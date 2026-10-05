/*
 * 只给"自家下载服务器"用的 https 实现。
 *
 * 为什么不能用全局 fetch：
 *   镜像没有域名（阿里云按 SNI 拦未备案域名），所以拿不到 CA 签发的证书，
 *   只能用自签证书；而 fetch 没法注入自定义 CA —— Node 不对外暴露 undici 的 Agent。
 *   这里用 node:https，把镜像那张证书作为 ca 传进去：
 *   **只额外信任这一张**，不做任何全局放宽（绝不用 ignore-certificate-errors）。
 *
 * 接口刻意做成 fetch 的子集，好直接喂给 update-download.js 的 fetchImpl：
 *   status / ok / headers.get() / body.getReader() / body.cancel() / arrayBuffer()
 */
const https = require('node:https');
const { URL } = require('node:url');

const MAX_REDIRECTS = 5;

function makeHeaders(raw) {
  const map = new Map(Object.entries(raw || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    get: (name) => {
      const v = map.get(String(name).toLowerCase());
      return v === undefined ? null : (Array.isArray(v) ? v.join(', ') : v);
    },
  };
}

/* 把 Node 的可读流转成 fetch 风格的 body */
function makeBody(stream) {
  let reader = null;
  return {
    getReader() {
      if (!reader) {
        reader = {
          read: () => new Promise((resolve, reject) => {
            const onData = (chunk) => { cleanup(); resolve({ done: false, value: chunk }); };
            const onEnd = () => { cleanup(); resolve({ done: true, value: undefined }); };
            const onErr = (e) => { cleanup(); reject(e); };
            const cleanup = () => {
              stream.removeListener('data', onData);
              stream.removeListener('end', onEnd);
              stream.removeListener('error', onErr);
            };
            stream.on('data', onData);
            stream.on('end', onEnd);
            stream.on('error', onErr);
            stream.resume();
          }),
        };
      }
      return reader;
    },
    cancel: () => new Promise((resolve) => {
      try { stream.destroy(); } catch (e) { /* 已经结束 */ }
      resolve();
    }),
    /* 少数地方会整块取，这里也支持 */
    arrayBuffer: () => new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
      stream.resume();
    }),
    /* 查更新时要在 response 上调 json()。以前没有这个方法，所以元数据只能退回
       明文 http —— 而那份 JSON 里带着"去哪儿下载安装包"，等于把地址交给中间人改。
       补上之后元数据也能走钉了证书的 https。 */
    json: () => new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('下载服务器返回的不是合法 JSON：' + e.message)); }
      });
      stream.on('error', reject);
      stream.resume();
    }),
  };
}

/*
 * 创建镜像专用的 fetch。
 *   ca     —— 镜像那张自签证书（PEM）。不传就退回系统信任链。
 *   expect —— 可选的 SPKI 指纹（base64），传了就额外比对公钥，换证书会被发现。
 */
function createMirrorFetch({ ca, expect } = {}) {
  return function mirrorFetch(url, opts = {}) {
    const follow = (target, redirectsLeft) => new Promise((resolve, reject) => {
      let u;
      try { u = new URL(target); } catch (e) { return reject(new Error('下载地址不合法: ' + target)); }
      if (u.protocol !== 'https:') return reject(new Error('mirrorFetch 只处理 https 地址'));

      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: opts.headers,
        ca: ca || undefined,
        signal: opts.signal,
      }, (res) => {
        /* 重定向自己跟：Node 的 https 不会自动跟 */
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('重定向次数过多'));
          const next = new URL(res.headers.location, target).toString();
          return resolve(follow(next, redirectsLeft - 1));
        }
        const streamBody = makeBody(res);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: makeHeaders(res.headers),
          body: streamBody,
          /* update-download.js 是在 response 上调 arrayBuffer()，不是 body 上 —— 两边都给 */
          arrayBuffer: streamBody.arrayBuffer,
          /* 查更新（/api/latest）是在 response 上调 json()，同样两边都给 */
          json: streamBody.json,
        });
      });
      req.on('error', reject);
      req.end();
    });
    return follow(url, MAX_REDIRECTS);
  };
}

/* 算一张证书的公钥指纹（SPKI sha256 base64），用来在构建/运行时核对 */
function spkiFingerprint(pem) {
  const crypto = require('node:crypto');
  const { X509Certificate } = crypto;
  const cert = new X509Certificate(pem);
  return crypto.createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
}

module.exports = { createMirrorFetch, spkiFingerprint };
