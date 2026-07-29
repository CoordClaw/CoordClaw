/**
 * term-box.ts — 终端框线绘制工具（控制台 ASCII 框）
 * 统一供 server.ts 启动横幅、index.ts 启动小框复用，避免各写一套硬编码边框。
 */

/** 显示宽度（终端列数）：CJK/emoji/全角算 2 列，ASCII 算 1 列；组合符零宽 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xFE0F || cp === 0x200D || cp === 0xFE0E) continue; // 变体选择符 / 零宽连接符
    if (
      (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0x303E) ||
      (cp >= 0x3041 && cp <= 0x33FF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xA000 && cp <= 0xA4FF) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F000) ||
      (cp >= 0x2600 && cp <= 0x27BF) || (cp >= 0x2B00 && cp <= 0x2BFF) ||
      (cp > 0xFFFF)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

export type BoxRow = string | { sep: true };

export interface DrawBoxOpts {
  /** 右 ║ 前富余列数，默认 4（最长行右 ║ 前留 spare+1 列空格） */
  spare?: number;
  /** 最小内宽，默认 40 */
  minWidth?: number;
}

/**
 * 绘制终端框。innerW = max(minWidth, 最长行显示宽 + 2(║内两空格) + spare)。
 * 返回字符串数组，调用方 forEach(console.log) 即可。
 * 最长文本决定宽度 + 富余，永不错位。
 */
export function drawBox(rows: BoxRow[], opts: DrawBoxOpts = {}): string[] {
  const spare = opts.spare ?? 4;
  const minWidth = opts.minWidth ?? 40;
  let maxW = 0;
  for (const r of rows) {
    if (typeof r === 'string') {
      const w = displayWidth(r);
      if (w > maxW) maxW = w;
    }
  }
  const innerW = Math.max(minWidth, maxW + 2 + spare);
  const edge = '═'.repeat(innerW);
  const top = '╔' + edge + '╗';
  const bottom = '╚' + edge + '╝';
  const sep = '╠' + edge + '╣';
  const out: string[] = [top];
  for (const r of rows) {
    if (r && typeof r === 'object' && 'sep' in r) {
      out.push(sep);
    } else {
      const text = r as string;
      const pad = Math.max(0, innerW - 2 - displayWidth(text));
      out.push('║ ' + text + ' '.repeat(pad) + ' ║');
    }
  }
  out.push(bottom);
  return out;
}
