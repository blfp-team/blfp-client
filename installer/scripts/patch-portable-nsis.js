/*
 * 构建前给 electron-builder 的 portable 模板打补丁。
 *
 * 为什么需要这个：`portable` 目标**不支持**自定义 NSIS 脚本
 * （PortableOptions 继承的 CommonNsisOptions 里没有 include / script，
 * 那两个只在 nsis 目标上）。所以在 dist 之前直接改模板文件，是唯一的办法。
 *
 * 改什么：原版 portable.nsi 的解压 Section 第一件事是 `HideWindow`：
 *
 *     Section
 *       !ifdef SPLASH_IMAGE
 *         HideWindow
 *       !endif
 *
 * 配了 splashImage 时窗口是先建出来了（.onInit 不设 SetSilent silent），
 * 但紧接着就被藏起来。而 BgImage 插件到底是"画在安装器窗口上"还是
 * "自己开一个窗口"我无法在本机确认（它随构建时才下载的 nsis-resources 分发）。
 * 如果是前者，这一藏就等于把 splash 也藏了 —— 用户还是什么都看不到，
 * 白配这一趟。
 *
 * 去掉 HideWindow 在两种语义下都成立：
 *   - 画在窗口上 → 窗口留着，图看得见
 *   - 自己开窗口 → 多出一个 NSIS 进度窗口，正好还能显示解压进度
 * 而 instfiles 页面本来就会在 `File /r` 期间显示进度条，所以用户看到的是
 * "带 BLFP 品牌底图的进度窗口"，解压全程可见。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(
  __dirname, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'portable.nsi'
);

/* 原版那一小段，逐字匹配 */
const ORIGINAL = [
  'Section',
  '  !ifdef SPLASH_IMAGE',
  '    HideWindow',
  '  !endif',
  '',
].join('\n');

const PATCHED = [
  'Section',
  '  ; electron-builder 原版这两行是：',
  '  ;   !ifdef SPLASH_IMAGE',
  '  ;     HideWindow',
  '  ;   !endif',
  '  ; 被 installer/scripts/patch-portable-nsis.js 去掉了 ——',
  '  ; 窗口留着不藏，splash 底图和解压进度条才看得见。原因见那个脚本。',
  '',
].join('\n');

/** 纯函数，方便单测：把补丁打在一段源码上 */
function patchSource(source) {
  if (source.includes(PATCHED)) return { source, changed: false };   // 已经打过
  if (!source.includes(ORIGINAL)) {
    throw new Error(
      'portable.nsi 里找不到要替换的那一段 —— electron-builder 可能升级后改了模板。\n' +
      '请对照 templates/nsis/portable.nsi 的 Section 开头，更新本脚本里的 ORIGINAL。'
    );
  }
  return { source: source.replace(ORIGINAL, PATCHED), changed: true };
}

function main() {
  if (!fs.existsSync(TEMPLATE)) {
    console.error('[patch-portable] 找不到模板: ' + TEMPLATE);
    console.error('[patch-portable] 先装依赖（npm ci），再跑构建。');
    process.exit(1);
  }
  const before = fs.readFileSync(TEMPLATE, 'utf8');
  let result;
  try {
    result = patchSource(before);
  } catch (e) {
    console.error('[patch-portable] ' + e.message);
    process.exit(1);
  }
  if (!result.changed) {
    console.log('[patch-portable] 模板已经是打过补丁的状态，跳过');
    return;
  }
  fs.writeFileSync(TEMPLATE, result.source);
  console.log('[patch-portable] 已去掉便携包解压时的 HideWindow，窗口会保持可见');
}

if (require.main === module) main();
module.exports = { patchSource, TEMPLATE, ORIGINAL, PATCHED };
