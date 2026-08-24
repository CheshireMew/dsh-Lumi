# Agent Note: Settings 协议与注册所有权

Status: implemented

[English](2026-08-23-settings-wire-and-registration-ownership.md) | 中文

## 问题

settings 服务存在三个所有权缺口。协议调用方必须记得传入 `describe({ redactSecrets: true })`，但脱敏器无法证明 union、intersection 和 transform 后面没有机密时，仍会返回其中的值；序列化 schema 与写入拒绝文本也可能包含机密字面值。namespace disposer 会直接移除注册，却不等待已经启动的 watcher，因此插件卸载完成后，属于该插件的回调仍可能继续运行。最后，旧注册方已经进入 `persist()` 的写入可能在它卸载、替代注册方出现后才完成，导致替代注册方仍停留在写入前的文档。使用 `{}` 构造属性还会让 `__proto__` 无法作为普通 JSON 数据保留。

## 决策

`SettingsProvider.describe()` 是同进程原值接口。`describeForWire()` 是唯一的客户端描述接口，不提供可选开关：它只保留 schema 可以证明安全的 JSON 字段，选择能够通过校验的 union 分支，合并 intersection 字段，并把 transform 或未知节点整体视为不透明的只写 slot。它会从解析值、base 层和 user 层移除所有已声明机密；`schemaForWire()` 会替换机密或不透明的 schema 节点，并移除机密默认值。ApiProxy 只使用该方法，并把非冲突类写入失败映射为稳定且不含值的消息。开放数据可能承载凭据时，schema 必须把该容器声明为 secret；因此 pi-ai 将完整 `headers` 映射标为只写。

注册现在拥有其 watcher 的结算过程。disposer 会把注册及其所有 watcher 标为不活动，仅在它仍是当前 owner 时移除 namespace，并等待已经启动的回调结束。遗留 scope 无法在卸载后新增 watcher。`persist()` 已经开始后，写入仍会到达存储。持久化完成后，服务会用最终提交的原始分节重新解析当时实际拥有 namespace 的注册；旧注册方不会收到通知，替代注册方会推进 revision 并收到已提交值。提供方发布文档时，会先推进原始 revision，再尝试校验解析值；schema 校验失败但仍是对象的分节也遵循该顺序。

settings 记录对 patch、嵌套路径编辑和分层合并统一使用自有属性定义与属性安全克隆。`__proto__` 等键会继续作为数据存在，绝不会触发继承来的 setter。深相等判断要求两侧都有同名自有属性，不再把原型属性当作匹配项。

## 曾考虑的替代方案

- **保留脱敏布尔值并审计每个 carrier**：拒绝，因为安全结果仍取决于每个未来协议调用方是否记得传入选项。
- **拒绝任何含 transform 的 namespace**：虽然安全，却会无谓地移除表单中其它可用字段。只把该字段设为不透明，可以保留已经证明安全的字段，并在不返回值的前提下暴露其配置状态。
- **owner 卸载时取消 persist**：提供方越过持久化点后无法做到，而且取消可能让进程状态与存储不一致。系统改为在写入后重新同步当前 owner。
- **注册方卸载时分离仍在运行的回调**：拒绝，因为回调属于注册方代码，仍可能访问同一 fiber 正在释放的资源。

## 后果

协议配置视图可能比同进程视图更少：即使不透明字段的某些实例不含凭据，它仍然只能写入。写入拒绝响应不再重复具体 schema 或提供方诊断；这些内容留在 Host 本地。注册方卸载可能等待较慢的回调，从而使资源所有权确定。替代注册方会观察到自己出现后才完成持久化的旧写入，与提供方文档保持一致，而不是取决于注册时机。

## 验证

settings 测试覆盖含机密的 union 与 intersection 值、不透明 transform、机密 schema 默认值、属性安全的 `__proto__` 写入、注册方 watcher 排干，以及延迟持久化期间的注册替换。ApiProxy 测试证明响应正文不会包含被拒绝的机密输入或 schema 中已清理的默认值。pi-ai 动态 settings 测试证明任意提供方标头仍可供适配器使用，而协议只能收到只写 slot 的设置状态。

## 风险

- 通用表单无法按结构编辑不透明字段；客户端必须把该字段作为一个整体值替换。这是无法证明 schema 输出关系时必须付出的代价。
- 永不结束的 watcher 现在会阻止其所属插件完成卸载。watcher 回调原本就有完成约定；新行为会明确暴露这一所有权问题，而不是让卸载错误地提前完成。
