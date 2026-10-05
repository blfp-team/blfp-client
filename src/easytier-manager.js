const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const net = require('net');
const path = require('path');
const platform = require('./platform');

const HOST_PORT = 25565;

class EasyTierManager extends EventEmitter {
  constructor(appOrOptions = {}) {
    super();
    const isApp = typeof appOrOptions.getAppPath === 'function';
    this._packed = isApp ? appOrOptions.isPackaged : Boolean(appOrOptions.packed ?? appOrOptions.isPackaged);
    this._resourcesPath = isApp
      ? process.resourcesPath
      : (appOrOptions.resourcesPath || process.resourcesPath);
    this._proc = null;
    this._proxyServer = null;
    this._proxySockets = new Set();
    this._state = 'stopped';
    this._mode = null;
    this._virtualIp = null;
    this._lastError = null;
    this._stopping = false;
    this._operationQueue = Promise.resolve();
    this._stopOperation = null;
    this._generation = 0;
    this._rpcPortal = null;
  }

  getBinaryPath() {
    const binDirectory = platform.binDir(this._packed, this._resourcesPath);
    return platform.binaryPath(binDirectory, 'easytierCore');
  }

  getCliPath() {
    const binDirectory = platform.binDir(this._packed, this._resourcesPath);
    return platform.binaryPath(binDirectory, 'easytierCli');
  }

  ensureBinary() {
    const binDirectory = path.dirname(this.getBinaryPath());
    return platform.ensureBinaries(binDirectory, ['easytierCore', 'easytierCli']);
  }

  getStatus() {
    return {
      state: this._state,
      running: this._state === 'running' && this._isProcessAlive(),
      mode: this._mode,
      virtualIp: this._virtualIp,
      proxyPort: this._proxyPort ?? HOST_PORT,
      proxyListening: Boolean(this._proxyServer?.listening),
      error: this._lastError,
    };
  }

  start(config = {}) {
    this._stopOperation = null;
    return this._enqueueOperation(() => this._start(config));
  }

  stop() {
    if (this._stopOperation) return this._stopOperation;
    const operation = this._enqueueOperation(() => this._stop());
    this._stopOperation = operation;
    const clear = () => {
      if (this._stopOperation === operation) this._stopOperation = null;
    };
    operation.then(clear, clear);
    return operation;
  }

  async _start(config = {}) {
    if (this._state !== 'stopped') await this._stop();
    const generation = ++this._generation;

    const mode = config.mode || config.role || (config.hostMode ? 'host' : 'guest');
    const virtualIp = String(config.virtualIp || '').trim();
    const [proxyIp, prefixLength, ...extraParts] = virtualIp.split('/');
    const networkName = String(config.networkName || '').trim();
    const networkSecret = String(config.networkSecret || '').trim();
    const peers = Array.isArray(config.peers) ? config.peers : (config.peer ? [config.peer] : []);
    const mcPort = Number(config.mcPort);

    if (!['host', 'guest'].includes(mode)) throw new Error('EasyTier 模式必须为 host 或 guest');
    if (!net.isIPv4(proxyIp)
      || extraParts.length
      || (prefixLength !== undefined && (!/^\d+$/.test(prefixLength) || Number(prefixLength) > 32))) {
      throw new Error('EasyTier 虚拟 IP 无效');
    }
    if (!networkName) throw new Error('EasyTier 网络名称不能为空');
    if (!networkSecret) throw new Error('EasyTier 网络密钥不能为空');
    if (mode === 'host' && (!Number.isInteger(mcPort) || mcPort < 1 || mcPort > 65535)) {
      throw new Error('Minecraft 端口无效');
    }

    this.ensureBinary();
    const binaryPath = this.getBinaryPath();
    const cliPath = this.getCliPath();
    const rpcPortal = `127.0.0.1:${await this._findFreeTcpPort()}`;

    const easyTierIp = prefixLength === undefined ? `${proxyIp}/24` : virtualIp;
    const instanceName = `${networkName}-${mode}`
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 63)
      .replace(/-$/, '') || `blfp-${mode}`;
    const args = [
      '--ipv4', easyTierIp,
      '--network-name', networkName,
      '--network-secret', networkSecret,
      '--hostname', instanceName,
      '--instance-name', instanceName,
      '--latency-first',
      '--rpc-portal', rpcPortal,
    ];
    peers.map((peer) => String(peer).trim()).filter(Boolean).forEach((peer) => args.push('-p', peer));

    this._mode = mode;
    this._virtualIp = virtualIp;
    this._rpcPortal = rpcPortal;
    this._lastError = null;
    this._stopping = false;
    this._setState('starting');
    this._log(`正在启动 EasyTier，${mode} 模式`);

