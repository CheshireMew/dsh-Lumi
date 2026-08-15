import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { LumiCharacterInjected } from '@dsh-lumi/client-character/client'
import type { LumiAnimationDefinition, LumiCharacterStateDefinition, CharacterState } from '@dsh-lumi/client-character/contract'
import './desktop-api.ts'
import { LUMI_LAYOUT_CONFIG, effectiveLumiLayout } from './layout-config.ts'
import css from './LumiFrame.module.css'

/** Full lumi-frame component props. */
export type LumiFrameProps = PropsRuntime<'layout.frame'>
  & InjectFace<LumiCharacterInjected> & PropsLocale<'lumi.shell'>

/** Pure state priority below the character runtime's speaking/success overlays. */
export function conversationCharacterState(input: {
  pending: number
  error: boolean
  runningCalls: number
  running: boolean
  engaging: boolean
}): Exclude<CharacterState, 'speaking' | 'success'> {
  if (input.pending > 0) return 'waiting'
  if (input.error) return 'error'
  if (input.runningCalls > 0) return 'tool'
  if (input.running) return 'thinking'
  if (input.engaging) return 'listening'
  return 'idle'
}

/** Last finalized assistant message, text blocks only. */
function latestAssistant(nodes: readonly ConversationNode[]): { id: string; text: string } | undefined {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node?.kind !== 'assistant' || node.messageId === undefined || node.interrupted) continue
    const text = node.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n')
    if (text.trim() !== '') return { id: String(node.messageId), text }
  }
  return undefined
}

/** Follow a pack fallback chain without allowing malformed cycles to escape idle. */
export function resolvePackState(
  states: Readonly<Partial<Record<CharacterState, LumiCharacterStateDefinition>>>,
  requested: CharacterState,
): LumiCharacterStateDefinition | undefined {
  let state = requested
  const visited = new Set<CharacterState>()
  while (!visited.has(state)) {
    visited.add(state)
    const definition = states[state]
    if (definition !== undefined) return definition
    const idle = states.idle
    if (idle !== undefined) return idle
    state = 'idle'
  }
  return undefined
}

/** Apply pack keyframes to the visual layer; reduced motion keeps only appearance changes. */
function usePackAnimation(
  target: React.RefObject<HTMLDivElement | null>,
  definition: LumiAnimationDefinition | undefined,
  reduced: boolean,
  paused: boolean,
): void {
  useEffect(() => {
    const element = target.current
    if (element === null || definition === undefined || reduced || paused || typeof element.animate !== 'function') return
    const frames = definition.keyframes.map(frame => ({
      offset: frame.at,
      transform: `translate(${frame.translateX ?? 0}px, ${frame.translateY ?? 0}px) scale(${frame.scale ?? 1}) rotate(${frame.rotate ?? 0}deg)`,
      opacity: frame.opacity ?? 1,
    }))
    const animation = element.animate(frames, {
      duration: definition.minDurationMs,
      iterations: definition.loop === 'none' ? 1 : Number.POSITIVE_INFINITY,
      direction: definition.loop === 'alternate' ? 'alternate' : 'normal',
      easing: 'ease-in-out',
    })
    return () => { animation.cancel() }
  }, [definition, paused, reduced, target])
}

/** Custom title bar shown only inside Electron. */
function DesktopTitleBar({
  t, name, state, level, progress, mode, onMode,
}: {
  t: LumiFrameProps['t']
  name: string
  state: string
  level: number
  progress: number
  mode: 'scene' | 'work'
  onMode: (mode: 'scene' | 'work') => void
}) {
  const desktop = window.dshDesktop
  if (desktop === undefined) return null
  return (
    <header className={css.titleBar}>
      <div className={css.titleIdentity}>
        <strong>{name}</strong><span>{state}</span><span>{t('bond.level', { level })}</span>
        <BondProgress t={t} level={level} progress={progress} />
      </div>
      <div className={css.titleMode}>
        <button type="button" aria-pressed={mode === 'scene'} data-active={mode === 'scene' || undefined} onClick={() => { onMode('scene') }}>{t('mode.scene')}</button>
        <button type="button" aria-pressed={mode === 'work'} data-active={mode === 'work' || undefined} onClick={() => { onMode('work') }}>{t('mode.work')}</button>
      </div>
      <div className={css.titleActions}>
        <button type="button" onClick={() => { void desktop.app.openCharacterPacksFolder() }}>{t('title.packs')}</button>
        <button type="button" onClick={() => { void desktop.app.openLogsFolder() }}>{t('title.logs')}</button>
        {desktop.platform === 'darwin' ? null : <>
          <button type="button" aria-label={t('window.minimize')} onClick={() => { void desktop.window.minimize() }}>—</button>
          <button type="button" aria-label={t('window.maximize')} onClick={() => { void desktop.window.toggleMaximize() }}>□</button>
          <button type="button" className={css.closeButton} aria-label={t('window.close')} onClick={() => { void desktop.window.close() }}>×</button>
        </>}
      </div>
    </header>
  )
}

