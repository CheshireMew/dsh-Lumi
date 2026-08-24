# 用户设置

[English](settings.md) | 中文

[dsh-settings](../../packages/settings/settings) 的用户设置 seam 持有一份按 namespace 分节的用户文档，并把每个已注册 namespace 解析为：schema 默认值，然后注册方的组合 `base`，最后用户分节。[dsh-settings-file](../../packages/settings/settings-file) 这类提供方存储原始文档并推送外部编辑；消费方插件注册 schema 后读取或观察解析值。组合配置仍留在 `cordis.yml`——namespace 只承载用户可编辑子集。

来源：[`packages/settings/settings/src/index.ts`](../../packages/settings/settings/src/index.ts)

## 标识

namespace 命名用户文档中一个归插件所有的分节。brand 防止调用方将设置 namespace 与在包或进程之间传递的其他 id 混用；构造时校验小写 kebab-case 语法。

```ts type-equiv
/** Nominal id of one registered settings namespace. */
type SettingsNamespace = Branded<'SettingsNamespace'>
```

## 注册

注册把 Schemastery schema 绑定到调用方插件 fiber 上的 namespace。dispose（资源释放）该 fiber 时，系统会停用其观察者、等待已经启动的回调，并移除 namespace。已经进入提供方持久化的写入仍会完成；如果替代注册方此时拥有该 namespace，它会从最终提交的分节重新解析。options 携带组合层、owner 的生效时机，以及一个可选的、用于校验 schema 表达不了的约束的钩子。

```ts type-equiv
/** Configuration surfaces a namespace owner may explicitly opt into. */
type SettingsSurface = 'configuration-client'
```

```ts type-equiv
/** Registration options beyond the namespace schema. */
interface SettingsRegisterOptions<T> {
  /** Composition-layer values resolved below the user layer (entry-config subset). */
  base?: Partial<T>
  /** Owner's effect timing, surfaced to configuration UIs; defaults to `live`. */
  applies?: SettingsApplies
  /** Configuration surfaces allowed to read and write this namespace. */
  surfaces?: readonly SettingsSurface[]
  /**
   * Reject a resolved section the owner could not act on, for constraints its
   * schema cannot express — a cross-field requirement, or one field's validity
   * depending on another's. Throwing here refuses the *write* that produced the
   * value, so a caller learns at `update`/`replace`/`mutate` instead of storing
   * something that would silently disable the owner.
   *
   * Kept separate from the schema because the schema is also what a
   * configuration surface renders and what an absent section resolves through;
   * folding a cross-field check into it would change both.
   *
   * Once the owner is registered, a stored section that fails this keeps the
   * namespace's last good value and warns, exactly as a schema failure does,
   * so an externally edited document cannot strand a running owner. At
   * registration there is no last good value yet, so a stored section that
   * already fails rejects the registration itself — again exactly as a schema
   * failure does.
   * @param value - the resolved section, schema-valid by construction.
   */
  validate?: (value: T) => void
}
```

`surfaces` 让客户端暴露范围由 owner 决定。Host 调用 `namespacesFor('configuration-client')`，只暴露明确选择加入的注册项，因此增删可配置插件时不会留下第二份过期的 Host 允许列表。`validate` 在 schema 接纳该值之后运行，因此它看到的默认值和组合 base 与 owner 实际看到的完全一致。`dsh-llm-pi-ai` 用它在写入处拒绝自己无法服务的提供方 profile，而不是先存下来、再让该 namespace 下每条路由失效。

`applies` 是 UI 提示而非机制：`restart` 的 owner 只是从不 watch，其值在构造期读取一次，配置界面可为待生效变更加标。

```ts type-equiv
/** When a namespace's changes take effect for its owner. */
type SettingsApplies = 'live' | 'restart'
```

## Owner scope

scope 是面向 owner 的句柄。`update` 把稀疏 patch 只合并进用户分节（绝不进 `base`）；`replace` 整体替换分节，是删除/重置路径——替换中缺席的键重新继承 `base` 与 schema 默认值。同一 namespace 的写入按调用顺序串行，解析值是深冻结快照。

```ts type-equiv
/** Owner-facing handle for one registered namespace. */
interface SettingsScope<T> {
  /** Current resolved value: schema defaults, then `base`, then the user layer. */
  get(): T
  /**
   * Observe committed changes to this namespace's resolved value. Invocations
   * of one callback run asynchronously, one at a time, in commit order; a
   * rejection is contained and logged like a sync throw. After the disposer
   * returns, no further invocation starts — one already queued is skipped;
   * one already started still settles. Registrant and service disposal both
   * wait for started invocations they own.
   * @param callback - invoked after each commit with the next and previous values.
   * @returns the disposer removing this observer.
   */
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
  /**
   * Merge a partial patch into this namespace's user layer and persist it.
   * @param patch - plain-object patch over the user section; JSON-compatible data
   * only (non-JSON values reject with their path before anything persists).
   */
  update(patch: object): Promise<void>
  /**
   * Replace this namespace's user section wholesale; absent keys re-inherit
   * the composition `base` and schema defaults (`replace({})` resets all).
   * @param section - the complete next user section; JSON-compatible data only,
   * as for {@link update}.
   */
  replace(section: object): Promise<void>
}
```

