/*
 * 便携安装包"双击就出窗口"的守卫。
 *
 * 背景：安装器是 electron-builder 的 portable 目标（自解压包）。
 * portable.nsi 的 .onInit 里写着 —— 没配 SPLASH_IMAGE 就 `SetSilent silent`，
 * 解压 452MB 的整个过程一个窗口都没有，用户看到的就是"双击了没反应"。
 *
 * 配了 splashImage 之后窗口会建出来，但原版紧接着在 Section 开头 `HideWindow`
 * 又把它藏了。而 BgImage 到底是画在窗口上还是自己开窗口，没法在本机确认
 * （插件随构建时才下载的 nsis-resources 分发）。
 * 所以 installer/scripts/patch-portable-nsis.js 在构建前把 HideWindow 去掉 ——
 * 两种语义下都成立，用户至少能看见一个带品牌底图的进度窗口。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname);
const patch = require('./scripts/patch-portable-nsis.js');

const ORIGINAL_FIXTURE = [
  'Function .onGUIInit',
  '  !ifdef SPLASH_IMAGE',
  '    BgImage::SetBg $PLUGINSDIR\\splash.bmp',
  '  !endif',
  'FunctionEnd',
  '',
  'Section',
  '  !ifdef SPLASH_IMAGE',
  '    HideWindow',
  '  !endif',
  '',
  '  StrCpy $INSTDIR "$PLUGINSDIR\\app"',
].join('\n');

test('补丁会去掉解压时的 HideWindow', () => {
  const out = patch.patchSource(ORIGINAL_FIXTURE);
  assert.equal(out.changed, true, '没有识别出要改的那一段');
  assert.equal(/\n\s*HideWindow\s*\n/.test(out.source), false,
    'HideWindow 还在 —— 配了 splashImage 也会被立刻藏起来，用户照样什么都看不到');
  assert.ok(out.source.includes('StrCpy $INSTDIR'), '把后面的内容改坏了');
});

test('重复打补丁不报错（幂等）', () => {
  const once = patch.patchSource(ORIGINAL_FIXTURE).source;
  const twice = patch.patchSource(once);
  assert.equal(twice.changed, false, '第二次应该识别为"已打过"并跳过');
  assert.equal(twice.source, once, '第二次不该再改内容');
});

test('模板改版时必须报错，不能静默跳过', () => {
  const alien = 'Section\n  ; 模板完全变了\n';
  assert.throws(() => patch.patchSource(alien), /找不到要替换的那一段/,
    'electron-builder 升级改了模板时要在这里炸掉 —— ' +
    '静默跳过的话构建照常成功，但补丁没打上，用户依旧看不到窗口');
});

test('dist 脚本必须先打补丁再构建', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const dist = pkg.scripts.dist;
  const patchAt = dist.indexOf('patch-portable-nsis.js');
  const buildAt = dist.indexOf('electron-builder');
  assert.ok(patchAt > 0, 'dist 里没有调用 patch-portable-nsis.js');
  assert.ok(buildAt > 0, 'dist 里没有 electron-builder');
  assert.ok(patchAt < buildAt, '补丁必须排在 electron-builder 之前');
});

test('package.json 配了 splashImage，且文件真的在', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const splash = pkg.build && pkg.build.portable && pkg.build.portable.splashImage;
  assert.ok(splash, 'portable.splashImage 没配 —— 那 SetSilent silent 一开，连窗口都不会建');
  assert.ok(fs.existsSync(path.join(ROOT, splash)), 'splashImage 指向的文件不存在：' + splash);
  /* electron-builder 的 NsisTarget.js 是 path.resolve(projectDir, splashImage)，
     所以这里也要按项目目录解析，两边才会指到同一个文件 */
  assert.equal(splash, 'splash.bmp', '路径形式变了，确认 NsisTarget.js 的解析方式仍然对得上');
});

test('splash 必须是 24 位无压缩 BMP，尺寸别超过普通安装窗口', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'splash.bmp'));
  assert.equal(buf.toString('ascii', 0, 2), 'BM', '不是 BMP 文件');
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  assert.equal(bpp, 24, '必须是 24 位 —— 其它位深/调色板的 BMP 在 NSIS 里不一定能画');
  assert.equal(compression, 0, '必须是 BI_RGB 无压缩');
  assert.ok(width > 0 && height > 0 && width <= 800 && height <= 600,
    `尺寸 ${width}x${height} 不合适：NSIS 安装窗口不大，图太大反而显示不全`);
  assert.equal(buf.length, offset + width * 3 * height + (4 - (width * 3) % 4) % 4 * height,
    '文件长度和 BMP 头对不上');
});
