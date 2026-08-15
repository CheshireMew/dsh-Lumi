/** Simplified Chinese lumi-shell messages. */
export const zh = {
  'mode.scene': '场景模式',
  'mode.work': '工作模式',
  'title.app': 'DeepSeek Harness · Lumi',
  'title.packs': '角色包',
  'title.logs': '日志',
  'window.minimize': '最小化',
  'window.maximize': '最大化或还原',
  'window.close': '关闭',
  'bond.label': '默契',
  'bond.level': 'Lv.{level}',
  'state.idle': '待机',
  'state.listening': '在听',
  'state.thinking': '思考中',
  'state.tool': '执行工具',
  'state.speaking': '朗读中',
  'state.success': '完成啦',
  'state.error': '遇到问题',
  'state.waiting': '等你确认',
  'details.close': '关闭详情',
  'sidebar.toggle': '展开或收起侧栏',
} as const satisfies Record<string, string>

/** Translation keys owned by the lumi shell. */
export type LumiShellKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'lumi.shell': LumiShellKey
  }
}

/** English lumi-shell messages. */
export const en = {
  'mode.scene': 'Scene',
  'mode.work': 'Work',
  'title.app': 'DeepSeek Harness · Lumi',
  'title.packs': 'Character packs',
  'title.logs': 'Logs',
  'window.minimize': 'Minimize',
  'window.maximize': 'Maximize or restore',
  'window.close': 'Close',
  'bond.label': 'Bond',
  'bond.level': 'Lv.{level}',
  'state.idle': 'Idle',
  'state.listening': 'Listening',
  'state.thinking': 'Thinking',
  'state.tool': 'Using a tool',
  'state.speaking': 'Speaking',
  'state.success': 'Complete',
  'state.error': 'Needs attention',
  'state.waiting': 'Waiting for you',
  'details.close': 'Close details',
  'sidebar.toggle': 'Toggle sidebar',
} satisfies Record<LumiShellKey, string>
