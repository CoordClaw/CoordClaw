#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chat_manager.py v6.0.0 - CoordClaw Group Chat Manager (Agent Only)

Commands:
- send     : Send message (auto writes sender_id / recipient_id)
- inbox    : Check unread (--reader records view behavior / --all human-only, no marking)
- history  : Check history (fallback query, zero side effects)
- members  : List members
- views    : View message view statistics (behavior audit)

v6.0.0 Update: Added human members

Author: Dai Kexing
Version: v6.0.0 (2026-06-19)
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

# ── UTC time utilities (timezone-independent, output ISO-8601 UTC with milliseconds, e.g. 2026-07-25T13:05:39.123Z)──
def _utc(dt): return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"
def utc_now_iso(): return _utc(datetime.now(timezone.utc))
def utc_now_pair():
    """Return (UTC-Z timestamp, local date YYYY-MM-DD) — created_date must use local date, do not use now[:10]"""
    dt = datetime.now(timezone.utc)
    return _utc(dt), dt.astimezone().strftime("%Y-%m-%d")
def utc_iso_minus(minutes): return _utc(datetime.now(timezone.utc) - timedelta(minutes=minutes))

SCRIPT_DIR = Path(__file__).resolve().parent
DB_PATH = SCRIPT_DIR.parent / "data" / "coordclaw.db"
TEAM_PATH = SCRIPT_DIR.parent / "team.json"
RULE_PATH = SCRIPT_DIR.parent / "team RULE.md"
TASK_DB_PATH = SCRIPT_DIR.parent / "data" / "task_progress.db"
ABORT_LOG_PATH = SCRIPT_DIR / "abort_log.txt"

MARK_READ_ON_DONE = False
# ── Message length limits ──
MIN_MESSAGE_LENGTH = 100       # Minimum length for non-status messages (chars)
MAX_MESSAGE_LENGTH = 700       # Maximum length for all messages (chars)

# ── Status flag tags (case-sensitive, extensible array)──
STATUS_TAGS = ["[STATUS]"]

T1_TASK = {
    "name":"T1",
    "description":"get unread messages",
    "progress":20
}

T4_TASK = {
    "name":"T4",
    "description":"send messages",
    "progress":80
}


# ── Script retrieves prompts and returns them with tool results to LLM──
LLM_PROMPT_INBOX = ["x-messagerule"]
LLM_PROMPT_SEND = ["x-messagerule","x-teamorganization"]

