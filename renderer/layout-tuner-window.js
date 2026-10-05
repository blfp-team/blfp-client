/* ============================================================================
 * BLFP 布局调试器 —— 独立窗口版（开发用，正式发布版会被剔除）
 *
 * 与旧版的区别：
 *   旧版是主窗口里的浮层面板，只能改"当前看得见"的东西 ——
 *   弹窗（公告、更新、各种 modal）默认带 .hidden，根本选不到，
 *   所以公告界面之类没法调。
 *
 *   现在调试器跑在**独立窗口**里，主窗口只留一个负责"应用样式"的代理，
 *   两者用 IPC 通信。于是：
 *     - 主窗口可以随便切页面/开关弹窗，调试器始终在旁边可见可操作；
 *     - 调试器自己的样式不会污染被测界面；
 *     - 能列出**所有界面**（含隐藏的弹窗），选中时让主窗口临时把它显示出来；
 *     - 元素列表由主窗口遍历 DOM 回报，隐藏界面里的部件同样能选中。
 *
 * 通信约定（见 main.js / preload.js）：
 *   调试器 → 主窗口：window.mclink.tunerToMain(channel, payload)
 *   主窗口 → 调试器：window.mclink.onTunerData(({channel, payload}) => ...)
 *                   channel: ready / screens / elements / selected / styles /
 *                            overrides / picked
 * ========================================================================= */
