#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
task_done.py - Agent Task Completion Signal Sender

Command Arguments:
- --name : The agent's own name (matched from team.json)

Features:
1. Reads gatewayUrl and member information from team.json
2. Matches the corresponding member based on --name, extracts sessionKey
3. Checks whether work log content is complete (if a template exists)
4. If MARK_READ_ON_DONE is True, marks all unread messages for this member as read
5. Checks unread message status for all members; enables msg_robot and refreshes cache when conditions are met
6. Cleans up files and directories older than 2 hours in the temp directory (same level as worklog)
7. Sends an abort signal to the session-abort-debug endpoint
8. Outputs the sending result

Author: Dai Kexing (based on chat_manager.py v5.4.3)
Version: v1.4.0 (2026-07-16)
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

# ── UTC time writing (character-by-character isomorphic with panel toISOString(): 3-digit ms + Z, true UTC)──
def _utc(dt):
    """Format as UTC ISO-8601 (YYYY-MM-DDTHH:MM:SS.sssZ), milliseconds strictly 3 digits"""
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"
def utc_now_iso():
    """Current UTC time (used for read_at / JSON timestamp and other single-column times)"""
    return _utc(datetime.now(timezone.utc))
def utc_now_pair():
    """Returns (created_at_utc_z, created_date_local), taken from the same instant"""
    dt = datetime.now(timezone.utc)
    return _utc(dt), dt.astimezone().strftime("%Y-%m-%d")
def utc_iso_minus(minutes):
    """Since threshold: current UTC minus N minutes"""
    return _utc(datetime.now(timezone.utc) - timedelta(minutes=minutes))

sys.stdout.reconfigure(encoding="utf-8")

# ── Feature Switch: Automatically mark unread messages as read upon task completion ──
# Set to True to enable, set to False to disable
MARK_READ_ON_DONE = True
CLEANUP_TEMP=False

# ── Path Configuration ──
SCRIPT_DIR = Path(__file__).resolve().parent
TEAM_PATH = SCRIPT_DIR.parent / "team.json"
DB_PATH = SCRIPT_DIR.parent / "data" / "coordclaw.db"

# ── Centralized String Constants ──
MESSAGES = {
    "ERR_TEAM_NOT_FOUND": "[Error] team.json not found: {path}",
    "ERR_TEAM_PARSE": "[Error] Failed to parse team.json: {error}",
    "ERR_MEMBER_NOT_FOUND": "[Error] Member '{name}' not found. Valid members: {valid_names}",
    "ERR_NO_SESSION_KEY": "[Error] Member '{name}' has no sessionKey configured",
    "ERR_SEND_FAIL": "[Error] Failed to send abort signal: {error}",
    "ERR_SEND_EX": "[Error] Exception while sending abort signal: {error}",
    "ERR_RESET_FAIL": "[Error] RESET failed: {error}",
    "ERR_RESET_EX": "[Error] RESET exception: {error}",
    "ERR_MARK_READ": "[Error] Failed to mark as read: {error}",
    "ERR_WORKLOG_NO_RECORD": "[Error] Please complete the current round T3 work log record in the `{path}` directory according to the `{template}` content outline, then re-execute T5 to end the task.",
    "ERR_WORKLOG_INCOMPLETE": "[Error] Your work log is missing the following content:\n{missing}\nPlease supplement the current round T3 work log record according to the `{path}/{template}` content outline. In addition, you may record other matters to ensure the work log is comprehensive and detailed, then re-execute T5 to end the task.",
    "MSG_TASK_DONE": "**Terminate Session**: You have completed this task. Stop thinking immediately and end the session now!",
    "MSG_MARK_READ_OK": "[OK] Marked {count} viewed messages as read for {reader}",
    "MSG_MARK_READ_NONE": "[Info] {reader} has no viewed but unread messages (there may be unread and unviewed messages)",
    # ── New: All-member unread check related ──
    "WARN_CHECK_UNREAD": "[Warning] Failed to query all-member unread messages: {error}",
    "WARN_UPDATE_TEAM": "[Warning] Failed to modify team.json: {error}",
    "WARN_REFRESH_FAIL": "[Warning] Failed to send cache refresh signal: {error}",
    "WARN_REFRESH_STATUS": "[Warning] Cache refresh signal returned status code: {status}",
    "OK_MSG_ROBOT_ENABLED": "[OK] msg_robot enabled (team.json updated)",
    "OK_CACHE_REFRESHED": "[OK] Cache refresh signal sent",
    # ── New: temp directory cleanup related ──
    "INFO_TEMP_CLEANUP": "[Info] temp directory does not exist, skipping cleanup: {path}",
    "INFO_TEMP_CLEANED": "[OK] Temp directory cleaned: Removed {count} expired item(s) (older than 2 hours). Please move valid documents out of the temp directory in time to avoid being cleaned up!",
    "WARN_TEMP_CLEANUP": "[Warning] Error while cleaning temp directory: {error}",
}


