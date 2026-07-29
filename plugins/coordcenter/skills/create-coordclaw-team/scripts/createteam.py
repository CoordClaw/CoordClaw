#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CoordClaw Team Verification Script V10.0 - Refactored (i18n Support)
"""

import re
import os
import sys
import json
import shutil
import argparse
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass, field
from typing import List, Tuple, Set, Callable
from collections import Counter


# ============================================================================
# i18n (Internationalization)
# ============================================================================

_I18N_CACHE = {}

def _load_lang_file(lang: str) -> dict:
    """Load language file from same directory as script."""
    if lang in _I18N_CACHE:
        return _I18N_CACHE[lang]
    script_dir = Path(__file__).parent.resolve()
    lang_file = script_dir / f"lang_{lang}.json"
    if not lang_file.exists():
        return {}
    try:
        with open(lang_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        _I18N_CACHE[lang] = data
        return data
    except Exception:
        return {}

def get_language() -> str:
    """Detect language from coordclaw.json, fallback to 'zh'."""
    try:
        user_dir = _read_config_key("openclawUserDir")
        if sys.platform == "win32":
            coordclaw_json = Path(user_dir) / "coordclaw.json"
        else:
            p = Path(user_dir)
            parts = list(p.parts)
            try:
                users_idx = parts.index("Users")
                rel = parts[users_idx + 2:]
                if rel:
                    coordclaw_json = Path.home() / Path(*rel) / "coordclaw.json"
                else:
                    coordclaw_json = Path.home() / ".openclaw/coordclaw.json"
            except (ValueError, IndexError):
                coordclaw_json = Path.home() / ".openclaw/coordclaw.json"
        if coordclaw_json.exists():
            with open(coordclaw_json, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
            return cfg.get("language", "zh")
    except Exception:
        pass
    return "zh"

def tr(key: str, **kwargs) -> str:
    """Translate a key using current language from config. Falls back to key itself."""
    lang = get_language()
    lang_data = _load_lang_file(lang)
    text = lang_data.get(key, key)
    if kwargs:
        try:
            return text.format(**kwargs)
        except KeyError:
            pass
    return text


# ============================================================================
# Path Resolution (i18n)
# ============================================================================

def resolve_coordclaw_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home())
    return Path(base) / "coordclaw"


def find_config_path() -> Path:
    env = os.environ.get("COORDCLAW_CONFIG")
    if env:
        p = Path(env)
        if p.exists():
            return p
    p = resolve_coordclaw_dir() / "config.json"
    if p.exists():
        return p
    p = Path(__file__).parent.resolve() / "config.json"
    if p.exists():
        return p
    raise FileNotFoundError(tr("err_cannot_find_config", path=resolve_coordclaw_dir() / 'config.json'))


def _read_config_key(key: str) -> str:
    with open(find_config_path(), 'r', encoding='utf-8') as f:
        config = json.load(f)
    value = config.get(key)
    if not value:
        raise KeyError(tr("err_config_missing", key=key))
    return value


def _resolve_user_dir(user_dir: str) -> Path:
    if sys.platform == "win32":
        return Path(user_dir) / "coordclaw-teams"
    p = Path(user_dir)
    parts = list(p.parts)
    try:
        users_idx = parts.index("Users")
        relative_parts = parts[users_idx + 2:]
        if relative_parts:
            return Path.home() / Path(*relative_parts) / "coordclaw-teams"
    except (ValueError, IndexError):
        pass
    return Path.home() / ".qclaw/coordclaw-teams"


def get_team_base_dir() -> Path:
    return _resolve_user_dir(_read_config_key("openclawUserDir"))


def _get_coordclaw_root() -> Path:
    coordclaw_root = _read_config_key("coordClawRoot")
    if sys.platform == "win32":
        return Path(coordclaw_root)
    p = Path(coordclaw_root)
    parts = list(p.parts)
    if len(parts) == 1 and ':\\' in str(p):
        win_path = str(p).replace("\\\\", "\\").replace("/", "\\")
        if "Program Files" in win_path:
            idx = win_path.find("Program Files")
            relative = win_path[idx:].replace("\\", "/")
            return Path.home() / relative
        return Path.home() / "coordclaw"
    return Path(coordclaw_root)


def get_template_path(filename: str) -> Path:
    root = _get_coordclaw_root()
    language = get_language()
    path = root / "teamstemplate" / language / ".data" / filename
    if path.exists():
        return path
    fallback = root / "teamstemplate" / "zh" / ".data" / filename
    return fallback if fallback.exists() else path


def get_teamsoul_path() -> Path:
    return get_template_path("teamsoul.md")


def get_teamrule_path() -> Path:
    return get_template_path("team RULE.md")


def get_roleprompt_path() -> Path:
    return get_template_path("roleprompt.json")

DEFAULT_TEAM_BASE_DIR = get_team_base_dir()


# ============================================================================
# Data Models
# ============================================================================

@dataclass
class CheckResult:
    step_name: str
    passed: bool = False
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    info: List[str] = field(default_factory=list)


# ============================================================================
# Logging
# ============================================================================

def log_info(m): print(f"[INFO] {m}")
def log_ok(m): print(f"[OK] {m}")
def log_warn(m): print(f"[FAIL] {m}")
def log_error(m): print(f"[ERROR] {m}")


# ============================================================================
# Helpers
# ============================================================================

def read_file_safe(filepath: Path) -> str:
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        return f"__ERROR__:{e}"


def write_file_safe(filepath: Path, content: str) -> bool:
    try:
        filepath.parent.mkdir(parents=True, exist_ok=True)
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        return True
    except Exception as e:
        log_error(tr("err_failed_write_file", filepath=filepath, err=e))
        return False


def validate_team_name(team_name: str) -> Tuple[bool, str]:
    if not team_name:
        return False, tr("err_team_name_empty")
    if not re.match(r'^[\w-]+$', team_name):
        return False, tr("err_team_name_invalid", team_name=team_name)
    return True, ""


# ============================================================================
# Extraction Functions
# ============================================================================

def get_agent_ids_from_agents_start(content: str, include_human: bool = False) -> Tuple[List[str], str]:
    # Extract agent IDs from the AGENTS:START marker
    match = re.search(r'<!--\s*AGENTS:START\s+([\w,-]+)\s*-->', content)
    if not match:
        return [], tr("err_agents_start_not_found")
    agent_ids = [x.strip() for x in match.group(1).split(",") if x.strip()]
    
    # Check if any agent ID contains "human" (case-insensitive)
    # This prevents mistakenly adding human members to the agent list
    human_in_agents = [aid for aid in agent_ids if "human" in aid.lower()]
    if human_in_agents:
        return agent_ids, tr("err_human_in_agents")
    
    if include_human:
        # Also extract human IDs from the HUMAN:START marker
        human_match = re.search(r'<!--\s*HUMAN:START\s+([\w,-]+)\s*-->', content)
        if human_match:
            human_ids = [x.strip() for x in human_match.group(1).split(",") if x.strip()]
            seen = set(agent_ids)
            for hid in human_ids:
                if hid not in seen:
                    agent_ids.append(hid)
                    seen.add(hid)
    if not agent_ids:
        return [], tr("err_agents_start_empty")
    invalid_ids = [aid for aid in agent_ids if not re.match(r'^[\w-]+$', aid)]
    if invalid_ids:
        return agent_ids, tr("err_agent_id_invalid") + ", ".join(invalid_ids)
    return agent_ids, ""


def get_section_ids_from_sections(content: str) -> Tuple[Set[str], str]:
    section_ids = set(re.findall(r'<!--\s*SECTION:START\s+id=(\S+)', content))
    if not section_ids:
        return set(), tr("err_section_start_not_found")
    for sid in section_ids:
        end_pattern = rf'<!--\s*SECTION:END\s+id={re.escape(sid)}\b[^>]*-->'
        if not re.search(end_pattern, content):
            return section_ids, tr("err_section_end_missing", sid=sid)
    return section_ids, ""


def get_role_sections_from_teamrule(content: str) -> Tuple[List[Tuple[str, str, str]], str]:
    pattern = r'<!--\s*SECTION:START\s+id=(\S+)\s+role=(\S+)\s+name=("[^"]*"|\S+)(?:\s+[^>]*)?\s*-->'
    matches = re.findall(pattern, content)
    matches = [(sid, role, name.strip('"')) for sid, role, name in matches]
    if not matches:
        return [], tr("err_role_section_not_found_tr")
    return matches, ""


def get_role_sections_from_teamsoul(content: str) -> Tuple[List[Tuple[str, str]], str]:
    pattern = r'<!--\s*SECTION:START\s+id=(\S+)\s+name=("[^"]*"|\S+)\s*-->'
    matches = re.findall(pattern, content)
    matches = [(sid, name.strip('"')) for sid, name in matches]
    if not matches:
        return [], tr("err_role_section_not_found_ts")
    return matches, ""


def get_agent_names_from_teamsoul(team_dir: Path) -> List[str]:
    teamsoul_file = team_dir / '.data' / 'teamsoul.md'
    if not teamsoul_file.exists():
        return []
    content = read_file_safe(teamsoul_file)
    if content.startswith("__ERROR__"):
        return []

    agent_ids, _ = get_agent_ids_from_agents_start(content)
    agent_ids = [aid for aid in agent_ids if "human" not in aid.lower()]
    role_sections, _ = get_role_sections_from_teamsoul(content)
    id_to_name = dict(role_sections)

    return [id_to_name[aid] for aid in agent_ids if aid in id_to_name]


# ============================================================================
# Consistency Check
# ============================================================================

def check_agents_sections_consistency(
    content: str, label: str, get_role_func: Callable, step_name: str, include_human: bool = False
) -> CheckResult:
    result = CheckResult(step_name=step_name)
    agents_ids, err = get_agent_ids_from_agents_start(content, include_human=include_human)
    if err:
        result.errors.append(tr("err_agents_start_prefix", err=err))
        if not agents_ids:
            result.passed = False
            return result
    agents_set = set(agents_ids)
    result.info.append(tr("info_agents_start_list", count=len(agents_set), ids=", ".join(sorted(agents_set))))
    role_sections, err = get_role_func(content)
    if err:
        result.errors.append(tr("err_role_section", err=err))
        section_ids = set()
    else:
        section_ids = set(sid for sid, *_ in role_sections)
        result.info.append(tr("info_role_section_ids", count=len(section_ids), ids=", ".join(sorted(section_ids))))
        for section in role_sections:
            if len(section) == 3:
                sid, role, name = section
                result.info.append(tr("info_role_section_detail_3", sid=sid, role=role, name=name))
            elif len(section) == 2:
                sid, name = section
                result.info.append(tr("info_role_section_detail_2", sid=sid, name=name))
    missing_in_sections = agents_set - section_ids
    missing_in_agents = section_ids - agents_set
    if missing_in_sections:
        result.errors.append(tr("err_missing_in_sections", ids=", ".join(sorted(missing_in_sections))))
    if missing_in_agents:
        result.errors.append(tr("err_missing_in_agents", ids=", ".join(sorted(missing_in_agents))))
    if not missing_in_sections and not missing_in_agents:
        result.info.append(tr("info_agents_sections_match", count=len(agents_set)))
    if len(agents_set) != len(section_ids):
        result.errors.append(tr("err_count_mismatch", agents_count=len(agents_set), sections_count=len(section_ids)))
    else:
        result.info.append(tr("info_count_match", count=len(agents_set)))
    result.passed = len(result.errors) == 0
    return result


# ============================================================================
# File Check
# ============================================================================

def check_file_exists(filepath: Path, step_name: str) -> CheckResult:
    result = CheckResult(step_name=step_name)
    if not filepath.exists():
        result.errors.append(tr("err_file_not_exist", filepath=filepath))
        result.passed = False
    else:
        result.info.append(tr("info_file_exist", filepath=filepath))
        result.passed = True
    return result


# ============================================================================
# Worklog
# ============================================================================

def clean_worklog_subdirs(worklog_dir: Path, keep_names: Set[str]) -> Tuple[bool, str]:
    removed = []
    try:
        for item in worklog_dir.iterdir():
            if item.is_dir() and item.name not in keep_names:
                shutil.rmtree(item)
                removed.append(item.name)
        msg = tr("info_cleaned_subdirs", count=len(removed))
        if removed:
            msg += f"：{', '.join(removed)}"
        return True, msg
    except Exception as e:
        return False, tr("err_clean_subdirs_failed", err=e)


def parse_worklog_template(filepath: Path) -> Tuple[str, str]:
    default_prefix = "workLog"
    default_content = tr("worklog_default_content")
    if not filepath.exists():
        return default_prefix, default_content
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            text = f.read()
    except Exception:
        return default_prefix, default_content
    match = re.match(r'^---\s*\n(.*?)\n---\s*\n(.*)', text, re.DOTALL)
    if not match:
        return default_prefix, text
    front_matter = match.group(1)
    content = match.group(2)
    prefix = default_prefix
    for line in front_matter.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if ':' in line:
            key, val = line.split(':', 1)
            if key.strip() == 'filename_prefix':
                prefix = val.strip().strip('"').strip("'")
                break
    return prefix, content


def create_worklog_for_agent(worklog_dir: Path, agent_name: str) -> Tuple[bool, str]:
    agent_dir = worklog_dir / agent_name
    try:
        agent_dir.mkdir(parents=True, exist_ok=True)
        today = datetime.now().strftime('%Y-%m-%d')
        template_path = get_teamsoul_path().parent / "worklog.md"
        prefix, content = parse_worklog_template(template_path)
        log_filename = f'{prefix}-{agent_name}-{today}-001.md'
        log_file = agent_dir / log_filename
        if not log_file.exists():
            with open(log_file, 'w', encoding='utf-8') as f:
                f.write(content)
            return True, tr("info_worklog_created", agent_dir=agent_dir, log_filename=log_filename)
        else:
            return True, tr("info_worklog_exists", agent_name=agent_name)
    except Exception as e:
        return False, str(e)


def setup_worklog_directory(team_dir: Path, agent_names: List[str], created_log: List[str]) -> None:
    worklog_dir = team_dir / 'worklog'
    worklog_dir.mkdir(parents=True, exist_ok=True)
    if tr("info_confirm_dir_worklog") not in created_log:
        created_log.append(tr("info_confirm_dir_worklog"))
    keep_names = set(agent_names)
    success, msg = clean_worklog_subdirs(worklog_dir, keep_names)
    if success and len([x for x in worklog_dir.iterdir() if x.is_dir() and x.name not in keep_names]) > 0:
        created_log.append(f"  {msg}")
    for name in agent_names:
        success, msg = create_worklog_for_agent(worklog_dir, name)
        if success:
            created_log.append(f"  {msg}")
        else:
            created_log.append(f"  [ERROR] {msg}")


# ============================================================================
# Initialization
# ============================================================================

def initialize_team_structure(team_dir: Path) -> Tuple[bool, List[str]]:
    created = []
    anything_created = False
    if not team_dir.exists():
        team_dir.mkdir(parents=True, exist_ok=True)
        created.append(tr("info_create_team_root", team_dir=team_dir))
        anything_created = True
    try:
        if team_dir.exists():
            base = team_dir.parent
            marker = base / '.newteam.lock'
            tmp = base / '.newteam.lock.tmp'
            tmp.write_text(team_dir.name, encoding='utf-8')
            tmp.replace(marker)
    except Exception:
        pass
    for subdir in ['.data', '.data/scripts', '.data/data', 'temp', 'worklog']:
        d = team_dir / subdir
        if not d.exists():
            d.mkdir(parents=True, exist_ok=True)
            created.append(tr("info_create_dir", subdir=subdir))
            anything_created = True
    created.append(tr("info_dir_structure_json"))
    return anything_created, created


# ============================================================================
# Verification Steps
# ============================================================================

def _check_file_and_read(team_dir: Path, filename: str, step_name: str) -> Tuple[CheckResult, str]:
    filepath = team_dir / '.data' / filename
    result = CheckResult(step_name=step_name)
    if not filepath.exists():
        result.errors.append(tr("err_file_not_exist", filepath=filepath))
        result.passed = False
        return result, ""
    content = read_file_safe(filepath)
    if content.startswith("__ERROR__"):
        result.errors.append(tr("err_read_file_failed", content=content))
        result.passed = False
        return result, ""
    result.info.append(tr("info_file_exist", filepath=filepath))
    return result, content


def step4_check_teamsoul_exists(team_dir: Path) -> CheckResult:
    return check_file_exists(team_dir / '.data' / 'teamsoul.md', tr("step_teamsoul_exists"))


def step4_2_validate_teamsoul_format(team_dir: Path) -> CheckResult:
    result, content = _check_file_and_read(team_dir, 'teamsoul.md', tr("step_teamsoul_format"))
    if not content:
        return result
    agent_ids, err = get_agent_ids_from_agents_start(content)
    if err:
        result.errors.append(tr("err_agents_start_prefix", err=err))
    else:
        result.info.append(tr("info_agents_start_count", count=len(agent_ids), ids=", ".join(agent_ids)))
    section_ids, err = get_section_ids_from_sections(content)
    if err:
        result.errors.append(tr("err_section", err=err))
    else:
        result.info.append(tr("info_section_start_count", count=len(section_ids)))
    if not re.search(r'<!--\s*SECTION:START\s+id=common\b', content):
        result.errors.append(tr("err_missing_common_section"))
    else:
        result.info.append(tr("info_found_common_section"))
    names = get_agent_names_from_teamsoul(team_dir)
    unique_names = set(names)
    if len(names) != len(unique_names):
        dupes = [n for n, c in Counter(names).items() if c > 1]
        result.errors.append(tr("err_names_not_unique", total=len(names), unique=len(unique_names), dupes=dupes))
    else:
        result.info.append(tr("info_names_unique", count=len(names), names=", ".join(unique_names)))
    agent_id_bold = tr("pattern_agent_id_bold")
    name_field_bold = tr("pattern_name_field_bold")
    has_bold = agent_id_bold in content or name_field_bold in content
    result.info.append(tr("info_markdown_bold") if has_bold else tr("info_plain_text"))
    result.passed = len(result.errors) == 0
    return result


def step5_check_team_rule_exists(team_dir: Path) -> CheckResult:
    return check_file_exists(team_dir / '.data' / 'team RULE.md', tr("step_teamrule_exists"))


def step5_2_validate_team_rule_format(team_dir: Path) -> CheckResult:
    result, content = _check_file_and_read(team_dir, 'team RULE.md', tr("step_teamrule_format"))
    if not content:
        return result
    agent_ids, err = get_agent_ids_from_agents_start(content)
    if err:
        result.errors.append(tr("err_agents_start_prefix", err=err))
    else:
        result.info.append(tr("info_agents_start_count", count=len(agent_ids), ids=", ".join(agent_ids)))
    section_ids, err = get_section_ids_from_sections(content)
    if err:
        result.errors.append(tr("err_section", err=err))
    else:
        result.info.append(tr("info_section_start_count", count=len(section_ids)))
    for sid in ["common", "individual", "boundary"]:
        pattern = r'<!--\s*SECTION:START\s+id=' + re.escape(sid) + r'\b'
        if not re.search(pattern, content):
            result.errors.append(tr("err_missing_section", sid=sid))
        else:
            result.info.append(tr("info_found_section", sid=sid))
    text_org = tr("text_org_relation")
    if text_org not in content:
        result.errors.append(tr("err_missing_org_table"))
    else:
        result.info.append(tr("info_found_org_table"))
        table_level_header = tr("pattern_table_level")
        header_pos = content.find(f"| {table_level_header} |")
        if header_pos == -1:
            header_pos = content.find(f"|{table_level_header}|")
        if header_pos != -1:
            lines = content[header_pos:].split("\n")
            table_lines = []
            for line in lines:
                s = line.strip()
                if s == "" or not s.startswith("|"):
                    break
                table_lines.append(s)
            data_rows = []
            for r in table_lines:
                if r.startswith("|") and table_level_header not in r and not re.match(r'\|\s*[-:]+\s*\|', r):
                    cells = [c.strip() for c in r.split("|") if c.strip()]
                    if cells:
                        data_rows.append(r)
            result.info.append(tr("info_org_table_rows", count=len(data_rows)))
            teamsoul_file = team_dir / '.data' / 'teamsoul.md'
            if teamsoul_file.exists():
                ts_content = read_file_safe(teamsoul_file)
                if not ts_content.startswith("__ERROR__"):
                    ts_agent_ids, _ = get_agent_ids_from_agents_start(ts_content)
                    expected = len(ts_agent_ids)
                    if len(data_rows) != expected:
                        result.errors.append(tr("err_org_table_rows_mismatch", expected=expected, actual=len(data_rows)))
                    else:
                        result.info.append(tr("info_org_table_rows_ok", expected=expected))
                    tr_agent_ids, _ = get_agent_ids_from_agents_start(content)
                    if set(ts_agent_ids) != set(tr_agent_ids):
                        missing_in_tr = set(ts_agent_ids) - set(tr_agent_ids)
                        extra_in_tr = set(tr_agent_ids) - set(ts_agent_ids)
                        if missing_in_tr:
                            result.errors.append(tr("err_tr_missing_agent_ids", ids=", ".join(sorted(missing_in_tr))))
                        if extra_in_tr:
                            result.errors.append(tr("err_tr_extra_agent_ids", ids=", ".join(sorted(extra_in_tr))))
                    else:
                        result.info.append(tr("info_agent_ids_match", count=len(ts_agent_ids)))
    human_match = re.search(r'<!--\s*HUMAN:START\s+([\w,-]+)\s*-->', content)
    if not human_match:
        result.errors.append(tr("err_no_human_members"))
    else:
        human_ids = [x.strip() for x in human_match.group(1).split(",") if x.strip()]
        if not human_ids:
            result.errors.append(tr("err_no_human_members"))
    result.passed = len(result.errors) == 0
    return result


def step3_check_dir_structure(team_dir: Path) -> CheckResult:
    result = CheckResult(step_name=tr("step_dir_structure"))
    EXCLUDED_PREFIXES = {"worklog/"}


    for d in [".data", "temp"]:
        if (team_dir / d).exists():
            result.info.append(f"Root directory exists: {d}/")
        else:
            result.errors.append(f"Root directory missing: {d}/")

    worklog_dir = team_dir / "worklog"
    if worklog_dir.exists():
        result.info.append(tr("info_root_dir_exists", d="worklog"))
    else:
        result.info.append(tr("info_root_dir_missing", d="worklog"))
        worklog_dir.mkdir(parents=True, exist_ok=True)
        result.info.append(tr("info_auto_created_dir", d="worklog"))

    agent_names = get_agent_names_from_teamsoul(team_dir)
    if agent_names:
        result.info.append(tr("info_read_agents_from_teamsoul", count=len(agent_names)))
        setup_worklog_logs = []
        setup_worklog_directory(team_dir, agent_names, setup_worklog_logs)
        for log in setup_worklog_logs:
            if log.startswith("[ERROR]"):
                result.errors.append(f"  {log}")
            elif log.startswith("[FAIL]"):
                result.warnings.append(f"  {log}")
            else:
                result.info.append(f"  {log}")
    else:
        result.info.append(tr("info_skip_worklog_check"))

    data_dir = team_dir / ".data"
    if data_dir.exists():
        for f in ["teamsoul.md", "team RULE.md"]:
            if (data_dir / f).exists():
                result.info.append(tr("info_data_exists", f=f))
            else:
                result.errors.append(tr("err_data_missing", f=f))
        for d in ["scripts", "data"]:
            if (data_dir / d).exists():
                result.info.append(tr("info_data_dir_exists", d=d))

    json_file = team_dir / "dir_structure.json"
    if not json_file.exists():
        result.errors.append(tr("err_dir_structure_missing"))
        result.passed = False
        return result
    try:
        with open(json_file, 'r', encoding='utf-8') as f:
            config = json.load(f)
        if not config or 'directories' not in config:
            result.errors.append(tr("err_json_format"))
            result.passed = False
            return result
        expected_dirs = set()
        for dinfo in config.get("directories", []):
            if isinstance(dinfo, dict) and dinfo.get("name"):
                expected_dirs.add(dinfo["name"])
            else:
                result.warnings.append(tr("warn_json_bad_entry", dinfo=dinfo))
        expected_dirs = {d for d in expected_dirs if not any(d.startswith(prefix) for prefix in EXCLUDED_PREFIXES)}
        result.info.append(tr("info_json_dir_count", count=len(expected_dirs)))
        for d in expected_dirs:
            if (team_dir / d).exists():
                result.info.append(tr("info_dir_exists", d=d))
            else:
                result.errors.append(tr("err_dir_missing", d=d))
    except Exception as e:
        result.errors.append(tr("err_read_json_failed", err=e))
    result.passed = len(result.errors) == 0
    return result


def step6_check_project_charter(team_dir: Path) -> CheckResult:
    result = CheckResult(step_name=tr("step_project_charter"))
    charter_filename = tr("filename_project_charter")
    charter_file = team_dir / charter_filename
    content = ""  # 默认值，防止文件不存在时 NameError
    if not charter_file.exists():
        result.errors.append(tr("err_charter_not_exist", filepath=charter_file))
        result.passed = False
    else:
        result.info.append(tr("info_charter_exists", filepath=charter_file))
        content = read_file_safe(charter_file)
        if content.startswith("__ERROR__"):
            result.errors.append(tr("err_read_charter_failed", content=content))
        else:
            result.info.append(tr("info_charter_length", length=len(content)))
        result.passed = len(result.errors) == 0
    return result


def step5_3_check_projectroot_placeholder(team_dir: Path) -> CheckResult:
    result, content = _check_file_and_read(team_dir, 'team RULE.md', tr("step_projectroot_placeholder"))
    if not content:
        return result
    placeholder_count = content.count('<#projectroot#>')
    if placeholder_count == 0:
        result.errors.append(tr("err_missing_placeholder"))
        result.passed = False
    else:
        result.info.append(tr("info_placeholder_count", count=placeholder_count))
        suspicious = []
        for match in re.findall(r'<#[^#]*[/\\][^#]*#>', content):
            suspicious.append(match)
        for match in re.findall(r'<#[^#]*:[^#]*#>', content):
            suspicious.append(match)
        for match in re.findall(r'<#[^#]*\.\.[^#]*#>', content):
            suspicious.append(match)
        if suspicious:
            result.warnings.append(tr("warn_suspicious_placeholder", suspicious=suspicious))
        result.passed = True
    return result


def _check_agents_consistency(team_dir: Path, filename: str, step_name: str, get_role_func: Callable, include_human: bool = False) -> CheckResult:
    result, content = _check_file_and_read(team_dir, filename, step_name)
    if not content:
        return result
    return check_agents_sections_consistency(content, filename, get_role_func, step_name, include_human=include_human)


def step4_3_check_teamsoul_agents_sections_consistency(team_dir: Path) -> CheckResult:
    return _check_agents_consistency(team_dir, 'teamsoul.md', tr("step_teamsoul_consistency"), get_role_sections_from_teamsoul)


def step5_4_check_teamrule_agents_sections_consistency(team_dir: Path) -> CheckResult:
    return _check_agents_consistency(team_dir, 'team RULE.md', tr("step_teamrule_consistency"), get_role_sections_from_teamrule, include_human=True)


def step7_check_roleprompt_json(team_dir: Path) -> CheckResult:
    result = CheckResult(step_name=tr("step_roleprompt"))
    roleprompt_file = team_dir / '.data' / 'roleprompt.json'
    if not roleprompt_file.exists():
        result.errors.append(tr("err_roleprompt_not_exist", filepath=roleprompt_file))
        result.passed = False
        return result
    result.info.append(tr("info_roleprompt_exists", filepath=roleprompt_file))
    content = read_file_safe(roleprompt_file)
    if content.startswith("__ERROR__"):
        result.errors.append(tr("err_read_file_failed", content=content))
        result.passed = False
        return result
    try:
        data = json.loads(content)
        result.info.append(tr("info_roleprompt_format_ok", type=type(data).__name__))
        if isinstance(data, dict):
            keys = list(data.keys())
            result.info.append(tr("info_roleprompt_keys", count=len(keys), keys=keys[:5]) + ("..." if len(keys) > 5 else ""))
        else:
            result.warnings.append(tr("warn_roleprompt_not_dict", type=type(data).__name__))
    except json.JSONDecodeError as e:
        result.errors.append(tr("err_roleprompt_json_parse", err=e))
        result.passed = False
        return result
    except Exception as e:
        result.errors.append(tr("err_roleprompt_verify", err=e))
        result.passed = False
        return result
    result.passed = True
    return result


# ============================================================================
# Output
# ============================================================================

def print_result(result: CheckResult):
    print(f"\n{'='*60}")
    print(f"[FAIL] {result.step_name}")
    print(f"{'='*60}")
    if result.warnings:
        for warning in result.warnings:
            log_warn(warning)
    if result.errors:
        for error in result.errors:
            log_error(error)


# ============================================================================
# Unified Verification Runner
# ============================================================================

def run_verification(team_dir: Path, team_name: str, cmd_suffix: str = "") -> int:
    results = [
        step3_check_dir_structure(team_dir),
        step4_check_teamsoul_exists(team_dir),
        step4_2_validate_teamsoul_format(team_dir),
        step4_3_check_teamsoul_agents_sections_consistency(team_dir),
        step5_check_team_rule_exists(team_dir),
        step5_2_validate_team_rule_format(team_dir),
        step5_3_check_projectroot_placeholder(team_dir),
        step5_4_check_teamrule_agents_sections_consistency(team_dir),
        step6_check_project_charter(team_dir),
        step7_check_roleprompt_json(team_dir),
    ]
    failed_steps = [r.step_name for r in results if not r.passed]
    for result in results:
        if not result.passed:
            print_result(result)
    total_errors = sum(len(r.errors) for r in results)
    total_warnings = sum(len(r.warnings) for r in results)
    if total_errors == 0:
        json_file = team_dir / "dir_structure.json"
        if json_file.exists():
            try:
                json_file.unlink()
            except Exception:
                pass
    ok_log_file = Path(team_dir) / '.createteamok.log'
    if total_errors == 0:
        try:
            with open(ok_log_file, 'a', encoding='utf-8') as f:
                timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                f.write(f"[{timestamp}] Team '{team_name}' verification passed\n")
            print(tr("ok_complete"))
        except Exception:
            pass
    else:
        print(f"\n{'='*60}")
        log_error(tr("err_verification_failed"))
        for step in failed_steps:
            print(f"    ✗ {step}")
        print(f"{'='*60}")
        print()
        log_error(tr("must_fix"))
        cmd = f"python {Path(__file__).name} {cmd_suffix} {team_name}".strip()
        print(f"    {cmd}")
        print()
        log_warn(tr("err_script_failed"))
    return 0 if total_errors == 0 else 1


# ============================================================================
# Main
# ============================================================================

def main():
    parser = argparse.ArgumentParser(description=tr("desc_script"))
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--init", action="store_true", help=tr("desc_init"))
    group.add_argument("--verify", action="store_true", help=tr("desc_verify"))
    group.add_argument("--soul", action="store_true", help=tr("desc_soul"))
    group.add_argument("--rule", action="store_true", help=tr("desc_rule"))
    group.add_argument("--roleprompt", action="store_true", help=tr("desc_roleprompt"))
    parser.add_argument("team_name", nargs="?", default="", help=tr("desc_team_name"))
    parser.add_argument("--team-base-dir", default=str(DEFAULT_TEAM_BASE_DIR), help=tr("desc_team_base_dir") + f" (default: {DEFAULT_TEAM_BASE_DIR})")
    args = parser.parse_args()

    if args.soul:
        try:
            print(tr("msg_soul_path"))
            print(str(get_teamsoul_path()))
            sys.exit(0)
        except Exception as e:
            log_error(tr("err_failed_get_soul", err=e))
            sys.exit(1)
    if args.rule:
        try:
            print(tr("msg_rule_path"))
            print(str(get_teamrule_path()))
            sys.exit(0)
        except Exception as e:
            log_error(tr("err_failed_get_rule", err=e))
            sys.exit(1)
    if args.roleprompt:
        try:
            print(tr("msg_roleprompt_path"))
            print(str(get_roleprompt_path()))
            sys.exit(0)
        except Exception as e:
            log_error(tr("err_failed_get_roleprompt", err=e))
            sys.exit(1)

    team_name = args.team_name
    if not team_name:
        parser.print_help()
        sys.exit(1)
    valid, msg = validate_team_name(team_name)
    if not valid:
        log_error(msg)
        sys.exit(1)
    team_dir = Path(args.team_base_dir) / team_name

    if args.init:
        anything_created, created_logs = initialize_team_structure(team_dir)
        if anything_created:
            for log in created_logs:
                print(f"  [CREATE] {log}")
            print(f"\n[INFO] {tr('info_init_complete')}")
            print(f"       {tr('info_run_verify', script_name=Path(__file__).name, team_name=args.team_name)}")
            sys.exit(0)
        else:
            print(tr("ok_no_init_needed"))
            sys.exit(0)

    if args.verify:
        if not team_dir.exists():
            log_error(tr("err_team_dir_not_exist", team_dir=team_dir))
            print(f"\n[INFO] {tr('info_to_initialize', script_name=Path(__file__).name, team_name=args.team_name)}")
            sys.exit(1)
        sys.exit(run_verification(team_dir, team_name, "--verify"))

    anything_created, created_logs = initialize_team_structure(team_dir)
    if anything_created:
        for log in created_logs:
            print(f"  [CREATE] {log}")
        print(f"\n[INFO] {tr('info_init_complete')}")
        print(f"       {tr('info_run_verify', script_name=Path(__file__).name, team_name=args.team_name)}")
        sys.exit(0)

    sys.exit(run_verification(team_dir, team_name))


if __name__ == "__main__":
    main()