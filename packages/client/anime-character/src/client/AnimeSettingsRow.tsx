import type { AnimeSettingsRowProps } from './slots.ts'
import css from './AnimeSettingsRow.module.css'

/** General settings surface for the shared `ui-anime` namespace. */
export function AnimeSettingsRow({ useCharacter, setPreference, refreshPacks, t }: AnimeSettingsRowProps) {
  const snapshot = useCharacter(value => value)
  const { settings } = snapshot
  const speechUnavailable = snapshot.ttsUnavailableReason !== undefined
  return (
    <section className={css.group} aria-labelledby="ui-anime-settings-title">
      <div className={css.heading}>
        <span id="ui-anime-settings-title">{t('settings.title')}</span>
        <button type="button" className={css.refresh} aria-label={t('settings.refreshPacks')} onClick={() => { void refreshPacks() }}>↻</button>
      </div>
      {snapshot.notice === undefined ? null : <p className={css.notice} role="status">{snapshot.notice}</p>}
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
    </section>
  )
}
