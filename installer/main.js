/* 全局异常兜底：避免任何未捕获异常弹出 "A JavaScript error occurred in the main process" 对话框 */
process.on('uncaughtException', (err) => {
  console.error('[安装器] 已拦截未捕获异常:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[安装器] 已拦截未处理的 Promise 拒绝:', reason && reason.message ? reason.message : reason);
});

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const core = require('./install-core.js');

/* 隐藏的静默触发接口：客户端下载完更新后会带 --blfp-silent-update 把本安装器拉起来。
   必须在创建窗口**之前**就解析出来 —— 静默模式下整个进程不该有任何窗口。 */
const ARGS = core.parseSilentArgs(process.argv);
const SILENT = ARGS.silent;

/* 静默模式下的进度输出：写到 stdout 与状态文件，父进程（客户端）可以据此显示进度。
   刻意不依赖 Electron 的窗口/日志系统，保证即使界面层出问题也能跑。 */
function silentStatus(payload) {
  if (!SILENT) return;
  try { process.stdout.write('[BLFP-安装] ' + JSON.stringify(payload) + '\n'); } catch (e) {}
  if (!ARGS.statusFile) return;
  try {
    fs.mkdirSync(path.dirname(ARGS.statusFile), { recursive: true });
    fs.writeFileSync(ARGS.statusFile, JSON.stringify({ ...payload, at: Date.now() }), 'utf8');
  } catch (e) {}
}

// payload.zip 内含主程序全部文件（win-unpacked 内容）
let lastPayloadDiagnostic = '';
function payloadPath() {
  const path = require('path');
  const fsx = require('fs');
  const candidates = [
    path.join(process.resourcesPath || '', 'payload', 'payload.zip'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'payload', 'payload.zip'),
    path.join(app.getAppPath(), 'payload', 'payload.zip'),
    path.join(__dirname, 'payload', 'payload.zip'),
    path.join(__dirname, '..', 'payload', 'payload.zip'),
    path.join(process.resourcesPath || '', 'app', 'payload', 'payload.zip'),
  ];
  const hit = candidates.find((c) => { try { return fsx.existsSync(c) && fsx.statSync(c).size > 0; } catch (e) { return false; } });
  if (hit) { lastPayloadDiagnostic = '命中候选路径: ' + hit; return hit; }

  /* 兜底：在 resources 与程序目录下递归查找 payload.zip（2 层深度内） */
  const roots = [process.resourcesPath, app.getAppPath(), __dirname].filter(Boolean);
  for (const root of roots) {
    try {
      const found = findFileDeep(root, 'payload.zip', 3);
      if (found) { lastPayloadDiagnostic = '递归搜索命中: ' + found; return found; }
    } catch (e) {}
  }

  /* 全部失败：记录实际目录结构，便于定位 */
  const describe = (p) => {
    try { return p + ' → ' + (fsx.existsSync(p) ? fsx.readdirSync(p).slice(0, 30).join(', ') : '不存在'); }
    catch (e) { return p + ' → 读取失败'; }
  };
  lastPayloadDiagnostic = [
    '未找到 payload.zip。候选路径检查结果：',
    ...candidates.map((c) => '  ' + c + (fsx.existsSync(c) ? ' [存在但为空]' : ' [不存在]')),
    '目录结构：',
    '  ' + describe(process.resourcesPath || ''),
    '  ' + describe(path.join(process.resourcesPath || '', 'payload')),
    '  ' + describe(__dirname),
    '  ' + describe(app.getAppPath()),
  ].join('\n');
  return undefined;
}

function findFileDeep(root, fileName, depth) {
  const path = require('path');
  const fsx = require('fs');
  if (depth < 0) return null;
  let entries = [];
  try { entries = fsx.readdirSync(root, { withFileTypes: true }); } catch (e) { return null; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      try { if (fsx.statSync(full).size > 0) return full; } catch (e) {}
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === 'locales') continue;
    const found = findFileDeep(path.join(root, entry.name), fileName, depth - 1);
    if (found) return found;
  }
  return null;
}