# ── Centralized string constants (multi-language/unified maintenance)──
MESSAGES = {
    # ===== General =====
    "ERR_MEMBER_NOT_FOUND": "[Error] {role} error: '{name}', valid members: {valid_names}",

    # ===== send command =====
    "SEND_ERR_TOO_LONG": "[Error] Send failed, async message exceeds {max} chars (current {current} chars), please save the document and send the file path or split into multiple messages.",
    "SEND_ERR_TOO_SHORT": "[Error] Send failed, async message content is not detailed enough, must be between {min}~{max} chars (current {current} chars), please resend.",
    "SEND_ERR_FAIL": "[Error] Send failed: {error}",
    "SEND_OK": "[OK] Async message sent [{timestamp}] {sender}({sender_id}) -> @{recipient}({recipient_id}):",
    "SEND_REMINDER_RECIPIENT": "**IMPORTANT: You are currently executing T4. Please send each item one by one and do not wait for a reply after completion. Once T4 is finished, you are strictly prohibited from ending the session—you must immediately execute the T5 standard action! Finally, please recall whether you have completed the T3 standard action; if not, please execute the T3 standard action!",

    # ===== inbox command =====
    "INBOX_ERR_MISSING_ARG": "[Error] inbox must specify --reader or --all",
    "INBOX_NO_MSGS": "[{label}] **Important Hint:**You have just checked unread messages, the inbox is now empty. **You are strictly prohibited from checking again in this session**.Please recall the messages you just checked and continue with the subsequent standard actions!",
    "INBOX_HAS_MSGS_PREFIX": "[{label}] Total {count} messages: (Should these tasks be handled by you according to the organizational relationship?**Strictly prohibited from handling tasks outside your role setting or scope of responsibility**)",
    "INBOX_VERIFY_REMINDER": "**Important Hint:** The above conclusive messages are not credible, **Strictly prohibited from direct adoption**. You need to ask them to provide more evidence, such as test scripts, dependency files, code files, etc., and then you verify item by item according to the PRD.\nYou have completed T1, please immediately execute the T2 standard action!",
    "INBOX_FIRST_EMPTY": "[Reminder] {reader}'s inbox is empty, please do not repeatedly call the inbox tool.",
    "INBOX_FIRST_EMPTY_ACTION": "You have completed T1, please immediately execute the T2 standard action!",
    "INBOX_ABORT_SENT": "[System] Session termination signal sent ({reader})",
    "INBOX_ABORT_FAILED": "[System] Session termination signal failed to send ({reader}), pre-termination record has been cleaned",
    "INBOX_DEADLOCK_OFF": "[System] checkdeadlockstatus is disabled, skipping abort signal send ({reader})",
    "INBOX_EXEMPT_COMPLETE": "[System] {reader} is the team leader and all members have no unread messages, judged as team task completed, skipping abort signal",
    "INBOX_ALL_MODE_HINT": "[Hint] --all mode does not mark as read, please use --reader to specify a member if you need to mark",
    "INBOX_MARKED_READ": "\n",

    # ===== history command =====
    "HISTORY_ERR_ALL_NO_LIMIT": "[Error] {cmd} --all must be combined with date filter or count limit",
    "HISTORY_HINT_FROM_DATE": "[Hint] --from-date 2026-04-01 --to-date 2026-04-30",
    "HISTORY_HINT_EXAMPLE": "[Example] python chat_manager.py {cmd} --all --last 20",

    # ===== members command =====
    "MEMBERS_PREFIX": "Team members: ",

    # ===== abort mechanism =====
    "WARN_ABORT_LOG_FAIL": "[Warning] Unable to write abort log: {error}",
    "WARN_ABORT_NET_FAIL": "[Warning] Network error sending abort signal: {error}",
    "WARN_ABORT_EX_FAIL": "[Warning] Exception sending abort signal: {error}",

    # ===== Repeated view reminder =====
    "REMINDER_REPEATED_VIEW": "{reminder_msg}",
    # ===== CLI Help Documentation =====
    "CLI_EPILOG": """PowerShell Safe Invocation Guide:
  All string arguments (especially --content) are recommended to be wrapped in single quotes ' ' to avoid $ being parsed as a variable.
  Double quotes should only be used when the content contains single quotes, note that $ needs to be escaped as `$.

Example:
  # Send message (single quote safe wrapping)
  python chat_manager.py send --from 'Zhong Yuan' --to 'Lin Rui' --content 'Test message'

  # Content contains $ symbol (must use single quotes)
  python chat_manager.py send --from 'Zhong Yuan' --to 'Lin Rui' --content 'Price$100'

  # Check someone's unread (auto marks that person as read)
  python chat_manager.py inbox --reader 'Zhong Yuan' --last 20

  # Coordinator only: check all members' unread (does not mark anyone as read)
  python chat_manager.py inbox --all --last 20

  # Check history messages (zero side effects)
  python chat_manager.py history --with 'Zhong Yuan' --last 20
  python chat_manager.py history --all --last 20

  # List members
  python chat_manager.py members

  # View message view statistics (behavior audit)
  python chat_manager.py views --msg-id 'abc12345'
  python chat_manager.py views --viewer 'Zhong Yuan' --recent 30
  python chat_manager.py views
""",
}



# ── Load member info from team.json (sole authoritative source) ──

def _load_team():
    """Load team.json, return (by_name_dict, by_id_dict, team_dict, gateway_url)"""
    with open(TEAM_PATH, "r", encoding="utf-8") as f:
        team = json.load(f)
    by_name = {}
    by_id = {}
    # 1. Load Agent members
    for m in team.get("members", []):
        by_name[m["name"]] = m
        by_id[m["agent_id"]] = m
    # 2. Load human members (enabled is true)
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
    # 3. As long as there is one enabled human, additionally add "User"
    if enabled_humans:
        user_obj = {
            "name": "User",
            "agent_id": "human-000",
            "sessionKey": "",
            "append_message_prompts": {},
        }
        by_name[user_obj["name"]] = user_obj
        by_id[user_obj["agent_id"]] = user_obj
    gateway_url = team.get("gatewayUrl", "http://127.0.0.1:28789")
    # Ensure no trailing slash to avoid double slashes when concatenating
    gateway_url = gateway_url.rstrip("/")
    return by_name, by_id, team, gateway_url



