# Agent Note: 有界验证冷空白会话

Status: implemented

[English](2026-08-13-bounded-cold-blank-verification.md) | 中文

## Problem

Web 会话树会隐藏空白 Session，并把当前选中的空白项复用为 New Session。已附加 Session 可以从内存事件日志派生空白状态，但 `session.list` 通常不会加载每一份冷日志。把所有已物化的冷 Session 都视为非空，会暴露旧版本留下的空 Session；反过来，把 projection cache 中的 `blank: true` 当成当前事实，则可能在日志已经前进而 fail-soft cache 仍然陈旧时隐藏真实对话。

同一份冷列表还曾用 JSONL 工件的 mtime 作为 `updatedAt`。打开 Session 会追加 `session/end-seed`，因此即使没有真人 prompt，单纯拾起也会刷新 mtime，并把该 Session 提升到最近使用的对话之前。

## Decision

`dsh-host-apiproxy` 注册 `sessionListMetadata` 投影，其中包含 `blank` 与 `lastPromptAt`。已附加摘要直接用同一组函数折叠实时日志。`blank` 只在 `turn/start` 时从 true 单调变为 false；`lastPromptAt` 只在来源 kind 为 `user` 的 `user/message` 上更新。

冷摘要信任缓存的 `blank: false`，因为已包含 `turn/start` 的 checkpoint 前缀会始终保持非空。缓存的 `blank: true` 和 cache miss 都无法证明当前日志为空。当 persistence 通过 `locate()` 暴露物理工件，且其观测大小不超过 `coldBlankProbeMaxBytes` 资格阈值（默认每个 Session 1 KiB）时，网关调用 `readFrom(id, 0)`，从已存前缀折叠精确列表元数据。超过阈值的文件、不提供位置的后端、已消失的工件和读取失败都产生 `blank: false`，让 Session 保持可见。

`updatedAt` 取 `createdAt` 与 `lastPromptAt` 中较晚者。后续的[持久活动索引决策](../architecture/2026-07-29-durable-last-activity-index.md)把冷会话最近时间移入 `SessionPersistenceSnapshot`；有界工件读取现在只核验空白状态。每次异步冷读取后，网关都会再次检查实时 store；若另一请求期间已恢复该 Session，则用已附加摘要替换冷结果。

## Alternatives considered

**信任缓存的 `blank: true`。** 拒绝，因为 projection cache 有意允许持久日志前进到 checkpoint 之后。首个 `turn/start` 之后若发生崩溃或 fail-soft 写入失败，真实对话就会被隐藏，客户端还可能把它复用为 New Session。

**读取每一份冷日志。** 拒绝，因为列表延迟与 I/O 会随所有已存对话的总字节数增长。物理大小资格检查只针对能够低成本核验的小型历史工件，更大的未知项则向保持可见降级。该检查有意不为“让阈值与读取原子化”单独新增 persistence 操作：并发增长可能增加一次探测的读取成本，但新增事件只会保持可见，或把空白结果改为非空。

**把空白状态与最近时间存入 persistence index。** 本决策暂缓了范围更大的格式变化。后续的[活动索引决策](../architecture/2026-07-29-durable-last-activity-index.md)采用了精确最近时间，同时让空白状态继续走本文的有界核验路径：JSONL 使用按 revision 校验且可重建的伴随文件，SQLite 使用事务内 schema 字段。

**继续按 mtime 排序 JSONL。** 拒绝，因为 mtime 记录包括拾起边界在内的每一次工件写入，而非最近真人 prompt；其错误方向会把未经操作的 Session 提升到列表开头。

## Consequences

既有的小型空白 JSONL 工件无需依赖 projection cache 是否存在即可被隐藏，陈旧 cache 也无法隐藏已存的 `turn/start`。对于 cache 尚不能证明非空，且观测物理大小在配置阈值内的每个 Session，冷列表可能读取其工件。对默认交付的 Zstandard JSONL 后端，该阈值比较压缩后的字节数。

超过阈值的空白工件，以及来自不提供位置的后端的空白 Session 会保持可见。这种保守降级可能让 UI 多显示一条空记录，但不能隐藏真实对话。最近时间不再随 projection cache 降级，因为 persistence 会提供精确的真人 prompt 索引值。

网关自有投影是网关 fiber 的 effect；卸载网关会移除该 key。单元覆盖固定了临界大小资格、拒绝陈旧 true、复用单调 false、小日志精确最近时间、实时附加竞态、回退方向、真人 prompt 最近时间和 fiber 销毁。无密钥 Web snapshot 会启动发行版的压缩 JSONL 组合，在没有 cache row 的情况下播种一份小型冷空白工件，并验证侧栏不展示它。
