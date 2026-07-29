"""跨平台文件夹选择对话框
- Windows: IFileDialog (现代资源管理器风格)
- macOS: NSOpenPanel (原生 Finder 对话框)  
- Linux: GTK/Qt (桌面环境原生)
所有平台都是全尺寸前台对话框，零配置。
"""
import sys
import os
import tkinter as tk
from tkinter import filedialog

title = sys.argv[1] if len(sys.argv) > 1 else '选择'
initial_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser('~')
mode = sys.argv[3] if len(sys.argv) > 3 else 'folder'
if not os.path.isdir(initial_dir):
    initial_dir = os.path.expanduser('~')

root = tk.Tk()
root.withdraw()
root.attributes('-topmost', True)

if mode == 'file':
    selected = filedialog.askopenfilename(
        title=title,
        initialdir=initial_dir,
        filetypes=[('团队包', '*.tpkg'), ('所有文件', '*.*')],
        parent=root
    )
else:
    selected = filedialog.askdirectory(
        title=title,
        initialdir=initial_dir,
        mustexist=True,
        parent=root
    )

root.destroy()

if selected:
    # 统一为正斜杠
    print(os.path.normpath(selected).replace('\\', '/'))
