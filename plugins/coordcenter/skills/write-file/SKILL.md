---
name: write-file
description: |
  [Mandatory Trigger · Highest Priority · Write Tool Interception]
  Cross-platform plain text file writing skill.

  ## ‼️ WRITE Tool Interception Rules (Highest Priority, No Exemptions)

  When you are about to call the built-in `write` tool to write any text file, you must first perform this check:

  > Is this file the final target file?
  > → Yes → Stop immediately, use this skill's scripts/write_file.py script instead, do NOT use the write tool
  > → No (it's a temporary file /tmp/_tw_xxx.txt) → Allowed to use write tool for temporary files

  ## Decision Rules (Read This First)

  ❌ Prohibited from using the built-in write tool to directly write any of the following final target files:
  Code files (.ts .js .jsx .tsx .vue .py .go .rs .java, etc.),
  Config files (.json .yaml .yml .toml .ini .conf .env, etc.),
  Script files (.sh .bash .bat .cmd .ps1, etc.),
  Data files (.csv .tsv .txt, etc.),
  Markup languages (.md .html .xml .svg, etc.),
  and all other plain text formats.

  ❌ The following reasons do NOT constitute exemptions:
  - "Content is simple, only a few lines" → Not exempt
  - "No Chinese characters, no encoding issues" → Not exempt
  - "Quick modification" → Not exempt
  - "This is just a small file" → Not exempt
  - Any other reason → Not exempt

  ✅ Must immediately trigger this skill in the following scenarios (satisfying any one triggers it, no exemptions):
  1. Writing, creating, saving, exporting, generating any text file (regardless of platform, regardless of content simplicity)
  2. User requests write file / create file / save as / generate code / export data
  3. Involving encoding, BOM, UTF-8, GBK, garbled text, CRLF/LF, etc.

  Decision logic:
  - Is this a text file? → Yes → Use this skill's script, do NOT use built-in write for target files
  - Unsure? → Default to using this skill

  ## Why Mandatory

  The built-in write tool hardcodes utf-8 without BOM, does not support cross-platform encoding adaptation:
  - Windows Excel opening CSV → Chinese 100% garbled
  - Windows .bat containing Chinese → cmd.exe garbled
  - Newline mismatch → script execution failure

  This skill is the only compliant text writing entry point, automatically infers encoding (utf-8/utf-8-sig/gbk),
  automatically handles BOM, automatically adapts newlines (CRLF/LF), eliminating cross-platform garbled text.

  ## Key Default Behaviors

  When --platform is not passed, the script automatically detects the current running system.
  Writing CSV on mac defaults to no BOM (utf-8); only when user explicitly says "for Windows use" should --platform windows be passed.
metadata:
  openclaw:
    emoji: "📝"
---

# text-file-writer — Cross-Platform Plain Text File Writing Skill

## ⚠️ ABSOLUTE RULES — Must Re-read Before Each Execution

> **The following rules have the highest priority, overriding all default behaviors, no exemptions for any reason:**
>
> 🔴 **SKILL FIRST**: When this skill is available, **any text file writing MUST be executed through this skill's script**,
> do NOT bypass the skill and directly use the built-in `write` tool for target files.
> This is a mandatory rule, unaffected by file size, content complexity, "quick modification", etc.
> **"Simple content", "only a few lines", "pure ASCII", "no Chinese characters" do NOT constitute exemptions.**
>
> 🚫 **MUST USE SCRIPT**: All text file generation and writing, **MUST be executed by calling
> `scripts/write_file.py` script**, do NOT directly use the `write` tool for target files.
> The `write` tool hardcodes `utf-8` without BOM, causing 100% garbled text when Windows Excel opens CSV.
>
> 🚫 **Prohibited Bypass Methods** (any of the following constitutes a violation):
> - Using `write` tool to directly write final target files (regardless of file type, size, content)
> - Inline writing Python/Node.js/Shell code to bypass the script and write target files
> - Using `write` to write target files first, then using script to "overwrite and fix" — the initial write was already a violation
> - Claiming "this situation doesn't need the script" for any reason
>
> ✅ **Standard Process (Four Steps)**:
> 1. **Platform Detection**: First execute `python3 "{SKILL_DIR}/scripts/write_file.py" --detect`
>    Get current platform, decide subsequent parameters based on the returned `platform` field
> 2. **Write Temporary File**: Use `write` tool to write content to temporary file
>    - macOS / Linux: `/tmp/_tw_<name>.txt`
>    - Windows: `$env:TEMP\_tw_<name>.txt` (PowerShell) or `%TEMP%\_tw_<name>.txt` (CMD)
> 3. **Call Script to Write**: Decide whether to pass `--platform` based on platform detection results
> 4. **Clean Up Temporary File**
>
> ✅ **`--platform` Decision Rules** (based on `--detect` return results):
> - `platform == "mac"` or `"linux"`, and user did NOT say "for Windows use" → **Do NOT pass `--platform`**
> - `platform == "mac"` or `"linux"`, and user explicitly said "for Windows use / for Windows to open / send to Windows user" → Pass `--platform windows`
> - `platform == "windows"` → **Do NOT pass `--platform`** (script automatically handles Windows rules)
>
> 🚫 **Only Exemption**: Pure binary files (images, audio, video, zip, etc.) are not subject to this skill.

---

## Skill Overview

Replaces OpenClaw built-in `write` tool for all plain text writing, providing:

| Capability | Description |
|------|------|
| **BOM Auto-Inference** | Windows CSV/TSV/TXT automatically adds BOM; JSON/YAML/Shell scripts etc. forcibly do not add |
| **Newline Auto-Adaptation** | Windows → `\r\n`; macOS/Linux → `\n`; supports `preserve` to keep existing style |
| **GBK Support** | Windows `.bat`/`.cmd` containing Chinese uses GBK to avoid cmd.exe garbled text |
| **Cross-Platform Target Specification** | `--platform windows` generates files for Windows use on macOS |
| **Append Mode** | `--append` appends to end of existing file without overwriting |
| **Existing File Preservation** | `--preserve` automatically preserves existing file's BOM state and newline style |

---

## `--platform` Usage Rules (Important)

**`--platform` means "the platform where the file will be opened/used", NOT the current running platform.**

| Scenario | Action |
|------|------|
| User on **macOS/Linux**, file also used locally | **Do NOT pass `--platform`** (script auto-detects current system) |
| User on **Windows**, file also used locally | **Do NOT pass `--platform`** (script auto-detects current system) |
| User on **macOS**, but file **sent to Windows user** (especially CSV/Excel) | Pass `--platform windows` |
| User on **Windows**, but file **sent to macOS/Linux user** | Pass `--platform mac` |
| User **did not specify** who the file is for or where to open it | **Do NOT pass `--platform`** (script auto-detects, do not guess) |

> ⚠️ **Strictly prohibited from defaulting to `--platform windows` when user has not explicitly said "for Windows use".**
> Incorrectly passing `--platform windows` will generate files with CRLF and unnecessary BOM on mac.

---

## Command Line Interface

```
python3 "{SKILL_DIR}/scripts/write_file.py" [arguments]

Content Source (must choose one):
  --content-file <file>    Read content from temporary file [Recommended] avoids shell escaping breaking content
  --content <string>       Directly pass content string (suitable for simple single-line content without special characters)

Target Path (required):
  --path <path>            Target file path (relative or absolute, supports ~ expansion)

Encoding Control (optional, defaults to file type + current system auto-inference):
  --encoding <enc>         Force specify encoding: utf-8 | utf-8-sig | gbk | gb18030 | utf-16 | utf-16-le
  --platform <p>           Target platform: windows | mac | linux
                           [Default not passed] script auto-detects current system
                           [Only pass in cross-platform scenarios] see "--platform Usage Rules" above

Newline Control (optional, defaults to --platform/current system auto-selection):
  --newline <nl>           crlf | lf | preserve | auto (default auto)
                           preserve = keep existing file's newline style

Existing File Preservation (optional):
  --preserve               Enable both --preserve-bom and --preserve-newline
  --preserve-bom           Keep BOM if existing file has it, even if inference rules say it's not needed
  --preserve-newline       Equivalent to --newline preserve

Write Mode (optional):
  --append                 Append mode, content appended to end of file (does not overwrite)

Others (optional):
  --no-mkdir               Prohibit automatic parent directory creation (default auto-creates)
```

---

## Output Format (JSON, stdout)

```json
// Success
{
  "status": "ok",
  "path": "/absolute/path/to/file.csv",
  "encoding": "utf-8-sig",
  "bom": true,
  "newline": "crlf",
  "bytes": 1024,
  "bytes_written": 1024,
  "mode": "write",
  "preserved_bom": false,
  "preserved_newline": false
}

// Failure
{"status": "error", "message": "Failed to write file: Permission denied"}

// Encoding Error (character cannot be represented with specified encoding)
{"status": "error", "message": "Encoding error: Character '😀' (U+1F600) cannot be represented with gbk encoding. Suggest using --encoding utf-8 or --encoding utf-8-sig"}
```

---

## Encoding Inference Rules (when `--encoding auto`)

**Not passing `--platform` = script auto-detects current system** (running on mac → handled as macOS column)

### Base Encoding Table

| File Extension | macOS / Linux (default/do not pass platform) | Windows (`--platform windows` or current system is Windows) |
|---------|:-----------------------------------:|:----------------------------------------------------:|
| `.csv` `.tsv` | utf-8 (**no BOM**) | **utf-8-sig (with BOM ✅)** |
| `.reg` | **utf-8 (with BOM)** | **utf-8 (with BOM ✅)** |
| `.inf` | utf-8 (no BOM) | **gbk (ANSI)** |
| `.ps1` | utf-8-sig (with BOM) | utf-8-sig (with BOM) |
| `.bat` `.cmd` (no Chinese) | utf-8 (no BOM) | utf-8 (no BOM) |
| `.bat` `.cmd` (with Chinese) | utf-8 (no BOM) | **gbk (auto-detect ✅)** |
| `.sh` `.bash` `.zsh` `.fish` | utf-8 (no BOM) | utf-8 (no BOM) |
| `.json` `.jsonc` `.json5` | utf-8 (no BOM) | utf-8 (no BOM) |
| `.yaml` `.yml` `.toml` `.ini` `.conf` `.env` | utf-8 (no BOM) | utf-8 (no BOM) |
| `.html` `.htm` `.xml` `.svg` | utf-8 (no BOM) | utf-8 (no BOM) |
| `.md` `.markdown` `.rst` `.txt` | utf-8 (no BOM) | utf-8 (no BOM) |
| `.js` `.ts` `.jsx` `.tsx` `.vue` `.py` etc. code | utf-8 (no BOM) | utf-8 (no BOM) |
| `.css` `.less` `.scss` `.sass` | utf-8 (no BOM) | utf-8 (no BOM) |
| `.sql` `.graphql` `.proto` | utf-8 (no BOM) | utf-8 (no BOM) |
| `.log` `.lock` | utf-8 (no BOM) | utf-8 (no BOM) |
| No extension files (Dockerfile, Makefile, etc.) | utf-8 (no BOM) | utf-8 (no BOM) |
| Others | utf-8 (no BOM) | utf-8 (no BOM) |

### Covered File Types (Complete List)

The script has built-in support for encoding inference of all the following plain text file types:

**Programming Languages**: `.js` `.ts` `.jsx` `.tsx` `.mjs` `.cjs` `.vue` `.svelte` `.py` `.pyi` `.go` `.rs` `.c` `.cpp` `.cc` `.h` `.hpp` `.java` `.kt` `.scala` `.groovy` `.swift` `.m` `.mm` `.rb` `.erb` `.php` `.dart` `.lua` `.r` `.R` `.pl` `.pm` `.ex` `.exs` `.erl` `.hrl` `.hs` `.fs` `.clj` `.cljs` `.elm` `.v` `.sv` `.vhd`

**Config Files**: `.json` `.jsonc` `.json5` `.yaml` `.yml` `.toml` `.ini` `.cfg` `.conf` `.env` `.editorconfig` `.prettierrc` `.eslintrc` `.babelrc` `.nvmrc`

**Markup Languages**: `.html` `.htm` `.xhtml` `.xml` `.svg` `.md` `.markdown` `.rst`

**Script Files**: `.sh` `.bash` `.zsh` `.fish` `.bat` `.cmd` `.ps1`

**Data/Query**: `.sql` `.graphql` `.gql` `.proto`

**Others**: `.css` `.less` `.scss` `.sass` `.styl` `.log` `.lock` `.tf` `.hcl` `.nix` `.prisma` `.plist`

**No Extension Files**: `Dockerfile` `Makefile` `Gemfile` `Rakefile` `Procfile` `Vagrantfile` `Brewfile` `Podfile` `Jenkinsfile` `CODEOWNERS` `LICENSE` `README` `CHANGELOG`, etc.

### Core Principles

- On mac without passing `--platform`, `.csv` generates **no BOM** utf-8 (suitable for local use)
- Only when explicitly generating "CSV for Windows users" should `--platform windows` be passed
- `.ps1` is the only type that adds BOM on mac (because it itself is a script executed on Windows)
- `.bat`/`.cmd` with Chinese, **Windows platform automatically switches to GBK**, no need to manually pass parameters
- `.reg` registry files **MUST be UTF-16 with BOM**, script auto-handles
- `.inf` installation info files use GBK (ANSI encoding) on Windows

---

## Standard Execution Process

### Step Zero: Platform Detection (Required)

```bash
python3 "{SKILL_DIR}/scripts/write_file.py" --detect
```

Example return (macOS):
```json
{
  "platform": "mac",
  "system": "Darwin",
  "python": "3.11.0",
  "default_csv_encoding": "utf-8",
  "default_csv_bom": false,
  "needs_platform_windows_for_local_csv": false
}
```

Example return (Windows):
```json
{
  "platform": "windows",
  "system": "Windows",
  "python": "3.11.0",
  "default_csv_encoding": "utf-8-sig",
  "default_csv_bom": true,
  "needs_platform_windows_for_local_csv": true
}
```

**Decide `--platform` parameter based on return value:**

| `platform` Return Value | User Intent | Whether to Pass `--platform` |
|------------------|---------|-------------------|
| `mac` / `linux` | Local use (not specified) | **Do NOT pass** |
| `mac` / `linux` | Explicitly said "for Windows use" | Pass `--platform windows` |
| `windows` | Any scenario | **Do NOT pass** (script automatically handles Windows rules) |

### Step One: Use `write` tool to write content to temporary file

```
# macOS / Linux
write(path="/tmp/_tw_<target_filename>.txt", content="<full file content>")

# Windows (PowerShell)
write(path="$env:TEMP\_tw_<target_filename>.txt", content="<full file content>")
```

> Temporary file naming suggestion: use target filename as suffix (e.g., target is `report.csv`, temporary file uses
> `/tmp/_tw_report.csv.txt`), to avoid path conflicts during concurrency.

### Step Two: Call script to write target file

```bash
# macOS / Linux
python3 "{SKILL_DIR}/scripts/write_file.py" \
  --path "<target_file_path>" \
  --content-file "/tmp/_tw_<target_filename>.txt" \
  [--platform windows|mac|linux] \
  [--encoding utf-8-sig|gbk|...] \
  [--preserve] \
  [--append]

# Windows (PowerShell)
python3 "{SKILL_DIR}/scripts/write_file.py" `
  --path "<target_file_path>" `
  --content-file "$env:TEMP\_tw_<target_filename>.txt" `
  [--platform windows|mac|linux] `
  [--encoding utf-8-sig|gbk|...] `
  [--preserve] `
  [--append]
```

### Step Three: Check output results

- `status == "ok"` → Show user file path, encoding, whether it contains BOM
- `status == "error"` → Explain error reason, check path permissions or disk space

### Step Four: Clean up temporary file

```bash
# macOS / Linux
rm -f /tmp/_tw_<target_filename>.txt

# Windows (PowerShell)
Remove-Item -Force "$env:TEMP\_tw_<target_filename>.txt"

# Windows (CMD)
del "%TEMP%\_tw_<target_filename>.txt"
```

---

## Typical Scenario Examples

### Scenario 1: User says "write csv file" (platform not specified)

```bash
# Step Zero: Detect platform
python3 "{SKILL_DIR}/scripts/write_file.py" --detect
# → {"platform": "mac", ...}  Current is mac, do not pass --platform

# Step One: Write temporary file (macOS/Linux)
write(path="/tmp/_tw_poems.csv.txt", content="Title,Author,Content\nQuiet Night Thoughts,Li Bai,Bedside bright moonlight")
# Windows: write(path="$env:TEMP\_tw_poems.csv.txt", ...)

# Step Two: Script write, do not pass --platform on mac → utf-8 no BOM (local use)
python3 "{SKILL_DIR}/scripts/write_file.py" \
  --path "~/Desktop/poems.csv" \
  --content-file "/tmp/_tw_poems.csv.txt"
# Windows: --content-file "$env:TEMP\_tw_poems.csv.txt"

# Step Four: Clean up (macOS/Linux)
rm -f /tmp/_tw_poems.csv.txt
# Windows: Remove-Item -Force "$env:TEMP\_tw_poems.csv.txt"
```

### Scenario 2: User explicitly says "CSV for Windows users"

```bash
# Step Zero: Detect platform
python3 "{SKILL_DIR}/scripts/write_file.py" --detect
# → {"platform": "mac", ...}  User said for Windows use, pass --platform windows

# Step Two: Script write, specify Windows platform → utf-8-sig + CRLF
# macOS/Linux:
python3 "{SKILL_DIR}/scripts/write_file.py" \
  --path "export.csv" \
  --content-file "/tmp/_tw_export.csv.txt" \
  --platform windows
# Windows: change --content-file to "$env:TEMP\_tw_export.csv.txt"
# → Automatically uses utf-8-sig + CRLF, Excel double-click directly shows Chinese correctly
```

### Scenario 3: JSON / YAML Config Files

```bash
# No additional parameters needed, auto utf-8 no BOM (regardless of platform)
python3 "{SKILL_DIR}/scripts/write_file.py" \
  --path "config.json" \
  --content-file "/tmp/_tw_config.json.txt"
# Windows: change --content-file to "$env:TEMP\_tw_config.json.txt"
```

### Scenario 4: PowerShell Script (with Chinese comments)

```bash
# .ps1 auto utf-8-sig, no additional parameters needed (ps1 executes on Windows, always needs BOM)
python3 "{SKILL_DIR}/scripts/write_file.py" \
  --path "deploy.ps1" \
  --content-file "/tmp/_tw_deploy.ps1.txt"
# Windows: change --content-file to "$env:TEMP\_tw_deploy.ps1.txt"
```

### Scenario 5: Windows Batch Script (with Chinese)

```bash
# Windows platform: .bat with Chinese auto-detected and uses GBK encoding
# No need to manually pass --encoding gbk (script has built-in non-ASCII character detection)
python3 "{SKILL_DIR}/scripts/write_file.py" \
  --path "run.bat" \
  --content-file "/tmp/_tw_run.bat.txt"
# Windows: change --content-file to "$env:TEMP\_tw_run.bat.txt"
# → Auto-detects Chinese on Windows, uses gbk encoding

# macOS/Linux writing .bat file for Windows use:
python3 "{SKILL_DIR}/scripts/write_file.py" \
  --path "run.bat" \
  --content-file "/tmp/_tw_run.bat.txt" \
  --platform windows
# Windows: --content-file "$env:TEMP\_tw_run.bat.txt"
# → Auto-detects Chinese, uses gbk encoding
```

### Scenario 6: Shell Script

```bash
# .sh auto utf-8 no BOM + LF, no additional parameters needed
python3 "{SKILL_DIR}/scripts/write_file.py" \
  --path "setup.sh" \
  --content-file "/tmp/_tw_setup.sh.txt"
# Windows: change --content-file to "$env:TEMP\_tw_setup.sh.txt"
```

### Scenario 7: Append Content to Existing Log File

```bash
python3 "{SKILL_DIR}/scripts/write_file.py" \
  --path "app.log" \
  --content-file "/tmp/_tw_new_lines.txt" \
  --append --preserve
# Windows: change --content-file to "$env:TEMP\_tw_new_lines.txt"
# --preserve preserves existing file's encoding and newline style
```

### Scenario 8: Update Existing CSV (Preserve Original BOM and Newlines)

```bash
python3 "{SKILL_DIR}/scripts/write_file.py" \
  --path "data.csv" \
  --content-file "/tmp/_tw_data.csv.txt" \
  --preserve
# Windows: change --content-file to "$env:TEMP\_tw_data.csv.txt"
# If original file had BOM, new file preserves it; if original file was CRLF, new file preserves CRLF
```

### Scenario 9: Windows Registry File (.reg)

```bash
# .reg files MUST be UTF-16 with BOM, script auto-handles
python3 "{SKILL_DIR}/scripts/write_file.py" \
  --path "settings.reg" \
  --content-file "/tmp/_tw_settings.reg.txt"
# Windows: change --content-file to "$env:TEMP\_tw_settings.reg.txt"
# → Auto uses utf-16 encoding (with BOM), regedit can import normally
```

### Scenario 10: Windows Installation Info File (.inf)

```bash
# Windows .inf files auto use GBK (ANSI) encoding
python3 "{SKILL_DIR}/scripts/write_file.py" \
  --path "driver.inf" \
  --content-file "$env:TEMP\_tw_driver.inf.txt" \
  --platform windows
# macOS/Linux: change --content-file to "/tmp/_tw_driver.inf.txt"
# → Windows Device Manager can recognize normally
```

---

## Common Pitfalls

| Pitfall | Description |
|------|------|
| **Bypassing skill, directly using `write` tool for target files** | **Strictly prohibited. When this skill is available, write tool is only allowed for temporary files, not for final target files** |
| **Using write directly because "content is simple/only a few lines/pure English"** | **Strictly prohibited. Simple content must also go through script, rules have no size exemptions** |
| **Bypassing script for "quick modification"** | **Strictly prohibited. No "quick modification exemption", any target file writing must go through script** |
| **Using write for target files first, then overwriting with script** | **Strictly prohibited. Initial write to target file is already a violation, must go directly from temporary file through script** |
| Using `write` tool to directly write CSV | `write` tool utf-8 no BOM, Windows Excel will inevitably show garbled text |
| **Defaulting to `--platform windows` on mac** | **Never pass this parameter when user hasn't said "for Windows use", otherwise local files on mac will have extra BOM and CRLF** |
| Forgetting to pass `--platform windows` | When explicitly generating "CSV for Windows users", not passing results in no BOM, Windows shows garbled text |
| Adding BOM blindly to all files | HTML/JSON/YAML/`.sh` adding BOM will cause parsing errors or syntax errors |
| Using GBK for files containing emoji | GBK cannot represent emoji, script will report encoding error, switch to utf-8 |
| `.reg` files not using UTF-16 | Windows registry files MUST be UTF-16 LE with BOM, otherwise regedit cannot import |
| Temporary file name conflicts | When concurrently writing multiple files, temporary file names should include target filename to distinguish |
| Python not available | Script depends on `python3` (Python 3.6+), if unavailable prompt user to install |

---

## Notes

- `{SKILL_DIR}` is replaced with this skill's **actual installation path** during actual execution
- Script **zero external dependencies**, only uses Python standard library (`pathlib` `json` `argparse` `platform`)
- Supports Python 3.6+, compatible with Windows / macOS / Linux
- Parent directory does not exist by default auto-creates (`--no-mkdir` can prohibit)
- `--content` directly passing string is suitable for simple content scenarios; when content contains quotes, `$`, newlines, etc.
  must use `--content-file` method, otherwise shell escaping may break content
