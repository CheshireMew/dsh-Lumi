# Agent Note: 标准仓库门禁的 Windows 兼容性

Status: implemented

[English](2026-08-14-windows-gate-compatibility.md) | 中文

## 问题

仓库的标准快照与聚合门禁必须在 Windows 上验证相同的产品行为，同时不能改变发布后的 Windows shell，也不能为每个 POSIX fixture 另录一份结果。多处测试启动器假定 `PATH` 中已经存在 `bash`，JSONL 还原会把原生路径作为未转义文本直接插入，嵌套 JSON 字符串又引入了第二层路径转义。单元测试聚合还会启动 16 个 fork worker，而 `check:all` 同时运行多项大量创建进程的门禁，导致 Git、Oxlint、Lefthook 与生命周期测试超过原本足以覆盖正常执行的截止时间。

## 决定

在 Windows 上，源码模式的示例启动解析会把 Git for Windows 的 Bash 目录加入 `PATH` 前端。共享 Loader smoke、ACP、SDK 与 Headless 子进程都会使用这项设置，但产品 profile 不受影响：发布的 Windows profile 仍选择 PowerShell 和 Windows ACL runner。平台专用的 Headless fixture 会直接验证该选择；SDK 的持久 Bash 场景则明确标记为仅支持 POSIX，因为其底层终端检查提供方按设计拒绝 Windows。

可移植会话 fixture 按 JSON 值还原，不再进行文本替换。若字符串字段本身包含 JSON，就递归解码，在语义值上替换 token，再逐层重新序列化。快照归一化同时识别原生文件系统写法及其 JSON 字符串写法；标准模式只会在以 cwd 为根的路径中，将一个或多个 Windows 分隔符统一成一个 `/`。因此，一份已提交 fixture 可以跨受支持宿主使用，同时不会接受损坏的 JSON，也不会隐藏无关反斜杠。

根 `devEngines.runtime` 声明让 pnpm 为开发脚本安装并锁定 Node 22.23.2，而 `engines.node` 只声明 Node 22 版本线。这样可以避开 Node 24 的 CJS lexer 原生崩溃；该崩溃可能在没有断言失败时直接终止隔离的 Vitest 进程。Node 22 目标快照只为其子进程禁用 `ExperimentalWarning`，因此 SQLite 稳定性提示不会破坏将 stderr 留给产品输出的断言。Windows 会把单元测试清单分成 8 个依次执行的 Vitest shard，每个 shard 使用 1 个 fork worker，以限制 Git、编译器、真实 CLI 与子进程测试的进程创建压力；显式测试过滤仍只执行一次普通调用。Oxlint 修复重试子进程断言在聚合门禁负载下允许 20 秒，与相邻的进程密集型用例一致。本地 `check:all` 在 Windows 上一次只运行一项顶层门禁，因为其子门禁已经拥有内部并行能力，而且其中多项会创建进程树。其他平台保留原有 worker 限制。产品超时不变。如果 ACP 子日志轮询在场景截止前一次都来不及完成，快照工具仍会报告具体子任务、turn 和请求的截止时间，而不会泄漏 Vitest 的通用等待超时。Web scaffold 会拒绝操作系统分配但被 Chromium 禁止访问的端口，并在安装回放 fixture 前重新启动临时 Host。原子文件替换会对 `EACCES`、`EBUSY` 和 `EPERM` 重命名失败进行有界重试，与既有的 vendor Loader 写入器保持一致，因此 Windows 上杀毒软件、索引器或 watcher 暂时持有文件句柄时，不会拒绝原本有效的设置修改。每项设置浏览器用例都独占一个全新的临时 Host、设置目录和浏览器页面，因此失败后残留的遮罩或偏好写入不会污染下一项用例。深色主题用例会先等待浅色偏好持久化，再选择深色；持久设置文件断言允许等待 30 秒，避免同步中的 Windows 卷把已经完成的 Host 写入误判为失败。这些断言会解析 YAML 文档并比较命名空间字段，不再依赖块格式或行内格式的序列化写法。

客户端领域依赖图门禁只接受官方代码树中已经存在的精确跨领域依赖，并拒绝任何新增依赖；从源码移除一项既有依赖时无需同步修改允许列表。vendor 重命名门禁也只排除精确文件：这些文件中的裸 `cordis` 表示运行时 id、本地化命名空间、预设 id 或产品术语，而不是 npm 包说明符。两项门禁都会继续执行，不再因官方基线本身而失败。

## 验证

Windows 无密钥快照覆盖完整 ACP 场景表、SDK 回放、Headless profile 命令、翻译提示词和内置 skill 快照。针对性的归一化测试固定嵌套 JSON 字符串中的 Windows 路径，并在启动浏览器前拒绝 Chromium 禁止访问的 4045 端口。单元测试聚合会在 Windows worker 限制下执行 Git worktree、合并驱动、安装锁、Oxlint 项目归属、生成的客户端目录和真实 subagent 生命周期文件。`check:all` 仍是最终聚合验收命令。

## 考虑过的替代方案

**提高测试超时时间。** 失败源于多个进程树争抢资源，而不是产品行为本身缓慢。延长截止时间会掩盖资源饱和、拖慢真实失败的反馈，而且在负载更高的 Windows 主机上仍然不稳定。

**为每个可移植快照另录一份 Windows 版本。** 大多数场景在不同宿主上的语义相同，平行 fixture 树只会复制预期行为并产生漂移。只有发布行为确实因平台而异时才保留平台专用 fixture，例如 PowerShell profile。

**关闭官方基线无法通过的静态门禁。** 关闭客户端领域或 vendor 重命名检查也会放过新增违规。精确清单既能保留门禁价值，也能显式呈现继承的技术债，并允许清单在无需额外维护的情况下自然缩短。

## 后果

Windows 可以验证标准仓库行为，而无需改变生产 shell 选择；只有产品表现本身确实因平台而异时才维护平台专用快照。Windows 上的聚合门禁耗时会增加，但失败重新具有明确诊断意义，不再依赖偶发的进程资源饱和。显式的客户端领域与重命名例外列表也是可审查的技术债清单：新增问题会立即失败，删除既有问题则始终改善结果。
