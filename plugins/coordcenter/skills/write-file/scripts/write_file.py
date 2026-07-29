#!/usr/bin/env python3
"""
text-file-writer: 跨平台文本文件写入脚本
=========================================
解决 OpenClaw write 工具硬编码 utf-8 (无 BOM) 导致 Windows Excel
打开 CSV/TSV 文件时中文乱码的问题。

用法:
  # 平台探测（不写文件，仅返回当前系统信息）
  python3 write_file.py --detect

  # 写入文件
  python3 write_file.py --path <文件路径> --content-file <内容临时文件> [选项]
  python3 write_file.py --path <文件路径> --content <内容字符串> [选项]

选项:
  --detect             探测当前平台并输出 JSON，不做任何文件写入（推荐写文件前先调用）
  --encoding <enc>     显式指定编码。不传则根据文件后缀和目标平台自动推断。
                       可选值: utf-8 | utf-8-sig | gbk | gb18030 | utf-16 | utf-16-le | auto (默认 auto)
  --platform <p>       目标平台。不传则自动检测当前平台。
                       可选值: windows | mac | linux | auto (默认 auto)
  --newline <nl>       换行符。不传则根据平台自动选择。
                       可选值: crlf | lf | preserve | auto (默认 auto)
                       preserve: 保留已有文件的换行符风格（文件不存在时退化为 auto）
  --preserve           同时启用 --preserve-bom 和 --preserve-newline
  --preserve-bom       若目标文件已存在且有 BOM，则保留 BOM（即使推断规则认为不需要）
  --preserve-newline   等同于 --newline preserve
  --append             追加模式（不覆盖，追加到文件末尾）
  --no-mkdir           禁止自动创建父目录

退出码:
  0  成功
  1  参数错误
  2  写入失败

输出 (stdout, JSON):
  # --detect 模式
  {"platform": "mac", "system": "Darwin", "python": "3.11.0",
   "default_csv_encoding": "utf-8", "default_csv_bom": false}

  # 写入成功
  {"status": "ok", "path": "<绝对路径>", "encoding": "<实际使用的编码>",
   "bom": true/false, "newline": "crlf"/"lf", "bytes": <字节数>,
   "mode": "write"/"append", "preserved_bom": true/false, "preserved_newline": true/false}

  {"status": "error", "message": "<错误信息>"}
"""

import os
import argparse
import json
import platform
import subprocess
import datetime
import sys
import hashlib
from pathlib import Path

# ── 编码推断规则 ──────────────────────────────────────────────────────────────

# 需要 BOM 的场景：供 Windows Excel 直接双击打开的表格文件
# Excel 依赖 BOM (EF BB BF) 来识别 UTF-8，无 BOM 时回落到系统 ANSI (GBK)
_EXCEL_FRIENDLY_EXTS = {".csv", ".tsv"}

# 需要 UTF-16 LE with BOM 的文件（Windows 注册表文件）
_UTF16_LE_BOM_EXTS = {".reg"}

# Windows ANSI (GBK) 文件（Windows 安装信息文件）
_WINDOWS_ANSI_EXTS = {".inf"}

# 禁止加 BOM 的文件类型（BOM 会导致解析错误或语法错误）
_NO_BOM_EXTS = {
    # 数据交换格式
    ".json", ".jsonc", ".json5",
    ".yaml", ".yml",
    ".toml", ".ini", ".cfg", ".conf",

    # Web 标记语言
    ".html", ".htm", ".xhtml",
    ".xml", ".svg",

    # Shell 脚本（Unix shell 不识别 BOM）
    ".sh", ".bash", ".zsh", ".fish",
    # 注意：.bat/.cmd 有单独逻辑处理

    # 文档
    ".md", ".markdown", ".rst", ".txt",

    # JavaScript/TypeScript 生态
    ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
    ".vue", ".svelte",

    # Python
    ".py", ".pyi", ".pyx",

    # CSS 系列
    ".css", ".less", ".scss", ".sass", ".styl",

    # 系统语言
    ".go", ".rs",
    ".c", ".cpp", ".cc", ".h", ".hpp", ".hxx",
    ".java", ".kt", ".kts", ".scala", ".groovy",

    # 其他编程语言
    ".swift", ".m", ".mm",      # Apple
    ".rb", ".erb",              # Ruby
    ".php",                     # PHP
    ".dart",                    # Dart
    ".lua",                     # Lua
    ".r", ".R",                 # R
    ".pl", ".pm",               # Perl
    ".ex", ".exs",              # Elixir
    ".erl", ".hrl",             # Erlang
    ".hs", ".lhs",              # Haskell
    ".fs", ".fsx",              # F#
    ".clj", ".cljs", ".cljc",   # Clojure
    ".elm",                     # Elm
    ".v", ".sv",                # Verilog/SystemVerilog
    ".vhd", ".vhdl",            # VHDL

    # 数据/查询语言
    ".sql",
    ".graphql", ".gql",
    ".proto",

    # 配置/元文件
    ".env",
    ".editorconfig",
    ".gitignore", ".gitattributes", ".gitmodules",
    ".dockerignore", ".npmignore",
    ".prettierrc", ".eslintrc", ".stylelintrc", ".babelrc",
    ".nvmrc", ".node-version", ".python-version", ".ruby-version",

    # 锁文件
    ".lock",

    # 日志
    ".log",

    # IaC / DevOps
    ".tf", ".tfvars",           # Terraform
    ".hcl",                     # HCL
    ".nix",                     # Nix
    ".prisma",                  # Prisma
    ".plist",                   # Apple Property List (XML)
}

