# Agent Note: 基于官方 Web UI 的 Electron 二次元产品层

Status: implemented

[English](2026-08-14-anime-electron-product-layer.md) | 中文

## 问题

二次元桌面界面需要原生窗口行为、可持久化的角色领域和明显不同的布局，但不应接管官方 Web UI 已经实现的 Harness 功能。复制前端会让每次官方 UI 变化都变成人工移植任务，启动另一套无关后端则会拆分 profile、会话、设置和插件发现。

## 决定

产品使用 Electron 作为官方 Web 应用外层的轻量桌面宿主。专用 Electron utility process 通过公开 CLI profile 启动 API 加载 `anime-desktop` profile，依次使用 `dsh-base`、`dsh-web-app` 和增量式 `@dsh-anime/bundle-desktop`。Web 服务器监听 `127.0.0.1` 和操作系统自动分配的端口，并通过结构化进程消息报告就绪。

官方布局插件拥有稳定的 `LayoutRoot`、布局存储和所有官方子 slot。它声明单一 `layout.frame` 展示 slot，并以优先级 `0` 安装 `AppFrame`。`@dsh-anime/client-shell` 以优先级 `-100` 安装另一个框架，因此产品界面只替换排列方式。移除产品框架后，会显示保留相同会话和面板状态的官方布局。工具检查通过官方对话 owner 选中调用并打开官方 `DetailsPanel`；二次元框架只负责安排抽屉位置。

`@dsh-anime/client-character` 拥有 Character Pack v1 校验与只读提供、系统语音、角色状态投影，以及 `ui-anime` 设置命名空间中的默契度。角色包协议包括画布位置、分层身体、表情、口型与效果素材、带动画和 fallback 时序的全部状态、待机动作及中英文等级解锁。这些能力始终是浏览器／设置 sidecar，不会修改模型提示词、模型历史、会话持久化、工具或提供方选择。只有官方反馈修改成功后，产品才观察 `message-feedback/change`，并持久保存已计分 Turn 与评价身份，防止重连重复奖励。

## 桌面端边界

Electron 负责单实例锁、无边框窗口、启动页、utility process 生命周期、每日日志和打开产品目录。启用沙箱的 preload 只暴露这些操作所需的固定 API。上下文隔离保持启用，Node 集成保持关闭；产品组件不导入 Electron，普通浏览器构建仍然可用。

生命周期控制器拥有 30 秒启动期限、两次短时间断线重试、十秒稳定运行后的重试额度重置、结构化重启与关闭命令，以及终止进程前八秒的优雅关闭期限。致命启动消息和重试耗尽都会让应用停留在恢复页，提供重试、复制诊断和打开日志操作。桌面应用和 CLI 共享 `$DSH_HOME`；桌面应用只增加角色包和日志目录。窗口位置经过校验后，以原子替换方式保存在 Electron `userData`，profile 初始化则保留后续由用户拥有的 profile 与主目录 patch。

Electron utility process 的 Node 运行时不会暴露 Cordis Loader 使用的 Node 内部 ESM loader。因此，当内部 loader 不存在时，应用启动层会通过 Loader 公开 API 提供基于已安装宿主的 `importModule` 回调。没有模块根目录时，配置专用 HMR 仍然可用，也不要求内部模块缓存。

## 上游维护

官方仓库是只能拉取的 `upstream` remote，`upstream-base` 只快进到 `upstream/master`，稳定产品代码位于 `main`，Git `rerere` 记录重复冲突的解决结果。`.upstream.json` 记录官方目标、已验收提交和高冲突路径。受保护的同步命令会拒绝脏工作区，从 `main` 创建 `codex/sync-YYYYMMDD-<sha>`，合并 `upstream-base`，保留冲突和门禁失败现场，运行产品与官方门禁，并记录带日期的报告。已提交的修复只能从这个同步分支原地续验。只有全部成功时才会推进已验收记录。官方组合包配置项保持不变；二次元组合包是产品配置项的完整差异。

Windows 通过 Git for Windows Bash 和仅用于测试的直通 runner 执行标准 POSIX 录制 Web 回放语料，所有命令都位于新建的临时工作区。测试 scaffold 只在复制的预设目录中选择 Bash，为原生 Python 映射 fixture 的 `/tmp` 路径，在快照中归一化平台路径，并在结束时恢复环境。原生 Windows 验收场景会退出这条兼容路径，继续使用 PowerShell 和 ACL runner。发布的预设、产品 shell 选择和产品隔离行为均不受影响。

## 验证

相关测试覆盖布局框架回退与未变化的官方 Frame DOM、真实 install anchor profile 启动、没有 Loader 内部实现时基于已安装宿主解析嵌套模块、配置专用 HMR、Character Pack v1 拒绝与回退、状态优先级和释放时序、语音清理与播放控制、默契奖励与去重、Host 设置收敛、桌面协议与 IPC 允许列表、窗口位置，以及确定性的工作进程生命周期。只比较的浏览器矩阵会截取空白、长历史、工具详情、运行中、成功、审批、问题和错误状态，并成对覆盖视口、缩放、主题、模式、语言、动效、角色与侧边栏选择。Windows 审批 fixture 保留已录制的对话记录，同时将 POSIX 命令替换为等价的 PowerShell 请求，使它执行真实审批路径。Windows Electron e2e 会验证单实例锁、唯一命名 Harness utility process、随机本机端口及释放、preload 隔离、场景／工作与窄屏布局、普通浏览器行为、无系统语音、外链、短时间连续崩溃恢复与恢复页操作、窗口位置保存、截图和代码零优雅关闭。

## 考虑过的替代方案

**Tauri。** Tauri 可以减小外壳二进制体积，但产品已经嵌入基于 Node 的 Cordis 插件图和原生 Node 依赖。Rust 宿主仍然需要启动并管理独立 Node 运行时，只会增加第二套工具链和进程协议，不会移除 Web UI 或 Node 后端。

**仅使用浏览器皮肤。** 浏览器插件可以替换布局，但无法提供完整统一的无边框桌面窗口、单实例行为、受控后端生命周期或直接打开目录的命令。它适合作为兼容浏览器的展示层，但不能独自构成完整桌面产品。

**独立前端 fork。** 复制 Web 前端可以获得最大的视觉自由，但也会复制会话、设置、工具和插件集成。布局框架扩展可以保留同等的排列自由，同时继续由上游拥有业务能力。

**普通 Node 子进程。** 子进程也能承载 Harness，但 Electron utility process 提供由 Electron 管理的生命周期和结构化 parent port，同时无需在渲染进程中启用 Node。utility process 是范围更小的桌面集成。

## 后果

产品可以独立修改角色美术和布局，同时继续获得 Harness 官方功能。长期合并范围仅限布局扩展、profile 启动 API、消息评价事件、设置允许列表和兼容 Electron 的 Loader 回退。代价是这些少量面向上游的变化需要有意识地演练合并并维护回归测试；在另一项打包决定引入安装程序、签名与更新机制前，应用仍是从源码运行的 Windows 桌面程序。