/* 用户守则验证码：每次运行安装程序随机生成（6 位数字），仅主进程持有，
   渲染进程只能取到用于显示的值，校验在主进程完成，无法通过改页面绕过 */
const verificationCode = String(crypto.randomInt(100000, 1000000));

const APP_NAME = 'BLFP';
const EXE_NAME = 'BLFP.exe';

function defaultInstallDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Programs', APP_NAME);
}

function entryOutputPath(targetDir, entryName) {
  const segments = entryName.split(/[\\/]+/);
  if (path.isAbsolute(entryName) || path.win32.isAbsolute(entryName) || path.posix.isAbsolute(entryName) || segments.includes('..')) {
    throw new Error(`安装包包含不安全路径：${entryName}`);
  }

  const root = path.resolve(targetDir);
  const output = path.resolve(root, entryName);
  if (output !== root && !output.startsWith(root + path.sep)) {
    throw new Error(`安装包路径超出安装目录：${entryName}`);
  }
  return output;
}

function taskkill(imageName) {
  return new Promise((resolve) => {
    const child = spawn('taskkill.exe', ['/F', '/IM', imageName], { windowsHide: true, stdio: 'ignore' });
    child.on('error', resolve);
    child.on('close', resolve);
  });
}

/* 客户端以管理员权限运行，普通权限的安装器杀不掉它。
   本安装器现在自己就是 requireAdministrator（见 package.json），
   所以可以直接强杀 —— 不再需要 powershell + cmd + UAC 那一串，
   那串正是"关客户端时间太长"的来源（弹窗要等用户点、还要再等 120 秒）。 */
function taskkillElevated() {
  return taskkillAll();
}

/* 兜底：显式提权执行 taskkill（会弹 UAC）。
   只在"强杀之后文件仍然被占用"（也就是安装器没拿到管理员权限）时才会走到，
   正常路径上永远不会触发。 */
function taskkillViaUac() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve();
    const cmd = 'taskkill /F /IM ' + EXE_NAME + ' & taskkill /F /IM easytier-core.exe & taskkill /F /IM frpc.exe';
    try {
      /* -Wait 不能省：没有它 powershell 一发出请求就退出，
         安装器会在客户端仍被占用时继续解压，必然 EBUSY */
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-Command',
        "Start-Process cmd.exe -ArgumentList '/c " + cmd + " & timeout /t 1 >nul' -Verb RunAs -Wait",
      ], { windowsHide: false, stdio: 'ignore' });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    } catch (e) { resolve(); }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Windows 上被占用的文件抛 EBUSY / EPERM / EACCES；进程刚退出时句柄释放还有延迟 */
function isBusyError(err) {
  const code = err && err.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
}

/* 能否独占打开目标文件（文件不存在也算已解锁） */
function isUnlocked(filePath) {
  try { const fd = fs.openSync(filePath, 'r+'); fs.closeSync(fd); return true; }
  catch (e) { return !isBusyError(e); }
}

function taskkillAll() {
  return Promise.all([taskkill(EXE_NAME), taskkill('easytier-core.exe'), taskkill('frpc.exe')]);
}

/* 等待主程序文件解锁；期间周期性重发 taskkill。
   超时从 120 秒砍到 15 秒：安装器自己有管理员权限，taskkill /F 基本是立刻生效，
   等 120 秒只会在"杀不掉"这种异常情况下把用户晾在那里两分钟。 */
async function waitForUnlock(exePath, timeoutMs = 15000, onTick) {
  let lastKill = Date.now();
  const ok = await core.waitUnlocked(exePath, {
    timeoutMs,
    intervalMs: 100,
    isUnlocked,
    sleep: async (ms) => {
      await sleep(ms);
      /* 每 3 秒补一次强杀：可能有进程在客户端退出后又拉起来（easytier/frpc） */
      if (Date.now() - lastKill > 3000) { lastKill = Date.now(); await taskkillAll(); }
    },
  });
  if (!ok && onTick) onTick(timeoutMs);
  return ok;
}

