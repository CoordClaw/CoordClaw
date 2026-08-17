cd teamstemplate
find . -type d | while read d; do
  # 该目录无任何文件且无子目录 → 空 → 加 .gitkeep
  if [ -z "$(find "$d" -mindepth 1 -maxdepth 1)" ]; then touch "$d/.gitkeep"; fi
done