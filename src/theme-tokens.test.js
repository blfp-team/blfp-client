/*
 * 主题变量覆盖率测试。
 *
 * 起因：浅色主题只覆盖了 11 个变量，而卡片/弹窗/房间卡片用的是硬编码深色，
 * 结果切到浅色后"只有侧边栏变浅、右边一片黑"。这类 bug 靠肉眼看代码很难发现，
 * 因为它不是语法错，是"某个主题下少了一个定义"。
 *
 * 这里做两件事：
 *   1. CSS 里用到的每个 var(--x) 必须在 :root 里有定义（否则任何主题下都是空值）
 *   2. 凡是"会随主题变"的变量（颜色类），必须在 [data-theme="light"] 里也有定义
 *      —— 否则浅色下会继承深色的值，正是上面那个 bug
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'style.css'), 'utf8');

/* 取出某个选择器块里定义的所有 --变量 */
function definedIn(selector) {
  const start = CSS.indexOf(selector + ' {');
  assert.ok(start > 0, '找不到选择器 ' + selector);
  const end = CSS.indexOf('\n}', start);
  const block = CSS.slice(start, end);
  return new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

/* 全文件里被用到的所有 var(--x) */
const used = new Set([...CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));

const rootVars = definedIn(':root');
const lightVars = definedIn('[data-theme="light"]');

/* 这些是"与主题无关"的：尺寸、时长、布局，浅色下不需要重新定义 */
const THEME_NEUTRAL = /^--(radius|radius-sm|radius-lg|radius-xl|sidebar-w|fast|base|slow|anim-speed)$/;

/* 这几个由 JS 在运行时写在元素上（鼠标位置、水波纹落点），
   CSS 里本来就不该有定义 —— 不是遗漏 */
const RUNTIME_SET = new Set(['--mouse-x', '--mouse-y', '--ripple-x', '--ripple-y']);

test('CSS 里用到的每个变量都在 :root 里有定义', () => {
  const missing = [...used].filter((v) => !rootVars.has(v) && !RUNTIME_SET.has(v));
  assert.deepEqual(missing, [], '这些变量被用了但没定义，任何主题下都是空值：' + missing.join(', '));
});

test('颜色类变量必须在浅色主题里也有定义（否则会继承深色的值）', () => {
  const missing = [...used]
    .filter((v) => rootVars.has(v))
    .filter((v) => !THEME_NEUTRAL.test(v))
    .filter((v) => !lightVars.has(v));
  assert.deepEqual(missing, [],
    '这些颜色变量在 [data-theme="light"] 里没有定义 —— 浅色下会沿用深色的值：' + missing.join(', '));
});

test('浅色主题的叠加基色必须是"压暗"而不是"提亮"', () => {
  /* --ov-rgb 是深色提亮 / 浅色压暗的开关。写反了整套浅色主题就废了 */
  const start = CSS.indexOf('[data-theme="light"] {');
  const block = CSS.slice(start, CSS.indexOf('\n}', start));
  assert.match(block, /--ov-rgb:\s*0,\s*0,\s*0/, '浅色下 --ov-rgb 必须是 0,0,0（压暗）');
  const rootStart = CSS.indexOf(':root {');
  const rootBlock = CSS.slice(rootStart, CSS.indexOf('\n}', rootStart));
  assert.match(rootBlock, /--ov-rgb:\s*255,\s*255,\s*255/, '深色下 --ov-rgb 必须是 255,255,255（提亮）');
});

test('body 的环境光渐变必须走变量（否则浅色下整页被深色洗过）', () => {
  const bodyStart = CSS.indexOf('\nbody {');
  const bodyBlock = CSS.slice(bodyStart, CSS.indexOf('\n}', bodyStart));
  assert.match(bodyBlock, /var\(--amb-1\)/, 'body 背景没有用 --amb-* 变量');
  assert.equal(/hsla\(\s*280,\s*20%,\s*15%/.test(bodyBlock), false,
    'body 背景里还有硬编码的深色渐变 —— 浅色下会把整页压黑');
});
