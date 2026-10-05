const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');

class FrpcManager extends EventEmitter {
  constructor() {
    super();
    this._proc = null;
    this._configPath = null;
    this._state = 'stopped';
    this._stopping = false;
    this._operationQueue = Promise.resolve();
    this._stopOperation = null;
    this._generation = 0;
  }

  getStatus() {
    return {
      state: this._state,
      running: this._state === 'running' && this._isChildAlive(this._proc),
    };
  }

  start(cfg) {
    this._stopOperation = null;
    return this._enqueueOperation(() => this._start(cfg));
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

  async _start(cfg) {
    if (this._state !== 'stopped' || this._proc || this._configPath) await this._stop();
    const generation = ++this._generation;
    this._tunnelName = this._genTunnelName();
    const frpcPath = this._getFrpcPath();
    if (!fs.existsSync(frpcPath)) {
      throw new Error(`未找到 frpc 可执行文件: ${frpcPath}\n请将 frpc.exe 放入 client/bin/ 目录`);
    }

    const configPath = path.join(
      os.tmpdir(),
      `blfp_frpc_${process.pid}_${generation}_${Date.now()}_${Math.random().toString(16).slice(2)}.toml`,
    );
    fs.writeFileSync(configPath, this._buildToml(cfg), 'utf8');
    this._configPath = configPath;
    this._stopping = false;
    this._setState('starting');

    try {
      const child = spawn(frpcPath, ['-c', configPath], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this._proc = child;
      const result = await this._attachProcess(child, generation, configPath, cfg);
      if (this._generation !== generation || this._proc !== child || !this._isChildAlive(child)) {
        throw new Error('frpc 进程在启动期间退出');
      }
      this._setState('running');
      return result;
    } catch (error) {
      if (this._generation === generation) this._setState('error');
      await this._stop();
      throw error;
    }
  }

  async _stop() {
    this._generation += 1;
    this._stopping = true;
    if (this._state !== 'stopped' || this._proc || this._configPath) this._setState('stopping');

    const child = this._proc;
    const configPath = this._configPath;
    if (this._isChildAlive(child)) {
      try { child.kill(); } catch {}
      let exited = await this._waitForExit(child, 3000);
      if (!exited && process.platform === 'win32' && child.pid) {
        await this._taskkill(child.pid);
        exited = await this._waitForExit(child, 3000);
      }
      if (!exited) {
        try { child.kill('SIGKILL'); } catch {}
        await this._waitForExit(child, 1000);
      }
    }

    if (this._proc === child) this._proc = null;
    this._cleanupConfig(configPath);
    if (this._configPath === configPath) this._configPath = null;
    this._stopping = false;
    this._setState('stopped');
    return this.getStatus();
  }

  _enqueueOperation(operation) {
    const result = this._operationQueue.then(operation, operation);
    this._operationQueue = result.catch(() => {});
    return result;
  }

  _attachProcess(child, generation, configPath, cfg) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let processError = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const handleLine = (prefix, line) => {
        this.emit('log', `${prefix}${line}`);
        if (settled) return;

        const success = /start proxy success|proxy added|proxy started|start proxy.*success/i.test(line);
        const portMatch = line.match(/remotePort[=:]\s*(\d+)|remote_port\s*=\s*(\d+)|start proxy(?: success)?.*:(\d+)/i);
        if (success) {
          const port = parseInt((portMatch && (portMatch[1] || portMatch[2] || portMatch[3])) || cfg.remotePort);
          if (port) {
            this.emit('port', { port, tunnelName: this._tunnelName });
            finish(resolve, { remotePort: port, tunnelName: this._tunnelName });
            return;
          }
        }
        if (/login to the server failed|connect to server error|authorization failed|authentication failed|\bEOF\b/i.test(line)) {
          const message = /\bEOF\b/i.test(line)
            ? 'frps 握手失败：节点协议、TLS 设置或 frps/frpc 版本不匹配'
            : 'frps 认证失败：请检查节点 token 和服务端认证配置';
          finish(reject, new Error(message));
          return;
        }
        if (/start error|port.*already|proxy.*error|port unavailable/i.test(line)) {
          finish(reject, new Error('随机公网端口不可用'));
        }
      };
      const emitLines = (prefix, buffer) => {
        buffer.toString().split(/\r?\n/).filter(Boolean).forEach((line) => handleLine(prefix, line));
      };
      const timer = setTimeout(() => finish(reject, new Error('frpc 启动超时')), 10000);

      child.stdout.on('data', (buffer) => emitLines('', buffer));
      child.stderr.on('data', (buffer) => emitLines('[stderr] ', buffer));
      child.once('error', (error) => {
        processError = error;
        if (this._generation === generation && this._proc === child) this.emit('error', error.message);
        finish(reject, error);
      });
      child.once('close', (code, signal) => {
        this._cleanupConfig(configPath);
        if (this._configPath === configPath) this._configPath = null;
        if (this._generation !== generation || this._proc !== child) return;
        this._proc = null;
        if (!this._stopping && !processError) {
          this._setState('error');
          this.emit('error', `frpc 进程退出，code ${code}`);
        }
        finish(reject, new Error(`frpc 进程意外退出，退出码: ${code}${signal ? `，信号: ${signal}` : ''}`));
      });
    });
  }

  _waitForExit(child, timeout) {
    if (!this._isChildAlive(child)) return Promise.resolve(true);
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

  _taskkill(pid) {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
  }

  _isChildAlive(child) {
    return Boolean(child && child.exitCode === null && child.signalCode === null);
  }

  _genTunnelName() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let name = '';
    for (let i = 0; i < 6; i++) name += chars[Math.floor(Math.random() * chars.length)];
    return name;
  }

  _setState(state) {
    this._state = state;
    this.emit('status', this.getStatus());
  }

  _cleanupConfig(configPath) {
    if (!configPath) return;
    try { fs.unlinkSync(configPath); } catch (error) {
      if (error.code !== 'ENOENT') this.emit('log', `[stderr] 清理 frpc 配置失败: ${error.message}`);
    }
  }

  _getFrpcPath() {
    const devPath = path.join(__dirname, '..', 'bin', 'frpc.exe');
    if (fs.existsSync(devPath)) return devPath;
    return path.join(process.resourcesPath || '', 'bin', 'frpc.exe');
  }

  _buildToml(cfg) {
    const quote = (value) => JSON.stringify(String(value));
    const lines = [
      `serverAddr = ${quote(cfg.serverAddr)}`,
      `serverPort = ${Number(cfg.serverPort) || 7000}`,
    ];
    if (cfg.token) lines.push(`auth.token = ${quote(cfg.token)}`);
    lines.push(`transport.tls.enable = ${cfg.tls === true}`);
    lines.push(
      '',
      '[[proxies]]',
      `name = ${quote(this._tunnelName || 'blfp_tcp')}`,
      'type = "tcp"',
      'localIP = "127.0.0.1"',
      `localPort = ${Number(cfg.localPort) || 25565}`,
      `remotePort = ${Number(cfg.remotePort) || 0}`,
    );
    return lines.join('\n');
  }
}

module.exports = FrpcManager;
