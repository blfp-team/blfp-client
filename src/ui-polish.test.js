/*
 * 界面一致性的结构守卫。
 *
 * 这一轮改的都是"看得见的东西"，没有业务逻辑；但这类改动最容易在后续迭代里
 * 被悄悄改回去，或者像「吸底栏底下漏一条」那样改一半留下个坑。所以把关键结构钉死：
 *
 *   1. 设置页的保存按钮必须在吸底栏里，页面中间不许再有第二份
 *   2. 吸底栏必须是 sticky，且底部内边距不能留在 .content 上
 *      （留在容器上会让 sticky 停在 padding 内边缘，底下漏出 24px 内容）
 *   3. 空状态必须带次级提示（一行灰字悬在空白里的老样子不许回来）
 *   4. 选项卡选中态必须用主色（--accent），不许退回灰块
 *   5. 危险按钮必须深红（浅红配白字看不清）
 *   6. 聊天区空了要有兜底文案
 *   7. 键盘导航的焦点环
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'renderer', 'style.css'), 'utf8');

test('设置页保存按钮在吸底栏里，页面中间不再有第二份', () => {
  const m = HTML.match(/<div class="settings-actions">([\s\S]*?)<\/div>/);
  assert.ok(m, '找不到 .settings-actions 吸底栏');
  assert.match(m[1], /onclick="saveSettings\(\)"/, '吸底栏里没有保存按钮');

  const before = HTML.slice(0, HTML.indexOf('class="settings-actions"'));
  assert.equal(/onclick="saveSettings\(\)"/.test(before), false,
    '页面中间还留着一份「保存设置」—— 两份按钮会让用户不知道哪个生效');
});

test('吸底栏是 sticky，且底部内边距不留在 .content 上', () => {
  const bar = CSS.match(/\.settings-actions\s*\{[^}]*\}/);
  assert.ok(bar, '找不到 .settings-actions 的样式');
  assert.match(bar[0], /position:\s*sticky/, '吸底栏必须是 sticky');

  const content = CSS.match(/\.content\s*\{[^}]*\}/);
  assert.ok(content, '找不到 .content 样式');
  assert.equal(/padding:\s*24px\s+28px\s*;/.test(content[0]), false,
    '.content 还留着底部内边距 —— sticky 会停在 padding 内边缘，底下漏出一条内容');
  assert.match(content[0], /padding:\s*24px\s+28px\s+0/,
    '.content 的 padding 应该是 24px 28px 0');
});

test('空状态必须带一行次级提示', () => {
  const els = [...HTML.matchAll(/<div class="empty-state">([\s\S]*?)<\/div>/g)];
  assert.ok(els.length >= 4, 'index.html 里的空状态少于 4 处，结构变了？');
  for (const e of els) {
    assert.match(e[1], /class="empty-sub"/, '有空状态没写次级提示：' + e[1].slice(0, 40));
  }

  const total = (APP.match(/class="empty-state"/g) || []).length;
  const withSub = (APP.match(/class="empty-sub"/g) || []).length;
  assert.ok(total > 0, 'app.js 里没有动态空状态了？');
  assert.ok(withSub >= total, 'app.js 里有 ' + (total - withSub) + ' 处动态空状态没有次级提示');
});

test('选项卡选中态用主色，不许退回灰块', () => {
  for (const sel of ['\\.tab-btn\\.active', '\\.auth-tabs button\\.active', '\\.login-method-tabs button\\.active']) {
    const m = CSS.match(new RegExp(sel + '\\s*\\{[^}]*\\}'));
    assert.ok(m, '找不到规则：' + sel);
    assert.match(m[0], /var\(--accent\)/, sel + ' 的选中态没用主色');
  }
});

test('危险按钮用深红（浅红配白字看不清）', () => {
  const danger = CSS.match(/\.btn-danger\s*\{[^}]*\}/);
  assert.ok(danger, '找不到 .btn-danger');
  assert.match(danger[0], /#dc2626/, '危险按钮没用深红');
});

test('聊天区清空后要有兜底文案', () => {
  assert.match(CSS, /\.chat-messages:empty::before/, '聊天区空了会是一整块黑');
});

test('键盘导航要有可见焦点环', () => {
  for (const sel of ['.nav-item:focus-visible', '.tab-btn:focus-visible', '.theme-btn:focus-visible']) {
    assert.ok(CSS.includes(sel), '缺少焦点环：' + sel);
  }
});