## 描述符

`describe()` 返回仅限同进程使用的原值 descriptor：Schemastery `toJSON()` 信封、解析值，以及分离出的 `base`／`user` 层。`describeForWire()` 是独立的默认拒绝不确定内容的客户端接口。它只保留 schema 可以证明安全的 JSON 字段，把 transform 与未知 schema 节点整体设为不透明内容，从三层值中移除 `role('secret')` 字段，清除序列化 schema 中的机密字面值，并枚举 `{path, set}` slot，使页面能在不接收机密的前提下渲染只写输入框。ApiProxy 只使用该方法，并为 schema 或提供方写入失败返回不含值的文本。

```ts type-equiv
/** One registered namespace as surfaced to configuration UIs. */
interface SettingsDescriptor {
  /** The registered namespace. */
  ns: SettingsNamespace
  /** Serialized schemastery schema (`schema.toJSON()`). */
  schema: unknown
  /** Current resolved value. */
  value: unknown
  /**
   * Monotonic revision of the raw user section this descriptor was read at.
   * Send it back as `expectedRevision` on a write to refuse a stale one.
   */
  revision: number
  /** Registrant's composition `base` layer (detached), when one was declared. */
  base?: unknown
  /**
   * Raw user section from the stored document (detached), when one exists and
   * is well-formed; a field's presence here is what marks it user-overridden.
   */
  user?: unknown
  /** Owner's declared effect timing. */
  applies: SettingsApplies
  /** Schema-declared secret positions; present on {@link SettingsProvider.describeForWire} results. */
  secrets?: RedactedSecret[]
}
```

只持有脱敏 descriptor 的调用方无法安全地重建分节，因此删除改以路径 op 传递。每个 descriptor 还携带针对原始分节的 `revision`；写入可以把它作为 `expectedRevision` 送回，不再匹配的写入会被拒绝，而不会覆盖先落地的写入。
```ts type-equiv
/**
 * One path-addressed edit to a namespace's user section. Path mutation exists
 * for a caller holding an INCOMPLETE view of the section — a configuration UI
 * reads the redacted descriptor, which by construction never received the
 * `role('secret')` fields. Such a caller can name the field it means without
 * restating the section: a wholesale `replace` rebuilt from a redacted
 * document silently deletes every secret the wire never returned.
 */
type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }
```

## 变更提交

每次提交的变更——进程内写入或提供方观察到的外部编辑——在新值成为权威值之后发出 `settings/updated (ns, next, prev, source)`，解析值深相等时绝不发出。source 标记区分两条入口路径。

```ts type-equiv
/** Origin of one committed settings change. */
type SettingsUpdateSource = 'update' | 'provider'
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsettings--settingsprovider-abstract-seam"></a>

### `ctx.settings` — `SettingsProvider` (abstract seam)

Abstract settings service. Providers implement raw-document storage (`load`/`persist`) and push external changes through Settings.publish; the base class owns namespace registration, resolution, validation, change detection, and the `settings/updated` commit event.

```ts cordis-catalog
/**
 * Prepare the provider's user-editable document for a native editor. File
 * providers may materialize an absent document before returning its path;
 * non-file providers return undefined.
 * @returns the absolute local document path, or undefined for non-file storage.
 */
prepareDocument(): Promise<string | undefined>

/**
 * Register a namespace schema and receive its owner scope. The registration
 * is an effect on the calling plugin's fiber: disposing that fiber
 * deactivates its observers, waits for started callbacks, then removes the
 * namespace. An invalid stored section fails the registration itself — the
 * earliest point where the schema can judge it.
 * @param ns - unique namespace; duplicate registration fails loud.
 * @param schema - schemastery schema resolving this namespace's value.
 * @param options - composition `base` layer and effect timing.
 * @returns the owner scope for reads, observation, and updates.
 */
register<T>(ns: SettingsNamespace, schema: z<T>, options?: SettingsRegisterOptions<T>): SettingsScope<T>

/**
 * Describe every registered namespace for configuration surfaces, including
 * the composition `base` and raw user layers so a form can mark which fields
 * the user overrode (presence in `user`) and what a reset returns to.
 * @returns one descriptor per registered namespace, in registration order.
 */
describe(): SettingsDescriptor[]

/**
 * Describe every namespace for an untrusted client. This is a separate
 * method so a wire carrier cannot forget an opt-in flag: values and layers
 * contain only schema-proven JSON fields, opaque nodes become write-only
 * slots, and serialized schema literals are scrubbed.
 * @returns one fail-closed descriptor per registered namespace.
 */
describeForWire(): SettingsDescriptor[]

