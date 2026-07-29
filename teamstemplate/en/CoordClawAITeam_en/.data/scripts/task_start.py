#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
task_start.py - Agent preparation materials when starting a task

Command arguments:
- --name : The agent's own name (matched from team.json)

"""

import sys
import json
import urllib.request
import urllib.error
import argparse
import re
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

# ── Path Configuration ──
SCRIPT_DIR = Path(__file__).resolve().parent
TEAM_PATH = SCRIPT_DIR.parent / "team.json"
RULE_PATH = SCRIPT_DIR.parent / "team RULE.md"
WORKLOG_PATH = SCRIPT_DIR.parent.parent / "worklog"

# ── Centralized String Constants ──
MESSAGES = {
    "ERR_TEAM_NOT_FOUND": "[Error] team.json not found: {path}",
    "ERR_TEAM_PARSE": "[Error] Failed to parse team.json: {error}",
    "ERR_MEMBER_NOT_FOUND": "[Error] Member '{name}' not found, valid members: {valid_names}",
}

ROLE_RULE_BOOL = False
LLM_PROMPT = ["x-teamorganization", "x-projectdirectorystructure", "x-codingstandards", "x-documenttool"]


def _load_section_rule(id):
    """Extract the rule section with the specified id from team RULE.md (without markers)"""
    if not RULE_PATH.exists():
        return None
    try:
        with open(RULE_PATH, "r", encoding="utf-8") as f:
            content = f.read()
        # Match <!-- SECTION:START id={id} ... --> to <!-- SECTION:END id={id} -->
        pattern = rf'<!-- SECTION:START id={re.escape(id)} name=.*? -->(.*?)<!-- SECTION:END id={re.escape(id)} -->'
        match = re.search(pattern, content, re.DOTALL)
        if match:
            # Strip leading/trailing whitespace, return pure content (without HTML comment markers)
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
        # match <!-- SECTION:START id={agent_id} ... --> to <!-- SECTION:END id={agent_id} -->
        pattern = rf'<!-- SECTION:START id={re.escape(agent_id)} name=.*? -->(.*?)<!-- SECTION:END id={re.escape(agent_id)} -->'
        match = re.search(pattern, content, re.DOTALL)
        if match:
            # Strip leading/trailing whitespace, return pure content (without HTML comment markers)
            return match.group(1).strip()
        return None
    except Exception:
        return None


def _load_task_prompt():
    """Read the .md file with the same name in the script directory as taskprompt"""
    script_name = Path(__file__).resolve().stem  
    md_path = SCRIPT_DIR / f"{script_name}.md"

    if not md_path.exists():
        return "Please read the latest work log in the folder named after yourself under the worklog directory."

    try:
        with open(md_path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception as e:
        return "Please read the latest work log in the folder named after yourself under the worklog directory."


def _find_latest_logs(agent_name):
    """
    Find the latest work log: retrieve from two sources simultaneously, deduplicate and return all results.

    Source 1: Scan the worklog/{agent_name}/ directory and get the latest .md file by mtime.
    Source 2: Read the latest field in the last line of worklog/{agent_name}/.record.jsonl.

    If results from both sources point to the same file (compared via resolve()), keep only one.
    If they point to different files, return both.
    """
    agent_log_dir = WORKLOG_PATH / agent_name
    results = []
    resolved_paths = set()

    # Source 1: Find the latest .md file by mtime
    if agent_log_dir.exists() and agent_log_dir.is_dir():
        md_files = [
            f for f in agent_log_dir.iterdir()
            if f.is_file() and f.suffix.lower() == ".md" and f.stem.startswith("worklog")
        ]
        if md_files:
            latest_by_mtime = max(md_files, key=lambda f: f.stat().st_mtime)
            results.append(latest_by_mtime)
            resolved_paths.add(latest_by_mtime.resolve())

    # Source 2: Read the latest record from .record.jsonl
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


def validate_member(name):
    """Validate if the member exists, return the normalized name"""
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

    # Validate member
    name = validate_member(args.name)
    member = TEAM_BY_NAME[name]
    agent_id = member.get("agent_id", "")

    # Load taskprompt from the .md file with the same name
    taskprompt = _load_task_prompt()

    # Find and output the latest work log path (check both sources, output both if different files)
    latest_logs = _find_latest_logs(name)
    if latest_logs:
        print("Latest work log found:")
        for log_path in latest_logs:
            print(log_path)
        if len(latest_logs)>1:
            print("**Warning**: You did not execute the T5 action in the previous round. The T5 action must be executed upon completion of the current round task. The T5 action must be executed upon completion of the current round task. The T5 action must be executed when completing this round's task!")
        print("After reading, collect materials according to the following prompts and complete the message task:")
        print()

    # Inject general rule prompts
    for sectionid in LLM_PROMPT:
        sectionrule = _load_section_rule(sectionid)
        if sectionrule:
            print(sectionrule.replace("<#projectroot#>", Path(__file__).resolve().parent.parent.parent.as_posix() + "/"))
            print("\n")

    # Inject role-specific rule prompts
    rolerule = _load_role_rule(agent_id)
    if ROLE_RULE_BOOL:
        if rolerule:
            print(rolerule.replace("<#projectroot#>", Path(__file__).resolve().parent.parent.parent.as_posix() + "/"))
            print("\n")

    print(taskprompt)


if __name__ == "__main__":
    main()