def _get_repeated_view_reminder():
    """Get Repeated view reminder configuration from team.json"""
    check_cfg = TEAM_CONFIG.get("checkmessagesrepeatedly", {})
    reminder_cfg = check_cfg.get("reminder", {})
    return {
        "enabled": reminder_cfg.get("enabled", False),
        "message": reminder_cfg.get("message", "【You have already viewed this message {count} times, please check your own work log for records!】")
    }


def _load_role_rule(agent_id):
    """Extract the complete role rule section for the specified agent_id from team RULE.md (without markers)"""
    if not RULE_PATH.exists():
        return None
    try:
        with open(RULE_PATH, "r", encoding="utf-8") as f:
            content = f.read()
        # Match <!-- SECTION:START id={agent_id} ... --> to <!-- SECTION:END id={agent_id} -->
        pattern = rf'<!-- SECTION:START id={re.escape(agent_id)} name=.*? -->(.*?)<!-- SECTION:END id={re.escape(agent_id)} -->'
        match = re.search(pattern, content, re.DOTALL)
        if match:
            # Remove leading/trailing whitespace, return pure content (without HTML comment markers)
            return match.group(1).strip()
        return None
    except Exception:
        return None


def _load_section_rule(id):
    """Extract the rule section for the specified id from team RULE.md (without markers)"""
    if not RULE_PATH.exists():
        return None
    try:
        with open(RULE_PATH, "r", encoding="utf-8") as f:
            content = f.read()
        # Match <!-- SECTION:START id={id} ... --> to <!-- SECTION:END id={id} -->
        pattern = rf'<!-- SECTION:START id={re.escape(id)} name=.*? -->(.*?)<!-- SECTION:END id={re.escape(id)} -->'
        match = re.search(pattern, content, re.DOTALL)
        if match:
            # Remove leading/trailing whitespace, return pure content (without HTML comment markers)
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

# ── Task progress recording ──

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
            print(f"[OK] Task progress recorded: {task_attr['name']} ({agent_name}, progress={task_attr['progress']})")
        finally:
            conn.close()
    except Exception as e:
        print(f"[Warning] Failed to record task progress ({task_attr['name']}): {e}")


def _clear_agent_tasks_if_round_complete(agent_id):
    try:
        conn = get_task_db()
        try:
            row = conn.execute(
                "SELECT 1 FROM task_progress WHERE agent_id = ? AND task_progress >= 100 LIMIT 1",
                (agent_id,)
            ).fetchone()
            if row:
                conn.execute("DELETE FROM task_progress WHERE agent_id = ?", (agent_id,))
                conn.commit()
                print(f"[OK] Cleared old round task records for {agent_id}")
                return True
        finally:
            conn.close()
    except Exception as e:
        print(f"[Warning] Failed to clear old round records ({agent_id}): {e}")
    return False



def normalize_name(name):
    return name.lstrip("@") if name else name


def generate_msg_id(sender, content, ts):
    return hashlib.md5(f"{ts}_{sender}_{content}".encode()).hexdigest()[:8]


def validate_member(name, role="Name"):
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
    """Check whether message content contains any status flag tag (case-sensitive)"""
    return any(tag in content for tag in STATUS_TAGS)


def cmd_send(args):
    sender_name = validate_member(args.from_, "Sender")
    recipient_name = validate_member(args.to, "Recipient")
    if not sender_name or not recipient_name:
        return

    sender_id = TEAM_BY_NAME[sender_name]["agent_id"]
    recipient_id = TEAM_BY_NAME[recipient_name]["agent_id"]

    content = args.content

    # Inject Send message Hint words
    for sectionid in LLM_PROMPT_SEND:
        sectionrule=_load_section_rule(sectionid)
        if sectionrule:
            print(sectionrule.replace("<#projectroot#>",Path(__file__).resolve().parent.parent.parent.as_posix() + "/"))
            print ("\n")

    # ── Length validation: too long ──
    if len(content) > MAX_MESSAGE_LENGTH:
        print(MESSAGES["SEND_ERR_TOO_LONG"].format(max=MAX_MESSAGE_LENGTH-200, current=len(content)))
        return

    # ── Length validation: too short (triggered when no status tag is present)──
    if not _has_status_tag(content) and len(content) < MIN_MESSAGE_LENGTH:
        print(MESSAGES["SEND_ERR_TOO_SHORT"].format(min=MIN_MESSAGE_LENGTH, max=MAX_MESSAGE_LENGTH-200, current=len(content)))
        return

    # ── Concatenate append_message_prompts (not counted in length limit)──
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
        # Record T4 task progress
        _record_task_progress(sender_id, sender_name, T4_TASK)
        print(MESSAGES["SEND_REMINDER_RECIPIENT"])
    except Exception as e:
        print(MESSAGES["SEND_ERR_FAIL"].format(error=e))
    finally:
        conn.close()


