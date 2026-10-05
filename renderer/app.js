/* ============ 全局状态 ============ */
const DEFAULT_SERVER = 'http://154.40.43.136:4000';   /* 主服务器：登录/房间/好友/设置 */
const DEFAULT_CHAT_SERVER = 'http://154.40.43.136:4001'; /* 聊天公告专用服务器 */
/* 主服务器候选：启动时自动探测，哪个能通用哪个 */
const SERVER_CANDIDATES = [
  'http://154.40.43.136:4000',
  'https://p.blfp.cn',
];
/* 聊天/公告服务器候选：探测失败时回退到主服务器（主服务器同样带聊天+公告能力） */
const CHAT_SERVER_CANDIDATES = [
  'http://154.40.43.136:4001',
];
const GITHUB_REPO_URL = 'https://github.com/blfp-team/blfp-client';
const state = {
  server: DEFAULT_SERVER,
  chatServer: DEFAULT_CHAT_SERVER,   // 聊天/公告专用服务器
  chatWs: null,        // 聊天室独立 WebSocket
  publicRooms: [],     // 最近一次获取的公开房间列表（详情降级用）
  joinTimer: null,     // 加入房间超时计时器
  roomInfo: null,      // 房间信息（加入后由服务端下发）
  geetestValidate: null, // 极验验证回调
  token: null,
  user: null,
  mode: 'easytier',
  ws: null,            // 信令 WebSocket
  role: null,          // 'host' | 'guest'
  roomCode: null,
  mcPort: 25565,
  easytier: { state: 'stopped', running: false, virtualIp: null, error: null },
  frpNodes: [],
  frpNodeId: null,
  frpNode: null,
  frpEndpoint: null,
  frpTunnelName: '',
  etNodes: [],
  etNodeMode: 'auto',
  hostResetPromise: null,
  members: [],
  maxMembers: 12,
  appInfo: null,
  updateInfo: null,
  signingKey: null,
  signingKeyToken: null,
  debugMode: false,
  isPublic: false,
  presenceTimer: null,
  closingSignaling: false,
  announcement: null,
  announcementTimer: null,
  updateChannel: 'stable',  /* stable: 正式版(忽略pre) | test: 测试版(含最新pre) */
};

/* ============ 工具函数 ============ */
function $(id) { return document.getElementById(id); }

function toast(msg, type = '') {
  const wrap = $('toast-wrap');
  if (!wrap) return console.error('Toast 容器未准备:', msg);
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  wrap.appendChild(el);
  // 退场必须走 CSS 动画（滑回去）：.toast 没有 transition，直接改 opacity 会瞬间消失。
  // 动画被禁用时（性能模式 / 系统减少动态效果）animationend 不会触发，用定时器兜底移除。
  const dismiss = () => {
    if (el.classList.contains('leaving')) return;
    el.classList.add('leaving');
    let removed = false;
    const finish = () => { if (removed) return; removed = true; el.remove(); };
    el.addEventListener('animationend', finish);
    setTimeout(finish, 700);
  };
  setTimeout(dismiss, 3000);
}

function logLine(msg) {
  const time = new Date().toLocaleTimeString();
  /* 先写日志文件（界面日志框不存在时也不丢日志，PowerShell 才能看到内容） */
  writeLogFile('[' + time + '] ' + msg);
  const box = $('log-box');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = `[${time}] ${msg}`;
  box.appendChild(line);
  const maxLines = state.debugMode ? 2000 : 500;
  while (box.childElementCount > maxLines) box.firstElementChild.remove();
  if (nearBottom) box.scrollTop = box.scrollHeight;
}
/* 日志同时写入文件（%APPDATA%\\BLFP\\logs\\blfp.log），供"在 PowerShell 中查看日志"实时跟随 */
let logFileBuffer = [];
let logFileFlushTimer = null;
function flushLogFile() {
  logFileFlushTimer = null;
  if (!logFileBuffer.length) return;
  const lines = logFileBuffer;
  logFileBuffer = [];
  try {
    if (window.mclink && window.mclink.appendLog) window.mclink.appendLog(lines);
  } catch (e) {}
}
function writeLogFile(line) {
  logFileBuffer.push(line);
  if (logFileBuffer.length >= 20) { flushLogFile(); return; }
  if (!logFileFlushTimer) logFileFlushTimer = setTimeout(flushLogFile, 400);
}
window.addEventListener('beforeunload', flushLogFile);


function debugLog(msg) {
  if (state.debugMode) logLine('[调试] ' + msg);
}


/* ====== 服务器自动探测：按候选顺序试 /api/health，取第一个可用的 ====== */
async function probeServer(url, timeoutMs) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 4000);
    const res = await fetch(url + '/api/health', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) return false;
    /* 必须数据库就绪（ready:true）——否则会选到"服务活着但数据库没连上"的实例，报"数据库尚未就绪" */
    const data = await res.json().catch(() => ({}));
    return data.ok !== false && data.ready === true;
  } catch (e) { return false; }
}

/* ====== 应用内日志窗口（始终可用，不依赖 PowerShell）====== */
let logViewerTimer = null;
async function refreshLogViewer() {
  const pre = document.querySelector('.log-viewer-pre');
  if (!pre) return;
  try {
    const res = await window.mclink.readLog(500);
    if (res && res.ok) {
      pre.textContent = res.text || '日志为空';
      pre.scrollTop = pre.scrollHeight;
    } else {
      pre.textContent = '读取日志失败：' + ((res && res.error) || '未知错误');
    }
  } catch (e) {
    pre.textContent = '读取日志失败：' + e.message;
  }
}
async function openLogViewer() {
  let res = null;
  try { res = await window.mclink.readLog(500); } catch (e) {}
  showModal('log-viewer-modal',
    '<h3>运行日志</h3>' +
    '<p style="font-size:.75rem;color:var(--text2);margin-bottom:8px">' +
      escapeHtml((res && res.logPath) || '') +
    '</p>' +
    '<pre class="log-viewer-pre diag-pre" style="max-height:52vh">正在读取…</pre>' +
    '<div class="modal-actions">' +
      '<button class="btn btn-outline btn-sm" onclick="openLogFolder()">打开日志文件夹</button>' +
      '<button class="btn btn-outline btn-sm" onclick="exportDiagnostics()">导出诊断</button>' +
      '<button class="btn btn-primary btn-sm" onclick="closeModal(\'log-viewer-modal\')">关闭</button>' +
    '</div>');
  refreshLogViewer();
  if (logViewerTimer) clearInterval(logViewerTimer);
  logViewerTimer = setInterval(() => {
    if (!document.querySelector('.log-viewer-pre')) { clearInterval(logViewerTimer); logViewerTimer = null; return; }
    refreshLogViewer();
  }, 2000);
}
async function openLogFolder() {
  try {
    const res = await window.mclink.openLogFolder();
    if (res && res.ok) toast('已打开日志文件夹', 'success');
    else notify('打开失败：' + ((res && res.error) || '未知错误'), 'error');
  } catch (e) { notify('打开失败：' + e.message, 'error'); }
}

/* ====== EasyTier 需要管理员权限：不再默认提权，需要时提示用户以管理员重启 ====== */
async function isElevated() {
  try {
    if (!window.mclink || !window.mclink.isElevated) return true;
    return !!(await window.mclink.isElevated());
  } catch (e) { return false; }
}

function askElevation(what) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const t = $('confirm-title');
    const m = $('confirm-msg');
    if (t) t.textContent = '需要管理员权限';
    if (m) m.textContent = what + ' 需要创建虚拟网卡，必须以管理员身份运行。\n\n点「确定」会以管理员身份重启客户端，重启后请重新操作。点「取消」则保持当前权限，此时 EasyTier 用不了，可以改用 frp 中转模式。';
    openModal('confirm-modal');
    /* 与 showConfirm 共用同一套安全设置：不再直接往 $('confirm-cancel') 上写属性 */
    setConfirmHandlers(() => finish('elevate'), () => finish('cancel'));
  });
}

/* 返回 true 表示可以继续启动 EasyTier；false 表示已中断（正在提权重启或用户取消） */
async function ensureElevatedForEasyTier(what) {
  if (await isElevated()) return true;
  const choice = await askElevation(what);
  if (choice === 'elevate') {
    notify('正在以管理员身份重启客户端…');
    try { await window.mclink.relaunchElevated(); } catch (e) { notify('提权重启失败：' + e.message, 'error'); }
    return false;
  }
  notify('已取消：EasyTier 需要管理员权限，可改用 frp 中转模式', 'warn');
  return false;
}

/* ====== 登录过期统一处理（JWT 7天到期 / 服务器换密钥 / 改密码 → 所有请求 401）====== */
let sessionExpiredHandling = false;
async function handleSessionExpired(message) {
  if (sessionExpiredHandling) return;
  sessionExpiredHandling = true;
  try {
    notify(message || '登录已过期，请重新登录', 'error');
    /* 清理房间与隧道，避免留下孤儿进程 */
    try { if (state.role === 'guest') await leaveRoom(); else if (state.role === 'host') await closeRoom(); } catch (e) {}
    try { await stopEasyTier(); } catch (e) {}
    try { await window.mclink.frpcStop(); } catch (e) {}
    if (state.presenceTimer) { clearInterval(state.presenceTimer); state.presenceTimer = null; }
    if (state.joinTimer) { clearTimeout(state.joinTimer); state.joinTimer = null; }
    try { if (state.ws) { state.closingSignaling = true; state.ws.onclose = null; state.ws.close(); } } catch (e) {}
    try { if (state.chatWs) { state.chatWs.onclose = null; state.chatWs.close(); } } catch (e) {}
    state.ws = null;
    state.chatWs = null;
    state.token = null;
    state.user = null;
    state.signingKey = null;
    state.signingKeyToken = null;
    state.role = null;
    state.roomCode = null;
    state.roomInfo = null;
    try { localStorage.removeItem('mclink_token'); } catch (e) {}
    const main = $('main-app'); if (main) main.classList.add('hidden');
    const auth = $('auth-page'); if (auth) auth.classList.remove('hidden');
    /* 跟退出登录一样：过期后必须把验证码也重置并重新拉一个。
       否则旧控件还留着上一轮已消耗的 challenge（极验的 challenge 是一次性的），
       再登录会直接报"网络不给力"；而且旧的 validate 还可能被当成"验证通过"复用。 */
    if (typeof resetCaptchaState === 'function') { resetCaptchaState('login'); resetCaptchaState('reg'); }
    if (typeof refreshCaptchaBox === 'function') { refreshCaptchaBox('login'); refreshCaptchaBox('reg'); }
    showAuthErr(message || '登录已过期，请重新登录');
  } finally {
    setTimeout(() => { sessionExpiredHandling = false; }, 3000);
  }
}

/* 聊天/公告专用请求：走 chatServer，失败自动回退主服务器 */
async function apiChat(path, opts) {
  try {
    return await api(path, opts || {}, state.chatServer);
  } catch (e) {
    /* 聊天服务器不可用/密钥不一致（401/403）时回退主服务器——主服务器同样能读写公告 */
    if (state.chatServer !== state.server && /数据库尚未就绪|请求失败|无法连接|超时|未登录|登录已过期|权限/.test(e.message || '')) {
      logLine('聊天/公告服务器请求失败（' + e.message + '），已回退主服务器');
      state.chatServer = state.server;
      return api(path, opts || {}, state.server);
    }
    throw e;
  }
}

/* 探测聊天/公告服务器；不可用则回退到主服务器 */
async function resolveChatServer() {
  for (const url of CHAT_SERVER_CANDIDATES) {
    if (await probeServer(url)) {
      state.chatServer = url;
      logLine('聊天/公告服务器: ' + url);
      return url;
    }
    logLine('聊天/公告服务器不可用，回退主服务器: ' + url);
  }
  state.chatServer = state.server;
  logLine('聊天/公告使用主服务器: ' + state.server);
  return state.chatServer;
}

async function resolveServer() {
  for (const url of SERVER_CANDIDATES) {
    if (await probeServer(url)) {
      if (url !== state.server) logLine('已选择服务器: ' + url);
      state.server = url;
      const a = $('a-server'); if (a) a.value = url;
      const s = $('s-server'); if (s) s.value = url;
      return url;
    }
    logLine('服务器不可用，尝试下一个: ' + url);
  }
  logLine('警告：所有候选服务器均不可达，使用默认地址 ' + DEFAULT_SERVER);
  state.server = DEFAULT_SERVER;
  return DEFAULT_SERVER;
}

/* 已提醒过的明文服务器地址（每个 origin 只提醒一次） */
let insecureServerWarned = '';
function assertSecureServer(server) {
  const url = new URL(server);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !local && insecureServerWarned !== url.origin) {
    insecureServerWarned = url.origin;
    logLine('警告：服务器使用 HTTP 明文传输，登录密码未加密，建议尽快配置 HTTPS');
  }
  return url;
}

async function sha256Hex(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getSigningKey() {
  if (state.signingKeyToken === state.token && state.signingKey) return state.signingKey;
  const res = await fetch(state.server + '/api/auth/signing-key', {
    headers: { Authorization: 'Bearer ' + state.token },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.key) throw new Error(data.error || '获取安全会话密钥失败');
  state.signingKeyToken = state.token;
  state.signingKey = data.key;
  return data.key;
}

function isAuthEndpoint(path) {
  return /^\/auth\/(login|register|send-code|tfa)/.test(String(path || ''));
}

async function api(path, opts = {}, baseServer) {
  const base = baseServer || state.server;
  assertSecureServer(base);
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const method = (opts.method || 'GET').toUpperCase();
  if (state.token && method !== 'GET' && method !== 'HEAD') {
    const timestamp = Date.now().toString();
    const nonce = crypto.randomUUID();
    const bodyHash = await sha256Hex(opts.body || '{}');
    const keyHex = await getSigningKey();
    const keyBytes = new Uint8Array(keyHex.match(/.{2}/g).map((byte) => parseInt(byte, 16)));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const payload = [method, '/api' + path.split('?')[0], timestamp, nonce, bodyHash].join('\n');
    const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    headers['X-Timestamp'] = timestamp;
    headers['X-Nonce'] = nonce;
    headers['X-Signature'] = Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(base + '/api' + path, { ...opts, method, headers, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token && !isAuthEndpoint(path)) {
      /* token 失效：统一退回登录页，而不是让用户面对"点什么都没反应" */
      handleSessionExpired(data.error || '登录已过期，请重新登录');
    }
    if (!res.ok) {
      /* 把服务端附加字段（如 captcha:true、tfa_required）挂在 error 上，
         调用方不必靠匹配错误文案来判断失败原因 */
      const err = new Error(data.error || '请求失败 (' + res.status + ')');
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      /* 超时：换一个候选服务器再试一次 */
      const next = await switchServerCandidate();
      if (next) return api(path, opts);
      throw new Error('请求超时，请检查网络后重试');
    }
    /* 网络层失败（Failed to fetch 等）：多半是当前地址被代理/防火墙挡住，换候选重试 */
    if (e instanceof TypeError && base === state.server) {
      const next = await switchServerCandidate();
      if (next) {
        logLine('当前服务器不可达，已切换到 ' + next + ' 并重试');
        return api(path, opts);
      }
      throw new Error('无法连接服务器（' + state.server + '）。可能是本机代理未放行该地址，请尝试关闭系统代理后重试');
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

/* 切换到下一个可用候选服务器；没有可切换的返回 null */
let serverSwitchLock = false;
async function switchServerCandidate() {
  if (serverSwitchLock) return null;
  serverSwitchLock = true;
  try {
    const others = SERVER_CANDIDATES.filter((u) => u !== state.server);
    for (const url of others) {
      if (await probeServer(url)) {
        state.server = url;
        const a = $('a-server'); if (a) a.value = url;
        const s = $('s-server'); if (s) s.value = url;
        return url;
      }
    }
    return null;
  } finally { serverSwitchLock = false; }
}

function setLoginLoading(show, text = '登录中…') {
  $('login-loading-text').textContent = text;
  $('login-loading').classList.toggle('hidden', !show);
  $('btn-login').disabled = show;
}

/* ============ 登录鉴权 ============ */
function showAuthTab(tab) {
  $('tab-login').classList.toggle('active', tab === 'login');
  $('tab-reg').classList.toggle('active', tab === 'reg');
  $('form-login').classList.toggle('hidden', tab !== 'login');
  $('form-reg').classList.toggle('hidden', tab !== 'reg');
  $('form-2fa').classList.add('hidden');
  $('auth-err').classList.add('hidden');
  tfaSession = null;
  /* 切到哪个表单，就准备好哪个表单的人机验证（两个表单各自的验证码互不串台） */
  loadCaptcha(tab === 'reg' ? 'reg' : 'login');
}

function showAuthErr(msg) {
  const el = $('auth-err');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// 登录方式：'pass' 密码 | 'code' 验证码
let loginMethod = 'pass';
function switchLoginMethod(m) {
  loginMethod = m;
  $('lm-pass').classList.toggle('active', m === 'pass');
  $('lm-code').classList.toggle('active', m === 'code');
  $('login-by-pass').classList.toggle('hidden', m !== 'pass');
  $('login-by-code').classList.toggle('hidden', m !== 'code');
  $('auth-err').classList.add('hidden');
}

// 发送邮箱验证码。scene: 'register' | 'login'
async function sendCode(scene) {
  state.server = DEFAULT_SERVER;
  const email = scene === 'register' ? $('r-email').value.trim() : $('l-user').value.trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return showAuthErr(scene === 'register' ? '请填写正确的邮箱' : '验证码登录请在上方填写邮箱');
  }
  const btn = scene === 'register' ? $('r-send-code') : $('l-send-code');
  const slot = scene === 'register' ? 'reg' : 'login';
  /* 发信也要过人机验证（防邮件轰炸）。服务端这一步只校验不消费挑战，
     所以用户解一次图形码就能接着完成注册/登录。 */
  if (!ensureCaptcha(slot)) return;
  try {
    btn.disabled = true;
    const purpose = scene === 'register' ? 'register' : 'login';
    await api('/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ email, purpose, ...captchaFields(slot) }),
    });
    toast('验证码已发送，请查收邮箱', 'success');
    // 60秒倒计时
    let sec = 60;
    const timer = setInterval(() => {
      btn.textContent = sec + 's';
      if (--sec < 0) { clearInterval(timer); btn.disabled = false; btn.textContent = '获取验证码'; }
    }, 1000);
  } catch (e) {
    btn.disabled = false;
    handleCaptchaError(slot, e);
    showAuthErr(e.message);
  }
}

let tfaSession = null;

async function doLogin() {
  state.server = DEFAULT_SERVER;
  const username = $('l-user').value.trim();
  if (!username) return showAuthErr('请输入用户名或邮箱');

  let body;
  if (loginMethod === 'code') {
    const code = $('l-code').value.trim();
    if (!code) return showAuthErr('请输入邮箱验证码');
    body = { email: username, code };
  } else {
    const password = $('l-pass').value;
    if (!password) return showAuthErr('请输入密码');
    body = { username, password };
  }
  /* 人机验证由服务端校验；这里先本地拦一次，省掉一次必定失败的请求 */
  if (!ensureCaptcha('login')) return;

  try {
    setLoginLoading(true, '登录中…');
    const data = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ ...body, ...captchaFields('login') }),
    });

    if (data.tfa_required) {
      tfaSession = { tfaToken: data.tfa_token, methods: data.tfa_methods || {} };
      $('form-login').classList.add('hidden');
      $('form-reg').classList.add('hidden');
      $('form-2fa').classList.remove('hidden');
      $('tfa-btn-email').classList.toggle('hidden', !tfaSession.methods.email);
      $('tfa-btn-qq').classList.toggle('hidden', !tfaSession.methods.qq);
      setLoginLoading(false);
      return;
    }

    state.token = data.token;
    state.user = data.user;
    state.server = DEFAULT_SERVER;
    localStorage.setItem('mclink_token', data.token);
    localStorage.removeItem('mclink_server');
    enterApp();
  } catch (e) {
    /* 服务端在**校验账号密码之前**就先消耗掉了人机验证
       （routes/auth.js 里 requireCaptcha 排在密码校验前面），
       所以任何一次登录失败都会让这次的 challenge 作废 ——
       不只是"验证码错误"那一种。
       必须重新签发并重新渲染，否则用户下次提交必然被判定验证码无效，
       而且（以前）连验证码本身都看不到。 */
    if (!handleCaptchaError('login', e)) resetCaptcha('login');
    showAuthErr(e.message);
  } finally {
    setLoginLoading(false);
  }
}

async function requestTfaCode(method) {
  if (!tfaSession) return;
  try {
    const emailEl = $('l-user');
    await api('/auth/tfa/send', { method: 'POST', body: JSON.stringify({ tfa_token: tfaSession.tfaToken, method }) });
    $('tfa-method').value = method;
    toast('验证码已发送，请查收邮箱', 'success');
  } catch (e) { showAuthErr(e.message); }
}

function showTfaQqTip() {
  $('tfa-method').value = 'qq';
  toast('请在QQ机器人发送 /verify [验证码]，再将验证码填入下方输入框', 'info');
}

async function submitTfa() {
  if (!tfaSession) return;
  const code = $('tfa-code').value.trim();
  const method = $('tfa-method').value;
  if (!code) return showAuthErr('请输入验证码');
  try {
    setLoginLoading(true, '验证中…');
    const data = await api('/auth/tfa/verify', { method: 'POST', body: JSON.stringify({ tfa_token: tfaSession.tfaToken, code, method }) });
    tfaSession = null;
    state.token = data.token;
    state.user = data.user;
    state.server = DEFAULT_SERVER;
    localStorage.setItem('mclink_token', data.token);
    localStorage.removeItem('mclink_server');
    cancelTfa(true);
    enterApp();
  } catch (e) {
    showAuthErr(e.message);
  } finally {
    setLoginLoading(false);
  }
}

function cancelTfa(silent) {
  tfaSession = null;
  $('form-2fa').classList.add('hidden');
  $('tfa-code').value = '';
  if (!silent) showAuthTab('login');
}

async function doRegister() {
  state.server = DEFAULT_SERVER;
  const username = $('r-user').value.trim();
  const email = $('r-email').value.trim();
  const code = $('r-code').value.trim();
  const password = $('r-pass').value;
  if (!username || !password) return showAuthErr('请输入用户名和密码');
  if (!email) return showAuthErr('请填写邮箱');
  if (!code) return showAuthErr('请填写邮箱验证码');
  /* 人机验证由服务端校验；这里先本地拦一次，省掉一次必定失败的请求 */
  if (!ensureCaptcha('reg')) return;

  try {
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, code, password, ...captchaFields('reg') }),
    });
    toast('注册成功，请登录', 'success');
    resetCaptcha('reg');
    showAuthTab('login');
    $('l-user').value = username;
  } catch (e) {
    /* 验证码错误时服务端会作废该挑战，必须换一张再试 */
    /* 同登录：注册路由也是先 requireCaptcha 再校验用户名/邮箱是否存在，
       所以"用户名已存在"这类失败同样会让 challenge 作废，必须换一张。 */
    if (!handleCaptchaError('reg', e)) resetCaptcha('reg');
    showAuthErr(e.message);
  }
}

