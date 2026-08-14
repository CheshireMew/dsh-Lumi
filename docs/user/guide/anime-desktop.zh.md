# 二次元桌面版

[English](anime-desktop.md) | 中文

二次元桌面应用把 DeepSeek Harness 官方 Web UI 放进 Electron。官方侧栏、会话、工具、审批、问题、设置、工作区、插件、详情和会话存储全部保留；Electron 只管理原生窗口与本机 Harness 进程，二次元包只替换根布局并增加本地角色行为。

## 从源码安装和运行

当前验收平台是 Windows 10 或 11。请使用仓库支持的 Node.js 与 pnpm；需要时把 Electron 和 pnpm 缓存放在系统盘之外：

```powershell
$env:ELECTRON_CACHE = 'D:\Tools\electron-cache'
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
pnpm install --store-dir 'D:\Tools\pnpm-store'
pnpm run build:anime
pnpm run start:anime
```

`pnpm run dev:anime` 会启动 Web、二次元包和 Electron 的监视构建，并在桌面宿主产物变化后重启 Electron。`pnpm run compat:anime` 检查与上游相关的 profile、布局、角色和桌面接口；`pnpm run test:anime` 还会运行真实 Electron 测试；`pnpm run sync:upstream` 执行[二次元桌面架构](../../anime-desktop-architecture.md#upstream-synchronization)中说明的受保护官方合并流程。

## 共享数据与产品 profile

桌面版和 CLI 解析同一个 `$DSH_HOME`；没有设置该变量时，两者都使用 `~/.dsh`。桌面版只会在 `anime-desktop` profile 不存在时，用 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 和 `@dsh-anime/bundle-desktop` 初始化它。因此会话、模型配置、凭据、工作区、插件和设置在两个界面中都可见。桌面日志位于 `$DSH_HOME/logs/anime-desktop`，角色包位于 `$DSH_HOME/anime/packs`，Electron 窗口位置保存在 Electron `userData` 中。

不要让两个独立的持久 Web Host 同时使用同一个 `$DSH_HOME`。Electron 会强制应用单实例，第二次启动只会恢复并聚焦已有窗口。浏览器可以打开已经运行的 Anime Host URL，因为这不会创建第二个 Host。

## 界面、语音与默契度

场景模式突出角色，并把官方会话放在底部玻璃面板中；工作模式展开会话，把角色以较低透明度放到工作区后方。宽度小于 1100 像素时自动采用工作布局并隐藏角色，1100–1439 像素使用更紧凑的间距，1440 像素及以上显示完整场景布局。动画可以跟随操作系统，也可以强制使用完整或减少动态效果。

文本转语音通过 Chromium 使用系统已安装的语音，默认关闭，不上传或保存音频。自动朗读只处理当前可见会话中新完成的助手最终消息；打开历史、刷新、重连或切换会话都不会补读旧消息。朗读会去掉代码块、裸链接、表格、图片目标、Markdown 结构、推理和工具内容。自动朗读会在接近长度上限的自然句号处停止，手动朗读则可播放清理后的完整消息。窗口隐藏、会话切换、新的自动朗读开始或用户按下停止时，当前朗读会立即取消。系统没有可用语音时，语音控件会禁用，聊天仍可正常使用。

默契度只写入 `ui-anime` 设置命名空间，不会进入 Session 日志、模型提示词、上下文或模型选择。每天按本地日历计算，前 10 个获奖的无错误完成 Turn 各增加 2 点，当天第一次成功完成额外增加 3 点，当天第一次正面消息评价增加 5 点。已完成 Turn 与评价的身份会持久保存，因此刷新和重连不能重复计分。连续自然日使用会增加 streak；中断只重置 streak，负面评价不扣分。等级公式为 `floor(points / 30) + 1`，角色包只能用等级解锁本地表情、待机动作和气泡。

## Character Pack v1

从桌面标题栏打开角色包目录，或创建 `$DSH_HOME/anime/packs/<pack-id>`。目录结构固定为：

```text
<pack-id>/
  manifest.json
  preview.webp
  background.webp
  layers/
  expressions/
  effects/
```

每个 manifest 都使用 `schemaVersion: 1`。目录名必须与 `id` 相同；`id` 只能包含小写字母、数字、点、下划线或连字符，最长 64 个字符；每个素材声明都必须是对应目录内的相对路径。`preview` 和 `background` 固定为 `preview.webp` 与 `background.webp`。素材支持 SVG、PNG、WebP 和 JPEG。缺失文件、绝对路径、反斜杠、`.` 或 `..` 片段、无效状态引用、不支持的格式、重复 id 和不完整 manifest 都会被拒绝，内置 Lumi 回退不受影响。

下面的简化数值展示了完整字段结构；八个状态全部必填，每个状态都要有自己的动画对象：

```json
{
  "schemaVersion": 1,
  "id": "luna",
  "displayName": "Luna",
  "author": "Your name",
  "license": "CC-BY-4.0",
  "version": "1.0.0",
  "canvas": {
    "width": 720,
    "height": 1120,
    "anchor": { "x": 360, "y": 1080 },
    "safeMargin": { "top": 24, "right": 24, "bottom": 24, "left": 24 }
  },
  "assets": {
    "preview": "preview.webp",
    "background": "background.webp",
    "body": "layers/body.svg",
    "expressions": { "neutral": "expressions/neutral.svg", "happy": "expressions/happy.svg" },
    "mouth": { "closed": "layers/mouth-closed.svg", "open": "layers/mouth-open.svg" },
    "effects": { "sparkle": "effects/sparkle.svg" }
  },
  "states": {
    "idle": { "expression": "neutral", "fallback": "idle", "animation": { "keyframes": [{ "at": 0 }, { "at": 1 }], "loop": "repeat", "minDurationMs": 2400 } },
    "listening": { "expression": "neutral", "fallback": "idle", "animation": { "keyframes": [{ "at": 0 }, { "at": 1 }], "loop": "repeat", "minDurationMs": 1200 } },
    "thinking": { "expression": "neutral", "fallback": "idle", "animation": { "keyframes": [{ "at": 0 }, { "at": 1 }], "loop": "alternate", "minDurationMs": 1200 } },
    "tool": { "expression": "neutral", "fallback": "thinking", "animation": { "keyframes": [{ "at": 0 }, { "at": 1 }], "loop": "repeat", "minDurationMs": 1200 } },
    "waiting": { "expression": "neutral", "fallback": "idle", "animation": { "keyframes": [{ "at": 0 }, { "at": 1 }], "loop": "repeat", "minDurationMs": 1200 } },
    "success": { "expression": "happy", "effect": "sparkle", "fallback": "idle", "animation": { "keyframes": [{ "at": 0 }, { "at": 1 }], "loop": "none", "minDurationMs": 2200 } },
    "error": { "expression": "neutral", "fallback": "idle", "animation": { "keyframes": [{ "at": 0 }, { "at": 1 }], "loop": "repeat", "minDurationMs": 1200 } },
    "speaking": { "expression": "happy", "fallback": "idle", "animation": { "keyframes": [{ "at": 0, "mouth": "closed" }, { "at": 1, "mouth": "open" }], "loop": "alternate", "minDurationMs": 500 } }
  },
  "idleActions": {
    "breathe": { "animation": { "keyframes": [{ "at": 0 }, { "at": 1, "translateY": -3 }], "loop": "alternate", "minDurationMs": 2400 } }
  },
  "bondUnlocks": [
    { "level": 1, "expressions": ["neutral"], "idleActions": ["breathe"], "bubbles": { "zh": ["你好。"], "en": ["Hello."] } }
  ]
}
```

动画关键帧从 `at: 0` 开始，以 `at: 1` 结束；`loop` 可取 `none`、`repeat` 或 `alternate`。关键帧还可声明 `translateX`、`translateY`、`scale`、`rotate`、`opacity` 和 `mouth`。状态 fallback 必须是 `idle`、`listening`、`thinking`、`tool`、`waiting`、`success`、`error` 或 `speaking`。解锁等级必须递增，而且只能引用已声明的表情和待机动作。缺少 `license` 的有效角色包仍可在本机使用，但不能参与未来发布。

Host 会监听角色包目录，并向已连接客户端发送刷新事件。已选择的角色包如果消失或变得无效，应用会回退 Lumi，并显示非阻塞提示。

## 故障恢复

启动页最多等待 Harness 30 秒。工作进程异常退出后会自动重试两次；短时间连续退出超过上限时，会显示带有「重试」「复制诊断」和「打开日志」的恢复页。退出应用时会发送结构化关闭请求，等待八秒后才终止没有响应的工作进程。标题栏的「日志」会打开 `$DSH_HOME/logs/anime-desktop`：`main-YYYY-MM-DD.log` 记录 Electron 生命周期，`harness-YYYY-MM-DD.log` 记录工作进程输出。Web 服务器始终监听 `127.0.0.1`，端口由操作系统分配。

Windows 验收时，应选择工作区、创建会话、发送消息、观察流式回复与工具调用、处理一次审批或问题、播放语音、切换两种布局模式、重启应用，并确认同一会话恢复。真实模型步骤需要已经配置好提供商凭据。

## 分发边界

仓库固定使用 Electron `43.4.0`，但不包含安装程序、打包后的可执行文件、签名、更新器或发布流水线。内置分层 Lumi 美术是原创且协议完整的占位资源，不代表最终角色美术验收。
