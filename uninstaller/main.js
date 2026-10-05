/* 全局异常兜底：避免任何未捕获异常弹出 "A JavaScript error occurred in the main process" 对话框 */
process.on('uncaughtException', (err) => {
  console.error('[卸载器] 已拦截未捕获异常:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[卸载器] 已拦截未处理的 Promise 拒绝:', reason && reason.message ? reason.message : reason);
});

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let win;
let installDir;
let installDirError;
let uninstallPrepared = false;
let deleteScheduled = false;

function normalizePath(value) {
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

function realPath(value) {
  return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
}

function executableDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return path.resolve(process.env.PORTABLE_EXECUTABLE_DIR);
  if (process.env.PORTABLE_EXECUTABLE_FILE) return path.dirname(path.resolve(process.env.PORTABLE_EXECUTABLE_FILE));
  return path.dirname(process.execPath);
}

function validateSafeInstallDir(targetDir) {
  const resolved = path.resolve(targetDir);
  const normalized = normalizePath(resolved);
  const root = normalizePath(path.parse(resolved).root);
  const windowsDir = process.env.WINDIR || process.env.SystemRoot;
  const forbidden = [
    os.homedir(),
    path.dirname(os.homedir()),
    process.env.USERPROFILE,
    process.env.PUBLIC,
    process.env.ProgramData,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    process.env.TEMP,
    process.env.TMP,
  ].filter(Boolean).map(normalizePath);

  if (normalized === root || forbidden.includes(normalized)) {
    throw new Error('拒绝卸载根目录、系统目录或用户目录');
  }

  if (windowsDir) {
    const normalizedWindowsDir = normalizePath(windowsDir);
    if (normalized === normalizedWindowsDir || normalized.startsWith(normalizedWindowsDir + path.sep.toLowerCase())) {
      throw new Error('拒绝卸载根目录、系统目录或用户目录');
    }
  }
}

function resolveInstallDir() {
  const actualDir = executableDir();
  validateSafeInstallDir(actualDir);

  if (!fs.existsSync(actualDir) || !fs.statSync(actualDir).isDirectory()) {
    throw new Error('卸载程序所在目录不存在');
  }

  const infoPath = path.join(actualDir, 'install-info.json');
  const hasInfo = fs.existsSync(infoPath) && fs.statSync(infoPath).isFile();

  if (!hasInfo) {
    // 次选：卸载器与主程序位于同一安装目录，直接以同目录 BLFP.exe 校验
    if (!fs.existsSync(path.join(actualDir, 'BLFP.exe'))) {
      throw new Error('安装 metadata 缺失且同目录未找到 BLFP.exe');
    }
    return actualDir;
  }

  let info;
  try {
    info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  } catch {
    throw new Error('安装 metadata 无效');
  }

  if (!info || typeof info.installDir !== 'string' || !info.installDir.trim() || !path.isAbsolute(info.installDir)) {
    throw new Error('安装 metadata 中的目录无效');
  }

  const metadataDir = path.resolve(info.installDir);
  validateSafeInstallDir(metadataDir);

  if (!fs.existsSync(metadataDir) || !fs.statSync(metadataDir).isDirectory()) {
    throw new Error('metadata 指向的安装目录不存在');
  }

  if (normalizePath(realPath(actualDir)) !== normalizePath(realPath(metadataDir))) {
    throw new Error('卸载程序所在目录与安装 metadata 不一致');
  }

  if (!fs.existsSync(path.join(metadataDir, 'BLFP.exe'))) {
    throw new Error('安装目录缺少 BLFP.exe');
  }

  return metadataDir;
}

function taskkill(imageName) {
  return new Promise((resolve) => {
    const child = spawn('taskkill.exe', ['/IM', imageName, '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', resolve);
    child.on('close', resolve);
  });
}

/* 客户端以管理员权限运行，普通权限的卸载器杀不掉它 —— 提权弹出 cmd 窗口执行 taskkill */
function taskkillElevated() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve();
    const cmd = 'taskkill /F /IM BLFP.exe & taskkill /F /IM easytier-core.exe & taskkill /F /IM frpc.exe';
    try {
      /* -Wait：等提权 cmd 真正执行完再返回，避免 UAC 还没点「是」就继续往下走 */
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

function scheduleDeletion() {
  if (!uninstallPrepared || deleteScheduled || !installDir) return false;
  try {
    const validatedDir = resolveInstallDir();
    if (normalizePath(validatedDir) !== normalizePath(installDir)) return false;
  } catch {
    return false;
  }
  deleteScheduled = true;

  const scriptPath = path.join(app.getPath('temp'), `blfp-remove-${process.pid}-${Date.now()}.cmd`);
  const escapedTarget = String(installDir).replace(/"/g, '""');
  const script = [
    '@echo off',
    'chcp 65001 >nul',
    `set "TARGET=${escapedTarget}"`,
    'set /a ATTEMPT=0',
    ':retry',
    'timeout /t 1 /nobreak >nul',
    'rmdir /s /q "%TARGET%" 2>nul',
    'if not exist "%TARGET%" goto done',
    'set /a ATTEMPT+=1',
    'if %ATTEMPT% lss 30 goto retry',
    ':done',
    'del /f /q "%~f0"',
  ].join('\r\n');

  try {
    fs.writeFileSync(scriptPath, script, 'utf8');
    spawn('cmd.exe', ['/d', '/s', '/c', `"${scriptPath}"`], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    }).unref();
    return true;
  } catch {
    deleteScheduled = false;
    try {
      if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
    } catch {}
    return false;
  }
}

function quit() {
  scheduleDeletion();
  app.quit();
}

function createWindow() {
  win = new BrowserWindow({
    width: 620,
    height: 480,
    resizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'BLFP 卸载程序',
    backgroundColor: '#0f1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  try {
    installDir = resolveInstallDir();
  } catch (error) {
    installDirError = error.message;
  }
  createWindow();
});

app.on('window-all-closed', quit);

ipcMain.handle('get-install-dir', () => installDir || `无效安装目录：${installDirError}`);

ipcMain.handle('uninstall', async () => {
  try {
    if (installDirError) throw new Error(installDirError);
    const validatedDir = resolveInstallDir();
    if (!installDir || normalizePath(validatedDir) !== normalizePath(installDir)) {
      throw new Error('安装目录在卸载过程中发生变化');
    }

    const desktopLink = path.join(app.getPath('desktop'), 'BLFP.lnk');
    const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    for (const link of [desktopLink, path.join(startMenu, 'BLFP.lnk'), path.join(startMenu, '卸载 BLFP.lnk')]) {
      try {
        if (fs.existsSync(link)) fs.unlinkSync(link);
      } catch {}
    }

    await Promise.all([
      taskkill('BLFP.exe'),
      taskkill('easytier-core.exe'),
      taskkill('frpc.exe'),
    ]);
    /* 主程序可能仍以管理员权限运行 → 提权关闭（会弹 UAC） */
    try {
      const exe = path.join(installDir, 'BLFP.exe');
      let locked = false;
      if (fs.existsSync(exe)) {
        try { const fd = fs.openSync(exe, 'r+'); fs.closeSync(fd); } catch (e) { locked = true; }
      }
      if (locked) {
        await taskkillElevated();
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 600));
          try { const fd = fs.openSync(exe, 'r+'); fs.closeSync(fd); break; } catch (e) {}
        }
      }
    } catch (e) { /* 继续卸载流程 */ }

    uninstallPrepared = true;
    return { ok: true, installDir };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('quit', quit);

ipcMain.handle('open-dir', () => {
  if (installDir) return shell.openPath(installDir);
  return '';
});
