/**
 * install.js — CoordClaw 安装向导
 */

var I18N = {
  zh: {
    subtitle: '检测到未安装。请完成以下步骤以启用 CoordClaw 协作系统。',
    langTitle: '选择语言 / Language',
    langDesc: '这将决定默认团队模板和界面语言。',
    platTitle: '选择要安装的平台',
    platDesc: '在用户目录下检测到以下 OpenClaw 实例。勾选需要安装 CoordClaw 的平台。',
    scanning: '正在扫描...',
    scanFail: '扫描失败，请检查服务状态',
    noPlatform: '未检测到 OpenClaw 实例。请确认已安装 OpenClaw 或其变体。',
    installed: '已安装',
    notInstalled: '未安装',
    installing: '安装中...',
    doneTitle: '安装完成',
    doneSummary: function (d) { var s = ''; if (d.installed.length) s += '已在 ' + d.installed.length + ' 个平台安装。'; if (d.skipped.length) s += ' ' + d.skipped.length + ' 个平台已存在配置，已跳过。'; return s; },
    doneInstalled: '已注册插件 + 技能 + 创建配置',
    doneSkipped: '已跳过（配置已存在）',
    doneHint: '请确保 OpenClaw（或变体）已启动，然后点击下方按钮进入控制面板。',
    doneRestart: '⚠️ 务必重启 OpenClaw（或变体）后再进入，否则可能无法进入 CoordClaw 团队协调控制中心面板。',
    enterBtn: '进入 CoordClaw',
    back: '上一步',
    next: '下一步',
    install: '安装',
    logoSub: ' 多智能体协作系统',
    hook: '真·一人公司 AI 团队',
  },
  en: {
    subtitle: 'Installation required. Complete the steps below to enable CoordClaw.',
    langTitle: 'Select Language',
    langDesc: 'This determines the default team template and interface language.',
    platTitle: 'Select Platforms to Install',
    platDesc: 'The following OpenClaw instances were detected in your home directory. Check the platforms where you want to install CoordClaw.',
    scanning: 'Scanning...',
    scanFail: 'Scan failed. Please check the service status.',
    noPlatform: 'No OpenClaw instances detected. Please install OpenClaw or a variant first.',
    installed: 'Installed',
    notInstalled: 'Not Installed',
    installing: 'Installing...',
    doneTitle: 'Installation Complete',
    doneSummary: function (d) { var s = ''; if (d.installed.length) s += 'Installed on ' + d.installed.length + ' platform(s). '; if (d.skipped.length) s += d.skipped.length + ' platform(s) skipped (config already exists).'; return s; },
    doneInstalled: 'Plugin + skills registered + config created',
    doneSkipped: 'Skipped (config already exists)',
    doneHint: 'Please ensure OpenClaw (or variant) is running, then click the button below to enter the control panel.',
    doneRestart: '⚠️ You MUST restart OpenClaw (or variant) before entering, otherwise you may be unable to access the CoordClaw Team Coordination Control Center.',
    enterBtn: 'Enter CoordClaw',
    back: 'Back',
    next: 'Next',
    install: 'Install',
    logoSub: ' Multi-Agent Collaboration System',
    hook: 'A True One-Person AI Company',
  }
};

var _lang = '';
var _platforms = [];
var _selectedPlatforms = {};

function T(key) {
  var t = (I18N[_lang] || I18N.zh)[key];
  if (typeof t === 'function') return t.apply(null, Array.prototype.slice.call(arguments, 1));
  return t || key;
}

function selectLang(l) {
  _lang = l;
  document.getElementById('subtitle').textContent = T('subtitle');
  document.getElementById('logo-sub').textContent = T('logoSub');
  document.getElementById('hook').textContent = T('hook');
  document.getElementById('lang-title').textContent = T('langTitle');
  document.getElementById('lang-desc').textContent = T('langDesc');
  document.getElementById('plat-title').textContent = T('platTitle');
  document.getElementById('plat-desc').textContent = T('platDesc');
  document.getElementById('done-title').textContent = T('doneTitle');
  document.getElementById('done-restart').textContent = T('doneRestart');
  document.getElementById('done-hint').textContent = T('doneHint');
  document.querySelectorAll('.lang-btn').forEach(function (b) { b.classList.remove('selected'); });
  document.getElementById('lang-' + l).classList.add('selected');
  document.getElementById('btn-next-lang').disabled = false;
  setBtnLabels();
  PhiloCycle.start(_lang);
}

