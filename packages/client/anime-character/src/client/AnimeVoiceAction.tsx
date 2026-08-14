import { useMemo } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { AnimeVoiceActionProps } from './slots.ts'
import css from './AnimeVoiceAction.module.css'

/** Extract finalized text blocks only; reasoning and tool nodes never enter speech. */
function messageText(nodes: readonly unknown[], messageId: string): string {
  const node = nodes.find(candidate =>
    typeof candidate === 'object' && candidate !== null
    && (candidate as { kind?: unknown }).kind === 'assistant'
    && String((candidate as { messageId?: unknown }).messageId) === messageId) as AssistantMessageNode | undefined
  return node?.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n') ?? ''
}

/** Per-message read, pause, continue, and stop controls. */
export function AnimeVoiceAction({
  messageId, useSession, useCharacter, speak, pauseSpeaking, resumeSpeaking, stopSpeaking, t,
}: AnimeVoiceActionProps) {
  const id = String(messageId)
  const nodes = useSession(snapshot => snapshot.nodes)
  const text = useMemo(() => messageText(nodes, id), [id, nodes])
  const snapshot = useCharacter(value => value)
  if (!snapshot.settings.ttsEnabled || text === '') return null
  const unavailable = snapshot.ttsUnavailableReason !== undefined
  const active = snapshot.speechMessageId === id && snapshot.speech !== 'idle'
  const paused = active && snapshot.speech === 'paused'
  const primaryLabel = unavailable
    ? t(snapshot.ttsUnavailableReason === 'unsupported' ? 'settings.ttsUnsupported' : 'settings.noVoices')
    : paused ? t('voice.resume') : active ? t('voice.pause') : t('voice.read')
  return (
    <span className={css.controls}>
      <Tooltip label={primaryLabel} side="bottom">
        <button type="button" className={css.action} disabled={unavailable} aria-label={primaryLabel} onClick={() => {
          if (paused) resumeSpeaking()
          else if (active) pauseSpeaking()
          else speak(text, id)
        }}>
          {paused ? '▶' : active ? 'Ⅱ' : '◖))'}
        </button>
      </Tooltip>
      {active ? (
        <Tooltip label={t('voice.stop')} side="bottom">
          <button type="button" className={css.action} aria-label={t('voice.stop')} onClick={stopSpeaking}>■</button>
        </Tooltip>
      ) : null}
    </span>
  )
}