# ── Database Connection ──

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA busy_timeout=10000")  # Symmetric with panel to avoid database is locked silent message loss during concurrent WAL writes
    conn.row_factory = sqlite3.Row
    return conn


# ── Load Member Information from team.json ──

def _load_team():
    """Load team.json, return (by_name_dict, team_dict, gateway_url)"""
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


# ── Member Validation ──

def validate_member(name):
    """Validate whether the member exists, return the standardized name"""
    if name in TEAM_BY_NAME:
        return name
    else:
        valid_names = ", ".join(TEAM_BY_NAME.keys())
        print(MESSAGES["ERR_MEMBER_NOT_FOUND"].format(name=name, valid_names=valid_names))
        sys.exit(1)


# ── Mark All Unread Messages as Read ──

def mark_all_unread_as_read(reader_name, reader_id):
    """Mark viewed but unread messages for the specified member as read, return the count marked"""
    conn = get_db()
    result = -1
    try:
        # Check if message_views table exists
        table_check = conn.execute("""
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name='message_views'
        """).fetchone()

        if table_check:
            # Query: unread + has inbox view record
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
            print("[Error] Database is missing the message_views table. Please update the database first (run the new version of chat_manager.py's inbox/history command to auto-create the table)")
            result = -1
    except Exception as e:
        print(MESSAGES["ERR_MARK_READ"].format(error=e))
        result = -1
    finally:
        conn.close()
    return result


# ── New: Query Whether Any Member Has Unread Messages ──

def has_any_unread():
    """Query whether there are any unread messages in the database (team-wide dimension)"""
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


# ── New: Check Conditions and Enable msg_robot ──

def check_and_enable_msg_robot():
    """
    Check all-member unread message status; enable msg_robot and refresh cache when conditions are met.
    Errors do not affect subsequent logic, only print warnings.
    """
    # 1. Check whether all members have unread messages
    if has_any_unread():
        # 2. Check team.json conditions
        msg_robot = TEAM_CONFIG.get("msg_robot", False)
        auto_coordination = TEAM_CONFIG.get("auto_coordination", False)

        if not msg_robot and auto_coordination:
            # 3. Modify team.json
            try:
                TEAM_CONFIG["msg_robot"] = True
                with open(TEAM_PATH, "w", encoding="utf-8") as f:
                    json.dump(TEAM_CONFIG, f, ensure_ascii=False, indent=2)
                print(MESSAGES["OK_MSG_ROBOT_ENABLED"])
            except Exception as e:
                print(MESSAGES["WARN_UPDATE_TEAM"].format(error=e))
                return

            # 4. Send cache refresh signal
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


# ── New: Work Log Record Read/Write ──

def _load_record(worklog_dir):
    """Read .record.jsonl, return {filename: mtime} dictionary"""
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
    """Append a record to .record.jsonl"""
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


# ── New: Title Normalization and Keyword Extraction ──

def _normalize_title(title):
    """Remove numbers, special symbols, and spaces; keep only Chinese and English letters"""
    chars = re.findall(r'[\u4e00-\u9fff]|[a-zA-Z]', title)
    return ''.join(chars).lower()


def _extract_keywords(text):
    """Extract 2-4 character keywords from pure Chinese text (sliding window)"""
    chinese_only = re.sub(r'[^\u4e00-\u9fff]', '', text)
    keywords = set()
    n = len(chinese_only)
    for length in [2, 3, 4]:
        for i in range(n - length + 1):
            keywords.add(chinese_only[i:i+length])
    return keywords


