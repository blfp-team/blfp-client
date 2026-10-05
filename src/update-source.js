/**
 * 自家下载服务器（GitHub Releases 镜像）的接入。
 *
 * 为什么要有这个：
 *   客户端原来只从 GitHub 拉更新。国内连 GitHub API 经常超时，
 *   下载 256MB 的安装包更慢。用户在 47.103.142.240:8080 跑了一个
 *   blfp-release-mirror 服务（自动把 Releases 同步到本地），
 *   它就在国内，版本发现和下载都该优先走它。
 *
 * ⚠️ 最容易搞错的一点：**下载服务器不看渠道。**
 *   它的 /api/latest 返回的是"它手上最新的那个 release"，
 *   而它的配置里 includePrerelease 通常是 true —— 于是"最新"可能是预发布。
 *   正式渠道的用户如果直接采信它，就会被推去测试版。
 *   所以本模块必须自己按渠道过滤：正式渠道一律拒绝 prerelease:true。
 *
 * 服务器返回（实测，2026-10-03）：
 *   GET /api/latest
 *   {
 *     "tag": "v2.3.22-pre", "prerelease": true, "publishedAt": "...",
 *     "htmlUrl": "https://github.com/.../releases/tag/v2.3.22-pre",
 *     "alwaysLatestUrl": "http://.../latest",
 *     "files": [{
 *       "name": "BLFP-Setup-v2.3.22-pre.exe", "size": 269337952,
 *       "sha256": "...", "verified": true, "downloaded": true,
 *       "downloadUrl": "http://.../download/BLFP-Setup-v2.3.22-pre.exe",
 *       "directUrl":  "http://.../files/BLFP-Setup-v2.3.22-pre.exe",
 *       "sourceUrl":  "https://github.com/.../releases/download/..."
 *     }],
 *     "primaryDownloadUrl": "http://.../download/<file>",
 *     "directUrl": "http://.../files/<file>"
 *   }
 */

const { isPrerelease } = require('./version-lib');

/* 默认地址。可以用环境变量覆盖，换服务器不用重新打包。
   ⚠️ 必须是 https：这份 JSON 里带着"去哪儿下载安装包"，明文取等于把
   下载地址交给中间人改。客户端对自家服务器钉了证书（main.js 的 MIRROR_HOSTS），
   走 https 才能用上那个钉。 */
const DEFAULT_DOWNLOAD_SERVER = 'https://47.103.142.240:8443';

function downloadServerBase(explicit) {
  const raw = explicit || process.env.BLFP_UPDATE_SERVER || DEFAULT_DOWNLOAD_SERVER;
  return String(raw).replace(/\/+$/, '');
}

