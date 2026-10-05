/*
 * 拉起静默安装器 —— 这一步做错会让客户端"关掉就再也回不来"，所以单独成模块、单独测。
 *
 * 背景（Windows 上非常容易踩）：
 *   `child_process.spawn` 底层是 CreateProcess，而 **CreateProcess 不会提权**。
 *   安装器的清单是 requireAdministrator，所以当客户端自己**没有**管理员权限时：
 *     - spawn 不会弹 UAC，而是异步抛 ERROR_ELEVATION_REQUIRED（EACCES）
 *     - 这个错误是 'error' 事件，同步 try/catch **抓不到**
 *   老实现里没人监听 'error'，于是"启动失败"和"启动成功"看起来一模一样，
 *   而客户端紧接着就 exit 了 —— 用户看到的就是"点更新，软件没了"。
 *
 * 所以这里的规矩：
 *   1. spawn 之后要**短暂观察**，确认进程真的起来了，才允许客户端退出。
 *   2. spawn 不行就退回 ShellExecute(runas)（会弹 UAC，用户点一下即可）。
 *   3. 两条路都失败（比如用户在 UAC 上点了"否"）→ 如实返回失败，
 *      调用方**不要退出客户端**，把错误显示出来让用户可以重试。
 */
'use strict';

const DEFAULT_SILENT_FLAG = '--blfp-silent-update';
/* 观察窗口：CreateProcess 失败是同步失败，'error' 事件下一个 tick 就到，
   所以几百毫秒足够判断；太长会让"秒退"变成"愣一下"。 */
const DEFAULT_OBSERVE_MS = 700;

/** 拼静默安装的参数（与安装器 install-core.js 的约定必须一致） */
function buildSilentArgs(options) {
  const o = options || {};
  const args = [o.silentFlag || DEFAULT_SILENT_FLAG];
  if (o.targetDir) args.push('--target', o.targetDir);
  if (o.relaunch !== false) args.push('--relaunch');
  if (o.shortcuts === false) args.push('--no-shortcuts');
  if (o.statusFile) args.push('--status-file', o.statusFile);
  return args;
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 直接 spawn 并观察一小段时间，判断进程是否真的活着。
 * @returns {Promise<{ok:boolean, pid?:number, error?:string}>}
 */
function spawnAndObserve(options) {
  const o = options || {};
  const spawnImpl = o.spawnImpl;
  const sleep = o.sleep || realSleep;
  const observeMs = typeof o.observeMs === 'number' ? o.observeMs : DEFAULT_OBSERVE_MS;
  const log = typeof o.log === 'function' ? o.log : () => {};

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };

    let child;
    try {
      child = spawnImpl(o.command, o.args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (e) {
      /* 少数情况下是同步抛的 */
      return finish({ ok: false, error: (e && e.message) || String(e) });
    }
    if (!child || typeof child.on !== 'function') {
      return finish({ ok: false, error: 'spawn 没有返回子进程对象' });
    }

    /* 必须监听：提权失败就是从这里来的，不监听就永远发现不了 */
    child.on('error', (e) => {
      const message = (e && e.message) || String(e);
      log('直接启动安装器失败：' + message);
      finish({ ok: false, error: message });
    });

    /* 撑过观察窗口还活着，就认为起来了 */
    sleep(observeMs).then(() => {
      if (typeof child.unref === 'function') { try { child.unref(); } catch (e) {} }
      finish({ ok: true, pid: child.pid });
    });
  });
}

/** ShellExecute(runas) 语义：会弹 UAC。用在客户端自己没提权的时候。 */
function defaultRunElevated(command, args) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const argList = args.map((a) => "'" + String(a).replace(/'/g, "''") + "'").join(',');
    const script =
      "Start-Process -FilePath '" + String(command).replace(/'/g, "''") + "'" +
      ' -ArgumentList ' + argList + ' -Verb RunAs -Wait';
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', script],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let errOut = '';
      if (child.stderr) child.stderr.on('data', (d) => { errOut += d.toString(); });
      child.on('error', (e) => finish({ ok: false, error: (e && e.message) || String(e) }));
      child.on('close', (code) => {
        if (code === 0) finish({ ok: true });
        else finish({
          ok: false,
          /* 用户在 UAC 上点"否"时 PowerShell 会报这条，翻译成人话 */
          error: /canceled|cancelled|被用户取消|操作已被取消/i.test(errOut)
            ? '你取消了管理员授权，更新没有开始'
            : (errOut.trim() || ('提权启动失败（退出码 ' + code + '）')),
        });
      });
    } catch (e) {
      finish({ ok: false, error: (e && e.message) || String(e) });
    }
  });
}

/**
 * 拉起静默安装器：先直接 spawn，不行再走 UAC。
 * @returns {Promise<{ok:boolean, method?:string, error?:string}>}
 */
async function startSilentInstaller(options) {
  const o = options || {};
  const command = o.installerPath;
  const args = o.args || buildSilentArgs(o);
  const log = typeof o.log === 'function' ? o.log : () => {};
  if (!command) return { ok: false, error: '没有安装程序路径' };

  const direct = await spawnAndObserve({
    spawnImpl: o.spawnImpl,
    command, args,
    observeMs: o.observeMs,
    sleep: o.sleep,
    log,
  });
  if (direct.ok) {
    log('安装器已启动（直接方式，pid=' + direct.pid + '）');
    return { ok: true, method: 'direct', pid: direct.pid };
  }

  /* 直接方式失败：多半是客户端自己没提权（CreateProcess 不能提权）。
     退回 ShellExecute(runas)，让用户点一下 UAC —— 总比"软件直接消失"好。 */
  log('改用提权方式启动安装器…');
  const runElevated = o.runElevated || defaultRunElevated;
  const elevated = await runElevated(command, args);
  if (elevated && elevated.ok) {
    log('安装器已启动，提权方式');
    return { ok: true, method: 'elevated' };
  }
  return {
    ok: false,
    method: 'elevated',
    error: (elevated && elevated.error) || direct.error || '启动安装器失败',
  };
}

module.exports = {
  DEFAULT_SILENT_FLAG,
  DEFAULT_OBSERVE_MS,
  buildSilentArgs,
  spawnAndObserve,
  defaultRunElevated,
  startSilentInstaller,
};
