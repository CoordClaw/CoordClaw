#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chat_manager.py v6.0.0 - CoordClaw群聊管理工具（Agent专用）

命令集：
- send     : 发消息（自动写入 sender_id / recipient_id）
- inbox    : 查收未读（--reader 记录查阅行为 / --all 人类专用不标记）
- history  : 查历史（兜底查询，零副作用）
- members  : 列成员
- views    : 查看消息查看统计（行为审计）

v6.0.0 更新：增加人类成员

作者：代可行
版本：v6.0.0（2026-06-19）
"""

import sys
import sqlite3
import hashlib
import argparse
import json
import urllib.request
import urllib.error
import random
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

# ── UTC 时间工具（时区无关，输出带毫秒的 ISO-8601 UTC，如 2026-07-25T13:05:39.123Z）──
def _utc(dt): return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"
def utc_now_iso(): return _utc(datetime.now(timezone.utc))
def utc_now_pair():
    """返回 (UTC-Z 时间戳, 本地日 YYYY-MM-DD) —— created_date 必须用本地日，禁止 now[:10]"""
    dt = datetime.now(timezone.utc)
    return _utc(dt), dt.astimezone().strftime("%Y-%m-%d")
def utc_iso_minus(minutes): return _utc(datetime.now(timezone.utc) - timedelta(minutes=minutes))

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "coordclaw.db"
TEAM_PATH = Path(__file__).resolve().parent.parent / "team.json"
RULE_PATH = Path(__file__).resolve().parent.parent / "team RULE.md"

MARK_READ_ON_DONE = False
# ── 消息长度限制 ──
MIN_MESSAGE_LENGTH = 100       # 非状态消息的最短长度（字）
MAX_MESSAGE_LENGTH = 700       # 所有消息的最长长度（字）

# ── 状态标志标签（大小写敏感，可扩展数组）──
STATUS_TAGS = ["[STATUS]"]

# ── 脚本获取提示词并连同工具返回值一同返回给LLM──
LLM_PROMPT_INBOX = ["x-messagerule"]
LLM_PROMPT_SEND = ["x-messagerule","x-teamorganization"]

# ── 集中字符串常量（多语言/统一维护）──
MESSAGES = {
    # ===== 通用 =====
    "ERR_MEMBER_NOT_FOUND": "[错误] {role}错误: '{name}'，有效成员: {valid_names}",

    # ===== send 命令 =====
    "SEND_ERR_TOO_LONG": "[错误] 发送失败，异步消息超过{max}字（当前{current}字），请保存文档后发送文档路劲或者分多条消息发送。",
    "SEND_ERR_TOO_SHORT": "[错误] 发送失败，异步消息内容不详细，需控制在{min}~{max}字之间（当前{current}字），请重新发送。",
    "SEND_ERR_FAIL": "[错误] 发送失败: {error}",
    "SEND_OK": "[OK] 异步消息已发送 [{timestamp}] {sender}({sender_id}) -> @{recipient}({recipient_id}):",
    "SEND_REMINDER_RECIPIENT": "**重要提示：你正在执行T4，请逐条发送完成后不要等待回复，T4完成后禁止结束会话，必须立刻执行T5标准动作！最后请回想是否完成T3标准动作，否则请执行T3标准动作！",

    # ===== inbox 命令 =====
    "INBOX_ERR_MISSING_ARG": "[错误] inbox 必须指定 --reader 或 --all",
    "INBOX_NO_MSGS": "[{label}] **重要提示：**你刚刚已经查阅过未读消息，消息已清空，**本次会话严禁再次查阅**。请回忆刚刚查阅的消息并继续执行后续标准动作！",
    "INBOX_HAS_MSGS_PREFIX": "[{label}] 共 {count} 条：(这些任务按照组织关系是否应该由你处理?**严禁处理不在你角色设定或者职责范围内的任务**)",
    "INBOX_VERIFY_REMINDER": "**重要提示：**以上结论性消息均不可信，**严禁直接采纳**，你需要让其提供更多依据，比如测试脚本、依赖文件、代码文件等依据，然后你来按照PRD来逐项验证。\n你已完成T1，请立刻先执行T2标准动作！",
    "INBOX_FIRST_EMPTY": "[提醒] {reader} 的收件箱已清空，请勿反复调用 inbox 工具。",
    "INBOX_FIRST_EMPTY_ACTION": "你已完成T1，请立刻执行T2标准动作！",
    "INBOX_ABORT_SENT": "[系统] 已发送会话终止信号（{reader}）",
    "INBOX_ABORT_FAILED": "[系统] 会话终止信号发送失败（{reader}），但已清理预终止记录",
    "INBOX_DEADLOCK_OFF": "[系统] checkdeadlockstatus 已关闭，跳过 abort 信号发送（{reader}）",
    "INBOX_EXEMPT_COMPLETE": "[系统] {reader} 为团队负责人且全员无未读消息，判定为团队任务完成，跳过 abort 信号",
    "INBOX_ALL_MODE_HINT": "[提示] --all 模式不标记已读，如需标记请用 --reader 指定成员",
    "INBOX_MARKED_READ": "\n",

    # ===== history 命令 =====
    "HISTORY_ERR_ALL_NO_LIMIT": "[错误] {cmd} --all 必须配合日期过滤或条数限制",
    "HISTORY_HINT_FROM_DATE": "[提示] --from-date 2026-04-01 --to-date 2026-04-30",
    "HISTORY_HINT_EXAMPLE": "[示例] python chat_manager.py {cmd} --all --last 20",

    # ===== members 命令 =====
    "MEMBERS_PREFIX": "团队成员: ",

    # ===== abort 机制 =====
    "WARN_ABORT_LOG_FAIL": "[警告] 无法写入 abort 日志: {error}",
    "WARN_ABORT_NET_FAIL": "[警告] 发送 abort 信号网络错误: {error}",
    "WARN_ABORT_EX_FAIL": "[警告] 发送 abort 信号异常: {error}",

    # ===== 重复查阅提醒 =====
    "REMINDER_REPEATED_VIEW": "{reminder_msg}",
    # ===== CLI 帮助文档 =====
    "CLI_EPILOG": """PowerShell 安全调用指南：
  所有字符串参数（尤其 --content）建议用单引号 ' ' 包裹，避免 $ 被解析为变量。
  双引号仅在内容含单引号时使用，注意内容中的 $ 需转义为 `$。

示例:
  # 发送消息（单引号安全包裹）
  python chat_manager.py send --from '钟远' --to '林锐' --content '测试消息'

  # 内容含 $ 符号（必须用单引号）
  python chat_manager.py send --from '钟远' --to '林锐' --content '价格$100'

  # 查收某人未读（自动标记该人已读）
  python chat_manager.py inbox --reader '钟远' --last 20

  # 协调者专用：查收全员未读（不标记任何人的已读）
  python chat_manager.py inbox --all --last 20

  # 查历史消息（零副作用）
  python chat_manager.py history --with '钟远' --last 20
  python chat_manager.py history --all --last 20

  # 列出成员
  python chat_manager.py members

  # 查看消息查看统计（行为审计）
  python chat_manager.py views --msg-id 'abc12345'
  python chat_manager.py views --viewer '钟远' --recent 30
  python chat_manager.py views
""",
}

# ── 防反复调用机制：日志文件路径保留（仅 abort_log.txt）──
SCRIPT_DIR = Path(__file__).resolve().parent
ABORT_LOG_PATH = SCRIPT_DIR / "abort_log.txt"


# ── 从 team.json（唯一权威源）加载成员信息 ──

def _load_team():
    """加载 team.json，返回 (by_name_dict, by_id_dict, team_dict, gateway_url)"""
    with open(TEAM_PATH, "r", encoding="utf-8") as f:
        team = json.load(f)
    by_name = {}
    by_id = {}
    # 1. 加载 Agent 成员
    for m in team.get("members", []):
        by_name[m["name"]] = m
        by_id[m["agent_id"]] = m
    # 2. 加载人类成员（enabled 为 true 的）
    enabled_humans = [
        h for h in team.get("humanmember", [])
        if h.get("enabled", False)
    ]
    for h in enabled_humans:
        human_obj = {
            "name": h["name"],
            "agent_id": h["human_id"],
            "sessionKey": "",
            "append_message_prompts": {},
        }
        by_name[human_obj["name"]] = human_obj
        by_id[human_obj["agent_id"]] = human_obj
    # 3. 只要有一个 enabled human，额外加入 "用户"
    if enabled_humans:
        user_obj = {
            "name": "用户",
            "agent_id": "human-000",
            "sessionKey": "",
            "append_message_prompts": {},
        }
        by_name[user_obj["name"]] = user_obj
        by_id[user_obj["agent_id"]] = user_obj
    gateway_url = team.get("gatewayUrl", "http://127.0.0.1:28789")
    # 确保末尾无斜杠，避免拼接时双斜杠
    gateway_url = gateway_url.rstrip("/")
    return by_name, by_id, team, gateway_url



def _get_repeated_view_reminder():
    """从 team.json 获取重复查阅提醒配置"""
    check_cfg = TEAM_CONFIG.get("checkmessagesrepeatedly", {})
    reminder_cfg = check_cfg.get("reminder", {})
    return {
        "enabled": reminder_cfg.get("enabled", False),
        "message": reminder_cfg.get("message", "【你已经重复查阅过该消息{count}次了，请查看你自己的工作日志是否有记录！】")
    }


def _load_role_rule(agent_id):
    """从 team RULE.md 中提取指定 agent_id 的完整角色规则章节（不含标记）"""
    if not RULE_PATH.exists():
        return None
    try:
        with open(RULE_PATH, "r", encoding="utf-8") as f:
            content = f.read()
        # 匹配 <!-- SECTION:START id={agent_id} ... --> 到 <!-- SECTION:END id={agent_id} -->
        pattern = rf'<!-- SECTION:START id={re.escape(agent_id)} name=.*? -->(.*?)<!-- SECTION:END id={re.escape(agent_id)} -->'
        match = re.search(pattern, content, re.DOTALL)
        if match:
            # 去掉首尾的空白字符，返回纯内容（不含 HTML 注释标记）
            return match.group(1).strip()
        return None
    except Exception:
        return None


def _load_section_rule(id):
    """从 team RULE.md 中提取指定 id 的规则章节（不含标记）"""
    if not RULE_PATH.exists():
        return None
    try:
        with open(RULE_PATH, "r", encoding="utf-8") as f:
            content = f.read()
        # 匹配 <!-- SECTION:START id={id} ... --> 到 <!-- SECTION:END id={id} -->
        pattern = rf'<!-- SECTION:START id={re.escape(id)} name=.*? -->(.*?)<!-- SECTION:END id={re.escape(id)} -->'
        match = re.search(pattern, content, re.DOTALL)
        if match:
            # 去掉首尾的空白字符，返回纯内容（不含 HTML 注释标记）
            return match.group(1).strip()
        return None
    except Exception:
        return None
    


TEAM_BY_NAME, TEAM_BY_ID, TEAM_CONFIG, GATEWAY_URL = _load_team()
TOOL_INJECTION_PROMPTS = TEAM_CONFIG.get("tool_injection_prompts", False)


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=10000")
    _ensure_core_tables(conn)
    return conn


def normalize_name(name):
    return name.lstrip("@") if name else name


def generate_msg_id(sender, content, ts):
    return hashlib.md5(f"{ts}_{sender}_{content}".encode()).hexdigest()[:8]


def validate_member(name, role="姓名"):
    n = normalize_name(name)
    if n not in TEAM_BY_NAME:
        valid_names = ", ".join(TEAM_BY_NAME.keys())
        print(MESSAGES["ERR_MEMBER_NOT_FOUND"].format(role=role, name=name, valid_names=valid_names))
        return None
    return n


def build_date_filter(query, params, from_date, to_date, prefix=""):
    if from_date:
        query += f" AND {prefix}created_date >= ?"
        params.append(from_date)
    if to_date:
        query += f" AND {prefix}created_date <= ?"
        params.append(to_date)
    return query, params


def _has_status_tag(content):
    """检查消息内容是否包含任一状态标志标签（大小写敏感）"""
    return any(tag in content for tag in STATUS_TAGS)


def cmd_send(args):
    sender_name = validate_member(args.from_, "发送者")
    recipient_name = validate_member(args.to, "接收者")
    if not sender_name or not recipient_name:
        return

    sender_id = TEAM_BY_NAME[sender_name]["agent_id"]
    recipient_id = TEAM_BY_NAME[recipient_name]["agent_id"]

    content = args.content

    #注入发送消息提示词
    for sectionid in LLM_PROMPT_SEND:
        sectionrule=_load_section_rule(sectionid)
        if sectionrule:
            print(sectionrule.replace("<#projectroot#>",Path(__file__).resolve().parent.parent.parent.as_posix() + "/"))
            print ("\n")

    # ── 长度校验：超长 ──
    if len(content) > MAX_MESSAGE_LENGTH:
        print(MESSAGES["SEND_ERR_TOO_LONG"].format(max=MAX_MESSAGE_LENGTH-200, current=len(content)))
        return

    # ── 长度校验：过短（不含状态标签时触发）──
    if not _has_status_tag(content) and len(content) < MIN_MESSAGE_LENGTH:
        print(MESSAGES["SEND_ERR_TOO_SHORT"].format(min=MIN_MESSAGE_LENGTH, max=MAX_MESSAGE_LENGTH-200, current=len(content)))
        return

    # ── 拼接 append_message_prompts（不计入长度限制）──
    sender_cfg = TEAM_BY_NAME.get(sender_name, {})
    append_cfg = sender_cfg.get("append_message_prompts", {})
    if append_cfg.get("enabled", False):
        prompts = append_cfg.get("message", [])
        if prompts:
            prompt_text = random.choice(prompts)
            if append_cfg.get("behind", True):
                content = content + "\n" + prompt_text
            else:
                content = prompt_text + "\n" + content

    now, today = utc_now_pair()
    msg_id = generate_msg_id(sender_name, content, now)

    
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO team_messages (msg_id, sender, sender_id, recipient, recipient_id, content, created_at, created_date) VALUES (?,?,?,?,?,?,?,?)",
            (msg_id, sender_name, sender_id, recipient_name, recipient_id, content, now, today)
        )
        conn.commit()
        print(MESSAGES["SEND_OK"].format(
            timestamp=now, sender=sender_name, sender_id=sender_id,
            recipient=recipient_name, recipient_id=recipient_id
        ))
        print(MESSAGES["SEND_REMINDER_RECIPIENT"])
    except Exception as e:
        print(MESSAGES["SEND_ERR_FAIL"].format(error=e))
    finally:
        conn.close()


# ── 优化 #2: LEFT JOIN 单查询取代两步查询 ──

def get_unread_msgs(reader, from_date=None, to_date=None, last_n=None, limit=50):
    """查未读消息: LEFT JOIN anti-join，一次 SQL 完成"""
    conn = get_db()
    try:
        # 用 LEFT JOIN + IS NULL 替代"先查消息→再查已读→Python 差集"的两步模式
        q = """SELECT tm.* FROM team_messages tm
               LEFT JOIN team_message_reads tmr
                 ON tm.msg_id = tmr.msg_id AND tmr.reader_name = ?
               WHERE tm.recipient = ?
                 AND tmr.msg_id IS NULL"""
        p = [reader, reader]

        q, p = build_date_filter(q, p, from_date, to_date, "tm.")
        q += " ORDER BY tm.created_at DESC"

        if last_n is not None and last_n > 0:
            q += f" LIMIT {last_n}"
        elif last_n is None and limit and limit > 0:
            q += f" LIMIT {limit}"

        return conn.execute(q, p).fetchall()
    finally:
        conn.close()


# ── 优化 #3: 加 sender_id/recipient_id 精确匹配分支 ──

def get_history_msgs(participant=None, participant_id=None, from_date=None, to_date=None, last_n=None, limit=50):
    """查历史消息: 有 agent_id 时走索引精确匹配，兜底仍用 LIKE"""
    conn = get_db()
    try:
        q = "SELECT * FROM team_messages WHERE 1=1"
        p = []
        if participant_id:
            # 走 sender_id / recipient_id 索引精确匹配（O(log n)）
            q += " AND (sender_id = ? OR recipient_id = ?)"
            p += [participant_id, participant_id]
        elif participant:
            # 无 ID 时兜底走 LIKE（全表扫描，极少触发）
            q += " AND (sender = ? OR sender = ? OR sender LIKE ? OR sender LIKE ? OR recipient = ? OR recipient = ? OR recipient LIKE ? OR recipient LIKE ?)"
            p += [participant, "@" + participant, f"%{participant}%", f"%@{participant}%",
                  participant, "@" + participant, f"%{participant}%", f"%@{participant}%"]

        q, p = build_date_filter(q, p, from_date, to_date)
        q += " ORDER BY created_at DESC"

        if last_n is not None and last_n > 0:
            q += f" LIMIT {last_n}"
        elif last_n is None and limit and limit > 0:
            q += f" LIMIT {limit}"

        return conn.execute(q, p).fetchall()
    finally:
        conn.close()


def print_msgs(rows, label, viewer_name=None):
    if not rows:
        print(MESSAGES["INBOX_NO_MSGS"].format(label=label))
        return False
    print(MESSAGES["INBOX_HAS_MSGS_PREFIX"].format(label=label, count=len(rows)))

    reminder_cfg = _get_repeated_view_reminder() if viewer_name else {"enabled": False}

    for r in rows:
        # 先组装基础头部
        header = f"  [{r['created_at']}] {r['sender']} -> @{r['recipient']}:"
        
        # 检查是否需要拼接重复查阅提醒
        if viewer_name and reminder_cfg.get("enabled", False):
            view_count = get_message_view_count(msg_id=r['msg_id'], viewer_name=viewer_name)
            if view_count > 1:
                reminder_msg = reminder_cfg["message"].format(count=view_count)
                header += f" {reminder_msg}"  # 拼到冒号后面

        print(header)
        print(f"  {r['content']}")
    print(MESSAGES["INBOX_VERIFY_REMINDER"])
    return True


def _check_all_limit(args, cmd_name):
    """检查 --all 是否带了范围限制"""
    has_from = bool(args.from_date)
    has_to = bool(args.to_date)
    has_last = args.last is not None
    if not (has_from or has_to or has_last):
        print(MESSAGES["HISTORY_ERR_ALL_NO_LIMIT"].format(cmd=cmd_name))
        print(MESSAGES["HISTORY_HINT_FROM_DATE"])
        print(MESSAGES["HISTORY_HINT_EXAMPLE"].format(cmd=cmd_name))
        sys.exit(1)


# ── 防反复调用机制：数据库版（方案4）──

def _ensure_pre_abort_table(conn):
    """确保 pre_abort_records 表存在（幂等）"""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pre_abort_records (
            reader_name TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            session_key TEXT,
            first_empty_at TEXT NOT NULL
        )
    """)
    conn.commit()


def _ensure_core_tables(conn):
    """确保核心表存在（首次运行时自动建表）"""
    # 消息主表
    conn.execute("""
        CREATE TABLE IF NOT EXISTS team_messages (
            msg_id TEXT PRIMARY KEY,
            sender TEXT NOT NULL,
            sender_id TEXT NOT NULL,
            recipient TEXT NOT NULL,
            recipient_id TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            created_date TEXT NOT NULL
        )
    """)
    # 消息索引
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_team_messages_recipient 
        ON team_messages(recipient)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_team_messages_created 
        ON team_messages(created_at DESC)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_team_messages_date 
        ON team_messages(created_date)
    """)

    # 已读记录表
    conn.execute("""
        CREATE TABLE IF NOT EXISTS team_message_reads (
            msg_id TEXT NOT NULL,
            reader_name TEXT NOT NULL,
            reader_id TEXT NOT NULL,
            read_at TEXT NOT NULL,
            PRIMARY KEY (msg_id, reader_name)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_reads_reader 
        ON team_message_reads(reader_name, read_at)
    """)

    conn.commit()


def _load_pre_abort(reader_name):
    """从数据库加载指定阅读者的预终止记录"""
    conn = get_db()
    try:
        _ensure_pre_abort_table(conn)
        row = conn.execute(
            "SELECT * FROM pre_abort_records WHERE reader_name = ?",
            (reader_name,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def _save_pre_abort(reader_name, agent_id, session_key, first_empty_at):
    """保存/更新预终止记录（UPSERT，原子操作）"""
    conn = get_db()
    try:
        _ensure_pre_abort_table(conn)
        conn.execute("""
            INSERT INTO pre_abort_records (reader_name, agent_id, session_key, first_empty_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(reader_name) DO UPDATE SET
                agent_id = excluded.agent_id,
                session_key = excluded.session_key,
                first_empty_at = excluded.first_empty_at
        """, (reader_name, agent_id, session_key, first_empty_at))
        conn.commit()
    finally:
        conn.close()


def _remove_pre_abort(reader_name):
    """删除指定阅读者的预终止记录"""
    conn = get_db()
    try:
        _ensure_pre_abort_table(conn)
        conn.execute("DELETE FROM pre_abort_records WHERE reader_name = ?", (reader_name,))
        conn.commit()
    finally:
        conn.close()


def _ensure_message_views_table(conn):
    """确保 message_views 表存在（行为审计：记录每次消息查看）"""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS message_views (
            view_id INTEGER PRIMARY KEY AUTOINCREMENT,
            msg_id TEXT NOT NULL,
            viewer_name TEXT NOT NULL,
            viewer_id TEXT NOT NULL,
            viewed_at TEXT NOT NULL,
            view_source TEXT DEFAULT 'inbox'
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_message_views_msg_id 
        ON message_views(msg_id)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_message_views_viewer 
        ON message_views(viewer_name, viewer_id)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_message_views_time 
        ON message_views(viewed_at)
    """)
    conn.commit()


def _record_message_views(msg_id, viewer_name, viewer_id, view_source='inbox'):
    """记录消息查看行为（非幂等，每次查看都记录）"""
    conn = get_db()
    try:
        _ensure_message_views_table(conn)
        now = utc_now_iso()
        conn.execute(
            "INSERT INTO message_views (msg_id, viewer_name, viewer_id, viewed_at, view_source) VALUES (?,?,?,?,?)",
            (msg_id, viewer_name, viewer_id, now, view_source)
        )
        conn.commit()
    finally:
        conn.close()


def get_message_view_count(msg_id=None, viewer_name=None, since=None):
    """查询消息查看次数

    Args:
        msg_id: 指定消息ID，None则查全部
        viewer_name: 指定查看者，None则查全部
        since: 时间阈值，如 '2026-06-18 22:00:00'，None则无限制

    Returns:
        int: 查看次数
    """
    conn = get_db()
    try:
        _ensure_message_views_table(conn)
        q = "SELECT COUNT(*) as cnt FROM message_views WHERE 1=1"
        p = []
        if msg_id:
            q += " AND msg_id = ?"
            p.append(msg_id)
        if viewer_name:
            q += " AND viewer_name = ?"
            p.append(viewer_name)
        if since:
            q += " AND viewed_at >= ?"
            p.append(since)
        row = conn.execute(q, p).fetchone()
        return row["cnt"] if row else 0
    finally:
        conn.close()


def get_message_viewers(msg_id):
    """查询某条消息被哪些人查看过（去重）"""
    conn = get_db()
    try:
        _ensure_message_views_table(conn)
        rows = conn.execute(
            "SELECT DISTINCT viewer_name, viewer_id FROM message_views WHERE msg_id = ?",
            (msg_id,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_viewer_recent_activity(viewer_name, minutes=30):
    """查询某查看者最近N分钟内的查看次数（用于判断重复行为）"""
    since = utc_iso_minus(minutes)
    return get_message_view_count(viewer_name=viewer_name, since=since)


def _has_any_unread():
    """查询数据库是否存在任何未读消息（全团队维度）"""
    conn = get_db()
    try:
        row = conn.execute("""
            SELECT EXISTS(
                SELECT 1 FROM team_messages tm
                LEFT JOIN team_message_reads tmr
                  ON tm.msg_id = tmr.msg_id AND tmr.reader_name = tm.recipient
                WHERE tmr.msg_id IS NULL
            ) AS has_unread
        """).fetchone()
        return bool(row["has_unread"]) if row else False
    finally:
        conn.close()


FIRST_MEMBER_NAME = TEAM_CONFIG.get("members", [{}])[0].get("name", "")


def _send_abort_signal(session_key, message):
    """发送 abort 信号到 session-steer-debug 接口"""
    url = f"{GATEWAY_URL}/coordclaw-plugin/coordclawcenter/session-steer-debug"
    payload = json.dumps({
        "sessionKey": session_key,
        "message": message
    }, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except urllib.error.URLError as e:
        print(MESSAGES["WARN_ABORT_NET_FAIL"].format(error=e))
        return False
    except Exception as e:
        print(MESSAGES["WARN_ABORT_EX_FAIL"].format(error=e))
        return False


def _write_abort_log(reader_name, agent_id, session_key, success):
    """写入 abort 信号发出日志"""
    now = utc_now_iso()
    status = "成功" if success else "失败"
    log_line = f"{now} | abort_signal | {reader_name}({agent_id}) | sessionKey={session_key} | 状态={status}\n"
    try:
        with open(ABORT_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(log_line)
    except Exception as e:
        print(MESSAGES["WARN_ABORT_LOG_FAIL"].format(error=e))


# ── inbox 命令（含防反复调用机制）──

def cmd_inbox(args):
    """
    两种模式：
    1. --reader 某人  -> 查收该人未读，自动标记该人已读
    2. --all           -> 查收全员未读，不标记任何人的已读（协调者专用）

    v5.4.3 更新：pre_abort 机制改为数据库存储，消除文件竞态
      - 首次空收件箱：INSERT/UPDATE pre_abort_records 表
      - 二次空收件箱：发送 abort 信号，DELETE 记录，写日志
    """
    # 模式2：协调者专用 --all（不触发防反复机制）
    if args.all:
        _check_all_limit(args, "inbox")
        last_n = args.last if args.last is not None else None
        all_unread = []
        for name in TEAM_BY_NAME:
            msgs = get_unread_msgs(
                name,
                from_date=args.from_date,
                to_date=args.to_date,
                last_n=None,
                limit=0 if last_n == 0 else 200
            )
            all_unread.extend(msgs)
        all_unread.sort(key=lambda r: r["created_at"], reverse=True)
        if last_n is not None and last_n > 0:
            all_unread = all_unread[:last_n]
        if TOOL_INJECTION_PROMPTS:
            # 在全员模式下，为每条消息的接收者查找并输出其角色规则前缀
            # 但由于 all_unread 包含多个接收者，这里简化处理：
            # 输出所有涉及接收者的角色规则（去重）
            seen_agents = set()
            for row in all_unread:
                recipient_name = row["recipient"]
                if recipient_name in TEAM_BY_NAME:
                    agent_id = TEAM_BY_NAME[recipient_name]["agent_id"]
                    if agent_id not in seen_agents:
                        seen_agents.add(agent_id)
                        rule_content = _load_role_rule(agent_id)
                        if rule_content:
                            print(f"\n===== 角色规则: {recipient_name} ({agent_id}) =====")
                            print(rule_content)
                            print("===== 请按以上规则处理下面的事项 =====\n")
        if not print_msgs(all_unread, "全员未读"):
            return
        print(MESSAGES["INBOX_ALL_MODE_HINT"])
        return

    # 模式1：指定成员 --reader
    if not args.reader:
        print(MESSAGES["INBOX_ERR_MISSING_ARG"])
        print(MESSAGES["HISTORY_HINT_EXAMPLE"].format(cmd="inbox --reader '钟远' --last 20"))
        return

    reader_name = validate_member(args.reader, "阅读者")
    if not reader_name:
        return
    reader_id = TEAM_BY_NAME[reader_name]["agent_id"]
    reader_session_key = TEAM_BY_NAME[reader_name].get("sessionKey", "")

    last_n = args.last if args.last is not None else None
    msgs = get_unread_msgs(
        reader_name,
        from_date=args.from_date,
        to_date=args.to_date,
        last_n=last_n,
        limit=50
    )

    # 如果 tool_injection_prompts 开启，先输出阅读者的角色规则前缀
    if TOOL_INJECTION_PROMPTS:
        rule_content = _load_role_rule(reader_id)
        if rule_content:
            print("rule_content")
            print("\n")

    #注入处理未读消息提示词
    for sectionid in LLM_PROMPT_INBOX:
        sectionrule=_load_section_rule(sectionid)
        if sectionrule:
            print(sectionrule.replace("<#projectroot#>",Path(__file__).resolve().parent.parent.parent.as_posix() + "/"))
            print ("\n")

    # ── 记录查看行为（行为审计，不影响已读标记逻辑）──
    if msgs:
        conn = get_db()
        try:
            _ensure_message_views_table(conn)
            now = utc_now_iso()
            for m in msgs:
                conn.execute(
                    "INSERT INTO message_views (msg_id, viewer_name, viewer_id, viewed_at, view_source) VALUES (?,?,?,?,?)",
                    (m["msg_id"], reader_name, reader_id, now, 'inbox')
                )
            conn.commit()
        finally:
            conn.close()

    has_msgs = print_msgs(msgs, f"{reader_name}的收件箱", viewer_name=reader_name)

    if not has_msgs:
        # ── 空收件箱：防反复调用机制（数据库版）──
        existing = _load_pre_abort(reader_name)

        if existing:
            # 二次空查询 → 发送 abort 信号
            # 豁免：第一个成员 + 全员无未读 = 团队任务完成，不触发 abort
            if reader_name == FIRST_MEMBER_NAME and not _has_any_unread():
                _remove_pre_abort(reader_name)
                _write_abort_log(reader_name, reader_id, reader_session_key, True)
                print(MESSAGES["INBOX_EXEMPT_COMPLETE"].format(reader=reader_name))
                return

            # 从 checkdeadlockstatus 配置中读取，支持开关和随机消息
            checkdeadlockstatus = TEAM_CONFIG.get("checkdeadlockstatus", {})
            if checkdeadlockstatus.get("enabled", False):
                deadlock_msgs = checkdeadlockstatus.get("message", [])
                msg5 = random.choice(deadlock_msgs) if deadlock_msgs else "继续执行标准动作，你已经收取过未读消息，不要再查阅了！"
            else:
                msg5 = None

            if msg5:
                success = _send_abort_signal(reader_session_key, msg5)

                # 删除记录
                _remove_pre_abort(reader_name)

                # 写日志
                _write_abort_log(reader_name, reader_id, reader_session_key, success)

                if success:
                    print(MESSAGES["INBOX_ABORT_SENT"].format(reader=reader_name))
                else:
                    print(MESSAGES["INBOX_ABORT_FAILED"].format(reader=reader_name))
            else:
                # 开关关闭，不发送 abort 信号，仅清理记录
                _remove_pre_abort(reader_name)
                print(MESSAGES["INBOX_DEADLOCK_OFF"].format(reader=reader_name))
        else:
            # 首次空查询 → 记录预终止信息（UPSERT，原子操作）
            now = utc_now_iso()
            _save_pre_abort(reader_name, reader_id, reader_session_key, now)

            print(MESSAGES["INBOX_FIRST_EMPTY"].format(reader=reader_name))
            print(MESSAGES["INBOX_FIRST_EMPTY_ACTION"])
        return

    # 有消息 → 自动标记已读（原有逻辑）
    if MARK_READ_ON_DONE:
        conn = get_db()
        try:
            now = utc_now_iso()
            for m in msgs:
                conn.execute(
                    "INSERT OR IGNORE INTO team_message_reads (msg_id, reader_name, reader_id, read_at) VALUES (?,?,?,?)",
                    (m["msg_id"], reader_name, reader_id, now)
                )
            conn.commit()
            print(MESSAGES["INBOX_MARKED_READ"].format(count=len(msgs)))
        finally:
            conn.close()


# ── 优化 #4: cmd_history 传 participant_id，走索引 ──

def cmd_history(args):
    """兜底查询，零副作用"""
    participant = None
    participant_id = None
    if args.with_:
        participant = validate_member(args.with_, "参与者")
        if not participant:
            return
        participant_id = TEAM_BY_NAME[participant]["agent_id"]

    if not participant and args.all:
        _check_all_limit(args, "history")

    last_n = args.last if args.last is not None else None
    rows = get_history_msgs(
        participant=participant,
        participant_id=participant_id,
        from_date=args.from_date,
        to_date=args.to_date,
        last_n=last_n,
        limit=50
    )

    # ── 记录查看行为（history 查询也计入审计）──
    if rows and participant:  # 只有指定了查看者时才记录
        conn = get_db()
        try:
            _ensure_message_views_table(conn)
            now = utc_now_iso()
            participant_id_actual = TEAM_BY_NAME[participant]["agent_id"] if participant in TEAM_BY_NAME else None
            if participant_id_actual:
                for r in rows:
                    conn.execute(
                        "INSERT INTO message_views (msg_id, viewer_name, viewer_id, viewed_at, view_source) VALUES (?,?,?,?,?)",
                        (r["msg_id"], participant, participant_id_actual, now, 'history')
                    )
                conn.commit()
        finally:
            conn.close()

    label = f"{participant}的消息历史" if participant else "全部消息历史"
    print_msgs(rows, label)


def cmd_members(args):
    members_info = [f"{m['name']}({m['agent_id']})" for m in TEAM_BY_NAME.values()]
    print(MESSAGES["MEMBERS_PREFIX"] + ", ".join(members_info))


def cmd_views(args):
    """查询消息查看统计（行为审计）"""
    if args.msg_id:
        # 查询某条消息的查看统计
        total = get_message_view_count(msg_id=args.msg_id)
        viewers = get_message_viewers(args.msg_id)
        print(f"消息 [{args.msg_id}] 查看统计:")
        print(f"  总查看次数: {total}")
        print(f"  不同查看者: {len(viewers)} 人")
        for v in viewers:
            personal = get_message_view_count(msg_id=args.msg_id, viewer_name=v["viewer_name"])
            print(f"    - {v['viewer_name']}({v['viewer_id']}): {personal} 次")
    elif args.viewer:
        # 查询某人的查看统计
        viewer_name = validate_member(args.viewer, "查看者")
        if not viewer_name:
            return
        total = get_message_view_count(viewer_name=viewer_name)
        recent = get_viewer_recent_activity(viewer_name, minutes=args.recent or 30)
        print(f"查看者 [{viewer_name}] 统计:")
        print(f"  总查看次数: {total}")
        print(f"  最近 {args.recent or 30} 分钟: {recent} 次")
    else:
        # 全局统计
        total = get_message_view_count()
        print(f"全局查看统计:")
        print(f"  总查看次数: {total}")
        print(f"  使用 --msg-id 或 --viewer 查看详细统计")


def main():
    p = argparse.ArgumentParser(
        description="CoordClaw群聊管理工具 v5.4.3（Agent精简版）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=MESSAGES["CLI_EPILOG"]
    )
    subs = p.add_subparsers(dest="cmd", help="子命令")

    s = subs.add_parser("send", help="发送消息")
    s.add_argument("--from", dest="from_", required=True, help="发送者姓名")
    s.add_argument("--to", required=True, help="接收者姓名（无需@前缀）")
    s.add_argument("--content", required=True, help="消息内容（最多500字）")

    inbox_p = subs.add_parser("inbox", help="查看收件箱（--reader自动标已读 / --all协调者专用不标记）")
    inbox_p.add_argument("--reader", help="阅读者姓名（与--all二选一）")
    inbox_p.add_argument("--all", action="store_true", help="查看全员未读（协调者专用，不标记已读；需配合范围限制）")
    inbox_p.add_argument("--from-date", help="开始日期 (YYYY-MM-DD)")
    inbox_p.add_argument("--to-date", help="结束日期 (YYYY-MM-DD)")
    inbox_p.add_argument("--last", type=int, help="最新N条（0=全部）")

    hist_p = subs.add_parser("history", help="查看历史消息（零副作用）")
    hist_p.add_argument("--with", dest="with_", help="参与者姓名")
    hist_p.add_argument("--all", action="store_true", help="查看全员历史（需配合范围限制）")
    hist_p.add_argument("--from-date", help="开始日期 (YYYY-MM-DD)")
    hist_p.add_argument("--to-date", help="结束日期 (YYYY-MM-DD)")
    hist_p.add_argument("--last", type=int, help="最新N条（0=全部）")

    subs.add_parser("members", help="列出团队成员")

    views_p = subs.add_parser("views", help="查看消息查看统计（行为审计）")
    views_p.add_argument("--msg-id", help="指定消息ID查询查看记录")
    views_p.add_argument("--viewer", help="指定查看者查询统计")
    views_p.add_argument("--recent", type=int, help="最近N分钟内的查看次数（配合--viewer）")

    args = p.parse_args()

    if args.cmd == "send":
        cmd_send(args)
    elif args.cmd == "inbox":
        cmd_inbox(args)
    elif args.cmd == "history":
        cmd_history(args)
    elif args.cmd == "members":
        cmd_members(args)
    elif args.cmd == "views":
        cmd_views(args)
    else:
        p.print_help()


if __name__ == "__main__":
    main()