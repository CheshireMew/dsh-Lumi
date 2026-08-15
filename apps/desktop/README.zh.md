# @dsh-lumi/desktop

[English](README.md) | 中文

Lumi 的 Electron 桌面宿主。Electron 负责单实例窗口、启用沙箱的 preload bridge、Harness utility process 生命周期、桌面专属目录、有界本机诊断、Windows 签名打包和更新检查。官方 Web 应用仍是产品核心，并通过与 CLI 相同的 profile 启动路径监听本机回环地址和操作系统自动分配的端口。

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
- preload API 可以通过操作系统打开目录，但应用内没有文件管理器。
