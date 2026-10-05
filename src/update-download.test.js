/*
 * 更新下载器测试：挑源、换源、进度、完整性。
 * 这些分支在真实网络里很难复现（尤其是"下到一半断了"），所以全部用桩覆盖。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dl = require('./update-download.js');

/* ---------------- 工具桩 ---------------- */

function okResponse(chunks, opts) {
  const o = opts || {};
  let i = 0;
  return {
    ok: true,
    status: o.status || 206,
    headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(o.length || 0) : null) },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: Buffer.from(chunks[i++]) } : { done: true }),
        cancel: async () => {},
      }),
    },
  };
}

function memFs() {
  const files = new Map();
  return {
    files,
    existsSync: (p) => files.has(p),
    unlinkSync: (p) => { files.delete(p); },
    createWriteStream: (p) => {
      const chunks = [];
      let onFinish = null;
      let onError = null;
      return {
        write(c) { chunks.push(Buffer.from(c)); return true; },
        once(evt, cb) { if (evt === 'drain') setTimeout(cb, 0); },
        on(evt, cb) { if (evt === 'finish') onFinish = cb; if (evt === 'error') onError = cb; },
        end(c) {
          if (c) chunks.push(Buffer.from(c));
          files.set(p, Buffer.concat(chunks));
          if (onFinish) setTimeout(onFinish, 0);
        },
        _fail: (e) => { if (onError) onError(e); },
      };
    },
  };
}

const tmpDest = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blfp-dl-')), 'setup.exe');

/* ---------------- mirrorUrl ---------------- */

test('mirrorUrl：直连不加前缀，加速源把原始地址拼在后面', () => {
  assert.equal(dl.mirrorUrl('', 'https://github.com/a/b.exe'), 'https://github.com/a/b.exe');
  assert.equal(dl.mirrorUrl('https://ghfast.top/', 'https://github.com/a/b.exe'), 'https://ghfast.top/https://github.com/a/b.exe');
  assert.equal(dl.mirrorUrl('https://ghfast.top', 'https://github.com/a/b.exe'), 'https://ghfast.top/https://github.com/a/b.exe');
});

/* ---------------- 挑源 ---------------- */

test('probeMirrors：能用的排前面，且按耗时从快到慢', async () => {
  const delays = { '': 300, 'https://fast/': 20, 'https://slow/': 900 };
  const fetchImpl = async (url) => {
    const prefix = Object.keys(delays).find((p) => p && url.startsWith(p)) || '';
    await new Promise((r) => setTimeout(r, delays[prefix]));
    return { status: 206, headers: { get: () => null }, body: { cancel: async () => {} } };
  };
  const mirrors = [
    { name: '直连', prefix: '' },
    { name: 'fast', prefix: 'https://fast/' },
    { name: 'slow', prefix: 'https://slow/' },
  ];
  const out = await dl.probeMirrors({ url: 'https://github.com/x', mirrors, fetchImpl, timeoutMs: 3000 });
  assert.deepEqual(out.map((m) => m.name), ['fast', '直连', 'slow'],
    '"自动选择能用的镜像源"必须是：能用的优先，快的更靠前');
});

test('probeMirrors：403/404 的源判定为不可用（别浪费时间）', async () => {
  const fetchImpl = async (url) => ({ status: url.includes('bad') ? 404 : 206, headers: { get: () => null }, body: { cancel: async () => {} } });
  const mirrors = [{ name: 'bad', prefix: 'https://bad/' }, { name: 'good', prefix: 'https://good/' }];
  const out = await dl.probeMirrors({ url: 'https://g/x', mirrors, fetchImpl });
  assert.deepEqual(out.map((m) => m.name), ['good']);
});

test('probeMirrors：超时的源被排除，不会把整体拖死', async () => {
  const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
    if (url.includes('hang')) {
      /* 模拟"连上但不回"：只有 abort 能让它结束 */
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      return;
    }
    resolve({ status: 206, headers: { get: () => null }, body: { cancel: async () => {} } });
  });
  const mirrors = [{ name: 'hang', prefix: 'https://hang/' }, { name: 'ok', prefix: 'https://ok/' }];
  const out = await dl.probeMirrors({ url: 'https://g/x', mirrors, fetchImpl, timeoutMs: 150 });
  assert.deepEqual(out.map((m) => m.name), ['ok'], '卡住的源必须被超时踢掉');
});