/** 取地址的主机名；不是 http(s) 绝对地址就返回 null */
function urlHost(raw) {
  if (!/^https?:\/\//i.test(String(raw || ''))) return null;
  try { return new URL(String(raw)).hostname.toLowerCase(); } catch (e) { return null; }
}

/**
 * 服务器给的绝对地址是不是指向"我们自己配的那台下载服务器"。
 *
 * 为什么必须查：这段 JSON 的来源是下载服务器，而服务器可以被换掉、被劫持、
 * 或者只是配错了。客户端拿到 downloadUrl 就直接下载的话，
 * 一个 `https://evil.example/x.exe`（攻击者用一张正常 CA 签的证书）就能装进用户机器 ——
 * 因为 updateFetch 只对 MIRROR_HOSTS 里的主机钉证书，别的主机退回全局 fetch。
 * 所以：主机跟配置的下载服务器不一致就**不信这个地址**，按 base 自己拼。
 */
function isOurDownloadHost(raw, base) {
  const h = urlHost(raw);
  if (!h) return false;
  const baseHost = urlHost(base) || urlHost(DEFAULT_DOWNLOAD_SERVER);
  return !!baseHost && h === baseHost;
}

function serverLatestUrl(base) {
  return downloadServerBase(base) + '/api/latest';
}

/* 支持断点续传的下载地址（服务器自己标的 primaryDownloadUrl 就是这个形态） */
function serverDownloadUrl(fileName, base) {
  return downloadServerBase(base) + '/download/' + encodeURIComponent(String(fileName || ''));
}

/* 挑出安装包：只要 .exe，排除校验文件与 blockmap */
function isInstallerAsset(name) {
  const n = String(name || '');
  return /\.exe$/i.test(n)
    && !/(blockmap|\.ya?ml$|sha256|\.sig$|uninstaller)/i.test(n)
    && /blfp|setup|installer/i.test(n);
}

/**
 * 从 /api/latest 的返回里挑出**适合该渠道**的安装包。
 *
 * 返回 null 的情况（调用方应回退 GitHub）：
 *   - 渠道是正式版，但服务器手上只有预发布
 *   - 没有可用的安装包，或安装包还没同步完（downloaded !== true）
 *   - 返回结构不认识
 */
function pickServerRelease(payload, options = {}) {
  const channel = options.channel === 'test' ? 'test' : 'stable';
  if (!payload || typeof payload !== 'object') return null;
  const tag = String(payload.tag || '').trim();
  if (!tag) return null;
  const version = tag.replace(/^v/i, '');
  if (!version) return null;

  /* 预发布判定以版本号为准，tag 上的 prerelease 字段只作参考 ——
     两边不一致时以版本号为准（跟 workflow 的判定方式一致）。 */
  const prerelease = isPrerelease(version) || payload.prerelease === true;
  if (channel === 'stable' && prerelease) return null;

  const files = Array.isArray(payload.files) ? payload.files : [];
  const usable = files.filter((f) => {
    if (!f || !isInstallerAsset(f.name)) return false;
    /* 还没下载完/校验没过的文件不能给用户，否则下到半个包 */
    if (f.downloaded === false) return false;
    if (f.verified === false) return false;
    return true;
  });
  if (!usable.length) return null;

  /* 地址优先级：服务器给的 downloadUrl → 自己拼的 /download/<文件名> → directUrl(/files/)。
     为什么把"自己拼"排在 directUrl 前面：/download/ 是支持 Range 断点续传的入口，
     而 /files/ 是静态直链，不一定支持。安装包 257MB，能续传很重要。

     ⚠️ 服务器给的地址必须先过 isOurDownloadHost：只有主机就是"我们配的那台"才采信，
     否则一律按 base 自己拼。见 isOurDownloadHost 上面的说明。 */
  const pick = usable.find((f) => isOurDownloadHost(f.downloadUrl, options.base)) || usable[0];
  const downloadUrl = isOurDownloadHost(pick.downloadUrl, options.base)
    ? pick.downloadUrl
    : serverDownloadUrl(pick.name, options.base);

  return {
    source: 'download-server',
    channel,
    prerelease,
    latestVersion: version,
    releaseName: tag,
    releaseNotes: '',
    releaseUrl: /^https?:\/\//i.test(payload.htmlUrl || '') ? payload.htmlUrl : null,
    publishedAt: payload.publishedAt || null,
    downloadUrl,
    assetName: pick.name || null,
    assetSize: typeof pick.size === 'number' ? pick.size : null,
    sha256: typeof pick.sha256 === 'string' ? pick.sha256 : null,
    /* 服务器自己的直链（/files/），下载失败时可当备用源 */
    directUrl: /^https?:\/\//i.test(pick.directUrl || '') ? pick.directUrl : null,
    /* 原始 GitHub 地址，最终兜底 */
    sourceUrl: /^https?:\/\//i.test(pick.sourceUrl || '') ? pick.sourceUrl : null,
  };
}

/**
 * 问一次下载服务器。任何异常都抛出，由调用方决定是否回退 GitHub
 * （本函数不吞异常：静默失败会让人以为"服务器没新版本"）。
 */
async function fetchServerRelease(options = {}) {
  const fetchImpl = options.fetchImpl || options.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('缺少 fetch 实现');
  const base = downloadServerBase(options.base);
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 8000;
  const log = typeof options.log === 'function' ? options.log : () => {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(serverLatestUrl(base), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('下载服务器返回 ' + res.status);
    const payload = await res.json();
    const picked = pickServerRelease(payload, { channel: options.channel, base });
    if (!picked) {
      log('下载服务器上没有适合当前渠道（' + (options.channel === 'test' ? '测试版' : '正式版') + '）的安装包');
      return null;
    }
    return picked;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_DOWNLOAD_SERVER,
  downloadServerBase,
  serverLatestUrl,
  serverDownloadUrl,
  isInstallerAsset,
  pickServerRelease,
  fetchServerRelease,
  isOurDownloadHost,
};
