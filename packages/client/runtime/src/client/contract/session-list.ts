import type {
  JobView, RpcError, SessionId, SubagentAddress, SubagentCatalog,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { AgentContext } from './agent-scope.ts'
import type { PendingInteractionStatus } from './pending.ts'
import type { SessionFace } from './session.ts'

/** Monotone session-list arrival lifecycle. */
export type SessionListPhase = 'pending' | 'ready'

/** Request-local content hit returned to sidebar search consumers. */
export interface SessionSearchResultItem {
  sessionId: SessionId
  snippet: string
}

/** One parent-addressed durable catalog projected through the sessions snapshot. */
export interface SubagentCatalogSnapshot extends SubagentCatalog {
  state: 'loading' | 'ready' | 'error'
  error: RpcError | null
}

/** Session list row projected from the host list RPC plus live stream increments. */
export interface SessionSummary {
  id: SessionId
  /** Latest durable log-backed title, absent until the host projects one. */
  title?: string
  /** Human-facing label: durable title, project basename, then session id. */
  displayTitle: string
  cwd?: string
  /** Preset the session's agent was composed from. */
  agentPreset?: string
  parentId?: SessionId
  /** Coarse durable origin for navigation filtering. */
  origin?: 'subagent'
  running: boolean
  /** User interaction currently blocking this session. */
  pendingInteraction?: PendingInteractionStatus
  /** Finished while not selected and not yet opened. */
  completed?: boolean
  /** Whether the durable log is still empty. */
  blank: boolean
  updatedAt: number
  /** Current host-computed projection values retained by the object layer. */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
}

/** Session list store shape shared by the runtime and feature consumers. */
export interface SessionListState {
  ids: SessionId[]
  byId: Record<SessionId, SessionSummary>
  current: SessionId | undefined
  phase: SessionListPhase
  subagentsByParent: Readonly<Record<SessionId, SubagentCatalogSnapshot>>
  jobsBySession: Readonly<Record<SessionId, readonly JobView[]>>
  currentAddress: SubagentAddress | undefined
}

/** Stable session assembly handle provided to render integrations. */
export interface SessionBinding {
  readonly sessionId: SessionId
  readonly session: SessionFace
  readonly ctx: AgentContext
}

/** One plugin's per-session standard-props contribution. */
export interface SessionProvideContribution {
  hooks?: Record<string, HostObservable<unknown>>
  props?: Record<string, unknown>
}

/** Static declaration plus per-session resolver for one standard-props contribution. */
export interface SessionProvideDescriptor {
  hooks?: readonly string[]
  props?: readonly string[]
  resolve(binding: SessionBinding): SessionProvideContribution
}

/** Persisted selection metadata shared by session runtime storage. */
export interface SessionSelection {
  sessionId?: SessionId
  subagentAddress?: SubagentAddress
}
