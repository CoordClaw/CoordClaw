/**
 * HTML 单文件导出呈现模块
 * =====================================
 * 复用 database.ts 的查询结果与 unread 计算（由调用方传入 rows），
 * 仅负责“白主题单文件 HTML”的组装：内嵌 CSS + 客户端筛选 JS + 成员总数。
 * 卡片标记刻意使用自含的白主题类名（不接 Tailwind / 暗色主题），
 * 属有意主题变体，非与实时 UI 的重复实现。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICTS } from './i18n-strings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** locale → html lang 映射（与 i18n.js setLocale 保持一致） */
function resolveHtmlLang(locale: string): string {
  return locale === 'en' ? 'en' : 'zh-CN';
}

/** 取选定语言词典，非法/缺失 locale 回退 zh */
function resolveDict(locale: string): Record<string, string> {
  return DICTS[locale] || DICTS.zh;
}

/** 模板翻译，{0} {1} 占位 */
function tp(dict: Record<string, string>, key: string, ...args: (string | number)[]): string {
  const template = dict[key] !== undefined ? dict[key] : key;
  if (!args.length) return template;
  return template.replace(/\{(\d+)\}/g, (_, i) => {
    const idx = parseInt(i, 10);
    return args[idx] !== undefined ? String(args[idx]) : `{${i}}`;
  });
}

export interface ExportHtmlOptions {
  messages: any[];
  members: { name: string; total: number }[];
  total: number;
  firstAt: string;
  senders: string[];
  recipients: string[];
  logoDataUri?: string;
  /** 导出 UI 语言：'zh' | 'en'，缺省 'zh'（与界面语言一致） */
  locale?: string;
}

let _logoCache: string | null = null;
function loadLogoDataUri(): string {
  if (_logoCache !== null) return _logoCache;
  try {
    // 从模块目录向上查找 static/png/logo-main.png，兼容不同构建/部署目录层级
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'static', 'png', 'logo-main.png');
      if (fs.existsSync(candidate)) {
        _logoCache = 'data:image/png;base64,' + fs.readFileSync(candidate).toString('base64');
        return _logoCache;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* ignore */ }
  _logoCache = '';
  return _logoCache;
}

/** 成员 = 所有出现过的发送者 ∪ 接收者；总数 = 涉及（发或收）的消息数 */
export function buildMembers(rows: any[]): { name: string; total: number }[] {
  const totals: Record<string, number> = {};
  for (const m of rows) {
    const a = m.from_name || '';
    const b = m.recipient || '';
    if (a) totals[a] = (totals[a] || 0) + 1;
    if (b) totals[b] = (totals[b] || 0) + 1;
  }
  return Object.keys(totals)
    .map(name => ({ name, total: totals[name] }))
    .sort((x, y) => y.total - x.total);
}

