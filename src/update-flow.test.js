/*
 * 软件内更新的接线测试。
 *
 * 用户要的效果：点更新 → 软件内进度条 → 自动挑源下载 → 不出现安装程序界面
 *              → 最快速安装 → 第一时间把客户端拉起来。
 *
 * 这条链子横跨两个工程（客户端 main.js / preload.js / renderer 与安装器 main.js），
 * 任何一处对不上都是"点了更新没反应"或者"弹出了安装程序界面"这种用户直接能看到的 bug，
 * 而且很难在本地复现，所以这里把关键约定全部钉死。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const MAIN = read('main.js');
const MAIN_CODE = strip(MAIN);
const PRELOAD = read('preload.js');
const APP = read('renderer', 'app.js');
const HTML = read('renderer', 'index.html');
const INSTALLER_MAIN = read('installer', 'main.js');

const handler = (name) => {
  const i = MAIN_CODE.indexOf(`ipcMain.handle('${name}'`);
  assert.ok(i > 0, `main.js 里没有 ${name} 这个 IPC`);
  return MAIN_CODE.slice(i, MAIN_CODE.indexOf('\n});', i));
};

/* ================= 隐藏参数必须两边一致 ================= */

test('客户端拉安装器用的隐藏参数必须和安装器认的完全一致', () => {
  const core = require('../installer/install-core.js');
  const launch = require('./update-launch.js');
  assert.equal(launch.DEFAULT_SILENT_FLAG, core.SILENT_FLAG,
    `客户端用的参数与安装器认的（${core.SILENT_FLAG}）不一致 —— ` +
    '那安装器就会当成"用户双击"，直接弹出安装界面');
  /* 端到端：客户端拼出来的参数，安装器必须真的解析成"静默 + 装到指定目录 + 装完重启" */
  const args = launch.buildSilentArgs({ targetDir: require('path').resolve('BLFP') });
  const parsed = core.parseSilentArgs(['electron.exe'].concat(args));
  assert.equal(parsed.silent, true, '安装器没把这串参数当成静默安装');
  assert.equal(parsed.relaunch, true, '安装器没解析出"装完要重启客户端"');
  assert.equal(parsed.target, require('path').resolve('BLFP'), '安装器没解析出目标目录');
  assert.ok(INSTALLER_MAIN.includes('core.parseSilentArgs'), '安装器没有解析这个参数');
});

/* ================= 下载：挑源 + 进度 ================= */

test('start-update 用 update-download 模块下载（挑源与换源都在里面）', () => {
  const body = handler('start-update');
  assert.ok(/downloadWithFallback\(/.test(body), '没有用统一的下载器，挑源/换源就无从谈起');
  /* 现在要带上 assetName：自家下载服务器是按文件名拼 /download/<file> 的；
     还要带上主地址 url —— 镜像候选必须跟随主地址协议，不能写死 http */
  assert.ok(/mirrors:\s*buildUpdateMirrors\(assetName,\s*url\)/.test(body), '没有传入镜像源候选（或没带上 assetName / 主地址）');
  assert.ok(/onProgress:/.test(body), '没有把下载进度接出来 —— 用户就看不到进度条');
});

test('必须是 HTTPS 才允许下载（不能被降级到明文）', () => {
  assert.ok(/\^https:\\\/\\\//.test(MAIN_CODE) || /\/\^https:/.test(MAIN_CODE),
    'start-update 没有校验下载地址是 HTTPS');
});

test('镜像源候选里有直连，也有至少一个加速源（用户网络访问 GitHub 常常不通）', () => {
  const body = MAIN_CODE.slice(MAIN_CODE.indexOf('function buildUpdateMirrors'));
  const prefixes = body.match(/prefix:\s*'([^']*)'/g) || [];
  assert.ok(prefixes.some((p) => p.includes("''")), '候选里缺少直连');
  assert.ok(prefixes.length >= 3, '候选太少，一个都不通时就没得换了（实际 ' + prefixes.length + ' 个）');
});

/* ================= 静默安装 + 秒退 ================= */

