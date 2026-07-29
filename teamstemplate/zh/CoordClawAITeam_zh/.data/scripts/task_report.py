#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
task_done.py - 智能体任务完成信号发送工具

命令参数：
- --name : 智能体自己的名字（从 team.json 中匹配）

功能：
1. 从 team.json 中读取 gatewayUrl 和成员信息
2. 根据 --name 匹配到对应成员，提取 sessionKey
3. 向 session-steer-debug 接口发送 abort 信号
4. 输出发送结果

作者：代可行（基于 chat_manager.py v5.4.3 改造）
版本：v1.0.0（2026-06-02）
"""

import sys
import json
import urllib.request
import urllib.error
import argparse
import re
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

# ── 路径配置 ──
SCRIPT_DIR = Path(__file__).resolve().parent
TEAM_PATH = SCRIPT_DIR.parent / "team.json"
RULE_PATH = SCRIPT_DIR.parent / "team RULE.md"

# ── 集中字符串常量 ──
MESSAGES = {
    "ERR_TEAM_NOT_FOUND": "[错误] 找不到 team.json: {path}",
    "ERR_TEAM_PARSE": "[错误] 解析 team.json 失败: {error}",
    "ERR_MEMBER_NOT_FOUND": "[错误] 找不到成员 '{name}'，有效成员: {valid_names}",
    "ERR_MD_NOT_FOUND": "[警告] 找不到同名的 .md 文件: {path}，使用默认提示词",
}

ROLE_RULE_BOOL=False
LLM_PROMPT = ["x-projectdirectorystructure","x-documenttool"]

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

# ── 加载同名 .md 文件内容 ──

def _load_task_prompt():
    """读取脚本目录下同名的 .md 文件内容作为 taskprompt"""
    script_name = Path(__file__).resolve().stem  # 获取脚本文件名（不含扩展名）
    md_path = SCRIPT_DIR / f"{script_name}.md"

    if not md_path.exists():
        print(MESSAGES["ERR_MD_NOT_FOUND"].format(path=md_path))
        return "按规则执行任务"

    try:
        with open(md_path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception as e:
        print(f"[警告] 读取 .md 文件失败: {e}，使用默认提示词")
        return "按规则执行标准动作"

# ── 从 team.json 加载成员信息 ──

def _load_team():
    """加载 team.json，返回 (by_name_dict, team_dict, gateway_url)"""
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


# ── 成员校验 ──

def validate_member(name):
    """校验成员是否存在，返回标准化后的名字"""
    if name not in TEAM_BY_NAME:
        valid_names = ", ".join(TEAM_BY_NAME.keys())
        print(MESSAGES["ERR_MEMBER_NOT_FOUND"].format(name=name, valid_names=valid_names))
        sys.exit(1)
    return name

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

    # 校验成员
    name = validate_member(args.name)
    member = TEAM_BY_NAME[name]
    agent_id = member.get("agent_id", "")

    # 从同名 .md 文件加载 taskprompt
    taskprompt = _load_task_prompt()

    #注入发送消息提示词
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