# 常见无后缀文件名（全部使用 UTF-8 无 BOM）
_NO_BOM_FILENAMES = {
    "dockerfile", "containerfile",
    "makefile", "gnumakefile",
    "gemfile", "rakefile", "procfile", "guardfile",
    "vagrantfile", "brewfile", "podfile",
    "fastfile", "appfile", "matchfile", "gymfile", "snapfile",
    "cakefile", "jakefile", "justfile",
    "jenkinsfile", "codeowners", "owners",
    "license", "licence", "copying", "authors", "contributors",
    "readme", "changelog", "history", "news",
    ".gitignore", ".gitattributes", ".gitmodules",
    ".dockerignore", ".npmignore", ".slugignore",
    ".editorconfig", ".prettierrc", ".eslintrc", ".stylelintrc",
    ".env", ".env.local", ".env.development", ".env.production", ".env.test",
    ".nvmrc", ".node-version", ".python-version", ".ruby-version", ".tool-versions",
}

# .ps1 含中文时用 utf-8-sig (PowerShell 识别 BOM)
_PS1_EXT = ".ps1"


def _has_non_ascii(content: str) -> bool:
    """检测内容是否包含非 ASCII 字符。"""
    return any(ord(c) > 127 for c in content)


def _detect_existing_encoding(file_path: Path) -> tuple:
    """
    检测已有文件的编码和 BOM 类型。

    返回值: (encoding, has_bom)
      - encoding: "utf-8-sig" | "utf-16-le" | "utf-16-be" | "utf-8"
      - has_bom: True 如果文件有 BOM
    """
    try:
        with open(file_path, "rb") as f:
            head = f.read(4)

        # UTF-8 BOM (EF BB BF)
        if head[:3] == b"\xef\xbb\xbf":
            return "utf-8-sig", True
        # UTF-16 LE BOM (FF FE) - 注意要在 UTF-32 之前检查
        if head[:2] == b"\xff\xfe" and head[2:4] != b"\x00\x00":
            return "utf-16-le", True
        # UTF-16 BE BOM (FE FF)
        if head[:2] == b"\xfe\xff":
            return "utf-16-be", True
        # UTF-32 LE BOM (FF FE 00 00) - 罕见
        if head[:4] == b"\xff\xfe\x00\x00":
            return "utf-32-le", True
        # UTF-32 BE BOM (00 00 FE FF) - 罕见
        if head[:4] == b"\x00\x00\xfe\xff":
            return "utf-32-be", True

        return "utf-8", False
    except Exception:
        return "utf-8", False


