#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
task_start.py - Agent preparation materials when starting a task

Command arguments:
- --name : The agent's own name (matched from team.json)

"""

import sys
import json
import sqlite3
import urllib.request
import urllib.error
import argparse
import re
from datetime import datetime, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

# ── UTC time utilities ──
def _utc(dt): return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"
def utc_now_iso(): return _utc(datetime.now(timezone.utc))

# ── Path configuration ──
SCRIPT_DIR = Path(__file__).resolve().parent
TEAM_PATH = SCRIPT_DIR.parent / "team.json"
RULE_PATH = SCRIPT_DIR.parent / "team RULE.md"
WORKLOG_PATH = SCRIPT_DIR.parent.parent / "worklog"
TASK_DB_PATH = SCRIPT_DIR.parent / "data" / "task_progress.db"

# ── Task progress constant ──
T2_TASK = {"name": "T2", "description": "start task", "progress": 40}

# ── Centralized string constants ──
MESSAGES = {
    "ERR_TEAM_NOT_FOUND": "[Error] team.json not found: {path}",
    "ERR_TEAM_PARSE": "[Error] Failed to parse team.json: {error}",
    "ERR_MEMBER_NOT_FOUND": "[Error] Member '{name}' not found, valid members: {valid_names}",
}

ROLE_RULE_BOOL = False
LLM_PROMPT = ["x-teamorganization", "x-projectdirectorystructure", "x-codingstandards", "x-documenttool"]


def _load_section_rule(id):
    """Extract the rule section for the specified id from team RULE.md (without markers)"""
    if not RULE_PATH.exists():
        return None
    try:
        with open(RULE_PATH, "r", encoding="utf-8") as f:
            content = f.read()
        pattern = rf'<!-- SECTION:START id={re.escape(id)} name=.*? -->(.*?)<!-- SECTION:END id={re.escape(id)} -->'
        match = re.search(pattern, content, re.DOTALL)
        if match:
            return match.group(1).strip()
        return None
    except Exception:
        return None


def _load_role_rule(agent_id):
    """Extract the complete role rule section for the specified agent_id from team RULE.md (without markers)"""
    if not RULE_PATH.exists():
        return None
    try:
        with open(RULE_PATH, "r", encoding="utf-8") as f:
            content = f.read()
        pattern = rf'<!-- SECTION:START id={re.escape(agent_id)} name=.*? -->(.*?)<!-- SECTION:END id={re.escape(agent_id)} -->'
        match = re.search(pattern, content, re.DOTALL)
        if match:
            return match.group(1).strip()
        return None
    except Exception:
        return None


def _load_task_prompt():
    """Read the .md file with the same name as the script in the script directory as taskprompt"""
    script_name = Path(__file__).resolve().stem
    md_path = SCRIPT_DIR / f"{script_name}.md"
    if not md_path.exists():
        return "Please read the latest work log in the folder named after yourself under the worklog directory."
    try:
        with open(md_path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return "Please read the latest work log in the folder named after yourself under the worklog directory."


def _find_latest_logs(agent_name):
    """Find the latest work log: retrieve from two sources simultaneously, deduplicate and return all results."""
    agent_log_dir = WORKLOG_PATH / agent_name
    results = []
    resolved_paths = set()

    if agent_log_dir.exists() and agent_log_dir.is_dir():
        md_files = [f for f in agent_log_dir.iterdir() if f.is_file() and f.suffix.lower() == ".md"]
        if md_files:
            latest_by_mtime = max(md_files, key=lambda f: f.stat().st_mtime)
            results.append(latest_by_mtime)
            resolved_paths.add(latest_by_mtime.resolve())

    record_path = agent_log_dir / ".record.jsonl"
    if record_path.exists():
        try:
            with open(record_path, "r", encoding="utf-8") as f:
                last_line = None
                for line in f:
                    line = line.strip()
                    if line:
                        last_line = line
                if last_line:
                    record = json.loads(last_line)
                    latest_filename = record.get("latest")
                    if latest_filename:
                        latest_from_record = agent_log_dir / latest_filename
                        if latest_from_record.exists():
                            resolved = latest_from_record.resolve()
                            if resolved not in resolved_paths:
                                results.append(latest_from_record)
                                resolved_paths.add(resolved)
        except Exception:
            pass

    return results


def _load_team():
    """Load team.json, return (by_name_dict, team_dict, gateway_url, reset_context)"""
    if not TEAM_PATH.exists():
        print(MESSAGES["ERR_TEAM_NOT_FOUND"].format(path=TEAM_PATH))
        sys.exit(1)
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


TEAM_BY_NAME, TEAM_CONFIG, GATEWAY_URL, RESET_CONTEXT = _load_team()


# ── Task progress recording (reusing chat_manager.py pattern) ──

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


def validate_member(name):
    """Validate whether the member exists, return the standardized name"""
    if name not in TEAM_BY_NAME:
        valid_names = ", ".join(TEAM_BY_NAME.keys())
        print(MESSAGES["ERR_MEMBER_NOT_FOUND"].format(name=name, valid_names=valid_names))
        sys.exit(1)
    return name


def main():
    p = argparse.ArgumentParser(
        description="Get preparation materials when an agent starts a task",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Example:
  python task_start.py --name 'John'
"""
    )
    p.add_argument("--name", required=True, help="The agent's own name (must match the name in team.json)")
    args = p.parse_args()

    name = validate_member(args.name)
    member = TEAM_BY_NAME[name]
    agent_id = member.get("agent_id", "")

    # Record T2 task progress
    _record_task_progress(agent_id, name, T2_TASK)

    taskprompt = _load_task_prompt()
    latest_logs = _find_latest_logs(name)
    if latest_logs:
        print("Latest work log found:")
        for log_path in latest_logs:
            print(log_path)
        if len(latest_logs) > 1:
            print("**Warning**: You did not execute the T5 action in the previous round. You must execute the T5 action upon completion of the current round's task!")
        print("After reading, collect materials according to the prompts below and complete the messaging task:")
        print()

    for sectionid in LLM_PROMPT:
        sectionrule = _load_section_rule(sectionid)
        if sectionrule:
            print(sectionrule.replace("<#projectroot#>", Path(__file__).resolve().parent.parent.parent.as_posix() + "/"))
            print("\n")

    rolerule = _load_role_rule(agent_id)
    if ROLE_RULE_BOOL:
        if rolerule:
            print(rolerule.replace("<#projectroot#>", Path(__file__).resolve().parent.parent.parent.as_posix() + "/"))
            print("\n")

    print(taskprompt)


if __name__ == "__main__":
    main()