# ── Optimization #2: LEFT JOIN single query replaces two-step query ──

def get_unread_msgs(reader, from_date=None, to_date=None, last_n=None, limit=50):
    """Check unread messages: LEFT JOIN anti-join, completed in one SQL"""
    conn = get_db()
    try:
        # Use LEFT JOIN + IS NULL to replace "first query messages -> then query reads -> Python difference" two-step mode
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


# ── Optimization #3: Add sender_id/recipient_id exact Match branch ──

def get_history_msgs(participant=None, participant_id=None, from_date=None, to_date=None, last_n=None, limit=50):
    """Query history messages: use indexed exact Match when agent_id is available, fallback still uses LIKE"""
    conn = get_db()
    try:
        q = "SELECT * FROM team_messages WHERE 1=1"
        p = []
        if participant_id:
            # Use sender_id / recipient_id index exact Match (O(log n))
            q += " AND (sender_id = ? OR recipient_id = ?)"
            p += [participant_id, participant_id]
        elif participant:
            # When no ID is available, fallback uses LIKE (full table scan, rarely triggered)
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
        # First assemble the basic header
        header = f"  [{r['created_at']}] {r['sender']} -> @{r['recipient']}:"

        # Check whether Repeated view reminder needs to be appended
        if viewer_name and reminder_cfg.get("enabled", False):
            view_count = get_message_view_count(msg_id=r['msg_id'], viewer_name=viewer_name)
            if view_count > 1:
                reminder_msg = reminder_cfg["message"].format(count=view_count)
                header += f" {reminder_msg}"  # Append after colon

        print(header)
        print(f"  {r['content']}")
    print(MESSAGES["INBOX_VERIFY_REMINDER"])
    return True


def _check_all_limit(args, cmd_name):
    """Check if --all has range limits"""
    has_from = bool(args.from_date)
    has_to = bool(args.to_date)
    has_last = args.last is not None
    if not (has_from or has_to or has_last):
        print(MESSAGES["HISTORY_ERR_ALL_NO_LIMIT"].format(cmd=cmd_name))
        print(MESSAGES["HISTORY_HINT_FROM_DATE"])
        print(MESSAGES["HISTORY_HINT_EXAMPLE"].format(cmd=cmd_name))
        sys.exit(1)


# ── Anti-repeated call mechanism: database version (Plan 4)──

def _ensure_pre_abort_table(conn):
    """Ensure pre_abort_records table exists (idempotent)"""
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
    """Ensure core tables exist (auto-create on first run)"""
    # Messages main table
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
    # Message indexes
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

    # Read records table
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
    """Load pre-termination record for the specified reader from database"""
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
    """Save/update pre-termination record (UPSERT, atomic operation)"""
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
    """Delete pre-termination record for the specified reader"""
    conn = get_db()
    try:
        _ensure_pre_abort_table(conn)
        conn.execute("DELETE FROM pre_abort_records WHERE reader_name = ?", (reader_name,))
        conn.commit()
    finally:
        conn.close()


