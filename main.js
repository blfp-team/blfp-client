const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const { scanJavaPorts } = require('./src/port-scanner');
const FrpcManager = require('./src/frpc-manager');
const MotdBroadcaster = require('./src/motd-broadcast');
const McStatusProxy = require('./src/mc-status-proxy');
const { createMirrorFetch } = require('./src/mirror-fetch');
const EasyTierManager = require('./src/easytier-manager');
const { downloadWithFallback } = require('./src/update-download');
const { fetchServerRelease, serverDownloadUrl } = require('./src/update-source');
const { startSilentInstaller } = require('./src/update-launch');

/* 后台/遮挡时不挂起渲染，避免恢复窗口后出现黑屏 */
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');

const GITHUB_RELEASE_API = 'https://api.github.com/repos/blfp-team/blfp-client/releases/latest';
let mainWindow;
/* 布局调试器的独立窗口（仅 PRE 版带调试器时才会创建）。
   独立窗口的好处：主窗口可以随便切页面、开关弹窗，调试器始终在旁边可见可操作，
   而且调试器自己的样式不会污染被测界面。 */
let tunerWindow = null;
let frpcMgr = new FrpcManager();
let motdBroadcaster = new MotdBroadcaster();
let easyTierMgr = new EasyTierManager(app);

// 获取本机局域网 IPv4 地址（供复制连接IP用）
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name]) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}


/* ====== Windows 防火墙自动放行（虚拟网卡属"公用网络"时会拦截入站，导致访客连不上）====== */
function ensureFirewallRules() {
  if (process.platform !== 'win32') return;
  const { execFile } = require('child_process');
  const path = require('path');
  const ruleName = 'BLFP 联机助手';
  execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + ruleName], (err, stdout) => {
    if (!err && stdout && stdout.includes(ruleName)) return;   /* 已存在 */
    const targets = [
      process.execPath,
      path.join(process.resourcesPath || '', 'bin', 'easytier-core.exe'),
      path.join(process.resourcesPath || '', 'bin', 'frpc.exe'),
    ].filter((p) => { try { return require('fs').existsSync(p); } catch (e) { return false; } });
    if (!targets.length) return;
    let done = 0;
    targets.forEach((exe) => {
      execFile('netsh', ['advfirewall', 'firewall', 'add', 'rule', 'name=' + ruleName, 'dir=in', 'action=allow', 'program=' + exe, 'enable=yes', 'profile=any'], () => {
        done += 1;
        if (done === targets.length) console.log('[BLFP] 防火墙规则已添加（放行 ' + targets.length + ' 个程序）');
      });
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 860,
    minHeight: 600,
    title: 'BLFP 联机助手',
    frame: false,                 /* 无原生边框，标题栏完全由 HTML 自己画 */
    titleBarStyle: 'hidden',
    /* 不使用系统 titleBarOverlay——否则会和 HTML 自定义标题栏叠成两条 */
    /* 立即显示：不再等 ready-to-show，否则启动时会有一段"什么都没有"的空档期。
       深色 backgroundColor 保证出现瞬间不白屏，界面随首个绘制帧补上。 */
    show: true,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
  });
  /* 后台久了黑屏的自愈：恢复/聚焦/显示时强制重绘并通知渲染进程 */
  let lastHiddenAt = 0;
  function repaintWindow(force) {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) return;
      mainWindow.webContents.invalidate();
      mainWindow.webContents.send('force-repaint');
      /* 长时间后台（>2 分钟）后仅靠 invalidate 有时仍留黑帧，
         做一次肉眼不可见的 1px 尺寸抖动强制重建合成层 */
      const hiddenFor = lastHiddenAt ? Date.now() - lastHiddenAt : 0;
      if (force || hiddenFor > 120000) {
        const [w, h] = mainWindow.getSize();
        mainWindow.setSize(w, h + 1);
        setTimeout(() => {
          try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setSize(w, h); } catch (e) {}
        }, 60);
      }
      lastHiddenAt = 0;
    } catch (e) {}
  }
  /* 窗口已在创建时立即显示；这里只做一次补充重绘，确保首帧内容到位 */
  mainWindow.once('ready-to-show', () => {
    try { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); repaintWindow(true); } } catch (e) {}
  });

  /* 后台自动降进程优先级（防止挂在后台时抢占鼠标/UI 响应） */
  const os = require('os');
  function lowerPriority() {
    try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) {}
  }
  function normalPriority() {
    try { os.setPriority(process.pid, os.constants.priority.PRIORITY_NORMAL); } catch (e) {}
  }
  mainWindow.on('hide', () => { lastHiddenAt = Date.now(); lowerPriority(); });
  mainWindow.on('minimize', () => { lastHiddenAt = Date.now(); lowerPriority(); });
  mainWindow.on('show', () => { normalPriority(); repaintWindow(true); setTimeout(() => repaintWindow(true), 300); });
  mainWindow.on('restore', () => { normalPriority(); repaintWindow(true); setTimeout(() => repaintWindow(true), 300); });
  mainWindow.on('focus', () => { normalPriority(); repaintWindow(); });
  mainWindow.on('blur', () => {
    // 失焦且被遮挡时也降（Electron occlusion 检测）
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) lowerPriority();
  });
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
  mainWindow.on('unresponsive', () => {
    console.error('[BLFP] 界面无响应，尝试重绘');
    repaintWindow();
  });
  /* 长时间后台后 GPU 进程可能被回收，重新载入界面即可恢复（登录态在 localStorage，不会丢） */
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process exited:', details.reason);
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error('Renderer failed to load:', {
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
    });
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level === 3) {
      console.error('Renderer console error:', { message, line, sourceId });
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

/* 从睡眠/休眠恢复后同样可能黑屏 */
try {
  require('electron').powerMonitor.on('resume', () => {
    try { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.webContents.invalidate(); mainWindow.webContents.send('force-repaint'); } } catch (e) {}
  });
} catch (e) {}

