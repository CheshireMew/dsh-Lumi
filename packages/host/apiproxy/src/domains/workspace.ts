import type { ApiProxy, RpcRequest, RpcResponse, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-protocol/api'
import {
  WorkspaceId as brandWorkspaceId,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  WorkspaceUnknownSessionError,
  workspaceRecord,
  type Workspace,
  type WorkspaceRecord,
  type WorkspaceRegistry,
} from '@deepseek-ai/dsh-workspace'
import { err, ok } from '../rpc-result.ts'

/** An explicit naming operation would duplicate another workspace title. */
class WorkspaceNameConflictError extends Error {
  constructor(readonly workspaceName: string) {
    super(`workspace name '${workspaceName}' is already in use`)
    this.name = 'WorkspaceNameConflictError'
  }
}

/** Shared workspace-not-found response. */
function workspaceNotFound<T>(request: RpcRequest<unknown>, workspaceId: string): RpcResponse<T> {
  return err(request, {
    code: 'workspace-not-found',
    message: `workspace "${workspaceId}" not found`,
    details: { workspaceId },
  })
}

/**
 * Project a live workspace entity onto its wire representation.
 * @param workspace - Live workspace entity.
 * @returns Its wire projection.
 */
export function workspaceView(workspace: Workspace): WorkspaceView {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

/**
 * Project one durable workspace change onto the wire.
 * @param workspaceId - changed workspace identity.
 * @param value - durable record value.
 * @returns the validated workspace view.
 */
export function changedWorkspaceView(workspaceId: string, value: unknown): WorkspaceView {
  const record: WorkspaceRecord = workspaceRecord.parse(value)
  return {
    workspaceId: workspaceId as WorkspaceId,
    path: record.path,
    title: record.title,
    sessionIds: [...record.sessionIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * Serializes path ownership, title uniqueness, and deletion so session-create
 * attachment and explicit workspace mutations observe one ordered state.
 */
export class WorkspaceApiCoordinator {
  private chain = Promise.resolve()

  /** @param registryForCall - resolves the durable registry only when an operation runs. */
  constructor(private readonly registryForCall: () => WorkspaceRegistry) {}

  private get registry(): WorkspaceRegistry {
    return this.registryForCall()
  }

  /**
   * Resolve or create one path in the same mutation queue as the API methods.
   * @param path - requested project directory.
   * @returns the existing or newly created workspace.
   */
  ensure(path: string): Promise<{ workspace: Workspace; created: boolean }> {
    const operation = this.chain.then(async () => {
      const existing = await this.registry.resolveByPath(path)
      if (existing !== undefined) return { workspace: existing, created: false }
      return { workspace: await this.registry.create(path), created: true }
    })
    this.track(operation)
    return operation
  }

  /**
   * Build the workspace API methods sharing this coordinator's queue.
   * @returns Workspace API methods.
   */
  api(): ApiProxy['workspace'] {
    return {
      list: request => Promise.resolve(ok(request, {
        items: this.registry.list().map(workspaceView),
        archivedSessionIds: [...this.registry.archivedSessionIds],
      })),

      create: async (request) => {
        const { path } = request.payload
        try {
          const { workspace, created } = await this.ensure(path)
          return ok(request, { workspace: workspaceView(workspace), created })
        } catch (error: unknown) {
          return err(request, {
            code: 'workspace-invalid-path',
            message: `cannot create a workspace at "${path}": ${error instanceof Error ? error.message : String(error)}`,
            details: { path },
          })
        }
      },

      rename: async (request) => {
        const { payload } = request
        const workspace = this.registry.get(brandWorkspaceId(payload.workspaceId))
        if (workspace === undefined) return workspaceNotFound(request, payload.workspaceId)
        const title = payload.title.trim()
        const operation = this.chain.then(async () => {
          if (title === workspace.title) return
          if (this.registry.list().some(other => other.id !== workspace.id && other.title === title)) {
            throw new WorkspaceNameConflictError(title)
          }
          await workspace.setTitle(title)
        })
        this.track(operation)
        try {
          await operation
        } catch (error: unknown) {
          if (error instanceof WorkspaceNameConflictError) {
            return err(request, {
              code: 'workspace-name-conflict',
              message: error.message,
              details: { name: error.workspaceName },
            })
          }
          throw error
        }
        return ok(request, { workspace: workspaceView(workspace) })
      },

      delete: async (request) => {
        const { workspaceId } = request.payload
        const operation = this.chain.then(() => this.registry.delete(brandWorkspaceId(workspaceId)))
        this.track(operation)
        if (!await operation) return workspaceNotFound(request, workspaceId)
        return ok(request, { deleted: true as const })
      },

      insertBefore: async (request) => {
        const { workspaceId, beforeWorkspaceId } = request.payload
        try {
          const workspaceIds = await this.registry.insertBefore(
            brandWorkspaceId(workspaceId),
            beforeWorkspaceId === undefined ? undefined : brandWorkspaceId(beforeWorkspaceId),
          )
          return ok(request, { workspaceIds: [...workspaceIds] })
        } catch (error: unknown) {
          if (!(error instanceof WorkspaceOrderInvalidError)) throw error
          return workspaceNotFound(request, error.workspaceId)
        }
      },

      insertSessionBefore: async (request) => {
        const { payload } = request
        const workspace = this.registry.get(brandWorkspaceId(payload.workspaceId))
        if (workspace === undefined) return workspaceNotFound(request, payload.workspaceId)
        try {
          await workspace.insertSessionBefore(payload.sessionId, payload.beforeSessionId)
        } catch (error: unknown) {
          if (!(error instanceof WorkspaceMoveInvalidError)) throw error
          return err(request, {
            code: 'workspace-move-invalid',
            message: error.message,
            details: {
              workspaceId: payload.workspaceId,
              sessionId: payload.sessionId,
              ...payload.beforeSessionId === undefined ? {} : { beforeSessionId: payload.beforeSessionId },
            },
          })
        }
        return ok(request, { workspace: workspaceView(workspace) })
      },

      archiveSession: async (request) => {
        const { sessionId } = request.payload
        try {
          await this.registry.archiveSession(sessionId)
        } catch (error: unknown) {
          if (!(error instanceof WorkspaceUnknownSessionError)) throw error
          return err(request, {
            code: 'session-not-found',
            message: error.message,
            details: { sessionId },
          })
        }
        return ok(request, { archivedSessionIds: [...this.registry.archivedSessionIds] })
      },

      unarchiveSession: async (request) => {
        await this.registry.unarchiveSession(request.payload.sessionId)
        return ok(request, { archivedSessionIds: [...this.registry.archivedSessionIds] })
      },
    }
  }

  private track(operation: Promise<unknown>): void {
    this.chain = operation.then(() => undefined, () => undefined)
  }
}