function doLogout() {
  // 二次确认弹窗
  showConfirm('确认退出登录？', '退出后需重新登录才能使用联机功能。', () => {
    /* 顺序很重要：先把"退出登录"这件事同步做完（清会话 + 回登录页），再去收尾。
       原实现是 await 收尾步骤（关房间 / 停 EasyTier / 停 frpc 都是 IPC 或网络调用），
       只要其中任意一个不返回（IPC 卡住、网络无响应），后面的清 token、切页面
       就永远执行不到 —— 表现就是"确认按钮点了有反应，但退不回登录页"。 */
    const oldToken = state.token;
    const oldRole = state.role;
    const oldRoomCode = state.roomCode;
    if (state.presenceTimer) clearInterval(state.presenceTimer);
    state.presenceTimer = null;
    state.token = null;
    state.user = null;
    state.signingKey = null;
    state.signingKeyToken = null;
    // 房间状态也要清，否则重新登录后 createRoom 会以为「已在房间中」
    state.role = null;
    state.roomCode = null;
    state.members = [];
    localStorage.removeItem('mclink_token');
    $('main-app').classList.add('hidden');
    $('auth-page').classList.remove('hidden');
    /* 顺手收起可能还开着的弹窗，避免退出后界面残留 */
    ['log-viewer-modal', 'diag-modal', 'room-detail-modal', 'announcement-modal', 'update-modal'].forEach((id) => closeModal(id));
    /* 关键：彻底重置验证码（含已通过的 validate），
       否则再登录会显示"验证通过"直接放行，验证码形同虚设。 */
    if (typeof resetCaptchaState === 'function') { resetCaptchaState('login'); resetCaptchaState('reg'); }
    /* resetCaptchaState 会把验证码框清空，这里立刻补回来 ——
       否则退出登录后回到登录页是"没有人机验证"的空白，得先点一次登录才出现。 */
    if (typeof refreshCaptchaBox === 'function') { refreshCaptchaBox('login'); refreshCaptchaBox('reg'); }
    toast('已退出登录', 'success');

    /* ---- 以下都是"尽力而为"的收尾：每步独立超时，失败只记日志 ---- */
    const stepTimeout = 5000;
    const withTimeout = (fn, ms) => Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => setTimeout(() => reject(new Error('超时 ' + ms + 'ms')), ms)),
    ]);
    /* 收尾步骤仍需要旧会话（关房间要 role/roomCode，上报离线要 token），
       临时挂回去，用完恢复成当前值（用户可能已经重新登录了） */
    const withOldSession = async (fn) => {
      const prev = { token: state.token, role: state.role, roomCode: state.roomCode };
      state.token = oldToken;
      state.role = oldRole;
      state.roomCode = oldRoomCode;
      try { return await fn(); } finally {
        state.token = prev.token;
        state.role = prev.role;
        state.roomCode = prev.roomCode;
      }
    };
    (async () => {
      const failed = [];
      const step = async (name, fn) => {
        try { await withTimeout(fn, stepTimeout); } catch (e) {
          failed.push(name);
          logLine('退出登录时「' + name + '」失败: ' + ((e && e.message) || e));
        }
      };
      if (oldRole === 'guest') await step('退出房间', () => withOldSession(() => leaveRoom()));
      else if (oldRole === 'host') await step('关闭房间', () => withOldSession(() => closeRoom()));
      await step('停止 EasyTier', () => stopEasyTier());
      await step('停止 frpc', () => window.mclink.frpcStop());
      await step('同步离线状态', () => withOldSession(() => syncPresence(false)));
      if (failed.length) toast('已退出登录（' + failed.join('、') + ' 未正常结束）', 'warn');
    })();
  });
}

// 通用二次确认弹窗
/* 取弹窗里的两个按钮，**永远不假设它们存在**。
   这里曾经是"退出登录点确认没反应"的元凶：取消按钮漏写了 id="confirm-cancel"，
   而 confirmOk() 里 `$('confirm-cancel').__handler = null` 会往 null 上写属性、
   直接抛 TypeError —— 抛在 closeModal() 和 handler() 之前，
   于是弹窗不关、回调也不执行，表现就是"按钮点了没反应"。 */
function confirmEls() {
  return { ok: $('confirm-ok'), cancel: $('confirm-cancel') };
}
function setConfirmHandlers(okFn, cancelFn) {
  const { ok, cancel } = confirmEls();
  if (ok) ok.__handler = okFn || null;
  if (cancel) cancel.__handler = cancelFn || null;
  if (!ok || !cancel) {
    logLine('确认弹窗缺少按钮：' + (!ok ? '#confirm-ok ' : '') + (!cancel ? '#confirm-cancel' : ''));
  }
}
function takeConfirmHandlers() {
  const { ok, cancel } = confirmEls();
  const h = { ok: ok ? ok.__handler : null, cancel: cancel ? cancel.__handler : null };
  if (ok) ok.__handler = null;
  if (cancel) cancel.__handler = null;
  return h;
}
function showConfirm(title, msg, onConfirm) {
  const t = $('confirm-title');
  const m = $('confirm-msg');
  if (t) t.textContent = title;
  if (m) m.textContent = msg;
  /* 必须走 openModal/closeModal：直接切 hidden 会绕过退场动画，弹窗会"瞬间消失" */
  openModal('confirm-modal');
  setConfirmHandlers(onConfirm, null);
}
function confirmOk() {
  const h = takeConfirmHandlers();
  /* 顺序很重要：先关弹窗再跑回调。
     回调里万一抛错，至少不会把弹窗永远晾在界面上（原来的顺序是反的，
     而且中间那句会抛错，导致两者都执行不到）。 */
  closeModal('confirm-modal');
  if (!h.ok) return;
  try {
    h.ok();
  } catch (e) {
    logLine('确认操作执行失败: ' + ((e && e.message) || e));
    toast('操作失败：' + ((e && e.message) || '未知错误'), 'error');
  }
}
function confirmCancel() {
  const h = takeConfirmHandlers();
  closeModal('confirm-modal');
  if (!h.cancel) return;
  try {
    h.cancel();
  } catch (e) {
    logLine('取消操作处理失败: ' + ((e && e.message) || e));
  }
}

function syncPresence(online = true) {
  return api('/auth/presence', { method: 'POST', body: JSON.stringify({ online }) });
}

function safeUserTheme(theme) {
  return ['light', 'dark', 'gold', 'violet', 'ice', 'emerald', 'blue', 'green', 'role'].includes(theme) ? theme : null;
}

function resolveUserThemeClass(theme, role) {
  const t = safeUserTheme(theme) || (role === 'admin' ? 'gold' : role === 'sponsor' ? 'blue' : 'dark');
  if (t === 'role') return `theme-role role-${role || 'user'}`;
  const map = { violet: 'violet', emerald: 'emerald' };
  return `theme-${map[t] || t}`;
}

function applyUserAppearance(user) {
  const title = user.title || ({ admin: '管理员', dev: '开发者', sponsor: '赞助用户', user: '普通用户' }[user.role] || '普通用户');
  const cls = resolveUserThemeClass(user.theme, user.role);
  $('s-role').textContent = title;
  $('s-role').className = `user-role ${cls}`.trim();
  $('s-role').dataset.userTheme = safeUserTheme(user.theme) || 'role';
}

function enterApp() {
  setTimeout(applyPrivilegeUI, 100);
  $('auth-page').classList.add('hidden');
  $('main-app').classList.remove('hidden');
  $('s-username').textContent = state.user.username;
  // Also update sidebar user area
  if ($('s-username')) $('s-username').textContent = state.user.username;
  if ($('s-avatar-initials')) $('s-avatar-initials').textContent = state.user.username.charAt(0).toUpperCase();
  applyUserAppearance(state.user);
  fillUserPanel();
  const welcome = state.user.role === 'sponsor' ? `感谢赞助，${state.user.username}！欢迎回到 BLFP。` : `欢迎回来，${state.user.username}。`;
  if ($('us-logged-in-as')) $('us-logged-in-as').textContent = '登录为: ' + state.user.username;
  logLine(welcome);
  const home = $('page-home');
  home.classList.add('enter-from-right');
  setTimeout(() => home.classList.remove('enter-from-right'), 230);
  loadFrpNodes();
  loadEtNodes();
  loadPublicRooms(true);
  loadFriends(true);
  loadAnnouncements();
  if (state.user.role === 'sponsor' && !sessionStorage.getItem('blfp_sponsor_welcome')) { sessionStorage.setItem('blfp_sponsor_welcome', '1'); toast(`感谢赞助，${state.user.username}，欢迎回来！`, 'success'); }
  syncPresence(true).catch((e) => logLine('在线状态同步失败: ' + e.message));
  if (state.presenceTimer) clearInterval(state.presenceTimer);
  state.presenceTimer = setInterval(() => syncPresence(true).catch((e) => debugLog('在线状态同步失败: ' + e.message)), 60000);
  loadAnnouncement();
}

/* ============ 主页的"当前状态" ============
   打开软件时用户第一眼要回答的只有一个问题：我现在能不能玩、房间号是多少。
   以前主页只有一句欢迎语和两个按钮，这三个问题一个都答不上来。
   这里只读 state，不自己存一份状态 —— 免得两处漂移。 */
function renderHomeStatus() {
  const box = $('home-status');
  if (!box) return;

  const inRoom = Boolean(state.role && state.roomCode);
  if (!inRoom) {
    const name = state.user?.username || '';
    box.innerHTML = `
      <div class="hs-idle">
        <div class="hs-idle-title">${escapeHtml(greetingText() + (name ? '，' + name : ''))}</div>
        <div class="hs-idle-sub">现在没有联机 · 建个房间，把房间号发给朋友就能一起玩</div>
        <div class="hs-actions">
          <button class="btn btn-primary" onclick="openStartHostDialog()">开始联机</button>
          <button class="btn btn-outline" onclick="navTo('rooms')">看看别人的房间</button>
        </div>
      </div>`;
    return;
  }

  const isHost = state.role === 'host';
  const total = Array.isArray(state.members) && state.members.length ? state.members.length : 1;
  const max = Number(state.maxMembers) || 8;
  const modeText = state.mode === 'frp' ? 'frp 中转' : 'EasyTier 组网';

  box.innerHTML = `
    <div class="hs-live">
      <div class="hs-live-head">
        <span class="hs-dot"></span>
        <span class="hs-live-title">${isHost ? '房间已开' : '已连上房间'}</span>
        <span class="hs-mode">${escapeHtml(modeText)}</span>
      </div>
      <div class="hs-code" onclick="copyRoomCode()" title="点一下复制房间号">${escapeHtml(String(state.roomCode))}</div>
      <div class="hs-meta">
        <span>${total}/${max} 人在线</span>
        <span>游戏端口 ${Number(state.mcPort) || 25565}</span>
      </div>
      <div class="hs-actions">
        <button class="btn btn-primary" onclick="copyRoomCode()">复制房间号</button>
        <button class="btn btn-outline" onclick="navTo('${isHost ? 'host' : 'rooms'}')">${isHost ? '房间控制' : '连接信息'}</button>
        <button class="btn btn-outline" onclick="leaveRoom()">退出</button>
      </div>
    </div>`;
}

/* ============ 导航 ============ */
const NAV_ORDER = ['home', 'host', 'rooms', 'friends', 'chat'];
let currentPage = 'home';
let navTimer = null;
let navLock = false;
function navTo(page, btn) {
  /* 进主页前刷新一次状态面板：房间状态可能在别的页面被改过 */
  if (page === 'home') renderHomeStatus();
  if (page === 'user-settings') { setTimeout(applyPrivilegeUI, 50); setTimeout(fillUserPanel, 30); }
  // When navigating to any page other than settings, remove .active from gear-btn
  if (page !== 'settings' && page !== 'user-settings') {
    const gearBtn = $('sidebar-gear-btn');
    if (gearBtn) gearBtn.classList.remove('active');
  }
  if (page === currentPage) {
    // 重复点当前选项卡 → 回主页（设置/用户页除外）
    if (page !== 'home' && page !== 'settings' && page !== 'user-settings') {
      navTo('home');
      return;
    }
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n === (btn || document.querySelector(`.nav-item[data-page="${page}"]`))));
    return;
  }
  if (navLock) return;
  const oldPage = $('page-' + currentPage);
  const nextPage = $('page-' + page);
  if (!oldPage || !nextPage) return;
  // 'log' is no longer a page, but keep the perf check for compatibility
  const noAnimation = page === 'log' || currentPage === 'log' || document.body.classList.contains('perf-off');
  clearTimeout(navTimer);
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('page-entering', 'page-leaving', 'enter-from-left', 'enter-from-right', 'leave-to-left', 'leave-to-right'));
  document.querySelector('.content').scrollTop = 0;
  if (noAnimation) {
    oldPage.classList.remove('active');
    nextPage.classList.add('active');
    currentPage = page;
  } else {
    navLock = true;
    // Handle pages not in NAV_ORDER for animation direction
    const idx = NAV_ORDER.indexOf(page);
    const currentIdx = NAV_ORDER.indexOf(currentPage);
    const forward = (idx !== -1 && currentIdx !== -1) ? idx > currentIdx : true;
    oldPage.classList.add('page-leaving', forward ? 'leave-to-left' : 'leave-to-right');
    nextPage.classList.add('active', 'page-entering', forward ? 'enter-from-right' : 'enter-from-left');
    currentPage = page;
    navTimer = setTimeout(() => {
      oldPage.classList.remove('active', 'page-leaving', 'leave-to-left', 'leave-to-right');
      nextPage.classList.remove('page-entering', 'enter-from-left', 'enter-from-right');
      navLock = false;
    }, 225);
  }
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  (btn || document.querySelector(`.nav-item[data-page="${page}"]`))?.classList.add('active');
  if (page === 'host' && state.token) loadFrpNodes({ silent: true, preserveSelection: true });
  if (page === 'rooms' && state.token) loadPublicRooms(true);
  if (page === 'friends' && state.token) loadFriends(true);
  if (page === 'chat') { initChat(); ensureChatConnection(); }
}

/* ============ 设置齿轮动画 ============ */
function toggleSettingsGear() {
  const gearBtn = $('sidebar-gear-btn');
  if (!gearBtn) return;
  if (currentPage === 'settings') {
    // 已在设置页 → 回主页
    gearBtn.classList.remove('active');
    navTo('home');
  } else {
    // 其他任何页面（含用户面板）→ 进设置
    navTo('settings');
    gearBtn.classList.add('active');
  }
}

/* ============ 模式选择 ============ */
function selectMode(mode) {
  state.mode = mode;
  $('mode-easytier').classList.toggle('active', mode === 'easytier');
  $('mode-frp').classList.toggle('active', mode === 'frp');
  // 伸长动画展开/收起节点选择
  const sec = $('frp-node-section');
  if (sec) {
    if (mode === 'frp') {
      sec.classList.remove('collapsed');
      loadFrpNodes({ force: false }).catch(() => {});
    } else {
      sec.classList.add('collapsed');
    }
  }
}

let frpLoadPromise = null;
let frpPingSequence = 0;
async function loadFrpNodes(options = {}) {
  if (frpLoadPromise && !options.force) return frpLoadPromise;
  const selects = [$('frp-node-select'), $('quick-frp-node-select')].filter(Boolean);
  const previousId = options.preserveSelection ? state.frpNodeId : null;
  selects.forEach((sel) => { sel.disabled = true; sel.innerHTML = '<option value="">正在获取节点...</option>'; });
  frpLoadPromise = (async () => {
    try {
      const result = await api('/nodes');
      const nodes = Array.isArray(result) ? result : [];
      state.frpNodes = nodes;
      if (!nodes.length) {
        state.frpNodeId = null;
        selects.forEach((sel) => { sel.innerHTML = '<option value="">暂无可用节点</option>'; });
        return [];
      }
      const optionsHtml = nodes.map((n) =>
        `<option value="${n.id}">${escapeHtml(n.name)} (${escapeHtml(n.region || '未知')} · ${escapeHtml(n.bandwidth || '未知')})</option>`
      ).join('');
      selects.forEach((sel) => { sel.innerHTML = optionsHtml; sel.disabled = false; });
      const selected = nodes.find((n) => n.id === previousId) || nodes[0];
      state.frpNodeId = selected.id;
      selects.forEach((sel) => { sel.value = String(selected.id); });
      await pingSelectedNode(selected);
      debugLog(`已刷新 ${nodes.length} 个 frp 节点`);
      return nodes;
    } catch (e) {
      state.frpNodes = [];
      state.frpNodeId = null;
      selects.forEach((sel) => { sel.innerHTML = '<option value="">节点获取失败，请重试</option>'; sel.disabled = false; });
      logLine('加载 frp 节点失败: ' + e.message);
      if (!options.silent) toast('frp 节点获取失败：' + e.message, 'error');
      return [];
    } finally {
      frpLoadPromise = null;
    }
  })();
  return frpLoadPromise;
}

function refreshFrpNodes() {
  return loadFrpNodes({ force: true, preserveSelection: true });
}

/* ============ EasyTier 节点选择 ============ */
let etLoadPromise = null;

/* 解析 EasyTier peer 地址。
   必须容忍"没有协议头"的写法（例如后台手工写库成 host:port），
   否则 new URL() 直接抛错，节点会被整体判成不可用。
   返回 { host, port, protocol }，protocol 用于决定探测方式：
     tcp/ws/wss → TCP 连接探测；udp → 只能做主机级探测（TCP 探测对 UDP 中继无意义） */
const ET_DEFAULT_PORT = 11010;
function parsePeerTarget(peer) {
  const raw = String(peer == null ? '' : peer).trim();
  if (!raw || raw.length > 512) return null;
  let protocol = '';
  let rest = raw;
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    protocol = scheme[1].toLowerCase();
    rest = raw.slice(scheme[0].length);
    if (!['tcp', 'udp', 'ws', 'wss', 'http', 'https'].includes(protocol)) return null;
  }
  rest = rest.split('/')[0].split('?')[0]; /* 去掉路径与查询串 */
  if (!rest || rest.includes('@')) return null; /* 不处理带认证信息的地址 */
  let host;
  let port;
  const v6 = rest.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) {
    host = v6[1];
    port = v6[2] ? Number(v6[2]) : null;
  } else {
    const idx = rest.lastIndexOf(':');
    if (idx === -1) {
      host = rest;
      port = null;
    } else {
      host = rest.slice(0, idx);
      const tail = rest.slice(idx + 1);
      if (!/^\d+$/.test(tail)) return null;
      port = Number(tail);
    }
  }
  if (!host || /\s/.test(host)) return null;
  if (port === null) port = protocol === 'wss' || protocol === 'https' ? 443 : ET_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, protocol: protocol || 'tcp' };
}

/* 规范化 peer，用于"用户选的节点"与"房间下发的 peers"做比较。
   服务端下发的字符串与节点列表同源，但大小写/协议默认值/有无协议头都可能不一致，
   直接字符串相等会误判成"当前不可用"而偷偷回退到自动选择。 */
function canonicalPeer(peer) {
  const t = parsePeerTarget(peer);
  if (!t) return String(peer == null ? '' : peer).trim().toLowerCase();
  return `${t.protocol}://${t.host.toLowerCase()}:${t.port}`;
}

/* 探测单个节点。返回 { state, ms, error }：
     ok          探测成功，ms 为延迟
     unreachable 明确不可达（TCP 拒绝/超时，或主机探测失败）
     unknown     无法判定（UDP 中继且主机探测被墙等）——不能当成不可达
   error 只属于本次探测，不再用全局变量，避免把 A 节点的错误显示到 B 节点上。 */
async function probeNode(peer) {
  const target = parsePeerTarget(peer);
  if (!target) {
    return { state: 'unreachable', ms: null, error: '节点地址无法解析：' + String(peer == null ? '' : peer) };
  }
  if (!window.mclink || typeof window.mclink.pingNode !== 'function') {
    return { state: 'unknown', ms: null, error: '客户端接口不可用，请重启客户端' };
  }
  try {
    /* udp 中继没法用 TCP 连接判断可用性，交给主进程做主机级探测 */
    const res = await window.mclink.pingNode({ host: target.host, port: target.port, protocol: target.protocol });
    if (res && res.ok) return { state: 'ok', ms: Number(res.latency), error: '' };
    if (res && res.unknown) {
      return { state: 'unknown', ms: null, error: (res && res.error) || '无法判定：UDP 中继不支持 TCP 探测' };
    }
    return { state: 'unreachable', ms: null, error: (res && res.error) || '未知错误' };
  } catch (e) {
    return { state: 'unknown', ms: null, error: (e && e.message) || '调用失败' };
  }
}

/* 兼容旧签名：只关心延迟的调用点用它 */
async function pingPeerUrl(peer) {
  const r = await probeNode(peer);
  if (r.state === 'ok') return r.ms;
  logLine('测速 ' + String(peer) + ' → ' + r.state + ' ' + (r.error || ''));
  return null;
}

async function loadEtNodes(options = {}) {
  if (etLoadPromise && !options.force) return etLoadPromise;
  const sel = $('s-et-node');
  etLoadPromise = (async () => {
    try {
      const nodes = await api('/easytier-nodes/client');
      state.etNodes = Array.isArray(nodes) ? nodes : [];
      if (sel) {
        const opts = ['<option value="auto">自动选择延迟最低的节点</option>'];
        state.etNodes.forEach((n) => {
          const kind = n.kind === 'signaling' ? '信令' : '中继';
          opts.push(`<option value="${n.id}">${escapeHtml(n.name)}（${kind}）</option>`);
        });
        sel.innerHTML = opts.join('');
        const saved = String(state.etNodeMode || 'auto');
        sel.value = saved !== 'auto' && state.etNodes.some((n) => String(n.id) === saved) ? saved : 'auto';
      }
      return state.etNodes;
    } catch (e) {
      debugLog('加载 EasyTier 节点失败: ' + e.message);
      return [];
    } finally {
      etLoadPromise = null;
    }
  })();
  return etLoadPromise;
}

async function testEtNodes() {
  const results = $('s-et-results');
  const badge = $('s-et-latency');
  let nodes = state.etNodes;
  if (!nodes.length) nodes = await loadEtNodes({ force: true });
  if (!nodes.length) return toast('没有可用的 EasyTier 节点', 'warn');
  if (results) { results.classList.remove('hidden'); results.textContent = '正在测速…'; }
  if (badge) { badge.classList.remove('hidden'); badge.textContent = '测速中...'; }
  const rows = await Promise.all(nodes.map(async (n) => ({ node: n, probe: await probeNode(n.peer) })));
  const rank = { ok: 0, unknown: 1, unreachable: 2 };
  rows.sort((a, b) => (rank[a.probe.state] - rank[b.probe.state]) || ((a.probe.ms ?? Infinity) - (b.probe.ms ?? Infinity)));
  if (results) {
    results.innerHTML = rows.map((r) => {
      const p = r.probe;
      const text = p.state === 'ok' ? (p.ms + ' ms')
        : p.state === 'unknown' ? ('未测出：' + (p.error || '无法判定'))
          : ('不可达 ' + (p.error || ''));
      const cls = p.state === 'ok' ? 'et-node-good' : (p.state === 'unknown' ? 'et-node-unknown' : 'et-node-bad');
      /* 把 peer 原文一并列出来：节点地址写错、协议写错时一眼可见 */
      return `<div class="et-result-row"><span>${escapeHtml(r.node.name)}<em class="et-peer">${escapeHtml(String(r.node.peer || ''))}</em></span><span class="${cls}">${escapeHtml(text)}</span></div>`;
    }).join('');
  }
  const best = rows.find((r) => r.probe.state === 'ok');
  if (badge) {
    /* 测速探不出 ≠ 节点不能用：UDP 中继无法用 TCP 探测，不能因此显示成"无可用节点"误导用户 */
    badge.textContent = best
      ? `最低延迟：${best.node.name} ${best.probe.ms} ms`
      : '未测出延迟，节点仍可用于连接';
  }
  if (best) logLine(`EasyTier 测速完成，最低延迟节点 ${best.node.name}，${best.probe.ms} ms`);
  else logLine('EasyTier 测速：均未测出延迟，将按原顺序尝试连接。测速失败不代表节点不可用');
}