test('下载完把安装器以隐藏参数拉起来，且是脱离父进程运行', () => {
  const body = handler('start-update');
  assert.ok(/startSilentInstaller\(/.test(body),
    '没有走 startSilentInstaller —— 它负责确认安装器真的起来了（含提权兜底）');
  /* detached / unref / windowsHide 现在由 update-launch.js 统一实现，去那边断言 */
  const launch = fs.readFileSync(path.join(ROOT, 'src', 'update-launch.js'), 'utf8');
  assert.ok(/detached:\s*true/.test(launch), '不是 detached —— 客户端一退出安装器就跟着没了');
  assert.ok(/unref\(\)/.test(launch), '没有 unref，客户端可能退不干净');
  assert.ok(/windowsHide:\s*true/.test(launch), '没有隐藏窗口 —— 可能会闪一个黑框');
});

test('安装器没启动成功时绝不能退出客户端（否则软件直接消失）', () => {
  const body = handler('start-update');
  const launchAt = body.indexOf('startSilentInstaller(');
  const guardAt = body.indexOf('if (!launched.ok)');
  const exitAt = body.indexOf('app.exit(0)');
  assert.ok(launchAt > 0 && guardAt > launchAt && exitAt > guardAt,
    '退出必须排在"确认安装器已启动"之后：客户端没提权时 spawn 会异步失败，' +
    '如果先退出，用户看到的就是"点更新，软件没了"，只能重装');
  /* 守卫分支里必须 return，不能只是提示一下就往下走。
     注意别用"到第一个 } 为止"来切块 —— 里面 send({...}) 的 } 会把它提前截断。 */
  const guardBlock = body.slice(guardAt, exitAt);
  assert.ok(/return\s*\{\s*ok:\s*false/.test(guardBlock),
    '启动失败的守卫没有 return { ok: false }，会继续走到退出');
  assert.ok(!/app\.exit/.test(guardBlock), '启动失败的守卫里居然在退出客户端');
});

test('拉起安装器后客户端必须立刻退出（不退就占着 BLFP.exe，安装器写不进去）', () => {
  const body = handler('start-update');
  const spawnAt = body.indexOf('startSilentInstaller(');
  const exitAt = body.indexOf('app.exit(0)');
  assert.ok(exitAt > spawnAt, '没有在拉起安装器之后退出客户端');
  /* 退出的 setTimeout 的延迟写在 app.exit(0) 之后，所以从 spawn 往后整段找 */
  const afterSpawn = body.slice(spawnAt);
  const m = afterSpawn.match(/setTimeout\(\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*(\d+)\s*\)/);
  assert.ok(m, '退出没有延迟控制，可能在安装器起来之前就把自己关了');
  assert.ok(Number(m[1]) <= 2000,
    '退出延迟 ' + m[1] + ' 毫秒太久了，用户会看到"卡一下才重启"');
});

test('安装目标目录取的是客户端自己的安装目录（不能装到别处去）', () => {
  assert.ok(/getPath\(\'exe\'\)/.test(MAIN_CODE), '没有用 BLFP.exe 所在目录作为安装目录');
  assert.ok(/targetDir:\s*installDir/.test(handler('start-update')),
    '没有把安装目录交给启动器');
});

test('会传 --relaunch，让安装器装完把客户端拉起来', () => {
  /* buildSilentArgs 默认带 --relaunch，除非显式 relaunch:false */
  const launch = require('./update-launch.js');
  assert.ok(launch.buildSilentArgs({ targetDir: 'x' }).includes('--relaunch'),
    '没传 --relaunch 的话装完客户端不会自己回来，用户会以为装坏了');
});

/* ================= 渲染层：进度条 ================= */

test('更新弹窗里有进度条三件套', () => {
  for (const id of ['update-progress', 'update-progress-fill', 'update-progress-text']) {
    assert.ok(HTML.includes(`id="${id}"`), `更新弹窗缺少 #${id}`);
  }
});

test('弹窗按钮走软件内更新，而不再是打开浏览器下载', () => {
  const m = HTML.match(/id="update-download"[^>]*onclick="([^"]+)"/);
  assert.ok(m, '找不到更新按钮');
  assert.ok(/startUpdate\(\)/.test(m[1]),
    '按钮还在调用 ' + m[1] + ' —— 那就还是"打开下载页"，不是软件内更新');
});

test('渲染层订阅了主进程推来的进度', () => {
  assert.ok(/onUpdateProgress\(/.test(APP), '没有订阅 update-progress');
  assert.ok(/phase === 'download'/.test(APP), '没有处理下载阶段');
  assert.ok(/'install'/.test(APP), '没有处理"后台安装中"阶段');
});

test('preload 暴露了 startUpdate 与 onUpdateProgress', () => {
  assert.ok(/startUpdate:\s*\(opts\)\s*=>\s*ipcRenderer\.invoke\('start-update'/.test(PRELOAD),
    'preload 没暴露 startUpdate');
  assert.ok(/onUpdateProgress:\s*\(cb\)\s*=>\s*ipcRenderer\.on\('update-progress'/.test(PRELOAD),
    'preload 没暴露 onUpdateProgress');
});

test('更新失败要能重试，并且不让用户把弹窗关掉看不到进度', () => {
  const body = APP.slice(APP.indexOf('async function startUpdate()'));
  const fn = body.slice(0, body.indexOf('\nfunction openUpdateDownload'));
  assert.ok(/btn\.textContent = '重试'/.test(fn), '失败后按钮没有变成"重试"');
  assert.ok(/updateInFlight/.test(fn), '没有防重入，连点会开出多个下载');
});

test('重新打开更新弹窗会复位进度条（否则上次的"更新失败"一直挂着）', () => {
  assert.ok(/function resetUpdateProgressUI/.test(APP), '没有复位函数');
  const i = APP.indexOf("$('update-download').textContent");
  const around = APP.slice(Math.max(0, i - 300), i + 300);
  assert.ok(/resetUpdateProgressUI\(\)/.test(around),
    '打开更新弹窗时没有复位进度条');
});

/* ================= 不能把老路径悄悄退回去 ================= */

test('"稍后"按钮仍可关闭弹窗（不能把用户锁在更新弹窗里）', () => {
  const m = HTML.match(/id="update-later"[^>]*onclick="([^"]+)"/);
  assert.ok(m, '找不到"稍后"按钮');
  assert.ok(/closeModal\('update-modal'\)/.test(m[1]), '稍后按钮关不掉弹窗');
});

/* ================= 更新失败必须看得见 ================= */

test('客户端把 --status-file 传给安装器（否则失败原因无处可查）', () => {
  const body = handler('start-update');
  assert.ok(/statusFile:\s*updateStatusFile\(\)/.test(body), '没有把状态文件路径交给启动器');
  assert.ok(/function updateStatusFile/.test(MAIN_CODE), '没有 updateStatusFile 实现');
  const launch = require('./update-launch.js');
  const args = launch.buildSilentArgs({ targetDir: 'x', statusFile: 'C:\\s.json' });
  assert.ok(args.includes('--status-file'), 'buildSilentArgs 没带上 --status-file');
  assert.ok(args.includes('C:\\s.json'), '状态文件路径没传进去');
  /* 安装器必须真的认这个参数 */
  const core = require('../installer/install-core.js');
  const parsed = core.parseSilentArgs(['e.exe'].concat(args));
  assert.equal(parsed.statusFile, require('path').resolve('C:\\s.json'),
    '安装器没解析出状态文件路径 —— 写了也白写');
});

test('客户端启动时会读上次更新的结果，失败要报出来', () => {
  assert.ok(/ipcMain\.handle\('read-update-status'/.test(MAIN_CODE), '没有读状态的 IPC');
  assert.ok(/readUpdateStatus/.test(PRELOAD), 'preload 没暴露 readUpdateStatus');
  assert.ok(/function reportLastUpdateResult/.test(APP), '渲染层没有报告函数');
  const body = APP.slice(APP.indexOf('async function reportLastUpdateResult'));
  const fn = body.slice(0, body.indexOf('\nasync function checkForUpdates'));
  assert.ok(/st\.ok === false/.test(fn), '没有判断失败');
  assert.ok(/toast\([^)]*'error'\)/.test(fn), '失败没有用红色通知报出来');
  /* 必须挂在自动检查更新的调用点上，否则启动时不会执行 */
  const calls = APP.match(/checkForUpdates\(\);\n\s*reportLastUpdateResult\(\);/g) || [];
  assert.ok(calls.length >= 3, '自动检查更新的入口没有全部接上报告（接了 ' + calls.length + ' 处）');
});

test('状态只报一次（读走就删，不能每次启动都弹）', () => {
  const body = MAIN_CODE.slice(MAIN_CODE.indexOf("ipcMain.handle('read-update-status'"));
  const fn = body.slice(0, body.indexOf('\n});'));
  assert.ok(/unlinkSync\(file\)/.test(fn), '读完没有删除状态文件，会每次启动都弹一次');
});

/* ================= 写不进去时不能崩 ================= */

test('下载前先确认临时安装包写得进去，写不进去就换个名字', () => {
  const body = handler('start-update');
  assert.ok(/resolveInstallerDest\(assetName\)/.test(body),
    '直接按固定文件名去写 —— 那个文件被上一个安装器/杀软占着时就是 EPERM（真实事故）');
  assert.ok(!/const dest = updateInstallerPath\(/.test(body),
    '还在直接用固定路径，没走可写性预检');
  assert.ok(/function resolveInstallerDest/.test(MAIN_CODE), '没有 resolveInstallerDest 实现');
  const fn = MAIN_CODE.slice(MAIN_CODE.indexOf('function resolveInstallerDest'));
  assert.ok(/openSync\(/.test(fn.slice(0, fn.indexOf('\n}'))),
    'resolveInstallerDest 没有真的试写一下，只是拼了个名字');
  assert.ok(/Math\.random\(\)/.test(fn.slice(0, fn.indexOf('\n}'))),
    '换的名字没有随机/时间戳，第二次还是会撞上同一个被占用的文件');
});

test('换名字产生的安装包要有人清，不能把临时目录堆满 200MB', () => {
  assert.ok(/function sweepOldInstallers/.test(MAIN_CODE), '没有清理函数');
  assert.ok(/sweepOldInstallers\(dest\)/.test(handler('start-update')), '下载前没有清理旧安装包');
});

test('主进程有未捕获异常兜底，用户不该看到原始 JS 报错框', () => {
  assert.ok(/process\.on\('uncaughtException'/.test(MAIN_CODE),
    '没有兜底 —— 任何一处漏掉的异步错误都会弹"A JavaScript error occurred in the main process"');
  const i = MAIN_CODE.indexOf("process.on('uncaughtException'");
  const fn = MAIN_CODE.slice(i, i + 900);
  assert.ok(/LOG_PATH/.test(fn), '兜底没有把异常写进日志，用户/我们事后查不到');
  assert.ok(/appendFileSync\(LOG_PATH/.test(fn), '没有真的写日志文件');
  assert.ok(/showErrorBox/.test(fn), '没有给用户任何提示，异常会被静默吞掉');
});
