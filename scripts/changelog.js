/**
 * 生成发布说明（更新日志）—— 从真实的 git 提交里提取，不硬编码。
 *
 * 为什么需要它：
 *   release.yml 里原先写死了一段 v2.3.3 时期的说明，之后每次发版都原样贴出去，
 *   用户看到的更新日志和实际改动对不上。这里改为按版本区间算，
 *   提交写了什么就发布什么。
 *
 * 用法：
 *   node scripts/changelog.js                     # 自动：上一个 tag → HEAD
 *   node scripts/changelog.js v2.3.3 v2.3.6-pre   # 指定区间
 *   node scripts/changelog.js --since v2.3.3      # 只要起点
 *
 * 输出：Markdown，写到 stdout，同时可用 --out 写文件。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

/* 同时支持 git(['log','-1']) 和 git('log','-1') 两种写法。
   之前只支持数组，而调用处按可变参数写，结果 'describe' 之外全被丢掉，
   静默返回空字符串（因为 catch 吞了错），表现为"算不出区间"。 */
function git() {
  const args = Array.isArray(arguments[0]) ? arguments[0] : Array.prototype.slice.call(arguments);
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch (e) {
    return '';
  }
}

/* 版本号比较：只按数字段，忽略 pre 后缀（用于挑"上一个正式版"） */
function cmpVer(a, b) {
  const n = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map(Number);
  const A = n(a), B = n(b);
  for (let i = 0; i < 3; i++) {
    if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
  }
  return 0;
}

/* 找版本区间的起点。
   关键点：必须挑**当前 HEAD 的祖先** tag —— 仓库里 tag 不一定在同一条线上
   （比如 v2.3.3 与 HEAD 分叉），拿它当起点会算出空区间，日志就成了空的。
   git describe 正好就是"最近的可达 tag"，用它最稳。 */
function autoRange() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const cur = 'v' + pkg.version;

  /* 1) 优先：HEAD 可达的最近 tag */
  let from = git('describe', '--tags', '--abbrev=0', 'HEAD');

  /* 2) 兜底：可达 tag 里挑版本号小于当前的
        （避免"当前 tag 就打在本提交上"时算出空区间） */
  if (from) {
    const same = from.replace(/^v/, '') === String(pkg.version);
    if (same) {
      const prevTag = git('describe', '--tags', '--abbrev=0', from + '^');
      if (prevTag) from = prevTag;
    }
  }
  if (!from) {
    const all = git('tag', '--sort=-v:refname').split('\n').filter(Boolean)
      .filter((t) => /^v?\d+\.\d+/.test(t) && cmpVer(t, cur) < 0);
    from = all[0] || '';
  }
  return { from: from || '', to: 'HEAD' };
}

/* 提交分类：按 conventional-commit 前缀归档 */
const KINDS = [
  { key: 'feat', title: '✨ 新功能', re: /^feat(\([^)]*\))?!?:/i },
  { key: 'fix', title: '🐛 修复', re: /^fix(\([^)]*\))?!?:/i },
  { key: 'perf', title: '⚡ 性能', re: /^perf(\([^)]*\))?!?:/i },
  { key: 'style', title: '🎨 界面', re: /^(style|ui|design)(\([^)]*\))?!?:/i },
  { key: 'docs', title: '📝 文档', re: /^docs(\([^)]*\))?!?:/i },
  { key: 'refactor', title: '♻️ 重构', re: /^refactor(\([^)]*\))?!?:/i },
  { key: 'chore', title: '⚙️ 其他', re: /^(chore|build|ci|test)(\([^)]*\))?!?:/i },
];

/* 合并提交 / 备份快照 / 纯版本号提交不进更新日志 */
const SKIP = /^(Merge |backup:|chore\(release\)|v?\d+\.\d+\.\d+$)/i;

function cleanSubject(s) {
  return s
    .replace(/^(feat|fix|perf|style|ui|design|docs|refactor|chore|build|ci|test)(\([^)]*\))?!?:\s*/i, '')
    .trim();
}

