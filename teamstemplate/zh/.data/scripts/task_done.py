#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
task_done.py - 智能体任务完成信号发送工具

命令参数：
- --name : 智能体自己的名字（从 team.json 中匹配）

功能：
1. 从 team.json 中读取 gatewayUrl 和成员信息
2. 根据 --name 匹配到对应成员，提取 sessionKey
3. 检查工作日志内容是否齐全（如存在模板）
4. 如 MARK_READ_ON_DONE 为 True，将该成员所有未读消息标记为已读
5. 检查全员未读消息状态，条件满足时启用 msg_robot 并刷新缓存
6. 清理与 worklog 目录同级的 temp 目录下超过 2 小时的文件和目录
7. 向 session-abort-debug 接口发送 abort 信号
8. 输出发送结果

作者：代可行（基于 chat_manager.py v5.4.3 改造）
版本：v1.4.0（2026-07-16）
"""

import sys
import json
import sqlite3
import urllib.request
import urllib.error
import argparse
import re
import os
import shutil
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

# ── 功能开关：完成任务时自动标记未读消息为已读 ──
MARK_READ_ON_DONE = True
CLEANUP_TEMP = False

# ── 路径配置 ──
SCRIPT_DIR = Path(__file__).resolve().parent
TEAM_PATH = SCRIPT_DIR.parent / "team.json"
DB_PATH = SCRIPT_DIR.parent / "data" / "coordclaw.db"
TASK_DB_PATH = SCRIPT_DIR.parent / "data" / "task_progress.db"

# ── 任务进度常量 ──
T5_TASK = {"name": "T5", "description": "complete task", "progress": 100}

# ── 集中字符串常量 ──
MESSAGES = {
    "ERR_TEAM_NOT_FOUND": "[错误] 找不到 team.json: {path}",
    "ERR_TEAM_PARSE": "[错误] 解析 team.json 失败: {error}",
    "ERR_MEMBER_NOT_FOUND": "[错误] 找不到成员 '{name}'，有效成员: {valid_names}",
    "ERR_NO_SESSION_KEY": "[错误] 成员 '{name}' 没有配置 sessionKey",
    "ERR_SEND_FAIL": "[错误] 发送 abort 信号失败: {error}",
    "ERR_SEND_EX": "[错误] 发送 abort 信号异常: {error}",
    "ERR_RESET_FAIL": "[错误] RESET失败: {error}",
    "ERR_RESET_EX": "[错误] RESET异常: {error}",
    "ERR_MARK_READ": "[错误] 标记已读失败: {error}",
    "ERR_WORKLOG_NO_RECORD": "[错误] 请在`{path}`目录下按照`{template}`内容纲要完成本轮T3工作日志记录，然后再重新执行T5结束任务。",
    "ERR_WORKLOG_INCOMPLETE": "[错误] 你的工作日志缺少以下内容：\n{missing}\n请按照`{path}/{template}`内容纲要补充本轮T3工作日志记录，除此之外，你可记录其他事项，保证工作日志内容全面详细，然后再重新执行T5结束任务。",
    "MSG_TASK_DONE": "**终止会话**：你已经完成本次任务，马上停止思考，立即结束会话！",
    "MSG_MARK_READ_OK": "[OK] 已将 {reader} 的 {count} 条已查阅消息标记为已读",
    "MSG_MARK_READ_NONE": "[提示] {reader} 没有已查阅但未标记已读的消息（可能存在未读且未读且未查阅的消息）",
    "WARN_CHECK_UNREAD": "[警告] 查询全员未读消息失败: {error}",
    "WARN_UPDATE_TEAM": "[警告] 修改 team.json 失败: {error}",
    "WARN_REFRESH_FAIL": "[警告] 发送缓存刷新信号失败: {error}",
    "WARN_REFRESH_STATUS": "[警告] 缓存刷新信号返回状态码: {status}",
    "OK_MSG_ROBOT_ENABLED": "[OK] 已启用 msg_robot（team.json 已更新）",
    "OK_CACHE_REFRESHED": "[OK] 缓存刷新信号已发送",
    "INFO_TEMP_CLEANUP": "[信息] temp 目录不存在，跳过清理: {path}",
    "INFO_TEMP_CLEANED": "[OK] 已清理 temp 目录: 删除 {count} 个过期项（超过 2 小时），请及时将有效文档移除temp目录，以免被清理！",
    "WARN_TEMP_CLEANUP": "[警告] 清理 temp 目录时出错: {error}",
}


# ── 数据库连接 ──

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


# ── 任务进度记录（复用 chat_manager.py 模式）──

def get_task_db():
    TASK_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(TASK_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("PRAGMA journal_mode=WAL")
    _ensure_task_progress_table(conn)
    return conn


def _ensure_task_progress_table(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS task_progress (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            task_name TEXT NOT NULL,
            task_description TEXT NOT NULL,
            task_progress INTEGER NOT NULL,
            recorded_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_task_progress_agent_recorded
        ON task_progress(agent_id, recorded_at)
    """)
    conn.commit()