function setBtnLabels() {
  document.querySelectorAll('[data-zh]').forEach(function (el) {
    el.textContent = _lang === 'en' ? el.dataset.en : el.dataset.zh;
  });
}

function toStep(n) {
  document.querySelectorAll('.card').forEach(function (c) { c.classList.add('hidden'); });
  document.querySelectorAll('.step').forEach(function (s) { s.classList.remove('active', 'done'); });
  for (var i = 1; i <= 3; i++) {
    if (i < n) document.getElementById('s' + i).classList.add('done');
    if (i === n) document.getElementById('s' + i).classList.add('active');
  }
  if (n === 1) document.getElementById('step-lang').classList.remove('hidden');
  if (n === 2) { document.getElementById('step-platforms').classList.remove('hidden'); scanPlatforms(); }
  if (n === 3) document.getElementById('step-done').classList.remove('hidden');
}

async function scanPlatforms() {
  var list = document.getElementById('platform-list');
  list.innerHTML = '<div class="scanning"><div class="dot"></div><div class="dot"></div><div class="dot"></div>' + T('scanning') + '</div>';
  try {
    var r = await fetch('/api/install/scan');
    if (!r.ok) { list.innerHTML = '<div style="color:var(--red);font-size:13px">' + T('scanFail') + '</div>'; return; }
    var d = await r.json();
    _platforms = d.platforms || []; _selectedPlatforms = {}; renderPlatforms();
  } catch (e) { list.innerHTML = '<div style="color:var(--red);font-size:13px">' + T('scanFail') + '</div>'; }
}

function renderPlatforms() {
  var list = document.getElementById('platform-list');
  if (_platforms.length === 0) { list.innerHTML = '<div style="color:var(--warn);font-size:13px">' + T('noPlatform') + '</div>'; return; }
  var hasInstalled = _platforms.some(function(p) { return p.hasPlugin; });
  document.getElementById('btn-enter').style.display = hasInstalled ? '' : 'none';
  list.innerHTML = _platforms.map(function (p) {
    var sel = _selectedPlatforms[p.dir];
    var badge = p.hasPlugin ? '<span class="platform-badge installed">' + T('installed') + '</span>' : '<span class="platform-badge new">' + T('notInstalled') + '</span>';
    return '<div class="platform-item' + (sel ? ' selected' : '') + '" data-dir="' + p.dir + '" onclick="togglePlatform(\'' + p.dir + '\')"><div class="platform-check"></div><span class="platform-name">' + p.name + '</span>' + badge + '</div>';
  }).join('');
  updateInstallBtn();
}

function togglePlatform(dir) {
  if (_selectedPlatforms[dir]) delete _selectedPlatforms[dir]; else _selectedPlatforms[dir] = true;
  renderPlatforms();
}

function updateInstallBtn() { document.getElementById('btn-install').disabled = Object.keys(_selectedPlatforms).length === 0; }

