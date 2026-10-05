const fs = require('fs');
const path = require('path');

const PLATFORM = process.platform;
const IS_LINUX = PLATFORM === 'linux';
const IS_WINDOWS = PLATFORM === 'win32';
/* Windows 下二进制带 .exe 后缀——缺了这个后缀会导致 existsSync 永远失败（"未找到运行文件"） */
const EXE = IS_WINDOWS ? '.exe' : '';

const BINARIES = {
  easytierCore: 'easytier-core' + EXE,
  easytierCli: 'easytier-cli' + EXE,
  frpc: 'frpc' + EXE,
};

// Windows 需要虚拟网卡驱动；Linux 版 EasyTier 直接走内核 TUN，无需 wintun.dll / Packet.dll 等
const EXTRA_RUNTIME_FILES = IS_WINDOWS ? ['wintun.dll', 'Packet.dll', 'WinDivert64.sys'] : [];

// Linux 下 TUN 设备创建失败的典型日志特征（权限不足 / 缺少 CAP_NET_ADMIN）
const TUN_FATAL_RE = /failed to create tun|create tun device|tun device error|permission denied|operation not permitted|capabilities?|os error 1\b|os error 13\b/i;

const TUN_FATAL_MSG = 'TUN 虚拟网卡创建失败，权限不足：Linux 下 EasyTier 需要 CAP_NET_ADMIN 权限，请以 root/sudo 运行 BLFP，或预先授权：sudo setcap cap_net_admin,cap_net_raw+ep easytier-core';

function binDir(packed, resourcesPath) {
  if (packed) return path.join(resourcesPath, 'bin');
  return path.join(__dirname, '..', 'bin');
}

function binaryPath(binDirectory, key) {
  return path.join(binDirectory, BINARIES[key]);
}

// 校验二进制与运行依赖存在，且具备可执行权限（Linux 特有）
function ensureBinaries(binDirectory, keys) {
  const requiredFiles = keys.map((key) => binaryPath(binDirectory, key))
    .concat(EXTRA_RUNTIME_FILES.map((file) => path.join(binDirectory, file)));
  const missingFile = requiredFiles.find((file) => !fs.existsSync(file));
  if (missingFile) throw new Error(`未找到运行文件: ${missingFile}`);
  for (const key of keys) {
    const file = binaryPath(binDirectory, key);
    try {
      fs.accessSync(file, fs.constants.X_OK);
    } catch {
      throw new Error(`${file} 缺少可执行权限，请执行: chmod +x "${file}"`);
    }
  }
  return true;
}

module.exports = {
  PLATFORM,
  IS_LINUX,
  IS_WINDOWS,
  BINARIES,
  EXTRA_RUNTIME_FILES,
  TUN_FATAL_RE,
  TUN_FATAL_MSG,
  binDir,
  binaryPath,
  ensureBinaries,
};