    try {
      const child = spawn(binaryPath, args, {
        cwd: path.dirname(binaryPath),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this._proc = child;
      this._attachProcess(child, generation, networkSecret);

      await this._waitForPeerReady(child, generation, cliPath, rpcPortal);
      if (mode === 'host') {
        await this._waitForVirtualIp(proxyIp, 20000);
        await this._startHostProxy(child, generation, proxyIp, mcPort);
      }

      if (this._generation !== generation || this._proc !== child || !this._isChildAlive(child)) {
        throw new Error('EasyTier 进程在启动期间退出');
      }
      /* 访客入站需要：把虚拟网卡网络类别设为"专用"，否则 Windows 防火墙会按"公用网络"拦截 */
      this._setTunProfilePrivate(proxyIp);
      this._setState('running');
      this._log('EasyTier 启动成功');
      return this.getStatus();
    } catch (error) {
      this._lastError = error.message;
      this._setState('error');
      this._emitError(error.message);
      await this._stop();
      throw error;
    }
  }

  async _stop() {
    this._generation += 1;
    this._stopping = true;
    if (this._state !== 'stopped') this._setState('stopping');

    await this._closeProxy();
    const child = this._proc;
    if (child && child.exitCode === null && child.signalCode === null) {
      this._log('正在停止 EasyTier');
      try { child.kill('SIGTERM'); } catch {}
      const exited = await this._waitForExit(child, 3000);
      if (!exited) {
        try { child.kill('SIGKILL'); } catch {}
        await this._waitForExit(child, 1000);
      }
    }

    if (this._proc === child) this._proc = null;
    this._mode = null;
    this._virtualIp = null;
    this._rpcPortal = null;
    this._stopping = false;
    this._setState('stopped');
    return this.getStatus();
  }

  testConnectivity(hostVirtualIp, port = HOST_PORT, timeout = 3000) {
    return new Promise((resolve) => {
      const host = String(hostVirtualIp || '').trim();
      const targetPort = Number(port);
      if (!net.isIPv4(host) || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
        resolve({ ok: false, error: '连接地址或端口无效' });
        return;
      }

      const socket = new net.Socket();
      const startedAt = Date.now();
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(timeout);
      socket.once('connect', () => finish({ ok: true, latency: Date.now() - startedAt }));
      socket.once('timeout', () => finish({ ok: false, error: '连接超时' }));
      socket.once('error', (error) => finish({ ok: false, error: error.message }));
      socket.connect(targetPort, host);
    });
  }

  _enqueueOperation(operation) {
    const result = this._operationQueue.then(operation, operation);
    this._operationQueue = result.catch(() => {});
    return result;
  }

  _attachProcess(child, generation, networkSecret) {
    const emitLines = (prefix, buffer) => {
      buffer.toString().split(/\r?\n/).filter(Boolean).forEach((line) => {
        const safeLine = networkSecret ? line.split(networkSecret).join('[REDACTED]') : line;
        this._log(`${prefix}${safeLine}`);
        if (platform.TUN_FATAL_RE.test(safeLine) && this._generation === generation && this._proc === child) {
          this._lastError = platform.TUN_FATAL_MSG;
        }
      });
    };
    child.stdout.on('data', (buffer) => emitLines('', buffer));
    child.stderr.on('data', (buffer) => emitLines('[stderr] ', buffer));
    child.once('error', (error) => {
      if (this._generation !== generation || this._proc !== child) return;
      this._lastError = error.message;
      this._emitError(error.message);
    });
    child.once('close', (code, signal) => {
      this._log(`EasyTier 进程退出 code=${code} signal=${signal || 'none'}`);
      if (this._generation !== generation || this._proc !== child) return;
      this._proc = null;
      this._closeProxy();
      if (!this._stopping) {
        this._lastError = `EasyTier 进程意外退出，退出码 ${code}`;
        this._setState('error');
        this._emitError(this._lastError);
      }
    });
  }

  _findFreeTcpPort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close((error) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
    });
  }

  async _waitForPeerReady(child, generation, cliPath, rpcPortal, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this._generation !== generation || this._proc !== child || !this._isChildAlive(child)) {
        throw new Error('EasyTier 进程在启动期间退出');
      }

      const attemptStartedAt = Date.now();
      try {
        const peers = await this._queryPeers(cliPath, rpcPortal, child);
        if (Array.isArray(peers) && peers.some((peer) => peer?.cost !== 'Local')) {
          this._log('EasyTier 共享节点连接成功');
          return;
        }
      } catch (error) {
        if (!this._isChildAlive(child)) throw new Error('EasyTier 进程在启动期间退出');
      }

      const delay = Math.min(1000 - (Date.now() - attemptStartedAt), deadline - Date.now());
      if (delay > 0) await this._waitForProcess(child, delay);
    }
    throw new Error('无法连接 EasyTier 共享节点');
  }

  _queryPeers(cliPath, rpcPortal, child) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        child.removeListener('close', onClose);
        callback(value);
      };
      const onClose = () => finish(reject, new Error('EasyTier 进程在启动期间退出'));
      child.once('close', onClose);
      execFile(cliPath, ['-p', rpcPortal, '-o', 'json', 'peer'], {
        cwd: path.dirname(cliPath),
        timeout: 900,
      }, (error, stdout) => {
        if (error) {
          finish(reject, error);
          return;
        }
        try {
          finish(resolve, JSON.parse(stdout));
        } catch (parseError) {
          finish(reject, parseError);
        }
      });
    });
  }

  async _startHostProxy(child, generation, virtualIp, mcPort, timeout = 60000) {
    const deadline = Date.now() + timeout;
    let proxyPort = HOST_PORT;
    let eaccesAttempts = 0;
    while (Date.now() < deadline) {
      if (this._generation !== generation || this._proc !== child || !this._isChildAlive(child)) {
        throw new Error('EasyTier 进程在等待虚拟 IP 时退出');
      }
      try {
        const server = await this._listenProxy(virtualIp, mcPort, proxyPort);
        if (this._generation !== generation || this._proc !== child) {
          await new Promise((resolve) => server.close(() => resolve()));
          throw new Error('EasyTier 启动已取消');
        }
        this._proxyServer = server;
        this._proxyPort = proxyPort;
        this._log(`TCP 代理已监听 ${virtualIp}:${proxyPort} -> 127.0.0.1:${mcPort}`);
        return;
      } catch (error) {
        if (!['EADDRNOTAVAIL', 'EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
        if (error.code === 'EADDRINUSE' && proxyPort === HOST_PORT) {
          // 端口冲突：切换到随机空闲端口
          proxyPort = await this._findFreeTcpPort();
          this._log(`端口 ${HOST_PORT} 被占用，切换到代理端口 ${proxyPort}`);
          continue;
        }
        if (error.code === 'EACCES') {
          /* Windows 上绑定虚拟 IP 可能持续报 EACCES（接口未就绪/安全软件拦截）。
             先短暂重试，仍失败则走 0.0.0.0 回退（只放行虚拟网段来源）。 */
          eaccesAttempts += 1;
          if (eaccesAttempts <= 6) {
            this._log('虚拟网卡绑定被拒 EACCES，重试 ' + eaccesAttempts + '/6 ...');
            await this._delay(800);
            continue;
          }
          this._log('虚拟 IP 绑定持续被拒 EACCES，改用 0.0.0.0 回退方案');
          break;
        }
        await this._delay(500);
      }
    }
    /* 虚拟 IP 绑定持续失败（非管理员/杀软拦截等）：回退绑定 0.0.0.0。
       Windows 上监听 0.0.0.0 同样能收到发往虚拟 IP 的隧道流量（EasyTier 会把包投递到本机）。 */
    try {
      const server = await this._listenProxy('0.0.0.0', mcPort, proxyPort, virtualIp);
      this._proxyServer = server;
      this._proxyPort = proxyPort;
      this._log('已回退监听 0.0.0.0:' + proxyPort + '（虚拟 IP ' + virtualIp + ' 绑定被系统拒绝；仅放行 ' + virtualIp.split('.').slice(0, 2).join('.') + '.x.x 来源，隧道连接不受影响）');
      return;
    } catch (fallbackError) {
      throw new Error('等待虚拟 IP ' + virtualIp + ' 可绑定超时。请依次检查：1) 是否以管理员身份运行，虚拟网卡需要权限 2) Windows 防火墙或杀软是否拦截 3) 端口 25565 是否被系统保留，可执行 netsh int ipv4 show excludedportrange protocol=tcp 查看');
    }
  }

  /* 列出本机所有 IPv4 地址（诊断虚拟网卡是否创建成功） */
  _listLocalIpv4() {
    try {
      const os = require('os');
      const out = [];
      const ifaces = os.networkInterfaces();
      Object.keys(ifaces).forEach((name) => {
        (ifaces[name] || []).forEach((info) => {
          if (info && (info.family === 'IPv4' || info.family === 4) && info.address) {
            out.push({ name, address: info.address });
          }
        });
      });
      return out;
    } catch (e) { return []; }
  }

  /* 等待虚拟 IP 出现在本机网卡上（EasyTier 创建 TUN 成功后才会出现） */
  async _waitForVirtualIp(virtualIp, timeout = 20000) {
    const deadline = Date.now() + timeout;
    let last = [];
    while (Date.now() < deadline) {
      last = this._listLocalIpv4();
      if (last.some((item) => item.address === virtualIp)) {
        this._log('虚拟网卡已就绪: ' + virtualIp + '（接口 ' + last.find((i) => i.address === virtualIp).name + '）');
        return true;
      }
      await this._delay(500);
    }
    this._log('警告：虚拟 IP ' + virtualIp + ' 未出现在本机网卡上。当前 IPv4: ' + (last.map((i) => i.address).join(', ') || '无'));
    this._log('这通常表示 EasyTier 的虚拟网卡 TUN/wintun 创建失败，请检查上方 [EasyTier] 日志中的驱动相关报错');
    return false;
  }

  /* 找到承载虚拟 IP 的网卡名称 */
  _tunInterfaceName(virtualIp) {
    const hit = this._listLocalIpv4().find((item) => item.address === virtualIp);
    return hit ? hit.name : null;
  }

  /* 把承载虚拟 IP 的网卡设为"专用网络"：否则 Windows 防火墙按"公用网络"拦截访客入站 */
  _setTunProfilePrivate(virtualIp) {
    if (process.platform !== 'win32') return;
    const iface = this._tunInterfaceName(virtualIp);
    if (!iface) return;
    try {
      const { execFile } = require('child_process');
      execFile('powershell', ['-NoProfile', '-Command',
        "Set-NetConnectionProfile -InterfaceAlias '" + iface.replace(/'/g, "''") + "' -NetworkCategory Private -ErrorAction SilentlyContinue"
      ], (err) => {
        if (err) this._log('虚拟网卡网络类别设置失败，可忽略: ' + (err.message || ''));
        else this._log('已将虚拟网卡 ' + iface + ' 设为专用网络，防火墙会放行访客入站');
      });
    } catch (e) { /* 忽略 */ }
  }

  _probeTcp(host, port, timeout = 800) {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const done = (result) => { socket.destroy(); resolve(result); };
      socket.setTimeout(timeout, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  }

  /* 判断来源是否在虚拟网段（用于 0.0.0.0 回退时过滤非隧道流量） */
  _isVirtualSource(remoteAddress, virtualIp) {
    if (!remoteAddress) return false;
    const addr = String(remoteAddress).replace(/^::ffff:/, '');
    if (addr === virtualIp) return true;
    const parts = String(virtualIp).split('.');
    if (parts.length === 4) return addr.startsWith(parts[0] + '.' + parts[1] + '.');
    return addr.startsWith('10.200.');
  }

  _listenProxy(virtualIp, mcPort, port, restrictToVirtual) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((client) => {
        /* 回退监听 0.0.0.0 时，只放行来自虚拟网段的连接，避免把 MC 端口暴露到局域网/公网 */
        if (restrictToVirtual && !this._isVirtualSource(client.remoteAddress, virtualIp)) {
          this._log('已拒绝非虚拟网段连接: ' + client.remoteAddress);
          client.destroy();
          return;
        }
        const upstream = net.createConnection({ host: '127.0.0.1', port: mcPort });
        this._proxySockets.add(client);
        this._proxySockets.add(upstream);
        const forget = (socket) => this._proxySockets.delete(socket);
        client.once('close', () => forget(client));
        upstream.once('close', () => forget(upstream));
        client.pipe(upstream);
        upstream.pipe(client);
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
      });
      server.once('error', reject);
      const bindPort = port ?? HOST_PORT;
      server.listen(bindPort, virtualIp, () => {
        server.removeListener('error', reject);
        server.on('error', (error) => this._emitError(`EasyTier 代理错误: ${error.message}`));
        resolve(server);
      });
    });
  }

  _closeProxy() {
    const server = this._proxyServer;
    this._proxyServer = null;
    for (const socket of this._proxySockets) socket.destroy();
    this._proxySockets.clear();
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  _waitForProcess(child, milliseconds) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this._isChildAlive(child) ? resolve() : reject(new Error('EasyTier 进程未能保持运行'));
      }, milliseconds);
      const onClose = () => {
        cleanup();
        reject(new Error('EasyTier 进程在启动期间退出'));
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        child?.removeListener('close', onClose);
        child?.removeListener('error', onError);
      };
      child?.once('close', onClose);
      child?.once('error', onError);
    });
  }

  _waitForExit(child, timeout) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener('close', onClose);
        resolve(false);
      }, timeout);
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once('close', onClose);
    });
  }

  _isChildAlive(child) {
    return Boolean(child && child.exitCode === null && child.signalCode === null);
  }

  _isProcessAlive() {
    return this._isChildAlive(this._proc);
  }

  _setState(state) {
    this._state = state;
    this.emit('status', this.getStatus());
  }

  _emitError(message) {
    this.emit('manager-error', message);
  }

  _log(message) {
    this.emit('log', `[EasyTier] ${message}`);
  }

  _delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

module.exports = EasyTierManager;
