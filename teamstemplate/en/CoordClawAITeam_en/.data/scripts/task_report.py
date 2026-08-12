#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
task_report.py - Agent Task Report Generator

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
TASK_DB_PATH = SCRIPT_DIR.parent / "data" / "task_progress.db"

# ── Task progress constant ──
T3_TASK = {"name": "T3", "description": "generate task report", "progress": 60}

# ── Centralized string constants ──
MESSAGES = {
    "ERR_TEAM_NOT_FOUND": "[Error] team.json not found: {path}",
    "ERR_TEAM_PARSE": "[Error] Failed to parse team.json: {error}",
    "ERR_MEMBER_NOT_FOUND": "[Error] Member '{name}' not found, valid members: {valid_names}",
    "ERR_MD_NOT_FOUND": "[Warning] Same-name .md file not found: {path}, using default prompt",
}

ROLE_RULE_BOOL = False
LLM_PROMPT = ["x-projectdirectorystructure", "x-documenttool"]


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
        print(MESSAGES["ERR_MD_NOT_FOUND"].format(path=md_path))
        return "Execute the task according to the rules"
    try:
        with open(md_path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception as e:
        print(f"[Warning] Failed to read .md file: {e}, using default prompt")
        return "Execute the standard actions according to the rules"


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
        description="Agent Task Report Generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Example:
  python task_report.py --name 'Zhong Yuan'
"""
    )
    p.add_argument("--name", required=True, help="The agent's own name (must match the name in team.json)")
    args = p.parse_args()

    name = validate_member(args.name)
    member = TEAM_BY_NAME[name]
    agent_id = member.get("agent_id", "")

    # Record T3 task progress
    _record_task_progress(agent_id, name, T3_TASK)

    taskprompt = _load_task_prompt()

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
