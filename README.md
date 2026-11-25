# Antigravity Desktop File Actions

> 将 [ITer99/antigravity-file-actions](https://github.com/ITer99/antigravity-file-actions)（原 Antigravity IDE / VS Code 扩展）改造为适用于 **Antigravity 桌面端 (Antigravity 2.0, Electron Windows 客户端)** 的原生文件右键增强补丁。

当 AI Agent 对话窗口或 Artifact 视图中包含本地文件路径或可点击的文件链接时，直接在链接/路径上点击**鼠标右键**，即可弹出上下文操作菜单：

- **使用系统默认程序打开**：通过 Windows Shell 默认关联程序打开目标文件（自动剥离 `ELECTRON_*` / `ANTIGRAVITY_*` 等宿主环境变量，确保 Typora、Obsidian、VS Code 等 Electron 应用可正常拉起；可执行文件与脚本强制弹出二次安全确认框）。
- **在 Windows 资源管理器中显示**：调用 Electron `shell.showItemInFolder`（目录回退 `explorer.exe`）打开资源管理器并高亮选中目标文件。
- **复制文件绝对路径**：将规范化后的 Windows 绝对路径写入系统剪贴板并弹出 Toast 提示。

---

## 与 IDE 版的架构区别

| 项目 | Antigravity IDE 版 | Antigravity 桌面端版（本项目） |
| :--- | :--- | :--- |
| 宿主形态 | VS Code Fork (`.vsix` 扩展) | 纯 Electron 桌面应用 (`resources/app.asar`) |
| 通信方式 | 本地回环 HTTP 服务 (`127.0.0.1:49821`) + `agy` 反向代理 | 原生 Electron `ipcMain` / `ipcRenderer`（零端口占用、零代理） |
| 注入方式 | `workbench.js`、`jetskiAgent.js`、`extensions/agy`、`product.json` | 主进程注入 `dist/afaMain.js`（由 `dist/main.js` 加载）；渲染层逻辑直接内联注入 `dist/preload.js`（兼容 Electron 沙盒化 preload） |
| 备份恢复 | `.afa-backup` + `product.json` SHA-256 重算 | `app.asar.afa-backup` 整包备份 + ASAR 文件级 SHA-256 integrity 重算 |

---

## 使用方法

> 前置要求：Windows 10/11 + Node.js 18+

### 1. 安装 / 更新补丁（一步到位，自动重启桌面端）

- **PowerShell 7（推荐）**：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File ".\install.ps1"
```

- **双击批处理**：双击运行 [`install.bat`](./install.bat)
- **命令行**：

```cmd
node cli.js install --kill
```

### 2. 查看状态

```cmd
node cli.js status
```

### 3. 卸载并恢复原状

- **PowerShell 7**：`pwsh -NoProfile -ExecutionPolicy Bypass -File ".\uninstall.ps1"`
- **双击批处理**：双击运行 [`uninstall.bat`](./uninstall.bat)
- **命令行**：`node cli.js uninstall --kill`

---

## 目录结构

```text
antigravity-desktop-file-actions/
├── cli.js              # 命令行入口 (install / uninstall / status)
├── install.ps1         # PowerShell 7 一键安装并自动重启桌面端
├── uninstall.ps1       # PowerShell 7 一键卸载并自动重启桌面端
├── install.bat         # Windows 批处理一键安装脚本
├── uninstall.bat       # Windows 批处理一键卸载恢复脚本
├── package.json        # 项目配置与 npm scripts
├── LICENSE             # MIT 许可证
├── src/
│   ├── asar.js         # 零依赖纯 Node.js ASAR 解析与重打包器
│   ├── afaMain.js      # 注入到 Electron 主进程的 IPC 与 Windows 文件操作模块
│   ├── afaRenderer.js  # 内联注入到 Electron preload 的右键捕获、路径识别与菜单 UI
│   └── patcher.js      # app.asar 备份、补丁安装/卸载与状态检查
└── test/
    └── run-tests.js    # 单元测试与 ASAR 临时副本端到端往返验证
```

---

## 注意事项

- 当 Antigravity 桌面端自动更新覆盖 `resources/app.asar` 后，只需再次运行 `install.ps1` / `install.bat` 或 `node cli.js install --kill` 即可重新应用补丁（会自动识别未打补丁的新版 `app.asar` 并刷新备份）。
- 本项目仅使用 Node.js 内置模块，无任何第三方 npm 依赖。

---

## 致谢与许可证

- 致谢原项目：[ITer99/antigravity-file-actions](https://github.com/ITer99/antigravity-file-actions)
- 本项目基于 [MIT License](./LICENSE) 开源。
