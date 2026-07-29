#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
task_done.py - Agent Task Completion Signal Sender

Command Arguments:
- --name : The agent's own name (matched from team.json)

Features:
1. Reads gatewayUrl and member info from team.json
2. Matches corresponding member based on --name, extracts sessionKey
3. Sends abort signal to session-steer-debug endpoint
4. Outputs send result

Author: Dai Kexing (Based on chat_manager.py v5.4.3)
Version: v1.0.0 (2026-06-02)
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

# ── Centralized String Constants ──
MESSAGES = {
    "ERR_TEAM_NOT_FOUND": "[Error] team.json not found: {path}",
    "ERR_TEAM_PARSE": "[Error] Failed to parse team.json: {error}",
    "ERR_MEMBER_NOT_FOUND": "[Error] Member '{name}' not found, valid members: {valid_names}",
    "ERR_MD_NOT_FOUND": "[Warning] Corresponding .md file not found: {path}, using default prompt",
}

ROLE_RULE_BOOL=False
LLM_PROMPT = ["x-projectdirectorystructure","x-documenttool"]

def _load_section_rule(id):
    """Extract specified id rule section from team RULE.md (without markers)"""
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

def _load_role_rule(agent_id):
    """Extract complete role rule section for specified agent_id from team RULE.md (without markers)"""
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

# ── Load same-name .md file content ──

def _load_task_prompt():
    """Read .md file with same name as script in script directory as taskprompt"""
    script_name = Path(__file__).resolve().stem  # Get script file name (without extension)
    md_path = SCRIPT_DIR / f"{script_name}.md"

    if not md_path.exists():
        print(MESSAGES["ERR_MD_NOT_FOUND"].format(path=md_path))
        return "Execute task according to rules"

    try:
        with open(md_path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception as e:
        print(f"[Warning] Failed to read .md file: {e}, using default prompt")
        return "Execute standard actions according to rules"

# ── Load Member Info from team.json ──

def _load_team():
    """Load team.json, return (by_name_dict, team_dict, gateway_url)"""
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

    reset_context = team.get("resetcontext","")

    return by_name, team, gateway_url, reset_context


TEAM_BY_NAME, TEAM_CONFIG, GATEWAY_URL, RESET_CONTEXT = _load_team()


# ── Member Validation ──

def validate_member(name):
    """Validate member exists, return normalized name"""
    if name not in TEAM_BY_NAME:
        valid_names = ", ".join(TEAM_BY_NAME.keys())
        print(MESSAGES["ERR_MEMBER_NOT_FOUND"].format(name=name, valid_names=valid_names))
        sys.exit(1)
    return name

def main():
    p = argparse.ArgumentParser(
        description="Agent Task Completion Signal Sender",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  python task_done.py --name 'Zhong Yuan'
"""
    )
    p.add_argument("--name", required=True, help="Agent's own name (must match the name in team.json)")
    args = p.parse_args()

    # Validate member
    name = validate_member(args.name)
    member = TEAM_BY_NAME[name]
    agent_id = member.get("agent_id", "")

    # Load taskprompt from same-name .md file
    taskprompt = _load_task_prompt()

    #Inject send message prompt
    for sectionid in LLM_PROMPT:
        sectionrule=_load_section_rule(sectionid)
        if sectionrule:
            print(sectionrule.replace("<#projectroot#>",Path(__file__).resolve().parent.parent.parent.as_posix() + "/"))
            print("\n")
    rolerule=_load_role_rule(agent_id)
    if ROLE_RULE_BOOL:
        if rolerule:
            print(rolerule.replace("<#projectroot#>",Path(__file__).resolve().parent.parent.parent.as_posix() + "/"))
            print ("\n")
    print(taskprompt)

if __name__ == "__main__":
    main()