app.whenReady().then(() => {
  createWindow();
  ensureFirewallRules();
});
let quitting = false;

// 退出前先释放代理端口并停止 EasyTier 子进程
async function stopServices() {
  frpcMgr.stop();
  motdBroadcaster.stop();
  await easyTierMgr.stop();
}

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  stopServices().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());

/* ====== 布局调试器的独立窗口 ====== */
const TUNER_HTML = path.join(__dirname, 'renderer', 'layout-tuner-window.html');

function openTunerWindow() {
  /* 已开着就聚焦，不重复创建 */
  if (tunerWindow && !tunerWindow.isDestroyed()) {
    if (tunerWindow.isMinimized()) tunerWindow.restore();
    tunerWindow.focus();
    return { ok: true, reused: true };
  }
  tunerWindow = new BrowserWindow({
    width: 420,
    height: 760,
    minWidth: 340,
    minHeight: 420,
    title: '布局调试器',
    /* 用原生边框：调试器是工具窗口，需要能拖动/缩放/最小化，
       无边框会让它和主窗口的视觉混在一起不好辨认 */
    frame: true,
    show: false,
    backgroundColor: '#12141c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
  });
  tunerWindow.loadFile(TUNER_HTML);
  tunerWindow.once('ready-to-show', () => {
    try { if (tunerWindow && !tunerWindow.isDestroyed()) tunerWindow.show(); } catch (e) {}
  });
  tunerWindow.on('closed', () => {
    tunerWindow = null;
    /* 通知主窗口：调试器关了，把高亮/拾取等临时状态清掉 */
    try { mainWindow?.webContents.send('tuner-window-closed'); } catch (e) {}
  });
  return { ok: true, reused: false };
}

function closeTunerWindow() {
  if (tunerWindow && !tunerWindow.isDestroyed()) tunerWindow.close();
  tunerWindow = null;
  return { ok: true };
}

/* 主窗口 → 调试器窗口 的单向转发（选中的元素信息、样式快照等）。
   调试器窗口不在时静默忽略，不报错。
   注意通道分工，避免两边互相回环：
     tuner-cmd   调试器 → 主窗口（下发指令）
     tuner-data  主窗口 → 调试器（上报数据） */
function sendToTuner(channel, payload) {
  try {
    if (tunerWindow && !tunerWindow.isDestroyed()) tunerWindow.webContents.send('tuner-data', { channel, payload });
  } catch (e) {}
}

ipcMain.handle('tuner-open', () => openTunerWindow());
ipcMain.handle('tuner-close', () => closeTunerWindow());
ipcMain.handle('tuner-is-open', () => Boolean(tunerWindow && !tunerWindow.isDestroyed()));
/* 调试器窗口 → 主窗口 的指令转发（例如"选中某个元素""把某界面显示出来"） */
ipcMain.handle('tuner-to-main', (_e, channel, payload) => {
  try { mainWindow?.webContents.send('tuner-cmd', { channel, payload }); } catch (e) {}
  return { ok: true };
});
/* 主窗口 → 调试器窗口 的信息上报 */
ipcMain.on('main-to-tuner', (_e, channel, payload) => sendToTuner(channel, payload));

// ====== IPC: 应用信息与安全外链 ======
ipcMain.handle('get-app-info', async () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
}));
ipcMain.handle('open-external', async (_e, url) => {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return { ok: false, error: '仅允许打开 HTTPS 链接' };
  await shell.openExternal(url);
  return { ok: true };
});
/* ==================== 软件内更新：自己下载 + 静默安装 ====================
 *
 * 用户要的效果：点更新 → 软件内出现进度条 → 自动挑一个能用的镜像源下载 →
 * 全程不出现安装程序界面 → 装完第一时间把客户端拉起来。
 *
 * 怎么做：
 *   1. 用 src/update-download.js 挑源 + 下载（带进度、坏了自动换源）
 *   2. 下载完把安装程序以**隐藏的静默参数**拉起来（--blfp-silent-update），
 *      安装器收到这个参数后完全不建窗口，在后台把活干完
 *   3. 客户端立刻退出 —— 必须退，否则 BLFP.exe 被占用，安装器写不进去
 *      （安装器那边也有等待解锁的兜底，两边都做才稳）
 *
 * 注意：安装器**只有**在被这样带参调用时才是无头的；
 * 用户自己双击安装器仍然是正常的图形界面安装。
 */
