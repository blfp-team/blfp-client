/*
 * 自家下载服务器接入的守卫。
 *
 * 服务：http://47.103.142.240:8080（blfp-release-mirror）
 * 它的 /api/latest 返回结构见 src/update-source.js 顶部注释（实测抓的）。
 *
 * 这里最要紧的一条是**渠道安全**：
 *   下载服务器不看渠道，它的"最新"可能就是预发布（实测时它就是 v2.3.22-pre）。
 *   正式渠道的用户如果直接采信它，就会被推去测试版 —— 这正是之前
 *   "没有正式版"那一类问题的另一种形态。所以必须有测试钉死这条。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const src = require(path.join(ROOT, 'src', 'update-source.js'));
const dl = require(path.join(ROOT, 'src', 'update-download.js'));
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

/* 实测抓下来的真实返回（照抄，别改结构 —— 改了就不是在测真实契约了） */
const REAL_PRE = {
  repo: 'blfp-team/blfp-client',
  tag: 'v2.3.22-pre',
  prerelease: true,
  publishedAt: '2026-10-02T08:52:59Z',
  htmlUrl: 'https://github.com/blfp-team/blfp-client/releases/tag/v2.3.22-pre',
  alwaysLatestUrl: 'http://47.103.142.240:8080/latest',
  fileCount: 1,
  files: [{
    name: 'BLFP-Setup-v2.3.22-pre.exe',
    size: 269337952,
    sha256: '6c05e24c3b59faeb8e8b1470f7507443ef400b64926eb5969a2d9b8037d24a32',
    verified: true,
    downloaded: true,
    status: 'skipped',
    downloadUrl: 'http://47.103.142.240:8080/download/BLFP-Setup-v2.3.22-pre.exe',
    directUrl: 'http://47.103.142.240:8080/files/BLFP-Setup-v2.3.22-pre.exe',
    sourceUrl: 'https://github.com/blfp-team/blfp-client/releases/download/v2.3.22-pre/BLFP-Setup-v2.3.22-pre.exe',
  }],
  primaryDownloadUrl: 'http://47.103.142.240:8080/download/BLFP-Setup-v2.3.22-pre.exe',
};

/* 正式版的返回结构：把预发布那份改几个字段构造出来 */
function stablePayload(overrides = {}) {
  const base = JSON.parse(JSON.stringify(REAL_PRE));
  base.tag = 'v2.3.22';
  base.prerelease = false;
  base.htmlUrl = 'https://github.com/blfp-team/blfp-client/releases/tag/v2.3.22';
  base.files[0].name = 'BLFP-Setup-v2.3.22.exe';
  base.files[0].downloadUrl = 'http://47.103.142.240:8080/download/BLFP-Setup-v2.3.22.exe';
  base.files[0].directUrl = 'http://47.103.142.240:8080/files/BLFP-Setup-v2.3.22.exe';
  base.files[0].sourceUrl = 'https://github.com/blfp-team/blfp-client/releases/download/v2.3.22/BLFP-Setup-v2.3.22.exe';
  return Object.assign(base, overrides);
}

/* ================= 渠道安全（最重要） ================= */

test('正式渠道必须拒绝预发布 —— 否则正式用户被推去测试版', () => {
  const picked = src.pickServerRelease(REAL_PRE, { channel: 'stable' });
  assert.equal(picked, null,
    '正式渠道采信了服务器上的预发布 —— 正式用户会被推去测试版。'
    + '下载服务器不看渠道，过滤必须由客户端做');
});

test('测试渠道接受预发布', () => {
  const picked = src.pickServerRelease(REAL_PRE, { channel: 'test' });
  assert.ok(picked, '测试渠道应该能用服务器上的预发布');
  assert.equal(picked.latestVersion, '2.3.22-pre');
  assert.equal(picked.prerelease, true);
  assert.equal(picked.assetName, 'BLFP-Setup-v2.3.22-pre.exe');
  assert.match(picked.downloadUrl, /\/download\/BLFP-Setup-v2\.3\.22-pre\.exe$/);
});

