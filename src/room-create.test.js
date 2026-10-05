/*
 * 建房（create）消息的守卫。
 *
 * 真实事故（用户报的）：建 FRP 房间弹"非法消息格式"，建 EasyTier 房间也一样，
 * 而且 frpc 会一直重启。
 *
 * 根因有两层：
 *   1) 服务端 validateMessage 用**严格字段白名单**。description / mcVersion /
 *      password 这三个房主自定义字段只在客户端加了，服务端那份改动一直没提交、
 *      也就没部署。客户端每次建房都多带三个字段 → 线上服务端白名单对不上 →
 *      整条 create 判"非法消息格式" → 两种模式的房间都建不起来。
 *   2) frp 隧道是在发 create **之前**就起来的，而服务端的错误是**异步**回来的，
 *      createFrpRoom 的 catch 接不到；handleSignal 的 error 分支又只清 state.role，
 *      不关隧道 → 公网端口一直占着，重试一次多一个，现象就是"一直启动 FRPC"。
 *
 * 所以这里钉四件事：字段集必须和服务端对得上、空字段不许发、
 * 建房失败必须关隧道、服务端不认新字段要能退一步重试。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');

/* 服务端是另一个仓库，CI 上只 checkout 客户端，所以拿不到就跳过。
   本地两个仓库并排放着，这条会真的跑 —— 它正是能提前发现本次事故的那条。 */
const SERVER_FILE = path.join(ROOT, '..', 'blfp-server', 'security-logic.js');
const hasServer = fs.existsSync(SERVER_FILE);
const SERVER = hasServer ? fs.readFileSync(SERVER_FILE, 'utf8') : '';

/** 把 `xxx: yyy` 的键抠出来（先把嵌套的 frp: {...} 抹掉，免得把 host/port/node 当顶层键） */
function topLevelKeys(source) {
  const flat = source.replace(/frp:\s*\{[^}]*\}/g, 'frp: 0');
  const keys = new Set();
  const re = /(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*:/g;
  let m;
  while ((m = re.exec(flat))) keys.add(m[1]);
  return keys;
}

/** 客户端所有 sendCreate({...}) 的顶层字段 */
function clientCreateKeys() {
  const keys = new Set();
  const re = /sendCreate\(\{([\s\S]*?)\}\)/g;
  let m;
  while ((m = re.exec(APP))) {
    for (const k of topLevelKeys(m[1])) keys.add(k);
  }
  /* ...hostCustomFields() 展开的字段 */
  const hc = APP.slice(APP.indexOf('function hostCustomFields'));
  const hcBody = hc.slice(0, hc.indexOf('\n}'));
  const re2 = /out\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = re2.exec(hcBody))) keys.add(m[1]);
  return keys;
}

/** 服务端 MESSAGE_FIELDS.create 允许的字段 */
function serverCreateFields() {
  const m = SERVER.match(/create:\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, '在服务端 security-logic.js 里找不到 MESSAGE_FIELDS.create');
  return new Set(m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
}

test('客户端 create 的每个字段，服务端白名单里都必须有', { skip: !hasServer && '找不到 ../blfp-server（CI 上只 checkout 客户端）' }, () => {
  const client = clientCreateKeys();
  const server = serverCreateFields();
  assert.ok(client.size >= 5, '没抠到客户端的 create 字段，解析逻辑坏了：' + [...client].join(','));
  const unknown = [...client].filter((k) => !server.has(k));
  assert.equal(unknown.length, 0,
    '客户端会发这些字段，但服务端 MESSAGE_FIELDS.create 不认：' + unknown.join('、') + '\n' +
    '服务端用的是严格白名单（hasOnlyFields），多一个字段整条 create 都会被判' +
    '"非法消息格式" —— 房间直接建不起来。\n' +
    '要么把服务端那份改动提交并部署，要么别在客户端发这些字段。');
});

test('空的自定义字段不要发出去（否则不填简介的用户也会被老服务端拒）', () => {
  const i = APP.indexOf('function hostCustomFields');
  assert.ok(i > 0, '找不到 hostCustomFields');
  const body = APP.slice(i, APP.indexOf('\n}', i));
  assert.ok(/if\s*\(description\)/.test(body) && /if\s*\(mcVersion\)/.test(body) && /if\s*\(password\)/.test(body),
    'hostCustomFields 没有"非空才带上"的判断 —— 空字符串也会发出去，' +
    '老服务端的字段白名单里没有这三个字段，会把整条 create 判成非法消息格式');
  assert.equal(/return\s*\{[\s\S]*description:/.test(body), false,
    'hostCustomFields 还在无条件返回这三个字段');
});

test('建房消息统一走 sendCreate（否则退一步重试没机会生效）', () => {
  const sends = APP.match(/sendSignal\(\{\s*type:\s*'create'/g) || [];
  assert.equal(sends.length, 0, '还有地方直接用 sendSignal 发 create，绕过了 sendCreate');
  const viaHelper = APP.match(/sendCreate\(\{\s*type:\s*'create'/g) || [];
  assert.ok(viaHelper.length >= 2, '两种模式（easytier / frp）的建房都要走 sendCreate，实际 ' + viaHelper.length + ' 处');
});

test('服务端不认新字段时要能摘掉它们重试一次', () => {
  assert.ok(/function retryCreateWithoutCustomFields/.test(APP), '没有重试函数');
  const i = APP.indexOf('function retryCreateWithoutCustomFields');
  const body = APP.slice(i, APP.indexOf('\n}', i));
  assert.ok(/retried/.test(body), '没有防重入标记，会无限重试');
  assert.ok(/description, mcVersion, password/.test(body), '没有真的把这三个字段摘掉');
  /* 触发点必须挂在 error 分支上，而且要排在"清 role"前面 */
  const errAt = APP.indexOf("case 'error':");
  const errBody = APP.slice(errAt, APP.indexOf('\n      break;', errAt));
  assert.ok(/retryCreateWithoutCustomFields\(\)/.test(errBody), 'error 分支没有调用重试');
  assert.ok(/非法消息格式/.test(errBody), '没有按错误内容判断，会把别的失败也当成字段问题');
});

test('建房失败必须关掉已经拉起来的 frp 隧道（否则"一直启动 FRPC"）', () => {
  const errAt = APP.indexOf("case 'error':");
  const errBody = APP.slice(errAt, APP.indexOf('\n      break;', errAt));
  assert.ok(/frpcStop\(\)/.test(errBody),
    'error 分支没有关 frp 隧道 —— 隧道是发 create 之前就起来的，' +
    '服务端错误异步回来时 createFrpRoom 的 catch 接不到，它会一直占着公网端口');
  assert.ok(/state\.frpNode\s*=\s*null/.test(errBody) && /state\.frpTunnelName\s*=\s*''/.test(errBody),
    '关隧道之后没有清掉 frpNode / frpTunnelName');
  /* 隧道是在 create 之前起的，所以创建路径里必须先起隧道再发消息 */
  const frpAt = APP.indexOf("mode: 'frp'");
  assert.ok(frpAt > 0, '找不到 frp 建房');
  const before = APP.slice(Math.max(0, frpAt - 3000), frpAt);
  assert.ok(/frpcStart|mclink\.frpcStart/.test(before), '没看到 frpcStart —— 建房流程变了，这条守卫要跟着更新');
});
