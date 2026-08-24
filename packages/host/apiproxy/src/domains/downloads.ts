import type { Context } from '@deepseek-ai/cordis'
import type { ApiProxy } from '@deepseek-ai/dsh-api-protocol/api'
import type { SessionRawArtifact } from '@deepseek-ai/dsh-session-persistence'
import {
  flushLiveSessionLog,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
  type SessionLogCompressionLevel,
  type SessionLogExportReady,
} from '../session-export.ts'

/**
 * Build host-only session-log downloads.
 * @param ctx - host context carrying export dependencies.
 * @param compressionLevel - validated ZIP compression level.
 * @returns the downloads API domain.
 */
export function createDownloadsApi(
  ctx: Context,
  compressionLevel: SessionLogCompressionLevel,
): ApiProxy['downloads'] {
  return {
    async sessionLog(request, signal) {
      const deps = sessionLogExportDeps(ctx)
      if (deps.sessionQuery === undefined || deps.sessionPersistence === undefined || deps.attachments === undefined) {
        return new Response(
          'session log export is unavailable: missing session-query, session-persistence, or attachments service',
          { status: 500 },
        )
      }
      if (!deps.sessionPersistence.supportsRawArtifacts) {
        return new Response(
          'session log export is unavailable: the persistence backend does not expose per-session raw artifacts',
          { status: 501 },
        )
      }
      const ready: SessionLogExportReady = {
        sessionQuery: deps.sessionQuery,
        sessionPersistence: deps.sessionPersistence,
        attachments: deps.attachments,
        sessions: deps.sessions,
      }
      let root: SessionRawArtifact | undefined
      try {
        await flushLiveSessionLog(deps, request.sessionId, signal)
        root = await deps.sessionPersistence.readRaw(request.sessionId, signal)
        signal.throwIfAborted()
      } catch {
        signal.throwIfAborted()
        return new Response('session log export failed to prepare the stored artifact', { status: 500 })
      }
      if (root === undefined) return new Response('session not found', { status: 404 })
      return new Response(
        streamSessionLogZip(
          ready,
          root,
          request.sessionId,
          request.includeDescendants === true,
          compressionLevel,
          signal,
        ),
        {
          headers: {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="${sessionLogZipFilename(request.sessionId)}"`,
          },
        },
      )
    },
  }
}
