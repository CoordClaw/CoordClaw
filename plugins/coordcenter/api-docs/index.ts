/**
 * 功能20 (v19.38): API 文档页 — 服务端渲染的交互式接口文档
 *
 * 提供 GET /coordclaw-plugin/coordclawcenter/api-docs 路由。
 * 所有接口数据在服务端渲染为 HTML 元素（零 JSON 注入，零 JS 解析问题）。
 */

import { ROUTE_REGISTRY, ROUTES } from "../shared/routes";
import { registerPluginRoute } from "../shared/http-helpers";
import { info, getEventId } from "../shared/logger";

const MODULE = "api-docs";

// ==================== 转义工具 ====================

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jstr(o: unknown): string {
  return JSON.stringify(o, null, 2);
}

// ==================== 渲染单个接口卡片 ====================

function renderEndpoint(ep: (typeof ROUTE_REGISTRY)[number]): string {
  const resp = ep.response;
  const fields = resp?.fields || {};
  const errors = resp?.errors || [];
  const params = ep.params || {};
  const paramKeys = Object.keys(params);
  const methodCls = (ep.method || "").toLowerCase();
  const hasResp = !!resp && !!resp.example;

  let html = `<div class="endpoint" data-path="${escHtml(ep.path)}" data-desc="${escHtml(ep.desc)}">`;
  // 头部（可点击展开）
  html += `<div class="ep-header" onclick="this.parentElement.classList.toggle('open')">`;
  html += `<span class="method-tag ${methodCls}">${escHtml(ep.method || "")}</span>`;
  html += `<span class="ep-path">${escHtml(ep.path)}</span>`;
  html += `<span class="ep-desc">${escHtml(ep.desc)}</span>`;
  html += "</div>";
  // 内容区
  html += "<div class='ep-body'>";

  // 参数表
  if (paramKeys.length > 0) {
    html += "<div class='section-title'>请求参数</div><table><tr><th>字段</th><th>类型/说明</th></tr>";
    for (const k of paramKeys) {
      html += `<tr><td><code>${escHtml(k)}</code></td><td>${escHtml(params[k])}</td></tr>`;
    }
    html += "</table>";
  } else {
    html += "<div class='section-title'>请求参数</div><p style='color:var(--text2);font-size:13px'>无请求参数</p>";
  }

  // 响应示例 + 字段说明 + 错误码
  if (hasResp && resp!.example) {
    html += "<div class='section-title'>响应示例 (成功)</div>";
    html += `<div class='json-block'>${escHtml(jstr(resp!.example))}</div>`;

    const fieldKeys = Object.keys(fields);
    if (fieldKeys.length > 0) {
      html += "<div class='section-title'>响应字段说明</div><table class='field-table'>";
      for (const fk of fieldKeys) {
        html += `<tr><td><code>${escHtml(fk)}</code></td><td>${escHtml(fields[fk])}</td></tr>`;
      }
      html += "</table>";
    }

    if (errors.length > 0) {
      html += "<div class='section-title'>可能错误</div><ul class='error-list'>";
      for (const e of errors) html += `<li>${escHtml(e)}</li>`;
      html += "</ul>";
    }

    // Try it out 表单（仅 POST）
    if ((ep.method || "").toUpperCase() === "POST") {
      const body: Record<string, unknown> = {};
      for (const bk in params) {
        const bv = params[bk];
        body[bk] =
          bv && bv.indexOf("必填") >= 0 ? "" :
          bv && bv.indexOf("boolean") >= 0 ? false :
          bv && (bv.indexOf("string[]") >= 0 || bv.indexOf("string[]") >= 0) ? [] : "";
      }
      const bodyJson = jstr(body)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const pathEsc = escHtml(ep.path).replace(/'/g, "&#39;");
      html += `<div class='try-area'><div class='section-title'>在线测试</div>`;
      html += `<textarea class='try-body' rows='6' placeholder='编辑请求体后点击发送...'>${bodyJson}</textarea>`;
      html += `<button class='try-btn' onclick="tryReq(this,'${pathEsc}')">发送请求</button>`;
      html += "<div class='result-area' style='display:none'></div></div>";
    }
  }

  html += "</div></div>";
  return html;
}

// ==================== 生成完整页面 ====================

function generateDocsHtml(): string {
  const cards = ROUTE_REGISTRY.map(renderEndpoint).join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CoordClaw Center - API 文档</title>
<style>
:root{--bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#e6edf3;--text2:#8b949e;--accent:#58a6ff;--green:#3fb950;--red:#f85149;--orange:#d29922;--method-get:#3fb950;--method-post:#a371f7}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
.header{background:var(--surface);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:100}
.header h1{font-size:18px;font-weight:600}
.header .badge{font-size:11px;background:var(--accent);color:#fff;padding:2px 8px;border-radius:12px}
.search-wrap{flex:1;max-width:420px;margin-left:auto}
.search-wrap input{width:100%;padding:8px 14px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:14px;outline:none}
.search-wrap input:focus{border-color:var(--accent)}
.container{max-width:1100px;margin:0 auto;padding:20px}
.stats{display:flex;gap:20px;margin-bottom:16px;color:var(--text2);font-size:13px}
.stat-num{color:var(--accent);font-weight:700;font-size:18px}
.endpoint{background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:12px;overflow:hidden;transition:border-color .15s}
.endpoint:hover{border-color:var(--accent)}
.ep-header{padding:14px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;user-select:none}
.ep-header:hover{background:rgba(88,166,255,.04)}
.method-tag{display:inline-block;padding:3px 10px;border-radius:4px;font-size:12px;font-weight:700;color:#fff;min-width:56px;text-align:center}
.method-tag.post{background:var(--method-post)}.method-tag.get{background:var(--method-get)}
.ep-path{font-family:"SF Mono",Consolas,monospace;font-size:13px;color:var(--accent);flex:1}
.ep-desc{color:var(--text2);font-size:13px}
.ep-body{display:none;border-top:1px solid var(--border);padding:16px}
.endpoint.open .ep-body{display:block}
.section-title{font-size:13px;font-weight:600;color:var(--text);margin:12px 0 8px;display:flex;align-items:center;gap:6px}
.section-title::before{content:'';width:3px;height:14px;background:var(--accent);border-radius:2px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text2);font-weight:500}
td{padding:8px 10px;border-bottom:1px solid rgba(48,54,61,.5);word-break:break-all}
td code{background:rgba(110,118,129,.2);padding:1px 5px;border-radius:3px;font-size:12px}
.json-block{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;font-family:"SF Mono",Consolas,monospace;font-size:12px;white-space:pre-wrap;overflow-x:auto;line-height:1.7;color:var(--text2)}
.try-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border:none;border-radius:6px;background:var(--accent);color:#fff;font-size:13px;font-weight:500;cursor:pointer;margin-top:8px}
.try-btn:hover{opacity:.85}.try-btn:disabled{opacity:.5;cursor:not-allowed}
.try-area{margin-top:8px}
.try-body{width:100%;min-height:80px;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-family:"SF Mono",Consolas,monospace;font-size:12px;resize:vertical;outline:none}
.try-body:focus{border-color:var(--accent)}
.result-area{margin-top:12px}
.result-area .json-block{max-height:400px;overflow-y:auto}
.field-table td:first-child{color:var(--accent);white-space:nowrap;width:140px}
.error-list{list-style:none;padding:0}
.error-list li{padding:4px 0;color:var(--orange);font-size:13px}
.error-list li::before{content:'!';display:inline-block;width:18px;height:18px;line-height:18px;text-align:center;background:rgba(210,153,34,.15);border-radius:50%;font-size:11px;font-weight:700;margin-right:6px}
.empty-state{text-align:center;padding:60px 20px;color:var(--text2)}
.empty-state .icon{font-size:40px;margin-bottom:12px}
@media(max-width:700px){.header{flex-direction:column;align-items:flex-start;gap:8px}.search-wrap{width:100%;max-width:none;margin-left:0}}
</style>
</head>
<body>
<div class="header">
  <h1>CoordClaw Center <span class="badge">API Docs</span></h1>
  <div class="search-wrap"><input id="q" placeholder="搜索接口路径 / 描述..." autocomplete="off"></div>
</div>
<div class="container">
  <div class="stats"><div>共 <span class="stat-num">${ROUTE_REGISTRY.length}</span> 个接口</div></div>
  <div id="list">${cards}</div>
</div>
<script>
(function(){
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function jstr(o){return JSON.stringify(o,null,2);}

  document.getElementById('q').addEventListener('input',function(){
    var q=this.value.trim().toLowerCase();
    var eps=document.querySelectorAll('.endpoint');
    var visible=0;
    for(var i=0;i<eps.length;i++){
      var el=eps[i];
      var path=el.getAttribute('data-path')||'';
      var desc=el.getAttribute('data-desc')||'';
      var match=!q||(path.toLowerCase().indexOf(q)>=0||desc.toLowerCase().indexOf(q)>=0);
      el.style.display=match?'':'none';
      if(match)visible++;
    }
    document.querySelector('.stats').innerHTML=
      '<div>共 <span class="stat-num">'+eps.length+'</span> 个接口</div>'+
      (q?'<div>匹配 <span class="stat-num">'+visible+'</span> 个结果</div>':'');
  });

  window.tryReq=function(btn,path){
    var area=btn.nextElementSibling;
    var ta=btn.previousElementSibling;
    area.style.display='block';
    area.innerHTML='<div class="json-block" style="color:var(--accent)">发送中...</div>';
    btn.disabled=true;
    var bodyStr=ta.value||'{}';
    fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:bodyStr})
      .then(function(r){return r.text().then(function(t){
        try{var o=JSON.parse(t);t=jstr(o);}catch(e){}
        area.innerHTML='<div class="section-title">HTTP '+r.status+'</div><div class="json-block">'+esc(t)+'</div>';
        btn.disabled=false;
      });})
      .catch(function(e){
        area.innerHTML='<div class="section-title" style="color:var(--red)">请求失败</div><div class="json-block">'+esc(e.message)+'</div>';
        btn.disabled=false;
      });
  };
})();
</script>
</body>
</html>`;
}

// ==================== 注册路由 ====================

export function registerApiDocsRoute(api: any): void {
  const eventId = getEventId();

  registerPluginRoute(
    api,
    {
      method: "GET",
      path: ROUTES.API_DOCS,
      auth: "plugin",
      handler: async (_req: any, res: any) => {
        info(MODULE, `[HTTP] 收到请求`, eventId);

        const html = generateDocsHtml();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.statusCode = 200;
        res.end(html);

        info(MODULE, `[HTTP] 已返回 (${html.length} bytes, ${ROUTE_REGISTRY.length} 个接口)`, eventId);
      },
    },
    MODULE,
  );

  info(MODULE, `[INIT] API 文档页已注册: ${ROUTES.API_DOCS}`, eventId);
}