test('正式渠道遇到正式版就正常使用', () => {
  const picked = src.pickServerRelease(stablePayload(), { channel: 'stable' });
  assert.ok(picked, '正式渠道应该能用服务器上的正式版');
  assert.equal(picked.latestVersion, '2.3.22');
  assert.equal(picked.prerelease, false);
});

test('预发布判定以版本号为准，不只信 tag 上的 prerelease 字段', () => {
  /* 服务器把 prerelease 标成 false，但版本号里明明有 -pre：
     这种自相矛盾的数据不能让它溜进正式渠道 */
  const payload = stablePayload({ tag: 'v2.3.22-pre', prerelease: false });
  assert.equal(src.pickServerRelease(payload, { channel: 'stable' }), null,
    '版本号带 -pre 却因为 prerelease:false 被放进正式渠道 —— 判定必须以版本号为准');
});

/* ================= 不能给用户半个包 ================= */

test('还没同步完（downloaded:false）的文件不能给用户', () => {
  const payload = stablePayload();
  payload.files[0].downloaded = false;
  assert.equal(src.pickServerRelease(payload, { channel: 'stable' }), null,
    '把服务器上还没下载完的文件给了用户 —— 会下到半个安装包');
});

test('校验没过（verified:false）的文件不能给用户', () => {
  const payload = stablePayload();
  payload.files[0].verified = false;
  assert.equal(src.pickServerRelease(payload, { channel: 'stable' }), null,
    '把校验没过的文件给了用户 —— 装上去可能是坏的');
});

test('只认安装包，blockmap/校验文件/uninstaller 都不要', () => {
  assert.equal(src.isInstallerAsset('BLFP-Setup-v2.3.22.exe'), true);
  assert.equal(src.isInstallerAsset('BLFP-Setup-v2.3.22.exe.blockmap'), false);
  assert.equal(src.isInstallerAsset('latest.yml'), false);
  assert.equal(src.isInstallerAsset('SHA256SUMS.txt'), false);
  assert.equal(src.isInstallerAsset('BLFP-Uninstaller.exe'), false);
  assert.equal(src.isInstallerAsset('some-random.exe'), false);
});

/* ================= 地址解析 ================= */

