/*
 * 镜像专用 https 实现的安全测试。
 *
 * 重点只有一条：**证书不对时必须拒绝下载**。
 * 这条要是松了，整个"自签证书 + 客户端钉证书"的方案就没有意义 ——
 * 等于谁都能冒充下载服务器塞一个安装包。
 * 所以用两张真证书跑真 TLS，而不是 mock。
 */
const test = require('node:test');
const assert = require('node:assert');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { createMirrorFetch, spkiFingerprint } = require('./mirror-fetch.js');

const FIX = path.join(__dirname, '__tls-fixtures__');
const serverCert = fs.readFileSync(path.join(FIX, 'test-server.crt'));
const serverKey = fs.readFileSync(path.join(FIX, 'test-server.key'));
const otherCert = fs.readFileSync(path.join(FIX, 'other-server.crt'));

function startTlsServer(handler) {
  return new Promise((resolve) => {
    const server = https.createServer({ cert: serverCert, key: serverKey }, handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const body = (text, status = 200, extra = {}) => (req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: '/file' });
    return res.end();
  }
  res.writeHead(status, { 'Content-Type': 'application/octet-stream', 'Content-Length': Buffer.byteLength(text), ...extra });
  res.end(text);
};

test('证书正确时能正常下载，并拿到 fetch 风格的对象', async () => {
  const srv = await startTlsServer(body('BLFP-INSTALLER-BYTES'));
  const mirrorFetch = createMirrorFetch({ ca: serverCert });
  try {
    const res = await mirrorFetch(`https://127.0.0.1:${srv.port}/file`);
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), String('BLFP-INSTALLER-BYTES'.length));
    const buf = await res.arrayBuffer();
    assert.equal(buf.toString(), 'BLFP-INSTALLER-BYTES');
  } finally {
    await srv.close();
  }
});

test('证书不匹配时必须拒绝（这是整个方案的安全底线）', async () => {
  const srv = await startTlsServer(body('MALICIOUS'));
  /* 拿另一张证书当 ca —— 相当于中间人换了一张证书 */
  const mirrorFetch = createMirrorFetch({ ca: otherCert });
  try {
    await assert.rejects(
      () => mirrorFetch(`https://127.0.0.1:${srv.port}/file`),
      (e) => /certificate|self.signed|unable to verify|UNABLE_TO_VERIFY/i.test(e.message || e.code || ''),
      '换了证书还下载成功 —— 钉证书形同虚设'
    );
  } finally {
    await srv.close();
  }
});

test('不给 ca 时，自签证书不该被系统信任链放行', async () => {
  const srv = await startTlsServer(body('X'));
  const mirrorFetch = createMirrorFetch({});
  try {
    await assert.rejects(
      () => mirrorFetch(`https://127.0.0.1:${srv.port}/file`),
      (e) => /certificate|self.signed|unable to verify/i.test(e.message || e.code || ''),
      '自签证书被默认信任了 —— 说明 ca 参数没生效'
    );
  } finally {
    await srv.close();
  }
});

test('会自己跟重定向（Node 的 https 不会自动跟）', async () => {
  const srv = await startTlsServer(body('AFTER-REDIRECT'));
  const mirrorFetch = createMirrorFetch({ ca: serverCert });
  try {
    const res = await mirrorFetch(`https://127.0.0.1:${srv.port}/redirect`);
    assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).toString(), 'AFTER-REDIRECT');
  } finally {
    await srv.close();
  }
});