/**
 * List namespaces whose owners opted into one configuration surface.
 * @param surface - configuration surface requesting access.
 * @returns registered namespaces in registration order.
 */
namespacesFor(surface: SettingsSurface): SettingsNamespace[]

/**
 * Read one registered namespace's resolved value.
 * @param ns - the namespace to read.
 * @returns the resolved value, or `undefined` while unregistered.
 */
get(ns: SettingsNamespace): unknown

/**
 * Merge a patch into one registered namespace's user layer, validate the
 * resolved candidate, persist through the provider, then commit and emit.
 * A validation failure rejects before anything is persisted. Writes to one
 * namespace are serialized: concurrent updates apply in call order, each
 * merging over the previous write's committed section.
 * @param ns - the registered namespace to update.
 * @param patch - plain-object patch over the user section.
 * @param expectedRevision - the descriptor `revision` the caller read; a
 *   namespace that moved past it rejects with {@link SettingsConflictError}.
 */
async update(ns: SettingsNamespace, patch: object, expectedRevision?: number): Promise<void>

/**
 * Replace one registered namespace's user section wholesale, validate,
 * persist, then commit and emit. Keys absent from `section` fall back to the
 * composition `base` and schema defaults — this is the removal/reset path a
 * merge-only patch cannot express (`replace({})` re-inherits everything).
 * @param ns - the registered namespace to replace.
 * @param section - the complete next user section.
 * @param expectedRevision - the descriptor `revision` the caller read; a
 *   namespace that moved past it rejects with {@link SettingsConflictError}.
 */
async replace(ns: SettingsNamespace, section: object, expectedRevision?: number): Promise<void>

/**
 * Apply path-addressed edits to one registered namespace's user section,
 * validate, persist, then commit and emit. The ops are applied to the
 * section as it stands when the write reaches the front of the queue, so a
 * caller never has to restate fields it did not touch — and, crucially,
 * cannot delete fields it never saw. This is the write path for any caller
 * holding a redacted view; `replace` remains the wholesale reset.
 * @param ns - the registered namespace to edit.
 * @param ops - ordered path edits; later ops observe earlier ones.
 * @param expectedRevision - the descriptor `revision` the caller read; a
 *   namespace that moved past it rejects with {@link SettingsConflictError}.
 */
async mutate(ns: SettingsNamespace, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
```

Source: [`packages/settings/settings/src/index.ts:367`](../../packages/settings/settings/src/index.ts)

<a id="settings-events"></a>

### `settings/*` events

<a id="settingsdocument-updated--emit"></a>

#### `settings/document-updated` — emit

One registered namespace's RAW user section changed, whether or not the resolved value did. `settings/updated` is the consumer-facing event and stays deep-equal-gated; this one exists for configuration surfaces, which must learn that a field went from inherited to overridden (same resolved value, different meaning) and that their held revision is stale. Listener containment matches `settings/updated`.

```ts cordis-catalog
/**
 * One registered namespace's RAW user section changed, whether or not the
 * resolved value did. `settings/updated` is the consumer-facing event and
 * stays deep-equal-gated; this one exists for configuration surfaces,
 * which must learn that a field went from inherited to overridden (same
 * resolved value, different meaning) and that their held revision is
 * stale. Listener containment matches `settings/updated`.
 * @param ns - the namespace whose stored section changed.
 * @param revision - the namespace's new revision.
 * @mode emit
 */
'settings/document-updated'(ns: SettingsNamespace, revision: number): void
```

Source: [`packages/settings/settings/src/types.ts:48`](../../packages/settings/settings/src/types.ts)

<a id="settingsupdated--emit"></a>

#### `settings/updated` — emit

Committed change to one registered namespace's resolved value. Emitted after the provider persisted (for `update`) or published (`provider`) the change; never emitted when the resolved value is deep-equal. Listener failures are contained and logged — a sync throw and an async rejection alike — except `INVARIANT`-coded failures, which rethrow after every listener ran; that rethrow reaches the emitter only from synchronous listeners, so invariant checks on this event must not be async functions.

```ts cordis-catalog
/**
 * Committed change to one registered namespace's resolved value. Emitted
 * after the provider persisted (for `update`) or published (`provider`)
 * the change; never emitted when the resolved value is deep-equal.
 * Listener failures are contained and logged — a sync throw and an async
 * rejection alike — except `INVARIANT`-coded failures, which rethrow
 * after every listener ran; that rethrow reaches the emitter only from
 * synchronous listeners, so invariant checks on this event must not be
 * async functions.
 * @param ns - the namespace whose resolved value changed.
 * @param next - the new resolved value.
 * @param prev - the previous resolved value.
 * @param source - whether the change entered through `update()` or the provider.
 * @mode emit
 */
'settings/updated'(ns: SettingsNamespace, next: unknown, prev: unknown, source: SettingsUpdateSource): void
```

Source: [`packages/settings/settings/src/types.ts:35`](../../packages/settings/settings/src/types.ts)
<!-- END GENERATED cordis-surface -->
