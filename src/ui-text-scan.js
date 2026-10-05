/*
 * 把"用户能看到的文字"从源码里抠出来。
 *
 * 为什么要专门做这个：用 grep 找括号会被代码里的函数调用淹没
 * （`((res && res.error) || '未知错误')` 这种一搜一大把），
 * 根本看不出哪些是真的文案。所以按语法抠：
 *   - JS：字符串字面量（含模板字符串，跳过 ${...} 里的表达式）
 *   - HTML：文本节点（去掉注释、script/style、标签）
 * 再在抠出来的文字里找括号。
 *
 * 产品要求（用户 2026-10 提的）：界面文案里不能出现 "xxxx（xxxxxxxxx）" 这种
 * "标签 + 括号解释"的写法 —— 设置项本来该说人话，不是靠括号补课。
 */
'use strict';

/** 从 JS 源码里抠出字符串字面量；返回 [{ line, text }] */
function jsStrings(src) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const bump = (from, to) => { for (let k = from; k < to; k++) if (src[k] === '\n') line++; };

  while (i < n) {
    const c = src[i];
    /* 注释整段跳过，里面的中文不该被当成文案 */
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      bump(i, stop); i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      bump(i, stop); i = stop;
      continue;
    }
    if (c !== "'" && c !== '"' && c !== '`') { if (c === '\n') line++; i++; continue; }

    const quote = c;
    const startLine = line;
    let j = i + 1;
    let text = '';
    while (j < n) {
      const d = src[j];
      if (d === '\\') { text += src[j + 1] === 'n' ? '\n' : src[j + 1]; j += 2; continue; }
      if (d === quote) break;
      if (quote === '`' && d === '$' && src[j + 1] === '{') {
        /* 模板表达式：括号配对跳过，里面的内容不是文案 */
        let depth = 1; j += 2;
        while (j < n && depth > 0) {
          if (src[j] === '{') depth++;
          else if (src[j] === '}') depth--;
          if (src[j] === '\n') line++;
          j++;
        }
        text += '\u0000'; /* 占位，保持"这里原来有内容" */
        continue;
      }
      if (d === '\n') {
        if (quote !== '`') break; /* 普通字符串不能跨行，说明是未闭合，认栽 */
        line++;
      }
      text += d; j++;
    }
    if (text.trim()) out.push({ line: startLine, text });
    i = j + 1;
  }
  return out;
}

/** 从 HTML 里抠出文本节点；返回 [{ line, text }] */
function htmlText(src) {
  const out = [];
  const stripped = src
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<script\b[\s\S]*?<\/script>/gi, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<style\b[\s\S]*?<\/style>/gi, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<[^>]*>/g, (m) => m.replace(/[^\n]/g, ' '));
  stripped.split('\n').forEach((raw, idx) => {
    const text = raw.replace(/&nbsp;/g, ' ').trim();
    if (text) out.push({ line: idx + 1, text });
  });
  return out;
}

/** 抠出某段文字里的括号片段 */
const PAREN_RE = /（[^）]{0,120}）|\([^)]{0,120}\)/g;

/* CSS 里的函数调用不是文案：rgba(0,0,0,.4)、var(--x)、cubic-bezier(...) 等等 */
/* 注意：before 是"括号之前"的文字，所以这里匹配函数名结尾，**不能**带 \( ——
   带上 \( 就永远匹配不上，整条过滤形同虚设（写错过一次，靠测试钉住的）。 */
const CSS_FN = /(?:^|[^\w-])(?:rgba?|hsla?|var|cubic-bezier|translate[XYZ3d]*|scale[XYZ]?|rotate[XYZ]?|saturate|brightness|blur|linear-gradient|radial-gradient|calc|url|clamp|min|max|repeat|matrix)$/i;
const CJK_RE = /[\u4e00-\u9fff]/;

/** 这条括号算不算"给用户看的文案" */
function looksLikeUiText(text, match, index) {
  const before = text.slice(Math.max(0, index - 8), index);
  if (CSS_FN.test(before)) return false;
  /* HTML 标签里的东西（onclick="f('x')"、style="..."）一律不算文案 */
  const inTag = text.lastIndexOf('<', index) > text.lastIndexOf('>', index);
  if (inTag) return false;
  /* 判据：括号里是中文，或者紧挨着括号前面是中文。
     这样 "端口号 (1-65535)" 算文案，而 "scale(1.1)"、"closeModal('x')" 不算。 */
  const inner = match.slice(1, -1);
  return CJK_RE.test(inner) || CJK_RE.test(before);
}

/**
 * 扫描一批文件，返回所有"用户可见文字里带括号"的地方。
 * @param {string} root 仓库根
 * @param {string[]} files 相对路径
 */
function scan(root, files) {
  const fs = require('fs');
  const path = require('path');
  const hits = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    const items = rel.endsWith('.html') ? htmlText(src) : jsStrings(src);
    for (const it of items) {
      PAREN_RE.lastIndex = 0;
      let m;
      while ((m = PAREN_RE.exec(it.text))) {
        if (!looksLikeUiText(it.text, m[0], m.index)) continue;
        hits.push({ file: rel, line: it.line, match: m[0], text: it.text.slice(0, 140) });
      }
    }
  }
  return hits;
}

module.exports = { jsStrings, htmlText, scan, looksLikeUiText, PAREN_RE };