(function () {
  'use strict';

  var SHARED = window.LT_SHARED || {
    GROUPS: [], MANAGED: [], SCREENS: [], discoverScreens: function () { return []; }
  };
  var bridge = window.mclink || window.electronAPI || null;

  var screens = SHARED.SCREENS.slice();
  var currentScreen = null;
  var currentEl = null;         // 当前选中的元素（选择器字符串）
  var elements = [];            // 主窗口回报的当前界面部件列表
  var allOverrides = {};        // 主窗口回报的全量覆盖
  var elFilter = '';
  var propFilter = '';
  var state = {};               // 选中元素的当前覆盖值

  function $(id) { return document.getElementById(id); }

  function setStatus(text, cls) {
    var el = $('ltw-status');
    if (!el) return;
    el.textContent = text;
    el.className = cls || '';
  }

  /* 独立窗口必须能连上主窗口，否则什么都做不了 —— 明确提示而不是静默 */
  if (!bridge || typeof bridge.tunerToMain !== 'function') {
    setStatus('未连接到主窗口，请在 BLFP 应用里按 Ctrl+Shift+D 打开', 'bad');
    return;
  }

  function send(channel, payload) {
    try { return bridge.tunerToMain(channel, payload); } catch (e) { return null; }
  }

  /* ---------- 界面下拉 ---------- */
  function renderScreens(list) {
    var sel = $('ltw-screen');
    if (!sel) return;
    var keep = sel.value;
    sel.innerHTML = '';
    list.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.sel;
      o.textContent = s.name + (s.modal ? ' 弹窗' : '');
      o.dataset.name = s.name;
      o.dataset.modal = s.modal ? '1' : '';
      sel.appendChild(o);
    });
    /* 尽量保持当前选择，其次默认登录页（最常调） */
    var want = keep || (list.find(function (s) { return s.sel === '#auth-page'; }) || {}).sel;
    if (want) sel.value = want;
    onScreenChange();
  }

  function onScreenChange() {
    var sel = $('ltw-screen');
    var opt = sel && sel.options[sel.selectedIndex];
    if (!opt) return;
    currentScreen = { sel: opt.value, name: opt.dataset.name, modal: opt.dataset.modal === '1' };
    currentEl = null;
    $('ltw-screen-name').textContent = currentScreen.name;
    $('ltw-sel-name').textContent = '未选中';
    $('ltw-groups').innerHTML = '';
    $('ltw-css').value = '';
    /* 告诉主窗口：切到哪个界面了；如果勾了"临时显示"，顺便把它显示出来 */
    send('select-screen', {
      sel: currentScreen.sel,
      name: currentScreen.name,
      modal: currentScreen.modal,
      reveal: $('ltw-reveal').checked
    });
  }

  /* ---------- 部件列表 ---------- */
  function renderElements() {
    var box = $('ltw-el-list');
    if (!box) return;
    var kw = elFilter.trim().toLowerCase();
    var list = elements.filter(function (e) {
      if (!kw) return true;
      return (e.name + ' ' + e.sel).toLowerCase().indexOf(kw) >= 0;
    });
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div class="ltw-empty">这个界面下没找到可调部件</div>';
      return;
    }
    list.forEach(function (e) {
      var row = document.createElement('div');
      row.className = 'ltw-item' + (e.sel === currentEl ? ' on' : '');
      var nm = document.createElement('span');
      nm.textContent = e.name;
      var tag = document.createElement('span');
      tag.className = 'ltw-tag';
      tag.textContent = e.sel;
      row.appendChild(nm);
      row.appendChild(tag);
      row.onclick = function () { selectElement(e.sel); };
      box.appendChild(row);
    });
  }

  function selectElement(sel) {
    currentEl = sel;
    send('select-element', { sel: sel });
    renderElements();
    $('ltw-sel-name').textContent = sel;
    renderGroups();
    renderCssBox();
  }

  /* ---------- 属性控件 ---------- */
  function renderGroups() {
    var box = $('ltw-groups');
    if (!box) return;
    box.innerHTML = '';
    if (!currentEl) { box.innerHTML = '<div class="ltw-empty">先选一个部件</div>'; return; }
    var kw = propFilter.trim().toLowerCase();

    SHARED.GROUPS.forEach(function (g) {
      var props = g.props.filter(function (p) {
        if (!kw) return true;
        return (p.label + ' ' + p.k).toLowerCase().indexOf(kw) >= 0;
      });
      if (!props.length) return;
      var grp = document.createElement('div');
      grp.className = 'ltw-grp';
      var gn = document.createElement('div');
      gn.className = 'ltw-grp-name';
      gn.textContent = g.name;
      grp.appendChild(gn);
      props.forEach(function (p) { grp.appendChild(makeRow(p)); });
      box.appendChild(grp);
    });
    if (!box.children.length) box.innerHTML = '<div class="ltw-empty">没有匹配的属性</div>';
  }

  function rawVal(p) {
    var ov = state || {};
    if (p.virt) return ov[p.k] === undefined ? p.def : ov[p.k];
    return (ov.styles && ov.styles[p.k] !== undefined) ? ov.styles[p.k] : '';
  }

  function setVal(p, value) {
    if (p.virt) {
      if (value === '' || value === null) delete state[p.k];
      else state[p.k] = Number(value);
    } else {
      state.styles = state.styles || {};
      if (value === '' || value === null) delete state.styles[p.k];
      else state.styles[p.k] = value;
    }
    send('set-style', { sel: currentEl, patch: buildPatch(p, value) });
    renderCssBox();
  }

  /* 只把**这一个属性**的变化发给主窗口，由主窗口合并。
     整份 state 覆盖会导致多个控件互相覆盖。 */
  function buildPatch(p, value) {
    var patch = { virt: {}, styles: {} };
    var v = (value === '' || value === null) ? null : value;
    if (p.virt) patch.virt[p.k] = (v === null ? null : Number(v));
    else patch.styles[p.k] = v;
    return patch;
  }

  function makeRow(p) {
    var row = document.createElement('div');
    row.className = 'ltw-prop';
    var lab = document.createElement('label');
    lab.textContent = p.label;
    row.appendChild(lab);

    var cur = rawVal(p);

    if (p.type === 'range') {
      var r = document.createElement('input');
      r.type = 'range';
      r.min = p.min; r.max = p.max; r.step = p.step;
      r.value = (cur === '' || cur === undefined) ? (p.virt ? p.def : p.min) : cur;
      var val = document.createElement('span');
      val.className = 'ltw-val';
      val.textContent = r.value + (p.unit || '');
      r.oninput = function () {
        val.textContent = r.value + (p.unit || '');
        setVal(p, r.value);
      };
      row.appendChild(r);
      row.appendChild(val);
    } else if (p.type === 'select') {
      var s = document.createElement('select');
      p.opts.forEach(function (o) {
        var op = document.createElement('option');
        op.value = o; op.textContent = o === '' ? '默认' : o;
        s.appendChild(op);
      });
      s.value = cur || '';
      s.onchange = function () { setVal(p, s.value); };
      row.appendChild(s);
    } else if (p.type === 'color') {
      var c = document.createElement('input');
      c.type = 'color';
      c.value = toHex(cur) || '#000000';
      c.oninput = function () { setVal(p, c.value); };
      row.appendChild(c);
      var txt = document.createElement('input');
      txt.type = 'text';
      txt.value = cur || '';
      txt.placeholder = 'auto / #rrggbb / rgba(...)';
      txt.onchange = function () { setVal(p, txt.value.trim()); };
      row.appendChild(txt);
    } else {
      var t = document.createElement('input');
      t.type = 'text';
      t.value = cur || '';
      t.placeholder = p.ph || '';
      t.onchange = function () { setVal(p, t.value.trim()); };
      row.appendChild(t);
    }

    /* 清除按钮：把这个属性还原成"没设过" */
    var clr = document.createElement('button');
    clr.className = 'ltw-clr';
    clr.textContent = '×';
    clr.title = '清除此属性';
    clr.onclick = function () { setVal(p, null); renderGroups(); };
    row.appendChild(clr);
    return row;
  }

  function toHex(v) {
    if (!v) return '';
    v = String(v).trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
    if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    var m = v.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (m) {
      var h = function (n) { return ('0' + Number(n).toString(16)).slice(-2); };
      return '#' + h(m[1]) + h(m[2]) + h(m[3]);
    }
    return '';
  }

  /* ---------- 自由 CSS ---------- */
  function serializeStyles(st) {
    if (!st) return '';
    return Object.keys(st).map(function (k) { return k + ': ' + st[k] + ';'; }).join('\n');
  }
  function renderCssBox() {
    var box = $('ltw-css');
    if (box) box.value = serializeStyles(state.styles);
  }

  var cssBox = $('ltw-css');
  if (cssBox) cssBox.onchange = function () {
    if (!currentEl) return;
    var decls = {};
    cssBox.value.split('\n').forEach(function (line) {
      var i = line.indexOf(':');
      if (i <= 0) return;
      var k = line.slice(0, i).trim();
      var v = line.slice(i + 1).trim().replace(/;$/, '');
      if (k && v) decls[k] = v;
    });
    state.styles = decls;
    send('set-all-styles', { sel: currentEl, styles: decls });
    renderGroups();
  };

  /* ---------- 导出 ---------- */
  function buildExport() {
    var out = {};
    if (currentScreen) out.screen = { name: currentScreen.name, selector: currentScreen.sel };
    out.selected = currentEl || null;
    out.overrides = {};
    Object.keys(allOverrides).forEach(function (sel) {
      var o = allOverrides[sel] || {};
      var props = [];
      if (o.dx || o.dy) props.push('translate: ' + (o.dx || 0) + 'px ' + (o.dy || 0) + 'px;');
      if (o.scale !== undefined && o.scale !== 1) props.push('/* scale: ' + o.scale + ' */');
      if (o.rotate) props.push('/* rotate: ' + o.rotate + 'deg */');
      Object.keys(o.styles || {}).forEach(function (k) { props.push(k + ': ' + o.styles[k] + ';'); });
      if (props.length) out.overrides[sel] = props;
    });
    return JSON.stringify(out, null, 2);
  }

  function runExport() {
    var o = $('ltw-out');
    if (o) o.value = buildExport();
    return o ? o.value : '';
  }

  var bExp = $('ltw-export'); if (bExp) bExp.onclick = runExport;
  var bCopy = $('ltw-copy');
  if (bCopy) bCopy.onclick = function () {
    var text = ($('ltw-out').value || runExport());
    $('ltw-out').select();
    try { document.execCommand('copy'); } catch (e) {}
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {});
    setStatus('已复制到剪贴板', 'ok');
  };
  var bSave = $('ltw-save');
  if (bSave) bSave.onclick = function () {
    var blob = new Blob([$('ltw-out').value || runExport()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'blfp-layout-' + Date.now() + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  };

  /* ---------- 其它按钮 ---------- */
  var elScreen = $('ltw-screen');
  if (elScreen) elScreen.onchange = onScreenChange;
  var elReveal = $('ltw-reveal');
  if (elReveal) elReveal.onchange = function () {
    send('set-reveal', { reveal: elReveal.checked, sel: currentScreen && currentScreen.sel });
  };
  var bPick = $('ltw-pick');
  if (bPick) bPick.onclick = function () { send('start-pick', {}); setStatus('请到主窗口点击要调的部件…'); };
  var bShow = $('ltw-show-screen');
  if (bShow) bShow.onclick = function () {
    if (currentScreen) send('reveal-screen', { sel: currentScreen.sel, modal: currentScreen.modal });
  };
  var fEl = $('ltw-filter-el');
  if (fEl) fEl.oninput = function (e) { elFilter = e.target.value; renderElements(); };
  var fProp = $('ltw-filter-prop');
  if (fProp) fProp.oninput = function (e) { propFilter = e.target.value; renderGroups(); };
  var bResetEl = $('ltw-reset-el');
  if (bResetEl) bResetEl.onclick = function () {
    if (!currentEl) return;
    send('reset-element', { sel: currentEl });
    state = {};
    renderGroups(); renderCssBox();
  };
  var bResetAll = $('ltw-reset-all');
  if (bResetAll) bResetAll.onclick = function () {
    send('reset-all', {});
    state = {}; allOverrides = {};
    renderGroups(); renderCssBox();
    setStatus('已全部重置', 'ok');
  };
  var bDetach = $('ltw-detach');
  if (bDetach) bDetach.onclick = function () {
    send('request-state', {});
    setStatus('正在重新同步…');
  };

  /* ---------- 接收主窗口回报 ---------- */
  if (typeof bridge.onTunerData === 'function') {
    bridge.onTunerData(function (msg) {
      if (!msg || !msg.channel) return;
      var p = msg.payload || {};
      switch (msg.channel) {
        case 'ready':
          setStatus('已连接 · ' + (p.version || ''), 'ok');
          if (p.screens && p.screens.length) { screens = p.screens; renderScreens(screens); }
          break;
        case 'screens':
          if (p.screens && p.screens.length) { screens = p.screens; renderScreens(screens); }
          break;
        case 'elements':
          elements = p.elements || [];
          renderElements();
          break;
        case 'selected':
          currentEl = p.sel || null;
          state = p.state || {};
          $('ltw-sel-name').textContent = currentEl || '未选中';
          renderElements(); renderGroups(); renderCssBox();
          break;
        case 'styles':
          state = p.state || {};
          renderGroups(); renderCssBox();
          break;
        case 'overrides':
          allOverrides = p.overrides || {};
          break;
        case 'picked':
          elements = p.elements || elements;
          if (p.sel) selectElement(p.sel);
          else renderElements();
          setStatus('已选中：' + (p.sel || '没选到元素'), p.sel ? 'ok' : '');
          break;
        default:
          break;
      }
    });
  }

  /* 窗口自己也要能触发一次同步（重连按钮之外的兜底） */
  setTimeout(function () { send('request-state', {}); }, 120);
})();
