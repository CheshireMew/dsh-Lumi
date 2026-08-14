# @dsh-anime/desktop

[English](README.md) | 中文

二次元界面层的 Electron 桌面宿主。Electron 只负责单实例窗口、启用沙箱的 preload bridge、Harness utility process 生命周期、桌面专属目录和每日日志。官方 Web 应用仍是产品核心，并通过与 CLI 相同的 profile 启动路径监听本机回环地址和操作系统自动分配的端口。

`anime-desktop` profile 只在首次使用时由 `dsh-base`、`dsh-web-app` 和 `@dsh-anime/bundle-desktop` 初始化。已有 profile patch、主目录 patch、会话、设置、凭据和插件仍由用户拥有，并继续位于普通 `$DSH_HOME` 下。

## 命令

- `pnpm run build` 只构建 Electron 主进程、preload 和工作进程入口，运行前要求 workspace 依赖已经存在。
- `pnpm run start` 启动已有产物。
- `pnpm run test` 运行协议、IPC、窗口位置和确定性生命周期测试。
- `pnpm run test:e2e` 构建完整产品并启动真实 Electron，覆盖单实例锁、唯一 Harness utility process、随机端口及释放、preload 隔离、场景／工作与窄屏布局、无桌面按钮的浏览器模式、无系统语音、外链、短时间连续崩溃恢复、恢复页操作、窗口位置保存、截图和优雅关闭。

## 已知限制与待办事项

- 应用尚无安装程序、打包后的可执行文件、签名、更新器或发布通道。
- 本地只验收当前 Windows 平台。
- preload API 可以通过操作系统打开目录，但应用内没有文件管理器。
