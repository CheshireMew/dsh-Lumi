# Agent Note: 在会话索引中记录最后活动

Status: implemented

[English](2026-07-29-durable-last-activity-index.md) | 中文

## 问题

本决策实施前，一个冷会话（已持久化、未附加）对「用户上次是什么时候在这里发出 prompt」没有权威的已存储答案。`dsh-host-apiproxy` 从可选 projection cache 的 `lastPromptAt` 提供 `updatedAt`，缺失时回退到 `createdAt`，Web 客户端按该值为 Session 树排序。cache 采用 fail-soft 并异步写入 checkpoint，因此缺失或延迟的记录会让最近收到 prompt 的 Session 排得过旧。

网关以前会在可用时采用 JSONL 产物的 mtime。mtime 回答的是另一件事：这份产物上次是什么时候被写入。每一次持久写入都会刷新它，包括对撕裂尾部的截断修复、平衡中断轮次的合成 closer，以及拾起时追加的 [`session/end-seed` 边界](2026-07-30-session-end-seed-log-boundary.md)。这套近似会让 Session 仅仅因为被打开就提升排序。[有界冷空白验证](../bug-fix/2026-08-13-bounded-cold-blank-verification.md)移除了 mtime 排序，并把 cache 保守的「过旧」错误方向作为现阶段取舍。

已附加摘要可以折叠实时事件日志并选择最新的真人 `user/message`，但冷路径有意不读取大日志。为计算 `updatedAt` 而读取每一份日志，会让 `list()` 的开销随对话总字节数而非 Session 数量增长。用于 metadata 验证的 1 KiB 冷读取可以让符合条件的小产物得到精确的最近时间，但不能让大日志的排序精确。

精确的冷排序要求持久层把活动元数据与每份日志的 revision 一起返回，而不是让网关继续近似。

## 决策

`SessionPersistenceSnapshot` 在 header 与 revision 旁携带 `lastPromptAt`。`dsh-session` 中的 `advanceLastHumanPromptAt()` 统一规定规则：只有 `source.kind` 为 `user` 的 `user/message` 才推进时间。已附加 Session 摘要与持久协调器都调用这个 reducer，因此注入式 user message、拾起边界、恢复 closer 和其他写入都不会影响排序。

协调器在每个按 id 划分的持久状态中保留精确时间。它在调用 `appendBatch` 前算出批次后的值，在调用 `commitRepair` 前算出修复后的值；后端把该值与日志变更一起持久化。

- **SQLite** 把 `last_prompt_at` 存在 `sessions` 表中，与事件 INSERT、修复 DELETE、closer 和 revision 递增放在同一个事务里更新。表结构变化把 `SCHEMA_VERSION` 推进到 16；依据预发布阶段不迁移的规则，其他所有非零版本都被拒绝。
- **JSONL** 保持 header 不可变、transcript 仅追加。可替换的 `session.index.json` 伴随文件保存 transcript revision、`lastPromptAt` 和完整性摘要。transcript 先完成持久化；匹配的伴随文件让列出工作保持常量大小。伴随文件缺失、落后、语法错误或完整性损坏时，后端会稳定读取一个 revision 的 transcript、用 reducer 精确折叠，再原子替换伴随文件。日志追加后若伴随文件写入失败，只记录警告；不能把已经提交的 append 变成重试，否则会重复事件 seq。

`dsh-host-apiproxy` 对每个冷会话的 `updatedAt` 使用索引值。Projection cache metadata 只再参与空白状态；最近活动时间不再依赖 cache 是否安装、checkpoint 时机、产物大小或 `locate()` 能力。引入索引前的 JSONL 产物会在第一次列出时重建。SQLite 旧数据库会被拒绝，因为发布前明确不支持 schema 迁移。

## 考虑过的替代方案

**在冷路径上读取日志。** 它按构造就是正确的，也不需要改动格式，但会让只读 header 的列举失去意义：`list()` 的开销将随日志总体量增长，而 web 会话树会扇出到存储中的每一个会话。mtime 近似的存在，正是为了避开这个选项。

**保留 mtime，但把边界的写入排除在它之外。** 否决的理由是做不到，而不是不合意：mtime 属于文件系统，不属于后端。除了在每次边界写入之后把时间戳复原，没有别的办法能保住它，而那样做会与任何并发读取方产生竞态，也会对这份产物撒谎。

**仅在确实发生了修复时才写入边界。** 这能降低出现频率，而[边界 Agent Note](2026-07-30-session-end-seed-log-boundary.md)已经否决过它：谓词对有序重启同样必须成立。用一条正确性不变式去换时间戳的准确度，方向是错的。

**从投影缓存派生活动时间。** `session-projection-cache` 会折叠水位线之后的尾部，无需改变持久格式，但它是可选且 fail-soft 的。缺失或 checkpoint 延迟会让排序取决于 cache 是否存在以及是否新鲜，因此无法为列出流程提供精确值。

## 后果

- 冷 Session 排序无需读取普通大日志即可保持精确；Session 恢复后没有新 prompt 就退出，排序不会改变。
- JSONL 通常为每个已实体化 Session 增加一个小型可变文件。恢复可能一次性解析受影响的 transcript，之后列出工作重新只与逐 Session metadata 有关。
- `listSnapshots()` 对提供方提出更强义务：每一行的 revision 与 `lastPromptAt` 必须描述同一个精确存储前缀。
- 新增真人直接消息来源时只需修改共享 reducer，不能分别改网关和后端谓词。

## 验证

- 共享持久契约在 memory、JSONL 与 SQLite 提供方上证明：注入式 user message 和非 prompt 事件不推进索引，后续真人直接 prompt 会推进。
- JSONL 测试覆盖索引缺失、语法错误、完整性损坏、revision 落后和重新打开；revision 不匹配会强制精确重建。
- SQLite 测试覆盖事务内活动时间更新，并钉住 `SCHEMA_VERSION = 16`，包括拒绝更旧和更新的 schema。
- ApiProxy 冷列表测试提供持久索引行，并证明异步空白探测期间若 Session 变为已附加，仍会用实时摘要替换冷摘要。
- 持久层与网关的定向测试共 399 项通过；扩展 snapshot 记录后，全仓类型检查通过。

## 风险

**持续的外部 writer 会延迟重建。** JSONL 在重建索引前必须获得 revision 稳定的 transcript。writer 若始终不给一次 read/check 往返留下稳定间隔，列出操作会被推迟；存储 ownership policy 应阻止竞争性的活动 writer，而不能削弱 revision 校验。

**恢复成本随损坏 transcript 增长。** JSONL 索引缺失或无效时，需要完整解析一次，包括解压缩。这属于异常恢复工作；普通列出仍不随 transcript 字节数增长。

## 相关

- [有界冷空白验证](../bug-fix/2026-08-13-bounded-cold-blank-verification.md)——继续把直接冷读取限制在小产物空白状态核验上。
- [种子结束日志边界](2026-07-30-session-end-seed-log-boundary.md)——让 mtime 不适用的非 prompt 写入之一。
- [会话持久化](2026-06-14-session-persistence.md)——规定仅追加 transcript 与崩溃恢复规则。
- [共享持久化写入协调器](2026-06-18-shared-persistence-write-coordinator.md)——负责把批次后与修复后的索引值传给后端。