/** Bond progress with the same accessible name in browser and desktop layouts. */
function BondProgress({
  t, level, progress,
}: {
  t: LumiFrameProps['t']
  level: number
  progress: number
}) {
  const percentage = Math.round(progress * 100)
  return (
    <span
      className={css.meter}
      role="progressbar"
      aria-label={`${t('bond.label')} ${t('bond.level', { level })}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percentage}
    ><span aria-hidden="true" style={{ width: `${percentage}%` }} /></span>
  )
}

/** Immersive frame arranging official Harness seats without owning their business state. */
export function LumiFrame({
  panels, actions, detailsAvailable,
  renderSidebar, renderConversation, renderDetails, renderOverlay,
  sessionId, useSession, useCharacter, observeConversation, setPreference, t,
}: LumiFrameProps) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const visualRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const [systemReduced, setSystemReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const nodes = useSession(snapshot => snapshot.nodes) ?? []
  const turnEnds = useSession(snapshot => snapshot.turnEnds)
  const pending = useSession(snapshot => snapshot.pending.length) ?? 0
  const error = useSession(snapshot => snapshot.promptError !== null || snapshot.nodes.at(-1)?.kind === 'turn-error') ?? false
  const runningCalls = useSession(snapshot => snapshot.runningCalls.length) ?? 0
  const running = useSession(snapshot => snapshot.running) ?? false
  const engaging = useSession(snapshot => snapshot.composerPhase === 'engaging') ?? false
  const character = useCharacter(snapshot => snapshot)
  const completedTurnCount = turnEnds?.size ?? 0
  const assistant = useMemo(() => latestAssistant(nodes), [nodes])
  const baseState = conversationCharacterState({ pending, error, runningCalls, running, engaging })

  useEffect(() => {
    observeConversation({
      sessionId: sessionId === undefined ? undefined : String(sessionId),
      baseState,
      completedTurnCount,
      ...(assistant === undefined ? {} : { latestAssistant: assistant }),
    })
  }, [assistant, baseState, completedTurnCount, observeConversation, sessionId])

  useEffect(() => {
    const frame = frameRef.current
    if (frame === null) return
    let pendingFrame: number | undefined
    const observer = new ResizeObserver(() => {
      pendingFrame ??= requestAnimationFrame(() => {
        pendingFrame = undefined
        const width = frame.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(frame)
    return () => {
      observer.disconnect()
      if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame)
    }
  }, [])

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => { setSystemReduced(query.matches) }
    query.addEventListener('change', update)
    return () => { query.removeEventListener('change', update) }
  }, [])

  const narrow = viewport <= LUMI_LAYOUT_CONFIG.workLayoutMaxWidth
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])
  const mode = effectiveLumiLayout(viewport, character.settings.layoutMode)
  const reduced = character.settings.motionPreference === 'reduced'
    || character.settings.motionPreference === 'system' && systemReduced
  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const sidebarWidth = sidebarCollapsed
    ? LUMI_LAYOUT_CONFIG.sidebarCollapsedWidth
    : panels.sidebar === 0 ? LUMI_LAYOUT_CONFIG.sidebarDefaultWidth : panels.sidebar
  const pack = character.activePack
  const stateDefinition = resolvePackState(pack.manifest.states, character.state)
  const idleActionName = character.state === 'idle' ? character.unlockedIdleActions.at(-1) : undefined
  const idleAction = idleActionName === undefined ? undefined : pack.manifest.idleActions[idleActionName]
  const animationDefinition = idleAction?.animation ?? stateDefinition?.animation
  usePackAnimation(visualRef, animationDefinition, reduced, character.animationsPaused)
  const expressionUrl = stateDefinition === undefined ? undefined : pack.assets.expressions[stateDefinition.expression]
  const effectName = idleAction?.effect ?? stateDefinition?.effect
  const effectUrl = effectName === undefined ? undefined : pack.assets.effects[effectName]
  const characterVisible = character.settings.characterVisible && !narrow
  const detailsOpen = detailsAvailable && panels.details > 0
  const stateLabel = t(`state.${character.state}`)
  const localeBubbles = navigator.language.toLowerCase().startsWith('zh') ? character.unlockedBubbles.zh : character.unlockedBubbles.en
  const bubble = localeBubbles.at(-1)
  const frameStyle = {
    gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr)`,
    '--lumi-panel-opacity': character.settings.panelOpacity,
    '--lumi-background-blur': `${character.settings.backgroundBlur}px`,
  } as CSSProperties

  return (
    <div
      ref={frameRef}
      className={css.frame}
      data-mode={mode}
      data-motion={reduced ? 'reduced' : 'full'}
      data-animation-paused={character.animationsPaused || undefined}
      data-character-state={character.state}
      data-character-visible={characterVisible || undefined}
      data-desktop={window.dshDesktop === undefined ? undefined : true}
      style={frameStyle}
    >
      <div className={css.sceneBackground} style={{ backgroundImage: `url(${JSON.stringify(pack.assets.background)})` }} />
      <div className={css.ambient} />
      <DesktopTitleBar
        t={t}
        name={pack.manifest.displayName}
        state={stateLabel}
        level={character.bondLevel}
        progress={character.bondLevelProgress}
        mode={mode}
        onMode={(next) => { setPreference('layoutMode', next) }}
      />

      <aside className={css.sidebar} data-lumi-sidebar data-collapsed={sidebarCollapsed ? 'true' : 'false'}>
        {renderSidebar({ collapsed: sidebarCollapsed, width: sidebarWidth })}
      </aside>

      <main className={css.stage}>
        <div className={css.topHud}>
          <button type="button" className={css.iconButton} aria-label={t('sidebar.toggle')} onClick={() => { actions.toggleSidebar() }}>☰</button>
          <div className={css.bondCard}>
            <span>{pack.manifest.displayName}</span><span className={css.stateText}>{stateLabel}</span>
            <span>{t('bond.level', { level: character.bondLevel })}</span>
            <BondProgress t={t} level={character.bondLevel} progress={character.bondLevelProgress} />
          </div>
          <div className={css.modeSwitch}>
            <button type="button" aria-pressed={mode === 'scene'} data-active={mode === 'scene' || undefined} onClick={() => { setPreference('layoutMode', 'scene') }}>{t('mode.scene')}</button>
            <button type="button" aria-pressed={mode === 'work'} data-active={mode === 'work' || undefined} onClick={() => { setPreference('layoutMode', 'work') }}>{t('mode.work')}</button>
          </div>
        </div>

        <div className={css.characterStage} role="img" aria-label={`${pack.manifest.displayName} · ${stateLabel}`}>
          <div className={css.characterGlow} />
          <div ref={visualRef} className={css.characterVisual} style={{ aspectRatio: `${pack.manifest.canvas.width} / ${pack.manifest.canvas.height}` }}>
            <img className={css.characterLayer} src={pack.assets.body} alt="" aria-hidden="true" draggable={false} />
            {expressionUrl === undefined ? null : <img className={css.characterLayer} src={expressionUrl} alt="" aria-hidden="true" draggable={false} />}
            <img className={css.characterLayer} src={character.mouthOpen ? pack.assets.mouth.open : pack.assets.mouth.closed} alt="" aria-hidden="true" draggable={false} />
            {effectUrl === undefined ? null : <img className={css.characterLayer} src={effectUrl} alt="" aria-hidden="true" draggable={false} />}
          </div>
          {bubble === undefined ? null : <div className={css.characterBubble} role="status" aria-live="polite">{bubble}</div>}
          <div className={css.characterCaption} aria-live="polite">{stateLabel}</div>
        </div>

        <section className={css.conversationPanel} data-lumi-conversation>{renderConversation()}</section>
      </main>

      <aside
        className={css.detailsDrawer}
        data-lumi-details
        data-open={detailsOpen || undefined}
        style={{ width: Math.max(360, panels.details) }}
      >
        {renderDetails()}
      </aside>
      <div className={css.overlay}>{renderOverlay()}</div>
    </div>
  )
}