test('下载地址优先用服务器给的 downloadUrl（带 /download/，支持断点续传）', () => {
  const picked = src.pickServerRelease(REAL_PRE, { channel: 'test' });
  assert.match(picked.downloadUrl, /^http:\/\/47\.103\.142\.240:8080\/download\//,
    '没有用服务器的 /download/ 地址 —— 那个才支持 Range 续传');
  assert.match(picked.directUrl, /\/files\//, '应该保留 /files/ 直链当备用源');
  assert.match(picked.sourceUrl, /^https:\/\/github\.com\//, '应该保留 GitHub 原链做最终兜底');
});

test('服务器没给 downloadUrl 时能自己拼出来', () => {
  const payload = stablePayload();
  delete payload.files[0].downloadUrl;
  const picked = src.pickServerRelease(payload, { channel: 'stable', base: 'http://x:1' });
  assert.equal(picked.downloadUrl, 'http://x:1/download/BLFP-Setup-v2.3.22.exe');
});

test('服务器地址可用环境变量覆盖（换服务器不用重新打包）', () => {
  const old = process.env.BLFP_UPDATE_SERVER;
  process.env.BLFP_UPDATE_SERVER = 'http://example.test:9000/';
  try {
    assert.equal(src.downloadServerBase(), 'http://example.test:9000');
    assert.equal(src.serverLatestUrl(), 'http://example.test:9000/api/latest');
  } finally {
    if (old === undefined) delete process.env.BLFP_UPDATE_SERVER;
    else process.env.BLFP_UPDATE_SERVER = old;
  }
  assert.equal(src.downloadServerBase(), src.DEFAULT_DOWNLOAD_SERVER);
});

test('结构不认识时返回 null，交给调用方回退 GitHub', () => {
  for (const bad of [null, undefined, {}, { tag: '' }, { tag: 'v2.3.22' }, { tag: 'v2.3.22', files: [] }]) {
    assert.equal(src.pickServerRelease(bad, { channel: 'stable' }), null,
      '结构不对却返回了东西：' + JSON.stringify(bad));
  }
});

/* ================= 下载源列表 ================= */

test('下载源里必须包含自家下载服务器，且它是"完整地址"型', () => {
  const i = MAIN.indexOf('function buildUpdateMirrors');
  assert.ok(i > 0, '找不到 buildUpdateMirrors');
  const body = MAIN.slice(i, i + 1600);
  assert.ok(/BLFP 下载服务器/.test(body), '下载源列表里没有自家下载服务器');
  assert.ok(/fullUrl:\s*serverDownloadUrl\(assetName,\s*base\)/.test(body),
    '下载服务器必须用 fullUrl 表达 —— 它的路径跟 GitHub 不同，套不上海外加速的前缀拼接');
  /* 关键：base 必须从主地址取，否则会往候选里塞写死的 http 地址，
     而 downloadWithFallback 内部不重新校验协议 = 明文下载后门 */
  assert.ok(/new URL\(primaryUrl\)\.origin/.test(body),
    '镜像候选没有跟随主地址的协议 —— 会在"只允许 https"的守卫旁边开明文后门');
});

test('完整地址型源能被解析出来（不能只支持前缀型）', () => {
  assert.equal(
    dl.resolveMirrorUrl({ name: 'x', fullUrl: 'http://a/b.exe' }, 'https://github.com/c/d.exe'),
    'http://a/b.exe');
  assert.equal(
    dl.resolveMirrorUrl({ name: 'y', prefix: 'https://ghfast.top/' }, 'https://github.com/c/d.exe'),
    'https://ghfast.top/https://github.com/c/d.exe');
  assert.equal(dl.resolveMirrorUrl({ name: 'z', prefix: '' }, 'https://github.com/c/d.exe'),
    'https://github.com/c/d.exe', '直连应该原样返回');
});

test('版本发现必须先问下载服务器，失败再回退 GitHub', () => {
  const i = MAIN.indexOf("ipcMain.handle('check-github-update'");
  assert.ok(i > 0, '找不到 check-github-update');
  const body = MAIN.slice(i, i + 1400);
  const serverAt = body.indexOf('fetchServerRelease');
  const githubAt = body.indexOf('GITHUB_RELEASE_API');
  assert.ok(serverAt > 0, '版本发现没有问下载服务器');
  assert.ok(githubAt > 0, '版本发现没有保留 GitHub 回退');
  assert.ok(serverAt < githubAt, '应该先问下载服务器再回退 GitHub（国内 GitHub API 经常连不上）');
});

/* 注释里提到 logLine 不该把断言弄红（踩过：断言被自己写的注释骗到）。
   captcha-recover.test.js 里有同样的处理。 */
function stripJsComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('主进程不能调用渲染层才有的 logLine（会在运行时直接抛）', () => {
  /* 实测事故：v2.4.0-pre 点「检查更新」直接报
     Error invoking remote method 'check-github-update':
     ReferenceError: logLine is not defined
     —— logLine 只定义在 renderer/app.js，主进程里根本没有。
     当时的 185 条测试全绿，因为它们只断言"代码结构"，没人真的执行过这段。
     同类错误在 app.js 那边犯过一次（见 captcha-ui.test.js 的守卫），这是第二次。 */
  const code = stripJsComments(MAIN);
  if (/function\s+logLine\b/.test(code)) return; /* main.js 自己定义了就不管 */
  assert.equal(/\blogLine\b/.test(code), false,
    "main.js 用了 logLine —— 它只在 renderer/app.js 里定义，主进程调用会抛 " +
    "ReferenceError: logLine is not defined，检查更新直接失败。" +
    "main.js 的日志约定是 console.log('[更新] ' + m)");
});


/* ================= 服务器给的下载地址不能照单全收 ================= */

/*
 * 真实存在的洞（v2.4.0-pre.7 之前）：
 *   客户端的更新元数据是**明文 HTTP** 取的（http://47.103.142.240:8080/api/latest），
 *   而那份 JSON 里的 downloadUrl 会被原样拿去下载，**完全不校验主机**。
 *   于是中间人只要污染那一次明文请求，塞一个
 *     "downloadUrl": "https://evil.example/BLFP-Setup.exe"
 *   就能让客户端从攻击者的机器上下载 —— 而 updateFetch 只对 MIRROR_HOSTS 里的主机
 *   钉证书，别的主机退回全局 fetch（系统 CA），攻击者用一张正常证书就通过了。
 *   之前那套 TLS + 钉证书被整个绕过，最终结果是用户机器上跑起攻击者的安装包。
 *
 * 两道修：元数据走 https（钉证书），并且只信"主机就是我们配的那台"的地址。
 */
test('下载地址的主机不是我们自己那台时，一律不信、按 base 自己拼', () => {
  const payload = {
    tag: 'v9.9.9',
    files: [{ name: 'BLFP-Setup-v9.9.9.exe', downloaded: true, verified: true,
              downloadUrl: 'https://evil.example/BLFP-Setup-v9.9.9.exe' }],
  };
  const r = src.pickServerRelease(payload, { channel: 'test', base: 'https://47.103.142.240:8443' });
  assert.ok(r, '不该整个丢掉这个版本（那样正式用户就收不到更新了）');
  assert.equal(/evil\.example/.test(r.downloadUrl), false,
    '把攻击者给的下载地址原样拿去用了：' + r.downloadUrl);
  assert.match(r.downloadUrl, /^https:\/\/47\.103\.142\.240:8443\/download\//,
    '应该按自己配的 base 重新拼地址，实际：' + r.downloadUrl);
});

test('自家下载服务器给的地址要原样采信（别把正常路径也堵死）', () => {
  const url = 'https://47.103.142.240:8443/download/BLFP-Setup-v9.9.9.exe';
  const payload = {
    tag: 'v9.9.9',
    files: [{ name: 'BLFP-Setup-v9.9.9.exe', downloaded: true, verified: true, downloadUrl: url }],
  };
  const r = src.pickServerRelease(payload, { channel: 'test', base: 'https://47.103.142.240:8443' });
  assert.equal(r.downloadUrl, url, '自家地址被改写了 —— 断点续传那个入口就白设了');
});

test('服务器一个地址都不给时，按 base 自己拼（老行为不能丢）', () => {
  const payload = { tag: 'v9.9.9', files: [{ name: 'BLFP-Setup-v9.9.9.exe', downloaded: true }] };
  const r = src.pickServerRelease(payload, { channel: 'test', base: 'https://47.103.142.240:8443' });
  assert.equal(r.downloadUrl, 'https://47.103.142.240:8443/download/BLFP-Setup-v9.9.9.exe');
});

test('默认下载服务器必须是 https —— 明文元数据等于把下载地址交给中间人', () => {
  assert.match(src.DEFAULT_DOWNLOAD_SERVER, /^https:\/\//,
    '默认地址是 ' + src.DEFAULT_DOWNLOAD_SERVER +
    '：这份 JSON 里带着"去哪儿下载安装包"，明文取的话中间人可以直接改掉它');
});

test('版本发现必须走 updateFetch（钉了证书），不能用全局 fetch', () => {
  const i = MAIN.indexOf("ipcMain.handle('check-github-update'");
  assert.ok(i > 0, '找不到 check-github-update');
  const body = MAIN.slice(i, i + 1600);
  const call = body.slice(body.indexOf('fetchServerRelease({'), body.indexOf('fetchServerRelease({') + 400);
  assert.ok(/fetchImpl:\s*updateFetch/.test(call),
    '问下载服务器时用的是全局 fetch —— 自签证书会被拒，于是只能退回明文 http；' +
    '而且别的主机会用系统 CA，中间人塞的地址骗得过去');
  assert.equal(/fetchImpl:\s*fetch\b/.test(call), false, '还在用全局 fetch');
});