/* 解压写入带重试：文件被占用时等待后重写，必要时再杀一次客户端。
   旧实现是一次性 writeFileSync —— 只要此刻 BLFP.exe 还被占用就整次安装失败，
   用户必须手动重试第二次才能装上（EBUSY: resource busy or locked）。 */
async function writeFileWithRetry(outPath, data, onRetry) {
  const deadline = Date.now() + 60000;
  let attempt = 0;
  let lastErr;
  for (;;) {
    try { fs.writeFileSync(outPath, data); return; }
    catch (e) {
      lastErr = e;
      if (!isBusyError(e)) throw e;
      attempt++;
      if (Date.now() >= deadline) break;
      if (attempt % 4 === 0) await taskkillAll();
      if (onRetry) onRetry(attempt);
      await sleep(Math.min(300 * attempt, 2000));
    }
  }
  throw new Error(
    '文件被占用，无法写入：' + outPath + '\n' +
    '请手动退出 BLFP 客户端，包括右下角托盘里的图标，然后重试安装。\n' +
    '错误码 ' + (lastErr && lastErr.code)
  );
}

/* 解析 tasklist /NH 输出：命中行以镜像名开头。
   不能用 includes —— 无匹配时 tasklist 会输出
   "INFO: No tasks are running which match the specified criteria."，
   宽松匹配容易把状态行误判成进程存在，从而谎报启动成功。 */
function tasklistHasImage(out, imageName) {
  const name = String(imageName).toLowerCase();
  return String(out || '').split(/\r?\n/).some((line) => {
    const t = line.trim().toLowerCase();
    return t === name || t.startsWith(name + ' ');
  });
}

/* 查询某个镜像名的进程是否在运行 */
function isProcessRunning(imageName) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('tasklist.exe', ['/FI', 'IMAGENAME eq ' + imageName, '/NH'], { windowsHide: true });
    } catch (e) { return resolve(false); }
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(tasklistHasImage(out, imageName)));
  });
}

/* 轮询等待进程出现（启动是异步的，UAC 还需要用户点击） */
let win;
function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 700,
    minHeight: 560,
    resizable: true,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'BLFP 安装程序',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

/*
 * 静默安装（隐藏触发接口被调用时走这条路）。
 * 全程不创建任何窗口，像无头浏览器一样在后台跑完。
 */
async function runSilentInstall() {
  const targetDir = ARGS.target || defaultInstallDir();
  const t0 = Date.now();
  silentStatus({ phase: 'start', target: targetDir, percent: 0 });
  try {
    const result = await runInstall({
      targetDir,
      desktopShortcut: ARGS.shortcuts,
      startMenuShortcut: ARGS.shortcuts,
      onProgress: (percent, text) => {
        silentStatus({ phase: 'install', percent, text });
      },
    });
    const ms = Date.now() - t0;
    silentStatus({
      phase: 'done', percent: 100, ok: true, target: targetDir,
      skipped: result.skipped, written: result.written, ms,
    });
    console.log(`[安装器] 静默安装完成：写入 ${result.written} 个文件、跳过 ${result.skipped} 个，用时 ${ms} 毫秒`);
    if (ARGS.relaunch) {
      silentStatus({ phase: 'launch', percent: 100, ok: true });
      try { await launchAndExit(result.exePath); } catch (e) { silentStatus({ phase: 'launch-failed', ok: false, error: e.message }); }
    }
    silentStatus({ phase: 'exit', percent: 100, ok: true, ms });
    /* 静默模式必须秒退：不留给用户任何"安装程序还开着"的观感 */
    try { app.exit(0); } catch (e) { process.exit(0); }
    return result;
  } catch (e) {
    const message = (e && e.message) || String(e);
    silentStatus({ phase: 'done', ok: false, error: message, ms: Date.now() - t0 });
    console.error('[安装器] 静默安装失败：' + message);
    /* 失败也必须把客户端拉回来。
       否则用户看到的就只是"点更新 → 软件关了 → 再也没回来"，
       完全不知道发生了什么（payload 缺失这类错误以前就是这么被吞掉的）。
       拉回来的是**原来那个**客户端（文件没被改动），
       它启动后会读状态文件，把失败原因显示给用户。 */
    if (ARGS.relaunch) {
      silentStatus({ phase: 'relaunch-after-failure', ok: false, error: message });
      const exePath = path.join(targetDir, EXE_NAME);
      try {
        if (fs.existsSync(exePath)) await launchAndExit(exePath);
        else console.error('[安装器] 客户端主程序不存在，无法自动恢复：' + exePath);
      } catch (err) {
        console.error('[安装器] 失败后自动拉回客户端也失败了：' + ((err && err.message) || err));
      }
    }
    try { app.exit(1); } catch (err) { process.exit(1); }
    return { ok: false, error: message };
  }
}

