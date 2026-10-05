# BLFP-4: v2.1.0→v2.1.1 Linux/Windows 打包与 CI 修复

> 日期：2026-08-27
> 任务来源：延续 BLFP-3 §10 待办，完成 Linux .deb/.AppImage 构建与 Windows .exe 安装器 GitHub Actions 自动化

---

## 任务清单

| # | 任务 | 状态 |
|---|------|------|
| 1 | 安装并配置 GitHub CLI (gh) | ✅ |
| 2 | 更新 release.yml 路径至 v2.1.1 | ✅ |
| 3 | 更新各子项目 package.json 版本至 2.1.1 | ✅ |
| 4 | 生成 256×256 PNG 图标 assets/icon.png | ✅ |
| 5 | 下载 EasyTier Windows 二进制文件 | ✅ |
| 6 | 补充缺失的 Windows 运行时库 | ✅ |
| 7 | 构建 Linux .deb + .AppImage (v2.1.1) | ✅ |
| 8 | 推送 v2.1.1 tag 触发 GitHub Actions | ✅ |
| 9 | Windows 安装器 CI 构建通过 | ✅ |
| 10 | 创建 BLFP-4.md 本文档 | ✅ |

---

## 关键产出

### Linux 本地构建产物（/workspace/）

| 文件 | 大小 | SHA256 |
|------|------|--------|
| BLFP-v2.1.1-linux-amd64.deb | 86.9 MB | 1fada10c74b447c72a5818a99c5bc223b2e5c1274a6c4ab42892fc750714da09 |
| BLFP-v2.1.1-linux-x86_64.AppImage | 121.8 MB | 6059afb0e4db98a2359ebbb40320dbfa8aedd804f61261e5540b1a1cd6433f24 |

### Windows 安装器（GitHub Release v2.1.1）

| 文件 | 大小 | 下载链接 |
|------|------|----------|
| BLFP-Setup-v2.1.1.exe | 272.8 MB | https://github.com/blfp-team/blfp-client/releases/download/v2.1.1/BLFP-Setup-v2.1.1.exe |

---

## 遇到的问题与解决

### Q1: EasyTier Windows 二进制找不到
- 原因：原 checkpoint 引用的 easy-tier/easytier 返回 404；实际仓库为 EasyTier/EasyTier（首字母大写）
- 解决：通过 GitHub API 发现正确仓库名，下载 easytier-windows-x86_64-v2.6.4.zip

### Q2: fpm 缺 ar 导致 .deb 构建失败
- 原因：容器环境未安装 binutils
- 解决：改用 dpkg-deb --build 手动构造 deb 包

### Q3: workflow 路径版本不匹配
- 原因：首次推送 v2.1.1 时只更新了 package.json 版本号
- **当时的**解决：重新 tag v2.1.1（force push）
- ⚠️ **这条做法已作废，不要再照做。** 当时那个 tag 还没有人装过，重打没代价。
  现在「已发布的 tag 永不重打」是硬规则：重打会让已装那个版本的用户版本号对不上。
  正确做法是先 `node scripts/bump-version.js --patch`（会自动拒绝回退的号），
  再用**新的号**打 tag。见 `docs/RELEASE.md` 的「版本号规则」。

### Q4: git push 需要认证
- 原因：容器无交互式终端
- 解决：将 GitHub PAT token 嵌入 remote URL

---

## 后续待办（续 BLFP-3 §10）

| 优先级 | 任务 |
|--------|------|
| P0 | 配置 EasyTier 外部 peer（当前 tcp://p.blfp.cn:11010 不可达） |
| P1 | 服务端支持多 EasyTier 节点自动切换 |
| P2 | 客户端添加连接诊断面板 |

---

## 本 Session 总结

- ✅ Linux 本地构建产出 .deb (86.9 MB) + .AppImage (121.8 MB)
- ✅ Windows 安装器通过 GitHub Actions windows-latest runner 成功构建并上传 Release
- ✅ 修复了 EasyTier 二进制缺失、fpm 缺 ar、workflow 路径不匹配等阻塞问题
- ✅ 所有产物 SHA256 已记录
