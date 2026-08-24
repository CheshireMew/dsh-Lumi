# Agent Note: 存储根目录落点与派生介质恢复

Status: implemented

[English](2026-07-28-storage-root-and-derived-medium-recovery.md) | 中文

## 问题

持久投影缓存（[决策记录](../../proposed/architecture/2026-07-27-session-projection-and-command-log.md)，已作为 `dsh-session-projection-cache` 落地）暴露了它所依托的存储基座的两个缺口。二者都是 domain-KV 栈（[设计](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md)）的属性而非缓存自身的问题，且都首先影响缓存，因为它是这条栈上第一个*派生*介质。

**文件存放位置。** 共享 base 将会话存储默认为全局 harness home（`$DSH_HOME/sessions`，默认 `~/.dsh/sessions`），出厂 Web overlay 则通过同一段 `!!js` 表达式把 `storage-json.root` 锚定到 `$DSH_HOME/storages`（`apps/cli/config/web.cordis.yml`）。`JsonStorageBackend` 在构造时解析一次配置根，因此后续 `process.cwd()` 变化不会把同一后端拆到不同目录。从不同目录启动时，会话、工作区记录与投影检查点仍使用同一个稳定位置。

**恢复方式。** 在健康介质内部，缓存继续自愈：`stateVersion` 不匹配的行会被丢弃并重新折叠，日志缩短到行水位以下会触发一次全量重读，后台写入采用 fail-soft。介质层面由 `session_projcache` 明确声明自己可以丢弃。缓存单元被截断、手改、版本变更或记录不符合 schema 时，系统会移除该单元并只重开一次；具有权威性的 `workspace` 和 `message_feedback` 域发生同类损坏时仍会阻止启动。普通 I/O 和配置错误也继续明确失败。

## 决策

两个独立改动，一个缺口一个。

### 全局唯一存储根，并在构造时解析一次

- 出厂 Web overlay 通过 app-boot 提供的 `dshHomePath('storages')`，直接在 `storage-json` 行内把 `root` 锚定到 `$DSH_HOME/storages`（默认 `~/.dsh/storages`，与 `~/.dsh/sessions` 并列；目录名不带点，因为 home 本身已是隐藏树）。该辅助函数委托给规范的 `dsh-home-paths` 解析器，会话根也使用同一个函数，无需重复其回退和波浪号规则。按行覆盖使用个人 `~/.dsh/config.yaml` patch 层。Web e2e scaffold 会把该行 patch 到临时绝对根，因此测试不接触用户 home。
- `JsonStorageBackend` 在构造时对配置根执行一次 `resolve(config.root)`。后续 `process.cwd()` 变化不会把同一后端拆到多个根。SQLite 存储后端已经解析其路径。
- 适用 pre-release 立场（已按此执行）：不做迁移垫片。曾在 `<cwd>/.storages` 下缓存过的部署要么全部重新派生（工作区从 header 索引重新 bootstrap；投影缓存惰性重折），要么手动把两个 json 文件挪一次。

### 声明派生介质：损坏时重置而非拒绝

- `DomainSpec` 增加 `recovery?: 'reject' | 'reset'`（默认 `'reject'`）。spec 对象已经是一个域的身份与布局的真源；其介质是权威还是派生属于同类事实，落在同一处。`session_projcache` 声明 `'reset'`；`workspace` 保持默认。
- `KvFacet` 增加一个原语：`destroy(descriptor): Promise<void>`——整体移除该 unit 的介质（json：删文件；sqlite：drop 该 unit 的表）。与 `open` 一样，它是后端存储原语，不是策略。
- `DomainFacility.open` 在 spec 声明 `'reset'` 且 open 恰以损坏类错误失败时——`StorageError('version-mismatch' | 'malformed-medium')` 或 `DomainError('invalid-record')`——记一条命名该域和被丢弃介质的警告，调用 `destroy`，再空开一次。其余一切失败（`backend-not-found`、`facet-unsupported`、`already-open`、I/O 错误）无论声明与否都保持大声：配置错误和环境故障不是介质损坏。重试单发——第二次失败原样传播，持续失败的介质不会成环。
- 有了这个，缓存域 spec 的 version 字段才获得其本意：bump `version`（或让 zod 拒绝漂移行）真正丢弃整个介质，缓存经正常写点和冷读重建——恢复阶梯的最外一档，与已落地的行级各档对齐。