def _record_task_progress(agent_id, agent_name, task_attr):
    try:
        conn = get_task_db()
        try:
            conn.execute(
                """INSERT INTO task_progress 
                   (agent_id, agent_name, task_name, task_description, task_progress, recorded_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (agent_id, agent_name, task_attr["name"], task_attr["description"],
                 task_attr["progress"], utc_now_iso())
            )
            conn.commit()
            print(f"[OK] 任务进度已记录: {task_attr['name']} ({agent_name}, progress={task_attr['progress']})")
        finally:
            conn.close()
    except Exception as e:
        print(f"[警告] 任务进度记录失败 ({task_attr['name']}): {e}")


# ── 从 team.json 加载成员信息 ──

def _load_team():
    """加载 team.json，返回 (by_name_dict, team_dict, gateway_url, reset_context)"""
    if TEAM_PATH.exists():
        try:
            with open(TEAM_PATH, "r", encoding="utf-8") as f:
                team = json.load(f)
        except Exception as e:
            print(MESSAGES["ERR_TEAM_PARSE"].format(error=e))
            sys.exit(1)

        by_name = {}
        for m in team.get("members", []):
            by_name[m["name"]] = m

        gateway_url = team.get("gatewayUrl", "http://127.0.0.1:28789")
        gateway_url = gateway_url.rstrip("/")
        reset_context = team.get("resetcontext", "")
        return by_name, team, gateway_url, reset_context
    else:
        print(MESSAGES["ERR_TEAM_NOT_FOUND"].format(path=TEAM_PATH))
        sys.exit(1)


TEAM_BY_NAME, TEAM_CONFIG, GATEWAY_URL, RESET_CONTEXT = _load_team()


# ── 成员校验 ──

def validate_member(name):
    """校验成员是否存在，返回标准化后的名字"""
    if name in TEAM_BY_NAME:
        return name
    else:
        valid_names = ", ".join(TEAM_BY_NAME.keys())
        print(MESSAGES["ERR_MEMBER_NOT_FOUND"].format(name=name, valid_names=valid_names))
        sys.exit(1)


# ── 标记所有未读消息为已读 ──

def mark_all_unread_as_read(reader_name, reader_id):
    """将指定成员的已查阅但未标记已读的消息标记为已读，返回标记数量"""
    conn = get_db()
    result = -1
    try:
        table_check = conn.execute("""
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name='message_views'
        """).fetchone()

        if table_check:
            q = """SELECT tm.msg_id FROM team_messages tm
                   LEFT JOIN team_message_reads tmr
                     ON tm.msg_id = tmr.msg_id AND tmr.reader_name = ?
                   WHERE tm.recipient = ?
                     AND tmr.msg_id IS NULL
                     AND tm.msg_id IN (
                         SELECT DISTINCT msg_id FROM message_views 
                         WHERE viewer_name = ? AND view_source = 'inbox'
                     )"""
            unread_rows = conn.execute(q, (reader_name, reader_name, reader_name)).fetchall()

            if unread_rows:
                now = utc_now_iso()
                for row in unread_rows:
                    conn.execute(
                        "INSERT OR IGNORE INTO team_message_reads (msg_id, reader_name, reader_id, read_at) VALUES (?,?,?,?)",
                        (row["msg_id"], reader_name, reader_id, now)
                    )
                conn.commit()
                result = len(unread_rows)
            else:
                result = 0
        else:
            print("[错误] 数据库缺少 message_views 表，请先更新数据库（运行新版 chat_manager.py 的 inbox/history 命令自动建表）")
            result = -1
    except Exception as e:
        print(MESSAGES["ERR_MARK_READ"].format(error=e))
        result = -1
    finally:
        conn.close()
    return result


# ── 查询全员是否有未读消息 ──

def has_any_unread():
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
    except Exception as e:
        print(MESSAGES["WARN_CHECK_UNREAD"].format(error=e))
        return False
    finally:
        conn.close()


# ── 检查条件并启用 msg_robot ──

def check_and_enable_msg_robot():
    """检查全员未读消息状态，条件满足时启用 msg_robot 并刷新缓存。"""
    if has_any_unread():
        msg_robot = TEAM_CONFIG.get("msg_robot", False)
        auto_coordination = TEAM_CONFIG.get("auto_coordination", False)

        if not msg_robot and auto_coordination:
            try:
                TEAM_CONFIG["msg_robot"] = True
                with open(TEAM_PATH, "w", encoding="utf-8") as f:
                    json.dump(TEAM_CONFIG, f, ensure_ascii=False, indent=2)
                print(MESSAGES["OK_MSG_ROBOT_ENABLED"])
            except Exception as e:
                print(MESSAGES["WARN_UPDATE_TEAM"].format(error=e))
                return

            try:
                url = f"{GATEWAY_URL}/coordclaw-plugin/coordclawcenter/cache-refresh"
                req = urllib.request.Request(
                    url,
                    data=b"{}",
                    headers={"Content-Type": "application/json"},
                    method="POST"
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    if resp.status == 200:
                        print(MESSAGES["OK_CACHE_REFRESHED"])
                    else:
                        print(MESSAGES["WARN_REFRESH_STATUS"].format(status=resp.status))
            except Exception as e:
                print(MESSAGES["WARN_REFRESH_FAIL"].format(error=e))


# ── 工作日志记录读写 ──

def _load_record(worklog_dir):
    """读取 .record.jsonl，返回 {filename: mtime} 字典"""
    record_path = worklog_dir / ".record.jsonl"
    records = {}
    if record_path.exists():
        try:
            with open(record_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                        records[obj.get("latest", "")] = obj.get("mtime", 0)
                    except (json.JSONDecodeError, KeyError):
                        continue
        except Exception:
            pass
    return records


def _append_record(worklog_dir, filename, mtime):
    """向 .record.jsonl 追加一条记录"""
    record_path = worklog_dir / ".record.jsonl"
    record = {
        "timestamp": utc_now_iso(),
        "latest": filename,
        "mtime": mtime,
    }
    try:
        with open(record_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


# ── 标题规范化与关键词提取 ──

def _normalize_title(title):
    """消除数字、特殊符号、空格，只保留中文和英文字母"""
    chars = re.findall(r'[\u4e00-\u9fff]|[a-zA-Z]', title)
    return ''.join(chars).lower()


def _extract_keywords(text):
    """从纯中文文本中提取2-4字关键词（滑动窗口）"""
    chinese_only = re.sub(r'[^\u4e00-\u9fff]', '', text)
    keywords = set()
    n = len(chinese_only)
    for length in [2, 3, 4]:
        for i in range(n - length + 1):
            keywords.add(chinese_only[i:i+length])
    return keywords


def _normalize_and_split(title):
    """消除空格后用数字和特殊符号分割，对每个中文片段提取2-4字关键词"""
    no_space = title.replace(' ', '').replace('\u3000', '')
    parts = re.split(r'[0-9\W_]+', no_space)
    all_keywords = set()
    for part in parts:
        if len(part) >= 2:
            if re.match(r'^[\u4e00-\u9fff]+$', part):
                all_keywords.update(_extract_keywords(part))
            else:
                all_keywords.add(part.lower())
    return all_keywords


def _match_titles(template_title, file_title):
    """基于关键词匹配的标题模糊匹配"""
    t_norm = _normalize_title(template_title)
    f_norm = _normalize_title(file_title)
    if t_norm in f_norm or f_norm in t_norm:
        return True
    else:
        t_keywords = _normalize_and_split(template_title)
        f_keywords = _normalize_and_split(file_title)
        if not t_keywords:
            return True
        else:
            matched = 0
            for t_kw in t_keywords:
                if t_kw in f_norm:
                    matched += 1
                else:
                    for f_kw in f_keywords:
                        if t_kw in f_kw or f_kw in t_kw:
                            matched += 1
                            break
            coverage = matched / len(t_keywords)
            return coverage >= 0.35


# ── 检查工作日志内容是否齐全 ──

def check_worklog(name):
    """检查工作日志内容是否齐全。"""
    worklog_dir = SCRIPT_DIR.parent.parent / "worklog" / name
    worklog_dir.mkdir(parents=True, exist_ok=True)

    md_files = list(worklog_dir.glob("worklog-*.md"))
    template_candidates = [
        f for f in md_files
        if f.name.startswith(f"worklog-{name}-") and f.name.endswith(".md")
    ]

    if template_candidates:
        template_file = min(template_candidates, key=lambda f: f.stat().st_mtime)
        records = _load_record(worklog_dir)

        template_content = None
        try:
            with open(template_file, "r", encoding="utf-8") as f:
                template_content = f.read()
        except Exception:
            pass

        if template_content is not None:
            standard_titles = []
            for line in template_content.splitlines():
                if line.startswith("## "):
                    standard_titles.append(line[3:])

            if standard_titles:
                if len(md_files) > 1:
                    other_files = [f for f in md_files if f != template_file]
                    latest_file = max(other_files, key=lambda f: f.stat().st_mtime)
                    latest_mtime = latest_file.stat().st_mtime

                    is_new_record = True
                    if latest_file.name in records:
                        recorded_mtime = records[latest_file.name]
                        if latest_mtime <= recorded_mtime:
                            is_new_record = False

                    if is_new_record:
                        latest_content = None
                        try:
                            with open(latest_file, "r", encoding="utf-8") as f:
                                latest_content = f.read()
                        except Exception:
                            pass

                        if latest_content is not None:
                            latest_titles = []
                            for line in latest_content.splitlines():
                                if line.startswith("## "):
                                    latest_titles.append(line[3:])

                            missing = []
                            for std_title in standard_titles:
                                found = False
                                for lat_title in latest_titles:
                                    if _match_titles(std_title, lat_title):
                                        found = True
                                        break
                                if not found:
                                    missing.append(std_title)

                            if missing:
                                missing_str = "、".join(missing)
                                print(MESSAGES["ERR_WORKLOG_INCOMPLETE"].format(missing=missing_str, path=worklog_dir.as_posix(), template=template_file.name))
                                sys.exit(1)
                            else:
                                _append_record(worklog_dir, latest_file.name, latest_mtime)
                    else:
                        print(MESSAGES["ERR_WORKLOG_NO_RECORD"].format(path=worklog_dir.as_posix(), template=template_file.name))
                        sys.exit(1)
                else:
                    print(MESSAGES["ERR_WORKLOG_NO_RECORD"].format(path=worklog_dir.as_posix(), template=template_file.name))
                    sys.exit(1)
    return True


# ── 清理 temp 目录 ──

def cleanup_temp_dir():
    """清理与 worklog 目录同级的 temp 目录下超过 2 小时的文件和目录。"""
    temp_dir = SCRIPT_DIR.parent.parent / "temp"
    if not temp_dir.exists():
        print(MESSAGES["INFO_TEMP_CLEANUP"].format(path=temp_dir.as_posix()))
        return
    if not temp_dir.is_dir():
        print(MESSAGES["WARN_TEMP_CLEANUP"].format(error=f"{temp_dir.as_posix()} 不是目录"))
        return

    cutoff = datetime.now(timezone.utc).timestamp() - 7200
    deleted_count = 0
    try:
        for entry in os.scandir(temp_dir):
            try:
                mtime = entry.stat().st_mtime
                if mtime < cutoff:
                    if entry.is_file(follow_symlinks=False):
                        os.remove(entry.path)
                        deleted_count += 1
                    elif entry.is_dir(follow_symlinks=False):
                        shutil.rmtree(entry.path)
                        deleted_count += 1
            except OSError:
                continue
        if deleted_count > 0:
            print(MESSAGES["INFO_TEMP_CLEANED"].format(count=deleted_count))
    except Exception as e:
        print(MESSAGES["WARN_TEMP_CLEANUP"].format(error=e))


# ── 发送 abort 信号 ──

def send_abort_signal(session_key):
    """发送 abort 信号到 session-abort-debug 接口"""
    url = f"{GATEWAY_URL}/coordclaw-plugin/coordclawcenter/session-abort-debug"
    payload = json.dumps({"sessionKey": session_key}, ensure_ascii=False).encode("utf-8")
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
        print(MESSAGES["ERR_SEND_FAIL"].format(error=e))
        return False
    except Exception as e:
        print(MESSAGES["ERR_SEND_EX"].format(error=e))
        return False


# ── 发送 reset 信号 ──

def send_reset_signal(session_key):
    """发送 reset 信号到 session-reset 接口"""
    url = f"{GATEWAY_URL}/coordclaw-plugin/coordclawcenter/session-reset"
    payload = json.dumps({"sessionKey": session_key}, ensure_ascii=False).encode("utf-8")
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
        print(MESSAGES["ERR_RESET_FAIL"].format(error=e))
        return False
    except Exception as e:
        print(MESSAGES["ERR_RESET_EX"].format(error=e))
        return False


# ── 主逻辑 ──

def main():
    p = argparse.ArgumentParser(
        description="智能体任务完成信号发送工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例:
  python task_done.py --name '钟远'
"""
    )
    p.add_argument("--name", required=True, help="智能体自己的名字（需与 team.json 中的 name 一致）")
    args = p.parse_args()

    name = validate_member(args.name)
    member = TEAM_BY_NAME[name]
    agent_id = member.get("agent_id", "")
    session_key = member.get("sessionKey", "")
    resetcontext = RESET_CONTEXT.get("external_tools", "")

    if session_key:
        if CLEANUP_TEMP:
            cleanup_temp_dir()

        # 先检查工作日志，通过后才记录 T5
        check_worklog(name)

        # 工作日志检查通过，记录 T5 任务进度
        _record_task_progress(agent_id, name, T5_TASK)

        if MARK_READ_ON_DONE:
            count = mark_all_unread_as_read(name, agent_id)
            if count > 0:
                print(MESSAGES["MSG_MARK_READ_OK"].format(reader=name, count=count))
            elif count == 0:
                print(MESSAGES["MSG_MARK_READ_NONE"].format(reader=name))

        check_and_enable_msg_robot()

        success = send_abort_signal(session_key)
        if success:
            print(MESSAGES["MSG_TASK_DONE"])
            if resetcontext:
                send_reset_signal(session_key)
        else:
            sys.exit(1)
    else:
        print(MESSAGES["ERR_NO_SESSION_KEY"].format(name=name))
        sys.exit(1)


if __name__ == "__main__":
    main()