def _normalize_and_split(title):
    """
    1. Remove spaces
    2. Split by numbers and special symbols
    3. Extract 2-4 character keywords for each Chinese segment
    """
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
    """Fuzzy title matching based on keyword matching"""
    # First check substring containment
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
            # Check whether template keywords are covered by the file
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


# ── New: Check Whether Work Log Content is Complete ──

def check_worklog(name):
    """
    Check whether work log content is complete.

    1. Ensure the work log directory exists (silently create if not)
    2. Find the template file (earliest modification time among WorkLog-<name>-*.md)
       - If no template found → silently skip check
    3. Read .record.jsonl, check if there is a new work log
       - If the latest file is already in the record and mtime is not updated → prompt and exit
    4. Extract ## headings from the template as standards
    5. Find the latest work log (most recently modified .md file)
       - If only the template file exists → prompt to complete the work log and exit
    6. Check whether the latest file contains all standard headings
       - If missing → prompt missing content and exit
       - If complete → write to .record.jsonl and return True
    """
    worklog_dir = SCRIPT_DIR.parent.parent / "worklog" / name

    # 1. Ensure directory exists (silently create)
    worklog_dir.mkdir(parents=True, exist_ok=True)

    # 2. Find template file: earliest modification time among WorkLog-<name>-*.md
    md_files = list(worklog_dir.glob("worklog-*.md"))

    template_candidates = [
        f for f in md_files
        if f.name.startswith(f"workLog-{name}-") and f.name.endswith(".md")
    ]

    if template_candidates:
        # Use the earliest modification time as the template
        template_file = min(template_candidates, key=lambda f: f.stat().st_mtime)

        # 3. Read historical records
        records = _load_record(worklog_dir)

        # 4. Extract standard headings from the template
        template_content = None
        try:
            with open(template_file, "r", encoding="utf-8") as f:
                template_content = f.read()
        except Exception:
            pass

        if template_content is not None:
            # Extract all ## headings, keep original titles for fuzzy matching
            standard_titles = []
            for line in template_content.splitlines():
                if line.startswith("## "):
                    raw_title = line[3:]
                    standard_titles.append(raw_title)

            if standard_titles:
                # 5. Find the latest work log (most recently modified .md file)
                if len(md_files) > 1:
                    # Exclude template file, take the latest
                    other_files = [f for f in md_files if f != template_file]
                    latest_file = max(other_files, key=lambda f: f.stat().st_mtime)
                    latest_mtime = latest_file.stat().st_mtime

                    # Check if already in the record (cross-platform timestamp comparison)
                    is_new_record = True
                    if latest_file.name in records:
                        recorded_mtime = records[latest_file.name]
                        if latest_mtime <= recorded_mtime:
                            is_new_record = False

                    if is_new_record:
                        # 6. Check whether the latest file contains all standard headings
                        latest_content = None
                        try:
                            with open(latest_file, "r", encoding="utf-8") as f:
                                latest_content = f.read()
                        except Exception:
                            pass

                        if latest_content is not None:
                            # Extract headings from the latest file, keep original titles for fuzzy matching
                            latest_titles = []
                            for line in latest_content.splitlines():
                                if line.startswith("## "):
                                    raw_title = line[3:]
                                    latest_titles.append(raw_title)

                            # Check for missing headings (using fuzzy matching)
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
                                # Output as-is from the template, preserving numbers, symbols, and spaces
                                missing_str = ", ".join(missing)
                                print(MESSAGES["ERR_WORKLOG_INCOMPLETE"].format(missing=missing_str, path=worklog_dir.as_posix(), template=template_file.name))
                                sys.exit(1)
                            else:
                                # Verification passed, write to record
                                _append_record(worklog_dir, latest_file.name, latest_mtime)
                    else:
                        # Latest file already recorded, indicating no new log was written this round
                        print(MESSAGES["ERR_WORKLOG_NO_RECORD"].format(path=worklog_dir.as_posix(), template=template_file.name))
                        sys.exit(1)
                else:
                    # Only template file exists, no other work logs
                    print(MESSAGES["ERR_WORKLOG_NO_RECORD"].format(path=worklog_dir.as_posix(), template=template_file.name))
                    sys.exit(1)
    # If no template found → silently skip (function naturally returns True)
    return True


# ── New: Clean Up temp Directory ──

