#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
task_start.py - 智能体开始任务时获取准备资料

命令参数：
- --name : 智能体自己的名字（从 team.json 中匹配）

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
WORKLOG_PATH = SCRIPT_DIR.parent.parent / "worklog"

# ── 集中字符串常量 ──
MESSAGES = {
    "ERR_TEAM_NOT_FOUND": "[错误] 找不到 team.json: {path}",
    "ERR_TEAM_PARSE": "[错误] 解析 team.json 失败: {error}",
    "ERR_MEMBER_NOT_FOUND": "[错误] 找不到成员 '{name}'，有效成员: {valid_names}",
}

ROLE_RULE_BOOL = False
LLM_PROMPT = ["x-teamorganization", "x-projectdirectorystructure", "x-codingstandards", "x-documenttool"]


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


def _load_task_prompt():
    """读取脚本目录下同名的 .md 文件内容作为 taskprompt"""
    script_name = Path(__file__).resolve().stem  # 获取脚本文件名（不含扩展名）
    md_path = SCRIPT_DIR / f"{script_name}.md"

    if not md_path.exists():
        return "请读取worklog目录下自己姓名文件夹里的最新工作日志。"

    try:
        with open(md_path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception as e:
        return "请读取worklog目录下自己姓名文件夹里的最新工作日志。"


def _find_latest_logs(agent_name):
    """
    查找最新工作日志：同时从两个来源获取，去重后返回所有结果。

    来源 1：扫描 worklog/{agent_name}/ 目录，按 mtime 取最新的 .md 文件。
    来源 2：读取 worklog/{agent_name}/.record.jsonl 最后一行的 latest 字段。

    两个来源的结果若指向同一文件（通过 resolve() 比对），只保留一个。
    若指向不同文件，则两个都返回。
    """
    agent_log_dir = WORKLOG_PATH / agent_name
    results = []
    resolved_paths = set()

    # 来源 1：按文件 mtime 查找最新的 .md 文件
    if agent_log_dir.exists() and agent_log_dir.is_dir():
        md_files = [
            f for f in agent_log_dir.iterdir()
            if f.is_file() and f.suffix.lower() == ".md"
        ]
        if md_files:
            latest_by_mtime = max(md_files, key=lambda f: f.stat().st_mtime)
            results.append(latest_by_mtime)
            resolved_paths.add(latest_by_mtime.resolve())

    # 来源 2：从 .record.jsonl 读取最新记录
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
    """加载 team.json，返回 (by_name_dict, team_dict, gateway_url, reset_context)"""
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
    """校验成员是否存在，返回标准化后的名字"""
    if name not in TEAM_BY_NAME:
        valid_names = ", ".join(TEAM_BY_NAME.keys())
        print(MESSAGES["ERR_MEMBER_NOT_FOUND"].format(name=name, valid_names=valid_names))
        sys.exit(1)
    return name


def main():
    p = argparse.ArgumentParser(
        description="智能体开始任务时获取准备资料",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例:
  python task_start.py --name '钟远'
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

    # 查找并输出最新工作日志路径（两个来源都去查，不同文件则都输出）
    latest_logs = _find_latest_logs(name)
    if latest_logs:
        print("已找到最新工作日志：")
        for log_path in latest_logs:
            print(log_path)
        if len(latest_logs)>1:
            print("**警告**：你上轮任务没有执行T5动作，本轮任务完成时必须执行T5动作，本轮任务完成时必须执行T5动作，本轮完成任务时必须执行T5！")
        print("读取后按照下面提示收集资料并完成消息任务：")
        print()

    # 注入通用规则提示词
    for sectionid in LLM_PROMPT:
        sectionrule = _load_section_rule(sectionid)
        if sectionrule:
            print(sectionrule.replace("<#projectroot#>", Path(__file__).resolve().parent.parent.parent.as_posix() + "/"))
            print("\n")

    # 注入角色专属规则提示词
    rolerule = _load_role_rule(agent_id)
    if ROLE_RULE_BOOL:
        if rolerule:
            print(rolerule.replace("<#projectroot#>", Path(__file__).resolve().parent.parent.parent.as_posix() + "/"))
            print("\n")

    print(taskprompt)


if __name__ == "__main__":
    main()