async function pickBestEtPeer(peers) {
  if (!Array.isArray(peers) || peers.length <= 1) return peers;
  const results = await Promise.all(peers.map(async (peer) => ({ peer, probe: await probeNode(peer) })));
  /* 只排序、不淘汰：测速仅是延迟估算，探不到的节点（尤其 UDP 中继）必须继续作为候选，
     否则会把一个本来能连的中继从连接列表里删掉。 */
  const rank = { ok: 0, unknown: 1, unreachable: 2 };
  results.sort((a, b) => (rank[a.probe.state] - rank[b.probe.state]) || ((a.probe.ms ?? Infinity) - (b.probe.ms ?? Infinity)));
  const ordered = results.map((r) => r.peer);
  if (results[0].probe.state === 'ok') {
    logLine(`EasyTier 首选节点 ${ordered[0]}，${results[0].probe.ms} ms，其余 ${ordered.length - 1} 个作为备用`);
  } else {
    logLine('EasyTier 未测出可用延迟，按原顺序尝试全部节点');
  }
  return ordered;
}

async function resolveEtPeers(peers) {
  if (!Array.isArray(peers) || !peers.length) return peers;
  const mode = state.etNodeMode;
  if (mode && String(mode) !== 'auto') {
    const node = state.etNodes.find((n) => String(n.id) === String(mode));
    if (node) {
      /* 用规范化后的地址比较：协议头有无、大小写、端口缺省都不该导致匹配失败 */
      const wanted = canonicalPeer(node.peer);
      const matched = peers.find((p) => canonicalPeer(p) === wanted);
      if (matched) {
        /* 指定节点排在第一位，其余保留为备用：万一指定中继临时不通，仍能连上房间 */
        const rest = peers.filter((p) => p !== matched);
        logLine(`使用指定 EasyTier 节点 ${node.name}，地址 ${node.peer}` + (rest.length ? `，另有 ${rest.length} 个备用节点` : ''));
        return [matched, ...rest];
      }
      logLine(`指定 EasyTier 节点 ${node.name} 不在本次房间的节点列表中，改为自动选择`);
    }
  }
  return pickBestEtPeer(peers);
}

function selectFrpNode(value) {
  state.frpNodeId = parseInt(value, 10) || null;
  [$('frp-node-select'), $('quick-frp-node-select')].filter(Boolean).forEach((sel) => { sel.value = value; });
  const node = state.frpNodes.find((n) => n.id === state.frpNodeId);
  if (node) pingSelectedNode(node);
}

async function pingSelectedNode(node) {
  const sequence = ++frpPingSequence;
  const badges = [$('frp-node-latency'), $('quick-frp-latency')].filter(Boolean);
  badges.forEach((badge) => { badge.textContent = '测速中...'; badge.className = 'latency-badge'; });
  try {
    const res = await window.mclink.pingNode({ host: node.host, port: node.port || 7000 });
    if (sequence !== frpPingSequence || node.id !== state.frpNodeId) return;
    if (res.ok) {
      const ms = res.latency;
      badges.forEach((badge) => { badge.textContent = ms + ' ms'; badge.className = 'latency-badge ' + (ms < 80 ? 'good' : ms < 180 ? 'ok' : 'bad'); });
    } else {
      badges.forEach((badge) => { badge.textContent = '超时'; badge.className = 'latency-badge bad'; });
    }
  } catch (e) {
    if (sequence !== frpPingSequence) return;
    badges.forEach((badge) => { badge.textContent = '失败'; badge.className = 'latency-badge bad'; });
    debugLog('节点测速失败: ' + e.message);
  }
}

/* ============ 端口检测 ============ */
let portTargetId = 'mc-port';
async function detectPort(targetInputId = 'mc-port') {
  portTargetId = targetInputId;
  logLine('正在检测端口占用...');
  // 先检测 25565 是否被占用
  const occupied = await window.mclink.checkPort(25565);
  const javaPorts = await window.mclink.scanPorts();

  if (occupied && javaPorts.some((p) => p.port === 25565)) {
    $(portTargetId).value = 25565;
    toast('检测到 Minecraft 运行在默认端口 25565', 'success');
    logLine('默认端口 25565 已被 Java 进程占用，直接使用');
    return;
  }

  if (javaPorts.length === 0) {
    toast('未检测到运行中的 Java/Minecraft 进程', 'warn');
    logLine('未扫描到 Java 进程监听端口，请确保已开启局域网游戏');
    return;
  }

  if (javaPorts.length === 1) {
    $(portTargetId).value = javaPorts[0].port;
    toast('已选择端口 ' + javaPorts[0].port, 'success');
    logLine('检测到单个 Java 端口: ' + javaPorts[0].port);
    return;
  }

  // 多个端口，弹窗让用户选择
  showPortModal(javaPorts);
}

function showPortModal(ports) {
  const list = $('port-modal-list');
  list.innerHTML = ports.map((p) =>
    `<div class="port-option" onclick="pickPort(${p.port})">
      <span class="po-port">${p.port}</span>
      <span class="po-info">PID ${p.pid} · ${p.process}${p.port === 25565 ? ' · 默认端口' : ''}</span>
    </div>`
  ).join('');
  openModal('port-modal');
}

function pickPort(port) {
  $(portTargetId).value = port;
  closeModal('port-modal');
  toast('已选择端口 ' + port, 'success');
  logLine('用户选择映射端口: ' + port);
}

let _modalCloseSeq = 0;
function openModal(id) {
  const el = $(id);
  if (!el) return;
  /* 取消任何挂起的关闭 */
  el._ltClosing = 0;
  el.classList.remove('modal-leaving');
  void el.offsetWidth; /* 强制 reflow，保证进场动画重播 */
  el.classList.remove('hidden');
}
/* 退场动画的真实时长（毫秒）；动画没在跑时返回 0。
   用 Web Animations API 判断动画是否真的在跑，比解析 CSS 可靠：
   性能模式关闭、系统"减弱动态效果"、规则被更高优先级覆盖等情况下都不会误等。 */
function modalLeaveMs(el) {
  try {
    if (typeof el.getAnimations === 'function') {
      const a = el.getAnimations().find((x) => x.animationName === 'backdropOut');
      if (!a) return 0;
      const timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
      const ms = timing && typeof timing.duration === 'number' ? timing.duration : 0;
      return ms > 0 ? ms : 0;
    }
  } catch (e) { /* 落到 CSS 兜底 */ }
  try {
    const cs = getComputedStyle(el);
    if (!cs.animationName || cs.animationName === 'none') return 0;
    if (cs.animationName.split(',').map((s) => s.trim()).indexOf('backdropOut') === -1) return 0;
    const raw = (cs.animationDuration || '0s').split(',')[0].trim();
    const ms = raw.endsWith('ms') ? parseFloat(raw) : parseFloat(raw) * 1000;
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  } catch (e) {
    return 0;
  }
}

function closeModal(id) {
  const el = $(id);
  if (!el || el.classList.contains('hidden') || el._ltClosing) return;
  const seq = ++_modalCloseSeq;
  el._ltClosing = seq;
  const finish = () => {
    if (el._ltClosing !== seq) return;
    el.classList.remove('modal-leaving');
    el.classList.add('hidden');
    el._ltClosing = 0;
  };
  /* 先播退场动画，动画结束（或按真实时长兜底）后再真正隐藏 */
  el.classList.add('modal-leaving');
  const ms = modalLeaveMs(el);
  if (!ms) {
    /* 动画没在跑（性能模式关/系统减弱动态效果）：立即隐藏，不能白等 */
    finish();
    return;
  }
  el.addEventListener('animationend', function ltEnd(e) {
    if (e.animationName === 'backdropOut') { el.removeEventListener('animationend', ltEnd); finish(); }
  });
  /* 兜底时长与真实动画一致（+60ms 余量），不再固定 320ms */
  setTimeout(finish, Math.round(ms) + 60);
}

// 通用弹窗打开：把内容写进 .modal 容器再显示遮罩。
// 此前 showModal 被调用三处却从未定义，导致「收集诊断信息失败: showModal is not defined」
function showModal(id, html) {
  const el = $(id);
  if (!el) return;
  const box = el.querySelector('.modal') || el;
  if (html != null) box.innerHTML = html;
  openModal(id);
}

