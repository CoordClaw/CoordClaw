"""解压团队包 .tpkg（zip 改后缀）到指定目录，并做安全校验。

用法：python extract-tpkg.py <tpkg路径> <输出目录>
输出：JSON {ok:bool, error:str, topEntries:[顶层目录名...]}
- 校验 zip 合法性（PK 头由调用方校验，这里用 zipfile.is_zipfile）
- 拒绝路径遍历（/ 开头、含 ..）与符号链接（纵深防御 zip-slip）
- 提取后返回非 macOS 元数据、非点文件的所有顶层条目名
"""
import sys
import os
import json
import zipfile
import stat


def main():
    result = {"ok": False, "error": "", "topEntries": []}
    if len(sys.argv) < 3:
        result["error"] = "参数不足"
        print(json.dumps(result, ensure_ascii=False))
        return

    tpkg = sys.argv[1]
    out = sys.argv[2]

    try:
        if not os.path.isfile(tpkg) or not zipfile.is_zipfile(tpkg):
            result["error"] = "无效的 .tpkg 包（不是 zip 文件）"
            print(json.dumps(result, ensure_ascii=False))
            return

        zf = zipfile.ZipFile(tpkg)
        bad = []
        for info in zf.infolist():
            norm = info.filename.replace('\\', '/')
            parts = norm.split('/')
            # 绝对路径或上级目录遍历
            if norm.startswith('/') or norm.startswith('\\') or '..' in parts:
                bad.append(info.filename)
                continue
            # 符号链接检测（Unix 权限位）
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                bad.append(info.filename + " (符号链接)")

        if bad:
            result["error"] = "包含非法路径或符号链接：" + ", ".join(bad[:5])
            print(json.dumps(result, ensure_ascii=False))
            return

        zf.extractall(out)

        tops = set()
        for info in zf.infolist():
            parts = info.filename.replace('\\', '/').split('/')
            if parts and parts[0]:
                tops.add(parts[0])
        # 过滤 macOS 元数据(__MACOSX/) 与点文件
        tops = [t for t in tops if not t.startswith('__MACOSX') and not t.startswith('.')]
        result["ok"] = True
        result["topEntries"] = list(tops)
    except Exception as e:  # noqa: BLE001
        result["error"] = "解压失败：" + str(e)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