async function doInstall() {
  var btn = document.getElementById('btn-install'), status = document.getElementById('install-status');
  btn.disabled = true; btn.textContent = T('installing'); status.className = 'status-msg'; status.style.display = 'none';
  try {
    var r = await fetch('/api/install/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: _lang, platforms: Object.keys(_selectedPlatforms) }) });
    var d = await r.json();
    if (d.error) { status.className = 'status-msg error show'; status.textContent = d.error; btn.disabled = false; btn.textContent = _lang === 'en' ? 'Install' : '安装'; return; }
    document.getElementById('s2').classList.add('done'); document.getElementById('s3').classList.add('active');
    document.getElementById('step-platforms').classList.add('hidden');
    document.getElementById('done-summary').textContent = T('doneSummary', d);
    document.getElementById('done-list').innerHTML =
      d.installed.map(function (p) { return '<div class="done-item"><span class="icon">✓</span>' + p + ' — ' + T('doneInstalled') + '</div>'; }).join('') +
      d.skipped.map(function (p) { return '<div class="done-item"><span class="icon" style="color:var(--warn)">−</span>' + p + ' — ' + T('doneSkipped') + '</div>'; }).join('') +
      d.errors.map(function (p) { return '<div class="done-item"><span class="icon" style="color:var(--red)">✗</span>' + p + '</div>'; }).join('');
    document.getElementById('step-done').classList.remove('hidden');
  } catch (e) { status.className = 'status-msg error show'; status.textContent = (_lang === 'en' ? 'Install failed: ' : '安装失败: ') + e.message; btn.disabled = false; btn.textContent = _lang === 'en' ? 'Install' : '安装'; }
}

var SmokeBg = (function () {
  function init() {
    var c = document.getElementById('bg-canvas'), ctx = c.getContext('2d');
    var W, H, blocks = [], t = 0;

    function resize() {
      W = c.width = window.innerWidth; H = c.height = window.innerHeight;
      blocks = [];
      var y = 0;
      while (y < H) {
        var x = 0;
        var rh = (60 + Math.floor(Math.random() * 180));
        if (y + rh > H) rh = H - y;
        while (x < W) {
          var rw = (80 + Math.floor(Math.random() * 250));
          if (x + rw > W) rw = W - x;
          blocks.push({ x: x, y: y, w: rw, h: rh, hue: Math.random() * 360, ds: Math.random() * .5 + .3, dl: Math.random() * .3 + .1 });
          x += rw;
        }
        y += rh;
      }
    }
    resize(); window.addEventListener('resize', resize);

    function draw() {
      t += .001;
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        b.hue = (b.hue + b.ds) % 360;
        var sat = 40 + Math.sin(t * .3 + i) * 20;
        var light = 6 + Math.cos(t * b.dl + i * .7) * 4;
        ctx.fillStyle = 'hsl(' + Math.floor(b.hue) + ',' + Math.floor(sat) + '%,' + Math.floor(light) + '%)';
        ctx.fillRect(b.x, b.y, b.w, b.h);
      }
      requestAnimationFrame(draw);
    }
    draw();
  }
  return { init: init };
})();

var PhiloCycle = (function () {
  var list = {
    zh: ['概率输出是智能的本质属性', '差异是协作的必要条件', '消息交换是管理差异的唯一方式', '协调是分布式注意力的聚合机制', '冲突是跳出概率进入事实的唯一路径', '可管理的前提是接受不确定', '协作的本质是信息交换', '不是让1+1>2，是让1不变成0', '协作保下限，不争上限', '上下文重置防止污染癌症传染', '结构化文档是项目的分布式记忆'],
    en: ['Probability is the essence of intelligence', 'Difference is the fuel of collaboration', 'Message exchange is the only way to manage difference', 'Coordination is the aggregation of distributed attention', 'Conflict exits probability, enters fact', 'Accepting uncertainty is the prerequisite of manageability', 'Collaboration is fundamentally information exchange', 'Not 1+1>2, but prevent 1 from becoming 0', 'Collaboration guarantees the floor, not the ceiling', 'Context reset prevents toxic contamination', 'Structured documents are the distributed memory of the project']
  };
  var idx = 0, timer = null;

  function start(lang) {
    var items = list[lang || 'zh']; idx = 0;
    var el = document.getElementById('philo');
    clearInterval(timer);
    function cycle() {
      el.classList.remove('visible');
      setTimeout(function () { el.textContent = items[idx]; el.classList.add('visible'); idx = (idx + 1) % items.length; }, 800);
    }
    cycle(); timer = setInterval(cycle, 6000);
  }
  return { start: start };
})();

SmokeBg.init();
setBtnLabels();
// 首装无 coordclaw.json：按时区/语言默认预选语言，外国用户直接见英文页（按钮高亮、下一步可用）
selectLang((window.LangDetect && window.LangDetect.detectDefaultLang()) || 'zh');

function enterCoordClaw() {
  fetch('/api/install/complete', { method: 'POST' }).then(function(r) {
    if (r.ok) return r.json();
    throw new Error();
  }).then(function(d) {
    if (d.success) location.href = '/';
    else alert(T('enterBtn') + ': ' + (d.message || ''));
  }).catch(function() {
    alert('进入请求失败，请重试');
  });
}