def _infer_encoding(path: Path, target_platform: str, content: str = "") -> str:
    """
    根据文件后缀、目标平台和内容推断最合适的编码。

    返回值:
      "utf-8-sig"   — UTF-8 with BOM
      "utf-8"       — UTF-8 without BOM
      "utf-16"      — UTF-16 with BOM (Python 自动选择字节序)
      "gbk"         — GBK (Windows .bat/.cmd/.inf 含中文场景)
    """
    ext = path.suffix.lower()
    filename = path.name.lower()

    # 需要 UTF-16 (with BOM) 的文件类型
    # Windows .reg 注册表文件必须是 UTF-16 LE with BOM
    if ext in _UTF16_LE_BOM_EXTS:
        return "utf-16"  # Python 的 utf-16 自动加 BOM

    # Windows ANSI (GBK) 文件
    # Windows .inf 安装信息文件需要 ANSI 编码
    if ext in _WINDOWS_ANSI_EXTS:
        if target_platform == "windows":
            return "gbk"
        # 非 Windows 平台上编辑 .inf 文件，用 UTF-8（用户自行处理）
        return "utf-8"

    # Windows .bat / .cmd 批处理文件
    # cmd.exe 默认代码页是 GBK (CP936)，不识别 UTF-8 BOM
    # 含非 ASCII 字符时必须用 GBK，否则中文乱码
    if ext in {".bat", ".cmd"}:
        if target_platform == "windows" and _has_non_ascii(content):
            return "gbk"
        return "utf-8"

    # .ps1 PowerShell 脚本
    # PowerShell 识别 UTF-8 BOM，含中文推荐 utf-8-sig
    if ext == _PS1_EXT:
        return "utf-8-sig"

    # 无后缀或特殊文件名：UTF-8 无 BOM
    if not ext or filename in _NO_BOM_FILENAMES:
        return "utf-8"

    # 明确禁止 BOM 的类型
    if ext in _NO_BOM_EXTS:
        return "utf-8"

    # Excel 友好类型：Windows 目标 → 加 BOM；其他平台 → 不加
    if ext in _EXCEL_FRIENDLY_EXTS:
        if target_platform == "windows":
            return "utf-8-sig"
        else:
            return "utf-8"

    # 默认：utf-8 无 BOM（最通用，不会破坏任何解析器）
    return "utf-8"


def _detect_platform(arg: str) -> str:
    """将 --platform 参数或当前系统映射为 windows / mac / linux。"""
    if arg != "auto":
        return arg.lower()
    s = platform.system().lower()
    if s == "windows":
        return "windows"
    if s == "darwin":
        return "mac"
    return "linux"


def _newline_for_platform(arg: str, target_platform: str) -> str:
    """返回实际换行符字符串。"""
    if arg in ("auto", "preserve"):
        # Windows 生成供 Excel 打开的 CSV 用 \r\n，其他场景统一 \n
        return "\r\n" if target_platform == "windows" else "\n"
    return "\r\n" if arg == "crlf" else "\n"


def _detect_existing_newline(text: str) -> str:
    """检测文本中使用的换行符风格，返回 '\\r\\n' 或 '\\n'。"""
    if "\r\n" in text:
        return "\r\n"
    return "\n"


# ── 平台探测 ──────────────────────────────────────────────────────────────────

def _detect_info() -> dict:
    """探测当前平台信息，供 AI 决策是否需要传 --platform。"""
    sys_name = platform.system()          # 'Darwin' / 'Windows' / 'Linux'
    plat = _detect_platform("auto")       # 'mac' / 'windows' / 'linux'

    # 在当前平台上，.csv 默认会用什么编码？（反映脚本实际行为）
    dummy_csv = Path("dummy.csv")
    default_csv_enc = _infer_encoding(dummy_csv, plat)
    has_bom = default_csv_enc == "utf-8-sig"

    return {
        "platform": plat,                       # mac | windows | linux
        "system": sys_name,                     # Darwin | Windows | Linux
        "python": platform.python_version(),    # e.g. "3.11.0"
        "default_csv_encoding": default_csv_enc,
        "default_csv_bom": has_bom,
        # 给 AI 的直接建议：当前平台写 CSV 是否需要传 --platform windows？
        "needs_platform_windows_for_local_csv": plat == "windows",
    }

# ── 解析环境变量 ──────────────────────────────────────────────────────────────────

def _resolve_path(path_str: str) -> Path:
    """展开环境变量、用户目录，解析为绝对路径。"""
    expanded = os.path.expandvars(os.path.expanduser(path_str))
    return Path(expanded).resolve()


# ── 主逻辑 ────────────────────────────────────────────────────────────────────


