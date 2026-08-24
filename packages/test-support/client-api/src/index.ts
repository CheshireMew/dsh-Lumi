// Programmable IApiClient test double (NOT the fixture: fixture is a demo
// data source on a real clock; behavior tests need per-case responses and
// deferred-controlled timing). Streams are hand pumps: pushMux/pushHost.
import type {
  ClientResponse, HostFrame, ModelSelection, MuxFrame,
  RpcError, RpcReceipt, RpcRequest, RpcResponse, SessionModels, SessionSearchItem, SkillEntry,
  WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-protocol/api'
import { RpcId } from '@deepseek-ai/dsh-api-protocol/api'
import type { IApiClient } from '@deepseek-ai/dsh-api-protocol/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Programmable-default workspace row (branded id, ISO-ish times). */
function fakeWorkspace(id: string, over: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    workspaceId: id as WorkspaceId,
    path: '/f/ws',
    title: 'ws',
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

/** Promise whose settlement is controlled by a test. */
export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

/**
 * Create test-held settlement whose case decides when an RPC lands.
 * @returns A promise and its resolve and reject controls.
 */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let nextRpc = 0

/**
 * Create a successful fake RPC response.
 * @param value - Successful response value.
 * @returns A successful RPC response.
 */
export function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: RpcId(`fake-${nextRpc++}`), result: { ok: true, value } }
}

/**
 * Create a failed fake RPC response.
 * @param error - Protocol error.
 * @returns A failed RPC response.
 */
export function err<T>(error: RpcError): RpcResponse<T> {
  return { rpcId: RpcId(`fake-${nextRpc++}`), result: { ok: false, error } }
}

type StreamItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' } | { kind: 'fail'; error: unknown }

interface StreamConn<F> {
  feed(item: StreamItem<F>): void
}

/** Programmable API client with controllable unary calls and event streams. */
export class FakeApiClient implements IApiClient {
  /** Chronological call record: [method, payload]. */
  readonly calls: { method: string; payload: unknown }[] = []

  // Programmable slots (defaults answer OK-empty); reassign per case.
  /** Programmable session-list response. */
  onList: (payload: unknown) => Promise<RpcResponse<{ items: never[]; nextCursor?: string }>> =
    () => Promise.resolve(ok({ items: [] }))
  /** Programmable session-delete response. */
  onDelete: (payload: unknown) => Promise<RpcResponse<{ deletedSessionIds: SessionId[] }>> =
    payload => Promise.resolve(ok({ deletedSessionIds: [(payload as { sessionId: SessionId }).sessionId] }))
  /** Programmable session-search response. */
  onSearch: (payload: unknown) => Promise<RpcResponse<{ items: SessionSearchItem[]; hasMore: boolean }>> =
    () => Promise.resolve(ok({ items: [], hasMore: false }))
  /** Programmable session-create response. */
  onCreate: (payload: unknown) => Promise<RpcResponse<{ sessionId: SessionId }>> = () => Promise.resolve(ok({ sessionId: 'fk-new' as SessionId }))
  /** Default model returned by the fake catalog. */
  readonly defaultModel: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  /** Programmable session-rename response. */
  onRename: (payload: unknown) => Promise<RpcResponse<{ title: string; seq: number }>> = () => Promise.resolve(ok({ title: 'fk-renamed', seq: 0 }))
  /** Programmable session-fork response. */
  onFork: (payload: unknown) => Promise<RpcResponse<{ sessionId: SessionId }>> = () => Promise.resolve(ok({ sessionId: 'fk-fork' as SessionId }))
  /** Programmable session-history response. */
  onHistory: (payload: { sessionId: SessionId; beforeSeq?: number; maxMessages?: number })
  => Promise<RpcResponse<{ events: never[]; hasMore: boolean }>> =
    () => Promise.resolve(ok({ events: [], hasMore: false }))