test('probeMirrors：全部不通时仍然返回直连，交给下载去试一次', async () => {
  const fetchImpl = async () => { throw new Error('ENOTFOUND'); };
  const out = await dl.probeMirrors({ url: 'https://g/x', mirrors: dl.DEFAULT_MIRRORS, fetchImpl });
  assert.equal(out.length, 1);
  assert.equal(out[0].prefix, '', '全不通时应该保留直连兜底，而不是直接判"没网"');
});

/* ---------------- 下载 ---------------- */

test('downloadWithFallback：正常下载成功，进度单调递增且最后到 100', async () => {
  const dest = tmpDest();
  const seen = [];
  const fetchImpl = async () => okResponse([Buffer.alloc(40), Buffer.alloc(60)], { length: 100 });
  const out = await dl.downloadWithFallback({
    url: 'https://g/x', dest, fsImpl: fs, fetchImpl, expectedSize: 100,
    mirrors: [{ name: '直连', prefix: '' }],
    onProgress: (p) => seen.push(p.percent),
  });
  assert.equal(out.ok, true);
  assert.equal(out.bytes, 100);
  assert.equal(fs.statSync(dest).size, 100);
  assert.equal(seen[seen.length - 1], 100, '进度最后应该到 100');
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], '进度不能倒退');
});

test('downloadWithFallback：第一个源下到一半断了 → 自动换源重下（不是接着拼）', async () => {
  const dest = tmpDest();
  let directDownloads = 0;
  const fetchImpl = async (url, opts) => {
    /* 探针带 Range: bytes=0-0，用它把"探测"和"真下载"分开，
       否则探针也会被当成下载、把计数打乱 */
    const isProbe = !!(opts && opts.headers && opts.headers.Range);
    if (isProbe) {
      /* 让加速源的探针慢一点，保证直连总是排在前面 ——
         否则两个探针都是瞬时返回，顺序由计时决定，这个测试会时红时绿（踩过）。 */
      if (url.startsWith('https://m/')) await new Promise((r) => setTimeout(r, 40));
      return okResponse([Buffer.alloc(1)], { length: 1 });
    }
    /* 直连的第一次真下载：只给 30 字节但声称 100 → 触发"不完整"，必须换源 */
    if (url === 'https://github.com/x' && directDownloads++ === 0) {
      return okResponse([Buffer.alloc(30)], { length: 100 });
    }
    return okResponse([Buffer.alloc(50), Buffer.alloc(50)], { length: 100 });
  };
  const mirrors = [{ name: '直连', prefix: '' }, { name: 'mirror', prefix: 'https://m/' }];
  const out = await dl.downloadWithFallback({
    url: 'https://github.com/x', dest, fsImpl: fs, fetchImpl, expectedSize: 100, mirrors,
  });
  assert.equal(out.ok, true, '第一个源坏了应该自动换源，而不是直接失败');
  assert.equal(fs.statSync(dest).size, 100, '换源后必须是完整的 100 字节，不能是 30+50 拼出来的');
  assert.equal(out.attempts.length, 2, '应该记录到两次尝试：直连失败 + 换源成功');
  assert.equal(out.attempts[0].ok, false);
  assert.equal(out.attempts[1].ok, true);
  assert.equal(out.mirror, 'mirror');
});

test('downloadWithFallback：所有源都失败时如实报错，并带上每个源的失败原因', async () => {
  const dest = tmpDest();
  const fetchImpl = async (url) => {
    if (url.includes('probe') || true) {
      /* 探针通过，真下载失败 */
      return { ok: true, status: 206, headers: { get: () => null }, body: { getReader: () => ({ read: async () => { throw new Error('连接被重置'); }, cancel: async () => {} }) } };
    }
  };
  const mirrors = [{ name: '直连', prefix: '' }, { name: 'm', prefix: 'https://m/' }];
  const out = await dl.downloadWithFallback({ url: 'https://g/x', dest, fsImpl: fs, fetchImpl, mirrors, expectedSize: 10 });
  assert.equal(out.ok, false);
  assert.match(out.error, /连接被重置/);
  assert.equal(out.attempts.length, 2);
  assert.equal(fs.existsSync(dest), false, '失败后不该留下半截文件（下次会当成完整的）');
});

