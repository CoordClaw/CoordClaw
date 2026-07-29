/**
 * 组织架构图处理器 — 提取自 server.ts
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { sendJSON } from '../lib/response.js';
import { resolveTeamJsonPath, readJsonFileSync, TEAM_JSON_FILENAME } from '../config-resolver.js';

interface AppConfig {
  projectRoot: string;
  teamName?: string;
  projectName?: string;
}

export function handleOrgChart(config: AppConfig, req: IncomingMessage, res: ServerResponse): void {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const isLight = url.searchParams.get('theme') === 'light';
    const lang = url.searchParams.get('lang') || 'zh';
    const L = {
      org_chart: lang === 'en' ? 'Org Chart' : '组织架构',
      l4_title: 'L4 ' + (lang === 'en' ? 'Lead' : '负责人'),
      l3_title: 'L3 ' + (lang === 'en' ? 'Manager' : '主管'),
      l2_title: 'L2 ' + (lang === 'en' ? 'Core' : '核心'),
      l1_title: 'L1 ' + (lang === 'en' ? 'Exec' : '执行'),
      position: lang === 'en' ? 'Role' : '职位',
      level: lang === 'en' ? 'Level' : '职级',
      supervisor: lang === 'en' ? 'Reports to' : '上级',
      subordinate: lang === 'en' ? 'Subordinates' : '下属',
    };
    const teamJsonPath = resolveTeamJsonPath(config.projectRoot);
    if (!existsSync(teamJsonPath)) {
      sendJSON(res, 404, { error: TEAM_JSON_FILENAME + ' 不存在' });
      return;
    }
    const team = readJsonFileSync(teamJsonPath);
    const members = team.members || [];
    const humans = team.humanmember || [];
    const humanNames = new Set<string>(humans.filter((h: any) => h.enabled).map((h: any) => h.name));
    const teamName = team.team_name || config.teamName || '';
    const projectName = team.project_name || config.projectName || '';
    const findInList = (name: string, set: Set<string>) =>
      set.has(name) || set.has(name.replace(/（.*$/, '') as string);
    const esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const supList = (sup: string) => sup.split(/[、，,]/).map(s => s.trim());

    // ★ humanMember 虚拟节点加入成员列表用于建树
    const humanNodes = humans.filter((h: any) => h.enabled).map((h: any) => ({
      name: h.name, role: h.role || '', authority_level: 'H', direct_supervisor: '', direct_subordinate: ''
    }));
    const allNodes = [...humanNodes, ...members.filter((m: any) => !humanNames.has(m.name))];
    const memberNames = new Set<string>(allNodes.map((m: any) => m.name));
    const roots = allNodes.filter((m: any) => {
      if (!m.direct_supervisor) return true;
      return supList(m.direct_supervisor).every((s: string) => !memberNames.has(s) && !memberNames.has(s.replace(/（.*$/, '')));
    });
    if (roots.length === 0) roots.push(allNodes[0]);
    const memberCount: Record<string, number> = {};
    const countSubtree = (m: any, all: any[]) => {
      if (!m) return;
      memberCount[m.name] = (memberCount[m.name] || 0) + 1;
      const kids = all.filter((x: any) => x.direct_supervisor && x.direct_supervisor !== '用户' && supList(x.direct_supervisor).some((s: string) => s === m.name || s.replace(/（.*$/, '') === m.name));
      kids.forEach(k => countSubtree(k, all));
    };
    roots.forEach((r: any) => countSubtree(r, allNodes));

    const inferUp = (levels: string[]) => {
      const max = Math.max(...levels.map(l => parseInt(l.replace('L','')) || 0));
      return 'L' + Math.min(max + 1, 4);
    };
    const buildTree = (m: any, all: any[]): string => {
      if (!m) return '';
      const kids = all.filter((x: any) => x.direct_supervisor && x.direct_supervisor !== '用户' && supList(x.direct_supervisor).some((s: string) => s === m.name || s.replace(/（.*$/, '') === m.name));
      const kidsLevels = kids.map((k: any) => k.authority_level).filter(Boolean);
      const lv = m.authority_level || (kidsLevels.length ? inferUp(kidsLevels) : 'L1');
      const multi = memberCount[m.name] > 1;
      const attrClass = lv + (multi ? ' multi' : '');
      const attrData = 'data-mid="' + esc(m.name) + '"' + (multi ? ' data-multi="1"' : '');
      const badge = '';
      const sup = m.direct_supervisor || '';
      const sub = m.direct_subordinate || '';
      const h = '<li><div class="nc ' + attrClass + '" ' + attrData
        + ' onclick="showInfo(\'' + esc(m.name) + '\',\'' + esc(m.role || m.description || '') + '\',\'' + lv + '\',\'' + esc(sup) + '\',\'' + esc(sub) + '\')">'
        + '<div class="nm">' + esc(m.name) + '</div><div class="rl">' + esc(m.role || m.description || '') + '</div>' + badge + '</div>';
      return kids.length ? h + '<ul>' + kids.map((k: any) => buildTree(k, all)).join('') + '</ul></li>' : h + '</li>';
    };

    const treeHtml = roots.map((r: any) => buildTree(r, allNodes)).join('');
    const themeCSS = isLight
      ? ':root{--org-bg:#f8f9fa;--org-text:#1a1a2e;--org-muted:#666;--org-red:#d63031;--bg-card:#f0f0f0;'
        + '--org-l4-bg:linear-gradient(135deg,#e94560,#c23a51);--org-l3-bg:linear-gradient(135deg,#e67e22,#d35400);'
        + '--org-l2-bg:linear-gradient(135deg,#27ae60,#1e8449);--org-l1-bg:linear-gradient(135deg,#2980b9,#1f6dad);'
        + '--sb-thumb:rgba(0,0,0,.28);--sb-thumb-hover:rgba(0,0,0,.45);--sb-track:rgba(0,0,0,.06)}'
      : ':root{--org-bg:#1a1a2e;--org-text:#fff;--org-muted:#a0a0a0;--org-red:#e94560;--bg-card:#252525;'
        + '--org-l4-bg:linear-gradient(135deg,#e94560,#c23a51);--org-l3-bg:linear-gradient(135deg,#f39c12,#d68910);'
        + '--org-l2-bg:linear-gradient(135deg,#2ecc71,#27ae60);--org-l1-bg:linear-gradient(135deg,#3498db,#2980b9);'
        + '--sb-thumb:rgba(255,255,255,.26);--sb-thumb-hover:rgba(255,255,255,.45);--sb-track:rgba(255,255,255,.06)}';
    const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">'
      + '<title>' + esc(teamName) + '</title><style>'
      + themeCSS
      + '*{margin:0;padding:0;box-sizing:border-box}'
      + 'body{font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--org-bg);'
      + 'height:100vh;color:var(--org-text);display:flex;flex-direction:column;overflow:hidden}'
      + '.header{text-align:center;padding:16px 0 8px}'
      + '.header h1{color:var(--org-red);font-size:20px;font-weight:700}'
      + '.header .sub{color:var(--org-muted);font-size:12px;margin-top:2px}'
      + '.legend{display:flex;justify-content:center;gap:14px;margin-bottom:8px}'
      + '.legend-item{display:flex;align-items:center;gap:4px;color:#ccc;font-size:11px}'
      + '.legend-dot{width:9px;height:9px;border-radius:50%}'
      + '.tree-wrap{overflow:auto;position:relative;flex:1;cursor:grab;display:flex;flex-direction:column}'
      + '.tree-wrap.grabbing{cursor:grabbing}'
      + '.tree-wrap::-webkit-scrollbar{width:10px;height:10px}'
      + '.tree-wrap::-webkit-scrollbar-track{background:var(--sb-track)}'
      + '.tree-wrap::-webkit-scrollbar-thumb{background:var(--sb-thumb);border-radius:6px;border:2px solid var(--sb-track)}'
      + '.tree-wrap::-webkit-scrollbar-thumb:hover{background:var(--sb-thumb-hover)}'
      + '.tree-wrap{scrollbar-color:var(--sb-thumb) var(--sb-track);scrollbar-width:thin}'
      + '.tree-inner{margin:auto;width:max-content}'
      + '.tree-scaler{padding:20px}'
      + '.tree ul{padding-top:32px;position:relative;display:flex;justify-content:center}'
      + '.tree li{text-align:center;list-style:none;position:relative;padding:32px 6px 0 6px}'
      + '.tree li::before,.tree li::after{content:"";position:absolute;top:0;right:50%;border-top:2px solid var(--org-red);width:50%;height:32px;opacity:.5}'
      + '.tree li::after{right:auto;left:50%;border-left:2px solid var(--org-red)}'
      + '.tree li:only-child::after,.tree li:only-child::before{display:none}'
      + '.tree li:only-child{padding-top:0}'
      + '.tree li:first-child::before,.tree li:last-child::after{border:0 none}'
      + '.tree li:last-child::before{border-right:2px solid var(--org-red);border-radius:0 5px 0 0}'
      + '.tree li:first-child::after{border-radius:5px 0 0 0}'
      + '.tree ul ul::before{content:"";position:absolute;top:0;left:50%;border-left:2px solid var(--org-red);width:0;height:32px;opacity:.5}'
      + '.nc{display:inline-block;padding:10px 14px;border-radius:12px;color:#fff;font-size:12px;font-weight:600;min-width:100px;box-shadow:0 2px 8px rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.1);transition:all .2s;cursor:pointer}'
      + '.nc:hover{transform:translateY(-2px) scale(1.03);z-index:100;box-shadow:0 4px 16px rgba(0,0,0,.4)}'
      + '.nc .nm{font-size:14px;font-weight:700;margin-bottom:1px}'
      + '.nc .rl{font-size:10px;opacity:.85}'
      + '.L4{background:var(--org-l4-bg);border-color:#ff6b6b}'
      + '.L3{background:var(--org-l3-bg);border-color:#f39c12}'
      + '.L2{background:var(--org-l2-bg);border-color:#2ecc71}'
      + '.L1{background:var(--org-l1-bg);border-color:#3498db}'
      + '.H{background:linear-gradient(135deg,#8e44ad,#6c3483);border-color:#a569bd}'
      + '.nc.multi{border-color:#a855f7!important;border-width:2px}'
      + '.nc.no-rel{background:var(--bg-card);color:var(--org-muted);border-color:rgba(255,255,255,.08)}'
      + '@keyframes pulse{0%,100%{opacity:1;box-shadow:0 2px 8px rgba(0,0,0,.3)}'
      + '50%{opacity:.55;box-shadow:0 0 24px var(--org-red)}}'
      + '.nc.pulse{animation:pulse .8s ease-in-out infinite}'
      + '.zoom-row{display:flex;justify-content:flex-end;padding:0 8px 4px 8px}'
      + '.zoom-bar{display:flex;align-items:center;gap:4px;'
      + 'padding:4px 6px;border-radius:8px;background:var(--org-bg);border:1px solid rgba(255,255,255,.1)}'
      + '.zoom-bar button{width:28px;height:28px;border-radius:5px;'
      + 'border:1px solid rgba(255,255,255,.12);background:var(--bg-card);'
      + 'color:var(--org-text);font-size:15px;cursor:pointer;line-height:1}'
      + '.zoom-bar button:hover{background:var(--org-red);border-color:var(--org-red);color:#fff}'
      + '.zoom-bar span{color:var(--org-muted);font-size:11px;min-width:36px;text-align:center}'
      + '.info-panel{position:fixed;top:50%;right:16px;transform:translateY(-50%);'
      + 'background:var(--bg-card);border:1px solid var(--org-red);opacity:.95;'
      + 'border-radius:10px;padding:14px 18px;color:var(--org-text);font-size:12px;'
      + 'backdrop-filter:blur(12px);z-index:500;display:none;'
      + 'min-width:200px;box-shadow:0 6px 24px rgba(0,0,0,.3)}'
      + '.info-panel.show{display:block}'
      + '.info-panel .close{position:absolute;top:4px;right:10px;cursor:pointer;color:var(--org-red);font-size:16px}'
      + '.info-panel h3{color:var(--org-red);margin-bottom:8px;font-size:14px;padding-right:16px;text-align:left}'
      + '.info-row{display:flex;margin:4px 0;text-align:left}'
      + '.info-label{color:var(--org-muted);min-width:36px;margin-right:8px}'
      + '.info-value{font-weight:600}'
      + '</style></head><body>'
      + '<div class="header"><h1>' + esc(teamName) + ' - ' + L.org_chart + '</h1><div class="sub">' + esc(projectName) + '</div></div>'
      + '<div class="legend"><div class="legend-item"><div class="legend-dot" style="background:#ff6b6b"></div><span>' + L.l4_title + '</span></div>'
      + '<div class="legend-item"><div class="legend-dot" style="background:#3498db"></div><span>' + L.l3_title + '</span></div>'
      + '<div class="legend-item"><div class="legend-dot" style="background:#5dade2"></div><span>' + L.l2_title + '</span></div>'
      + '<div class="legend-item"><div class="legend-dot" style="background:#7fb3d3"></div><span>' + L.l1_title + '</span></div>'
      + '<div class="legend-item"><div class="legend-dot" style="background:#a569bd"></div><span>' + (lang === 'en' ? 'Human' : '人类') + '</span></div></div>'
      + '<div class="zoom-row"><div class="zoom-bar"><button onclick="zoomOrg(.15)" title="' + (lang === 'en' ? 'Zoom in' : '放大') + '">+</button>'
      + '<span style="color:var(--org-muted);font-size:11px;min-width:32px;text-align:center;pointer-events:none" id="zl">100%</span>'
      + '<button onclick="zoomOrg(-.15)" title="' + (lang === 'en' ? 'Zoom out' : '缩小') + '">−</button>'
      + '<button onclick="zoomReset()" title="' + (lang === 'en' ? 'Reset' : '重置') + '" style="margin-left:8px">↺</button></div></div>'
      + '<div class="tree-wrap" id="tw">'
      + '<div class="tree-inner" id="ti"><div class="tree-scaler" id="ts"><div class="tree"><ul>' + treeHtml + '</ul></div></div></div></div>'
      + '<div class="info-panel" id="ip"><span class="close" onclick="closeInfo()">×</span>'
      + '<h3 id="ipName"></h3>'
      + '<div class="info-row"><span class="info-label">' + L.position + '</span><span class="info-value" id="ipRole"></span></div>'
      + '<div class="info-row"><span class="info-label">' + L.level + '</span><span class="info-value" id="ipLevel"></span></div>'
      + '<div class="info-row"><span class="info-label">' + L.supervisor + '</span><span class="info-value" id="ipSup"></span></div>'
      + '<div class="info-row"><span class="info-label">' + L.subordinate + '</span><span class="info-value" id="ipSub"></span></div>'
      + '</div>'
      + '<script>var NA="' + (lang === 'en' ? 'Not defined' : '组织关系未定义') + '";'
      + 'function showInfo(n,r,l,s,b){'
      + 'document.getElementById("ipName").textContent=n;'
      + 'document.getElementById("ipRole").textContent=r||NA;'
      + 'document.getElementById("ipLevel").textContent=l=="—"||!l?NA:l;'
      + 'document.getElementById("ipSup").textContent=s||NA;'
      + 'document.getElementById("ipSub").textContent=b||NA;'
      + 'document.getElementById("ip").classList.add("show");'
      + '}'
      + 'function closeInfo(){document.getElementById("ip").classList.remove("show")}'
      + 'document.addEventListener("click",function(e){if(!e.target.closest(".nc")&&!e.target.closest(".info-panel"))closeInfo()});'
      + 'document.addEventListener("mouseover",function(e){var n=e.target.closest(".nc");'
      + 'if(!n||!n.dataset.mid)return;var m=n.dataset.mid,s=document.querySelectorAll(\'[data-mid="\'+m+\'"]\');'
      + 'if(s.length>1)s.forEach(function(x){x.classList.add("pulse")})});'
      + 'document.addEventListener("mouseout",function(e){var n=e.target.closest(".nc");'
      + 'if(!n||!n.dataset.mid)return;'
      + 'document.querySelectorAll(\'[data-mid="\'+n.dataset.mid+\'"]\').forEach(function(x){x.classList.remove("pulse")})});'
      + 'var zs=1,hVw,hVh,tw=document.getElementById("tw"),ti=document.getElementById("ti"),ts=document.getElementById("ts");'
      + 'ts.style.transformOrigin="50% 50%";'
      + 'function zoomOrg(d){zs=Math.max(.3,Math.min(3,zs+d));'
      + 'ts.style.transform="scale("+zs+")";'
      + 'saveNat();'
      + 'document.getElementById("zl").textContent=Math.round(zs*100)+"%"};'
      + 'function zoomReset(){zs=1;'
      + 'ts.style.transform="scale(1)";'
      + 'saveNat();'
      + 'document.getElementById("zl").textContent="100%"};'
      + 'function saveNat(){hVw=tw.clientWidth/2;hVh=tw.clientHeight/2;'
      + 'var cw=ti.scrollWidth,ch=ti.scrollHeight;'
      + 'if(cw<=tw.clientWidth){tw.scrollLeft=0}else{tw.scrollLeft=Math.round(cw/2-hVw)}'
      + 'if(ch<=tw.clientHeight){tw.scrollTop=0}else{tw.scrollTop=Math.round(ch/2-hVh)}};'
      + 'requestAnimationFrame(function(){saveNat()});'
      + 'if(document.fonts&&document.fonts.ready)document.fonts.ready.then(saveNat);'
      + 'window.addEventListener("resize",saveNat);'
      + 'document.getElementById("tw").addEventListener("wheel",function(e){if(e.ctrlKey||e.metaKey){e.preventDefault();zoomOrg(e.deltaY>0?-.1:.1)}});'
      + '(function(){var px=0,py=0,dragging=false;'
      + 'tw.addEventListener("mousedown",function(e){if(e.button!==0||e.target.closest(".nc"))return;e.preventDefault();'
      + 'dragging=true;px=e.clientX+tw.scrollLeft;py=e.clientY+tw.scrollTop;tw.classList.add("grabbing")});'
      + 'window.addEventListener("mousemove",function(e){if(!dragging)return;'
      + 'tw.scrollLeft=px-e.clientX;tw.scrollTop=py-e.clientY});'
      + 'window.addEventListener("mouseup",function(){dragging=false;tw.classList.remove("grabbing")})})()'
      + '</script></body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    sendJSON(res, 500, { error: String(e) });
  }
}
