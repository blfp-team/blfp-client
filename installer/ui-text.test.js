/*
 * 守卫：安装程序界面文案里不能出现 "xxxx（xxxxxxxxx）" 这种写法。
 * 与 src/ui-text.test.js 同一套扫描器、同一个产品要求，见那边的说明。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const scan = require('../src/ui-text-scan.js');
const ROOT = path.join(__dirname, '..');
const FILES = [
  'installer/renderer/index.html',
  'installer/renderer/app.js',
  'installer/main.js',
  'installer/preload.js',
];

test('安装程序界面文案里不能有"标签（括号解释）"的写法', () => {
  const hits = scan.scan(ROOT, FILES);
  assert.equal(hits.length, 0,
    '下面这些地方还在用括号补课 —— 请改成一句话说清楚：\n' +
    hits.map((h) => `  ${h.file}:${h.line}  ${h.match}\n      ${h.text}`).join('\n'));
});
