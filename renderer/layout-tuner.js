/* ============================================================================
 * BLFP 布局调试器 —— 主窗口代理（开发用，正式发布版会被剔除）
 * 见 .github/workflows/release.yml 的 "Strip dev-only files" 步骤
 *
 * 这个文件跑在**主窗口**里，只负责两件事：
 *   1. 把样式覆盖应用到页面元素上（真正的渲染效果由它产生）；
 *   2. 把"当前有哪些界面/部件""选中了什么"通过 IPC 上报给独立调试器窗口，
 *      并接收调试器窗口下发的修改指令。
 *
 * 界面本身在 layout-tuner-window.html（独立窗口）里，
 * 属性分组等共享定义在 layout-tuner-shared.js。
 *
 * 为什么改成独立窗口：
 *   旧版是主窗口里的浮层面板，只能调"当前看得见"的元素 ——
 *   公告/更新等弹窗默认带 .hidden（display:none !important），
 *   既看不到也选不中，所以公告界面之类根本没法调。
 *   现在调试器能列出所有界面（含隐藏弹窗），选中时临时把目标界面显示出来，
 *   于是**所有界面都能调**。
 *
 * 快捷键：
 *   Ctrl+Shift+D   打开/关闭独立调试器窗口
 *   Alt+拖动       在主窗口直接移动部件
 *   方向键         微调 1px（Shift = 10px）
 *   Esc            退出拾取/拖动模式
 * ========================================================================= */
