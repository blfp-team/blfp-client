/* BLFP 安装程序：加载 → 用户手册/守则/声明 → 验证码校验 → 安装 */
const $ = (id) => document.getElementById(id);
let installedExe = null;
let verifyCode = '';

function showStep(id) {
  document.querySelectorAll('.step').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}

/* ---------- ① 加载：按真实自检项推进 ---------- */
async function runLoading() {
  const steps = [
    { text: '正在校验安装包数据…', to: 25 },
    { text: '正在检查安装目录…', to: 50 },
    { text: '正在读取用户手册与声明…', to: 75 },
    { text: '正在准备安装组件…', to: 100 },
  ];
  let percent = 0;
  const setLoading = (p, text) => {
    percent = p;
    $('loading-fill').style.width = p + '%';
    $('loading-pct').textContent = Math.round(p) + '%';
    if (text) $('loading-text').textContent = text;
  };
  setLoading(5, '正在启动安装程序…');

  let info = null;
  try { info = await window.installer.selfCheck(); } catch (e) { info = null; }

  for (const step of steps) {
    /* 平滑推进到目标百分比 */
    while (percent < step.to) {
      setLoading(Math.min(step.to, percent + 4), percent < step.to - 4 ? step.text : null);
      await new Promise((r) => setTimeout(r, 45));
    }
    setLoading(step.to, step.text);
    await new Promise((r) => setTimeout(r, 160));
  }

  /* 安装包异常时直接给出可读错误，而不是等安装到 80% 才失败 */
  if (info && !info.payloadOk) {
    $('error-text').textContent = '安装包数据不完整，请重新下载安装程序。\n\n' + (info.diagnostic || '');
    showStep('step-error');
    return;
  }
  $('loading-text').textContent = '加载完成';
  await new Promise((r) => setTimeout(r, 250));
  showStep('step-doc');
}

/* ---------- ② 用户手册页 ---------- */
async function initDoc() {
  try { verifyCode = await window.installer.getVerifyCode(); } catch (e) { verifyCode = ''; }
  $('verify-code').textContent = verifyCode || '------';
}

$('btn-quit-doc').addEventListener('click', () => window.installer.quit());

$('btn-next').addEventListener('click', () => {
  $('verify-error').textContent = '';
  $('verify-input').value = '';
  $('verify-modal').classList.remove('hidden');
  $('verify-input').focus();
});

/* ---------- 验证码弹窗 ---------- */
function closeVerify() { $('verify-modal').classList.add('hidden'); }

$('btn-verify-cancel').addEventListener('click', closeVerify);

async function submitVerify() {
  const value = ($('verify-input').value || '').trim();
  if (!/^\d{6}$/.test(value)) {
    $('verify-error').textContent = '请输入守则末尾的 6 位数字验证码';
    return;
  }
  let res;
  try { res = await window.installer.verifyCode(value); } catch (e) { res = { ok: false }; }
  if (res && res.ok) {
    closeVerify();
    showStep('step-setup');
  } else {
    $('verify-error').textContent = '验证码不正确，请重新查看「用户守则」末尾的数字';
    $('verify-input').value = '';
    $('verify-input').focus();
  }
}
$('btn-verify-ok').addEventListener('click', submitVerify);
$('verify-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitVerify(); });

/* ---------- ③ 安装选项 ---------- */
(async () => {
  try { $('install-dir').value = await window.installer.getDefaultDir(); } catch (e) {}
})();
$('btn-browse').addEventListener('click', async () => {
  const d = await window.installer.chooseDir();
  if (d) $('install-dir').value = d;
});
$('btn-cancel').addEventListener('click', () => window.installer.quit());

$('btn-install').addEventListener('click', async () => {
  const dir = $('install-dir').value.trim();
  if (!dir) return;
  showStep('step-progress');
  $('progress-fill').style.width = '0%';
  $('progress-pct').textContent = '0%';
  const res = await window.installer.install({
    dir,
    desktopShortcut: $('opt-desktop').checked,
    startMenuShortcut: $('opt-startmenu').checked,
  });
  if (res && res.ok) {
    installedExe = res.exePath;
    $('done-text').textContent = 'BLFP 已成功安装到：' + dir;
    showStep('step-done');
  } else {
    $('error-text').textContent = '安装失败：' + ((res && res.error) || '未知错误');
    showStep('step-error');
  }
});

window.installer.onProgress(({ percent, text }) => {
  $('progress-fill').style.width = percent + '%';
  $('progress-pct').textContent = percent + '%';
  if (text) {
    $('progress-text').textContent = text;
    /* 启动客户端时已经在「完成」页，把状态同步过去，避免看着像卡住 */
    if ($('step-done').classList.contains('active')) $('done-text').textContent = text;
  }
});

/* ---------- ④ 完成 ---------- */
$('btn-finish').addEventListener('click', async () => {
  if ($('opt-launch').checked && installedExe) {
    /* 客户端需要管理员权限，启动时系统会弹 UAC，这里先说明 */
    $('done-text').textContent = '正在启动 BLFP…';
    try {
      const res = await window.installer.launch(installedExe);
      if (res && res.ok === false) {
        $('error-text').textContent = '启动客户端失败：' + (res.error || '未知错误') + '\n请手动双击桌面上的 BLFP 快捷方式启动。';
        showStep('step-error');
      }
    } catch (e) {
      $('error-text').textContent = '启动客户端失败：' + e.message + '\n请手动双击桌面上的 BLFP 快捷方式启动。';
      showStep('step-error');
    }
  } else {
    window.installer.quit();
  }
});
$('btn-retry').addEventListener('click', () => showStep('step-setup'));
$('btn-close-err').addEventListener('click', () => window.installer.quit());

/* ---------- 启动 ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  await initDoc();
  runLoading();
});
