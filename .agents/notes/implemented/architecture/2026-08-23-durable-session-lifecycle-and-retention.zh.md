# Agent Note：持久 Session 生命周期与显式保留

Status: implemented

[English](2026-08-23-durable-session-lifecycle-and-retention.md) | 中文

## 问题

持久 Session 生命周期此前止于创建、追加、检查和恢复。归档可以隐藏 Session，却没有恢复或永久删除路径，因此共享 Harness home 会持续增长，产品自身没有保留管理操作。Workspace 记账、投影缓存和反馈表也可能在带外移除后继续保留引用。面向客户端的 Session 基线还会在一次响应中返回完整目录。

删除不能只等同于移除一行存储记录。实时 Session、正在从实时 owner 退役的写入控制器，以及为恢复而准备的未发布 Session 都仍然拥有该身份。父 Session 可能还有已持久化后代。如果进程在权威日志提交删除后、派生清理前停止，派生存储必须能够收敛。分页也不能混合多次最新观察：否则某个 Session 在翻页间被新 prompt 提升后，可能越过 cursor，并从客户端初始基线中消失。

## 决策

保留策略是显式的。归档可逆，并无限期保留日志。永久删除只能通过 `session.delete` 或底层 `SessionPersistence.delete` 发生；不会按年龄或存储压力自动清理。Workspace 浏览器会在末尾的专用分组或区段中呈现已归档 Session，并提供恢复和永久删除操作。破坏性操作必须经过阻塞式确认并请求递归删除；失败后确认框保持打开。

`SessionPersistence.delete(id, signal?)` 是存储权威。`PersistenceCoordinator` 将它与同 id 的追加、修复、preparation 和退役串行执行。删除进入 preparation I/O 队列前，就会拒绝实时身份和每个活跃 preparation 阶段（`loading`、`committing`、`reserved`）。这项预检防止删除插入 preparation load 与 reservation commit 之间。未知的已实体化 id 以 `SessionPersistenceNotFoundError` 拒绝。取消可在排队期间和后端工作开始前生效；后端删除一旦开始，其提交不可再拆分。

JSONL 会移除固定 transcript 和 `session.index.json`，随后只在 Session 目录为空时移除该目录；未知文件保持不动。SQLite 在一个事务中删除 `sessions` 行，由外键级联删除事件行。权威提交后，协调器发出 `session-persistence/deleted`。投影缓存、反馈和 Workspace 消费方收到事件后移除自身记录，也会在启动时独立剪除不存在的 Session id，从而覆盖权威删除与派生清理之间发生崩溃的情形。

Host 的 `session.delete` 会在写入前建立完整的持久／实时谱系。只要根或任何后代仍然实时，就在不执行删除的情况下拒绝。非递归请求遇到后代时拒绝。获准的树按确定的 id 顺序、子级优先删除。取消可以发生在两份已提交身份之间；重试同一递归请求会把已经缺失的后代视为已完成，并收敛到剩余树。`host/session-deleted` 表示持久移除，始终不同于只报告 activation teardown 的 `host/session-removed`。

`workspace.unarchiveSession` 会幂等地从持久归档集合中移除一个 id。Workspace 每次启动都会刷新持久化 header 目录，并在发布实体前剪除缺失的记账和归档引用；运行过程中则由删除事件执行同样清理。

`session.list` 采用有界快照分页：默认每页 50 条，最多 100 条。第一页先按 `updatedAt` 降序、Session id 升序排列一次完整观察。不透明 cursor 指向这份不可变观察内的 offset，因此后续页面不会因实时活动改变顺序而漏掉或重复 Session。未完成观察由可配置的 `sessionListSnapshotTtlMs` 和 `sessionListMaxSnapshots` 限制。观察过期或被逐出时返回 `session-list-cursor-stale`；客户端丢弃不完整尝试，并从第一页重启一次。格式错误的 cursor 返回 `session-list-cursor-invalid`，重复 cursor 会明确失败，客户端只发布完整的分页序列。

## 失败与恢复

递归删除会在首次提交前预检完整谱系，但多日志操作不会伪装成跨后端事务。子级优先顺序与“已缺失即已完成”的收敛规则，使中断后无需第二套删除账本即可恢复。派生清理同样发生在提交后，并可能独立失败；启动协调以 persistence 为权威移除残留。任何清理路径都不会重建已删除日志，也不会在存储提交前报告成功。

## 备选方案

**自动让旧的已归档 Session 过期。** 不采纳，因为归档是可逆的整理操作，不代表用户同意销毁历史。显式永久删除让本地桌面的保留策略可预测，不依赖隐藏计时器。

**从 Workspace 删除级联删除 Session。** 不采纳，因为 Workspace 是注册元数据。移除它会保留目录、用户文件、Session 和日志；永久删除 Session 仍是独立的确认操作。

**每个续传页面重新计算当前状态。** 不采纳，因为可变的 `updatedAt` 排序可能让尚未出现的 Session 移到此前 keyset cursor 之前。把 cursor 绑定到一份有界观察，才能保证重连基线完整。

**把递归删除做成一个全局事务。** 不采纳，因为 JSONL 身份是彼此独立的文件系统工件，持久化 seam 也支持多种介质。确定的子级优先提交和重试收敛，为所有后端提供相同的可恢复行为。

## 验证

持久化约定测试覆盖未知 id、实时所有权、提交后事件顺序和延迟身份。协调器测试覆盖删除与退役的竞态，以及每个恢复 preparation 阶段。JSONL 测试覆盖 transcript／index 移除、Windows 目录语义和未知文件保留；SQLite 测试覆盖事务级联删除。Workspace、投影缓存和反馈测试覆盖事件清理与启动剪枝。

ApiProxy 测试覆盖时间戳相同时的不可变分页、翻页期间发布新 Session、格式错误和已逐出的 cursor、非递归拒绝、实时后代零写入预检、确定的子级优先删除，以及取消／重试收敛。客户端运行时测试覆盖完整分页加载、陈旧快照重启、不发布失败的部分页面、拒绝重复 cursor、一元删除投影和外部删除帧。Workspace 浏览器测试覆盖归档区段、恢复、永久删除确认和可见失败恢复。

## 后果

产品现在拥有完整的普通 Session 保留路径：归档、恢复、确认后的永久删除、派生清理、崩溃协调、重连帧和有界客户端基线。底层 `list()` 和 `listSnapshots()` 协调操作仍然观察完整 persistence 目录；若要使其物理发现变成次线性，需要语义不同的带索引查询操作，但这不影响公开 wire 已经有界。

SQLite 会为本生命周期批次包含的持久活动列推进存储 schema。JSONL 保持 transcript 格式不变，并把活动索引存为派生 sidecar。删除、归档成员关系和列表 cursor 都不改变 Session 事件信封，因此 `SESSION_FORMAT_VERSION` 保持不变。