function buildUpdateMirrors(assetName, primaryUrl) {
  /* 源的顺序只是"初始顺序"，真正用哪个是按实测速度排的 ——
     所以"自动选择能用的镜像源"是真的测过再选，而不是写死顺序。 */
  const mirrors = [
    { name: 'GitHub 直连', prefix: '' },
    { name: 'ghfast.top', prefix: 'https://ghfast.top/' },
    { name: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
    { name: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
  ];
  /* 自家下载服务器：它在国内，通常比所有 GitHub 加速都快。
     它属于"完整地址"型源（路径是 /download/<文件名>，套不上海外加速的前缀拼接），
     所以用 fullUrl 而不是 prefix。下载失败会自动落到下面的其它源。

     ⚠️ base 必须取**主地址的 origin**，不能再用写死的 http 那个：
     downloadWithFallback 内部不会重新校验协议，塞一个 http 进去
     等于在"只允许 https"的守卫旁边开了个明文后门。 */
  if (assetName) {
    let base;
    try { base = new URL(primaryUrl).origin; } catch (e) { base = undefined; }
    mirrors.unshift({ name: 'BLFP 下载服务器', fullUrl: serverDownloadUrl(assetName, base) });
  }
  return mirrors;
}

/*
 * 更新下载用的 fetch。
 *
 * 自家下载服务器没有域名（阿里云按 SNI 拦未备案域名），拿不到 CA 签发的证书，
 * 只能用自签证书。全局 fetch 没法注入自定义 CA，所以对镜像那台主机改用
 * node:https 实现（src/mirror-fetch.js），**只额外信任镜像那一张证书**。
 *
 * 其它源（GitHub 直连、各家加速）照常走系统信任链，不做任何放宽 ——
 * 绝不能图省事去开 ignore-certificate-errors，那等于对所有源都关掉校验。
 */
const MIRROR_HOSTS = new Set(['47.103.142.240']);

function loadMirrorCa() {
  try {
    return fs.readFileSync(path.join(__dirname, 'assets', 'blfp-mirror-ca.pem'), 'utf8');
  } catch (e) {
    /* 还没装镜像证书：镜像的 https 会连不上（自签不被信任），
       但其它源不受影响，更新仍然能走通 */
    return null;
  }
}

const mirrorFetchImpl = (() => {
  const ca = loadMirrorCa();
  if (!ca) return null;
  try {
    return createMirrorFetch({ ca });
  } catch (e) {
    console.error('[更新] 镜像证书加载失败，将不使用自建下载服务器：', e.message);
    return null;
  }
})();

function updateFetch(url, opts) {
  try {
    const parsed = new URL(url);
    if (mirrorFetchImpl && parsed.protocol === 'https:' && MIRROR_HOSTS.has(parsed.hostname)) {
      return mirrorFetchImpl(url, opts);
    }
  } catch (e) { /* 地址不合法就交给下面的 fetch 去报错 */ }
  return fetch(url, opts);
}

/* 安装程序放在临时目录；同名会覆盖，避免堆积一堆 200MB 的安装包 */
function updateInstallerPath(assetName) {
  const safe = String(assetName || 'BLFP-Setup.exe').replace(/[^\w.\-]+/g, '_');
  return path.join(app.getPath('temp'), safe);
}

/* 上次更新的结果记录在这里（安装器写、客户端启动时读）。
   放在 userData 下：同一个用户、同一个客户端，重启后一定读得到。 */
function updateStatusFile() {
  return path.join(app.getPath('userData'), 'update-status.json');
}

/* 客户端自己的安装目录 = BLFP.exe 所在目录 */
function currentInstallDir() {
  return path.dirname(app.getPath('exe'));
}

ipcMain.handle('start-update', async (evt, opts) => {
  const url = opts && opts.url;
  const assetName = opts && opts.assetName;
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
    return { ok: false, error: '没有可用的下载地址' };
  }
  const sender = evt && evt.sender;
  const send = (payload) => { try { sender.send('update-progress', payload); } catch (e) {} };

  try {
    const dest = updateInstallerPath(assetName);
    /* 上次留下的半截文件会让"完整性检查"误判，先清掉 */
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (e) {}

    send({ phase: 'probe', percent: 0, text: '正在选择下载源…' });
    const result = await downloadWithFallback({
      url,
      dest,
      fsImpl: fs,
      fetchImpl: updateFetch,
      mirrors: buildUpdateMirrors(assetName, url),
      onProgress: (p) => send({ phase: 'download', percent: p.percent, received: p.received, total: p.total }),
      log: (m) => console.log('[更新] ' + m),
    });
    if (!result.ok) {
      send({ phase: 'error', percent: 0, text: result.error });
      return { ok: false, error: result.error, attempts: result.attempts };
    }

    const mb = Math.round(result.bytes / 1048576);
    send({ phase: 'install', percent: 100, text: `下载完成（${result.mirror}，${mb} MB），正在后台安装…` });

    /* 用隐藏的静默参数拉起安装器：不弹界面，由它在后台关客户端、装文件、再拉起来。
       必须确认真起来了才允许退出客户端 —— 客户端自己没提权时，
       spawn 一个 requireAdministrator 的 exe 不会弹 UAC，而是异步报 EACCES；
       老实现没人监听这个错误，于是"没启动"和"启动成功"长得一模一样，
       客户端照样退出 → 用户看到的就是"点更新，软件没了"。
       startSilentInstaller 内部：直接 spawn 并观察 → 不行退回 UAC 提权 → 都不行如实报错。 */
    const installDir = currentInstallDir();
    const launched = await startSilentInstaller({
      installerPath: dest,
      targetDir: installDir,
      /* 让安装器把进度与结果写到固定位置。客户端马上就退出了，
         装完之后不管成功失败都要靠这个文件知道发生了什么 ——
         尤其是失败：不然用户只会看到"软件关了再也没回来"。 */
      statusFile: updateStatusFile(),
      spawnImpl: spawn,
      log: (m) => console.log('[更新] ' + m),
    });
    if (!launched.ok) {
      /* 没起来就绝对不要退出客户端：退出去用户就只能重装了 */
      const message = launched.error || '启动安装程序失败';
      send({ phase: 'error', percent: 0, text: message });
      return { ok: false, error: message };
    }

    send({ phase: 'restart', percent: 100, text: '安装程序已在后台运行，界面会短暂关闭后自动重启…' });
    /* 必须尽快退出：不退的话 BLFP.exe 一直占着文件，安装器写不进去 */
    setTimeout(() => {
      try { app.exit(0); } catch (e) { process.exit(0); }
    }, 250);
    return { ok: true, mirror: result.mirror, bytes: result.bytes, method: launched.method };
  } catch (e) {
    const message = (e && e.message) || String(e);
    send({ phase: 'error', percent: 0, text: message });
    return { ok: false, error: message };
  }
});

/*
 * 读取"上次软件内更新的结果"。
 * 安装器失败时会把客户端原样拉回来，这时用户需要一个交代 ——
 * 否则他看到的只是"软件自己关了一下又开了"，完全不知道更新失败了。
 * 读一次就删掉，避免每次启动都弹。
 */
ipcMain.handle('read-update-status', async () => {
  const file = updateStatusFile();
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    try { fs.unlinkSync(file); } catch (e) {}
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('check-github-update', async (_e, channel) => {
  /* 更新渠道：'stable'（正式版，只拉最新正式 release）| 'test'（测试版，拉最新 release，含 pre 测试版）
     GitHub 的 /releases/latest 永远不会返回 pre-release，所以测试渠道必须列全量再挑。 */
  const wantBeta = channel === 'test';
  /* 先问自家下载服务器：它在国内、快，而且 GitHub API 在国内经常连不上。
     ⚠️ 但它**不看渠道**（它的"最新"可能就是预发布），
     所以过滤交给 fetchServerRelease —— 正式渠道一律拒绝预发布，
     否则正式用户会被推去测试版。它挑不出合适的就返回 null，我们回退 GitHub。 */
  try {
    const fromServer = await fetchServerRelease({
      fetchImpl: fetch,
      channel: wantBeta ? 'test' : 'stable',
      log: (m) => console.log('[更新] ' + m),
    });
    if (fromServer) {
      console.log('[更新] 更新来源：BLFP 下载服务器 ' + fromServer.latestVersion);
      return fromServer;
    }
  } catch (e) {
    console.log('[更新] 下载服务器不可用，回退 GitHub：' + ((e && e.message) || e));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const url = wantBeta
      ? 'https://api.github.com/repos/blfp-team/blfp-client/releases?per_page=30'
      : GITHUB_RELEASE_API;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `BLFP-Client/${app.getVersion()}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (response.status === 404) throw new Error('仓库尚未发布 Release');
    if (response.status === 403 || response.status === 429) throw new Error('GitHub API 请求受限，请稍后再试');
    if (!response.ok) throw new Error(`GitHub 更新检查失败 (${response.status})`);
    const body = await response.json();
    let release;
    if (wantBeta) {
      const list = (Array.isArray(body) ? body : []).filter((r) => !r.draft);
      if (!list.length) throw new Error('仓库尚未发布 Release');
      /* 按版本号取最高（含 pre-release），与客户端 compareVersions 语义一致 */
      release = list.reduce((best, r) =>
        (compareVersions(String(r.tag_name || '').replace(/^v/i, ''), String(best.tag_name || '').replace(/^v/i, '')) > 0 ? r : best));
    } else {
      release = body;
    }
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const candidates = assets.filter((asset) => {
      const name = String(asset.name || '');
      return /\.exe$/i.test(name) && !/(blockmap|\.ya?ml$|sha256|\.sig$)/i.test(name)
        && /^https:\/\//i.test(asset.browser_download_url || '');
    });
    candidates.sort((a, b) => {
      const score = (asset) => /blfp/i.test(asset.name) * 4 + /setup/i.test(asset.name) * 2 + /installer/i.test(asset.name);
      return score(b) - score(a);
    });
    const isPrerelease = release.prerelease === true || /-[0-9A-Za-z]/.test(String(release.tag_name || '').replace(/^v/i, ''));
    return {
      channel: wantBeta ? 'test' : 'stable',
      prerelease: isPrerelease,
      latestVersion: String(release.tag_name || '').replace(/^v/i, ''),
      releaseName: release.name || release.tag_name || '',
      releaseNotes: release.body || '',
      releaseUrl: /^https:\/\//i.test(release.html_url || '') ? release.html_url : null,
      publishedAt: release.published_at || null,
      downloadUrl: candidates[0]?.browser_download_url || null,
      assetName: candidates[0]?.name || null,
    };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接 GitHub 超时，请稍后重试');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
});

/* 与 renderer/app.js 的 compareVersions 同一语义：用于测试渠道挑最高版本（含 pre） */
function compareVersions(a, b) {
  const parse = (value) => {
    const [core, pre = ''] = String(value || '').trim().replace(/^v/i, '').split('-', 2);
    return { core: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre.split('.').filter(Boolean) };
  };
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    if ((pa.core[i] || 0) !== (pb.core[i] || 0)) return (pa.core[i] || 0) > (pb.core[i] || 0) ? 1 : -1;
  }
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    if (pa.pre[i] === undefined || pb.pre[i] === undefined) return pa.pre[i] === undefined ? -1 : 1;
    if (pa.pre[i] === pb.pre[i]) continue;
    const an = /^\d+$/.test(pa.pre[i]), bn = /^\d+$/.test(pb.pre[i]);
    if (an && bn) return Number(pa.pre[i]) > Number(pb.pre[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return pa.pre[i].localeCompare(pb.pre[i]) > 0 ? 1 : -1;
  }
  return 0;
}// ====== IPC: 本机局域网 IP ======
ipcMain.handle('get-lan-ip', async () => getLanIp());

// ====== IPC: 自定义标题栏窗口控制 ======
ipcMain.handle('window-minimize', () => { if (mainWindow) mainWindow.minimize(); return { ok: true }; });
ipcMain.handle('window-maximize', () => {
  if (!mainWindow) return { ok: false };
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return { ok: true, maximized: mainWindow.isMaximized() };
});
ipcMain.handle('window-is-maximized', () => (mainWindow ? mainWindow.isMaximized() : false));
ipcMain.handle('window-close', () => { if (mainWindow) mainWindow.close(); return { ok: true }; });

// ====== IPC: 窗口三按钮跟随主题（任务1）======
// titleBarOverlay 颜色只能在主进程实时改，渲染进程切换主题时通过这里同步
ipcMain.handle('set-titlebar-overlay', async (_e, theme) => {
  if (!mainWindow) return { ok: false };
  const light = theme === 'light';
  try {
    if (typeof mainWindow.setTitleBarOverlay !== 'function') return { ok: false };
    mainWindow.setTitleBarOverlay({
      color: light ? '#f3f4f6' : '#000000',
      symbolColor: light ? '#17181c' : '#ffffff',
      height: 36,
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// ====== IPC: 退出软件（功能5）======
ipcMain.handle('set-custom-titlebar', async (_e, opts) => {
    // 自定义标题栏：文本 / 图片 / 混合
    if (!mainWindow) return false;
    const data = typeof opts === 'string' ? JSON.parse(opts) : (opts || {});
    mainWindow.webContents.send('titlebar-customized', {
      text: data.text || '',
      image: data.image || '',
      mode: data.mode || 'text'
    });
    return true;
  });
  ipcMain.handle('set-custom-background', async (_e, opts) => {
    if (!mainWindow) return false;
    const data = typeof opts === 'string' ? JSON.parse(opts) : (opts || {});
    mainWindow.webContents.send('background-customized', {
      image: data.image || '',
      color: data.color || '',
      blur: data.blur ?? 0
    });
    return true;
  });
  /* 渲染进程的日志写入文件（此前日志只在界面里，PS 打开的是空文件） */
  const LOG_PATH = require('path').join(process.env.APPDATA || process.env.HOME || '.', 'BLFP', 'logs', 'blfp.log');
  const MAX_LOG_BYTES = 2 * 1024 * 1024;
  function ensureLogDir() {
    const dir = require('path').dirname(LOG_PATH);
    require('fs').mkdirSync(dir, { recursive: true });
    if (!require('fs').existsSync(LOG_PATH)) {
      require('fs').writeFileSync(LOG_PATH, '=== BLFP 运行日志 ===\r\n');
    }
  }
  ipcMain.handle('append-log', async (_e, lines) => {
    try {
      ensureLogDir();
      const text = Array.isArray(lines) ? lines.join('\r\n') : String(lines == null ? '' : lines);
      if (!text) return { ok: true };
      /* 超过 2MB 时轮转，避免无限增长 */
      try {
        if (require('fs').statSync(LOG_PATH).size > MAX_LOG_BYTES) {
          require('fs').writeFileSync(LOG_PATH, '=== BLFP 运行日志（已轮转）===\r\n');
        }
      } catch (e) {}
      require('fs').appendFileSync(LOG_PATH, text + '\r\n');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('open-log-external', async () => {
    try {
      ensureLogDir();
      const path = require('path');
      const childProcess = require('child_process');

      if (process.platform !== 'win32') {
        /* 非 Windows：直接调系统终端 */
        if (process.platform === 'darwin') childProcess.spawn('open', ['-a', 'Terminal', LOG_PATH], { detached: true }).unref();
        else childProcess.spawn('x-terminal-emulator', ['-e', 'tail', '-f', LOG_PATH], { detached: true }).unref();
        return { ok: true, logPath: LOG_PATH };
      }

      /* 关键：把脚本写入 .ps1 文件再用 -File 调用。
         之前用 -Command 传内联脚本（含中文/引号/$/分号）会被参数转义破坏，
         PowerShell 一闪即退，表现为"根本打不开 PS"。 */
      const scriptPath = path.join(path.dirname(LOG_PATH), 'view-log.ps1');
      const script = [
        '$OutputEncoding = [System.Text.Encoding]::UTF8',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$host.UI.RawUI.WindowTitle = "BLFP 实时日志"',
        'Write-Host "=== BLFP 实时日志 ===" -ForegroundColor Cyan',
        'Write-Host ("日志文件: ' + LOG_PATH.replace(/\\/g, '\\\\') + '") -ForegroundColor DarkGray',
        'Write-Host "按 Ctrl+C 停止跟随，关闭窗口即可退出。" -ForegroundColor DarkGray',
        'Write-Host ""',
        'Get-Content -LiteralPath "' + LOG_PATH.replace(/\\/g, '\\\\') + '" -Tail 200 -Wait -Encoding UTF8',
      ].join('\r\n');
      require('fs').writeFileSync(scriptPath, '\ufeff' + script, 'utf8');

      const args = ['/c', 'start', '', 'powershell.exe', '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
      const child = childProcess.spawn('cmd.exe', args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (e) => console.error('[BLFP] 启动 PowerShell 失败:', e.message));
      child.unref();
      return { ok: true, logPath: LOG_PATH, scriptPath };
    } catch (e) {
      console.error('[BLFP] 打开日志失败:', e && e.message);
      return { ok: false, error: (e && e.message) || '未知错误', logPath: LOG_PATH };
    }
  });

  /* 读取日志尾部（应用内日志窗口用，不依赖任何外部程序） */
  ipcMain.handle('read-log', async (_e, lines) => {
    try {
      ensureLogDir();
      const max = Math.max(20, Math.min(2000, Number(lines) || 300));
      const content = require('fs').readFileSync(LOG_PATH, 'utf8');
      const all = content.split(/\r?\n/).filter(Boolean);
      return { ok: true, text: all.slice(-max).join('\n'), logPath: LOG_PATH, size: content.length };
    } catch (e) {
      return { ok: false, error: e.message, logPath: LOG_PATH };
    }
  });

  /* 在资源管理器中定位日志文件（PowerShell 被组策略禁用时的兜底） */
  ipcMain.handle('open-log-folder', async () => {
    try {
      ensureLogDir();
      require('electron').shell.showItemInFolder(LOG_PATH);
      return { ok: true, logPath: LOG_PATH };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('exit-app', async () => {
  await stopServices();
  quitting = true;
  app.quit();
  return { ok: true };
});

// ====== IPC: 节点测延迟（frp 节点 + EasyTier 节点，功能9）======
/* TCP 连接探测：能真实反映"端口是否可连"，用于 tcp/ws/wss 节点 */
function tcpPing(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(ok ? { ok: true, latency: Date.now() - start, method: 'tcp' } : { ok: false, error: error || 'UNKNOWN' });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'ETIMEDOUT'));
    socket.once('error', (err) => finish(false, (err && (err.code || err.message)) || 'ERROR'));
    try { socket.connect(port || 7000, host); } catch { finish(false); }
  });
}

/* ICMP 探测：UDP 中继（udp://host:port）没法用 TCP 连接判断可用性——
   对 UDP 端口做 TCP connect 必然超时/被拒，会把能用的中继误判成"不可达"。
   这里退化为系统 ping 探主机，仅作延迟参考。
   探不到时返回 unknown，绝不能当成"节点不可达"。 */
function icmpPing(host, timeout = 3000) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const args = isWin
      ? ['-n', '1', '-w', String(timeout), host]
      : ['-c', '1', '-W', String(Math.max(1, Math.round(timeout / 1000))), host];
    const start = Date.now();
    try {
      require('child_process').execFile('ping', args, { timeout: timeout + 2000, windowsHide: true }, (err, stdout, stderr) => {
        const out = String(stdout || '') + String(stderr || '');
        const replied = /ttl[=|]/i.test(out) || /time[=<]\s*[\d.]+\s*ms/i.test(out) || /时间[=<]\s*[\d.]+\s*ms/i.test(out);
        if (err && !replied) return resolve({ ok: false, unknown: true, error: 'ICMP 无响应（UDP 中继无法用 TCP 探测）' });
        const m = out.match(/time[=<]\s*([\d.]+)\s*ms/i) || out.match(/时间[=<]\s*([\d.]+)\s*ms/i);
        const measured = m ? Math.round(Number(m[1])) : (Date.now() - start);
        resolve({ ok: true, latency: Number.isFinite(measured) ? measured : (Date.now() - start), method: 'icmp' });
      });
    } catch (e) {
      resolve({ ok: false, unknown: true, error: (e && e.message) || 'ICMP 调用失败' });
    }
  });
}

ipcMain.handle('ping-node', async (_e, { host, port, protocol } = {}) => {
  if (!host || typeof host !== 'string') return { ok: false, error: 'INVALID_HOST' };
  const proto = String(protocol || 'tcp').toLowerCase();
  /* udp 中继只做主机级探测；其余按 TCP 连接探测 */
  if (proto === 'udp') return icmpPing(host);
  return tcpPing(host, port);
});

// ====== IPC: 局域网 MOTD 广播（功能5）======
// 向局域网组播 BLFP+房间号+房主ID，让 MC「多人游戏」自动发现
ipcMain.handle('motd-start', async (_e, { port, roomCode, hostName }) => {
  try {
    const motd = `BLFP §a房间 ${roomCode} §7| 房主 ${hostName}`;
    motdBroadcaster.start(motd, port);
    return { ok: true, motd };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('motd-stop', async () => {
  motdBroadcaster.stop();
  return { ok: true };
});

// ====== IPC: MC 服务器列表探测代理 ======
// 房主开 FRP 房间时，公网端口先进这里：探测包回 BLFP 的图标+MOTD，
// 游戏流量原样转发给真正的 MC。这样房客在 MC 服务器列表里看到的是 BLFP。
let mcStatusProxy = null;
let blfpFaviconCache;

function blfpFavicon() {
  if (blfpFaviconCache !== undefined) return blfpFaviconCache;
  try {
    const iconPath = path.join(__dirname, 'assets', 'server-icon-64.png');
    blfpFaviconCache = 'data:image/png;base64,' + fs.readFileSync(iconPath).toString('base64');
  } catch (e) {
    /* 图标读不到就不带 favicon —— 不能让"没有图标"升级成"联机不可用" */
    blfpFaviconCache = '';
  }
  return blfpFaviconCache;
}

ipcMain.handle('mc-status-proxy-start', async (_e, { targetPort, motd } = {}) => {
  try {
    if (mcStatusProxy) { mcStatusProxy.stop(); mcStatusProxy = null; }
    const proxy = new McStatusProxy();
    const result = await proxy.start({
      targetPort: Number(targetPort),
      motd: motd || 'BLFP 联机',
      favicon: blfpFavicon(),
    });
    mcStatusProxy = proxy;
    return { ok: true, port: result.port };
  } catch (e) {
    mcStatusProxy = null;
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mc-status-proxy-stop', async () => {
  if (mcStatusProxy) { mcStatusProxy.stop(); mcStatusProxy = null; }
  return { ok: true };
});

// ====== IPC: 端口扫描 ======
ipcMain.handle('scan-ports', async () => {
  return scanJavaPorts();
});

// 检测 25565 是否被占用
ipcMain.handle('check-port', async (_e, port) => {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));   // 端口被占用
    s.once('listening', () => { s.close(); resolve(false); });
    s.listen(port);
  });
});

// ====== IPC: frpc 管理 ======
ipcMain.handle('frpc-start', async (_e, cfg) => {
  try {
    const result = await frpcMgr.start(cfg);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('frpc-stop', async () => {
  frpcMgr.stop();
  /* 探测代理和 frpc 是同一条链路：frpc 一停，代理就必须跟着停。
     放在这里而不是渲染层的每个 frpcStop 调用点（那里有 5 处，
     漏一处就会留下一个没人管的监听端口）。 */
  if (mcStatusProxy) { mcStatusProxy.stop(); mcStatusProxy = null; }
  return { ok: true };
});

ipcMain.on('frpc-log', (_e, line) => {
  mainWindow?.webContents.send('frpc-log', line);
});

frpcMgr.on('log', (line) => mainWindow?.webContents.send('frpc-log', line));
frpcMgr.on('port', (payload) => mainWindow?.webContents.send('frpc-port', payload));
frpcMgr.on('error', (err) => mainWindow?.webContents.send('frpc-error', err));

// ====== IPC: EasyTier 主进程与房主 TCP 代理 ======
ipcMain.handle('easytier-start', async (_e, config) => {
  try {
    const status = await easyTierMgr.start(config);
    return { ok: true, status };
  } catch (error) {
    return { ok: false, error: error.message, status: easyTierMgr.getStatus() };
  }
});

ipcMain.handle('easytier-stop', async () => {
  try {
    return { ok: true, status: await easyTierMgr.stop() };
  } catch (error) {
    return { ok: false, error: error.message, status: easyTierMgr.getStatus() };
  }
});


/* ====== 一键收集诊断信息（用于对比"我的机器能用、别人的不能用"）====== */
function runCapture(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    try {
      require('child_process').execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout || stderr || (err && err.message) || '').trim() });
      });
    } catch (e) { resolve({ ok: false, out: e.message }); }
  });
}

ipcMain.handle('collect-diagnostics', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const lines = [];
  const add = (k, v) => lines.push(k + ': ' + v);

  add('时间', new Date().toISOString());
  add('程序版本', app.getVersion());
  try {
    const bi = require(path.join(__dirname, 'renderer', 'build-info.js'));
  } catch (e) {}
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'renderer', 'build-info.js'), 'utf8');
    add('构建标识', (raw.match(/sha:\s*"([^"]+)"/) || [])[1] || '未知');
  } catch (e) { add('构建标识', '读取失败'); }
  add('系统', os.type() + ' ' + os.release() + ' ' + os.arch());
  add('Electron', process.versions.electron + '  Node ' + process.versions.node);
  add('安装路径', __dirname);
  add('resourcesPath', process.resourcesPath || '(无)');

  /* 是否管理员 */
  const adminCheck = await runCapture('net', ['session']);
  add('管理员权限', adminCheck.ok ? '是' : '否（虚拟网卡可能无法创建！）');

  /* 运行文件 */
  const binDir = path.join(process.resourcesPath || '', 'bin');
  try {
    const files = fs.readdirSync(binDir);
    add('bin 目录', binDir);
    files.forEach((f) => {
      const st = fs.statSync(path.join(binDir, f));
      add('  ' + f, (st.size / 1048576).toFixed(1) + ' MB');
    });
    if (!files.length) add('  (空)', '缺少运行文件！');
  } catch (e) { add('bin 目录', '不存在: ' + binDir); }

  /* 网卡（含 EasyTier 虚拟网卡） */
  const ifaces = os.networkInterfaces();
  const ipv4 = [];
  Object.keys(ifaces).forEach((name) => {
    (ifaces[name] || []).forEach((info) => {
      if (info && (info.family === 'IPv4' || info.family === 4)) ipv4.push(name + ' = ' + info.address);
    });
  });
  add('网卡 IPv4', ipv4.length ? '\n    ' + ipv4.join('\n    ') : '(无)');
  add('虚拟网卡', ipv4.some((s) => s.includes('10.200.')) ? '已创建' : '未创建（EasyTier 未运行或 TUN 失败）');

  /* 防火墙规则 */
  const fw = await runCapture('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=BLFP 联机助手']);
  add('防火墙规则', fw.out.includes('BLFP') ? '已存在' : '不存在（访客可能连不上）');

  /* 网络类别 */
  const prof = await runCapture('powershell', ['-NoProfile', '-Command', 'Get-NetConnectionProfile | Select-Object -Property InterfaceAlias,NetworkCategory | Format-Table -HideTableHeaders | Out-String']);
  add('网络类别', '\n    ' + (prof.out || '(读取失败)').split('\n').filter(Boolean).join('\n    '));

  /* 关键节点连通性 */
  for (const [label, host, port] of [['EasyTier 中继', '47.103.142.240', 11010]]) {
    const res = await new Promise((resolve) => {
      const net = require('net');
      const s = new net.Socket();
      const t0 = Date.now();
      let done = false;
      const fin = (r) => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(r); };
      s.setTimeout(5000);
      s.once('connect', () => fin('OK ' + (Date.now() - t0) + ' ms'));
      s.once('timeout', () => fin('超时 ETIMEDOUT'));
      s.once('error', (e) => fin('失败 ' + (e.code || e.message)));
      try { s.connect(port, host); } catch (e) { fin('失败 ' + e.message); }
    });
    add(label + ' (' + host + ':' + port + ')', res);
  }
  add('服务器 (' + (process.env.BLFP_SERVER || '154.40.43.136:4000') + ')', '(由客户端测速)');

  /* 日志尾部 */
  try {
    const logPath = path.join(process.env.APPDATA || process.env.HOME || '.', 'BLFP', 'logs', 'blfp.log');
    const content = fs.readFileSync(logPath, 'utf8');
    const tail = content.split(/\r?\n/).filter(Boolean).slice(-40);
    add('最近日志', '\n    ' + tail.join('\n    '));
  } catch (e) { add('最近日志', '读取失败'); }

  return lines.join('\n');
});

/* 以管理员身份重启（仅在用户确认后调用，不再默认提权） */
ipcMain.handle('relaunch-elevated', async () => {
  try {
    const { execFile } = require('child_process');
    const exe = process.execPath.replace(/"/g, '""');
    const cmd = 'Start-Process -FilePath "' + exe + '" -Verb RunAs';
    execFile('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true }, (err) => {
      if (err) console.error('[BLFP] 提权重启失败:', err.message);
    });
    setTimeout(() => app.quit(), 900);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('is-elevated', async () => {
  const r = await runCapture('net', ['session']);
  return r.ok;
});

ipcMain.handle('easytier-status', async () => easyTierMgr.getStatus());
ipcMain.handle('easytier-test', async (_e, config) => {
  const hostVirtualIp = typeof config === 'string' ? config : config?.hostVirtualIp;
  const port = config?.port || 25565;
  return easyTierMgr.testConnectivity(hostVirtualIp, port, 2500);
});

easyTierMgr.on('log', (line) => mainWindow?.webContents.send('easytier-log', line));
easyTierMgr.on('status', (status) => mainWindow?.webContents.send('easytier-status', status));
easyTierMgr.on('manager-error', (error) => mainWindow?.webContents.send('easytier-error', error));