(function () {
  'use strict';

  var KEY = 'blfp_layout_tuner';
  var SHARED = window.LT_SHARED || { MANAGED: [], GROUPS: [], SCREENS: [], discoverScreens: function () { return []; } };
  var MANAGED = SHARED.MANAGED;

  var overrides = {};        // selector -> { dx, dy, scale, rotate, styles:{} }
  var selected = null;
  var picking = false, dragMode = false;
  var bridge = window.mclink || window.electronAPI || null;
  var currentScreenSel = '#auth-page';

  /* 临时显示出来的界面（选中隐藏弹窗时），关掉调试器要还原回去 */
  var revealed = [];         // [{ el, hadHidden, prevDisplay }]

  function $(id) { return document.getElementById(id); }

  /* ---------- 存取 ---------- */
  function load() {
    try { overrides = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
    catch (e) { overrides = {}; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(overrides)); } catch (e) {}
  }
  function getOv(sel, create) {
    if (!overrides[sel] && create) overrides[sel] = { styles: {} };
    var ov = overrides[sel];
    if (ov && !ov.styles) ov.styles = {};
    return ov || null;
  }
  function isDirty(ov) {
    if (!ov) return false;
    if (ov.dx || ov.dy || ov.rotate) return true;
    if (ov.scale !== undefined && ov.scale !== 1) return true;
    return Object.keys(ov.styles || {}).some(function (k) { return ov.styles[k]; });
  }

  /* ---------- 选择器 ---------- */
  function stepFor(node) {
    var tag = node.tagName.toLowerCase();
    var parent = node.parentElement;
    if (!parent) return tag;
    var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
    if (same.length <= 1) return tag;
    return tag + ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
  }
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    var parts = [];
    var node = el;
    /* 一直向上走到带 id 的祖先或 body 为止；不能按层数截断，
       截断后最左段会匹配到别的元素。 */
    while (node && node.nodeType === 1) {
      if (node.id) { parts.unshift('#' + node.id); break; }
      parts.unshift(stepFor(node));
      var parent = node.parentElement;
      if (!parent || parent === document.documentElement) break;
      node = parent;
    }
    return parts.join(' > ');
  }
  function elFor(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }

  /* ---------- 应用 ---------- */
  function applyTo(el, ov) {
    if (!el) return;
    for (var i = 0; i < MANAGED.length; i++) el.style.removeProperty(MANAGED[i]);
    if (!ov) return;
    var dx = ov.dx || 0, dy = ov.dy || 0;
    if (dx || dy) el.style.translate = dx + 'px ' + dy + 'px';
    var t = [];
    if (ov.scale && ov.scale !== 1) t.push('scale(' + ov.scale + ')');
    if (ov.rotate) t.push('rotate(' + ov.rotate + 'deg)');
    if (t.length) el.style.transform = t.join(' ');
    var s = ov.styles || {};
    Object.keys(s).forEach(function (k) {
      var v = s[k];
      if (v === '' || v == null) return;
      try { el.style.setProperty(k, String(v)); } catch (e) {}
    });
  }
  function applyAll() {
    Object.keys(overrides).forEach(function (sel) { applyTo(elFor(sel), overrides[sel]); });
  }

  /* ---------- 隐藏界面的临时显示 ----------
     弹窗默认带 .hidden，不显示出来就既看不到效果也没法参与布局。
     这里按住原状态临时揭开，关掉调试器时原样还原，
     避免用户以为"软件自己弹了个公告"。 */
  function revealScreen(sel) {
    var el = elFor(sel);
    if (!el) return false;
    var wasHidden = el.classList.contains('hidden');
    el.classList.remove('hidden');
    if (wasHidden) {
      var rec = revealed.find(function (r) { return r.el === el; });
      if (!rec) revealed.push({ el: el, hadHidden: true, prevDisplay: el.style.display });
    }
    return true;
  }
  function restoreRevealed() {
    revealed.forEach(function (r) {
      try {
        if (r.hadHidden) r.el.classList.add('hidden');
        r.el.style.display = r.prevDisplay || '';
      } catch (e) {}
    });
    revealed = [];
  }

  /* ---------- 部件发现 ----------
     遍历指定界面下所有"看起来可调"的元素，含隐藏界面里的部件，
     所以公告弹窗里那些标题/正文/按钮都能单独选中。 */
  var SKIP_IDS = { 'lt-panel': 1, 'lt-hl': 1, 'lt-badge': 1 };
  var SKIP_CLASS = /(^|\s)(lt-hl|lt-badge|lt-panel)(\s|$)/;

  function describe(el) {
    var text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 22);
    var id = el.id ? '#' + el.id : '';
    var cls = (typeof el.className === 'string' && el.className)
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    var tag = el.tagName.toLowerCase();
    return text ? (tag + ' 「' + text + '」') : (tag + id + cls);
  }

  function collectElements(screenSel) {
    var root = screenSel ? elFor(screenSel) : document.body;
    if (!root) return [];
    var out = [];
    var seen = {};
    var selfSel = selectorFor(root);
    if (selfSel) {
      seen[selfSel] = 1;
      out.push({ sel: selfSel, name: describe(root) + ' 整个界面', tag: root.tagName.toLowerCase() });
    }
    function walk(el, depth) {
      if (!el || el.nodeType !== 1 || depth > 6 || out.length > 400) return;
      if (SKIP_IDS[el.id]) return;
      if (el.className && SKIP_CLASS.test(el.className)) return;
      var sel = selectorFor(el);
      if (!sel || seen[sel]) return;
      seen[sel] = 1;
      out.push({ sel: sel, name: describe(el), tag: el.tagName.toLowerCase() });
      Array.prototype.forEach.call(el.children || [], function (c) { walk(c, depth + 1); });
    }
    Array.prototype.forEach.call(root.children || [], function (c) { walk(c, 0); });
    return out;
  }

  /* ---------- 与调试器窗口通信 ---------- */
  function push(channel, payload) {
    if (!bridge || typeof bridge.toTuner !== 'function') return;
    try { bridge.toTuner(channel, payload); } catch (e) {}
  }
  function pushElements() { push('elements', { elements: collectElements(currentScreenSel) }); }
  function pushScreens() {
    var list = SHARED.discoverScreens(document);
    push('screens', { screens: list });
    return list;
  }
  function pushSelected() {
    var sel = selected ? selectorFor(selected) : null;
    push('selected', { sel: sel, state: sel ? (getOv(sel, false) || {}) : {} });
  }
  function pushOverrides() { push('overrides', { overrides: overrides }); }

  function openTunerWindow() {
    if (!bridge || typeof bridge.tunerOpen !== 'function') {
      try { console.warn('[布局调试器] 当前环境不支持独立窗口，需要 Electron 运行'); } catch (e) {}
      return;
    }
    bridge.tunerOpen().then(function () {
      /* 窗口建好后把初始状态推过去 */
      setTimeout(function () {
        pushScreens(); pushElements(); pushOverrides();
        push('ready', { version: window.__BLFP_VERSION || '' });
      }, 260);
    }).catch(function (e) { try { console.warn('[布局调试器] 打开独立窗口失败：', e); } catch (err) {} });
  }
  function closeTunerWindow() {
    if (bridge && typeof bridge.tunerClose === 'function') {
      try { bridge.tunerClose().catch(function () {}); } catch (e) {}
    }
    restoreRevealed();
  }

  /* ---------- 接收调试器窗口指令 ---------- */
  function bindBridge() {
    if (!bridge || typeof bridge.onTunerCmd !== 'function') return;
    bridge.onTunerCmd(function (msg) {
      if (!msg || !msg.channel) return;
      var p = msg.payload || {};
      switch (msg.channel) {
        case 'request-state':
          pushScreens(); pushElements(); pushOverrides(); pushSelected();
          break;
        case 'select-screen':
          currentScreenSel = p.sel || currentScreenSel;
          /* 勾了"临时显示"就揭开 .hidden，方便直接看到效果 */
          if (p.reveal) { restoreRevealed(); revealScreen(currentScreenSel); }
          else restoreRevealed();
          pushElements();
          break;
        case 'reveal-screen':
          revealScreen(p.sel || currentScreenSel);
          pushElements();
          break;
        case 'set-reveal':
          if (p.reveal) revealScreen(p.sel || currentScreenSel);
          else restoreRevealed();
          pushElements();
          break;
        case 'select-element':
          selected = elFor(p.sel);
          if (selected) { applyTo(selected, getOv(p.sel, false)); highlightAt(selected); }
          pushSelected();
          break;
        case 'set-style': {
          var ov = getOv(p.sel, true);
          var patch = p.patch || {};
          Object.keys(patch.virt || {}).forEach(function (k) {
            if (patch.virt[k] === null) delete ov[k]; else ov[k] = patch.virt[k];
          });
          Object.keys(patch.styles || {}).forEach(function (k) {
            if (patch.styles[k] === null) delete ov.styles[k]; else ov.styles[k] = patch.styles[k];
          });
          applyTo(elFor(p.sel), ov);
          if (!isDirty(ov)) delete overrides[p.sel];
          save(); pushOverrides(); pushSelected();
          break;
        }
        case 'set-all-styles': {
          var ov2 = getOv(p.sel, true);
          ov2.styles = p.styles || {};
          applyTo(elFor(p.sel), ov2);
          if (!isDirty(ov2)) delete overrides[p.sel];
          save(); pushOverrides(); pushSelected();
          break;
        }
        case 'reset-element':
          delete overrides[p.sel];
          applyTo(elFor(p.sel), null);
          save(); pushOverrides(); pushSelected(); pushElements();
          break;
        case 'reset-all':
          Object.keys(overrides).forEach(function (s) { applyTo(elFor(s), null); });
          overrides = {};
          save(); pushOverrides(); pushSelected(); pushElements();
          break;
        case 'start-pick':
          setPicking(true);
          break;
        default:
          break;
      }
    });
    if (typeof bridge.onTunerWindowClosed === 'function') {
      bridge.onTunerWindowClosed(function () {
        /* 调试器关了：退出拾取/拖动，还原被临时揭开的界面 */
        setPicking(false);
        setDragMode(false);
        hideHl();
        restoreRevealed();
      });
    }
  }

  /* ---------- 高亮 ---------- */
  var hl = null, badge = null;
  function ensureHl() {
    if (hl && badge) return;
    if (!hl) { hl = document.createElement('div'); hl.id = 'lt-hl'; document.body.appendChild(hl); }
    if (!badge) { badge = document.createElement('div'); badge.id = 'lt-badge'; document.body.appendChild(badge); }
  }
  function highlightAt(el) {
    ensureHl();
    if (!el || (el.closest && el.closest('#lt-panel'))) { hideHl(); return; }
    var r = el.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = r.left + 'px'; hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px';
    badge.style.display = 'block';
    badge.textContent = describe(el);
    badge.style.left = r.left + 'px';
    badge.style.top = Math.max(0, r.top - 18) + 'px';
  }
  function hideHl() {
    if (hl) hl.style.display = 'none';
    if (badge) badge.style.display = 'none';
  }

  /* ---------- 拾取 / 拖动 ---------- */
  function setPicking(on) {
    picking = on;
    if (document.body) document.body.style.cursor = on ? 'crosshair' : '';
    if (!on) hideHl();
  }
  function setDragMode(on) {
    dragMode = on;
    if (document.body) document.body.style.cursor = on ? 'move' : '';
  }

  var dragState = null;
  function onDown(e) {
    /* Alt+拖动 或 拖动模式：直接改位移，不用先选中 */
    var wantDrag = dragMode || (e.altKey && !picking);
    if (!wantDrag || e.button !== 0) return;
    var el = e.target;
    if (!el || (el.closest && el.closest('#lt-panel'))) return;
    e.preventDefault();
    selected = el;
    var sel = selectorFor(el);
    var ov = getOv(sel, true);
    dragState = { el: el, sel: sel, ov: ov, startX: e.clientX, startY: e.clientY, dx0: ov.dx || 0, dy0: ov.dy || 0 };
    try { el.setPointerCapture && el.setPointerCapture(e.pointerId); } catch (err) {}
    pushSelected();
  }
  function onMove(e) {
    if (picking && !dragState) { highlightAt(e.target); return; }
    if (!dragState) return;
    dragState.ov.dx = Math.round(dragState.dx0 + (e.clientX - dragState.startX));
    dragState.ov.dy = Math.round(dragState.dy0 + (e.clientY - dragState.startY));
    applyTo(dragState.el, dragState.ov);
  }
  function onUp() {
    if (!dragState) return;
    save(); pushOverrides(); pushSelected();
    dragState = null;
  }

  /* 点击选中：只在拾取模式下生效，避免影响正常使用 */
  function onClick(e) {
    if (!picking) return;
    var el = e.target;
    if (!el || (el.closest && el.closest('#lt-panel'))) return;
    e.preventDefault();
    e.stopPropagation();
    selected = el;
    setPicking(false);
    pushSelected();
    push('picked', { sel: selectorFor(el), elements: collectElements(currentScreenSel) });
  }

  /* ---------- 键盘 ---------- */
  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      /* Ctrl+Shift+D：开关独立调试器窗口 */
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        if (bridge && typeof bridge.tunerIsOpen === 'function') {
          bridge.tunerIsOpen().then(function (isOpen) {
            if (isOpen) closeTunerWindow(); else openTunerWindow();
          }).catch(function () { openTunerWindow(); });
        } else openTunerWindow();
        return;
      }
      if (e.key === 'Escape') { setPicking(false); setDragMode(false); hideHl(); return; }
      /* 方向键微调选中的部件 */
      if (!selected) return;
      var step = e.shiftKey ? 10 : 1;
      var dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step;
      else if (e.key === 'ArrowDown') dy = step;
      else return;
      /* 输入框里按方向键应该是移动光标，不是挪部件 */
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      var sel = selectorFor(selected);
      var ov = getOv(sel, true);
      ov.dx = (ov.dx || 0) + dx;
      ov.dy = (ov.dy || 0) + dy;
      applyTo(selected, ov);
      save(); pushOverrides(); pushSelected();
    });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    load();
    ensureHl();
    bindKeys();
    bindBridge();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('click', onClick, true);
    applyAll();
    try { console.log('[布局调试器] 已加载，按 Ctrl+Shift+D 打开独立调试器窗口'); } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
