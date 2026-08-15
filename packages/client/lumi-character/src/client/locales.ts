/** Simplified Chinese character-domain messages. */
export const zh = {
  'settings.title': '二次元桌面',
  'settings.refreshPacks': '刷新角色包',
  'settings.layoutMode': '默认布局',
  'settings.scene': '场景模式',
  'settings.work': '工作模式',
  'settings.characterVisible': '显示角色',
  'settings.motion': '动画偏好',
  'settings.motionSystem': '跟随系统',
  'settings.motionFull': '完整动画',
  'settings.motionReduced': '减少动画',
  'settings.panelOpacity': '面板不透明度',
  'settings.backgroundBlur': '背景模糊',
  'settings.pack': '角色包',
  'settings.localOnly': '仅本机',
  'settings.tts': '启用语音',
  'settings.autoRead': '自动朗读新回复',
  'settings.voice': '系统声音',
  'settings.defaultVoice': '系统默认',
  'settings.rate': '语速',
  'settings.pitch': '音调',
  'settings.volume': '音量',
  'settings.autoLimit': '自动朗读字数',
  'settings.ttsUnsupported': '当前浏览器不支持系统语音。聊天功能不受影响。',
  'settings.noVoices': '系统没有可用语音。安装系统语音后可启用朗读，聊天功能不受影响。',
  'voice.read': '朗读这条回复',
  'voice.pause': '暂停朗读',
  'voice.resume': '继续朗读',
  'voice.stop': '停止朗读',
} as const satisfies Record<string, string>

/** English character-domain messages. */
export const en = {
  'settings.title': 'Lumi desktop',
  'settings.refreshPacks': 'Refresh character packs',
  'settings.layoutMode': 'Default layout',
  'settings.scene': 'Scene mode',
  'settings.work': 'Work mode',
  'settings.characterVisible': 'Show character',
  'settings.motion': 'Motion preference',
  'settings.motionSystem': 'Follow system',
  'settings.motionFull': 'Full motion',
  'settings.motionReduced': 'Reduced motion',
  'settings.panelOpacity': 'Panel opacity',
  'settings.backgroundBlur': 'Background blur',
  'settings.pack': 'Character pack',
  'settings.localOnly': 'local only',
  'settings.tts': 'Enable speech',
  'settings.autoRead': 'Read new replies automatically',
  'settings.voice': 'System voice',
  'settings.defaultVoice': 'System default',
  'settings.rate': 'Rate',
  'settings.pitch': 'Pitch',
  'settings.volume': 'Volume',
  'settings.autoLimit': 'Automatic read limit',
  'settings.ttsUnsupported': 'This browser does not support system speech. Chat remains available.',
  'settings.noVoices': 'No system voice is available. Install one to enable speech; chat remains available.',
  'voice.read': 'Read this reply',
  'voice.pause': 'Pause reading',
  'voice.resume': 'Resume reading',
  'voice.stop': 'Stop reading',
} satisfies Record<LumiCharacterKey, string>

/** Translation keys owned by the character domain. */
export type LumiCharacterKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'lumi.character': LumiCharacterKey
  }
}
