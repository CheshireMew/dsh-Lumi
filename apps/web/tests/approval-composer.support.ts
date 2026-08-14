import { CallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { loadReplayScript, type ReplayEntry } from '@deepseek-ai/dsh-llm-replay'

/** Read the exact shell command recorded in the approval fixture. */
export function recordedApprovalCommand(fixture: string): string {
  const entry = loadReplayScript({ file: fixture })[1]
  if (entry?.kind !== 'chunks') throw new Error('approval replay second model call is not a chunk stream')
  for (const chunk of entry.chunks) {
    if (chunk.type !== 'block-end' || chunk.block.type !== 'tool-call') continue
    const args = JSON.parse(chunk.block.arguments) as { command?: unknown }
    if (typeof args.command === 'string') return args.command
  }
  throw new Error('approval replay second model call has no shell command')
}

/** Build the Windows PowerShell equivalent of the recorded bash approval flow. */
export function windowsApprovalReplay(fixture: string, contents: string): ReplayEntry[] {
  const derived = loadReplayScript({ file: fixture })
  if (derived.length < 4) {
    throw new Error(`approval replay needs four model calls, received ${String(derived.length)}`)
  }
  const command = `Set-Content -LiteralPath notes.txt -Value '${contents}' -NoNewline`
  const shellCall = (
    id: string,
    reasoning: string,
    escalation: boolean,
  ): ReplayEntry => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: CallId(id),
          name: 'pwsh',
          arguments: JSON.stringify({
            command,
            description: 'Write notes.txt with the specified text',
            ...escalation ? {
              sandbox_permissions: 'workspace-write',
              justification: 'Need to write the notes.txt file as requested by the user.',
            } : {},
          }),
        },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    return { kind: 'chunks', chunks }
  }
  return [
    shellCall(
      'call_windows_approval_denied',
      'The requested write needs one PowerShell command. I will run it under the current policy first.',
      false,
    ),
    shellCall(
      'call_windows_approval_escalated',
      'The read-only policy denied the write. I need to retry the same command with workspace-write approval.',
      true,
    ),
    ...derived.slice(2),
  ]
}