## 备选方案

**保持按启动目录的 `.storages`（改动前现状）**——拒绝：会话是全局的，所以每个从会话派生的介质都与自己的真源劈叉；缓存的动机场景（一次列出全部会话）结构性丢行，工作区注册表索引着从另一个启动目录看不见的会话。

**launcher patch + `storageRoot` profile 键**——未采：一行 yml `!!js` 表达式即达全局根，与会话根的既有分层完全一致；launcher patch 多引入一个改写点，profile 键在有真实消费方前是空席（按行覆盖已有个人 config.yaml patch 层可用）。

**只把投影缓存的 route 指到全局根，`workspace.json` 留在 per-cwd**——拒绝：工作区注册表有一模一样的全局 vs per-cwd 错位，而且用户选择把缓存放在 `workspace.json` 旁边——一个 hub 根让介质同址、心智模型单一。

**缓存插件本地恢复（在 `SessionProjectionCache[Service.init]` 捕获损坏错误、删文件、重开）**——拒绝：插件不越过后端抽象就叫不出介质路径，且未来每个派生域都要重抄同一段 catch；facility 是唯一已经在分类 open 失败的地方。

**损坏时退到内存态临时域**——拒绝：进程余生静默降级为仅内存，损坏文件永不自愈；下次启动照样失败。

**把损坏介质改名旁置（`<unit>.json.corrupt-<ts>`）而非删除**——未选：派生介质的损坏字节没有恢复价值（日志才是真源），残骸无界累积；删除才是诚实的操作。若未来某个*权威*域想要重置语义，旁置改名才是对的——这正是 `recovery` 按 spec 声明的理由。

**所有域一律自动重置（不加 spec 字段）**——断然拒绝：`workspace.json` 是权威用户数据；版本 bump 时静默重置会毁掉工作区。权威性是域的属性，必须由其所有者声明。

## 验证

- 从任意目录启动 `dsh` 都读写同一份 `$DSH_HOME/storages/*.json`（默认 `~/.dsh/storages`）；按行覆盖使用个人 config.yaml patch 层，JSON 后端的相对根回归测试证明构造时解析生效。
- `session_projcache.json` 被截断、版本 bump 或 schema 漂移时，组装干净启动：一条警告命名被丢弃的介质，文件消失，缓存经正常运转重建，冷列表列随会话重新 checkpoint 逐步回归。
- 同样的损坏发生在 `workspace.json` 上仍大声拒绝启动。
- facility 测试覆盖全部损坏类型、单次重试、非损坏错误传播和权威域默认策略。共享后端约定测试证明：两个出厂后端的 `destroy` 都会拒绝仍然存活的单元，对不存在的单元保持幂等，并移除记录与全局值。

## 后果

- 派生域启动不再依赖保留可重建的缓存文件。恢复可能增加下一次冷读成本，但缓存状态绝不能取代会话日志。
- 每个 KV 后端都要实现同一套已关闭单元 `destroy` 原语。新增后端时，共享销毁约定测试现在属于必验路径。
- 相对 JSON 根目录的含义在构造时确定。后续更改 `process.cwd()` 不会影响现有单元，也不会影响更改后才首次打开的单元。

## 风险

- **错误分类失误导致自动删除健康文件。** 由封闭的损坏类清单缓解：重置只在三个确定性解析期代码上触发；ENOENT 本来就是「空 unit」，一切 I/O 错误（EACCES、EIO）大声传播。单发重试把爆炸半径限定为每次 open 至多一删。
- **根迁移改变既有 checkout 的查找位置。** 在 pre-release 立场下接受（后端拒绝旧格式、无外部消费方）；上文为在乎 per-cwd `workspace.json` 内容的人记录了一次性手动搬移。
- **`destroy` 是存储 seam 上新增的破坏性原语。** 唯一调用方是 facility 的声明重置路径；后端约定将其记档为 facility 专属，任何面向模型或面向用户的路径都触不到它。