test('downloadWithFallback：HTTP 错误码会换源', async () => {
  const dest = tmpDest();
  const fetchImpl = async (url) => {
    if (url.startsWith('https://bad/')) return { ok: false, status: 500, headers: { get: () => null } };
    return okResponse([Buffer.alloc(10)], { length: 10 });
  };
  const mirrors = [{ name: 'bad', prefix: 'https://bad/' }, { name: 'good', prefix: 'https://good/' }];
  const out = await dl.downloadWithFallback({ url: 'https://g/x', dest, fsImpl: fs, fetchImpl, mirrors, expectedSize: 10 });
  assert.equal(out.ok, true);
  assert.equal(out.mirror, 'good');
});

/* ---------------- 写不进去：不能把主进程搞崩 ---------------- */

/*
 * 真实事故（用户报的）：
 *   更新到 v2.4.0-pre.6 时弹出
 *   "A JavaScript error occurred in the main process
 *    Uncaught Exception: Error: EPERM: operation not permitted, open
 *    'C:\Users\32396\AppData\Local\Temp\BLFP-Setup-v2.4.0-pre.6.exe'"
 *
 * 原因是 createWriteStream 的 'error' 监听挂晚了：文件打不开时（Windows 上
 * 正在运行的 exe 不能覆盖写、被杀软锁住）'error' 会在下载循环还在 await 网络数据时
 * 抛出来，而 EventEmitter 的 'error' 没有监听者就是**直接 throw**，
 * 这个 throw 在事件循环里，async 的 try/catch 接不住 → 主进程未捕获异常。
 *
 * 这个测试必须开子进程：老实现是**整个进程死掉**，在同一个进程里跑没法
 * 既断言"没崩"又拿到返回值。所以断言子进程正常退出、并且拿到了 ok:false。
 */
test('目标文件写不进去时如实报错，绝不能把主进程搞崩（EPERM 事故回归）', () => {
  const script = `
    const fs = require('fs'), os = require('os'), path = require('path');
    const dl = require(${JSON.stringify(require.resolve('./update-download.js'))});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blfp-dl-'));
    const dest = path.join(dir, 'BLFP-Setup-v2.4.0-pre.6.exe');
    /* 把目标路径做成目录 —— 跨平台都能稳定复现"打开失败"，
       Windows 上对应的是 EPERM（文件被占用） */
    fs.mkdirSync(dest);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const fetchImpl = async () => ({
      ok: true, status: 206, headers: { get: () => '10' },
      body: {
        /* 必须真的让出事件循环：打开失败是在下一个事件循环 tick 抛出来的，
           而那时下载循环正 await 网络数据 —— 这才是事故现场 */
        getReader: () => ({ read: async () => { await wait(20); return { done: true }; }, cancel: async () => {} }),
        cancel: async () => {},
      },
    });
    dl.downloadWithFallback({
      url: 'https://g/x', dest, fsImpl: fs, fetchImpl,
      mirrors: [{ name: '直连', prefix: '' }], expectedSize: 10,
    }).then((r) => {
      console.log('RESULT ' + JSON.stringify(r));
    }).catch((e) => {
      console.log('RESULT ' + JSON.stringify({ ok: false, thrown: e.message }));
    });
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0,
    '子进程异常退出了（老实现就是"主进程未捕获异常"整个崩掉）：\n' +
    (child.stderr || '') + (child.stdout || ''));
  const m = (child.stdout || '').match(/RESULT (.*)/);
  assert.ok(m, '没有拿到结果，输出：' + (child.stdout || '') + (child.stderr || ''));
  const result = JSON.parse(m[1]);
  assert.equal(result.ok, false, '写不进去时必须如实返回失败，交给上层换源/提示');
  assert.ok(result.error, '失败时必须带上原因');
  assert.equal(result.thrown, undefined, '不该把错误抛到调用方接不住的地方：' + result.thrown);
});

test('describeWriteError：EPERM/EACCES 这类错误要翻成人话，不能直接把 errno 甩给用户', () => {
  const eperm = Object.assign(new Error("EPERM: operation not permitted, open 'C:\\Temp\\BLFP-Setup.exe'"), { code: 'EPERM' });
  const msg = dl.describeWriteError(eperm, 'C:\\Temp\\BLFP-Setup.exe');
  assert.ok(!/EPERM|errno/i.test(msg), '还是把 errno 原样给用户看了：' + msg);
  assert.match(msg, /占用|权限|安全软件|运行/, '没说出"文件被占着"这个真正的原因：' + msg);
  assert.match(msg, /BLFP-Setup\.exe/, '没告诉用户是哪个文件：' + msg);
  assert.match(dl.describeWriteError(Object.assign(new Error('x'), { code: 'ENOSPC' }), 'a.exe'), /空间/,
    '磁盘满了要明说磁盘满了');
});