app.whenReady().then(() => {
  /* 隐藏触发接口：静默模式下绝不创建窗口 —— 这正是"不出现安装程序界面" */
  if (SILENT) {
    runSilentInstall();
    return;
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

// ---------- IPC ----------
ipcMain.handle('get-default-dir', () => defaultInstallDir());

/* 供界面显示（"用户守则末尾验证码"） */
ipcMain.handle('get-verify-code', () => verificationCode);

/* 校验用户输入的验证码 */
ipcMain.handle('verify-code', (evt, input) => {
  const value = String(input == null ? '' : input).trim();
  return { ok: value === verificationCode };
});

/* 安装前自检：让"加载中"页面显示真实检查结果 */
ipcMain.handle('self-check', async () => {
  const zipFile = payloadPath();
  let sizeMB = 0;
  try { if (zipFile) sizeMB = Math.round(fs.statSync(zipFile).size / 1048576); } catch (e) {}
  const targetDir = defaultInstallDir();
  let writable = false;
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const probe = path.join(targetDir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    writable = true;
  } catch (e) { writable = false; }
  return {
    payloadOk: !!zipFile && sizeMB >= 50,
    diagnostic: lastPayloadDiagnostic,
    payloadSizeMB: sizeMB,
    targetDir,
    writable,
    defaultDir: targetDir,
  };
});

ipcMain.handle('choose-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择安装目录',
  });
  if (r.canceled || !r.filePaths.length) return null;
  return path.join(r.filePaths[0], APP_NAME);
});

/*
 * 真正的安装流程。界面模式与静默模式共用同一份实现，
 * 区别只在 onProgress 往哪儿报（窗口 or stdout/状态文件）。
 */