/* 只要提交正文/标题里第一段有意义的描述，不要把整段 commit message 贴上去 */
function summarize(body, subject) {
  const lines = String(body || '').split('\n').map((l) => l.trim()).filter(Boolean);
  /* 取第一条"像人话"的说明行：不是元信息、不是列表符号以外的噪声 */
  const i = lines.findIndex((l) =>
    !/^(Signed-off-by|Co-authored-by|BREAKING CHANGE)/i.test(l) &&
    !/^[-*]\s*$/.test(l) &&
    l.length >= 6
  );
  if (i < 0) return clip(String(subject || ''));

  /* commit message 的正文经常一句没写完就换行，例如
       "问题：xxx 写死了，\n之后每次发版都原样贴出去。"
     只取第一行会得到半句话（尾随逗号），发布说明看着像被截断。
     所以：这一行若以逗号/顿号/分号/冒号结尾，就继续接下一行，直到句子写完。
     遇到新的列表项就停，避免把整段列表拼进来。 */
  let text = lines[i].replace(/^[-*]\s*/, '');
  for (let k = i + 1; k < lines.length && /([，,、：:；;]|——|—|--)$/.test(text); k++) {
    if (/^[-*]\s+/.test(lines[k])) break;
    if (/^(Signed-off-by|Co-authored-by)/i.test(lines[k])) break;
    text = glue(text, lines[k].replace(/^[-*]\s*/, ''));
  }
  return clip(text);
}

/* 拼接续行：破折号或 ASCII 标点后接拉丁字母时补一个空格（"—Windows" → "— Windows"） */
function glue(a, b) {
  const needSpace = /[—–\-\x00-\x7F]$/.test(a) && /^[A-Za-z0-9]/.test(b);
  return a + (needSpace ? ' ' : '') + b;
}

/* 裁剪：优先在句子边界收尾，避免出现"…初始化失败。新增…"这种半句 */
function clip(t) {
  let s = String(t || '').trim().replace(/^[-*]\s*/, '');
  const LIMIT = 150;
  if (s.length > LIMIT) {
    const head = s.slice(0, LIMIT);
    const m = head.match(/^[\s\S]*[。！？!?]/);
    /* 切在完整句子上（且不至于只剩一小截）；否则退化为按字数截断 */
    s = (m && m[0].length >= 40) ? m[0] : head.replace(/([，,、：:；;]|——|—|--|\s)+$/, '') + '…';
  }
  /* 结尾悬空的标点一律去掉 */
  return s.replace(/([，,、：:；;]+|——|—|--)$/, '');
}

function collect(from, to) {
  const range = from ? from + '..' + to : to;
  /* 用 \x1e 分隔提交、\x1f 分隔字段，避免正文里的换行把解析搞乱 */
  const raw = git('log', '--no-merges', '--pretty=format:%H%x1f%s%x1f%b%x1e', range);
  if (!raw) return [];
  return raw.split('\x1e').map((r) => r.trim()).filter(Boolean).map((rec) => {
    const [hash, subject, body] = rec.split('\x1f');
    return { hash: (hash || '').slice(0, 7), subject: subject || '', body: body || '' };
  });
}

