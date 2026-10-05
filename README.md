# BLFP Client

BLFP 是面向 Minecraft Java 版的联机客户端。无需公网 IP：房主一键开房，好友输入 6 位房间号即可加入，游戏流量走 EasyTier 虚拟网络（自动尝试 P2P 直连，受限时经共享节点中继），frp 固定中转作为备用通道。

**当前版本：v2.2.0**（Windows + Linux 双平台，[前往下载](https://github.com/blfp-team/blfp-client/releases/tag/v2.2.0)）

## 主要功能

- **EasyTier 智能组网**（默认）：每房间独立临时凭据，自动 P2P 直连，失败自动中继
- **节点选择与测速**：可指定 EasyTier 节点；auto 模式自动选延迟最低的节点
- **frp 中转模式**（备用）：固定公网节点转发，随机隧道名，连接信息上报管理台
- **6 位房间号**：房主创建即得，好友输入房间号一键加入
- **Minecraft 局域网发现**：自动扫描开放端口并广播 MOTD
- **成员与状态显示**：成员列表、延迟、在线人数
- **更新检测**：从 GitHub Releases 检查新版本

## 下载与安装

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows | `BLFP-Setup-v2.2.0.exe` | 图形安装器，需管理员权限 |
| Linux | `BLFP-v2.2.0-linux-x86_64.AppImage` | 免安装，`chmod +x` 后直接运行 |
| Linux | `BLFP-v2.2.0-linux-amd64.deb` | 安装到 /opt/BLFP 并注册桌面入口 |

SHA256 校验值与完整变更列表见 [Release v2.2.0](https://github.com/blfp-team/blfp-client/releases/tag/v2.2.0)。

> Linux 下 EasyTier 需要 `CAP_NET_ADMIN` 权限：以 root 运行，或执行
> `sudo setcap cap_net_admin,cap_net_raw+ep /opt/BLFP/resources/bin/easytier-core`

## 工作原理

### EasyTier 模式（默认）

- 房主创建房间，服务端分配 6 位房间号和该房间独立的临时网络凭据
- 房主与加入者通过共享节点互连，并自动尝试建立 P2P 直连
- 直连受限时，游戏流量自动经共享节点中继
- 加入者在 Minecraft 中直接连接房主的虚拟地址（`10.200.X.1:25565`）即可

### frp 中转模式（备用）

- 房主选择 frp 固定中转节点
- 客户端自动启动 frpc，将本机 Minecraft 端口映射到公网（每次使用随机隧道名）
- 加入者输入房间号后直接获得公网地址并连接

## 文档

完整的下载安装、联机教程、节点测速、管理台说明与 FAQ 见文档站（VitePress 构建）：

- 文档源码与构建产物位于服务端工作区的 `docs/` 与 `docs/build/`
- [更新日志](https://github.com/blfp-team/blfp-client/releases) ｜ 服务端可配置三平台下载链接聚合页 `/download`

## 本地开发

需要 Node.js 20 或更高版本。

```powershell
npm ci
npm start
```

## 构建

构建 Windows 安装包：推送 `v*` 标签后由 GitHub Actions 自动执行五步打包链并发布 Release。

本地构建 Linux 版（AppImage + deb）：

```bash
npm install --include=dev
npx electron-builder --linux --publish never
```

## 许可证

MIT

