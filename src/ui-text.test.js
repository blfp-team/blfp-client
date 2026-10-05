/*
 * 守卫：主程序界面文案里不能出现 "xxxx（xxxxxxxxx）" 这种"标签 + 括号解释"的写法。
 *
 * 用户 2026-10 提的要求，原话是"整个安装程序和主程序不能有任何类似于
 * xxxx(xxxxxxxxx)这种的"。之前也提过一次同类的：
 * "所谓的让用户看懂不是在设置项后面加一大堆括号，而是设置项本来就是大白话"。
 *
 * 为什么不能只靠 grep：代码里 `((res && res.error) || '未知错误')` 这种一搜一大把，
 * 混在一起根本看不出哪些是真的文案。所以用 src/ui-text-scan.js 按语法抠出
 * 字符串字面量和 HTML 文本节点，再在抠出来的文字里找括号。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const scan = require('./ui-text-scan.js');
const ROOT = path.join(__dirname, '..');
const FILES = ['renderer/index.html', 'renderer/app.js', 'main.js', 'preload.js', 'scripts/changelog.js'];

test('主程序界面文案里不能有"标签（括号解释）"的写法', () => {
  const hits = scan.scan(ROOT, FILES);
  assert.equal(hits.length, 0,
    '下面这些地方还在用括号补课 —— 请改成一句话说清楚，或者把信息放到 placeholder 里：\n' +
    hits.map((h) => `  ${h.file}:${h.line}  ${h.match}\n      ${h.text}`).join('\n'));
});

/* ---------- 守卫自己的守卫：扫描器不能把代码当文案 ---------- */

test('扫描器：字符串字面量抠得对，注释里的中文不算文案', () => {
  const src = [
    '// 这里有个（注释）不该被算成文案',
    '/* 块注释（也是） */',
    "const a = '正常文案';",
    'const b = `模板 ${x + y} 尾巴`;',
    "const c = \"双引号 ' 里的（中文）\";",
  ].join('\n');
  const out = scan.jsStrings(src);
  const texts = out.map((o) => o.text);
  assert.ok(texts.includes('正常文案'), '漏了单引号字符串');
  assert.ok(texts.some((t) => t.includes('尾巴')), '模板字符串的字面部分没抠出来');
  assert.ok(texts.some((t) => t.includes('里的（中文）')), '双引号里的括号没抠出来');
  assert.equal(texts.some((t) => t.includes('不该被算成文案')), false, '行注释被当成了文案');
  assert.equal(texts.some((t) => t.includes('块注释')), false, '块注释被当成了文案');
});

test('扫描器：CSS 函数和 HTML 属性里的括号不算文案', () => {
  const cases = [
    ['rgba(255,255,255,0.04)', false],
    ['cubic-bezier(.4, 0, .2, 1)', false],
    ['var(--text2)', false],
    ["onclick=\"closeModal('x')\"", false],
    ['用户名 (3-20位)', true],
    ['请输入有效的端口号 (1-65535)', true],
    ['（点击复制）', true],
    ['(无)', true],
    /* 下面两条是专门钉住那两个"防御性"过滤器的：
       只靠"括号里/前面有中文"这条判据，它们在合成用例里挡不住，
       但真实代码里确实出现过（CSS 值跟在中文后面、HTML 属性里带中文），
       所以各给一条用例，免得哪天被当成死代码删掉。 */
    ['中文 rgba(0,0,0,.4)', false],
    ['<button title="复制（点击）">复制</button>', false],
  ];
  for (const [text, want] of cases) {
    const m = scan.PAREN_RE.exec(text);
    scan.PAREN_RE.lastIndex = 0;
    assert.ok(m, '这段里应该有括号：' + text);
    assert.equal(scan.looksLikeUiText(text, m[0], m.index), want,
      `"${text}" 应该判定为${want ? '文案' : '代码'}`);
  }
});
