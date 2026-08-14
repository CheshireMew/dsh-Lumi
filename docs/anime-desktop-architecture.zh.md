# 二次元桌面版架构

[English](anime-desktop-architecture.md) | 中文

桌面产品是 DeepSeek Harness 的增量发行版。上游继续拥有会话、插件、模型、工具、设置和 Web UI；Electron 负责原生窗口事项，`@dsh-anime/*` 包负责界面表现和角色行为。

## 职责归属

| 归属方 | 职责 | 不应负责 |
|---|---|---|
| Harness 官方包 | 会话、profile、插件、工具、设置、Web 传输和所有现有业务界面 | Electron 生命周期或二次元界面表现 |
| `@dsh-anime/bundle-desktop` | 在 `dsh-base` 和 `dsh-web-app` 后叠加两个二次元插件配置项 | 官方组合包配置项的副本 |
| `@dsh-anime/client-shell` | 用场景／工作模式安排官方布局 slot | 会话、侧栏、详情或浮层状态 |
| `@dsh-anime/client-character` | 角色包、状态投影、语音、好感度和相关设置／操作 | 会话持久化或模型可见提示词 |
| `@dsh-anime/desktop` | 单实例窗口、preload API、Harness utility process、目录和日志 | 让 Web 组件直接访问 Node 或 Electron |

官方 `LayoutRoot` 拥有布局存储，并声明 `layout.frame`、侧栏、会话、详情和浮层 slot。官方 `AppFrame` 以优先级 `0` 占用 `layout.frame`，二次元外壳以优先级 `-100` 占用它。卸载二次元外壳后会恢复官方框架，不会重新挂载或转移业务状态。

## 进程与启动模型

Electron 主进程先获取单实例锁，再创建无边框、启用沙箱的 `BrowserWindow`，并显示本地加载页面。专用 utility process 使用与 CLI 相同的 profile 启动 API，并按以下顺序加载组合包：

```text
@deepseek-ai/dsh-base
@deepseek-ai/dsh-web-app
@dsh-anime/bundle-desktop
```

工作进程在普通 Harness 主目录下初始化 `anime-desktop` profile，让官方 Web 服务器监听 `127.0.0.1:0`，并发送结构化 `starting`、`ready`、`log`、`fatal` 和 `stopped` 事件。主进程只接受匹配的本机回环 URL，并在就绪后让窗口跳转。启动期限是 30 秒；异常退出自动重试两次，稳定运行十秒后重置重试额度，短时间连续退出则显示恢复页。关闭和重启都发送结构化命令，工作进程在八秒内无法完成收尾时才会被终止。

启用沙箱的 preload 只暴露窗口控制、窗口状态观察、Harness 重启，以及打开日志和角色包目录的命令。上下文隔离保持启用，Node 集成保持关闭。这些选择使用 Electron 的[上下文隔离](https://www.electronjs.org/docs/latest/tutorial/context-isolation)、[contextBridge](https://www.electronjs.org/docs/latest/api/context-bridge)、[utility process](https://www.electronjs.org/docs/latest/api/utility-process)和[自定义窗口](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions) API。

## 持久化数据

桌面应用和 CLI 解析同一个 `$DSH_HOME`。桌面应用只新增 `$DSH_HOME/anime/packs` 与 `$DSH_HOME/logs/anime-desktop`，不会复制会话、profile、凭据或设置。只有在产品 profile 不存在时，才会用三个组合包完成初始化，因此首次创建后仍以用户自己的 profile 和主目录 patch 文件为准。Electron 窗口位置经过校验后，以原子替换方式保存在 Electron `userData`。二次元偏好、语音配置、不封顶的默契积分、每日奖励账本和已计分身份都使用 Host 权威的 `ui-anime` 设置命名空间，不会进入 Session 日志或模型上下文。

## 角色与浏览器模型

Host 会验证 `$DSH_HOME/anime/packs/<pack-id>` 下的 Character Pack v1 manifest 和引用素材，生成 renderer 可安全使用的同源 URL，只提供允许列表中的文件，并通过服务器发送事件通知目录变化。八个角色状态、动画时序、fallback 引用、画布位置、口型层和默契解锁引用都在持久 JSON 入口完成校验。已选择的无效角色包会回退到协议完整的内置 Lumi 分层素材。缺少许可证只允许本机使用，并把角色包标记为不可发布。

浏览器运行时从当前会话投影推导角色状态。等待和错误高于朗读，朗读高于工具与思考；工具状态带短暂释放延迟，完成状态使用当前角色包声明的时长。切换会话会重新记录当前可见历史，不播放旧会话的完成动画或语音。Chromium 语音合成只读取清理后的助手最终文本，utterance 生命周期和边界事件负责朗读状态与口型层。纯本地默契账本只消费新完成的成功 Turn 和变更成功后的 `message-feedback/change` 事件，不增加会话事件。

## 同步上游

`.upstream.json` 记录官方仓库、分支、最近一次验收通过的提交，以及需要人工复查的文件。`upstream` remote 从官方仓库拉取内容，本地已禁用它的推送地址。只有在使用个人 fork 时才添加 `origin` remote。

受保护的更新入口是：

```powershell
pnpm run upstream:status
pnpm run sync:upstream
```

`upstream:status` 只读。`sync:upstream` 会拒绝有未提交改动的工作区，获取官方提交和 tags，把 `upstream-base` 快进到最新官方提交，返回 `main`，创建 `codex/sync-YYYYMMDD-<sha>`，再合并 `upstream-base`。遇到冲突时会保留分支与合并现场。合并成功后依次运行 Anime 契约与构建、官方 GUI 与 Web replay、仓库检查和已构建 Electron 测试。脚本总会写入 `docs/upstream-sync/<date>.md`；只有全部成功时才更新 `.upstream.json` 和 `UPSTREAM_BASE.md`。Git `rerere` 已启用，可以复用重复出现的冲突解决结果。

解决源码冲突时，先保留上游意图，再重新应用少量产品扩展。不要把官方组合包配置项复制进二次元组合包。`pnpm-lock.yaml` 无法机械解决冲突时，应运行 `pnpm install` 重新生成，而不是手工拼接依赖记录。报告会列出官方提交、上游触及的受监视接缝、自动化结果，以及仍需人工执行的官方 Web、Anime 和真实模型检查。

## 发布边界

仓库固定使用一个 Electron 版本，并在 Windows 上完成验证。仓库不包含安装程序、应用打包、代码签名、自动更新器或发布通道；只有明确开始打包任务时，才会把这些内容引入桌面运行时。