function build(from, to, opts) {
  opts = opts || {};
  const commits = collect(from, to);
  const groups = {};
  KINDS.forEach((k) => { groups[k.key] = []; });

  commits.forEach((c) => {
    if (SKIP.test(c.subject)) return;
    const kind = KINDS.find((k) => k.re.test(c.subject));
    const key = kind ? kind.key : 'chore';
    groups[key].push({
      text: cleanSubject(c.subject) || c.subject,
      detail: summarize(c.body, c.subject),
      hash: c.hash,
    });
  });

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const ver = 'v' + pkg.version;
  const isPre = String(pkg.version).includes('-');

  /* 同一分类里去重（多次提交说同一件事时只留一条） */
  Object.keys(groups).forEach((k) => {
    const seen = new Set();
    groups[k] = groups[k].filter((it) => {
      const key = it.text;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  const out = [];
  out.push('## BLFP ' + ver);
  out.push('');
  const total = Object.keys(groups).reduce((n, k) => n + groups[k].length, 0);
  if (isPre) {
    out.push('> 这是**测试版**，用于提前验证；正式版用户不会被自动推送到此版本。');
    out.push('> 设置页把「更新渠道」切到**测试版**才能收到。');
    out.push('');
  }
  if (!total) {
    out.push('本次发布没有面向用户的改动，只有构建和版本号变更。');
    out.push('');
  }

  KINDS.forEach((k) => {
    const items = groups[k.key];
    if (!items.length) return;
    out.push('### ' + k.title);
    items.forEach((it) => {
      /* 标题是概览，正文第一行作为补充说明。
         但很多提交正文的第一行就是标题本身（或加了个 fix(x): 前缀），
         这种就别重复贴一遍 —— 否则日志看起来像复读机。 */
      out.push('- ' + it.text);
      const d = String(it.detail || '').trim();
      const norm = (x) => String(x || '')
        .replace(/^(feat|fix|perf|style|ui|design|docs|refactor|chore|build|ci|test)(\([^)]*\))?!?:\s*/i, '')
        .replace(/[。.；;，,\s]+$/g, '')
        .trim();
      const nd = norm(d), nt = norm(it.text);
      const dup = !d || nd === nt || nt.includes(nd) || nd.includes(nt);
      if (!dup) out.push('  - ' + d);
    });
    out.push('');
  });

  if (opts.withBuild) {
    out.push('### 📦 构建信息');
    out.push('- 版本：`' + ver + '`' + (isPre ? ' 测试版' : ''));
    if (opts.sha) out.push('- 构建 commit：`' + opts.sha + '`');
    if (from) out.push('- 变更范围：`' + from + '...' + (to === 'HEAD' ? 'HEAD' : to) + '`');
    out.push('- 详细构建时间见包内 `renderer/build-info.js`');
    out.push('');
  }

  return { markdown: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', commitCount: commits.length, total, isPre, version: ver };
}

/* ---------- CLI ---------- */
if (require.main === module) {
  const argv = process.argv.slice(2);
  let from = '', to = 'HEAD', outFile = '', withBuild = false, sha = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') { from = argv[++i] || ''; }
    else if (a === '--out') { outFile = argv[++i] || ''; }
    else if (a === '--with-build') { withBuild = true; }
    else if (a === '--sha') { sha = argv[++i] || ''; }
    else if (!from) { from = a; }
    else { to = a; }
  }
  if (!from) { const r = autoRange(); from = r.from; to = r.to; }

  const res = build(from, to, { withBuild, sha });

  /* 生成结果为空（比如区间里没提交）要显式报错，别默默发一段空日志 */
  if (res.total === 0 && res.commitCount === 0) {
    console.error('[changelog] 区间 ' + (from || '开头') + '..' + to + ' 没有任何提交，拒绝生成空日志');
    /* 最常见的原因是**浅克隆**：CI 默认只拉 1 个提交，
       git describe <tag>^ 会 fatal，区间永远是空的。
       这里直接把病因和药方打出来，省得下次又从头查（真踩过）。 */
    const shallow = git('rev-parse', '--is-shallow-repository') === 'true';
    if (shallow) {
      console.error('[changelog] 原因：当前是**浅克隆**（git rev-list --count HEAD = '
        + (git('rev-list', '--count', 'HEAD') || '?') + '），无法遍历提交历史。');
      console.error('[changelog] 解决：在 workflow 的 actions/checkout 上加 fetch-depth: 0 和 fetch-tags: true。');
    }
    process.exit(2);
  }

  process.stdout.write(res.markdown);
  if (outFile) {
    fs.writeFileSync(outFile, res.markdown);
    console.error('[changelog] 已写入 ' + outFile + '（' + res.total + ' 条改动，覆盖 ' + res.commitCount + ' 个提交）');
  }
}

module.exports = { build, autoRange, collect, cleanSubject, cmpVer };
