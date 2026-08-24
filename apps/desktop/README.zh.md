# @dsh-lumi/desktop

[English](README.md) | 中文

Lumi 的 Electron 桌面宿主。Electron 负责单实例无边框窗口、加载与恢复页标题栏、启用沙箱的 preload bridge、Harness utility process 生命周期、桌面专属目录、经过校验的角色包导入、有界本机诊断、Windows 签名打包和更新检查。官方 Web 应用仍是产品核心，并通过与 CLI 相同的 profile 启动路径监听本机回环地址和操作系统自动分配的端口。即使 Web 应用从未挂载，加载页和致命启动失败页仍提供最小化、最大化、关闭、重启、打开日志目录和复制诊断操作。

主进程与 Harness stdout/stderr 诊断使用带 Node 背压的持久异步可写流。轮转只保留一个有界当前文件和一个前序文件，在重命名前先关闭 Windows 文件句柄，并在应用优雅关闭期间排空两条流；因此日志流量不会在 Electron 主线程执行同步文件写入。

`lumi-desktop` profile 只在首次使用时由 `dsh-base`、`dsh-web-app` 和 `@dsh-lumi/bundle-desktop` 初始化。已有 profile patch、主目录 patch、会话、设置、凭据和插件仍由用户拥有，并继续位于普通 `$DSH_HOME` 下。

## 命令

- `pnpm run build` 只构建 Electron 主进程、preload 和工作进程入口，运行前要求 workspace 依赖已经存在。
- `pnpm run start` 启动已有产物。
- `pnpm run test` 运行协议、IPC、窗口位置和确定性生命周期测试。
- `pnpm run test:e2e` 构建完整产品并启动真实 Electron，覆盖单实例锁、唯一 Harness utility process、随机端口及释放、preload 隔离、场景／工作与窄屏布局、无桌面按钮的浏览器模式、无系统语音、外链、短时间连续崩溃恢复、恢复页操作、窗口位置保存、截图和优雅关闭。
- `pnpm run dist:windows` 在本机生成经过签名的 x64 NSIS 安装程序。`forceCodeSigning` 会让缺少 Windows 签名凭据直接失败；普通开发检查不会运行这个命令。
- `pnpm run publish:windows` 是发布工作流入口，只接受与版本完全匹配的 `lumi-v*` 标签，并把安装程序、blockmap 与更新元数据放入 GitHub 草稿 Release。

## 运行边界

- 本地只验收当前 Windows 平台。
- 发布打包要求受保护的 `lumi-desktop-release` GitHub environment 提供 `WIN_CSC_LINK` 与 `WIN_CSC_KEY_PASSWORD`。已安装应用检查更新时，用户必须能够读取仓库公开发布的 Release 资源。
- preload API 可以通过操作系统打开目录，也能通过经过校验的暂存副本和原子重命名安装用户选择的 Character Pack v1 目录，但不提供通用的应用内文件管理器。已有角色包 id 绝不会被覆盖；暂存失败的副本会保留在 `$DSH_HOME/lumi/import-staging` 供诊断。