def _emit_a1_cert(target_path: Path) -> None:
    """
    落盘成功后输出 A1-CERT 固化行（跨平台兼容版）。
    使用 Python hashlib 计算 SHA-256，全平台通用，无外部依赖。
    """
    path_str = str(target_path)
    try:
        # Python 标准库计算 SHA-256（分块读取，支持大文件）
        h = hashlib.sha256()
        with open(target_path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
        sha256 = h.hexdigest()

        # 读取 LastWriteTime，格式化为 ISO8601
        ts = target_path.stat().st_mtime
        lwt = datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%dT%H:%M:%S")

        # 打印固化行到 stderr（保护 stdout 纯 JSON 契约）
        print(f'A1-CERT path="{path_str}" sha256={sha256} lwt={lwt}', file=sys.stderr)
    except Exception as e:
        # 异常降级：显式标注失败，严禁伪造哈希；退出码保持 0
        reason = str(e).replace("\n", " ").strip()[:200]
        print(f'A1-CERT path="{path_str}" status=unavailable reason={reason}', file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description="跨平台文本文件写入工具")
    parser.add_argument(
        "--detect",
        action="store_true",
        help="探测当前平台并输出 JSON，不做任何文件写入",
    )
    parser.add_argument("--path", help="目标文件路径（相对或绝对）")

    content_group = parser.add_mutually_exclusive_group()
    content_group.add_argument("--content", help="文件内容（直接传字符串）")
    content_group.add_argument(
        "--content-file",
        help="包含文件内容的临时文件路径（推荐，避免 shell 转义问题）",
    )

    parser.add_argument(
        "--encoding",
        default="auto",
        help="编码 (utf-8 | utf-8-sig | gbk | gb18030 | utf-16 | utf-16-le | auto)，默认 auto 自动推断",
    )
    parser.add_argument(
        "--platform",
        default="auto",
        help="目标平台 (windows | mac | linux | auto)，默认 auto",
    )
    parser.add_argument(
        "--newline",
        default="auto",
        help="换行符 (crlf | lf | preserve | auto)，默认 auto",
    )
    parser.add_argument(
        "--preserve",
        action="store_true",
        help="同时启用 --preserve-bom 和 --preserve-newline（修改已有文件时推荐）",
    )
    parser.add_argument(
        "--preserve-bom",
        action="store_true",
        help="若目标文件已有 BOM，则保留（即使推断规则认为不需要）",
    )
    parser.add_argument(
        "--preserve-newline",
        action="store_true",
        help="保留已有文件的换行符风格（等同于 --newline preserve）",
    )
    parser.add_argument(
        "--append",
        action="store_true",
        help="追加模式，不覆盖文件，追加到末尾",
    )
    parser.add_argument(
        "--no-mkdir",
        action="store_true",
        help="禁止自动创建父目录",
    )

    args = parser.parse_args()

    # ── --detect 模式：仅输出平台信息，不做任何文件操作 ──────────────────────
    if args.detect:
        _ok(_detect_info())
        return 0


    # 非 detect 模式时，--path 和内容来源为必填
    if not args.path:
        _error("--path 为必填参数（或使用 --detect 仅探测平台）")
        return 1
    if args.content is None and args.content_file is None:
        _error("--content 或 --content-file 为必填参数之一")
        return 1

    # --preserve 是 --preserve-bom + --preserve-newline 的快捷方式
    preserve_bom = args.preserve_bom or args.preserve
    preserve_newline = args.preserve_newline or args.preserve
    newline_arg = "preserve" if preserve_newline else args.newline

    # ── 读取内容 ──────────────────────────────────────────────────────────────
    if args.content is not None:
        content = args.content
    else:
        try:
            with open(args.content_file, "r", encoding="utf-8") as f:
                content = f.read()
        except UnicodeDecodeError as e:
            _error(f"读取内容文件失败: 文件编码不是 UTF-8。{e}")
            return 2
        except FileNotFoundError:
            _error(f"读取内容文件失败: 文件不存在 '{args.content_file}'")
            return 2
        except Exception as e:
            _error(f"读取内容文件失败: {e}")
            return 2

    # ── 解析目标路径 ──────────────────────────────────────────────────────────
    target_path = _resolve_path(args.path)
    file_exists = target_path.exists()

    # ── 推断平台和编码 ────────────────────────────────────────────────────────
    target_platform = _detect_platform(args.platform)

    # 编码推断需要知道内容（用于检测 .bat/.cmd 是否含非 ASCII）
    if args.encoding == "auto":
        encoding = _infer_encoding(target_path, target_platform, content)
    else:
        encoding = args.encoding

    # ── preserve-bom：若文件已存在且有 BOM，强制保留 ──────────────────────────
    preserved_bom = False
    detected_enc = "utf-8"
    if file_exists:
        detected_enc, has_existing_bom = _detect_existing_encoding(target_path)
        if preserve_bom and has_existing_bom and not args.append:
            encoding = detected_enc
            preserved_bom = True

    # ── 换行符处理 ────────────────────────────────────────────────────────────
    preserved_newline = False
    if newline_arg == "preserve" and file_exists:
        # 读取已有文件的换行符风格，使用检测到的编码
        try:
            with open(target_path, "r", encoding=detected_enc, errors="replace", newline="") as f:
                existing_text = f.read(4096)  # 只需要检测前几 KB
            newline = _detect_existing_newline(existing_text)
            preserved_newline = True
        except Exception:
            newline = _newline_for_platform("auto", target_platform)
    else:
        newline = _newline_for_platform(newline_arg, target_platform)

    # ── 创建父目录 ────────────────────────────────────────────────────────────
    if not args.no_mkdir:
        try:
            target_path.parent.mkdir(parents=True, exist_ok=True)
        except PermissionError:
            _error(f"创建目录失败: 权限拒绝 '{target_path.parent}'")
            return 2
        except Exception as e:
            _error(f"创建目录失败: {e}")
            return 2

    # ── 统一换行符 ────────────────────────────────────────────────────────────
    # 先把内容中所有换行符统一为 \n，再替换为目标换行符
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    final_content = normalized.replace("\n", newline)

    # ── 记录写入前大小（用于 append 模式统计） ────────────────────────────────
    size_before = 0
    if args.append and file_exists:
        try:
            size_before = target_path.stat().st_size
        except Exception:
            pass

    # ── 写入文件 ──────────────────────────────────────────────────────────────
    open_mode = "a" if args.append else "w"
    try:
        # newline="" 让 Python 不再做额外换行转换（我们已手动处理）
        with open(target_path, open_mode, encoding=encoding, newline="") as f:
            f.write(final_content)
    except UnicodeEncodeError as e:
        # 编码无法表示某些字符（如用 GBK 写 emoji）
        problem_char = e.object[e.start:e.end] if e.start < len(e.object) else "?"
        try:
            code_point = f"U+{ord(problem_char):04X}"
        except (TypeError, ValueError):
            code_point = "unknown"
        _error(
            f"编码错误: 字符 '{problem_char}' ({code_point}) 无法用 {encoding} 编码表示。"
            f"建议使用 --encoding utf-8 或 --encoding utf-8-sig"
        )
        return 2
    except PermissionError:
        _error(f"写入失败: 权限拒绝 '{target_path}'")
        return 2
    except OSError as e:
        # errno 28 = ENOSPC (磁盘空间不足)
        if hasattr(e, 'errno') and e.errno == 28:
            _error(f"写入失败: 磁盘空间不足")
        else:
            _error(f"写入失败: {e}")
        return 2
    except Exception as e:
        _error(f"写入失败: {e}")
        return 2

    # ── 计算实际字节数 ────────────────────────────────────────────────────────
    try:
        byte_size = target_path.stat().st_size
        bytes_written = byte_size - size_before if args.append else byte_size
    except Exception:
        byte_size = -1
        bytes_written = -1

    # 判断最终文件是否有 BOM
    has_bom = encoding.lower() in {"utf-8-sig", "utf-8-bom", "utf-16", "utf-16-le", "utf-16-be", "utf-32", "utf-32-le", "utf-32-be"}

    _ok({
        "status": "ok",
        "path": str(target_path),
        "encoding": encoding,
        "bom": has_bom,
        "newline": "crlf" if newline == "\r\n" else "lf",
        "bytes": byte_size,
        "bytes_written": bytes_written,
        "mode": "append" if args.append else "write",
        "preserved_bom": preserved_bom,
        "preserved_newline": preserved_newline,
    })
    # A1-CERT：落盘成功后固化可信源（路径/LWT/SHA256），便于 PM 一键复算
    # 仅 write 模式触发（append/detect/error 分支不触发），闭合 gap1
    if not args.append:
        _emit_a1_cert(target_path=target_path)
    return 0


# ── 输出工具 ──────────────────────────────────────────────────────────────────

def _ok(data: dict) -> None:
    print(json.dumps(data, ensure_ascii=False))


def _error(message: str) -> None:
    print(json.dumps({"status": "error", "message": message}, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