// 浏览器端脚本（静态，复用 ui.js 的辅助/渲染/筛选逻辑）。
// 用 String.raw 保留正则反斜杠；整段不含反引号与 ${ ，可安全内嵌。
const CLIENT_JS = String.raw`
function escapeHtml(s){ if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function generateAvatarGradient(name){
  var bytes = new TextEncoder().encode(name||'?');
  var hash = Array.from(bytes).reduce(function(sum,b){ return (sum+b)%360; },0);
  var startHue=hash, endHue=(hash+60)%360;
  return 'linear-gradient(45deg, hsl('+startHue+',70%,50%), hsl('+endHue+',70%,50%))';
}
function getLastChar(n){ return (n||'?').slice(-1); }
function getSenderName(m){ return m.from_name||m.sender||I18N.msg_unknown_sender; }
function tp(k){ var t=I18N[k]; if(t===undefined) return k; for(var i=1;i<arguments.length;i++){ t=t.split('{'+(i-1)+'}').join(String(arguments[i])); } return t; }
function formatDateLabel(cd){
  if(!cd) return '';
  if(LOCALE!=='en'){
    var parts=cd.split('-');
    return (parts.length===3) ? (parts[0]+'年'+parseInt(parts[1],10)+'月'+parseInt(parts[2],10)+'日') : cd;
  }
  return cd; // 英文直接用 DB 已有的 YYYY-MM-DD
}
function isMessageUnread(m){ return m.is_unread===true; }
function formatTime(iso){
  if(!iso||iso==='undefined'||iso==='null') return '—';
  var cleaned=iso, d=null;
  try{
    d=new Date(cleaned);
    if(isNaN(d.getTime()) && cleaned.indexOf(' ')!==-1){ d=new Date(cleaned.replace(' ','T')); }
    if(isNaN(d.getTime()) && cleaned.indexOf('Z')===-1 && cleaned.indexOf('+')===-1){ d=new Date(cleaned+'Z'); }
    if(isNaN(d.getTime())){
      var mm=cleaned.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})[\sT](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
      if(mm){ d=new Date(+mm[1],+mm[2]-1,+mm[3],+mm[4],+mm[5],+(mm[6]||'0')); }
    }
    if(!d||isNaN(d.getTime())) return iso;
    var hh=String(d.getHours()).padStart(2,'0'), mi=String(d.getMinutes()).padStart(2,'0'), ss=String(d.getSeconds()).padStart(2,'0');
    var t=hh+':'+mi+':'+ss;
    var now=new Date(), today=new Date(now.getFullYear(),now.getMonth(),now.getDate()), md=new Date(d.getFullYear(),d.getMonth(),d.getDate());
    if(md.getTime()===today.getTime()) return t;
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+t;
  }catch(e){ return iso; }
}
function msgTime(m){ var t=m.created_at||m.timestamp; return t?new Date(t).getTime():0; }
function renderMessage(m){
  var senderName=getSenderName(m), safeSender=escapeHtml(senderName);
  var recipientName=m.recipient||'';
  var time=formatTime(m.created_at||m.timestamp);
  var content=escapeHtml(m.content||m.message||'').replace(/\n/g,'<br>');
  var toName = recipientName ? '<span class="recipient-arrow">→</span><span class="recipient-name">'+escapeHtml(recipientName)+'</span>' : '';
  var avatarGradient=generateAvatarGradient(senderName);
  var lastChar=getLastChar(senderName);
  var isUnread=isMessageUnread(m);
  var isRecipientRead=!isUnread;
  var readBtnClass=isRecipientRead?'read-tag':'read-tag unread-btn';
  return '<div class="msg-card '+(isUnread?'unread':'read')+'" data-msg-id="'+escapeHtml(m.msg_id||'')+'" data-sender="'+safeSender+'" data-recipient="'+escapeHtml(recipientName)+'">'+
    '<div class="flex items-start">'+
      '<div class="avatar" style="background:'+avatarGradient+';">'+lastChar+'</div>'+
      '<div class="flex-1 min-w-0">'+
        '<div class="flex items-center mb-1 flex-wrap">'+
          '<span class="sender">'+safeSender+'</span>'+toName+
          '<span class="timestamp ml-auto">'+time+'</span>'+
        '</div>'+
        '<p class="message-content">'+content+'</p>'+
        ((m.view_count>0)?'<div class="view-count" title="'+tp('msg_view_title',m.view_count)+'">'+tp('msg_view_count',m.view_count)+'</div>':'')+
      '</div>'+
      '<span class="'+readBtnClass+'" title="'+(isUnread?tp('msg_filter_unread'):tp('msg_filter_read'))+'">'+(isRecipientRead?'✓':'○')+'</span>'+
    '</div>'+
  '</div>';
}
function renderMessages(list){
  var seen=new Set(); var unique=[];
  list.forEach(function(m){ var k=m.msg_id||(m.id!=null?String(m.id):null); if(k&&!seen.has(k)){ seen.add(k); unique.push(m); } });
  var sorted=unique.slice().sort(function(a,b){ return msgTime(a)-msgTime(b); });
  var html=''; var seenDates=new Set();
  sorted.forEach(function(m){
    var cd=m.created_date||'';
    if(cd && !seenDates.has(cd)){
      seenDates.add(cd);
      html+='<div class="date-separator">'+escapeHtml(formatDateLabel(cd))+'</div>';
    }
    html+=renderMessage(m);
  });
  return html || '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">'+escapeHtml(I18N.msg_no_messages)+'</div></div>';
}
function applyFilter(){
  var kw=document.getElementById('f-keyword').value.trim().toLowerCase();
  var sender=document.getElementById('f-sender').value;
  var recipient=document.getElementById('f-recipient').value;
  var read=document.getElementById('f-read').value;
  var filtered=DATA.messages.filter(function(m){
    if(kw && (m.content||'').toLowerCase().indexOf(kw)===-1) return false;
    if(sender && m.from_name!==sender) return false;
    if(recipient && m.recipient!==recipient) return false;
    if(read==='unread' && !m.is_unread) return false;
    if(read==='read' && m.is_unread) return false;
    return true;
  });
  document.getElementById('msglist').innerHTML=renderMessages(filtered);
  document.getElementById('f-count').textContent=tp('export_filtered', filtered.length, DATA.total);
}
function init(){
  var first = DATA.first_at ? formatTime(DATA.first_at) : '—';
  document.getElementById('meta').textContent=tp('export_meta', DATA.total, first);
  var ml=document.getElementById('member-list');
  ml.innerHTML = DATA.members.map(function(m){
    var g=generateAvatarGradient(m.name), ch=getLastChar(m.name);
    return '<div class="member-item">'+
      '<div class="member-avatar" style="background:'+g+';">'+escapeHtml(ch)+'</div>'+
      '<div class="member-name" title="'+escapeHtml(m.name)+'">'+escapeHtml(m.name)+'</div>'+
      '<div class="member-total">'+m.total+'</div>'+
    '</div>';
  }).join('');
  var fs=document.getElementById('f-sender'), fr=document.getElementById('f-recipient');
  DATA.senders.forEach(function(s){ fs.insertAdjacentHTML('beforeend','<option value="'+escapeHtml(s)+'">'+escapeHtml(s)+'</option>'); });
  DATA.recipients.forEach(function(r){ fr.insertAdjacentHTML('beforeend','<option value="'+escapeHtml(r)+'">'+escapeHtml(r)+'</option>'); });
  ['f-keyword','f-sender','f-recipient','f-read'].forEach(function(id){ document.getElementById(id).addEventListener('input',applyFilter); });
  applyFilter();
}
init();
`;