def _ensure_message_views_table(conn):
    """Ensure message_views table exists (behavior audit: records each message view)"""
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
    """Record message view behavior (non-idempotent, records each view)"""
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
    """Query message view count

    Args:
        msg_id: Specify message ID, None for all
        viewer_name: Specify viewer, None for all
        since: Time threshold, e.g. '2026-06-18 22:00:00', None for no limit

    Returns:
        int: View count
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
    """Query which people have viewed a certain message (deduplicated)"""
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
    """Query view count for a viewer within the last N minutes (used to judge repeated behavior)"""
    since = utc_iso_minus(minutes)
    return get_message_view_count(viewer_name=viewer_name, since=since)


def _has_any_unread():
    """Query whether any unread messages exist in the database (team-wide dimension)"""
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
    """Send abort signal to session-steer-debug endpoint"""
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
    """Write abort signal send log"""
    now = utc_now_iso()
    status = "Success" if success else "Failed"
    log_line = f"{now} | abort_signal | {reader_name}({agent_id}) | sessionKey={session_key} | status={status}\n"
    try:
        with open(ABORT_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(log_line)
    except Exception as e:
        print(MESSAGES["WARN_ABORT_LOG_FAIL"].format(error=e))


# ── inbox command (includes anti-repeated call mechanism)──

def cmd_inbox(args):
    """
    Two modes:
    1. --reader someone  -> Check that person's unread, auto-mark that person as read
    2. --all           -> Check all members' unread, do not mark anyone as read (coordinator only)

    v5.4.3 Update: pre_abort mechanism changed to database storage, eliminating file race conditions
      - First empty inbox: INSERT/UPDATE pre_abort_records table
      - Second empty inbox: send abort signal, DELETE record, write log
    """
    # Mode 2: Coordinator-only --all (does not trigger anti-repeated mechanism)
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
            # In all mode, find and output the role rule prefix for each message's recipient
            # But since all_unread contains multiple recipients, simplified here:
            # Output role rules for all involved recipients (deduplicated)
            seen_agents = set()
            for row in all_unread:
                recipient_name = row["recipient"]
                if recipient_name in TEAM_BY_NAME:
                    agent_id = TEAM_BY_NAME[recipient_name]["agent_id"]
                    if agent_id not in seen_agents:
                        seen_agents.add(agent_id)
                        rule_content = _load_role_rule(agent_id)
                        if rule_content:
                            print(f"\n===== Role Rule: {recipient_name} ({agent_id}) =====")
                            print(rule_content)
                            print("===== Please handle the following matters according to the above rules =====\n")
        if not print_msgs(all_unread, "All Unread"):
            return
        print(MESSAGES["INBOX_ALL_MODE_HINT"])
        return

    # Mode 1: Specify member --reader
    if not args.reader:
        print(MESSAGES["INBOX_ERR_MISSING_ARG"])
        print(MESSAGES["HISTORY_HINT_EXAMPLE"].format(cmd="inbox --reader 'Zhong Yuan' --last 20"))
        return

    reader_name = validate_member(args.reader, "Reader")
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

    # If tool_injection_prompts is enabled, first output the reader's Role Rule prefix
    if TOOL_INJECTION_PROMPTS:
        rule_content = _load_role_rule(reader_id)
        if rule_content:
            print("rule_content")
            print("\n")

    # Inject unread message processing Hint words
    for sectionid in LLM_PROMPT_INBOX:
        sectionrule=_load_section_rule(sectionid)
        if sectionrule:
            print(sectionrule.replace("<#projectroot#>",Path(__file__).resolve().parent.parent.parent.as_posix() + "/"))
            print ("\n")

    # ── Record view behavior (behavior audit, does not affect read marking logic)──
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

    has_msgs = print_msgs(msgs, f"{reader_name}'s Inbox", viewer_name=reader_name)

    if has_msgs:
        # ── Has messages: clean old round records and record T1 task progress ──
        _clear_agent_tasks_if_round_complete(reader_id)
        _record_task_progress(reader_id, reader_name, T1_TASK)

    if not has_msgs:
        # ── Empty inbox: anti-repeated call mechanism (database version)──
        existing = _load_pre_abort(reader_name)

        if existing:
            # Second empty query -> send abort signal
            # Exemption: first member + no unread for all = team task completed, do not trigger abort
            if reader_name == FIRST_MEMBER_NAME and not _has_any_unread():
                _remove_pre_abort(reader_name)
                _write_abort_log(reader_name, reader_id, reader_session_key, True)
                print(MESSAGES["INBOX_EXEMPT_COMPLETE"].format(reader=reader_name))
                return

            # Read from checkdeadlockstatus config, supports toggle and random messages
            checkdeadlockstatus = TEAM_CONFIG.get("checkdeadlockstatus", {})
            if checkdeadlockstatus.get("enabled", False):
                deadlock_msgs = checkdeadlockstatus.get("message", [])
                msg5 = random.choice(deadlock_msgs) if deadlock_msgs else "Continue with standard actions, you have already checked unread messages, do not check again!"
            else:
                msg5 = None

            if msg5:
                success = _send_abort_signal(reader_session_key, msg5)

                # Delete record
                _remove_pre_abort(reader_name)

                # Write log
                _write_abort_log(reader_name, reader_id, reader_session_key, success)

                if success:
                    print(MESSAGES["INBOX_ABORT_SENT"].format(reader=reader_name))
                else:
                    print(MESSAGES["INBOX_ABORT_FAILED"].format(reader=reader_name))
            else:
                # Toggle off, do not send abort signal, only clean records
                _remove_pre_abort(reader_name)
                print(MESSAGES["INBOX_DEADLOCK_OFF"].format(reader=reader_name))
        else:
            # First empty query -> record pre-termination info (UPSERT, atomic operation)
            now = utc_now_iso()
            _save_pre_abort(reader_name, reader_id, reader_session_key, now)

            print(MESSAGES["INBOX_FIRST_EMPTY"].format(reader=reader_name))
            print(MESSAGES["INBOX_FIRST_EMPTY_ACTION"])
        return

    # Has messages -> auto-mark as read (original logic)
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


# ── Optimization #4: cmd_history passes participant_id, uses index ──

def cmd_history(args):
    """Fallback query, zero side effects"""
    participant = None
    participant_id = None
    if args.with_:
        participant = validate_member(args.with_, "Participant")
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

    # ── Record view behavior (history query also counts in audit)──
    if rows and participant:  # Only record when a viewer is specified
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

    label = f"{participant}'s Message History" if participant else "All Message History"
    print_msgs(rows, label)


def cmd_members(args):
    members_info = [f"{m['name']}({m['agent_id']})" for m in TEAM_BY_NAME.values()]
    print(MESSAGES["MEMBERS_PREFIX"] + ", ".join(members_info))


def cmd_views(args):
    """Query message view statistics (behavior audit)"""
    if args.msg_id:
        # Query view statistics for a certain message
        total = get_message_view_count(msg_id=args.msg_id)
        viewers = get_message_viewers(args.msg_id)
        print(f"Message [{args.msg_id}] View Statistics:")
        print(f"  Total View count: {total}")
        print(f"  Unique viewers: {len(viewers)} people")
        for v in viewers:
            personal = get_message_view_count(msg_id=args.msg_id, viewer_name=v["viewer_name"])
            print(f"    - {v['viewer_name']}({v['viewer_id']}): {personal} times")
    elif args.viewer:
        # Query statistics for a certain viewer
        viewer_name = validate_member(args.viewer, "Viewer")
        if not viewer_name:
            return
        total = get_message_view_count(viewer_name=viewer_name)
        recent = get_viewer_recent_activity(viewer_name, minutes=args.recent or 30)
        print(f"Viewer [{viewer_name}] Statistics:")
        print(f"  Total View count: {total}")
        print(f"  Last {args.recent or 30} minutes: {recent} times")
    else:
        # Global statistics
        total = get_message_view_count()
        print(f"Global View Statistics:")
        print(f"  Total View count: {total}")
        print(f"  Use --msg-id or --viewer to see detailed statistics")


def main():
    p = argparse.ArgumentParser(
        description="CoordClaw Group Chat Manager v5.4.3 (Agent Lite Version)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=MESSAGES["CLI_EPILOG"]
    )
    subs = p.add_subparsers(dest="cmd", help="Subcommands")

    s = subs.add_parser("send", help="Send message")
    s.add_argument("--from", dest="from_", required=True, help="Sender name")
    s.add_argument("--to", required=True, help="Recipient name (no @ prefix needed)")
    s.add_argument("--content", required=True, help="Message content (max 500 chars)")

    inbox_p = subs.add_parser("inbox", help="Check inbox (--reader auto-marks as read / --all coordinator-only no marking)")
    inbox_p.add_argument("--reader", help="Reader name (mutually exclusive with --all)")
    inbox_p.add_argument("--all", action="store_true", help="Check all members' unread (coordinator-only, does not mark as read; requires range limit)")
    inbox_p.add_argument("--from-date", help="Start date (YYYY-MM-DD)")
    inbox_p.add_argument("--to-date", help="End date (YYYY-MM-DD)")
    inbox_p.add_argument("--last", type=int, help="Latest N messages (0=all)")

    hist_p = subs.add_parser("history", help="Check history messages (zero side effects)")
    hist_p.add_argument("--with", dest="with_", help="Participant name")
    hist_p.add_argument("--all", action="store_true", help="Check all members' history (requires range limit)")
    hist_p.add_argument("--from-date", help="Start date (YYYY-MM-DD)")
    hist_p.add_argument("--to-date", help="End date (YYYY-MM-DD)")
    hist_p.add_argument("--last", type=int, help="Latest N messages (0=all)")

    subs.add_parser("members", help="List team members")

    views_p = subs.add_parser("views", help="View message view statistics (behavior audit)")
    views_p.add_argument("--msg-id", help="Specify message ID to query view records")
    views_p.add_argument("--viewer", help="Specify viewer to query statistics")
    views_p.add_argument("--recent", type=int, help="View count within last N minutes (used with --viewer)")

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