/* ============ 信令 WebSocket ============ */
function connectSignaling() {
  return new Promise((resolve, reject) => {
    /* 已有连接先关闭，避免残留 socket 干扰加入流程 */
    try {
      if (state.ws && state.ws.readyState !== WebSocket.CLOSED) {
        state.closingSignaling = true;
        state.ws.onclose = null;
        state.ws.close();
      }
    } catch (e) {}
    state.ws = null;
    const serverUrl = assertSecureServer(state.server);
    const wsProtocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${serverUrl.host}/ws?token=${encodeURIComponent(state.token)}`;
    state.closingSignaling = false;
    state.ws = new WebSocket(wsUrl);
    state.ws.onopen = () => { logLine('信令服务器已连接'); resolve(); };
    state.ws.onerror = () => reject(new Error('无法连接信令服务器'));
    state.ws.onclose = async () => {
      state.ws = null;
      logLine('信令连接已关闭');
      if (state.closingSignaling) { state.closingSignaling = false; return; }
      if (currentPage === 'chat') {
        if (chatReconnectTimer) clearTimeout(chatReconnectTimer);
        chatReconnectTimer = setTimeout(() => { if (currentPage === 'chat') ensureChatConnection(); }, 3000);
      }
      if (state.role === 'guest') await failGuestConnection('服务端连接中断/房间已关闭');
      else if (state.role === 'host') await resetHostRoom('服务端连接中断/房间已关闭', true);
    };
    state.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        logLine('忽略无效的信令消息: ' + e.message);
        return;
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
        logLine('忽略格式错误的信令消息');
        return;
      }
      handleSignal(msg);
    };
  });
}

function sendSignal(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

function handleSignal(msg) {
  const safeAsync = (promise, label) => Promise.resolve(promise).catch((e) => {
    logLine(`${label}: ${e.message}`);
    toast(`${label}：${e.message}`, 'error');
    if (state.role === 'guest') safeAsync(failGuestConnection(label + '，请重试或改用 frp'), '清理访客连接失败');
  });
  switch (msg.type) {
    case 'created':
      Promise.resolve(onRoomCreated(msg)).catch(async (e) => {
        const detail = e instanceof Error ? e.message : String(e);
        logLine('创建房间失败: ' + detail);
        toast('创建房间失败：' + detail, 'error');
        sendSignal({ type: 'close', room: state.roomCode });
        await resetHostRoom('创建房间失败');
      });
      break;
    case 'joined': safeAsync(onRoomJoined(msg), '加入房间失败'); break;
    case 'peer-joined': onPeerJoined(msg); break;
    case 'peer-left': onPeerLeft(msg); break;
    case 'members': onMembers(msg); break;
    case 'closed': onRoomClosed(msg); break;
    case 'et-port':
      if (msg.port) {
        const newAddr = (state.easytier?.hostVirtualIp || '') + ':' + msg.port;
        if ($('host-lan-addr')) $('host-lan-addr').textContent = newAddr;
        logLine('房主代理端口已更新为: ' + msg.port);
      }
      break;
    case 'chat':
      // Handle chat messages from signaling
      if (msg.text && msg.username) {
        renderChatMessage(msg);
      }
      break;
    case 'error':
      toast(msg.error, 'error');
      logLine('信令错误: ' + msg.error);
      if (state.role === 'guest' && !state.roomInfo) safeAsync(failGuestConnection(msg.error || '加入房间失败'), '清理访客连接失败');
      if (!state.roomCode && state.role === 'host') state.role = null;
      $('btn-create').disabled = false;
      $('quick-host-confirm').disabled = false;
      $('btn-join').disabled = false;
      quickHostPending = false;
      break;
  }
}

// Alias for backward compatibility with onSignal references
function onSignal(msg) {
  return handleSignal(msg);
}

/* ============ Host 侧：创建房间 ============ */
// 建房页三阶段：setup（选模式表单）/ creating（建房中）/ active（房间已开）。
// 之前只有 setup 与 active 两块，建房期间一直停在 setup 上，看起来像卡在「创建房间」页。
function setHostPhase(phase) {
  const setup = $('host-setup');
  const creating = $('host-creating');
  const active = $('host-active');
  if (setup) setup.classList.toggle('hidden', phase !== 'setup');
  if (creating) creating.classList.toggle('hidden', phase !== 'creating');
  if (active) active.classList.toggle('hidden', phase !== 'active');
}
function setHostCreatingText(text) {
  const el = $('host-creating-text');
  if (el) el.textContent = text;
}

/* 房主自定义信息：简介 / MC 版本 / 密码。
   EasyTier 与 FRP 两条建房路径共用这一份，避免各写一遍导致两边漂移。
   长度上限与服务端 security-logic.js 的 ROOM_TEXT_LIMITS 保持一致。 */
function hostCustomFields() {
  return {
    description: ($('host-desc')?.value || '').trim().slice(0, 200),
    mcVersion: ($('host-version')?.value || '').trim().slice(0, 32),
    password: ($('host-password')?.value || '').slice(0, 64),
  };
}

async function createRoom(options = {}) {
  if (state.role) { setHostPhase('setup'); return toast('当前已在房间中，请先退出当前房间', 'warn'); }
  const inputId = options.inputId || 'mc-port';
  const mode = options.mode || state.mode;
  const button = $(options.buttonId || 'btn-create');
  const port = parseInt($(inputId).value, 10);
  if (!port || port < 1 || port > 65535) { setHostPhase('setup'); return toast('端口无效', 'error'); }
  state.mcPort = port;
  selectMode(mode);

  if (mode === 'frp') return createFrpRoom(button);

  /* EasyTier 需要管理员权限（虚拟网卡） */
  if (!(await ensureElevatedForEasyTier('创建 EasyTier 房间'))) { setHostPhase('setup'); return; }

  try {
    button.disabled = true;
    setHostCreatingText('正在连接信令服务器…');
    logLine('正在连接信令服务器...');
    await connectSignaling();
    setHostCreatingText('正在创建房间…');
    state.role = 'host';
    state.isPublic = !!(options.isPublic ?? $('host-public')?.checked);
    sendSignal({ type: 'create', mode: 'easytier', username: state.user.username, userId: state.user.id, mcPort: port, isPublic: state.isPublic, ...hostCustomFields() });
  } catch (e) {
    toast(e.message, 'error');
    button.disabled = false;
    setHostPhase('setup');
  }
}

async function onRoomCreated(msg) {
  const code = typeof msg === 'string' ? msg : msg.room || msg;
  const mode = typeof msg === 'object' ? (msg.mode || 'easytier') : 'easytier';
  state.roomCode = code;
  state.maxMembers = Number(msg.maxMembers) || state.maxMembers;
  $('btn-create').disabled = false;
  $('quick-host-confirm').disabled = false;
  if (quickHostPending) {
    quickHostPending = false;
    closeModal('quick-host-modal');
    navTo('host');
    setHostPhase('active');
  }
  setHostPhase('active');
  $('room-code-display').textContent = code;
  $('host-online-count').textContent = `1/${state.maxMembers}`;
  renderHomeStatus();

  if (mode === 'frp' && typeof msg === 'object' && msg.frp) {
    const { host, port } = msg.frp;
    notify('frp 中转已启动', 'success');
    $('host-lan-addr').textContent = host + ':' + port;
    logLine('frp 房间已创建: ' + code + '，访客连接地址: ' + host + ':' + port);
    state.frpEndpoint = { host, port };
    reportFrpSession(code, port).catch((e) => logLine('frp 端口上报失败: ' + e.message));
    return;
  }

  if (!msg.easytier) throw new Error('服务端未返回 EasyTier 配置');
  notify('正在启动 EasyTier...');
  const etConfig = { ...msg.easytier, mode: 'host', mcPort: state.mcPort };
  etConfig.peers = await resolveEtPeers(etConfig.peers);
  const result = await window.mclink.easytierStart(etConfig);
  if (!result?.ok) throw new Error(result?.error || 'EasyTier 启动失败');
  state.easytier = result.status;
  const hostVirtualIp = msg.easytier.hostVirtualIp || state.easytier.virtualIp;
  if (!hostVirtualIp) throw new Error('未获取到房主虚拟 IP');
  state.easytier.hostVirtualIp = hostVirtualIp;
  notify('EasyTier 已启动，等待好友加入...', 'success');
  const etPort = result.status?.proxyPort || 25565;
  $('host-lan-addr').textContent = hostVirtualIp + ':' + etPort;
  logLine('EasyTier 房间已创建: ' + code + '，连接地址: ' + hostVirtualIp + ':' + etPort);
  if (etPort !== 25565) sendSignal({ type: 'et-port-update', port: etPort });

  try {
    const r = await window.mclink.motdStart({ port: state.mcPort, roomCode: code, hostName: state.user.username });
    if (r.ok) logLine('已开启局域网广播: ' + r.motd);
  } catch (e) {
    logLine('局域网广播启动失败: ' + e.message);
  }
}

function onPeerJoined(msg) {
  if (state.role !== 'host') return;
  if (typeof msg.members === 'number') $('host-online-count').textContent = String(msg.members);
  notify('好友已加入，EasyTier 正在自动组网', 'success');
  logLine((msg.username || '好友') + ' 已加入房间');
  updateHostPeers();
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

function memberRow(member, showIp) {
  const name = escapeHtml(member.username || member.name || '未知用户');
  const hostBadge = member.isHost || member.role === 'host' ? '<span class="host-badge">房主</span>' : '';
  const ip = showIp ? escapeHtml(member.ip || '--') : '';
  const ping = Number.isFinite(Number(member.ping)) ? `${Number(member.ping)} ms` : '--';
  return `<div class="peer-item"><span class="peer-name">${name}${hostBadge}</span>${showIp ? '<span class="peer-ip">${ip}</span>' : '<span></span>'}<span class="peer-ping">${ping}</span></div>`;
}

function onMembers(msg) {
  state.members = Array.isArray(msg.members) ? msg.members : [];
  state.maxMembers = Number(msg.maxMembers) || state.maxMembers;
  updateHostPeers();
  renderHomeStatus();
  if ($('guest-members')) $('guest-members').innerHTML = state.members.map((m) => memberRow(m, false)).join('');
}

function updateHostPeers() {
  const total = state.members.length || (state.role === 'host' ? 1 : 0);
  $('host-online-count').textContent = `${total}/${state.maxMembers}`;
  $('host-peers').innerHTML = state.members.map((m) => memberRow(m, true)).join('');
}

function onPeerLeft(msg) {
  logLine((msg.username || '好友') + ' 已离开房间');
  if (state.role === 'host') {
    notify('EasyTier 已启动，等待好友加入...', 'success');
    updateHostPeers();
  } else if (state.role === 'guest') {
    $('j-status').textContent = '房间成员已离开';
  }
}

async function stopEasyTier() {
  try { await window.mclink.easytierStop(); } catch (e) { debugLog('停止 EasyTier 失败: ' + e.message); }
  state.easytier = { state: 'stopped', running: false, virtualIp: null, error: null };
}

async function resetHostRoom(reason = '房间已关闭', notify = false) {
  if (state.hostResetPromise) return state.hostResetPromise;
  state.hostResetPromise = (async () => {
    state.role = null;
    state.roomCode = null;
    state.members = [];
    state.isPublic = false;
    state.frpEndpoint = null;
    state.frpNode = null;
    state.frpTunnelName = '';
    const ws = state.ws;
    state.ws = null;
    if (ws) {
      state.closingSignaling = true;
      try { ws.close(); } catch {}
    }
    const cleanupResults = await Promise.allSettled([
      stopEasyTier(),
      Promise.resolve().then(() => window.mclink.frpcStop()),
      Promise.resolve().then(() => window.mclink.motdStop()),
    ]);
    const cleanupLabels = ['EasyTier', 'frpc', '局域网广播'];
    cleanupResults.forEach((result, index) => {
      if (result.status === 'rejected') debugLog(`停止 ${cleanupLabels[index]} 失败: ${result.reason?.message || result.reason}`);
    });
    setHostPhase('setup');
    $('btn-create').disabled = false;
    $('quick-host-confirm').disabled = false;
    quickHostPending = false;
    logLine(reason);
    if (notify) toast(reason, 'warn');
  })();
  try {
    await state.hostResetPromise;
  } finally {
    state.hostResetPromise = null;
  }
}

async function closeRoom() {
  if (state.role !== 'host') return;
  sendSignal({ type: 'close', room: state.roomCode });
  await new Promise((resolve) => setTimeout(resolve, 180));
  await resetHostRoom('房间已关闭', true);
}

/* ============ frp 中转模式（Host）=========== */
function randomFrpPort() {
  const min = 2000;
  const max = 5000;
  const range = max - min + 1;
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return min + (value[0] % range);
  }
  return min + Math.floor(Math.random() * range);
}

async function reportFrpSession(roomCode, remotePort) {
  if (!state.frpTunnelName || !roomCode) return;
  const body = {
    tunnelName: state.frpTunnelName,
    remotePort: Number(remotePort) || 0,
    roomCode: String(roomCode),
    nodeId: state.frpNode ? state.frpNode.id : null,
  };
  await api('/frp/report', { method: 'POST', body: JSON.stringify(body) });
  logLine('已向服务端上报 frp 端口: ' + remotePort + '（隧道 ' + state.frpTunnelName + '）');
}

async function createFrpRoom(button = $('btn-create')) {
  if (!state.frpNodes.length) await loadFrpNodes({ force: true });
  const node = state.frpNodes.find((n) => n.id === state.frpNodeId);
  if (!node) {
    button.disabled = false;
    return toast('没有可用的 frp 节点，请刷新节点后重试', 'error');
  }

  logLine('正在启动 frp 内网穿透: ' + node.name);
  toast('提示：frp 固定中转延迟通常高于 EasyTier', 'warn');

  try {
    button.disabled = true;

    /* 先起 MC 探测代理：房客在 MC 服务器列表里看到的将是 BLFP 的图标和 MOTD，
       而不是房主那个存档的名字。frpc 的公网端口指向代理，代理再把游戏流量转给 MC。
       代理起不来就退回直连 MC —— 宁可没有品牌，也不能让人连不上。 */
    let localPort = state.mcPort;
    try {
      const proxy = await window.mclink.mcStatusProxyStart({
        targetPort: state.mcPort,
        motd: 'BLFP 联机 | ' + (state.user?.username || '房主'),
      });
      if (proxy && proxy.ok && proxy.port) {
        localPort = proxy.port;
        logLine('MC 探测代理已启动，端口 ' + proxy.port + '，服务器列表将显示 BLFP');
      } else {
        logLine('MC 探测代理未启动，将直连 MC：' + ((proxy && proxy.error) || '未知原因'));
      }
    } catch (e) {
      logLine('MC 探测代理启动失败，将直连 MC：' + e.message);
    }

    // 1. 在 2000–5000 中随机选择公网端口；冲突时重新随机，不顺序递增
    let remotePort;
    let res;
    const attempted = new Set();
    for (let attempt = 0; attempt < 5; attempt++) {
      do { remotePort = randomFrpPort(); } while (attempted.has(remotePort));
      attempted.add(remotePort);
      res = await window.mclink.frpcStart({
        serverAddr: node.host,
        serverPort: node.port || 7000,
        token: node.token || undefined,
        tls: Boolean(node.tls_enabled),
        localPort,
        remotePort,
      });
      if (res.ok) {
        remotePort = res.remotePort || remotePort;
        break;
      }
      const retryable = /端口|already|unavailable|占用/i.test(res.error || '');
      if (!retryable) throw new Error(res.error || 'frpc 启动失败');
      logLine('frp 端口 ' + remotePort + ' 不可用，正在重新随机...');
    }
    if (!res || !res.ok) throw new Error((res && res.error) || '未找到可用的随机公网端口');
    state.frpTunnelName = res.tunnelName || '';
    logLine('frpc 已启动，随机公网端口: ' + remotePort + (state.frpTunnelName ? '，隧道名: ' + state.frpTunnelName : ''));

    // 2. 通过 ws 信令创建房间（附带 frp 端点信息）
    await connectSignaling();
    state.role = 'host';
    state.frpNode = node;
    sendSignal({
      type: 'create',
      mode: 'frp',
      userId: state.user.id,
      username: state.user.username,
      mcPort: state.mcPort,
      frp: { host: node.host, port: remotePort, node: node.id },
      isPublic: !!($('host-public')?.checked),
      ...hostCustomFields(),
    });
    // 等待 'created' 回调处理 UI
  } catch (e) {
    toast(e.message, 'error');
    logLine('frp 启动失败: ' + e.message);
    try { await window.mclink.frpcStop(); } catch {}
    state.role = null;
    state.frpNode = null;
    button.disabled = false;
    setHostPhase('setup');
  }
}

let quickHostMode = 'easytier';
let quickHostPending = false;
function quickHostKey(event, mode) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openQuickHost(mode);
  }
}
/* 快捷创建：直接打开真实起始弹窗并预选模式（旧的 quick-host-modal 是空 div，会弹出黑遮罩） */
function openQuickHost(mode) {
  quickHostMode = mode;
  try { selectStartMode(mode === 'frp' ? 'frp' : 'easytier'); } catch (e) {}
  const modal = $('start-host-modal');
  if (modal) modal.classList.remove('hidden');
  else navTo('host');
}
async function confirmQuickHost() {
  const button = $('quick-host-confirm');
  button.disabled = true;
  quickHostPending = true;
  $('mc-port').value = $('quick-mc-port').value;
  if (quickHostMode === 'frp') selectFrpNode($('quick-frp-node-select').value);
  await createRoom({ inputId: 'quick-mc-port', mode: quickHostMode, buttonId: 'quick-host-confirm', isPublic: !!($('quick-public')?.checked) });
  if (state.role !== 'host') {
    quickHostPending = false;
    button.disabled = false;
  }
}

/* ============ 开始联机对话框（新） ============ */
let startHostDialogMode = 'easytier';
let startHostDialogPortMode = 'auto';

function openStartHostDialog() {
  openModal('start-host-modal');
  startHostDialogMode = 'easytier';
  startHostDialogPortMode = 'auto';
  selectStartMode('easytier');
  selectHostPortOption('auto');
}

function selectHostPortOption(mode) {
  startHostDialogPortMode = mode;
  const autoCard = $('host-port-auto');
  const manualCard = $('host-port-manual');
  const portInput = $('start-custom-port');
  if (autoCard) autoCard.classList.toggle('selected', mode === 'auto');
  if (manualCard) manualCard.classList.toggle('selected', mode === 'manual');
  if (portInput) {
    portInput.disabled = mode !== 'manual';
    if (mode === 'manual') portInput.value = state.mcPort || 25565;
  }
}

function selectStartMode(mode) {
  startHostDialogMode = mode;
  const et = $('start-mode-easytier');
  const frp = $('start-mode-frp');
  if (et) et.classList.toggle('active', mode === 'easytier');
  if (frp) frp.classList.toggle('active', mode === 'frp');
  // frp 模式：伸长展开节点选择；easytier：收起
  const section = $('modal-frp-node-section');
  if (section) {
    if (mode === 'frp') {
      section.classList.remove('collapsed');
      loadStartDialogFrpNodes();
    } else {
      section.classList.add('collapsed');
    }
  }
}

/* 开始联机弹窗的 frp 节点选择（卡片式） */
let startDialogNodesLoaded = false;
async function loadStartDialogFrpNodes(force = false) {
  const list = $('frp-node-list');
  const status = $('frp-node-status');
  if (!list) return;
  if (startDialogNodesLoaded && !force) return;
  try {
    if (status) status.textContent = '加载中...';
    const result = await api('/nodes');
    const nodes = Array.isArray(result) ? result : [];
    state.frpNodes = nodes;
    if (!nodes.length) {
      list.innerHTML = '<div class="frp-node-empty">暂无可用节点</div>';
      if (status) status.textContent = '暂无节点';
      return;
    }
    if (status) status.textContent = nodes.length + ' 个节点可用';
    // 默认选第一个
    if (!state.frpNodeId || !nodes.find(n => n.id === state.frpNodeId)) {
      state.frpNodeId = nodes[0].id;
    }
    list.innerHTML = nodes.map((n, i) => `
      <div class="frp-node-item ${n.id === state.frpNodeId ? 'selected' : ''}" style="animation-delay:${Math.min(i * 0.07, 0.5)}s" onclick="selectStartDialogNode(${n.id})">
        <div>
          <div class="frp-node-name">${escapeHtml(n.name)}</div>
          <div class="frp-node-location">${escapeHtml(n.region || '未知')} · ${escapeHtml(n.bandwidth || '')}</div>
        </div>
        <div class="frp-node-latency mid" id="start-node-latency-${n.id}">测速中</div>
      </div>`).join('');
    startDialogNodesLoaded = true;
    // 后台测速（不阻塞）
    nodes.forEach((n) => {
      pingStartNode(n).catch(() => {});
    });
  } catch (e) {
    list.innerHTML = '<div class="frp-node-empty">节点获取失败，<a href="#" onclick="loadStartDialogFrpNodes(true);return false" style="color:var(--accent2)">重试</a></div>';
    if (status) status.textContent = '加载失败';
  }
}
function selectStartDialogNode(id) {
  state.frpNodeId = id;
  document.querySelectorAll('.frp-node-item').forEach((el) => {
    el.classList.toggle('selected', el.onclick.toString().includes(String(id)));
  });
  // 更精确的选中态
  document.querySelectorAll('#frp-node-list .frp-node-item').forEach((el, i) => {
    if (state.frpNodes[i]) el.classList.toggle('selected', state.frpNodes[i].id === id);
  });
}
async function pingStartNode(node) {
  const el = $('start-node-latency-' + node.id);
  if (!el) return;
  try {
    const t0 = performance.now();
    const res = await window.mclink.pingNode({ host: node.host || node.addr, port: Number(node.port || 443) });
    if (!res || !res.ok) { el.textContent = '本机不可达'; el.className = 'frp-node-latency bad'; return; }
    const ms = Number(res.latency) || Math.round(performance.now() - t0);
    el.textContent = ms + ' ms';
    el.className = 'frp-node-latency ' + (ms < 80 ? 'good' : ms < 200 ? 'mid' : 'bad');
  } catch (e) {
    el.textContent = '超时';
    el.className = 'frp-node-latency bad';
  }
}

function confirmStartHost() {
  const portEl = $('start-custom-port');
  let port;
  if (startHostDialogPortMode === 'auto') {
    port = state.mcPort || 25565;
    if ($('mc-port')) $('mc-port').value = port;
  } else {
    port = parseInt(portEl ? portEl.value : state.mcPort, 10);
    if (!port || port < 1 || port > 65535) {
      toast('请输入有效的端口号，范围 1 到 65535', 'error');
      return;
    }
    if ($('mc-port')) $('mc-port').value = port;
  }
  state.mcPort = port;
  closeModal('start-host-modal');
  // 直接创建房间（原来调 openQuickHost() 会弹出一个空的 quick-host-modal，
  // 那是个遗留空 div → 全屏黑遮罩盖住界面，看起来像卡死）
  const mode = startHostDialogMode || state.mode || 'easytier';
  // 先切页并进入 creating 阶段再建房：建房是异步的（EasyTier 还要等 UAC 授权），
  // 原来先 navTo('host') 就停在了「创建房间」表单上，用户以为卡住了。
  navTo('host');
  setHostPhase('creating');
  setHostCreatingText(mode === 'frp' ? '正在启动 frp 内网穿透…' : '正在准备 EasyTier 虚拟网卡…');
  createRoom({ inputId: 'mc-port', mode, buttonId: 'btn-create', isPublic: !!($('host-public') && $('host-public').checked) });
}

/* ============ 加入房间对话框（从房间列表弹出） ============ */
function confirmJoinRoom() {
  const input = $('join-room-input');
  if (!input) return;
  const code = input.value.trim();
  if (!/^\d{6}$/.test(code)) {
    toast('请输入 6 位纯数字房间号', 'error');
    return;
  }
  closeModal('join-room-modal');
  // 直接设置兼容输入框并加入（不再跳页）
  const originalInput = $('room-input');
  if (originalInput) originalInput.value = code;
  joinRoom();
}

/* ============ Guest 侧：加入房间 ============ */
/* 取房间号：优先弹窗输入框，其次兼容元素（历史代码读的是隐藏 div，值为 undefined 会抛错） */
function currentJoinCode() {
  const modalInput = $('join-room-input');
  const compat = $('room-input');
  const raw = (modalInput && modalInput.value) || (compat && compat.value) || '';
  return String(raw).replace(/\D/g, '').slice(0, 6);
}

async function joinRoom() {
  if (state.role) return toast('当前已在房间中，请先退出当前房间', 'warn');
  const code = currentJoinCode();
  if (!/^\d{6}$/.test(code)) return toast('请输入 6 位纯数字房间号', 'error');

  $('btn-join').disabled = true;
  notify('正在查询房间...');

  try {
    // 通过信令连接加入，服务端 joined 消息会携带模式信息
    notify('正在连接信令服务器...');
    await connectSignaling();
    state.role = 'guest';
    state.roomCode = code;
    renderHomeStatus();
    sendSignal({ type: 'join', room: code });

    /* 超时保护：15 秒内没收到 joined/error 就判定失败并恢复界面 */
    if (state.joinTimer) clearTimeout(state.joinTimer);
    state.joinTimer = setTimeout(() => {
      if (state.role === 'guest' && !state.roomInfo) {
        failGuestConnection('加入房间超时，房间可能已关闭或网络不稳定，请重试');
      }
      state.joinTimer = null;
    }, 15000);
  } catch (e) {
    toast(e.message, 'error');
    notify('连接失败: ' + e.message, 'error');
    await cleanupGuestConnection();
    $('btn-join').disabled = false;
  }
}

async function cleanupGuestConnection() {
  state.role = null;
  state.roomCode = null;
  state.roomInfo = null;
  await stopEasyTier();
  if (state.ws) { state.closingSignaling = true; try { state.ws.close(); } catch {} state.ws = null; }
}

async function failGuestConnection(message) {
  if (state.joinTimer) { clearTimeout(state.joinTimer); state.joinTimer = null; }
  if (state.role !== 'guest') return;
  await cleanupGuestConnection();
  $('join-active').classList.add('hidden');
  $('join-form').classList.remove('hidden');
  
  notify(message, 'error');
  $('btn-join').disabled = false;
  toast(message, 'error');
}

async function onRoomJoined(msg) {
  if (state.joinTimer) { clearTimeout(state.joinTimer); state.joinTimer = null; }
  logLine('已加入房间 ' + msg.room + '，模式: ' + (msg.mode || 'easytier'));
  state.roomInfo = { room: msg.room, hostUser: msg.hostUser };
  if (Array.isArray(msg.members)) onMembers(msg);

  if (msg.mode === 'frp') {
    
    $('btn-join').disabled = false;
    joinFrpRoom(msg);
    return;
  }

  if (!msg.easytier?.hostVirtualIp) throw new Error('服务端未返回 EasyTier 房主地址');
  /* 访客接入 EasyTier 同样需要管理员权限 */
  if (!(await ensureElevatedForEasyTier('加入 EasyTier 房间'))) {
    await failGuestConnection('EasyTier 需要管理员权限，请以管理员身份重启客户端后重试，或让房主改用 frp 模式');
    return;
  }
  const address = msg.easytier.hostVirtualIp + ':' + (msg.easytier.port || 25565);
  notify('正在启动 EasyTier...');
  const etConfig = { ...msg.easytier, mode: 'guest' };
  etConfig.peers = await resolveEtPeers(etConfig.peers);
  const result = await window.mclink.easytierStart(etConfig);
  if (!result?.ok) throw new Error(result?.error || 'EasyTier 启动失败');
  state.easytier = result.status;

  const deadline = Date.now() + 30000;
  let test;
  while (Date.now() < deadline) {
    const attemptStarted = Date.now();
    const remaining = deadline - attemptStarted;
    test = await Promise.race([
      window.mclink.easytierTest({ hostVirtualIp: msg.easytier.hostVirtualIp, port: msg.easytier.port }),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: test?.error || '连接超时' }), remaining)),
    ]);
    if (test?.ok) break;
    logLine('EasyTier 连通性测试未通过: ' + (test?.error || '未知原因') + '，重试中');
    notify('正在等待 EasyTier 网络连通... ' + (test?.error || '重试中'));
    const retryDelay = Math.min(Math.max(0, 1000 - (Date.now() - attemptStarted)), deadline - Date.now());
    if (retryDelay > 0) await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }
  if (!test?.ok) throw new Error('无法连接房主 Minecraft 端口: ' + (test?.error || '未知原因'));

  
  $('btn-join').disabled = false;
  $('join-form').classList.add('hidden');
  $('join-active').classList.remove('hidden');
  $('j-room').textContent = msg.room || state.roomCode || '--';
  $('j-host').textContent = msg.hostUser || '未知';
  $('j-mode').innerHTML = '<span class="tag tag-p2p">EasyTier 智能组网</span>';
  $('j-addr').textContent = address;
  $('j-status').textContent = 'EasyTier 连接已就绪';
  logLine('EasyTier 连通性测试成功: ' + address);
  toast('连接成功！请在 Minecraft 中连接 ' + address, 'success');
}

/* ============ frp 中转模式（Guest）=========== */
async function joinFrpRoom(room) {
  // room 来自信令 joined 消息（含 frp: {host, port}）或旧 REST 接口
  const frpHost = (room.frp && room.frp.host) || room.frp_host;
  const frpPort = (room.frp && room.frp.port) || room.frp_remote_port;
  if (!frpHost || !frpPort) {
    await failGuestConnection('frp 节点未返回可用连接地址，请让房主重新创建房间');
    return;
  }

  logLine('frp 中转房间，连接: ' + frpHost + ':' + frpPort);
  toast('提示：frp 固定中转延迟通常高于 EasyTier', 'warn');

  $('join-form').classList.add('hidden');
  $('join-active').classList.remove('hidden');
  $('j-room').textContent = room.room || state.roomCode || '--';
  $('j-host').textContent = room.hostUser || '未知';
  $('j-mode').innerHTML = '<span class="tag tag-frp">frp 中转</span>';
  $('j-addr').textContent = frpHost + ':' + (frpPort || '?');
  $('j-status').textContent = '请将上方地址填入 MC 多人游戏';
  $('btn-join').disabled = false;
  logLine('请在 MC 中直连: ' + frpHost + ':' + frpPort);
}

async function leaveRoom() {
  if (state.role === 'guest') {
    sendSignal({ type: 'leave', room: state.roomCode });
    await cleanupGuestConnection();
    $('join-active').classList.add('hidden');
    $('join-form').classList.remove('hidden');
    
    $('btn-join').disabled = false;
    logLine('已断开连接');
  }
  renderHomeStatus();
}

async function onRoomClosed(msg) {
  const reason = msg.reason || '房间已被服务端关闭';
  toast(reason, 'warn');
  logLine(reason);
  if (state.role === 'guest') {
    await cleanupGuestConnection();
    $('join-active').classList.add('hidden');
    $('join-form').classList.remove('hidden');
    
    notify(reason, 'error');
    $('btn-join').disabled = false;
  } else if (state.role === 'host') {
    await resetHostRoom(reason);
  } else await cleanupGuestConnection();
  renderHomeStatus();
}

/* ============ 运行时事件桥接 ============ */
function setupTunnelBridge() {
  window.mclink.onEasytierLog((line) => {
    if (state.debugMode) logLine('[EasyTier] ' + String(line).trim());
  });
  window.mclink.onEasytierStatus((status) => {
    state.easytier = { ...state.easytier, ...status };
    const text = status?.state || (status?.running ? 'running' : 'stopped');
    if (!['starting', 'stopping', 'error'].includes(text)) return;
    if (state.role === 'host') notify('EasyTier: ' + text);
    if (state.role === 'guest' && $('j-status')) $('j-status').textContent = 'EasyTier 状态: ' + text;
  });
  window.mclink.onEasytierError((err) => {
    const message = typeof err === 'string' ? err : err?.message || '未知错误';
    state.easytier = { ...state.easytier, state: 'error', running: false, error: message };
    logLine('[EasyTier错误] ' + message);
    toast('EasyTier: ' + message, 'error');
  });
  window.mclink.onFrpcLog((line) => {
    const KEY = ['start proxy', 'login to server', 'proxy added', 'proxy removed',
                 'reconnecting', 'disconnected', 'connected', 'error', 'failed'];
    const lower = line.toLowerCase();
    if (state.debugMode || KEY.some((k) => lower.includes(k))) logLine('[frpc] ' + line.trim());
  });
  window.mclink.onFrpcError((err) => {
    const detail = err instanceof Error ? err.message : String(err);
    logLine('[frpc错误] ' + detail);
    if (state.role === 'host' && state.roomCode && state.frpEndpoint) {
      const reason = 'frp 运行错误，房间已关闭：' + detail;
      sendSignal({ type: 'close', room: state.roomCode });
      void resetHostRoom(reason, true).catch((e) => debugLog('清理 frp 房间失败: ' + e.message));
      return;
    }
    toast('frp: ' + detail, 'error');
  });
}

/* ============ 其他 ============ */
function copyRoomCode() {
  navigator.clipboard.writeText(state.roomCode).then(() => toast('已复制房间号', 'success'));
}

// 房主：复制局域网连接地址
function copyHostAddr() {
  const addr = $('host-lan-addr').textContent;
  navigator.clipboard.writeText(addr).then(() => toast('已复制连接地址: ' + addr, 'success'));
}

// 访客：复制连接地址
function copyJoinAddr() {
  const addr = $('j-addr').textContent;
  navigator.clipboard.writeText(addr).then(() => toast('已复制连接地址: ' + addr, 'success'));
}

function clearLog() { $('log-box').innerHTML = ''; }
function copyQQGroup() { navigator.clipboard.writeText('229527551').then(() => toast('QQ群号已复制', 'success')); }

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
}
async function loadAppInfo() {
  state.appInfo = await window.mclink.getAppInfo();
  $('app-version').textContent = state.appInfo.version;
  $('app-platform').textContent = `${state.appInfo.platform} / ${state.appInfo.arch}`;
}
function announcementStorageKey(announcement) {
  return `blfp_announcement_${announcement.version || '1'}_${new Date().toISOString().slice(0, 10)}`;
}

async function loadAnnouncement() {
  try {
    const announcement = await apiChat('/settings/announcement');
    state.announcement = announcement;
    if (!announcement.enabled || !announcement.content || localStorage.getItem(announcementStorageKey(announcement))) {
      checkForUpdates();
    reportLastUpdateResult();
      return;
    }
    $('announcement-title').textContent = announcement.title || '公告';
    $('announcement-content').textContent = announcement.content;
    $('announcement-today').checked = false;
    const button = $('announcement-close');
    let remaining = Math.max(0, Number(announcement.forceSeconds) || 0);
    button.disabled = remaining > 0;
    button.textContent = remaining > 0 ? `请阅读 ${remaining} 秒` : '我知道了';
    openModal('announcement-modal');
    if (state.announcementTimer) clearInterval(state.announcementTimer);
    if (remaining > 0) {
      state.announcementTimer = setInterval(() => {
        remaining -= 1;
        button.disabled = remaining > 0;
        button.textContent = remaining > 0 ? `请阅读 ${remaining} 秒` : '我知道了';
        if (remaining <= 0) { clearInterval(state.announcementTimer); state.announcementTimer = null; }
      }, 1000);
    }
  } catch (e) {
    logLine('公告加载失败: ' + e.message);
    checkForUpdates();
    reportLastUpdateResult();
  }
}

function closeAnnouncement() {
  if ($('announcement-close').disabled) return;
  if ($('announcement-today').checked && state.announcement) localStorage.setItem(announcementStorageKey(state.announcement), '1');
  if (state.announcementTimer) clearInterval(state.announcementTimer);
  state.announcementTimer = null;
  closeModal('announcement-modal');
  checkForUpdates();
    reportLastUpdateResult();
}

/*
 * 检查更新。
 *
 * 注意：这里**只发一条通知**，而且成功一律用绿色的 toast。
 * 之前每个分支都是 notify(...) + toast(..., 'success') 两条一起发，
 * 而 notify 内部就是 toast(msg, type)，于是用户看到"一绿一正常"两条重复通知；
 * 自动检查那条又被 if (!silent) 挡掉了绿色那条，只剩普通的。
 * 现在统一成：成功 → 绿色；失败 → 红色。自动检查与手动检查表现完全一致。
 */
/*
 * 报告"上次软件内更新"的结果。
 *
 * 安装器失败时会把客户端原样拉回来（文件没动）。此时如果什么都不说，
 * 用户看到的只是「软件自己关了一下又开了」，完全不知道更新失败了 ——
 * payload 缺失那类错误以前就是这么被吞掉的。
 * 成功则不用报（客户端版本号变了，用户自己看得见）。
 */
async function reportLastUpdateResult() {
  try {
    if (!window.mclink || !window.mclink.readUpdateStatus) return;
    const st = await window.mclink.readUpdateStatus();
    if (!st || typeof st !== 'object') return;
    if (st.ok === false) {
      const reason = st.error || '未知原因';
      logLine('上次更新失败：' + reason);
      toast('上次更新失败：' + reason, 'error');
    }
  } catch (e) {
    logLine('读取更新结果失败: ' + ((e && e.message) || e));
  }
}

async function checkForUpdates() {
  try {
    if (!state.appInfo) await loadAppInfo();
    const channel = state.updateChannel === 'test' ? 'test' : 'stable';
    const info = await window.mclink.checkGithubUpdate(channel);
    state.updateInfo = info;
    if (channel !== 'test' && info.prerelease) {
      /* 正式版渠道：忽略预发布版本。测试版渠道用户就是要拉最新 pre，不再拦。 */
      state.updateInfo = null;
      toast('当前已是最新版本', 'success');
      return;
    }
    if (info.latestVersion && compareVersions(info.latestVersion, state.appInfo.version) > 0) {
      const tag = info.prerelease && channel === 'test' ? ' 测试版' : '';
      $('update-title').textContent = `发现新版本 ${info.latestVersion}${tag}`;
      $('update-notes').textContent = info.releaseNotes || '暂无更新说明';
      $('update-download').textContent = info.downloadUrl ? '立即更新' : '打开发布页';
      /* 复位进度条与按钮：上次可能失败过或已经走到一半 */
      if (typeof resetUpdateProgressUI === 'function') resetUpdateProgressUI();
      openModal('update-modal');
      toast(`发现新版本 ${info.latestVersion}${tag}`, 'success');
    } else {
      toast('当前已是最新版本', 'success');
    }
  } catch (e) {
    toast('检查更新失败：' + e.message, 'error');
  }
}
/*
 * 软件内更新：自己挑源下载（带进度条）→ 静默安装 → 客户端自动重启。
 * 全程不出现安装程序界面；也不需要用户去浏览器里手动下载。
 *
 * 注意主进程在拉起安装器后会立刻退出（不退就占着 BLFP.exe，安装器写不进去），
 * 所以这里拿到 result 之后基本就该被关掉了，进度全靠 onUpdateProgress 推。
 */
function setUpdateProgress(percent, text) {
  const wrap = $('update-progress');
  const fill = $('update-progress-fill');
  const label = $('update-progress-text');
  const pct = $('update-progress-percent');
  if (wrap) wrap.classList.remove('hidden');
  if (fill) fill.style.width = Math.max(0, Math.min(100, Number(percent) || 0)) + '%';
  if (label && text) label.textContent = text;
  if (pct) pct.textContent = Number.isFinite(Number(percent)) && Number(percent) > 0 ? Math.floor(Number(percent)) + '%' : '';
}

let updateInFlight = false;

/* 每次打开更新弹窗都复位一次：否则上次失败的红字/进度条会一直挂在那儿 */
function resetUpdateProgressUI() {
  const wrap = $('update-progress');
  if (wrap) wrap.classList.add('hidden');
  setUpdateProgress(0, '准备中…');
  if (wrap) wrap.classList.add('hidden');
  const btn = $('update-download');
  if (btn) {
    btn.disabled = false;
    btn.textContent = state.updateInfo?.downloadUrl ? '立即更新' : '打开发布页';
  }
  const later = $('update-later');
  if (later) later.disabled = false;
}

async function startUpdate() {
  if (updateInFlight) return;
  const url = state.updateInfo?.downloadUrl;
  if (!url) {
    /* 没有可下载的安装包时才退回浏览器，不让用户卡死在这里 */
    const fallback = state.updateInfo?.releaseUrl;
    if (fallback) return window.mclink.openExternal(fallback).then((r) => { if (!r.ok) toast(r.error, 'error'); });
    return toast('暂无可用下载地址', 'warn');
  }
  updateInFlight = true;
  const btn = $('update-download');
  const later = $('update-later');
  if (btn) { btn.disabled = true; btn.textContent = '更新中…'; }
  /* 更新期间不让关弹窗：关掉就看不到进度、也不知道出没出错 */
  if (later) later.disabled = true;
  setUpdateProgress(0, '正在选择下载源…');
  try {
    const r = await window.mclink.startUpdate({ url, assetName: state.updateInfo?.assetName });
    if (r && r.ok === false) {
      updateInFlight = false;
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
      if (later) later.disabled = false;
      setUpdateProgress(0, '更新失败：' + (r.error || '未知错误'));
      toast('更新失败：' + (r.error || '未知错误'), 'error');
      return;
    }
    /* 走到这里主进程通常马上就要退出了；万一没退，如实告诉用户下一步怎么办 */
    setUpdateProgress(100, '安装程序已在后台运行，客户端即将重启…');
  } catch (e) {
    updateInFlight = false;
    if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    if (later) later.disabled = false;
    setUpdateProgress(0, '更新失败：' + ((e && e.message) || '未知错误'));
    toast('更新失败：' + ((e && e.message) || '未知错误'), 'error');
  }
}

/* 主进程推过来的进度 */
if (window.mclink && window.mclink.onUpdateProgress) {
  window.mclink.onUpdateProgress((p) => {
    if (!p) return;
    if (p.phase === 'probe') return setUpdateProgress(0, '正在选择下载源…');
    if (p.phase === 'download') {
      const mb = (n) => (Number(n) || 0) / 1048576;
      const text = p.total
        ? `正在下载 ${mb(p.received).toFixed(1)} / ${mb(p.total).toFixed(1)} MB`
        : `正在下载 ${mb(p.received).toFixed(1)} MB`;
      return setUpdateProgress(p.percent || 0, text);
    }
    if (p.phase === 'install') return setUpdateProgress(100, p.text || '正在后台安装…');
    if (p.phase === 'restart') return setUpdateProgress(100, p.text || '正在重启客户端…');
    if (p.phase === 'error') return setUpdateProgress(0, '更新失败：' + (p.text || '未知错误'));
  });
}

function openUpdateDownload() {
  /* 保留旧入口名，避免历史调用点失效 */
  return startUpdate();
}
function openSourceRepo() {
  window.mclink.openExternal(GITHUB_REPO_URL);
}

/* ============ 退出软件 ============ */
function doExitApp() {
  showConfirm('确认退出软件？', '将停止所有连接并关闭 BLFP。', async () => {
    try { await stopEasyTier(); } catch (e) { logLine('退出前停止 EasyTier 失败: ' + ((e && e.message) || e)); }
    try { await window.mclink.frpcStop(); } catch {}
    try { await window.mclink.exitApp(); } catch { window.close(); }
  });
}

/* ============ 设置 ============ */
const SETTINGS_KEY = 'blfp_settings';

/* 安全读取设置（localStorage 损坏时不崩） */
function readSettingsSafe() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    try { localStorage.removeItem(SETTINGS_KEY); } catch (e2) {}
    return {};
  }
}

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { localStorage.removeItem(SETTINGS_KEY); }
  const server = DEFAULT_SERVER;
  localStorage.removeItem('mclink_server');
  const mcPort = Number(s.mcPort) || 25565;
  state.server = server;
  state.mcPort = mcPort;
  state.debugMode = !!s.debugMode;
  state.etNodeMode = s.etNodeMode || 'auto';
  applyTheme(s.theme || 'system', false);
  watchSystemTheme();
  applySidebarMode(s.sidebarMode || 'normal', false);
  applyPerfLevel(s.perf || 'medium', false);
  state.updateChannel = s.updateChannel === 'test' ? 'test' : 'stable';
  if (s.cursorTrail) enableCursorTrail();
  if ($('s-server')) $('s-server').value = server;
  if ($('a-server')) $('a-server').value = server;
  if ($('s-mc-port')) $('s-mc-port').value = mcPort;
  if ($('mc-port')) $('mc-port').value = mcPort;
  if ($('quick-mc-port')) $('quick-mc-port').value = mcPort;
  if ($('s-launch-behavior')) $('s-launch-behavior').value = s.launchBehavior || 'ask';
  if ($('sidebar-mode')) $('sidebar-mode').value = s.sidebarMode || 'normal';
  if ($('perf-level')) $('perf-level').value = s.perf || 'medium';
  if ($('s-update-channel')) $('s-update-channel').value = state.updateChannel;
  if ($('cursor-trail-toggle')) $('cursor-trail-toggle').checked = !!s.cursorTrail;
  if ($('debug-mode-toggle')) $('debug-mode-toggle').checked = state.debugMode;
  return s;
}

function saveSettings() {
  const server = DEFAULT_SERVER;
  const mcPort = parseInt($('s-mc-port').value) || 25565;
  const launchBehavior = $('s-launch-behavior').value;
  const sidebarMode = $('sidebar-mode').value;
  const perf = $('perf-level').value;
  const cursorTrail = $('cursor-trail-toggle').checked;
  const debugMode = $('debug-mode-toggle').checked;
  /* 存的是"模式"（system/light/dark），不是解析后的 light/dark ——
     否则用户选了"跟随系统"，一保存就被固化成当时的那个主题了 */
  const theme = readSettingsSafe().theme || 'system';
  const etNodeMode = $('s-et-node') ? $('s-et-node').value : 'auto';
  const updateChannel = $('s-update-channel') ? $('s-update-channel').value : 'stable';

  const s = { server, mcPort, launchBehavior, sidebarMode, perf, cursorTrail, debugMode, theme, etNodeMode, updateChannel };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  localStorage.setItem('mclink_server', server);
  state.server = server;
  state.mcPort = mcPort;
  state.debugMode = debugMode;
  state.etNodeMode = etNodeMode;
  state.updateChannel = updateChannel;
  $('a-server').value = server;
  $('mc-port').value = mcPort;
  $('quick-mc-port').value = mcPort;
  applySidebarMode(sidebarMode, false);
  applyPerfLevel(perf, false);
  if (cursorTrail) enableCursorTrail(); else disableCursorTrail();
  toast('设置已保存', 'success');
}

function setDebugMode(on) {
  state.debugMode = !!on;
  const s = readSettingsSafe();
  s.debugMode = state.debugMode;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  logLine(state.debugMode ? '开发者调试模式已开启，底层日志不再过滤' : '开发者调试模式已关闭');
}

function setSidebarMode(mode) { applySidebarMode(mode, true); }
function applySidebarMode(mode, save) {
  const value = ['normal', 'collapsed'].includes(mode) ? mode : 'normal';
  document.body.classList.remove('sidebar-normal', 'sidebar-collapsed');
  document.body.classList.add('sidebar-' + value);
  if ($('sidebar-mode')) $('sidebar-mode').value = value;
  if (save) {
    const s = readSettingsSafe();
    s.sidebarMode = value;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
}

function setTheme(t) {
  applyTheme(t, true);
}

/* 主题三选一：system（默认，跟随系统）/ light / dark。
   系统模式不写死 data-theme，而是实时跟随 prefers-color-scheme，
   并且监听它的变化 —— 用户在系统里切深色，客户端要跟着变，不用重启。 */
const THEME_MODES = ['system', 'light', 'dark'];

function systemPrefersLight() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  } catch (e) {
    return false;
  }
}

function resolveTheme(mode) {
  const m = THEME_MODES.includes(mode) ? mode : 'system';
  if (m === 'system') return systemPrefersLight() ? 'light' : 'dark';
  return m;
}

function applyTheme(t, save) {
  const mode = THEME_MODES.includes(t) ? t : 'system';
  const theme = resolveTheme(mode);
  document.documentElement.setAttribute('data-theme', theme);
  /* 三个按钮各自高亮，别把"跟随系统"错当成"深色" */
  ['theme-system', 'theme-dark', 'theme-light'].forEach((id) => {
    const el = $(id);
    if (el) el.classList.toggle('active', id === 'theme-' + mode);
  });
  if (window.mclink && window.mclink.setTitlebarOverlay) {
    window.mclink.setTitlebarOverlay(theme).catch(() => {});
  }
  if (save) {
    const s = readSettingsSafe();
    s.theme = mode; localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
}

/* 系统主题变化时，只有"跟随系统"模式才需要重画。
   加锁避免重复注册监听（loadSettings 被多次调用时会叠加）。 */
let systemThemeWatched = false;
function watchSystemTheme() {
  if (systemThemeWatched) return;
  systemThemeWatched = true;
  try {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      const mode = readSettingsSafe().theme || 'system';
      if (mode === 'system') applyTheme('system', false);
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (e) { /* 拿不到 matchMedia 就退化成固定主题，不影响使用 */ }
}

function setPerfLevel(level) { applyPerfLevel(level, true); }

function applyPerfLevel(level, save) {
  const value = ['off', 'low', 'medium', 'high'].includes(level) ? level : 'medium';
  document.body.classList.remove('perf-off', 'perf-low', 'perf-medium', 'perf-high');
  document.body.classList.add('perf-' + value);
  if ($('perf-level')) $('perf-level').value = value;
  if ($('cursor-trail-toggle')?.checked) {
    if (level === 'off') disableCursorTrail();
    else { if (!particleEnabled) enableCursorTrail(); else resetParticles(); }
  }
  if (save) {
    const s = readSettingsSafe();
    s.perf = value; localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
}

function setCursorTrail(on) {
  if (on) enableCursorTrail(); else disableCursorTrail();
  const s = readSettingsSafe();
  s.cursorTrail = on; localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

let particleEnabled = false;
let particleFrame = null;
let particles = [];
const particleMouse = { x: -1000, y: -1000, active: false, lastMove: 0 };
function particleCount() {
  const level = $('perf-level')?.value || 'medium';
  return { high: 96, medium: 64, low: 28, off: 0 }[level] || 64;
}
function resetParticles() {
  const canvas = $('particle-bg');
  const count = particleEnabled ? particleCount() : 0;
  particles = Array.from({ length: count }, () => ({
    x: Math.random() * innerWidth, y: Math.random() * innerHeight,
    vx: (Math.random() - 0.5) * 0.28, vy: (Math.random() - 0.5) * 0.28,
  }));
}
function drawParticles() {
  if (!particleEnabled) { particleFrame = null; return; }
  if (document.hidden) { particleFrame = null; return; }
  const canvas = $('particle-bg');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const mouseMoving = particleMouse.active && performance.now() - particleMouse.lastMove < 160;
  const perf = $('perf-level')?.value || 'medium';
  const repelParticles = ['high', 'medium'].includes(perf);
  const drawConnections = perf === 'high' || (perf === 'medium' && Math.floor(performance.now() / 16) % 2 === 0);
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (mouseMoving && repelParticles) {
      const dx = p.x - particleMouse.x, dy = p.y - particleMouse.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 190 && dist > 1) { const force = (1 - dist / 190) * 0.018; p.vx += dx / dist * force; p.vy += dy / dist * force; }
    }
    if (Math.hypot(p.vx, p.vy) < 0.055) { p.vx += (Math.random() - 0.5) * 0.006; p.vy += (Math.random() - 0.5) * 0.006; }
    p.vx *= 0.9985; p.vy *= 0.9985;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > 0.65) { p.vx = p.vx / speed * 0.65; p.vy = p.vy / speed * 0.65; }
    p.x += p.vx; p.y += p.vy;
    if (p.x < 0 || p.x > innerWidth) { p.x = Math.max(0, Math.min(innerWidth, p.x)); p.vx *= -1; }
    if (p.y < 0 || p.y > innerHeight) { p.y = Math.max(0, Math.min(innerHeight, p.y)); p.vy *= -1; }
    ctx.fillStyle = 'rgba(116,143,252,0.5)';
    ctx.beginPath(); ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2); ctx.fill();
    if (particleMouse.active) {
      const d = Math.hypot(particleMouse.x - p.x, particleMouse.y - p.y);
      if (d < 150) { ctx.strokeStyle = `rgba(116,143,252,${(1 - d / 150) * 0.28})`; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(particleMouse.x, particleMouse.y); ctx.stroke(); }
    }
    if (drawConnections) {
      for (let j = i + 1; j < particles.length; j++) {
        const q = particles[j], dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
        if (d < 85) {
          ctx.strokeStyle = `rgba(116,143,252,${(1 - d / 85) * 0.15})`;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        }
      }
    }
  }
  particleFrame = requestAnimationFrame(drawParticles);
}
function resizeParticles() {
  const canvas = $('particle-bg');
  if (!canvas) return;
  canvas.width = innerWidth;
  canvas.height = innerHeight;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && particleEnabled && !particleFrame) drawParticles();
});

function enableCursorTrail() {
  particleEnabled = true;
  const bg = $('particle-bg');
  if (!bg) return;
  bg.classList.remove('hidden');
  resizeParticles();
  resetParticles();
  drawParticles();
  window.addEventListener('resize', resizeParticles);
  bg.addEventListener('mousemove', (e) => {
    particleMouse.x = e.clientX;
    particleMouse.y = e.clientY;
    particleMouse.active = true;
    particleMouse.lastMove = performance.now();
  });
  bg.addEventListener('mouseleave', () => { particleMouse.active = false; });
}
function disableCursorTrail() {
  particleEnabled = false;
  const bg = $('particle-bg');
  if (!bg) return;
  bg.classList.add('hidden');
  window.removeEventListener('resize', resizeParticles);
  if (particleFrame) cancelAnimationFrame(particleFrame);
}

/* ============ 广场：公开房间 ============ */
let publicRoomsInterval = null;
function loadPublicRooms(initial = false) {
  if (!state.token) return;
  // 性能优化：仅在房间列表页可见时轮询，间隔30秒，失败静默（最多提示一次）
  let pollFailCount = 0;
  // initial 是闭包变量，不能直接拿来判断「首次」——它恒为 true，会让每 30 秒的轮询
  // 都写一行「已加载公开房间列表」，同时把「只在房间列表页轮询」的优化一并失效。
  // 改用只消费一次的 firstRun。
  let firstRun = initial;
  const fetchRooms = async () => {
    // 页面不可见时跳过请求
    if (document.hidden) return;
    // 首次无论如何拉一次；之后只在房间列表页轮询
    if (!firstRun && currentPage !== 'rooms') return;
    const isFirst = firstRun;
    firstRun = false;
    try {
      const rooms = await api('/rooms/public');
      renderPublicRooms(rooms);
      if (isFirst) logLine('已加载公开房间列表');
      pollFailCount = 0;
    } catch (e) {
      pollFailCount++;
      if (isFirst || pollFailCount === 1) logLine('加载公开房间失败: ' + e.message);
    }
  };
  fetchRooms();
  if (publicRoomsInterval) clearInterval(publicRoomsInterval);
  publicRoomsInterval = setInterval(fetchRooms, 30000);
}
function renderPublicRooms(rooms) {
  state.publicRooms = Array.isArray(rooms) ? rooms : [];
  const list = $('public-rooms');
  if (!list) return;
  if (!rooms || !rooms.length) {
    list.innerHTML = '<div class="empty-state">暂无公开房间</div>';
    return;
  }
  list.innerHTML = rooms.map((room) => {
    const rawCode = String(room.room_code ?? room.code ?? '');
    const code = /^\d{6}$/.test(rawCode) ? rawCode : '';
    const total = Number(room.total ?? room.members ?? 1);
    const maxMembers = Number(room.max_members ?? room.maxMembers ?? 8);
    const isFrp = room.mode === 'frp';
    const desc = String(room.description || '').trim();
    const version = String(room.mc_version || '').trim();
    const locked = room.has_password === true;
    const address = room.frp_host && room.frp_port ? room.frp_host + ':' + room.frp_port : '';

    /* 版本是房客最先要确认的事（版本对不上直接连不上），所以放在房主名后面当标签 */
    const versionTag = version ? `<span class="tag tag-version">${escapeHtml(version)}</span>` : '';
    /* 简介替代了原来的 MOTD：房客要看的是"这房间是什么类型"，不是服务器标语 */
    const descHtml = desc ? `<div class="pr-desc">${escapeHtml(desc)}</div>` : '';
    const addrHtml = isFrp
      ? (address
          ? `<div class="pr-addr">${escapeHtml(address)}</div>`
          : (locked
              ? '<div class="pr-addr pr-addr-locked">需要密码才能查看地址</div>'
              : '<div class="pr-addr pr-addr-pending">房主正在建立隧道…</div>'))
      : '';

    /* FRP 模式访客不用进房间：直接复制地址去 MC 里连。
       有密码的房间先弹密码框，密码不对服务端不会给地址。 */
    const action = isFrp
      ? `<div class="pr-join" onclick="event.stopPropagation();copyRoomAddress('${code}')">${locked && !address ? '输密码取地址' : '复制地址'}</div>`
      : `<div class="pr-join" onclick="event.stopPropagation();quickJoinRoom('${code}')">加入</div>`;

    return `
    <div class="public-room" onclick="showRoomDetail('${code}')">
      <div class="pr-code">${escapeHtml(code)}</div>
      <div class="pr-info">
        <div class="pr-host">${escapeHtml(room.host || '未知用户')} ${versionTag}</div>
        <div class="pr-meta">
          <span class="tag ${isFrp ? 'tag-frp' : 'tag-p2p'}">${isFrp ? 'frp 中转' : 'EasyTier 智能组网'}</span>
          <span>${total}/${maxMembers} 人在线</span>
        </div>
        ${descHtml}
        ${addrHtml}
      </div>
      ${action}
    </div>`;
  }).join('');
}

/* ===== FRP 房间：复制直连地址（有密码的先验密码）===== */

let roomPasswordResolver = null;

function askRoomPassword() {
  return new Promise((resolve) => {
    roomPasswordResolver = resolve;
    const input = $('room-password-input');
    if (input) input.value = '';
    openModal('room-password-modal');
    setTimeout(() => { if (input) input.focus(); }, 60);
  });
}

function submitRoomPassword() {
  const value = $('room-password-input')?.value || '';
  const resolve = roomPasswordResolver;
  roomPasswordResolver = null;
  closeModal('room-password-modal');
  if (resolve) resolve(value);
}

function cancelRoomPassword() {
  const resolve = roomPasswordResolver;
  roomPasswordResolver = null;
  closeModal('room-password-modal');
  if (resolve) resolve(null);
}

/* 复制 FRP 房间的直连地址。访客不需要进房间 —— 拿到地址直接在 MC 里连。
   有密码的房间地址不随列表下发，必须先向服务端换取；密码不对服务端会拒绝。 */
async function copyRoomAddress(code) {
  const room = state.publicRooms.find((r) => String(r.room_code) === String(code));
  if (!room) return toast('房间已不在列表中，请刷新', 'warn');

  let address = room.frp_host && room.frp_port ? room.frp_host + ':' + room.frp_port : '';
  if (!address) {
    if (room.has_password !== true) return toast('房主还没建立好隧道，稍后再试', 'warn');
    const password = await askRoomPassword();
    if (password === null) return; /* 用户取消 */
    try {
      const res = await api('/rooms/public/' + code + '/reveal', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      address = res.frp_host + ':' + res.frp_port;
      /* 回填缓存，免得同一次会话里反复问密码 */
      room.frp_host = res.frp_host;
      room.frp_port = res.frp_port;
      renderPublicRooms(state.publicRooms);
    } catch (e) {
      return toast(e.message || '密码不正确', 'error');
    }
  }

  try {
    await navigator.clipboard.writeText(address);
    toast('已复制连接地址：' + address + '，在 Minecraft 里直接连接', 'success');
  } catch (e) {
    toast('复制失败，地址是：' + address, 'warn');
  }
}
async function quickJoinRoom(code) {
  const roomCode = String(code ?? '').replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(roomCode)) return toast('房间号无效', 'error');
  if (state.role) return toast('当前已在房间中，请先退出当前房间', 'warn');
  const modalInput = $('join-room-input');
  if (modalInput) modalInput.value = roomCode;
  const compat = $('room-input');
  if (compat) compat.value = roomCode;
  await joinRoom();
}

/* ============ 好友 ============ */
async function searchFriends() {
  const q = ($('friend-search').value || '').trim();
  if (!q) return;
  const el = $('friend-search-results');
  try {
    const users = await api('/friends/search?q=' + encodeURIComponent(q));
    if (!users.length) { el.innerHTML = '<div class="empty-state">未找到用户</div>'; return; }
    el.innerHTML = users.map(u => `
      <div class="friend-item" data-friend-id="${u.id}">
        <div class="fi-avatar">${escapeHtml(u.username.charAt(0).toUpperCase())}</div>
        <div class="fi-info">
          <div class="fi-name">${escapeHtml(u.username)}${u.title ? ` <span class="user-title theme-${escapeHtml(u.theme||'dark')}">${escapeHtml(u.title)}</span>` : ''}</div>
          <div class="fi-status ${u.online ? 'online' : ''}">${u.online ? '在线' : '离线'}</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="sendFriendReq(${u.id})">添加好友</button>
      </div>`).join('');
  } catch (e) { toast(e.message, 'error'); }
}

async function sendFriendReq(id) {
  try { const r = await api(`/friends/${id}`, { method: 'POST' }); toast(r.message || '申请已发送'); } catch (e) { toast(e.message, 'error'); }
}

function switchFriendTab(tab) {
  ['list', 'requests', 'history'].forEach(t => {
    $('ftab-' + t).classList.toggle('active', t === tab);
    $('friends-panel-' + t).classList.toggle('hidden', t !== tab);
  });
  if (tab === 'requests') loadFriendRequests();
  if (tab === 'history') loadFriendHistory();
}

function loadFriends(initial = false) {
  if (!state.token) return;
  api('/friends').then((friends) => {
    renderFriends(friends);
    if (initial) logLine('已加载好友列表');
  }).catch((e) => {
    if (initial) logLine('加载好友失败: ' + e.message);
  });
  api('/friends/requests').then((reqs) => {
    const badge = $('ftab-requests-badge');
    if (badge) {
      if (reqs && reqs.length > 0) { badge.textContent = reqs.length; badge.classList.remove('hidden'); }
      else badge.classList.add('hidden');
    }
  }).catch(() => {});
}

function renderFriends(friends) {
  const list = $('friends-list');
  if (!list) return;
  if (!friends || !friends.length) { list.innerHTML = '<div class="empty-state">暂无好友</div>'; return; }
  list.innerHTML = friends.map((f) => `
    <div class="friend-item">
      <div class="fi-avatar">${escapeHtml(f.username.charAt(0).toUpperCase())}</div>
      <div class="fi-info">
        <div class="fi-name">${escapeHtml(f.username)}${f.title ? ` <span class="user-title theme-${escapeHtml(f.theme||'dark')}">${escapeHtml(f.title)}</span>` : ''}</div>
        <div class="fi-status ${f.online ? 'online' : ''}">${f.online ? '在线' : '离线'}${f.room ? ` · 房间 <span class="copy-link" onclick="copyText('${escapeHtml(f.room.code)}')">${escapeHtml(f.room.code)}</span>` : ''}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="removeFriend(${f.id})">删除</button>
    </div>`).join('');
}

function loadFriendRequests() {
  if (!state.token) return;
  api('/friends/requests').then((reqs) => {
    const list = $('friends-requests-list');
    const badge = $('ftab-requests-badge');
    if (badge) { if (reqs.length) { badge.textContent = reqs.length; badge.classList.remove('hidden'); } else badge.classList.add('hidden'); }
    if (!list) return;
    if (!reqs.length) { list.innerHTML = '<div class="empty-state">暂无待处理申请</div>'; return; }
    list.innerHTML = reqs.map(r => `
      <div class="friend-item">
        <div class="fi-avatar">${escapeHtml(r.username.charAt(0).toUpperCase())}</div>
        <div class="fi-info">
          <div class="fi-name">${escapeHtml(r.username)}${r.title ? ` <span class="user-title theme-${escapeHtml(r.theme||'dark')}">${escapeHtml(r.title)}</span>` : ''}</div>
          <div class="fi-status" style="font-size:.75rem;color:var(--text2)">${new Date(r.requested_at*1000).toLocaleString()}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-primary btn-sm" onclick="acceptFriend(${r.id})">接受</button>
          <button class="btn btn-danger btn-sm" onclick="rejectFriend(${r.id})">拒绝</button>
        </div>
      </div>`).join('');
  }).catch(() => {});
}

function loadFriendHistory() {
  if (!state.token) return;
  api('/friends/history').then((rows) => {
    const list = $('friends-history-list');
    if (!list) return;
    if (!rows.length) { list.innerHTML = '<div class="empty-state">暂无记录</div>'; return; }
    const statusLabel = { pending: '等待确认', rejected: '已被拒绝' };
    list.innerHTML = rows.map(r => `
      <div class="friend-item">
        <div class="fi-avatar">${escapeHtml(r.username.charAt(0).toUpperCase())}</div>
        <div class="fi-info">
          <div class="fi-name">${escapeHtml(r.username)}</div>
          <div class="fi-status">${statusLabel[r.status] || r.status} · ${new Date(r.sent_at*1000).toLocaleDateString()}</div>
        </div>
      </div>`).join('');
  }).catch(() => {});
}

async function acceptFriend(userId) {
  try { await api(`/friends/${userId}/accept`, { method: 'POST' }); toast('已接受好友申请'); loadFriendRequests(); loadFriends(); } catch (e) { toast(e.message, 'error'); }
}
async function rejectFriend(userId) {
  try { await api(`/friends/${userId}/reject`, { method: 'POST' }); toast('已拒绝'); loadFriendRequests(); } catch (e) { toast(e.message, 'error'); }
}
/* 应用内确认弹窗（替代原生 confirm） */
function appConfirm(message, onOk, opts) {
  let dlg = $('app-confirm-modal');
  if (!dlg) {
    dlg = document.createElement('div');
    dlg.id = 'app-confirm-modal';
    dlg.className = 'modal-backdrop hidden';
    dlg.innerHTML = '<div class="modal-card app-confirm-card" style="max-width:340px;padding:20px">' +
      '<div class="app-confirm-icon">⚠️</div>' +
      '<div class="app-confirm-text"></div>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">' +
      '<button class="btn btn-outline btn-sm app-confirm-cancel">取消</button>' +
      '<button class="btn btn-danger btn-sm app-confirm-ok">确定</button>' +
      '</div></div>';
    document.body.appendChild(dlg);
  }
  const textEl = dlg.querySelector('.app-confirm-text');
  if (textEl) textEl.textContent = message;
  const okBtn = dlg.querySelector('.app-confirm-ok');
  const cancelBtn = dlg.querySelector('.app-confirm-cancel');
  if (okBtn && opts && opts.okText) okBtn.textContent = opts.okText;
  openModal('app-confirm-modal');
  const close = () => { closeModal('app-confirm-modal'); };
  const okHandler = () => { close(); onOk && onOk(); };
  okBtn.onclick = okHandler;
  cancelBtn.onclick = close;
  dlg.onclick = (e) => { if (e.target === dlg) close(); };
}

async function removeFriend(userId) {
  appConfirm('确认删除该好友？', async () => {
    /* 乐观删除：先从界面移除，失败再恢复 */
    const list = $('friends-list');
    const prevHtml = list ? list.innerHTML : '';
    if (list) {
      const item = list.querySelector('[data-friend-id="' + userId + '"]');
      if (item) item.remove();
      if (!list.children.length) list.innerHTML = '<div class="empty-state">暂无好友</div>';
    }
    try {
      await api(`/friends/${userId}`, { method: 'DELETE' });
      toast('已删除');
    } catch (e) {
      toast('删除失败：' + e.message + '，已恢复', 'error');
      if (list && prevHtml) list.innerHTML = prevHtml;
    }
  });
}

/* ============ 首页公告（新）============ */
/* 公告渲染：标题第一行，正文往下排 */
function announcementHtml(a) {
  const title = String((a && a.title) || '').trim();
  const content = String((a && a.content) || '').trim();
  return '<div class="announcement-item">' +
    (title ? '<div class="announcement-title">' + escapeHtml(title) + '</div>' : '') +
    (content ? '<div class="announcement-content">' + escapeHtml(content) + '</div>' : '') +
    '</div>';
}

async function loadAnnouncements() {
  if (!state.token) return;
  try {
    const data = await apiChat('/settings/announcement');
    const container = $('home-announcements');
    if (!container) return;
    if (Array.isArray(data) && data.length > 0) {
      container.innerHTML = data.map(announcementHtml).join('');
    } else if (data && (data.content || data.title)) {
      container.innerHTML = announcementHtml(data);
    } else {
      container.innerHTML = '<div class="announcement-item" style="opacity:.7">暂无公告。BLFP 联机助手——与好友畅玩 Minecraft，局域网穿透，零门槛联机。</div>';
    }
  } catch (e) {
    debugLog('首页公告加载失败: ' + e.message);
  }
}

/* ============ 聊天 ============ */
function initChat() {
  // Chat is initialized when the chat page becomes active
  // Clear existing messages
  const messages = $('chat-messages');
  if (messages) messages.innerHTML = '';
  // Scroll to bottom
  if (messages) messages.scrollTop = messages.scrollHeight;
}

let chatReconnectTimer = null;
/* 聊天室独立连接「聊天服务器」的 /ws（与房间信令分离） */
function connectChatSocket() {
  return new Promise((resolve, reject) => {
    const base = state.chatServer || state.server;
    const serverUrl = assertSecureServer(base);
    const wsProtocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = wsProtocol + '//' + serverUrl.host + '/ws?token=' + encodeURIComponent(state.token);
    try { if (state.chatWs) { state.chatWs.onclose = null; state.chatWs.close(); } } catch (e) {}
    const sock = new WebSocket(wsUrl);
    state.chatWs = sock;
    let settled = false;
    /* 握手成功不代表鉴权通过——必须等服务端 ready 帧；
       若 3 秒内没收到（老版本服务端不发 ready），按可用处理 */
    const readyTimer = setTimeout(() => {
      if (!settled && sock.readyState === WebSocket.OPEN) { settled = true; resolve(); }
    }, 3000);
    sock.onopen = () => { /* 等 ready 帧 */ };
    sock.onerror = () => {
      if (settled) return;
      settled = true; clearTimeout(readyTimer);
      reject(new Error('无法连接聊天服务器'));
    };
    sock.onclose = (ev) => {
      state.chatWs = null;
      if (!settled) { settled = true; clearTimeout(readyTimer); reject(new Error('聊天服务器拒绝连接（' + (ev.code || '?') + '）')); }
      if (currentPage === 'chat') {
        if (chatReconnectTimer) clearTimeout(chatReconnectTimer);
        chatReconnectTimer = setTimeout(() => { if (currentPage === 'chat') ensureChatConnection(); }, 3000);
      }
    };
    sock.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        if (!settled) { settled = true; clearTimeout(readyTimer); resolve(); }
        return;
      }
      if (msg.type === 'error') {
        logLine('聊天服务器: ' + (msg.error || '未知错误'));
        if (!settled) { settled = true; clearTimeout(readyTimer); reject(new Error(msg.error || '聊天服务器拒绝连接')); }
        else if (msg.error) toast(msg.error, 'warn');
        return;
      }
      if (msg.type === 'chat') renderChatMessage(msg);
    };
  });
}

function ensureChatConnection() {
  if (!state.token) return;
  if (state.chatWs && state.chatWs.readyState === WebSocket.OPEN) return;
  connectChatSocket().then(() => {
    const messages = $('chat-messages');
    if (messages) {
      messages.innerHTML = '';
      const sys = document.createElement('div');
      sys.className = 'chat-msg system';
      sys.innerHTML = '<div class="chat-msg-text">已连接到聊天室</div>';
      messages.appendChild(sys);
    }
  }).catch((e) => {
    /* 聊天服务器不可用 / 鉴权失败 → 回退主服务器（两者都带聊天能力） */
    if (state.chatServer !== state.server) {
      logLine('聊天服务器连接失败，回退主服务器：' + e.message);
      state.chatServer = state.server;
      return ensureChatConnection();
    }
    const messages = $('chat-messages');
    if (messages) {
      messages.innerHTML = '';
      const sys = document.createElement('div');
      sys.className = 'chat-msg system';
      sys.innerHTML = '<div class="chat-msg-text">连接失败，3 秒后重试...</div>';
      messages.appendChild(sys);
    }
    if (chatReconnectTimer) clearTimeout(chatReconnectTimer);
    chatReconnectTimer = setTimeout(() => { if (currentPage === 'chat') ensureChatConnection(); }, 3000);
  });
}

function sendChatMessage() {
  const input = $('chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const sock = state.chatWs && state.chatWs.readyState === WebSocket.OPEN
    ? state.chatWs
    : (state.ws && state.ws.readyState === WebSocket.OPEN ? state.ws : null);
  if (!sock) {
    toast('未连接到聊天服务器，正在重连…', 'warn');
    ensureChatConnection();
    return;
  }
  const chatPayload = {
    type: 'chat',
    text: text,
    username: state.user ? state.user.username : 'Unknown',
    userId: state.user ? state.user.id : 0,
  };
  try { sock.send(JSON.stringify(chatPayload)); } catch (e) { toast('发送失败：' + e.message, 'error'); return; }
  /* 不再本地立即渲染——服务端会广播回自己的消息，本地渲染会导致显示两条 */
  input.value = '';
}

let chatDedupeMap = new Map();   /* key -> 时间戳，避免同一条广播被两个连接各渲染一次 */
function renderChatMessage(msg) {
  const container = $('chat-messages');
  if (!container) return;
  const key = String(msg.userId || '') + '|' + String(msg.username || '') + '|' + String(msg.text || '') + '|' + String(msg.at || '');
  const now = Date.now();
  const last = chatDedupeMap.get(key);
  if (last && now - last < 5000) return;      /* 5 秒内同一条消息只渲染一次 */
  chatDedupeMap.set(key, now);
  if (chatDedupeMap.size > 200) {
    for (const [k, t] of chatDedupeMap) { if (now - t > 10000) chatDedupeMap.delete(k); }
  }
  const isOwn = msg.local || (state.user && msg.userId === state.user.id);
  const el = document.createElement('div');
  el.className = 'chat-msg' + (isOwn ? ' self' : '') + (msg.system ? ' system' : '');
  const time = new Date().toLocaleTimeString().slice(0, 5);
  if (msg.system) {
    el.innerHTML = '<div class="chat-msg-text">' + escapeHtml(msg.text) + '</div>';
  } else {
    el.innerHTML = '<div class="chat-msg-header"><span class="chat-msg-author">' + escapeHtml(msg.username || '用户') + '</span><span class="chat-msg-time">' + time + '</span></div><div class="chat-msg-text">' + escapeHtml(msg.text) + '</div>';
  }
  container.appendChild(el);
  /* 上限 400 条：长时间挂机不会无限增长 */
  const MAX_CHAT_NODES = 400;
  while (container.childElementCount > MAX_CHAT_NODES) {
    container.removeChild(container.firstElementChild);
  }
  container.scrollTop = container.scrollHeight;
}

/* ============ 初始化 ============ */
/* ====== 后台久了黑屏的自愈：主进程通知时强制重排重绘 ====== */
if (window.mclink && window.mclink.onForceRepaint) {
  window.mclink.onForceRepaint(() => {
    try {
      /* 触发一次强制重排，清除合成层的黑帧 */
      const body = document.body;
      body.style.transform = 'translateZ(0)';
      void body.offsetHeight;
      body.style.transform = '';
      /* 恢复可能被暂停的视觉效果 */
      if (typeof particleEnabled !== 'undefined' && particleEnabled && !particleFrame && typeof drawParticles === 'function') {
        try { drawParticles(); } catch (e) {}
      }
      document.querySelectorAll('.page.active').forEach((p) => { void p.offsetHeight; });
    } catch (e) {}
  });
}

/* ====== 全局兜底：未处理的 Promise 拒绝不再静默失败 ======
   界面上有 15 处 onclick 直接调用 async 函数，任何一处抛错都会变成"点了没反应" */
window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason;
  const msg = (reason && (reason.message || reason.toString())) || '未知错误';
  try { logLine('未处理的错误: ' + msg); } catch (e) {}
  try { toast('操作失败: ' + msg, 'error'); } catch (e) {}
  if (event && event.preventDefault) event.preventDefault();
});
window.addEventListener('error', (event) => {
  const msg = (event && event.message) || '未知脚本错误';
  try { logLine('脚本错误: ' + msg); } catch (e) {}
});

document.addEventListener('DOMContentLoaded', async () => {
  $('auth-page').classList.remove('hidden');
  $('main-app').classList.add('hidden');
  setLoginLoading(false);
  /* 人机验证：先按**当前**地址立刻加载一次（快），服务器探测完再补一次（准）。
     为什么不能只等探测完：探测要挨个试候选地址，慢的话要好几秒，
     验证码就会迟迟不出现。为什么不能只在这里加载一次：此刻 state.server 还是
     硬编码的默认地址，而 resolveServer() 可能把它换成另一个候选地址；
     默认地址不可达时这次必然失败、框就空着，等用户点一次登录、地址被修正后
     才看得到极验 —— 就是"要点一次登录才会出现人机验证"。
     两次都走 refreshCaptchaBox：框里已经有东西时它不会重复渲染。 */
  refreshCaptchaBox('login');
  refreshCaptchaBox('reg');

  const showStartupError = (source, error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(source + '启动失败:', error);
    showAuthErr('启动错误：' + source + '失败：' + message);
  };

  try {
    loadSettings();
  } catch (error) {
    showStartupError('设置加载', error);
  }

  /* 服务器探测改为后台进行：不阻塞首屏渲染与登录交互 */
  Promise.resolve().then(async () => {
    try {
      await resolveServer();
      await resolveChatServer();
    } catch (error) {
      logLine('服务器探测失败: ' + error.message);
    }
    /* 地址定下来之后再加载人机验证：两块都预加载，进到登录页就能看到极验，
       不用先点一次登录。失败会自动重试。 */
    refreshCaptchaBox('login');
    refreshCaptchaBox('reg');
  });

  if (!window.mclink) {
    showStartupError('客户端接口', new Error('预加载接口不可用，请重新启动客户端'));
    return;
  }

  try {
    setupTunnelBridge();
  } catch (error) {
    showStartupError('IPC 初始化', error);
  }

  Promise.resolve()
    .then(() => loadAppInfo())
    .catch((error) => showStartupError('应用信息加载', error));

  const savedToken = localStorage.getItem('mclink_token');
  if (!savedToken) return;

  state.token = savedToken;
  state.server = DEFAULT_SERVER;
  setLoginLoading(true, '正在恢复登录…');
  try {
    state.user = await api('/auth/me');
    enterApp();
  } catch (error) {
    state.token = null;
    state.user = null;
    state.signingKey = null;
    state.signingKeyToken = null;
    localStorage.removeItem('mclink_token');
    $('main-app').classList.add('hidden');
    $('auth-page').classList.remove('hidden');
    showAuthErr('登录状态已失效，请重新登录：' + error.message);
  } finally {
    setLoginLoading(false);
  }
});


// ====== 鼠标光晕跟随 ======
(function initMouseGlow() {
  // 性能修复：rAF 节流 + 按钮缓存 + 近距离过滤
  // 旧版每次 mousemove 都 querySelectorAll + getBoundingClientRect（强制同步布局）导致鼠标卡顿
  let mx = -1, my = -1, pending = false;
  let btnCache = [];
  let btnCacheTime = 0;
  const BTN_CACHE_TTL = 2000;   /* 按钮列表缓存 2 秒 */
  const NEAR_DIST = 260;       /* 只更新鼠标 260px 内的按钮 */

  document.addEventListener('mousemove', (e) => {
    mx = e.clientX; my = e.clientY;
    if (!pending) {
      pending = true;
      requestAnimationFrame(flushGlow);
    }
  }, { passive: true });

  function flushGlow() {
    pending = false;
    if (document.hidden || mx < 0) return;
    const now = performance.now();
    /* body 光晕 */
    document.body.style.setProperty('--mouse-x', mx + 'px');
    document.body.style.setProperty('--mouse-y', my + 'px');
    /* 按钮列表缓存 */
    if (now - btnCacheTime > BTN_CACHE_TTL) {
      btnCache = Array.from(document.querySelectorAll('.btn-glow, .btn-primary, .btn-success, .btn-danger, .btn-outline'));
      btnCacheTime = now;
    }
    /* 只更新鼠标附近的按钮，跳过远处 */
    for (const btn of btnCache) {
      const r = btn.getBoundingClientRect();
      if (mx < r.left - NEAR_DIST || mx > r.right + NEAR_DIST ||
          my < r.top - NEAR_DIST || my > r.bottom + NEAR_DIST) continue;
      const x = ((mx - r.left) / Math.max(1, r.width)) * 100;
      const y = ((my - r.top) / Math.max(1, r.height)) * 100;
      btn.style.setProperty('--mouse-x', x + '%');
      btn.style.setProperty('--mouse-y', y + '%');
    }
  }
})();

// ====== 登录页 ======
/* 旧的 initAuth 死代码已删除（引用了不存在的 #auth-wrap 和未定义的 showToast，登录逻辑由 submitLogin 处理） */




/* 按时段给一句短问候。以前这里拼了"今天是X月X日 星期X，祝你游玩愉快"，
   信息量为零还占一整行 —— 主页那一行应该留给"现在能不能玩"。 */
function greetingText() {
  const h = new Date().getHours();
  if (h >= 5 && h < 9) return '早上好';
  if (h >= 9 && h < 12) return '上午好';
  if (h >= 12 && h < 14) return '中午好';
  if (h >= 14 && h < 18) return '下午好';
  if (h >= 18 && h < 23) return '晚上好';
  return '夜深了';
}
/* 每分钟重画一次主页：跨时段问候语自动切换，房间人数也保持新鲜。
   只在主页可见时做，别在后台白跑。 */
setInterval(() => { if (currentPage === 'home') renderHomeStatus(); }, 60000);

/* ====== 设置页「实时日志(PowerShell)」按钮 ====== */
async function toggleLiveLog() {
  /* 优先应用内日志（一定可用），并尝试同时呼出 PowerShell */
  openLogViewer();
  try {
    const res = await window.mclink.openLogExternal();
    if (res && res.ok === false) notify('PowerShell 不可用（' + (res.error || '未知') + '），已使用应用内日志', 'warn');
  } catch (e) {
    notify('PowerShell 不可用，已使用应用内日志', 'warn');
  }
}


/* ====== 按钮点击水波纹定位（CSS 的 .btn::after 使用 --ripple-x/y）====== */
document.addEventListener('mousedown', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('.btn');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  btn.style.setProperty('--ripple-x', (((e.clientX - rect.left) / rect.width) * 100).toFixed(1) + '%');
  btn.style.setProperty('--ripple-y', (((e.clientY - rect.top) / rect.height) * 100).toFixed(1) + '%');
}, true);

/* ====== 一键导出诊断信息（对比不同机器差异）====== */
async function exportDiagnostics() {
  notify('正在收集诊断信息...');
  try {
    if (!window.mclink || !window.mclink.collectDiagnostics) {
      notify('当前版本不支持导出诊断信息', 'error');
      return;
    }
    const text = await window.mclink.collectDiagnostics();
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch (e) {}
    showModal('diag-modal',
      '<h3>诊断信息' + (copied ? ' 已复制到剪贴板' : '') + '</h3>' +
      '<p style="font-size:.78rem;color:var(--text2);margin-bottom:10px">把下面内容整段发给开发者，即可定位这台机器与正常机器的差异。</p>' +
      '<pre class="diag-pre">' + escapeHtml(text) + '</pre>' +
      '<div class="modal-actions">' +
      '<button class="btn btn-outline btn-sm" onclick="closeModal(\'diag-modal\')">关闭</button>' +
      '<button class="btn btn-primary btn-sm" onclick="copyText(document.querySelector(\'.diag-pre\').textContent)">复制</button>' +
      '</div>');
    notify(copied ? '诊断信息已复制到剪贴板' : '诊断信息已生成', 'success');
  } catch (e) {
    notify('收集诊断信息失败: ' + e.message, 'error');
  }
}

/* ====== 统一状态消息：所有状态/进度/错误都走这里（提示条 + 运行日志）====== */
function notify(message, type = 'info') {
  const msg = String(message == null ? '' : message);
  if (!msg) return;
  try { logLine(msg); } catch (e) {}
  try { toast(msg, type); } catch (e) {}
}

/* ====== 复制到剪贴板（房间号/用户ID/日志等按钮调用）====== */
async function copyText(text) {
  const value = String(text ?? '').trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast('已复制：' + value, 'success');
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制：' + value, 'success');
    } catch (e2) {
      toast('复制失败，请手动选择复制', 'error');
    }
  }
}

/* ====== PowerShell 呼出日志 ====== */
async function openLogInPowerShell() {
  try {
    if (!window.mclink || !window.mclink.openLogExternal) {
      notify('当前版本不支持直接呼出 PowerShell，已改为应用内查看', 'warn');
      return openLogViewer();
    }
    const res = await window.mclink.openLogExternal();
    if (res && res.ok === false) {
      /* PowerShell 被组策略/AppLocker 禁用，或启动失败 → 自动降级 */
      notify('无法启动 PowerShell（' + (res.error || '未知原因') + '），已为你打开应用内日志', 'warn');
      openLogViewer();
      await openLogFolder();
      return;
    }
    toast('已打开 PowerShell 日志窗口；若没看到窗口，可用「查看日志」', 'success');
  } catch (e) {
    notify('打开日志失败：' + e.message + '，已改为应用内查看', 'error');
    openLogViewer();
  }
}


/* ====== 房间详情（点房间卡片显示详情弹窗） ====== */
async function showRoomDetail(code) {
  let fallbackUsed = false;
  let room;
  try {
    room = await api('/rooms/public/' + code + '/detail');
  } catch (e) {
    /* 服务器还没有详情接口（旧版本返回 404）时，用房间列表里已有的数据展示 */
    const cached = (state.publicRooms || []).find((r) => String(r.room_code ?? r.code ?? '') === String(code));
    if (!cached) {
      toast('获取房间详情失败: ' + e.message, 'error');
      return;
    }
    fallbackUsed = true;
    room = {
      room_code: code,
      host: cached.host,
      mode: cached.mode,
      total: cached.total,
      max_members: cached.max_members,
      members: [],
      latency: null,
      description: cached.description || '',
      mc_version: cached.mc_version || '',
      has_password: cached.has_password === true,
      frp_host: cached.frp_host || null,
      frp_port: cached.frp_port || null,
    };
  }
  try {
    const statsHtml = `
      <div class="room-detail-stat">
        <div class="stat-value ${room.latency < 80 ? 'latency-good' : room.latency < 200 ? 'latency-mid' : 'latency-bad'}">${room.latency ?? '--'} ms</div>
        <div class="stat-label">节点延迟</div>
      </div>
      <div class="room-detail-stat">
        <div class="stat-value">${room.members?.length ?? 0}/${room.max_members ?? 8}</div>
        <div class="stat-label">在线人数</div>
      </div>`;
    const membersHtml = (room.members || []).map((m) => `
      <div class="room-detail-member">
        <span class="fi-avatar" style="width:20px;height:20px;font-size:.6rem">${escapeHtml((m.username || '?')[0].toUpperCase())}</span>
        <span>${escapeHtml(m.username || '未知')}</span>
        ${m.title ? '<span class="user-title">' + escapeHtml(m.title) + '</span>' : ''}
      </div>`).join('');
    /* MC 版本也进 stats 区：房客最先要确认的就是"我用哪个版本能进" */
    const versionHtml = room.mc_version
      ? `<div class="room-detail-stat"><div class="stat-value">${escapeHtml(room.mc_version)}</div><div class="stat-label">MC 版本</div></div>`
      : '';
    /* 房主自定义简介取代了原来的 MOTD：房客要判断的是"这房间是什么类型" */
    const descHtml = room.description
      ? `<div style="margin-top:10px"><div style="font-size:.78rem;color:var(--text3);margin-bottom:6px">房间简介</div><div class="room-detail-desc">${escapeHtml(room.description)}</div></div>`
      : '';
    const isFrp = room.mode === 'frp';
    const address = room.frp_host && room.frp_port ? room.frp_host + ':' + room.frp_port : '';
    const addrHtml = isFrp
      ? `<div style="margin-top:10px"><div style="font-size:.78rem;color:var(--text3);margin-bottom:6px">直连地址，在 Minecraft 里直接连接</div><div class="room-detail-addr">${address ? escapeHtml(address) : (room.has_password ? '需要密码，点下方按钮获取' : '房主正在建立隧道…')}</div></div>`
      : '';
    /* FRP 访客不用进房间，复制地址即可；EasyTier 仍然要走加入流程拿虚拟网地址 */
    const actionBtn = isFrp
      ? `<button class="btn btn-primary btn-sm" onclick="closeModal('room-detail-modal');copyRoomAddress('${code}')">${address ? '复制地址' : '输密码取地址'}</button>`
      : `<button class="btn btn-primary btn-sm" onclick="closeModal('room-detail-modal');quickJoinRoom('${code}')">加入房间</button>`;
    showModal('room-detail-modal', `<h3>房间 ${escapeHtml(code)} 详情</h3>` + (fallbackUsed ? '<div style="font-size:.75rem;color:var(--warn);margin-bottom:8px">服务器未提供详情接口，以下为房间列表数据。更新服务器后可显示成员与延迟</div>' : '') + `<div class="room-detail-grid">` + statsHtml + versionHtml + `</div>` + descHtml + addrHtml + `<div style="font-size:.78rem;color:var(--text3);margin:10px 0 6px">在线成员</div><div class="room-detail-members">` + membersHtml + `</div><div class="modal-actions"><button class="btn btn-outline btn-sm" onclick="closeModal('room-detail-modal')">关闭</button>` + actionBtn + `</div>`);
  } catch (e) {
    toast('获取房间详情失败: ' + e.message, 'error');
  }
}


/* ====== 人机验证（服务端签发、服务端校验；支持极验 GeeTest v4 与内置图形码）======
   两种提供方由服务端决定（GET /auth/captcha 返回 provider）：
     - geetest：加载极验 SDK 渲染 widget，成功后拿到 4 个字段随请求提交
     - builtin：服务端签发图形码，答案只在服务端
   关键设计：极验 SDK 加载失败（CSP 拦截 / 网络不通 / file:// 限制）时
   **自动退回服务端随附的内置图形码**，绝不把用户卡在登录门外。 */
const captchaSlots = {
  login: { mode: 'none', token: '', image: '', answer: '', validate: null, disabled: false, unavailable: false, geetest: null, loading: false },
  reg:   { mode: 'none', token: '', image: '', validate: null, disabled: false, unavailable: false, geetest: null, loading: false },
};

function captchaBoxId(slot) { return slot === 'reg' ? 'reg-captcha-box' : 'login-captcha-box'; }
/* 收起动画的定时器句柄（按槽位存，便于重置时取消） */
const captchaDoneTimers = {};

/* 把某个槽位彻底恢复到"没加载过"的初始状态。
   退出登录 / 切换账号时必须调用——否则上一轮验证过的 validate 还留着，
   再登录会被 ensureCaptcha 当成"已通过"直接放行，等于验证码失效。 */
function resetCaptchaState(slot) {
  const st = captchaSlots[slot];
  if (!st) return;
  if (st.geetest && typeof st.geetest.reset === 'function') { try { st.geetest.reset(); } catch (_) {} }
  st.mode = 'none';
  st.token = '';
  st.answer = '';
  st.fallback = null;
  st.validate = null;
  st.geetest = null;
  st.challenge = '';
  st.offline = false;
  st.disabled = false;
  st.unavailable = false;
  st.loading = false;
  const box = $(captchaBoxId(slot));
  if (box) {
    /* 清掉动画留下的一切痕迹，否则下次复用还停在 height:0 / display:none */
    box.innerHTML = '';
    box.classList.remove('captcha-done');
    box.classList.remove('captcha-playing');
    box.style.height = '';
    box.style.overflow = '';
    box.style.opacity = '';
    box.style.marginBottom = '';
    box.style.transition = '';
    box.style.position = '';
  }
  if (captchaDoneTimers[slot]) { clearTimeout(captchaDoneTimers[slot]); captchaDoneTimers[slot] = null; }
  /* 还原被收起动画藏掉的 label */
  const labelReset = captchaLabelEl(box);
  if (labelReset) { labelReset.style.display = ''; labelReset.style.opacity = ''; labelReset.style.transition = ''; labelReset.style.overflow = ''; }
  const input = $(captchaInputId(slot));
  if (input) input.value = '';
}

/* 验证成功后的反馈：绿色对勾淡入，然后整块平滑收回（表单上移）。
   极验的 widget 是 iframe，直接压高度会生硬，所以先让 widget 淡出再收容器。
   总时长约 0.5 秒。 */
/*
 * 把 playCaptchaDone 造成的"已收起"状态**彻底复原**。
 *
 * 为什么必须有这个：playCaptchaDone 在验证通过后会给容器加 .captcha-done
 * （CSS 里是 display:none）并把前面的 <label> 也 display:none 掉。
 * 而重新渲染验证码时没人把这些清掉 —— 于是"验证过一次之后"，
 * 极验再怎么重新渲染都画在一个 display:none 的容器里，用户看到的就是**什么都没有**。
 * 这正是"登录一次后人机验证会失效、失败后啥都不出现"的根因。
 *
 * 所以任何一次重新渲染之前，都必须先调它。
 */
function resetCaptchaBoxVisual(slot) {
  const box = $(captchaBoxId(slot));
  if (!box) return null;
  if (captchaDoneTimers[slot]) { clearTimeout(captchaDoneTimers[slot]); captchaDoneTimers[slot] = null; }
  box.classList.remove('captcha-done', 'captcha-playing');
  /* 用与收起时同一份清单来清，两边不会漂移 */
  clearCaptchaCollapseStyles(box);
  /* 顺手清掉上一次残留的节点（含极验那个 iframe）。
     收起动画里**不做**这件事 —— 那会在动画末尾造成顿挫，见 playCaptchaDone 的注释。
     所有渲染入口都会先调本函数，所以这里是清理的唯一位置。 */
  box.innerHTML = '';
  const labelEl = captchaLabelEl(box);
  if (labelEl) {
    labelEl.style.display = '';
    clearCaptchaCollapseStyles(labelEl);
  }
  return box;
}

/* 验证通过后"收起"的时间线，分两段（用户反馈过慢、且"中间会卡一下"）：
 *
 *   第一段 CAPTCHA_FADE_MS：只动 opacity，让验证码**淡出**。
 *       这一段绝对不能碰高度 —— 极验控件是 iframe，盒子高度一变，
 *       iframe 每帧都要重新布局+重绘，掉帧就是用户说的"中间卡一下"。
 *   第二段 CAPTCHA_COLLAPSE_MS：此时内容已经淡到看不见，先把它 display:none
 *       移出布局，再收盒子的高度。高度动画从此只作用在一个**空盒子**上，
 *       iframe 不再参与每帧重排 —— 这才是平滑的收起。
 *
 * 两段首尾相接，中间没有静止等待（原来有 150ms 什么都不动的空档，那也是"卡一下"）。
 * 总时长 = 100 + 200 = 300ms。 */
const CAPTCHA_FADE_MS = 100;
const CAPTCHA_COLLAPSE_MS = 200;
/* 过渡必须把**所有影响高度的属性**都列上，不能只写 height。
   原因见下面第二段的注释：border-box 下 height 收不到 padding+border 以下，
   而这几个属性如果瞬时归零就是一次跳变，必须一起过渡才是平滑的。 */
const CAPTCHA_COLLAPSE_TRANSITION = [
  'height', 'padding-top', 'padding-bottom', 'border-top-width', 'border-bottom-width',
].map((prop) => prop + ' ' + CAPTCHA_COLLAPSE_MS + 'ms cubic-bezier(.4, 0, .2, 1)').join(', ');

/* 收起动画写进去的 inline 样式清单。设与清共用同一份，
   避免"设了却没清干净"，那样验证码下次回来会是压扁的状态。 */
const CAPTCHA_COLLAPSE_KEYS = [
  'height', 'minHeight', 'paddingTop', 'paddingBottom',
  'borderTopWidth', 'borderBottomWidth', 'marginBottom', 'overflow', 'transition',
];

function clearCaptchaCollapseStyles(el) {
  if (!el) return;
  CAPTCHA_COLLAPSE_KEYS.forEach((key) => { el.style[key] = ''; });
}
const CAPTCHA_FADE_TRANSITION = 'opacity ' + CAPTCHA_FADE_MS + 'ms ease-out';

function playCaptchaDone(slot) {
  const box = $(captchaBoxId(slot));
  /* 防重复触发：用 classList 而不是 dataset，兼容性更好 */
  if (!box || box.classList.contains('captcha-playing')) return;
  box.classList.add('captcha-playing');
  if (captchaDoneTimers[slot]) clearTimeout(captchaDoneTimers[slot]);

  /* 高度必须在**改任何样式之前**量。改完再读 offsetHeight 会强制一次同步重排，
     动画起手就会顿一下 —— 这也是"卡一下"的一个来源。 */
  const startHeight = box.offsetHeight;
  const labelEl = captchaLabelEl(box);
  /* 所有子节点整体淡出（含极验那个 iframe）。
     统一处理，不再逐个 querySelector 改样式，减少起手时的样式写入。 */
  const content = Array.prototype.slice.call(box.children);

  /* 第一段：只动 opacity。这一阶段**不动布局**，所以 iframe 不会被反复重排。 */
  content.forEach((el) => { el.style.transition = CAPTCHA_FADE_TRANSITION; el.style.opacity = '0'; });
  if (labelEl) {
    /* label 跟着淡出，避免"验证完了还剩个人机验证的字" */
    labelEl.style.transition = CAPTCHA_FADE_TRANSITION;
    labelEl.style.overflow = 'hidden';
    labelEl.style.opacity = '0';
  }

  /* 用户要求：验证通过后**不要**再出现"✓ 验证通过"那个小方块，
     不要任何中间产物，直接平滑收回；通过与否改用一条通知告知。 */
  toast('人机验证通过', 'success');

  /* 第二段：内容已经看不见了，先移出布局，再收空盒子的高度。 */
  captchaDoneTimers[slot] = setTimeout(() => {
    content.forEach((el) => { el.style.display = 'none'; });

    /* 这里是"还收会卡"的真正原因，务必看清楚：
       .captcha-box 上有 min-height:44px、padding:6px 8px，且全局是 box-sizing:border-box。
       只把 height 改成 0 是**收不动的** ——
         · min-height 会把它夹在 44px，height 从 44 变到 0 实际渲染高度始终是 44；
         · 就算没有 min-height，border-box 下高度也降不到 padding+border 以下。
       结果是高度过渡从头到尾没有任何视觉变化，等到最后 captcha-done（display:none）
       才"啪"地一下消失 —— 用户看到的就是"不收、最后卡一下、下面整块突然跳上来"。
       所以必须把 min-height、上下 padding、上下边框一起归零，并且一起过渡。 */
    box.style.height = startHeight + 'px';
    box.style.minHeight = '0';        /* 瞬时归零不会跳：此刻 height 已钉在 44px */
    box.style.overflow = 'hidden';

    /* label 也是同一回事：它是 display:block 且有 margin-bottom:6px，
       只淡出、到最后一 display:none，同样是"啪"地跳一行。这里一并压高度。 */
    if (labelEl) {
      labelEl.style.height = labelEl.offsetHeight + 'px';
      labelEl.style.overflow = 'hidden';
    }

    /* 先钉住起始高度，下一帧再改成 0，过渡才有起点 */
    requestAnimationFrame(() => {
      box.style.transition = CAPTCHA_COLLAPSE_TRANSITION;
      box.style.height = '0px';
      box.style.paddingTop = '0px';
      box.style.paddingBottom = '0px';
      box.style.borderTopWidth = '0px';
      box.style.borderBottomWidth = '0px';
      if (labelEl) {
        labelEl.style.transition = CAPTCHA_COLLAPSE_TRANSITION;
        labelEl.style.height = '0px';
        labelEl.style.marginBottom = '0px';
      }
    });

    setTimeout(() => {
      /* 此时高度已经是 0，display:none 不再产生任何跳动 */
      box.classList.add('captcha-done');
      if (labelEl) labelEl.style.display = 'none';
      clearCaptchaCollapseStyles(box);
      clearCaptchaCollapseStyles(labelEl);
      /* 这里**故意不写 box.innerHTML = ''**。
         极验控件是个 iframe，删掉它要让浏览器拆掉整个渲染上下文/子进程，
         是主线程上的重活 —— 动画本身很顺，偏偏在收尾这一下顿住。
         用户报的就是"最后还是会卡顿一下（顿挫）"。
         残留的节点留在已经 display:none、高度为 0 的盒子里完全看不见、也不占布局，
         等下次真正要渲染验证码时由 resetCaptchaBoxVisual 一并清掉 ——
         那时本来就在加载新控件，顿一下不会被察觉。 */
      box.classList.remove('captcha-playing');
    }, CAPTCHA_COLLAPSE_MS + 40);
  }, CAPTCHA_FADE_MS);
}

/* 找验证码容器前面那个同级的 <label>（"人机验证"那几个字）。
   收起动画只压容器的身高，label 不在容器里，不一起处理就会留在原地。 */
function captchaLabelEl(box) {
  if (!box || !box.parentElement) return null;
  const kids = box.parentElement.children || [];
  let found = null;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i] === box) break;                       // 只往前找，取最近的那个
    if (kids[i].tagName === 'LABEL') found = kids[i];
  }
  return found;
}

function captchaInputId(slot) { return slot === 'reg' ? 'reg-captcha-input' : 'login-captcha-input'; }

/* 渲染内置图形码（服务端签发的 SVG 图片 + 输入框） */
function renderBuiltinCaptcha(slot, token, image) {
  resetCaptchaBoxVisual(slot);
  const box = $(captchaBoxId(slot));
  if (!box) return;
  box.innerHTML =
    '<div class="captcha-row">' +
      '<img class="captcha-img" alt="验证码" src="' + image + '" title="点击换一张">' +
      '<input class="captcha-input" id="' + captchaInputId(slot) + '" maxlength="4" placeholder="验证码" autocomplete="off" spellcheck="false">' +
    '</div>';
  const img = box.querySelector('.captcha-img');
  if (img) img.onclick = () => loadCaptcha(slot, true);
  const input = box.querySelector('.captcha-input');
  if (input && input.addEventListener) {
    input.addEventListener('input', () => {
      /* 边输边存：收起动画结束后容器会被清空，输入框随之消失，
         届时再去 DOM 里读答案只会拿到空串 —— 提交必然被判"验证没过"。
         所以必须在这里把答案留一份在状态里。 */
      captchaSlots[slot].answer = input.value.trim();
      if (input.value.trim().length >= 4) playCaptchaDone(slot);
      else { const b = $(captchaBoxId(slot)); if (b) b.classList.remove('captcha-done'); }
    });
  }
  captchaSlots[slot].token = token || '';
  captchaSlots[slot].image = image || '';
  captchaSlots[slot].validate = null;
  captchaSlots[slot].mode = 'builtin';
  captchaSlots[slot].geetest = null;
}

/* 动态加载极验 v4 SDK（只加载一次），带超时，失败即抛错以便回退 */
function loadGeetestSdk() {
  if (window.initGeetest4) return Promise.resolve();
  if (loadGeetestSdk._p) return loadGeetestSdk._p;
  loadGeetestSdk._p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://static.geetest.com/v4/gt4.js';
    s.async = true;
    const timer = setTimeout(() => reject(new Error('极验 SDK 加载超时')), 8000);
    s.onload = () => { clearTimeout(timer); window.initGeetest4 ? resolve() : reject(new Error('极验 SDK 未初始化')); };
    s.onerror = () => { clearTimeout(timer); reject(new Error('极验 SDK 加载失败，可能被 CSP 或网络拦截')); };
    document.head.appendChild(s);
  }).catch((e) => { loadGeetestSdk._p = null; throw e; });
  return loadGeetestSdk._p;
}

/* 渲染极验 widget */
/* ---------- 极验 3.0 ----------
   与 4.0 完全不同的产品：脚本是 static/tools/gt.js，初始化函数是 initGeetest
   （注意没有 4），参数是 {gt, challenge, offline, new_captcha}。
   challenge 由**服务端**向极验申请（见 /api/auth/captcha），
   验证通过后 getValidate() 返回 geetest_challenge / geetest_validate / geetest_seccode。 */
function loadGeetest3Sdk() {
  if (window.initGeetest) return Promise.resolve();
  if (loadGeetest3Sdk._p) return loadGeetest3Sdk._p;
  loadGeetest3Sdk._p = new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://static.geetest.com/static/tools/gt.js';
    sc.async = true;
    const timer = setTimeout(() => reject(new Error('极验 SDK 加载超时')), 8000);
    sc.onload = () => { clearTimeout(timer); window.initGeetest ? resolve() : reject(new Error('极验 3.0 SDK 未初始化')); };
    sc.onerror = () => { clearTimeout(timer); reject(new Error('极验 SDK 加载失败')); };
    document.head.appendChild(sc);
  }).catch((e) => { loadGeetest3Sdk._p = null; throw e; });
  return loadGeetest3Sdk._p;
}

/* 极验挂了（最常见就是它自己的"网络不给力"）时切到内置图形码。
   用的是签到 /auth/captcha 时一并下发的 fallback_token/fallback_image，
   不需要再请求一次，切换是瞬时的。 */
function switchToBuiltinCaptcha(slot) {
  const st = captchaSlots[slot];
  if (!st) return false;
  if (!st.fallback || !st.fallback.token || !st.fallback.image) return false;
  if (captchaDoneTimers[slot]) { clearTimeout(captchaDoneTimers[slot]); captchaDoneTimers[slot] = null; }
  st.geetest = null;
  st.validate = null;
  st.answer = '';
  logLine('极验不可用，已改用图片验证码');
  renderBuiltinCaptcha(slot, st.fallback.token, st.fallback.image);
  return true;
}

/* 极验模式下的"刷新验证码"入口。
   注意：它刷新的是**极验**（重新向自家服务端签发 challenge 再渲染），不是换成别的验证方式 ——
   极验的报错画在它自己的 iframe 里，跨域读不到文字，onError 也不保证触发，
   所以除了自动处理之外，还得给用户一个能主动重来的按钮。 */
function renderCaptchaRefreshLink(slot) {
  const box = $(captchaBoxId(slot));
  if (!box || box.querySelector('.captcha-switch')) return;
  const wrap = document.createElement('div');
  wrap.className = 'captcha-switch';
  const a = document.createElement('a');
  a.textContent = '刷新验证码';
  a.onclick = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    /* resetCaptcha 会给极验重新签发一个 challenge 并重新渲染 */
    resetCaptcha(slot);
  };
  wrap.appendChild(a);
  box.appendChild(wrap);
}

function renderGeetest3(slot, opts) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let onGlobalError = null;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onGlobalError && window.removeEventListener) window.removeEventListener('error', onGlobalError);
      fn(arg);
    };
    /* 必须带超时：3.0 的 gt.js 在接口异常时也可能不回调，否则页面会永久卡在加载中 */
    timer = setTimeout(() => done(reject, new Error('极验初始化超时')), 8000);
    onGlobalError = (ev) => {
      const msg = String((ev && (ev.message || (ev.error && ev.error.message))) || '');
      if (/网络错误|Network error/i.test(msg)) done(reject, new Error('极验接口返回错误'));
    };
    if (window.addEventListener) window.addEventListener('error', onGlobalError);
    try {
      window.initGeetest({
        gt: opts.gt,
        challenge: opts.challenge,
        offline: Boolean(opts.offline),
        new_captcha: true,
        /* 必须显式声明 https：gt.js 的协议是从 window.location.protocol 推出来的
           （见其内部：config.protocol = window.location.protocol + "//"）。
           Electron 页面是 file://，于是它去加载 file://static.geetest.com/... 必然失败，
           widget 永远出不来 —— 这正是"客户端没有极验、网页却正常"的原因。
           传 https:true 后强制走 https://，与网页端行为一致。 */
        https: true,
        /* 3.0 的产品形式只有 float / popup（官方 demo 用的就是这两个）。
           'bind' 是 4.0 才有的概念，传给 3.0 会导致 widget 渲染异常。 */
        product: 'float',
        lang: 'zh-cn',
        width: '100%',
      }, (captcha) => {
        if (!captcha || typeof captcha.appendTo !== 'function') {
          done(reject, new Error('极验 widget 无法挂载'));
          return;
        }
        const box = resetCaptchaBoxVisual(slot);
        if (!box) { done(reject, new Error('验证码容器不存在')); return; }
        /* 清空已由 resetCaptchaBoxVisual 负责，这里不再重复写一次 */

        const st = captchaSlots[slot];
        st.geetest = captcha;
        st.mode = 'geetest3';
        st.offline = Boolean(opts.offline);
        st.challenge = opts.challenge || '';
        st.validate = null;
        /* 签到接口已经把内置图形码一并下发了，先存着，极验一挂就能立刻切过去 */
        if (opts.fallbackToken && opts.fallbackImage) {
          st.fallback = { token: opts.fallbackToken, image: opts.fallbackImage };
        }
        try { captcha.appendTo(box); } catch (e) { done(reject, e); return; }
        renderCaptchaRefreshLink(slot);
        captcha.onSuccess(() => {
          try { st.validate = captcha.getValidate() || null; } catch (_) { st.validate = null; }
          if (st.validate) playCaptchaDone(slot);
        });
        captcha.onError((err) => {
          st.validate = null;
          /* 不在这里切成内置图形码：用户要的是极验可用，不是被替换。
             刷新入口一直挂在下面，点一下就会用新的 challenge 重新渲染极验。 */
          logLine('极验回调报错：' + ((err && (err.error_code || err.msg)) || '未知') + '，可点"刷新验证码"重试');
        });
        done(resolve);
      });
    } catch (e) {
      done(reject, e);
    }
  });
}

function renderGeetest(slot, captchaId) {
  return new Promise((resolve, reject) => {
    /* 必须带超时：initGeetest4 的回调在多种情况下不会触发
       （captcha_id 失效、域名未在极验后台登记、到极验的网络不通……），
       回调不触发时原实现会永远挂起，界面一直停在"正在加载人机验证…"，
       用户既看不到验证码也无法登录。超时后由上层回退到内置图形码。 */
    let settled = false;
    let timer = null;
    let onGlobalError = null;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onGlobalError && window.removeEventListener) window.removeEventListener('error', onGlobalError);
      fn(arg);
    };
    timer = setTimeout(() => done(reject, new Error('极验初始化超时')), 8000);
    /* gt4.js 在极验接口返回错误状态时是"异步 throw"（throwError: 网络错误），
       既不走 initGeetest4 的回调，也不在下面 try/catch 的调用栈里，
       只能靠全局 error 事件捕获并立刻转成 reject，避免用户白等满 8 秒超时。 */
    onGlobalError = (ev) => {
      const msg = String((ev && (ev.message || (ev.error && ev.error.message))) || '');
      if (/网络错误|Network error/i.test(msg)) done(reject, new Error('极验接口返回错误'));
    };
    if (window.addEventListener) window.addEventListener('error', onGlobalError);
    try {
      window.initGeetest4({ captchaId: captchaId, product: 'bind', language: 'zho' }, (captcha) => {
        const box = $(captchaBoxId(slot));
        if (!box || !captcha || typeof captcha.appendTo !== 'function') {
          done(reject, new Error('极验 widget 无法挂载'));
          return;
        }
        if (typeof captcha.onError === 'function') {
          captcha.onError(() => {
            if (settled) { loadCaptcha(slot, true); }
            else { done(reject, new Error('极验初始化失败')); }
          });
        }
        try {
          captcha.appendTo(box);
        } catch (e) {
          done(reject, e);
          return;
        }
        if (typeof captcha.onSuccess === 'function') {
          captcha.onSuccess(() => {
            const v = typeof captcha.getValidate === 'function' ? captcha.getValidate() : null;
            captchaSlots[slot].validate = v || null;
            if (v) playCaptchaDone(slot);
          });
        }
        captchaSlots[slot].geetest = captcha;
        captchaSlots[slot].mode = 'geetest';
        done(resolve);
      });
    } catch (e) {
      done(reject, e);
    }
  });
}

/* 取验证码。provider 由服务端决定；极验失败自动退回内置图形码 */
async function loadCaptcha(slot, force) {
  const st = captchaSlots[slot];
  if (!st || st.loading) return;
  const box = $(captchaBoxId(slot));
  /* 加载期间不显示任何占位文字；真出不来时由超时兜底切回内置图形码 */
  if (box && force) box.innerHTML = '';
  st.loading = true;
  try {
    const data = await api('/auth/captcha');
    if (!data || data.enabled === false || !data.provider || data.provider === 'off') {
      /* 服务端关闭了人机验证：隐藏整块，提交时不带字段 */
      if (box) box.innerHTML = '';
      st.mode = 'none';
      st.disabled = true;
      st.unavailable = false;
      return;
    }
    st.disabled = false;
    if (data.provider === 'geetest3' && data.gt && data.challenge) {
      try {
        await loadGeetest3Sdk();
        await renderGeetest3(slot, { gt: data.gt, challenge: data.challenge, offline: data.offline, fallbackToken: data.fallback_token, fallbackImage: data.fallback_image });
        return;
      } catch (e) {
        logLine('人机验证：' + e.message + '，已回退内置图形码');
        if (data.fallback_token && data.fallback_image) {
          renderBuiltinCaptcha(slot, data.fallback_token, data.fallback_image);
          return;
        }
        throw e;
      }
    }
    if (data.provider === 'geetest' && data.captcha_id) {
      try {
        await loadGeetestSdk();
        await renderGeetest(slot, data.captcha_id);
        return;
      } catch (e) {
        /* 极验不可用：退回服务端随附的内置图形码，用户照样能登录 */
        logLine('人机验证：' + e.message + '，已回退内置图形码');
        if (data.fallback_token && data.fallback_image) {
          renderBuiltinCaptcha(slot, data.fallback_token, data.fallback_image);
          return;
        }
        throw e;
      }
    }
    if (!data.token || !data.image) throw new Error('服务端未返回验证码');
    renderBuiltinCaptcha(slot, data.token, data.image);
  } catch (e) {
    /* 老服务端没有 /auth/captcha（404）：标记为不可用，放行提交，
       避免新客户端在旧服务端上完全无法登录（服务端才是权威判定方） */
    const notFound = e && (e.status === 404 || e.status === 501);
    if (box) box.innerHTML = '';
    st.mode = 'none';
    st.unavailable = true;
    if (!notFound) logLine('人机验证加载失败：' + (e.message || e));
  } finally {
    captchaSlots[slot].loading = false;
  }
}

/*
 * 保证验证码框里**确实有东西**：空了就（重新）加载，失败还会退避重试。
 *
 * 为什么需要它：
 *   - 启动时如果请求失败（地址还没探测好），验证码框会一直空着，
 *     用户必须先点一次登录才看得到极验；
 *   - 退出登录后 resetCaptchaState() 会把盒子清空，回到登录页同样是空的。
 * 这两种情况都靠这里补上，做到"进到界面就能看到人机验证"。
 */
function refreshCaptchaBox(slot, attempt) {
  const st = captchaSlots[slot];
  const box = $(captchaBoxId(slot));
  if (!st || !box) return Promise.resolve();
  const n = attempt || 0;
  /* 已经有内容就别重渲染：否则会把用户已经填好/已通过验证的验证码清掉。
     但 captcha-done 的盒子要当成空的 —— 它虽然还留着上一次的节点
     （收起时故意不销毁，见 playCaptchaDone），可已经是"收起来"的状态，
     不当成空的就会一直以为"已经有验证码了"，从此再也不加载。 */
  if (box.childElementCount > 0 && !box.classList.contains('captcha-done')) return Promise.resolve();
  return loadCaptcha(slot, true).then(() => {
    const now = $(captchaBoxId(slot));
    /* 服务端关掉了人机验证：空白是正常的，不要白重试 */
    if (st.disabled) return;
    if (now && now.childElementCount > 0) return;
    if (n >= 4) {
      logLine('人机验证多次加载仍为空，可点"刷新验证码"或检查服务器地址');
      return;
    }
    /* 退避重试：0.6s / 1.2s / 2.4s / 4.8s。
       服务器刚起来、网络刚就绪这类情况，重试一次基本就好了。 */
    const delay = 600 * Math.pow(2, n);
    setTimeout(() => refreshCaptchaBox(slot, n + 1), delay);
  }).catch(() => { /* loadCaptcha 自己已经把失败记进日志了 */ });
}

/* 换一张（提交失败带 captcha:true 时调用） */
function resetCaptcha(slot) {
  const st = captchaSlots[slot];
  if (!st) return;
  if (st.mode === 'geetest' || st.mode === 'geetest3') {
    st.validate = null;
    /* 不要用 captcha.reset()！challenge 是一次性的：reset 会让极验拿着同一个
       （已经被 get.php 消费掉的）challenge 再请求一次，极验返回
       error_02 "old challenge"，widget 上就显示"网络不给力"，而且之后再也恢复不了。
       我们的 challenge 由自家服务端签发，所以重新签发一个再渲染才可靠。
       注意这条路径在"用户第一次没滑对"之后就会走到 —— 不修就会一直"网络不给力"。 */
    if (captchaDoneTimers[slot]) { clearTimeout(captchaDoneTimers[slot]); captchaDoneTimers[slot] = null; }
    st.geetest = null;
    st.answer = '';
    if (st.disabled || st.unavailable) return;
    loadCaptcha(slot, true);
    return;
  }
  st.validate = null;
  st.answer = '';
  const input = $(captchaInputId(slot));
  if (input) input.value = '';
  if (st.disabled || st.unavailable) return;
  loadCaptcha(slot, true);
}

/* 组装随请求提交的验证码字段：极验提交 4 个字段，内置码提交 token+答案 */
function captchaFields(slot) {
  const st = captchaSlots[slot] || {};
  if (st.mode === 'geetest') {
    const v = st.validate || {};
    return {
      lot_number: v.lot_number || '',
      captcha_output: v.captcha_output || '',
      pass_token: v.pass_token || '',
      gen_time: v.gen_time || '',
    };
  }
  if (st.mode === 'geetest3') {
    /* 3.0 的三个字段名固定；offline 时 validate 由极验 SDK 在本地生成 */
    const v = st.validate || {};
    return {
      geetest_challenge: v.geetest_challenge || '',
      geetest_validate: v.geetest_validate || '',
      geetest_seccode: v.geetest_seccode || '',
      geetest_offline: st.offline ? true : false,
    };
  }
  const input = $(captchaInputId(slot));
  const live = input ? input.value.trim() : '';
  /* 容器被收起后输入框已不存在，这时回退到状态里存的那份答案 */
  return { captcha_token: st.token || '', captcha_answer: live || st.answer || '' };
}

/* 提交前的本地检查（服务端仍会再校验一次，这里只是提前给提示） */
function ensureCaptcha(slot) {
  const st = captchaSlots[slot] || {};
  if (st.disabled || st.unavailable) return true;   // 关闭或旧服务端：不阻塞
  if (st.mode === 'geetest') {
    if (st.validate && st.validate.lot_number) return true;
    toast('请先完成人机验证', 'error');
    try { if (st.geetest && typeof st.geetest.showCaptcha === 'function') st.geetest.showCaptcha(); } catch (_) {}
    return false;
  }
  if (st.mode === 'geetest3') {
    if (st.validate && st.validate.geetest_validate) return true;
    toast('请先完成人机验证', 'error');
    if (st.geetest && typeof st.geetest.reset === 'function') { try { st.geetest.reset(); } catch (_) {} }
    return false;
  }
  if (st.mode === 'none') return true;              // 还没加载出来，交给服务端判定
  const input = $(captchaInputId(slot));
  const val = (input ? input.value.trim() : '') || st.answer || '';
  if (!val) {
    /* 走到这里通常意味着图形码已被收起且没有留存答案。
       只弹提示的话，容器是空的、用户无处可输，会彻底卡死 —— 所以顺手重新拉一张。 */
    toast('请重新输入图形验证码', 'error');
    loadCaptcha(slot, true);
    return false;
  }
  return true;
}

/* 服务端判定验证码失败时：刷新验证码并提示 */
function handleCaptchaError(slot, err) {
  if (!err || !err.payload || !err.payload.captcha) return false;
  resetCaptcha(slot);
  toast(err.payload.error || '人机验证失败，请重新验证', 'error');
  return true;
}
/* ====== 个性化：字体/标题栏/背景 ====== */
function setFontFamily(font) {
  localStorage.setItem('blfp_font', font);
  applyFontFamily();
}
function applyFontFamily() {
  const font = localStorage.getItem('blfp_font') || 'default';
  const stack = font === 'default'
    ? '"Segoe UI Variable Display", "Inter", "SF Pro Display", "Microsoft YaHei", system-ui, sans-serif'
    : font + ', "Microsoft YaHei", system-ui, sans-serif';
  document.body.style.fontFamily = stack;
  const sel = $('font-select');
  if (sel) sel.value = font;
}
function setCustomTitlebar(mode) {
  localStorage.setItem('blfp_titlebar_mode', mode);
  const textInput = $('titlebar-text-input');
  const imageInput = $('titlebar-image-input');
  const preview = $('titlebar-preview');
  if (textInput) textInput.style.display = (mode === 'text' || mode === 'mixed') ? 'block' : 'none';
  if (imageInput) imageInput.style.display = (mode === 'image' || mode === 'mixed') ? 'block' : 'none';
  if (preview) preview.style.display = mode === 'default' ? 'none' : 'flex';
  applyTitlebarPreview();
}
function applyTitlebarPreview() {
  const mode = localStorage.getItem('blfp_titlebar_mode') || 'default';
  const text = $('titlebar-text-input')?.value || localStorage.getItem('blfp_titlebar_text') || '';
  const image = $('titlebar-image-input')?.value || localStorage.getItem('blfp_titlebar_image') || '';
  if (mode === 'text' || mode === 'mixed') localStorage.setItem('blfp_titlebar_text', text);
  if (mode === 'image' || mode === 'mixed') localStorage.setItem('blfp_titlebar_image', image);
  // 更新实际标题栏
  const titleEl = document.querySelector('.titlebar-title');
  const preview = $('titlebar-preview');
  if (titleEl) {
    if (mode === 'text') titleEl.innerHTML = escapeHtml(text || 'BLFP');
    else if (mode === 'image') titleEl.innerHTML = image ? '<img src="' + escapeHtml(image) + '" style="height:18px;max-width:140px;object-fit:contain;border-radius:3px" onerror="this.outerHTML=\'BLFP\'">' : 'BLFP';
    else if (mode === 'mixed') titleEl.innerHTML = (image ? '<img src="' + escapeHtml(image) + '" style="height:18px;max-width:120px;object-fit:contain;border-radius:3px;margin-right:8px" onerror="this.remove()">' : '') + escapeHtml(text || 'BLFP');
    else titleEl.textContent = 'BLFP';
  }
  if (preview) {
    preview.style.alignItems = 'center';
    preview.style.gap = '8px';
    preview.innerHTML = titleEl ? titleEl.innerHTML : '';
  }
}
function setCustomBackground(mode) {
  localStorage.setItem('blfp_bg_mode', mode);
  const colorInput = $('bg-color-input');
  const imageInput = $('bg-image-input');
  if (colorInput) colorInput.style.display = mode === 'color' ? 'block' : 'none';
  const blocksHint = $('bg-blocks-hint');
  if (blocksHint) blocksHint.style.display = mode === 'blocks' ? 'block' : 'none';
  if (imageInput) imageInput.style.display = mode === 'image' ? 'block' : 'none';
  applyBackgroundPreview();
}
function applyBackgroundPreview() {
  /* 一次性迁移：老版本没背景时自动切到色块底 */
  if (localStorage.getItem('blfp_bg_v') !== '2') {
    localStorage.setItem('blfp_bg_v', '2');
    if (!localStorage.getItem('blfp_bg_mode') || localStorage.getItem('blfp_bg_mode') === 'default') {
      localStorage.setItem('blfp_bg_mode', 'blocks');
    }
  }
  const mode = localStorage.getItem('blfp_bg_mode') || 'blocks';
  const color = $('bg-color-input')?.value || localStorage.getItem('blfp_bg_color') || '#08080f';
  const image = $('bg-image-input')?.value || localStorage.getItem('blfp_bg_image') || '';
  const blur = Number($('bg-blur')?.value ?? localStorage.getItem('blfp_bg_blur') ?? 0);
  localStorage.setItem('blfp_bg_color', color);
  localStorage.setItem('blfp_bg_image', image);
  localStorage.setItem('blfp_bg_blur', String(blur));
  let bgEl = $('custom-bg-layer');
  if (!bgEl) {
    bgEl = document.createElement('div');
    bgEl.id = 'custom-bg-layer';
    bgEl.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;';
    document.body.prepend(bgEl);
  }
  if (mode === 'blocks') {
    /* 多彩色块背景 */
    bgEl.style.background = '#080a14';
    bgEl.innerHTML = '';
    const palette = [
      'hsla(222, 90%, 62%, .95)', 'hsla(268, 85%, 65%, .9)', 'hsla(320, 80%, 62%, .85)',
      'hsla(190, 85%, 58%, .9)', 'hsla(160, 75%, 55%, .85)', 'hsla(38, 90%, 60%, .85)',
      'hsla(12, 85%, 60%, .9)', 'hsla(300, 75%, 60%, .8)', 'hsla(240, 80%, 68%, .85)',
      'hsla(175, 80%, 52%, .8)',
    ];
    const COLS = 6, ROWS = 5, N = COLS * ROWS;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;inset:-10%;filter:blur(' + (blur > 0 ? blur : 42) + 'px) saturate(1.25);';
    for (let i = 0; i < N; i++) {
      const col = i % COLS, row = Math.floor(i / COLS);
      /* 用固定伪随机（种子）保证每次渲染布局一致 */
      const seed = (i * 9301 + 49297) % 233280 / 233280;
      const seed2 = (i * 4801 + 9973) % 233280 / 233280;
      const b = document.createElement('span');
      const size = 26 + seed * 26;                     /* 块大小 % */
      const x = col * (100 / (COLS - 1)) - 10 + (seed - 0.5) * 14;
      const y = row * (100 / (ROWS - 1)) - 8 + (seed2 - 0.5) * 14;
      b.style.cssText =
        'position:absolute;left:' + x.toFixed(2) + '%;top:' + y.toFixed(2) + '%;' +
        'width:' + size.toFixed(1) + '%;height:' + (size * (0.7 + seed2 * 0.6)).toFixed(1) + '%;' +
        'background:' + palette[i % palette.length] + ';' +
        'border-radius:' + (20 + seed * 40).toFixed(0) + '%;' +
        'transform:rotate(' + ((seed - 0.5) * 50).toFixed(1) + 'deg);' +
        'opacity:' + (0.55 + seed2 * 0.4).toFixed(2) + ';' +
        'mix-blend-mode:screen;';
      wrap.appendChild(b);
    }
    bgEl.appendChild(wrap);
    bgEl.style.backdropFilter = 'none';
    bgEl.style.filter = 'none';
  } else if (mode === 'color') {
    bgEl.style.background = color;
    bgEl.style.backdropFilter = 'none';
    bgEl.innerHTML = '';
  } else if (mode === 'image') {
    bgEl.innerHTML = '';
    const img = document.createElement('img');
    img.src = image;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;' + (blur > 0 ? 'filter:blur(' + blur + 'px);transform:scale(1.1);' : '');
    img.onerror = () => { bgEl.innerHTML = ''; };
    bgEl.appendChild(img);
  } else {
    bgEl.innerHTML = '';
    bgEl.style.background = 'transparent';
  }
}
// 启动时恢复个性化设置
function restorePersonalization() {
  applyFontFamily();
  const tbMode = localStorage.getItem('blfp_titlebar_mode');
  if (tbMode && tbMode !== 'default') {
    const sel = $('titlebar-mode');
    if (sel) sel.value = tbMode;
    setCustomTitlebar(tbMode);
  }
  const bgMode = localStorage.getItem('blfp_bg_mode');
  if (bgMode && bgMode !== 'default') {
    const sel = $('bg-mode');
    if (sel) sel.value = bgMode;
    setCustomBackground(bgMode);
  }
  updateWelcomeText();
}
document.addEventListener('DOMContentLoaded', () => {
  restorePersonalization();
  setTimeout(restorePersonalization, 500); // 主界面显示后再次应用
});


/* ====== 特殊头衔权限控制 ====== */
const PRIVILEGES = {
  admin: ['publish_announcement', 'manage_rooms', 'view_logs', 'manage_users', 'manage_nodes', 'ban_user', 'edit_motd', 'server_stats'],
  dev: ['publish_announcement', 'manage_rooms', 'view_logs', 'server_stats', 'edit_motd'],
  sponsor: ['custom_title', 'priority_nodes']
};
function getUserRole() {
  const u = state.user || {};
  if (u.role && PRIVILEGES[u.role]) return u.role;
  const t = String(u.title || '');
  if (t.includes('管理') || t === 'admin') return 'admin';
  if (t.includes('开发') || t === 'dev') return 'dev';
  if (t.includes('赞助') || t === 'sponsor') return 'sponsor';
  return 'user';
}
function hasPrivilege(priv) {
  const role = getUserRole();
  return (PRIVILEGES[role] || []).includes(priv);
}
function applyPrivilegeUI() {
  // 根据头衔显示/隐藏管理功能
  const isAdmin = hasPrivilege('publish_announcement');
  const annAdmin = document.querySelector('.announcement-admin-section');
  if (annAdmin) annAdmin.classList.toggle('hidden', !isAdmin);
}

/* ====== 用户面板数据填充 ====== */
function fillUserPanel() {
  const u = state.user;
  if (!u) return;
  const title = u.title || ({ admin: '管理员', dev: '开发者', sponsor: '赞助用户', user: '普通用户' }[u.role] || '普通用户');
  const initial = (u.username || 'U').charAt(0).toUpperCase();
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('us-avatar-initials', initial);
  set('us-username', u.username || '用户');
  const roleEl = $('us-role');
  if (roleEl) {
    roleEl.textContent = title;
    const cls = resolveUserThemeClass(u.theme, u.role);
    roleEl.className = 'user-role ' + cls;
    roleEl.dataset.userTheme = safeUserTheme(u.theme) || 'role';
    roleEl.style.cssText = 'font-size:.82rem;margin-bottom:2px';
  }
  set('us-uid', String(u.id !== undefined && u.id !== null ? u.id : '-'));
  set('us-info-name', u.username || '-');
  set('us-info-role', title);
  set('us-info-id', String(u.id !== undefined && u.id !== null ? u.id : '-'));
  set('us-info-server', state.server || DEFAULT_SERVER);
  /* 好友数（异步拉取） */
  api('/friends').then((friends) => {
    set('us-info-friends', Array.isArray(friends) ? friends.length : 0);
  }).catch(() => set('us-info-friends', '-'));
}


async function publishAnnouncement() {
  const title = $('admin-ann-title')?.value?.trim();
  const content = $('admin-ann-content')?.value?.trim();
  if (!title || !content) return toast('请填写公告标题和内容', 'warn');
  try {
    await apiChat('/settings/announcement', { method: 'POST', body: JSON.stringify({ title, content }) });
    toast('公告发布成功', 'success');
    loadAnnouncements();
  } catch (e) {
    toast('公告发布失败: ' + e.message, 'error');
  }
}


/* ====== 用户页设置归类（部分设置移到主设置页提示） ====== */
function categorizeUserSettings() {
  // 用户页仅保留账户相关；界面类设置已在主设置页
  const userPage = $('page-user-settings');
  if (!userPage) return;
  // 给用户页的界面类设置加提示标记
  const items = userPage.querySelectorAll('.form-group');
  items.forEach((item) => {
    const label = item.querySelector('label');
    if (label && (label.textContent.includes('主题') || label.textContent.includes('字体') || label.textContent.includes('玻璃'))) {
      let badge = item.querySelector('.moved-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'moved-badge';
        badge.textContent = '已移至主设置页';
        badge.style.cssText = 'font-size:.66rem;color:var(--text3);margin-left:8px;padding:2px 8px;border-radius:8px;background:rgba(255,255,255,0.04)';
        label.appendChild(badge);
      }
    }
  });
}

function navToSettingsFromUser() { navTo('settings'); const g = $('sidebar-gear-btn'); if (g) g.classList.add('active'); }