async function runInstall(opts) {
  const targetDir = opts.targetDir;
  const desktopShortcut = opts.desktopShortcut !== false;
  const startMenuShortcut = opts.startMenuShortcut !== false;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  const zipFile = payloadPath();
  if (!zipFile) throw new Error('安装包数据缺失，没有找到 payload.zip\n' + lastPayloadDiagnostic);

  onProgress(2, '准备安装目录...');
  fs.mkdirSync(targetDir, { recursive: true });

  /* 目录可写性检查（安装器已是管理员，这里主要拦住"选了个奇怪目录"） */
  try {
    const probe = path.join(targetDir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    throw new Error('安装目录不可写：' + targetDir + '\n请改用默认安装位置，或换一个你有写权限的目录。');
  }

  /* ---- 秒关客户端 ----
     安装器自带管理员权限，通常一句强杀就完事（几十毫秒）。
     只有在强杀之后文件仍被占用（说明没拿到管理员权限）时，才退回老的 UAC 办法，
     那条路正常永远走不到。旧实现是无条件"优雅等 5 秒 → 弹 UAC → 再等 120 秒"。 */
  const exeTarget = path.join(targetDir, EXE_NAME);
  if (fs.existsSync(exeTarget) && !isUnlocked(exeTarget)) {
    onProgress(5, '正在关闭客户端…');
    const t0 = Date.now();
    await taskkillElevated();
    let unlocked = await waitForUnlock(exeTarget, 4000);
    if (unlocked) {
      onProgress(8, `已关闭客户端，用时 ${Date.now() - t0} 毫秒`);
    } else {
      onProgress(6, '需要提权关闭客户端，请在弹窗点「是」…');
      await taskkillViaUac();
      unlocked = await waitForUnlock(exeTarget, 30000);
      if (unlocked) onProgress(8, `已关闭客户端，用时 ${Date.now() - t0} 毫秒`);
      /* 仍未解锁也不再直接判失败：交给逐文件重试兜底 */
      else onProgress(8, '客户端似乎仍在运行，继续尝试覆盖安装…');
    }
  }

  // 关闭 Electron 的 asar 拦截：主程序内含 resources/app.asar，
  // 若不关闭，写入该文件时 Electron 会把它当 asar 归档拒绝写入，导致解压失败
  process.noAsar = true;

  onProgress(9, '正在读取安装包...');
  const zip = new AdmZip(zipFile);
  const entries = zip.getEntries();

  /* ---- 秒装的关键：先算出哪些文件根本没变，直接跳过 ----
     一次常规版本更新里，Electron 运行时（~180MB）和 bin 下的工具都没变，
     真正变的只有我们自己的代码（几百 KB）。旧实现是无条件全量解压 230MB，
     所以每次更新都要等很久；现在只写真正变了的文件。 */
  onProgress(10, '正在比对已安装文件...');
  const plan = await core.planInstall(
    entries.map((entry) => ({
      raw: entry,
      entryName: entry.entryName,
      isDirectory: entry.isDirectory,
      size: entry.header && typeof entry.header.size === 'number' ? entry.header.size : undefined,
      crc32: entry.header ? entry.header.crc : undefined,
    })),
    targetDir,
    {
      safeOutputPath: (name) => entryOutputPath(targetDir, name),
      statSync: (p) => fs.statSync(p),
      crc32File: (p) => core.crc32File(p),
    }
  );
  onProgress(12, plan.skipped > 0
    ? `无需改动 ${plan.skipped} 个文件，正在写入 ${plan.toWrite} 个文件，共 ${Math.round(plan.bytesToWrite / 1048576)} MB...`
    : `正在写入 ${plan.toWrite} 个文件，共 ${Math.round(plan.bytesToWrite / 1048576)} MB...`);

  const total = plan.items.length || 1;
  let done = 0;
  let written = 0;
  for (const item of plan.items) {
    if (item.action === 'mkdir') {
      fs.mkdirSync(item.outPath, { recursive: true });
    } else if (item.action === 'write') {
      fs.mkdirSync(path.dirname(item.outPath), { recursive: true });
      await writeFileWithRetry(item.outPath, item.entry.raw.getData(), (attempt) => {
        const pct = 12 + Math.floor(((done + 1) / total) * 76);
        onProgress(pct, `正在解压文件 ${done + 1}/${total}，${path.basename(item.outPath)} 被占用，第 ${attempt} 次重试...`);
      });
      written++;
    }
    /* action === 'skip'：磁盘上已经是同一个文件，不解压、不写盘 */
    done++;
    if (done % 25 === 0 || done === total) {
      onProgress(12 + Math.floor((done / total) * 76), `正在安装 ${done}/${total}...`);
    }
  }

  onProgress(92, '正在创建快捷方式...');
  const exePath = path.join(targetDir, EXE_NAME);
  if (!fs.existsSync(exePath)) throw new Error('解压后未找到主程序 ' + EXE_NAME);

  // 桌面快捷方式
  if (desktopShortcut) {
    try {
      const desktop = app.getPath('desktop');
      shell.writeShortcutLink(path.join(desktop, APP_NAME + '.lnk'), 'create', {
        target: exePath,
        cwd: targetDir,
        description: 'BLFP 我的世界联机客户端',
      });
    } catch (e) { /* 桌面快捷方式失败不阻断安装 */ }
  }

  // 开始菜单快捷方式
  if (startMenuShortcut) try {
    const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    fs.mkdirSync(startMenu, { recursive: true });
    shell.writeShortcutLink(path.join(startMenu, APP_NAME + '.lnk'), 'create', {
      target: exePath,
      cwd: targetDir,
      description: 'BLFP 我的世界联机客户端',
    });
  } catch (e) { /* 开始菜单快捷方式失败不阻断安装 */ }

  // 写入卸载信息（简单记录安装目录）
  try {
    const metadata = { installDir: targetDir, installedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(targetDir, 'install-info.json'), JSON.stringify(metadata, null, 2), 'utf8');
  } catch (e) {}

  const uninstallerPath = path.join(targetDir, '卸载 BLFP.exe');
  if (startMenuShortcut && fs.existsSync(uninstallerPath)) {
    try {
      const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
      shell.writeShortcutLink(path.join(startMenu, '卸载 BLFP.lnk'), 'create', {
        target: uninstallerPath,
        cwd: targetDir,
        description: '卸载 BLFP',
      });
    } catch (e) {}
  }

  onProgress(100, '安装完成');
  return { ok: true, exePath, skipped: plan.skipped, written, bytesWritten: plan.bytesToWrite };
}

ipcMain.handle('install', async (evt, opts) => {
  const targetDir = typeof opts === 'string' ? opts : opts.dir;
  const desktopShortcut = typeof opts === 'string' ? true : opts.desktopShortcut !== false;
  const startMenuShortcut = typeof opts === 'string' ? true : opts.startMenuShortcut !== false;
  try {
    return await runInstall({
      targetDir,
      desktopShortcut,
      startMenuShortcut,
      onProgress: (percent, text) => { try { win.webContents.send('install-progress', { percent, text }); } catch (e) {} },
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/*
 * 启动客户端。
 *
 * 旧实现：shell.openPath → waitForProcess 15 秒 → 不行就 powershell 提权 →
 * 再 waitForProcess 30 秒 → 最后 setTimeout(quit, 800)。
 * 也就是"装完等客户端起来"最多要 45 秒，安装器窗口一直赖在那儿 ——
 * 这就是"安装程序消失时间太长"。
 *
 * 现在：发出去就立刻退出。BLFP.exe 起没起来不该由安装器守着：
 * 起来了窗口自然就出现；起不来让用户双击快捷方式，而不是让安装器空等。
 */
async function launchAndExit(exePath) {
  if (!exePath || !fs.existsSync(exePath)) throw new Error('未找到主程序：' + exePath);
  /* 已经在运行就不重复启动（客户端自己拉起的静默更新就是这种情况） */
  if (!(await isProcessRunning(EXE_NAME))) {
    /* shell.openPath 是 ShellExecute 语义：BLFP.exe 的清单是 requireAdministrator，
       会按清单提权。安装器本身已是管理员，这里不会再弹 UAC。 */
    const err = await shell.openPath(exePath);
    if (err) throw new Error(err);
  }
  return { ok: true };
}

/* 立刻退出：app.exit 比 app.quit 干脆，不会被 before-quit 之类钩子拖住。
   portable 版还会顺带清掉临时目录，所以走得越快、用户等得越少。 */
function exitFast(delayMs) {
  setTimeout(() => {
    try { app.exit(0); } catch (e) { process.exit(0); }
  }, typeof delayMs === 'number' ? delayMs : 120);
}

ipcMain.handle('launch', async (evt, exePath) => {
  const send = (text) => { try { win.webContents.send('install-progress', { percent: 100, text }); } catch (e) {} };
  send('正在启动 BLFP…');
  try {
    const result = await launchAndExit(exePath);
    exitFast(120);
    return result;
  } catch (e) {
    return {
      ok: false,
      error: '未能启动 BLFP。\n' + ((e && e.message) || '未知错误') +
        '\n请手动双击桌面上的 BLFP 快捷方式启动。弹出提示时请点「是」允许管理员权限。',
    };
  }
});

ipcMain.handle('quit', () => app.quit());
