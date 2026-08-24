import { useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LumiSettingsRowProps } from './slots.ts'
import css from './LumiSettingsRow.module.css'

type PackImportResult =
  | { kind: 'cancelled' }
  | { kind: 'installed'; id: string; displayName: string; author: string; version: string; license?: string }
  | { kind: 'error'; code: 'invalid' | 'exists' | 'copy-failed'; detail: string }

type DesktopPackActions = {
  importCharacterPack: () => Promise<PackImportResult>
  openCharacterPacksFolder: () => Promise<void>
}

function desktopPackActions(): DesktopPackActions | undefined {
  return (window as Window & { dshDesktop?: { app: DesktopPackActions } }).dshDesktop?.app
}

/** General settings surface for the shared `ui-lumi` namespace. */
export function LumiSettingsRow({ useCharacter, setPreference, retryPreference, refreshPacks, t }: LumiSettingsRowProps) {
  const snapshot = useCharacter(value => value)
  const [managerOpen, setManagerOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<PackImportResult | undefined>()
  const { settings } = snapshot
  const speechUnavailable = snapshot.ttsUnavailableReason !== undefined
  const settingsDisabled = snapshot.settingsStatus !== 'ready' || !snapshot.settingsWritable
  const desktop = desktopPackActions()
  const importPack = async (): Promise<void> => {
    if (desktop === undefined) return
    setImporting(true)
    setImportResult(undefined)
    try {
      const result = await desktop.importCharacterPack()
      setImportResult(result)
      if (result.kind === 'installed') await refreshPacks()
    } catch (error) {
      setImportResult({ kind: 'error', code: 'copy-failed', detail: error instanceof Error ? error.message : String(error) })
    } finally {
      setImporting(false)
    }
  }
  const openPackFolder = async (): Promise<void> => {
    if (desktop === undefined) return
    setImportResult(undefined)
    try {
      await desktop.openCharacterPacksFolder()
    } catch (error) {
      setImportResult({ kind: 'error', code: 'copy-failed', detail: error instanceof Error ? error.message : String(error) })
    }
  }
  return (
    <section className={css.group} aria-labelledby="ui-lumi-settings-title">
      <div className={css.heading}>
        <span id="ui-lumi-settings-title">{t('settings.title')}</span>
        <div className={css.headingActions}>
          <button type="button" className={css.manage} onClick={() => { setManagerOpen(true) }}>{t('settings.managePacks')}</button>
          <button type="button" className={css.refresh} disabled={snapshot.packStatus === 'loading'} aria-label={t('settings.refreshPacks')} onClick={() => { void refreshPacks() }}>↻</button>
        </div>
      </div>
      {snapshot.settingsStatus === 'loading' ? <p className={css.notice} role="status">{t('settings.settingsLoading')}</p> : null}
      {snapshot.settingsStatus === 'unavailable'
        ? <p className={css.errorNotice} role="alert">{t('settings.settingsUnavailable')}</p>
        : snapshot.settingsStatus === 'ready' && !snapshot.settingsWritable
          ? <p className={css.errorNotice} role="alert">{t('settings.settingsReadOnly')}</p>
          : null}
      {snapshot.preferenceStatus === 'saving' ? <p className={css.notice} role="status">{t('settings.saving')}</p> : null}
      {snapshot.preferenceFailure === undefined ? null : (
        <div className={css.errorNotice} role="alert">
          <span>{snapshot.preferenceFailure.kind === 'unavailable' ? t('settings.settingsUnavailable') : t('settings.saveFailed')}</span>
          <button type="button" onClick={retryPreference}>{t('settings.retry')}</button>
        </div>
      )}
      {snapshot.packStatus === 'loading' ? <p className={css.notice} role="status">{t('settings.packLoading')}</p> : null}
      {snapshot.packStatus === 'error' ? (
        <div className={css.errorNotice} role="alert">
          <span>{t('settings.packFailed')}</span>
          <button type="button" onClick={() => { void refreshPacks() }}>{t('settings.retry')}</button>
          {snapshot.packError === undefined ? null : <code>{snapshot.packError}</code>}
        </div>
      ) : null}
      {snapshot.packFallback ? <p className={css.notice} role="status">{t('settings.packFallback')}</p> : null}
      {snapshot.packDiagnostics.length === 0 ? null : (
        <details className={css.diagnostics}>
          <summary>{t('settings.packDiagnostics')}</summary>
          <ul>{snapshot.packDiagnostics.map(item => <li key={item.directory}><strong>{item.directory}</strong>: {item.message}</li>)}</ul>
        </details>
      )}
      <p className={css.hint}>{t('settings.narrowHint')}</p>
      <fieldset className={css.controls} disabled={settingsDisabled}>
        <label className={css.row}>
          <span>{t('settings.layoutMode')}</span>
          <select value={settings.layoutMode} onChange={(event) => { setPreference('layoutMode', event.target.value) }}>
            <option value="scene">{t('settings.scene')}</option>
            <option value="work">{t('settings.work')}</option>
          </select>
        </label>
        <label className={css.row}>
          <span>{t('settings.characterVisible')}</span>
          <input type="checkbox" checked={settings.characterVisible} onChange={(event) => { setPreference('characterVisible', event.target.checked) }} />
        </label>
        <label className={css.row}>
          <span>{t('settings.motion')}</span>
          <select value={settings.motionPreference} onChange={(event) => { setPreference('motionPreference', event.target.value) }}>
            <option value="system">{t('settings.motionSystem')}</option>
            <option value="full">{t('settings.motionFull')}</option>
            <option value="reduced">{t('settings.motionReduced')}</option>
          </select>
        </label>
        <label className={css.rangeRow}>
          <span>{t('settings.panelOpacity')}</span>
          <input type="range" min="0.65" max="1" step="0.01" value={settings.panelOpacity} onChange={(event) => { setPreference('panelOpacity', Number(event.target.value)) }} />
          <output>{Math.round(settings.panelOpacity * 100)}%</output>
        </label>
        <label className={css.rangeRow}>
          <span>{t('settings.backgroundBlur')}</span>
          <input type="range" min="0" max="48" step="1" value={settings.backgroundBlur} onChange={(event) => { setPreference('backgroundBlur', Number(event.target.value)) }} />
          <output>{settings.backgroundBlur}px</output>
        </label>
        <label className={css.row}>
          <span>{t('settings.pack')}</span>
          <select value={snapshot.activePack.manifest.id} onChange={(event) => { setPreference('selectedPack', event.target.value) }}>
            {snapshot.packs.map(pack => <option key={pack.manifest.id} value={pack.manifest.id}>{pack.manifest.displayName}{pack.publishable ? '' : ` · ${t('settings.localOnly')}`}</option>)}
          </select>
        </label>
        {speechUnavailable ? <p className={css.notice} role="status">{t(snapshot.ttsUnavailableReason === 'unsupported' ? 'settings.ttsUnsupported' : 'settings.noVoices')}</p> : null}
        <label className={css.row}>
          <span>{t('settings.tts')}</span>
          <input type="checkbox" checked={settings.ttsEnabled} disabled={speechUnavailable} onChange={(event) => { setPreference('ttsEnabled', event.target.checked) }} />
        </label>
        <label className={css.row}>
          <span>{t('settings.autoRead')}</span>
          <input type="checkbox" checked={settings.ttsAutoRead} disabled={!settings.ttsEnabled || speechUnavailable} onChange={(event) => { setPreference('ttsAutoRead', event.target.checked) }} />
        </label>
        <label className={css.row}>
          <span>{t('settings.voice')}</span>
          <select value={settings.ttsVoice} disabled={!settings.ttsEnabled || speechUnavailable} onChange={(event) => { setPreference('ttsVoice', event.target.value) }}>
            <option value="">{t('settings.defaultVoice')}</option>
            {snapshot.voices.map(voice => <option key={voice} value={voice}>{voice}</option>)}
          </select>
        </label>
        <label className={css.rangeRow}>
          <span>{t('settings.rate')}</span>
          <input type="range" min="0.5" max="2" step="0.1" value={settings.ttsRate} disabled={!settings.ttsEnabled || speechUnavailable} onChange={(event) => { setPreference('ttsRate', Number(event.target.value)) }} />
          <output>{settings.ttsRate.toFixed(1)}</output>
        </label>
        <label className={css.rangeRow}>
          <span>{t('settings.pitch')}</span>
          <input type="range" min="0.5" max="2" step="0.1" value={settings.ttsPitch} disabled={!settings.ttsEnabled || speechUnavailable} onChange={(event) => { setPreference('ttsPitch', Number(event.target.value)) }} />
          <output>{settings.ttsPitch.toFixed(1)}</output>
        </label>
        <label className={css.rangeRow}>
          <span>{t('settings.volume')}</span>
          <input type="range" min="0" max="1" step="0.05" value={settings.ttsVolume} disabled={!settings.ttsEnabled || speechUnavailable} onChange={(event) => { setPreference('ttsVolume', Number(event.target.value)) }} />
          <output>{Math.round(settings.ttsVolume * 100)}%</output>
        </label>
        <label className={css.rangeRow}>
          <span>{t('settings.autoLimit')}</span>
          <input type="range" min="80" max="4000" step="40" value={settings.ttsMaxAutoChars} disabled={!settings.ttsEnabled || speechUnavailable} onChange={(event) => { setPreference('ttsMaxAutoChars', Number(event.target.value)) }} />
          <output>{settings.ttsMaxAutoChars}</output>
        </label>
      </fieldset>
      <Modal
        open={managerOpen}
        onClose={() => { setManagerOpen(false) }}
        title={t('settings.managerTitle')}
        closeLabel={t('settings.closeManager')}
        description={t('settings.managerDescription')}
        className={css.managerDialog as string}
        contentClassName={css.managerContent as string}
        footer={(
          <>
            {desktop === undefined ? null : <button type="button" className={css.secondaryAction} onClick={() => { void openPackFolder() }}>{t('settings.openPackFolder')}</button>}
            {desktop === undefined ? null : <button type="button" className={css.primaryAction} disabled={importing} onClick={() => { void importPack() }}>{importing ? t('settings.importingPack') : t('settings.importPack')}</button>}
          </>
        )}
      >
        <div className={css.packGrid}>
          {snapshot.packs.map((pack) => {
            const selected = pack.manifest.id === snapshot.activePack.manifest.id
            return (
              <article key={pack.manifest.id} className={css.packCard} data-selected={selected || undefined}>
                <img src={pack.assets.preview} alt="" aria-hidden="true" />
                <div className={css.packInfo}>
                  <strong>{pack.manifest.displayName}</strong>
                  <span>{t('settings.author')}: {pack.manifest.author}</span>
                  <span>{t('settings.version')}: {pack.manifest.version}</span>
                  <span>{t('settings.license')}: {pack.manifest.license ?? t('settings.localOnly')}</span>
                </div>
                <button type="button" disabled={selected || settingsDisabled} onClick={() => { setPreference('selectedPack', pack.manifest.id) }}>
                  {selected ? t('settings.selected') : t('settings.usePack')}
                </button>
              </article>
            )
          })}
        </div>
        {importResult?.kind === 'installed' ? <p className={css.notice} role="status">{t('settings.installedPack', { name: importResult.displayName })}</p> : null}
        {importResult?.kind === 'error' ? (
          <div className={css.errorNotice} role="alert">
            <span>{t(importResult.code === 'invalid' ? 'settings.importInvalid' : importResult.code === 'exists' ? 'settings.importExists' : 'settings.importFailed')}</span>
            <code>{importResult.detail}</code>
          </div>
        ) : null}
      </Modal>
    </section>
  )
}
