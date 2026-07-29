"""打包团队文件夹为 .tpkg（zip 改后缀）。

用法：python package-tpkg.py <团队目录> <输出 .tpkg 路径> [--marker]
输出：JSON {ok:bool, error:str}
- 整文件夹 1:1 打包：源目录内容（含文件与目录条目，含空目录）全部进包，不做任何过滤/跳过
- arcname 统一为 <teamId>/<相对路径>（正斜杠），保持单一顶层目录结构
- --marker：若包内尚无 <teamId>/.createteamok.log，则注入一个标记条目
  （用于导入端校验；标记只写入包内，绝不改动源文件夹）
"""
import sys
import os
import json
import zipfile


def main():
    result = {"ok": False, "error": ""}
    args = sys.argv[1:]
    if len(args) < 2:
        result["error"] = "参数不足"
        print(json.dumps(result, ensure_ascii=False))
        return

    src = args[0]
    out = args[1]
    inject_marker = '--marker' in args
    team_id = os.path.basename(src.rstrip('/\\'))
    marker_name = team_id + '/.createteamok.log'

    try:
        if not os.path.isdir(src):
            result["error"] = "团队目录不存在或不是文件夹：" + src
            print(json.dumps(result, ensure_ascii=False))
            return

        # 先清理可能存在的半成品
        if os.path.exists(out):
            try:
                os.remove(out)
            except Exception:
                pass

        added_marker = False
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
            # 单一顶层目录条目（即使为空也保留，避免解压后缺顶层文件夹）
            zf.writestr(team_id + '/', '')
            for root, dirs, files in os.walk(src):
                # 目录条目：含空目录，保持完整文件夹骨架（与标准 zip -r 行为一致）
                for d in dirs:
                    rel_d = os.path.relpath(os.path.join(root, d), src).replace('\\', '/')
                    zf.writestr(team_id + '/' + rel_d + '/', '')
                for name in files:
                    full = os.path.join(root, name)
                    rel = os.path.relpath(full, src).replace('\\', '/')
                    arcname = team_id + '/' + rel
                    zf.write(full, arcname)
                    if arcname == marker_name:
                        added_marker = True

            # 注入导入端所需的标记条目（仅当源文件夹未自带时）
            if inject_marker and not added_marker:
                zf.writestr(marker_name, 'created-by-controlpanel-export\n')

        result["ok"] = True
    except Exception as e:  # noqa: BLE001
        result["error"] = "打包失败：" + str(e)
        try:
            if os.path.exists(out):
                os.remove(out)
        except Exception:
            pass

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