def cleanup_temp_dir():
    """
    Clean up files and directories older than 2 hours in the temp directory (same level as worklog).

    Directory structure example:
        project/
        ├── worklog/
        │   └── <name>/
        ├── temp/          ← Target to clean
        └── .DATA/

    1. Locate the temp directory
    2. If temp directory does not exist → silently skip
    3. Traverse all files and subdirectories in the temp directory
    4. Check the last modification time (st_mtime) for each item
    5. If older than 2 hours (7200 seconds) → delete (files with os.remove, directories with shutil.rmtree)
    6. Print cleanup results

    Cross-platform compatible: uses pathlib + os/shutil, does not depend on shell commands.
    """
    temp_dir = SCRIPT_DIR.parent.parent / "temp"

    if not temp_dir.exists():
        print(MESSAGES["INFO_TEMP_CLEANUP"].format(path=temp_dir.as_posix()))
        return

    if not temp_dir.is_dir():
        print(MESSAGES["WARN_TEMP_CLEANUP"].format(error=f"{temp_dir.as_posix()} is not a directory"))
        return

    cutoff = datetime.now(timezone.utc).timestamp() - 7200  # Timestamp from 2 hours ago
    deleted_count = 0

    try:
        # Use os.scandir for traversal, more efficient than listdir
        for entry in os.scandir(temp_dir):
            try:
                # Get modification time (cross-platform unified use of st_mtime)
                mtime = entry.stat().st_mtime
                if mtime < cutoff:
                    if entry.is_file(follow_symlinks=False):
                        os.remove(entry.path)
                        deleted_count += 1
                    elif entry.is_dir(follow_symlinks=False):
                        shutil.rmtree(entry.path)
                        deleted_count += 1
            except OSError:
                # Skip permission errors or other issues for the current item, continue processing others
                continue

        if deleted_count > 0:
            print(MESSAGES["INFO_TEMP_CLEANED"].format(count=deleted_count))
    except Exception as e:
        print(MESSAGES["WARN_TEMP_CLEANUP"].format(error=e))


# ── Send abort Signal ──

def send_abort_signal(session_key):
    """Send an abort signal to the session-abort-debug endpoint"""
    url = f"{GATEWAY_URL}/coordclaw-plugin/coordclawcenter/session-abort-debug"
    payload = json.dumps({
        "sessionKey": session_key
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
        print(MESSAGES["ERR_SEND_FAIL"].format(error=e))
        return False
    except Exception as e:
        print(MESSAGES["ERR_SEND_EX"].format(error=e))
        return False


# ── Send reset Signal ──

def send_reset_signal(session_key):
    """Send a reset signal to the session-reset endpoint"""
    url = f"{GATEWAY_URL}/coordclaw-plugin/coordclawcenter/session-reset"
    payload = json.dumps({
        "sessionKey": session_key
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
        print(MESSAGES["ERR_RESET_FAIL"].format(error=e))
        return False
    except Exception as e:
        print(MESSAGES["ERR_RESET_EX"].format(error=e))
        return False


# ── Main Logic ──

def main():
    p = argparse.ArgumentParser(
        description="Agent Task Completion Signal Sender",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Example:
  python task_done.py --name 'John Doe'
"""
    )
    p.add_argument("--name", required=True, help="The agent's own name (must match the name in team.json)")
    args = p.parse_args()

    # Validate member
    name = validate_member(args.name)
    member = TEAM_BY_NAME[name]
    agent_id = member.get("agent_id", "")
    session_key = member.get("sessionKey", "")
    resetcontext = RESET_CONTEXT.get("external_tools", "")

    # Validate sessionKey
    if session_key:
        # ── New: Clean up temp directory at the same level as worklog ──
        if CLEANUP_TEMP:
            cleanup_temp_dir()

        # ── Check whether work log content is complete ──
        check_worklog(name)


        # ── Auto mark as read (controlled by MARK_READ_ON_DONE) ──
        if MARK_READ_ON_DONE:
            count = mark_all_unread_as_read(name, agent_id)
            if count > 0:
                print(MESSAGES["MSG_MARK_READ_OK"].format(reader=name, count=count))
            elif count == 0:
                print(MESSAGES["MSG_MARK_READ_NONE"].format(reader=name))
            # count == -1 indicates an error, error message already printed within the function

        # ── Check all-member unread and enable msg_robot (before abort) ──
        check_and_enable_msg_robot()

        # Send abort signal
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