test('支持 Range 断点续传（返回 206 且 ok 为真）', async () => {
  const srv = await startTlsServer((req, res) => {
    res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-3/100' });
    res.end('ABCD');
  });
  const mirrorFetch = createMirrorFetch({ ca: serverCert });
  try {
    const res = await mirrorFetch(`https://127.0.0.1:${srv.port}/file`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(res.status, 206);
    assert.equal(res.ok, true, '206 也算成功，否则断点续传会被当成失败');
    assert.equal((await res.arrayBuffer()).toString(), 'ABCD');
  } finally {
    await srv.close();
  }
});

test('明文 http 地址一律拒绝（不能被降级）', async () => {
  const mirrorFetch = createMirrorFetch({ ca: serverCert });
  await assert.rejects(
    () => mirrorFetch('http://127.0.0.1:8080/download/x.exe'),
    /只处理 https/,
    'http 地址必须拒绝'
  );
});

test('SPKI 指纹能区分两张证书（换证书必须被发现）', () => {
  const a = spkiFingerprint(serverCert);
  const b = spkiFingerprint(otherCert);
  assert.equal(a.length, 44, 'sha256 base64 指纹长度应为 44');
  assert.notEqual(a, b);
  assert.equal(spkiFingerprint(serverCert), a, '同一张证书指纹必须稳定');
});

/* ===== 接线守卫 =====
   "只允许 https"这条守卫在 start-update 里，但下载候选列表是另算的。
   如果候选里混进一个 http 地址，downloadWithFallback 内部不会重新校验协议，
   等于在守卫旁边开了个明文后门。 */
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const { serverDownloadUrl } = require('./update-source.js');

test('镜像候选地址必须跟随主地址的协议，不能写死 http', () => {
  /* 行为：给了 https base 就该拼出 https 地址 */
  const httpsUrl = serverDownloadUrl('BLFP-Setup-v1.exe', 'https://47.103.142.240:8443');
  assert.match(httpsUrl, /^https:\/\/47\.103\.142\.240:8443\/download\//);
  assert.equal(httpsUrl.includes('http://'), false, '不能拼出明文地址');
});

test('main.js 的镜像候选基于主地址 origin，而不是写死的下载服务器地址', () => {
  const i = MAIN.indexOf('function buildUpdateMirrors');
  assert.ok(i > 0, '找不到 buildUpdateMirrors');
  const body = MAIN.slice(i, MAIN.indexOf('\n}', i));
  assert.match(body, /new URL\(primaryUrl\)/,
    'buildUpdateMirrors 没有用主地址 —— 会往候选里塞写死的 http 地址');
  assert.match(body, /\.origin/,
    'buildUpdateMirrors 没有取主地址的 origin —— 会往候选里塞写死的 http 地址');
  assert.match(body, /buildUpdateMirrors\(assetName, url\)|buildUpdateMirrors\(assetName/,
    'buildUpdateMirrors 的签名应接收主地址');
  /* 调用点必须把主地址传进去，否则 origin 取不到 */
  assert.match(MAIN, /buildUpdateMirrors\(assetName,\s*url\)/,
    '调用 buildUpdateMirrors 时没有传主地址 url');
});

/* 注释里提到 ignore-certificate-errors 不该让断言变红（踩过：断言被自己的注释骗到）。
   captcha-recover.test.js 里有同样的处理。 */
function stripJsComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('镜像主机走专用的 https 实现（能校验自签证书），其它源不受影响', () => {
  const code = stripJsComments(MAIN);
  assert.match(code, /MIRROR_HOSTS/, '没有维护镜像主机白名单');
  assert.match(code, /createMirrorFetch\(\{\s*ca\s*\}\)/, '没有用镜像证书创建专用 fetch');
  /* 绝不能图省事全局关掉证书校验 —— 那等于对所有源都关掉了校验 */
  assert.equal(/ignore-certificate-errors|rejectUnauthorized:\s*false/.test(code), false,
    '出现了全局放宽证书校验的写法 —— 那等于对所有源都关掉了校验');
});

test('随包发布的镜像证书与预期一致（换证书必须是有意的改动）', () => {
  const pem = fs.readFileSync(path.join(__dirname, '..', 'assets', 'blfp-mirror-ca.pem'), 'utf8');
  /* 钉死指纹：证书文件被误替换、或者镜像换了证书而客户端没跟着发版，
     都必须在这里就红，而不是等用户更新失败 */
  assert.equal(spkiFingerprint(pem), 'sMKjRr/5jz+6aDAlrakP6e7wGeaB6OZthUPdjphHMWA=',
    '镜像证书变了 —— 确认是有意更换后，同步更新这里的指纹');

  const { X509Certificate } = require('node:crypto');
  const cert = new X509Certificate(pem);
  assert.match(cert.subject, /blfp-mirror/);
  /* 客户端连的是 IP，所以证书 SAN 里必须有这个 IP，否则主机名校验过不了 */
  assert.match(cert.subjectAltName || '', /IP Address:47\.103\.142\.240/,
    '证书 SAN 里没有镜像 IP —— 客户端连 IP 时会被主机名校验拒绝');
  assert.ok(new Date(cert.validTo) > new Date('2031-01-01'),
    '证书有效期太短：换证书要跟着发客户端，别给自己找麻烦');
});

/*
 * 为什么镜像 fetch 必须支持 json()：
 *   更新元数据（/api/latest）里带着"去哪儿下载安装包"。以前这个方法不存在，
 *   元数据只能退回**明文 http** 取 —— 中间人把 downloadUrl 换成自己的机器，
 *   客户端就会去装他的包。补上 json() 之后元数据也能走这条钉了证书的 https。
 */
test('响应支持 json()，元数据才能走钉了证书的 https', async () => {
  const payload = { tag: 'v9.9.9', files: [{ name: 'BLFP-Setup-v9.9.9.exe', downloaded: true }] };
  const srv = await startTlsServer((req, res) => {
    const text = JSON.stringify(payload);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  });
  const mirrorFetch = createMirrorFetch({ ca: serverCert });
  try {
    const res = await mirrorFetch(`https://127.0.0.1:${srv.port}/api/latest`);
    const got = await res.json();
    assert.deepEqual(got, payload,
      'response.json() 拿不到结果 —— 元数据就只能退回明文 http，钉证书白做');
  } finally {
    await srv.close();
  }
});

test('json() 遇到非 JSON 要抛错，不能静默当空对象', async () => {
  const srv = await startTlsServer(body('<html>502 Bad Gateway</html>'));
  const mirrorFetch = createMirrorFetch({ ca: serverCert });
  try {
    const res = await mirrorFetch(`https://127.0.0.1:${srv.port}/api/latest`);
    await assert.rejects(() => res.json(), /JSON/,
      '静默返回空会被上层当成"服务器上没有新版本"，用户就收不到更新了');
  } finally {
    await srv.close();
  }
});