  /** Programmable session-model catalog response. */
  onModels: (payload: unknown) => Promise<RpcResponse<SessionModels>> = () => Promise.resolve(ok({
    current: this.defaultModel,
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
    }],
    failures: [],
  }))
  /** Programmable model-selection response. */
  onSelectModel: (payload: { provider: string; model: string }) =>
  Promise<RpcResponse<{ selected: ModelSelection }>> =
    payload => Promise.resolve(ok({ selected: { provider: payload.provider, model: payload.model } }))
  /** Programmable prompt response. */
  onPrompt: (payload: unknown) => Promise<RpcResponse<{ accepted: true }>> = () => Promise.resolve(ok({ accepted: true as const }))
  /** Programmable attachment-read response. */
  onAttachment: (payload: unknown) => Promise<RpcResponse<{ attachment: { attachmentId: never; mediaType: 'image/png'; bytes: number; width: number; height: number }; data: string }>> =
    () => Promise.resolve(ok({ attachment: { attachmentId: 'a' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 }, data: 'AA==' }))
  /** Programmable queued-message update response. */
  onUpdateQueue: (payload: unknown) => Promise<RpcResponse<{ accepted: true }>> = () => Promise.resolve(ok({ accepted: true as const }))
  /** Programmable session-cancel response. */
  onCancel: (payload: unknown) => Promise<RpcResponse<{ accepted: true }>> = () => Promise.resolve(ok({ accepted: true as const }))

  /** Programmable host-description response. */
  onDescribe: (payload: unknown) => Promise<RpcResponse<{
    version: string
    cwd: string
    attachedSessions: number
    canOpenPath: boolean
  }>> =
    () => Promise.resolve(ok({
      version: '0-fake', cwd: '/f', attachedSessions: 0, canOpenPath: true,
    }))
  /** Programmable native directory-picker response. */
  onPickDirectory: (payload: unknown) => Promise<RpcResponse<{ path: string | null }>> =
    () => Promise.resolve(ok({ path: null }))
  /** Programmable native path-open response. */
  onOpenPath: (payload: unknown) => Promise<RpcResponse<{ opened: true }>> =
    () => Promise.resolve(ok({ opened: true as const }))

  /** Programmable directory-listing response. */
  onListDirectory: (payload: unknown) => Promise<RpcResponse<{
    path: string
    home: string
    crumbs: { name: string; path: string; hidden: boolean }[]
    entries: { name: string; path: string; hidden: boolean }[]
    truncated: boolean
  }>> =
    () => Promise.resolve(ok({ path: '/home/fake', home: '/home/fake', crumbs: [{ name: '/', path: '/', hidden: false }], entries: [], truncated: false }))

  /** Programmable directory-create response. */
  onCreateDirectory: (payload: unknown) => Promise<RpcResponse<{ path: string }>> =
    () => Promise.resolve(ok({ path: '/home/fake/new' }))

  private readonly muxConns: StreamConn<MuxFrame>[] = []
  private readonly hostConns: StreamConn<HostFrame>[] = []
  /** Latest cancellation signal supplied to session search. */
  lastSearchSignal: AbortSignal | undefined

  // Parameters carry local structural annotations: the CI lint lane runs
  // without built lib/, so IApiClient's indexed-access types collapse to any
  // and inferred parameters would trip no-unsafe-argument.
  readonly sessions: IApiClient['sessions'] = {
    list: (payload: unknown) => this.record('session.list', payload, this.onList(payload)),
    delete: (payload: unknown) => this.record('session.delete', payload, this.onDelete(payload)),
    search: (payload: unknown, signal?: AbortSignal) => {
      this.lastSearchSignal = signal
      return this.record('session.search', payload, this.onSearch(payload))
    },
    create: (payload: unknown) => this.record('session.create', payload, this.onCreate(payload)),
    history: (payload: { sessionId: SessionId; beforeSeq?: number; maxMessages?: number }) =>
      this.record('session.history', payload, this.onHistory(payload)),
    models: (payload: unknown) => this.record('session.models', payload, this.onModels(payload)),
    selectModel: (payload: { provider: string; model: string }) =>
      this.record('session.selectModel', payload, this.onSelectModel(payload)),
    rename: (payload: unknown) => this.record('session.rename', payload, this.onRename(payload)),
    fork: (payload: unknown) => this.record('session.fork', payload, this.onFork(payload)),
    prompt: (payload: unknown) => this.record('session.prompt', payload, this.onPrompt(payload)),
    attachment: (payload: unknown) => this.record('session.attachment', payload, this.onAttachment(payload)),
    updateQueue: (payload: unknown) => this.record('session.updateQueue', payload, this.onUpdateQueue(payload)),
    cancel: (payload: unknown) => this.record('session.cancel', payload, this.onCancel(payload)),
  }

  /** Programmable subagent-list response. */
  onSubagentList: (payload: unknown) => Promise<RpcResponse<{ entries: never[]; parentAvailable: boolean }>>
    = () => Promise.resolve(ok({ entries: [], parentAvailable: true }))
  /** Programmable subagent-history response. */
  onSubagentHistory: (payload: unknown) => Promise<RpcResponse<{ events: never[]; hasMore: boolean }>>
    = () => Promise.resolve(ok({ events: [], hasMore: false }))
  /** Programmable subagent-prompt response. */
  onSubagentPrompt: (payload: unknown) => Promise<RpcResponse<{ messageId: never }>>
    = () => Promise.resolve(ok({ messageId: 'fake-message' as never }))

  /** Programmable subagent-interrupt response. */
  onSubagentInterrupt: (payload: unknown) => Promise<RpcResponse<{ accepted: true }>>
    = () => Promise.resolve(ok({ accepted: true as const }))

  readonly subagents: IApiClient['subagents'] = {
    list: (payload: unknown) => this.record('subagent.list', payload, this.onSubagentList(payload)),
    history: (payload: unknown) => this.record('subagent.history', payload, this.onSubagentHistory(payload)),
    prompt: (payload: unknown) => this.record('subagent.prompt', payload, this.onSubagentPrompt(payload)),
    interrupt: (payload: unknown) => this.record('subagent.interrupt', payload, this.onSubagentInterrupt(payload)),
  }

  readonly host: IApiClient['host'] = {
    describe: (payload: unknown) => this.record('host.describe', payload, this.onDescribe(payload)),
    pickDirectory: (payload: unknown) => this.record('host.pickDirectory', payload, this.onPickDirectory(payload)),
    listDirectory: (payload: unknown) => this.record('host.listDirectory', payload, this.onListDirectory(payload)),
    createDirectory: (payload: unknown) => this.record('host.createDirectory', payload, this.onCreateDirectory(payload)),
    openPath: (payload: unknown) => this.record('host.openPath', payload, this.onOpenPath(payload)),
  }

  // The archive-set field defaults at the binding below so list stubs keep
  // the pre-archive `{ items }` shape; a stub carrying the field wins.
  /** Programmable workspace-list response. */
  onWorkspaceList: (payload: unknown) => Promise<RpcResponse<{ items: never[]; archivedSessionIds?: never[] }>> =
    () => Promise.resolve(ok({ items: [] }))
  /** Programmable workspace-create response. */
  onWorkspaceCreate: (payload: unknown) => Promise<RpcResponse<{ workspace: WorkspaceView; created: boolean }>> =
    () => Promise.resolve(ok({ workspace: fakeWorkspace('fk-ws'), created: true }))

  /** Programmable workspace-rename response. */
  onWorkspaceRename: (payload: unknown) => Promise<RpcResponse<{ workspace: WorkspaceView }>> =
    () => Promise.resolve(ok({ workspace: fakeWorkspace('fk-ws') }))

  /** Programmable workspace-delete response. */
  onWorkspaceDelete: (payload: unknown) => Promise<RpcResponse<{ deleted: true }>> =
    () => Promise.resolve(ok({ deleted: true }))

  /** Programmable workspace-order response. */
  onWorkspaceInsertBefore: (payload: unknown) => Promise<RpcResponse<{ workspaceIds: WorkspaceId[] }>> =
    () => Promise.resolve(ok({ workspaceIds: [] }))

  /** Programmable workspace session-placement response. */
  onWorkspaceInsertSessionBefore: (payload: unknown) => Promise<RpcResponse<{ workspace: WorkspaceView }>> =
    () => Promise.resolve(ok({ workspace: fakeWorkspace('fk-ws') }))

  /** Programmable workspace session-archive response. */
  onWorkspaceArchiveSession: (payload: unknown) => Promise<RpcResponse<{ archivedSessionIds: SessionId[] }>> =
    payload => Promise.resolve(ok({ archivedSessionIds: [(payload as { sessionId: SessionId }).sessionId] }))
  /** Programmable workspace session-unarchive response. */
  onWorkspaceUnarchiveSession: (payload: unknown) => Promise<RpcResponse<{ archivedSessionIds: SessionId[] }>> =
    () => Promise.resolve(ok({ archivedSessionIds: [] }))

  readonly workspace: IApiClient['workspace'] = {
    list: (payload: unknown) => this.record('workspace.list', payload, this.onWorkspaceList(payload).then(response => (
      response.result.ok
        ? { ...response, result: { ok: true as const, value: { archivedSessionIds: [] as never[], ...response.result.value } } }
        : response
    )) as ReturnType<IApiClient['workspace']['list']>),
    create: (payload: unknown) => this.record('workspace.create', payload, this.onWorkspaceCreate(payload)),
    rename: (payload: unknown) => this.record('workspace.rename', payload, this.onWorkspaceRename(payload)),
    delete: (payload: unknown) => this.record('workspace.delete', payload, this.onWorkspaceDelete(payload)),
    insertBefore: (payload: unknown) =>
      this.record('workspace.insertBefore', payload, this.onWorkspaceInsertBefore(payload)),
    insertSessionBefore: (payload: unknown) =>
      this.record('workspace.insertSessionBefore', payload, this.onWorkspaceInsertSessionBefore(payload)),
    archiveSession: (payload: unknown) =>
      this.record('workspace.archiveSession', payload, this.onWorkspaceArchiveSession(payload)),
    unarchiveSession: (payload: unknown) =>
      this.record('workspace.unarchiveSession', payload, this.onWorkspaceUnarchiveSession(payload)),
  }

  // Payloads stay `unknown` (lint-lane note above); response rows are the real
  // wire shapes so cases can program requires-bearing catalogs and dual-address
  // skill lists without casts.
  /** Programmable skill-list response. */
  onSkillList: (payload: unknown) => Promise<RpcResponse<{ skills: SkillEntry[] }>>
    = () => Promise.resolve(ok({ skills: [] }))


  readonly agentPresets: IApiClient['agentPresets'] = {
    list: (payload: unknown) => this.record('agentPreset.list', payload, Promise.resolve(ok({ presets: [], authorable: false, hasDocument: false }))),
    select: (payload: { agentPreset: string }) =>
      this.record('agentPreset.select', payload, Promise.resolve(ok({ agentPreset: payload.agentPreset }))),
    read: (payload: { agentPreset: string }) =>
      this.record('agentPreset.read', payload, Promise.resolve(ok({
        agentPreset: payload.agentPreset, trust: 'user' as const, content: '',
      }))),
    copy: (payload: { agentPreset: string }) =>
      this.record('agentPreset.copy', payload, Promise.resolve(ok({ agentPreset: payload.agentPreset }))),
    openDocument: (payload: { agentPreset: string }) =>
      this.record('agentPreset.openDocument', payload, Promise.resolve(ok({ opened: true as const }))),
    remove: (payload: { agentPreset: string }) =>
      this.record('agentPreset.remove', payload, Promise.resolve(ok({}))),
  }

  readonly skills: IApiClient['skills'] = {
    list: (payload: unknown) => this.record('skill.list', payload, this.onSkillList(payload)),
  }

  readonly goals: IApiClient['goals'] = {
    create: payload => this.record('goal.create', payload, Promise.resolve(ok({ ref: { id: 'fake-goal' as never, revision: 1 } }))),
    edit: payload => this.record('goal.edit', payload, Promise.resolve(ok({ ref: { id: 'fake-goal' as never, revision: 1 } }))),
    pause: payload => this.record('goal.pause', payload, Promise.resolve(ok({ ref: { id: 'fake-goal' as never, revision: 1 } }))),
    resume: payload => this.record('goal.resume', payload, Promise.resolve(ok({ ref: { id: 'fake-goal' as never, revision: 1 } }))),
    complete: payload => this.record('goal.complete', payload, Promise.resolve(ok({ ref: { id: 'fake-goal' as never, revision: 1 } }))),
    clear: payload => this.record('goal.clear', payload, Promise.resolve(ok({ cleared: true as const }))),
  }

  readonly settings: IApiClient['settings'] = {
    describe: payload => this.record('settings.describe', payload, Promise.resolve(ok({ writable: true, hasDocument: false, namespaces: [] }))),
    openDocument: payload => this.record('settings.openDocument', payload, Promise.resolve(ok({ opened: true as const }))),
    update: payload => this.record('settings.update', payload, Promise.resolve(ok({ ns: 'fake', schema: {}, value: {}, applies: 'live' as const, secrets: [], revision: 0 }))),
    replace: payload => this.record('settings.replace', payload, Promise.resolve(ok({ ns: 'fake', schema: {}, value: {}, applies: 'live' as const, secrets: [], revision: 0 }))),
    mutate: payload => this.record('settings.mutate', payload, Promise.resolve(ok({ ns: 'fake', schema: {}, value: {}, applies: 'live' as const, secrets: [], revision: 0 }))),
  }

  readonly credentials: IApiClient['credentials'] = {
    describe: payload => this.record('credentials.describe', payload, Promise.resolve(ok({ credentials: {} }))),
    set: payload => this.record('credentials.set', payload, Promise.resolve(ok({}))),
    unset: payload => this.record('credentials.unset', payload, Promise.resolve(ok({}))),
  }

  readonly llm: IApiClient['llm'] = {
    providers: payload => this.record('llm.providers', payload, Promise.resolve(ok({ providers: [] }))),
    models: payload => this.record('llm.models', payload, Promise.resolve(ok({ groups: [], failures: [] }))),
    discoverModels: payload => this.record('llm.discoverModels', payload, Promise.resolve(ok({ models: [] }))),
  }

  /** When true, streams never fire onOpen (misbehaving-carrier material for the handshake timeout guard). */
  suppressStreamOpen = false

  /** When true, onOpen callbacks are parked instead of fired; releaseStreamOpens() fires them.
   *  Lets a case hold the readiness handshake open (describe done, streams not yet "established"). */
  holdStreamOpen = false
  private heldOpens: (() => void)[] = []

  /** Release every event-stream handshake parked by {@link holdStreamOpen}. */
  releaseStreamOpens(): void {
    const held = this.heldOpens
    this.heldOpens = []
    for (const fire of held) fire()
  }

  readonly events: IApiClient['events'] = {
    mux: (_payload: unknown, signal: AbortSignal, onOpen?: () => void) => this.openStream(this.muxConns, signal, onOpen),
    host: (_payload: unknown, signal: AbortSignal, onOpen?: () => void) => this.openStream(this.hostConns, signal, onOpen),
  }

  /** Programmable interaction-response receipt. */
  onRespond: (message: ClientResponse) => Promise<RpcReceipt> = () => Promise.resolve({ accepted: true })

  respond(message: ClientResponse): Promise<RpcReceipt> {
    return this.record('respond', message, this.onRespond(message))
  }

  /**
   * Push one mux frame to every open mux stream.
   * @param frame - Frame payload to publish.
   * @param rpcId - Optional pinned correlation identity.
   */
  pushMux(frame: MuxFrame, rpcId?: string): void {
    for (const conn of [...this.muxConns]) conn.feed({ kind: 'frame', envelope: { rpcId: RpcId(rpcId ?? `push-${nextRpc++}`), payload: frame } })
  }

  /**
   * Push one host frame to every open host stream.
   * @param frame - Frame payload to publish.
   * @param rpcId - Optional pinned correlation identity.
   */
  pushHost(frame: HostFrame, rpcId?: string): void {
    for (const conn of [...this.hostConns]) conn.feed({ kind: 'frame', envelope: { rpcId: RpcId(rpcId ?? `push-${nextRpc++}`), payload: frame } })
  }

  /** End (clean close) or fail (throw) every open stream — reconnect-path material. */
  endStreams(): void {
    for (const conn of [...this.muxConns, ...this.hostConns]) conn.feed({ kind: 'end' })
  }

  /**
   * Fail every open event stream.
   * @param error - Failure thrown by each stream.
   */
  failStreams(error: unknown): void {
    for (const conn of [...this.muxConns, ...this.hostConns]) conn.feed({ kind: 'fail', error })
  }

  /** Number of currently open mux streams. */
  get openMuxCount(): number {
    return this.muxConns.length
  }

  /**
   * Return payloads recorded for one API method.
   * @param method - Recorded method name.
   * @returns Payloads in call order.
   */
  callsOf(method: string): unknown[] {
    return this.calls.filter(c => c.method === method).map(c => c.payload)
  }

  private record<T>(method: string, payload: unknown, response: Promise<T>): Promise<T> {
    this.calls.push({ method, payload })
    return response
  }

  private async *openStream<F>(registry: StreamConn<F>[], signal: AbortSignal, onOpen?: () => void): AsyncGenerator<RpcRequest<F>> {
    const inbox: StreamItem<F>[] = []
    let wake: (() => void) | null = null
    const conn: StreamConn<F> = {
      feed: (item) => {
        inbox.push(item)
        wake?.()
      },
    }
    registry.push(conn)
    if (this.holdStreamOpen && onOpen !== undefined) this.heldOpens.push(onOpen)
    else if (!this.suppressStreamOpen) onOpen?.()
    try {
      while (!signal.aborted) {
        while (inbox.length > 0) {
          const item = inbox.shift() as StreamItem<F>
          if (item.kind === 'end') return
          if (item.kind === 'fail') throw item.error
          yield item.envelope
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        wake = null
      }
    } finally {
      registry.splice(registry.indexOf(conn), 1)
    }
  }
}