export function buildExportHTML(opts: ExportHtmlOptions): string {
  const logo = opts.logoDataUri || loadLogoDataUri();
  const locale = opts.locale || 'zh';
  const D = resolveDict(locale);
  const htmlLang = resolveHtmlLang(locale);
  const t = (k: string, ...a: (string | number)[]): string => tp(D, k, ...a);

  const dataJson = JSON.stringify({
    messages: opts.messages,
    members: opts.members,
    total: opts.total,
    first_at: opts.firstAt,
    senders: opts.senders,
    recipients: opts.recipients,
  });
  const dictJson = JSON.stringify(D);

  // —— 外壳文案（服务端渲染，跟随 locale） ——
  const titleText = t('page_heading') + ' ' + t('export_title_suffix');
  const h1Text = t('page_heading');
  const keywordPh = t('filter_keyword_placeholder');
  const senderAll = t('export_filter_all', t('msg_filter_sender'), t('msg_filter_read_all'));
  const recipientAll = t('export_filter_all', t('msg_filter_recipient'), t('msg_filter_read_all'));
  const statusAll = t('export_filter_all', t('export_status'), t('msg_filter_read_all'));
  const membersTitle = t('export_members_total');
  const unreadOpt = t('msg_filter_unread');
  const readOpt = t('msg_filter_read');

  return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${titleText}</title>
<link rel="icon" type="image/png" href="${logo}">
<style>
/* ===== Design Tokens (白色主题) ===== */
:root{
  --bg-primary:#f4f6f9; --bg-secondary:#ffffff; --bg-card:#ffffff; --bg-hover:#eef2f7; --bg-item-card:#ffffff;
  --text-primary:#1f2937; --text-secondary:#6b7280;
  --accent-blue:#2563eb; --accent-green:#059669; --accent-red:#dc2626; --accent-yellow:#d97706;
  --border-color:#e5e7eb;
  --bg-unread:rgba(217,119,6,0.10); --bg-read:#ffffff; --indicator-unread:#b45309; --border-unread:rgba(217,119,6,0.35);
  --spacing-card-margin:16px; --spacing-card-padding:16px; --spacing-avatar-mr:12px; --spacing-name-mb:4px; --spacing-time-ml:8px;
  --radius-card:12px; --radius-avatar:50%;
  --font-size-name:14px; --font-size-time:12px; --font-size-message:14px; --line-height:20px;
}
/* ===== 必要 flex 工具类 (复刻 Tailwind 子集) ===== */
.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1 1 0%}.min-w-0{min-width:0}
.items-start{align-items:flex-start}.items-center{align-items:center}.mb-1{margin-bottom:4px}.flex-wrap{flex-wrap:wrap}.ml-auto{margin-left:auto}.gap-2{gap:8px}.gap-3{gap:12px}
/* ===== 消息卡片皮肤 ===== */
.msg-card{margin-bottom:var(--spacing-card-margin);padding:var(--spacing-card-padding);background:var(--bg-secondary);border-radius:var(--radius-card);border:1px solid var(--border-color);transition:all .2s ease;position:relative}
.msg-card:hover{border-color:var(--accent-blue);box-shadow:0 4px 16px rgba(0,0,0,.12);transform:translateY(-1px)}
.msg-card .avatar{width:40px;height:40px;border-radius:var(--radius-avatar);display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px;font-weight:600;flex-shrink:0;margin-right:var(--spacing-avatar-mr)}
.msg-card .sender{font-size:var(--font-size-name);color:var(--text-primary);line-height:var(--line-height);font-weight:600}
.msg-card .recipient-arrow{color:var(--indicator-unread);margin:0 4px;font-weight:bold}
.msg-card .recipient-name{font-size:var(--font-size-name);color:var(--indicator-unread);line-height:var(--line-height);font-weight:600;background:var(--bg-unread);padding:2px 8px;border-radius:4px}
.msg-card .timestamp{font-size:var(--font-size-time);margin-left:var(--spacing-time-ml);line-height:var(--line-height)}
.msg-card .message-content{font-size:var(--font-size-message);color:var(--text-secondary);line-height:var(--line-height);margin-top:var(--spacing-name-mb);white-space:pre-wrap;word-break:break-word}
.msg-card .view-count{font-size:10px;color:var(--text-secondary);opacity:.6;text-align:right;margin-top:4px}
.msg-card.unread{background:var(--bg-unread);border:1px solid var(--border-unread);border-left:4px solid var(--indicator-unread)}
.msg-card.unread .sender,.msg-card.unread .message-content{font-weight:600;color:var(--text-primary)}
.msg-card.unread .timestamp{color:var(--indicator-unread);font-weight:500}
.msg-card.read .sender,.msg-card.read .message-content{font-weight:normal}
.msg-card.read .timestamp{color:var(--text-secondary)}
.read-tag{flex-shrink:0;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:14px;cursor:default;border-radius:50%;user-select:none;transition:all .15s ease;margin-left:8px;margin-top:2px;background:var(--bg-primary);border:1px solid var(--border-color);color:var(--accent-green)}
.read-tag.unread-btn{color:var(--indicator-unread);border-color:var(--border-unread)}
.date-separator{text-align:center;font-size:12px;color:var(--text-secondary);margin:16px 0 8px;padding:4px 8px;background:var(--bg-primary);border-radius:12px;display:inline-block;width:100%;box-sizing:border-box}
.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;color:var(--text-secondary)}
/* ===== 页面布局 ===== */
*{box-sizing:border-box}
body{margin:0;background:var(--bg-primary);color:var(--text-primary);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px}
.app{display:flex;flex-direction:column;height:100vh}
.app-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:16px 24px;background:var(--bg-secondary);border-bottom:1px solid var(--border-color)}
.app-header-left{display:flex;align-items:center;gap:12px}
.app-logo{height:56px;width:56px;object-fit:contain;flex-shrink:0}
.app-title-wrap{display:flex;flex-direction:column;line-height:1.2}
.app-title{font-weight:700;font-size:18px;margin:0;color:var(--text-primary)}
.app-subtitle{font-size:12px;color:var(--text-secondary);margin:2px 0 0}
.body{flex:1;display:flex;min-height:0}
.sidebar{width:240px;flex-shrink:0;background:var(--bg-card);border-right:1px solid var(--border-color);display:flex;flex-direction:column}
.sidebar h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-secondary);margin:0;padding:12px 14px 6px}
.member-list{flex:1;overflow-y:auto;padding:4px 8px}
.member-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;margin-bottom:3px}
.member-item:hover{background:var(--bg-hover)}
.member-avatar{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;font-size:14px;flex-shrink:0}
.member-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.member-total{font-size:11px;padding:2px 8px;border-radius:10px;background:color-mix(in srgb,var(--accent-green) 18%,transparent);color:var(--accent-green);font-weight:600;flex-shrink:0}
.main{flex:1;display:flex;flex-direction:column;min-width:0}
.app-header-right{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.app-header-right input,.app-header-right select{background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:6px;padding:6px 10px;font-size:13px;font-family:inherit;outline:none}
.app-header-right input:focus,.app-header-right select:focus{border-color:var(--accent-blue)}
.app-header-right input[type=text]{width:210px;flex:none;min-width:0}
.app-header-right .count{margin-left:4px;font-size:12px;color:var(--text-secondary)}
.msglist{flex:1;overflow-y:auto;padding:16px;background:var(--bg-primary)}
</style>
</head>
<body>
<div class="app">
  <header class="app-header">
    <div class="app-header-left">
      <img src="${logo}" alt="CoordClaw" class="app-logo">
      <div class="app-title-wrap">
        <h1 class="app-title">${h1Text}</h1>
        <p class="app-subtitle"><span id="meta"></span></p>
      </div>
    </div>
    <div class="app-header-right">
      <input type="text" id="f-keyword" placeholder="${keywordPh}">
      <select id="f-sender"><option value="">${senderAll}</option></select>
      <select id="f-recipient"><option value="">${recipientAll}</option></select>
      <select id="f-read">
        <option value="">${statusAll}</option>
        <option value="unread">${unreadOpt}</option>
        <option value="read">${readOpt}</option>
      </select>
      <span class="count" id="f-count"></span>
    </div>
  </header>
  <div class="body">
    <aside class="sidebar">
      <h2>${membersTitle}</h2>
      <div class="member-list" id="member-list"></div>
    </aside>
    <section class="main">
      <div class="msglist" id="msglist"></div>
    </section>
  </div>
</div>
<script>
const DATA = ${dataJson};
const LOCALE = ${JSON.stringify(locale)};
const I18N = ${dictJson};
${CLIENT_JS}
</script>
</body>
</html>`;
}
