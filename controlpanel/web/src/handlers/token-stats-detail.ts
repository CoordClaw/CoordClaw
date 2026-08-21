/**
 * Token 明细处理器 — 复用 orgchart.ts 的自包含 HTML 模板模式。
 *
 * 数据：tokenStatsService.getBreakdown(config.members)
 *   - 成员列表直接复用 config-resolver 解析出的 members（含 sessionKey），不重读 team.json。
 *   - 饼图 = 堆叠环（donut）：每个成员一段弧（∝ estTotal），弧内实色=输入(estInputTotal)、浅色=输出(estAsstOutput)。
 *   - 表格 = 仅 est 明细（排除 raw 与轮次）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { tokenStatsService, matchSessionKeyToMember, type BreakdownMember, type SessionTokenRow } from '../lib/token-stats.js';

interface TokenStatsConfig {
  projectRoot: string;
  teamName?: string;
  projectName?: string;
  members?: BreakdownMember[];
}

const PALETTE: [string, string][] = [
  ['#378ADD', '#B5D4F4'], // 蓝
  ['#1D9E75', '#9FE1CB'], // 绿
  ['#7F77DD', '#AFA9EC'], // 紫
  ['#E08A1E', '#F5C77A'], // 琥珀
  ['#D85A30', '#F5B39B'], // 珊瑚
  ['#C23A8C', '#EBA9CF'], // 粉
  ['#5F5E5A', '#B4B2A9'], // 灰
];
const UNMATCHED_COLOR: [string, string] = ['#888780', '#D3D1C7'];

// 成员占比饼图配色：黄金角 HSL 生成，任意成员数量都能保证相邻区分，
// 且整体是与类型占比(固定5色分类)不同的「光谱」色系
const memberShareColor = (i: number): string => {
  const hue = (188 + i * 137.508) % 360; // 188°=青绿起点，137.508°=黄金角步进，N 越大分布越均匀
  return 'hsl(' + hue.toFixed(1) + ',62%,56%)';
};

export function handleTokenStatsDetail(config: TokenStatsConfig, req: IncomingMessage, res: ServerResponse): void {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const isLight = url.searchParams.get('theme') === 'light';
    const lang = url.searchParams.get('lang') || 'zh';
    const L = {
      title: lang === 'en' ? 'Project Token Statistics' : '项目词元量统计',
      pie: lang === 'en' ? 'Visualization' : '可视化图表',
      table: lang === 'en' ? 'Detail Table' : '明细表格',
      member: lang === 'en' ? 'Member' : '成员',
      sessions: lang === 'en' ? 'Sessions' : '会话数',
      date: lang === 'en' ? 'Date' : '日期',
      total: lang === 'en' ? 'Total' : '词元总量',
      memberShare: lang === 'en' ? 'By Member' : '成员占比',
      typeShare: lang === 'en' ? 'By Type' : '类型占比',
      in: lang === 'en' ? 'Input' : '输入',
      out: lang === 'en' ? 'Output' : '输出',
      sys: lang === 'en' ? 'Sys Prompt' : '系统提示',
      user: lang === 'en' ? 'User' : '用户',
      hist: lang === 'en' ? 'History' : '历史',
      tool: lang === 'en' ? 'Tool Result' : '工具结果',
      unmatched: lang === 'en' ? 'Unmatched' : '未匹配',
      solidInput: lang === 'en' ? 'Solid = Input' : '实心 = 输入',
      lightOutput: lang === 'en' ? 'Light = Output' : '浅色 = 输出',
      noData: lang === 'en' ? 'No token data' : '暂无词元数据',
      close: lang === 'en' ? 'Close' : '关闭',
      note: lang === 'en' ? 'Statistics are based on local session files, for reference only.' : '统计数据来自本地会话文件，仅供参考！',
    };

    const breakdown = tokenStatsService.getBreakdown(config.members || []);
    const total = breakdown.total;

    const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // ---- 类型（5 类）固定顺序与配色：系统提示 / 用户 / 历史 / 工具结果 / 输出 ----
    const CATS: Array<{ key: string; label: string }> = [
      { key: 'estSysPrompt', label: L.sys },
      { key: 'estUser', label: L.user },
      { key: 'estAsstHistory', label: L.hist },
      { key: 'estToolResult', label: L.tool },
      { key: 'estAsstOutput', label: L.out },
    ];
    const CAT_COLORS = ['#378ADD', '#1D9E75', '#7F77DD', '#E08A1E', '#D85A30'];

    // ---- 通用环形图（donut）生成：hover 信息由 data-* 提供，不画图例 ----
    const buildDonut = (items: Array<{ label: string; value: number; color: string }>, title: string): string => {
      const cx = 100, cy = 100, rO = 80, rI = 48;
      const pt = (r: number, deg: number): [number, number] => {
        const rad = (deg - 90) * Math.PI / 180;
        return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
      };
      const arc = (a0: number, a1: number): string => {
        const [x1, y1] = pt(rO, a0), [x2, y2] = pt(rO, a1), [x3, y3] = pt(rI, a1), [x4, y4] = pt(rI, a0);
        const large = ((a1 - a0) % 360) > 180 ? 1 : 0;
        return 'M ' + x1.toFixed(2) + ' ' + y1.toFixed(2) + ' A ' + rO + ' ' + rO + ' 0 ' + large + ' 1 ' + x2.toFixed(2) + ' ' + y2.toFixed(2)
          + ' L ' + x3.toFixed(2) + ' ' + y3.toFixed(2) + ' A ' + rI + ' ' + rI + ' 0 ' + large + ' 0 ' + x4.toFixed(2) + ' ' + y4.toFixed(2) + ' Z';
      };
      const sum = items.reduce((s, it) => s + Math.max(0, it.value), 0);
      let paths = '';
      const nz = items.filter((it) => it.value > 0);
      if (nz.length === 1) {
        const c = nz[0];
        const rMid = (rO + rI) / 2, w = rO - rI;
        paths = '<circle class="slice" cx="' + cx + '" cy="' + cy + '" r="' + rMid.toFixed(2) + '" fill="none" stroke="' + c.color + '" stroke-width="' + w.toFixed(2) + '"'
          + ' data-label="' + esc(c.label) + '" data-raw="' + c.value + '" data-pct="100.0"></circle>';
      } else {
        let angle = 0;
        for (const it of items) {
          const v = Math.max(0, it.value);
          if (sum <= 0 || v <= 0) continue;
          const span = Math.min((v / sum) * 360, 359.99);
          const pct = (v / sum * 100).toFixed(1);
          paths += '<path class="slice" d="' + arc(angle, angle + span) + '" fill="' + it.color + '"'
            + ' data-label="' + esc(it.label) + '" data-raw="' + v + '" data-pct="' + pct + '"></path>';
          angle += span;
        }
      }
      return '<svg class="donut-svg" viewBox="0 0 200 200" width="240" height="240"><g class="slices">' + paths + '</g>'
        + '<text x="100" y="95" text-anchor="middle" class="dc-top">' + esc(title) + '</text>'
        + '<text x="100" y="116" text-anchor="middle" class="dc-sub" data-v="' + sum + '">' + sum + '</text>'
        + '</svg>';
    };

    // 成员占比：按 estTotal，每人一段实色弧
    const memberShareItems = breakdown.byMember
      .map((m, i) => ({ label: m.name, value: m.estTotal, color: memberShareColor(i) }))
      .filter((it) => it.value > 0);
    if (breakdown.unmatched.estTotal > 0) memberShareItems.push({ label: L.unmatched, value: breakdown.unmatched.estTotal, color: UNMATCHED_COLOR[0] });

    // 整体类型占比：跨所有已匹配成员聚合 5 类 + 未匹配整体
    const overallCat: Array<{ label: string; value: number; color: string }> = CATS.map((c, i) => {
      let v = 0;
      for (const m of breakdown.byMember) v += (m as any)[c.key] || 0;
      return { label: c.label, value: v, color: CAT_COLORS[i] };
    });
    if (breakdown.unmatched.estTotal > 0) overallCat.push({ label: L.unmatched, value: breakdown.unmatched.estTotal, color: '#888780' });

    // 拼装：第一排=成员占比+类型占比（全局），分隔线后=各成员的类型占比
    const globalPies = '<div class="pie-cell">' + buildDonut(memberShareItems, L.memberShare) + '</div>'
      + '<div class="pie-cell">' + buildDonut(overallCat, L.typeShare) + '</div>';
    let memberPies = '';
    breakdown.byMember.forEach((m) => {
      const items = CATS.map((c, ci) => ({ label: c.label, value: (m as any)[c.key] || 0, color: CAT_COLORS[ci] }));
      memberPies += '<div class="pie-cell">' + buildDonut(items, m.name) + '</div>';
    });
    const pieHtml = '<div class="pie-section"><div class="pie-scroll"><div class="pie-grid">' + globalPies + memberPies + '</div></div></div>';

    // ---- 表格行：单条会话明细，按 ts 倒序（最新在前），不按成员聚合 ----
    const sessions: SessionTokenRow[] = tokenStatsService.getSessionList();
    const fmtDate = (ts: number): string => {
      if (!ts) return '-';
      const d = new Date(ts);
      const p = (n: number) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    };
    const resolveName = (sk: string): string => {
      const idx = matchSessionKeyToMember(sk, config.members || []);
      if (idx >= 0) return (config.members || [])[idx].name;
      const parts = sk.split(':');
      return parts[0] === 'agent' && parts[1] ? parts[1] : (sk || '未知');
    };

    let rowsHtml = '';
    sessions.forEach((s) => {
      rowsHtml += '<tr><td class="tname">' + esc(resolveName(s.sessionKey)) + '</td>'
        + '<td>' + fmtDate(s.ts) + '</td>'
        + '<td data-v="' + s.estTotal + '">' + s.estTotal + '</td>'
        + '<td data-v="' + s.estSysPrompt + '">' + s.estSysPrompt + '</td>'
        + '<td data-v="' + s.estUser + '">' + s.estUser + '</td>'
        + '<td data-v="' + s.estAsstHistory + '">' + s.estAsstHistory + '</td>'
        + '<td data-v="' + s.estToolResult + '">' + s.estToolResult + '</td>'
        + '<td data-v="' + s.estAsstOutput + '">' + s.estAsstOutput + '</td></tr>';
    });

    const themeCSS = isLight
      ? ':root{--bg:#f8f9fa;--card:#fff;--text:#1a1a2e;--muted:#666;--border:rgba(0,0,0,.1);--accent:#378ADD;--th-bg:#eceff3;--slice-shadow:rgba(0,0,0,.45);--sb-thumb:rgba(0,0,0,.28);--sb-thumb-hover:rgba(0,0,0,.45);--sb-track:rgba(0,0,0,.06)}'
      : ':root{--bg:#1a1a2e;--card:#252545;--text:#fff;--muted:#a0a0a0;--border:rgba(255,255,255,.12);--accent:#5b8def;--th-bg:#22223c;--slice-shadow:rgba(255,255,255,.32);--sb-thumb:rgba(255,255,255,.26);--sb-thumb-hover:rgba(255,255,255,.45);--sb-track:rgba(255,255,255,.06)}';

    const html =
      '<!DOCTYPE html><html lang="' + (lang === 'en' ? 'en' : 'zh-CN') + '"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">'
      + '<title>' + esc(L.title) + '</title><style>'
      + themeCSS
      + '*{margin:0;padding:0;box-sizing:border-box}'
      + 'body{font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);min-height:100vh}'
      + '.header{text-align:center;padding:18px 0 6px}.header h1{font-size:19px;font-weight:600}.header .sub{color:var(--muted);font-size:12px;margin-top:2px}'
      + '.tabs{display:flex;justify-content:center;gap:8px}'
      + '.tab-btn{padding:6px 18px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--muted);font-size:13px;cursor:pointer}'
      + '.tab-btn.active{background:var(--accent);color:#fff;border-color:var(--accent)}'
      + '.tabs-wrap{position:relative;margin:10px 0 4px}'
      + '.tab-note{position:absolute;right:16px;top:50%;transform:translateY(-50%);font-size:11px;color:var(--muted);text-align:right}'
      + '.panel{padding:8px 16px 20px}'
      + '.pie-section{margin-top:18px}'
      + '.pie-scroll{max-height:calc(100vh - 200px);overflow:auto;scrollbar-gutter:stable;padding:4px}'
      + '.pie-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:34px 48px;justify-items:center}'
      + '.pie-cell{display:flex;flex-direction:column;align-items:center;padding:4px 8px}'
      + '.donut-svg{display:block;overflow:visible;filter:drop-shadow(0 2px 6px rgba(0,0,0,.14))}'
      + '.dc-top{fill:var(--muted);font-size:12px;letter-spacing:.04em}'
      + '.dc-sub{fill:var(--text);font-size:18px;font-weight:600}'
      + '.slice{cursor:pointer;transition:transform .14s ease,filter .14s ease;transform-box:fill-box;transform-origin:center}'
      + '.slice:hover{transform:scale(1.1);filter:drop-shadow(6px 6px 6px var(--slice-shadow)) brightness(1.06)}'
      + '.tip{position:fixed;display:none;pointer-events:none;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;line-height:1.5;box-shadow:0 4px 14px rgba(0,0,0,.28);z-index:99;white-space:nowrap}'
      + '.tip b{color:var(--accent)}'
      + 'table{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}'
      + '.tbl-wrap{margin-top:8px;border:1px solid var(--border);border-radius:8px;overflow:hidden}'
      + '.tbl-head{overflow:hidden;scrollbar-gutter:stable}'
      + '.tbl-body-scroll{max-height:calc(100vh - 230px);overflow:auto;scrollbar-gutter:stable}'
      + '.pie-scroll::-webkit-scrollbar,.tbl-body-scroll::-webkit-scrollbar{width:10px;height:10px}'
      + '.pie-scroll::-webkit-scrollbar-track,.tbl-body-scroll::-webkit-scrollbar-track{background:var(--sb-track)}'
      + '.pie-scroll::-webkit-scrollbar-thumb,.tbl-body-scroll::-webkit-scrollbar-thumb{background:var(--sb-thumb);border-radius:6px;border:2px solid var(--sb-track)}'
      + '.pie-scroll::-webkit-scrollbar-thumb:hover,.tbl-body-scroll::-webkit-scrollbar-thumb:hover{background:var(--sb-thumb-hover)}'
      + '.pie-scroll,.tbl-body-scroll{scrollbar-color:var(--sb-thumb) var(--sb-track);scrollbar-width:thin}'
      + 'th,td{padding:10px 14px;text-align:center;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + 'thead th{background:var(--th-bg);border-bottom:2px solid var(--border)}'
      + 'th{color:var(--text);font-weight:600;font-size:11px;letter-spacing:0.02em}'
      + 'th.input-group{color:var(--text);text-align:center;font-weight:600;font-size:12px;letter-spacing:0.04em;padding:8px 0}'
      + 'th.sub-col{color:var(--text);font-weight:600;font-size:11px}'
      + 'td:nth-child(3){font-weight:600;color:var(--accent)}'
      + 'td:not(:first-child),th:not(:first-child){border-left:1px solid var(--border)}'
      + 'th.col-in-start{border-left:1px solid var(--border)}'
      + 'tbody tr:hover td{background:rgba(55,138,221,0.03)}'
      + 'td.tname{display:flex;align-items:center;justify-content:center;gap:8px;font-weight:500}'
      + 'th.tname{text-align:center;font-weight:600;font-size:12px;color:var(--text)}'
      + 'tr.unmatched{color:var(--muted)}.muted{color:var(--muted)}'
      + '.empty{text-align:center;color:var(--muted);padding:40px 0}'
      + '</style></head><body>'
      + '<div class="header"><h1>' + esc(L.title) + '</h1><div class="sub">' + esc(config.teamName || '') + (config.projectName ? ' · ' + esc(config.projectName) : '') + '</div></div>'
      + '<div class="tabs-wrap"><div class="tabs"><button class="tab-btn active" data-tab="pie" onclick="switchTab(\'pie\')">' + L.pie + '</button>'
      + '<button class="tab-btn" data-tab="table" onclick="switchTab(\'table\')">' + L.table + '</button></div>'
      + '<span class="tab-note">' + esc(L.note) + '</span></div>'
      + '<div class="panel">'
      + (total > 0
        ? '<div id="tab-pie">' + pieHtml + '</div>'
          + '<div id="tab-table" style="display:none"><div class="tbl-wrap">'
          + '<div class="tbl-head"><table><colgroup><col style="width:10%"><col style="width:18%"><col style="width:11%"><col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:9%"></colgroup><thead>'
          + '<tr><th class="tname" rowspan="2">' + L.member + '</th><th rowspan="2">' + L.date + '</th><th rowspan="2">' + L.total + '</th>'
          + '<th class="input-group" colspan="4">' + L.in + '</th>'
          + '<th class="col-out" rowspan="2">' + L.out + '</th></tr>'
          + '<tr><th class="sub-col col-in-start">' + L.sys + '</th><th class="sub-col">' + L.user + '</th><th class="sub-col">' + L.hist + '</th><th class="sub-col">' + L.tool + '</th></tr>'
          + '</thead></table></div>'
          + '<div class="tbl-body-scroll"><table><colgroup><col style="width:10%"><col style="width:18%"><col style="width:11%"><col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:9%"></colgroup><tbody>' + rowsHtml + '</tbody></table></div>'
          + '</div></div>'
        : '<div class="empty">' + L.noData + '</div>')
      + '</div>'
      + '<div class="tip" id="tip"></div>'
      + '<script>var LANG="' + lang + '";'
      + 'function fmt(n){var v=Number(n)||0;'
      + 'function u(val,mag,suf){var x=val/mag;return (x>=100?Math.round(x):x.toFixed(1).replace(/\\.0$/,""))+suf;}'
      + 'if(LANG==="en"){if(v>=1e9)return u(v,1e9,"B");if(v>=1e6)return u(v,1e6,"M");if(v>=1e3)return u(v,1e3,"K");return String(v);}'
      + 'if(v>=1e8)return u(v,1e8,"亿");if(v>=1e4)return u(v,1e4,"万");return String(v);}'
      + 'function switchTab(t){document.getElementById("tab-pie").style.display=t==="pie"?"block":"none";'
      + 'document.getElementById("tab-table").style.display=t==="table"?"block":"none";'
      + 'document.querySelectorAll(".tab-btn").forEach(function(b){b.classList.toggle("active",b.dataset.tab===t);});}'
      + 'document.querySelectorAll("[data-v]").forEach(function(el){el.textContent=fmt(el.getAttribute("data-v"));});'
      + 'var tip=document.getElementById("tip");'
      + 'document.querySelectorAll(".slice").forEach(function(s){'
      + 's.addEventListener("mousemove",function(e){tip.style.display="block";tip.style.left=(e.clientX+14)+"px";tip.style.top=(e.clientY+14)+"px";tip.innerHTML="<b>"+s.getAttribute("data-label")+"</b><br>"+fmt(Number(s.getAttribute("data-raw")))+" · "+s.getAttribute("data-pct")+"%";'
      + 'if(!s._lifted){s._lifted=!0;var self=s;requestAnimationFrame(function(){var p=self.parentNode;if(p&&p.classList.contains("slices"))p.appendChild(self);});}});'
      + 's.addEventListener("mouseleave",function(){tip.style.display="none";s._lifted=!1;});});'
      + '</script></body></html>';

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Token stats detail error: ' + String(e));
  }
}
