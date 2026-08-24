# Agent Note：每个 Harness home 只允许一个 Host

Status: implemented

[English](2026-08-23-single-host-ownership-per-harness-home.md) | 中文

## 问题

产品 profile 会在 `$DSH_HOME` 下共享 Session、storage domain、设置、凭据、投影、反馈队列和 Workspace 记录。持久后端可以保证单次写入原子，但对应的 live owner 和变更队列只存在于进程内。因此，两个 Host 进程共用一个 home 时，可能接受彼此冲突的写入、提供互相分歧的内存快照，或让一个进程删除另一个进程仍在持有的 Session。只保护 JSON 文件或 SQLite 事务，无法协调这些生命周期关系。

所有权机制还必须在进程终止后安全恢复。持久锁文件、PID 检查或心跳可能在 owner 消失后残留、误认已经复用的 PID，或把暂停的进程猜成已经死亡。启动必须在初始化 profile、修复后备链接或访问 home 配置之前拒绝 live owner，而 owner 崩溃后不能要求用户手工清理。

## 决策

每次通过 `runProfile` 启动产品 profile 时，都要在组合 profile 或写入任何 profile／home 文件之前，先取得规范化 `$DSH_HOME` 的独占所有权。规范化过程会创建目录、解析文件系统别名，并在 Windows 上派生端点身份时统一路径大小写。所有权覆盖整个 home，而不是单个 profile，因为不同 profile 共享相同的持久权威和 live authority。不同的规范化 home 可以并行运行。

Windows 使用根据规范化 home 的 SHA-256 哈希派生出的 named pipe。其他平台尝试一组有界、确定的回环 TCP 端口。监听端会返回一份有大小限制和版本号的本机握手，其中包含 home 哈希、PID、profile 和启动时间。竞争方把匹配端点视为 live owner，并带着这些信息以非零状态退出。非 Windows 平台的握手还能识别碰巧占用候选端口的无关监听者，并继续尝试下一候选端口。

监听端点由操作系统持有，因此进程死亡后会自动释放，无需判断陈旧文件。正常完成、SIGINT、SIGTERM、显式失败拆除、组合失败和启动失败都会先等待插件树 dispose，再释放所有权。端点不会保持事件循环存活，因此已经完成的一次性进程可以正常退出。Host 运行期间若端点意外报错或关闭，进程会按致命故障结束，因为它已经无法再证明独占所有权。

该保证覆盖随附 CLI 和 Lumi Desktop，因为两者都通过 `runProfile` 挂载 profile。配置 dump 和插件管理不挂载 Host，因此不取得所有权。直接嵌入 Cordis 或使用自定义存储根目录会绕过产品启动器；这些调用方仍需自行保证单一写入者，或实现完整的跨进程协调协议。

## 备选方案

**分别给每个持久后端加锁。** 不采纳，因为 storage-domain 队列、live Session 所有权、投影状态、反馈队列和设置观察仍会在不同进程间分歧。后端锁只能串行化字节，不能形成统一的 Host 权威。

**每个 profile 使用一把锁。** 不采纳，因为不同 profile 会解析到同一个 `$DSH_HOME`，并可能写入相同的 Session、设置、凭据和 storage domain。

**使用带 PID 或心跳恢复的锁文件。** 不采纳，因为崩溃恢复会依赖陈旧文件清理和存活猜测。由操作系统持有的监听端点会在崩溃后自动释放，还能直接响应所有权探测。

**让第二个 Host 附着到第一个 Host。** 不采纳为启动器行为，因为附着需要目前不存在的、经过认证的发现和控制协议。浏览器客户端已经可以使用现有 Web Host，无需创建另一个 Host。

## 验证

单元测试会同时取得两个不同 home 的所有权，确认同一规范化 home 的第二个 owner 会被拒绝并得到 live owner 信息，确认释放操作幂等，并验证释放后的所有权交接。测试还会强制终止一个真实子进程，证明 Windows 无需显式清理即可释放 named pipe。

一条无密钥产品快照会用临时 home 启动真实源码和构建后的 `dsh` profile，观察第一个 Host 进入 ready 状态，确认第二个 Host 带着规范化所有权诊断退出，强制终止 owner，再确认替代 Host 可以用同一 home 进入 ready 状态。

## 后果

随附产品现在为一个 Harness home 下的全部状态提供唯一权威。后端仍保留文档所述的直接嵌入限制，但这些限制不再描述普通 CLI 或 Desktop 部署。用户若要启动另一个独立 Host，必须选择另一 `$DSH_HOME`；另一个浏览器窗口应连接已有 Host。

该 lease 是启动和生命周期不变量，不是持久数据格式。它不会向 home 添加文件，不改变存储 schema，也不需要迁移或陈旧锁恢复命令。
