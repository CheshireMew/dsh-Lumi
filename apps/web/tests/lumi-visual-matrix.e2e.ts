// Lumi profile visual acceptance matrix. The committed test is the matrix;
// PNG evidence and its manifest are generated under artifacts/qa so ordinary
// source builds stay free of binary churn. Pairwise responsive cases cover
// every requested viewport, Windows scale, theme, layout, motion, visibility,
// sidebar, and locale value. Real replayed sessions cover the content states
// that cannot be represented by an empty shell.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import {
  fixtureUserPrompts,
  launchWebScaffold,
  realizeSeedFixture,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { windowsApprovalReplay } from './approval-composer.support.ts'
import { connectFreshWorkspace, connectFreshWorkspaceZh, REPO_ROOT } from './support.ts'

const MODE = webSnapshotMode()
const LUMI_OVERLAY = join(REPO_ROOT, 'packages', 'bundle', 'lumi-desktop', 'cordis.patch.yml')
const LUMI_INSTALL_ANCHOR = join(REPO_ROOT, 'apps', 'desktop', 'package.json')
const ARTIFACT_ROOT = join(REPO_ROOT, 'artifacts', 'qa', 'lumi-visual-matrix')
const MANIFEST = join(ARTIFACT_ROOT, 'manifest.json')
const NAVIGATION_SEED = join(REPO_ROOT, 'apps', 'web', 'tests', 'snapshots', 'navigation-panes', 'seed.jsonl')
const APPROVAL_FIXTURE = join(REPO_ROOT, 'apps', 'web', 'tests', 'snapshots', 'approval-composer', 'session.jsonl')
const QUESTION_FIXTURE = join(REPO_ROOT, 'apps', 'web', 'tests', 'snapshots', 'question-composer', 'session.jsonl')
const ERROR_FIXTURE = join(REPO_ROOT, 'apps', 'web', 'tests', 'snapshots', 'live-interactions', 'session.jsonl')

type ThemePreference = 'light' | 'dark' | 'system'
type LayoutMode = 'scene' | 'work'
type MotionPreference = 'system' | 'full' | 'reduced'
type LocalePreference = 'zh' | 'en'
type CharacterState = 'idle' | 'listening' | 'thinking' | 'tool' | 'waiting' | 'success' | 'error' | 'speaking'

interface VisualRecord {
  name: string
  file: string
  viewport: { width: number; height: number }
  deviceScaleFactor: number
  theme: ThemePreference
  colorScheme: 'light' | 'dark'
  requestedMode: LayoutMode
  effectiveMode: LayoutMode
  motion: MotionPreference
  characterVisible: boolean
  sidebarCollapsed: boolean
  locale: LocalePreference
  contentState: string
  characterState: CharacterState
}

interface CaptureOptions {
  name: string
  page: Page
  theme: ThemePreference
  colorScheme: 'light' | 'dark'
  requestedMode: LayoutMode
  motion: MotionPreference
  characterVisible: boolean
  locale: LocalePreference
  contentState: string
  expectedState?: CharacterState
  expectedCharacterVisible?: boolean
  deviceScaleFactor?: number
  settleMs?: number
}

const records: VisualRecord[] = []

async function mutateSettings(
  scaffold: WebScaffold,
  options: {
    theme: ThemePreference
    locale: LocalePreference
    layoutMode: LayoutMode
    motion: MotionPreference
    characterVisible: boolean
  },
): Promise<void> {
  await scaffold.ctx.settings.mutate(settingsNamespace('ui-theme'), [
    { op: 'set', path: ['preference'], value: options.theme },
  ])
  await scaffold.ctx.settings.mutate(settingsNamespace('locale'), [
    { op: 'set', path: ['preference'], value: options.locale },
  ])
  await scaffold.ctx.settings.mutate(settingsNamespace('ui-lumi'), [
    { op: 'set', path: ['layoutMode'], value: options.layoutMode },
    { op: 'set', path: ['motionPreference'], value: options.motion },
    { op: 'set', path: ['characterVisible'], value: options.characterVisible },
  ])
}

async function captureVisual(options: CaptureOptions): Promise<void> {
  const frame = options.page.locator('[data-character-state]')
  await frame.waitFor({ timeout: 30_000 })
  if (options.expectedState !== undefined) {
    await expect.poll(() => frame.getAttribute('data-character-state'), { timeout: 15_000 })
      .toBe(options.expectedState)
  }
  await options.page.evaluate(async () => { await document.fonts.ready })
  // The official sidebar intentionally keeps its former width for a 150ms
  // crossfade. Capture only the stable rail, never that transition frame.
  await options.page.waitForTimeout(options.settleMs ?? 250)
  const geometry = await options.page.evaluate(() => {
    const frameElement = document.querySelector<HTMLElement>('[data-character-state]')
    const conversation = document.querySelector<HTMLElement>('[data-lumi-conversation]')
    const sidebar = document.querySelector<HTMLElement>('[data-lumi-sidebar]')
    if (frameElement === null || conversation === null || sidebar === null) {
      throw new Error('lumi visual matrix: frame seats are missing')
    }
    const frameBox = frameElement.getBoundingClientRect()
    const conversationBox = conversation.getBoundingClientRect()
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      frame: { left: frameBox.left, top: frameBox.top, right: frameBox.right, bottom: frameBox.bottom },
      conversation: {
        left: conversationBox.left,
        top: conversationBox.top,
        right: conversationBox.right,
        bottom: conversationBox.bottom,
      },
      effectiveMode: frameElement.dataset.mode,
      characterState: frameElement.dataset.characterState,
      characterVisible: frameElement.hasAttribute('data-character-visible'),
      motion: frameElement.dataset.motion,
      frameText: frameElement.textContent ?? '',
      sidebarCollapsed: sidebar.dataset.collapsed === 'true',
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
  expect(geometry.frame.left).toBeGreaterThanOrEqual(0)
  expect(geometry.frame.top).toBeGreaterThanOrEqual(0)
  expect(geometry.frame.right).toBeLessThanOrEqual(geometry.viewport.width + 1)
  expect(geometry.frame.bottom).toBeLessThanOrEqual(geometry.viewport.height + 1)
  expect(geometry.conversation.left).toBeGreaterThanOrEqual(0)
  expect(geometry.conversation.top).toBeGreaterThanOrEqual(0)
  expect(geometry.conversation.right).toBeLessThanOrEqual(geometry.viewport.width + 1)
  expect(geometry.conversation.bottom).toBeLessThanOrEqual(geometry.viewport.height + 1)
  expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1)
  expect(geometry.dark).toBe(options.theme === 'dark' || options.theme === 'system' && options.colorScheme === 'dark')
  expect(geometry.characterVisible).toBe(options.expectedCharacterVisible ?? options.characterVisible)
  expect(geometry.motion).toBe(options.motion === 'reduced' ? 'reduced' : 'full')
  if (options.expectedState !== undefined) {
    const labels: Record<CharacterState, { en: string; zh: string }> = {
      idle: { en: 'Idle', zh: '待机' },
      listening: { en: 'Listening', zh: '在听' },
      thinking: { en: 'Thinking', zh: '思考中' },
      tool: { en: 'Using a tool', zh: '执行工具' },
      waiting: { en: 'Waiting for you', zh: '等你确认' },
      success: { en: 'Complete', zh: '完成啦' },
      error: { en: 'Needs attention', zh: '遇到问题' },
      speaking: { en: 'Speaking', zh: '朗读中' },
    }
    expect(geometry.frameText).toContain(labels[options.expectedState][options.locale])
  }
  if (options.expectedState !== undefined) expect(geometry.characterState).toBe(options.expectedState)
  const file = join(ARTIFACT_ROOT, `${options.name}.png`)
  await options.page.screenshot({ path: file, fullPage: true })
  records.push({
    name: options.name,
    file,
    viewport: geometry.viewport,
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
    theme: options.theme,
    colorScheme: options.colorScheme,
    requestedMode: options.requestedMode,
    effectiveMode: geometry.effectiveMode as LayoutMode,
    motion: options.motion,
    characterVisible: geometry.characterVisible,
    sidebarCollapsed: geometry.sidebarCollapsed,
    locale: options.locale,
    contentState: options.contentState,
    characterState: geometry.characterState as CharacterState,
  })
}

async function closeWorld(browser: Browser | undefined, scaffold: WebScaffold | undefined): Promise<void> {
  const failures: unknown[] = []
  await browser?.close().catch((error: unknown) => { failures.push(error) })
  await scaffold?.close().catch((error: unknown) => { failures.push(error) })
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'lumi visual matrix teardown failed')
}

const TOOL_SCRIPT: ReplayEntry[] = [
  {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: CallId('call_lumi_visual_tool'),
          name: process.platform === 'win32' ? 'pwsh' : 'bash',
          arguments: JSON.stringify({
            command: process.platform === 'win32'
              ? "Start-Sleep -Seconds 4; Write-Output 'LUMI_VISUAL_TOOL_OK'"
              : 'node -e "setTimeout(function(){console.log(\'LUMI_VISUAL_TOOL_OK\')},4000)"',
            description: 'Hold a real tool call open for visual acceptance',
          }),
        },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  },
  {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'TOOL_DONE' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  },
]

describe.skipIf(MODE === 'record')('lumi profile visual acceptance matrix', () => {
  beforeAll(async () => { await mkdir(ARTIFACT_ROOT, { recursive: true }) })

  afterAll(async () => {
    await writeFile(MANIFEST, `${JSON.stringify({ generatedAt: new Date().toISOString(), records }, null, 2)}\n`)
  })

  it('covers every viewport, Windows scale, theme, mode, motion, visibility, sidebar, and locale value', async () => {
    const scaffold = await launchWebScaffold({
      nativeWindowsShell: true,
      extraOverlayPath: LUMI_OVERLAY,
      installAnchor: LUMI_INSTALL_ANCHOR,
    })
    const browser = await chromium.launch()
    const cases = [
      { name: 'empty-1920x1080-100-light-scene-zh', width: 1920, height: 1080, scale: 1, theme: 'light', color: 'light', mode: 'scene', expected: 'scene', motion: 'full', visible: true, locale: 'zh' },
      { name: 'empty-1920x1080-125-dark-work-en', width: 1920, height: 1080, scale: 1.25, theme: 'dark', color: 'dark', mode: 'work', expected: 'work', motion: 'reduced', visible: false, locale: 'en' },
      { name: 'empty-1920x1080-150-system-scene-zh', width: 1920, height: 1080, scale: 1.5, theme: 'system', color: 'dark', mode: 'scene', expected: 'scene', motion: 'system', visible: true, locale: 'zh' },
      { name: 'empty-1440x900-100-dark-scene-en', width: 1440, height: 900, scale: 1, theme: 'dark', color: 'dark', mode: 'scene', expected: 'scene', motion: 'full', visible: true, locale: 'en' },
      { name: 'empty-1440x900-125-system-work-zh', width: 1440, height: 900, scale: 1.25, theme: 'system', color: 'light', mode: 'work', expected: 'work', motion: 'reduced', visible: false, locale: 'zh' },
      { name: 'empty-1440x900-150-light-scene-en', width: 1440, height: 900, scale: 1.5, theme: 'light', color: 'light', mode: 'scene', expected: 'scene', motion: 'system', visible: true, locale: 'en' },
      { name: 'empty-1280x720-100-system-scene-zh', width: 1280, height: 720, scale: 1, theme: 'system', color: 'dark', mode: 'scene', expected: 'scene', motion: 'reduced', visible: true, locale: 'zh' },
      { name: 'empty-1280x720-125-light-work-en', width: 1280, height: 720, scale: 1.25, theme: 'light', color: 'light', mode: 'work', expected: 'work', motion: 'full', visible: false, locale: 'en' },
      { name: 'empty-1280x720-150-dark-scene-zh', width: 1280, height: 720, scale: 1.5, theme: 'dark', color: 'dark', mode: 'scene', expected: 'scene', motion: 'system', visible: true, locale: 'zh' },
      { name: 'empty-1024x768-100-light-forced-work-en', width: 1024, height: 768, scale: 1, theme: 'light', color: 'light', mode: 'scene', expected: 'work', motion: 'full', visible: true, locale: 'en' },
      { name: 'empty-1024x768-125-dark-work-zh', width: 1024, height: 768, scale: 1.25, theme: 'dark', color: 'dark', mode: 'work', expected: 'work', motion: 'reduced', visible: false, locale: 'zh' },
      { name: 'empty-1024x768-150-system-forced-work-en', width: 1024, height: 768, scale: 1.5, theme: 'system', color: 'light', mode: 'scene', expected: 'work', motion: 'system', visible: true, locale: 'en' },
    ] as const
    try {
      for (const item of cases) {
        await mutateSettings(scaffold, {
          theme: item.theme,
          locale: item.locale,
          layoutMode: item.mode,
          motion: item.motion,
          characterVisible: item.visible,
        })
        const context = await browser.newContext({
          viewport: { width: item.width, height: item.height },
          deviceScaleFactor: item.scale,
          colorScheme: item.color,
          reducedMotion: item.motion === 'reduced' ? 'reduce' : 'no-preference',
          locale: item.locale === 'zh' ? 'zh-CN' : 'en-US',
        })
        try {
          const page = await context.newPage()
          const tripwire = watchConsole(page)
          await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
          await expect.poll(
            () => page.locator('[data-character-state]').getAttribute('data-mode'),
            { timeout: 30_000 },
          ).toBe(item.expected)
          await captureVisual({
            name: item.name,
            page,
            theme: item.theme,
            colorScheme: item.color,
            requestedMode: item.mode,
            motion: item.motion,
            characterVisible: item.visible,
            locale: item.locale,
            contentState: 'no-session',
            expectedState: 'idle',
            ...(item.width <= 1024 ? { expectedCharacterVisible: false } : {}),
            deviceScaleFactor: item.scale,
          })
          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings).toEqual([])
        } finally {
          await context.close()
        }
      }
    } finally {
      await closeWorld(browser, scaffold)
    }
  }, 240_000)

  it('captures ordinary and long history, completed tools, details, hidden character, and a stable collapsed sidebar', async () => {
    const scaffold = await launchWebScaffold({
      nativeWindowsShell: true,
      extraOverlayPath: LUMI_OVERLAY,
      installAnchor: LUMI_INSTALL_ANCHOR,
    })
    const raw = await readFile(NAVIGATION_SEED, 'utf8')
    await seedSession(scaffold, realizeSeedFixture(scaffold, raw, 'lumi-visual-history'), 'lumi-visual-history')
    await mutateSettings(scaffold, {
      theme: 'dark', locale: 'en', layoutMode: 'work', motion: 'reduced', characterVisible: true,
    })
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'dark' })
      const tripwire = watchConsole(page)
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      const groupRow = page.locator('[role="treeitem"]').first()
      await groupRow.waitFor({ timeout: 15_000 })
      await groupRow.click()
      const sessionRow = page.locator('[role="treeitem"]').nth(1)
      await sessionRow.waitFor({ timeout: 10_000 })
      await sessionRow.click()
      await page.getByText('Navigation Summary', { exact: true }).waitFor({ timeout: 15_000 })
      await captureVisual({
        name: 'history-ordinary-long-dark-work-en', page, theme: 'dark', colorScheme: 'dark',
        requestedMode: 'work', motion: 'reduced', characterVisible: true, locale: 'en',
        contentState: 'ordinary-and-long-conversation', expectedState: 'idle',
      })

      // The seed's bash presentation is POSIX-only. Select the recorded read
      // call so this Windows lane opens a real, expandable tool result.
      const detailRow = page.locator('[data-variant="read"]').first()
      const detailToggle = detailRow.locator('[aria-expanded]').first()
      await detailToggle.waitFor({ timeout: 10_000 })
      // Enter targets the disclosure row itself; a geometric click near its
      // center can land on the nested file-path button, which deliberately
      // stops propagation so it can open the file without expanding the row.
      if (await detailToggle.getAttribute('aria-expanded') !== 'true') await detailToggle.press('Enter')
      await expect.poll(() => detailToggle.getAttribute('aria-expanded')).toBe('true')
      await detailRow.getByRole('button', { name: 'Inspect' }).click({ force: true })
      await page.locator('[data-lumi-details][data-open]').waitFor({ timeout: 10_000 })
      await captureVisual({
        name: 'history-tool-result-details-dark-work-en', page, theme: 'dark', colorScheme: 'dark',
        requestedMode: 'work', motion: 'reduced', characterVisible: true, locale: 'en',
        contentState: 'tool-result-and-details-drawer', expectedState: 'idle',
      })
      await page.locator('[data-lumi-details]').getByRole('button', { name: 'Close details' }).click()

      await scaffold.ctx.settings.mutate(settingsNamespace('ui-lumi'), [
        { op: 'set', path: ['characterVisible'], value: false },
      ])
      await expect.poll(() => page.locator('[data-character-state]').getAttribute('data-character-visible'))
        .toBeNull()
      const collapse = page.locator('[data-lumi-sidebar]').getByRole('button', { name: 'Collapse sidebar' })
      await collapse.click()
      await expect.poll(() => page.locator('[data-lumi-sidebar]').getAttribute('data-collapsed')).toBe('true')
      await captureVisual({
        name: 'history-character-hidden-sidebar-collapsed', page, theme: 'dark', colorScheme: 'dark',
        requestedMode: 'work', motion: 'reduced', characterVisible: false, locale: 'en',
        contentState: 'long-conversation', expectedState: 'idle',
      })
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      await closeWorld(browser, scaffold)
    }
  }, 120_000)

  it('captures a real running tool and its success transition', async () => {
    const override = join(ARTIFACT_ROOT, 'tool-replay.override.json')
    await writeFile(override, `${JSON.stringify(TOOL_SCRIPT, null, 2)}\n`)
    const fixture = await readFile(APPROVAL_FIXTURE, 'utf8')
    const prompt = fixtureUserPrompts(fixture)[0]
    if (prompt === undefined) throw new Error('lumi visual tool fixture has no user prompt')
    const scaffold = await launchWebScaffold({
      nativeWindowsShell: true,
      extraOverlayPath: LUMI_OVERLAY,
      installAnchor: LUMI_INSTALL_ANCHOR,
      replayFixture: APPROVAL_FIXTURE,
      replayOverride: override,
      paceMs: 5,
    })
    await mutateSettings(scaffold, {
      theme: 'light', locale: 'en', layoutMode: 'scene', motion: 'full', characterVisible: true,
    })
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'light' })
      const tripwire = watchConsole(page)
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      const settled = scaffold.whenTurnSettled(60_000)
      await page.locator('textarea').first().fill(prompt)
      await page.locator('textarea').first().press('Enter')
      await captureVisual({
        name: 'tool-running-light-scene-en', page, theme: 'light', colorScheme: 'light',
        requestedMode: 'scene', motion: 'full', characterVisible: true, locale: 'en',
        contentState: 'tool-running', expectedState: 'tool', settleMs: 25,
      })
      await settled
      await captureVisual({
        name: 'tool-success-light-scene-en', page, theme: 'light', colorScheme: 'light',
        requestedMode: 'scene', motion: 'full', characterVisible: true, locale: 'en',
        contentState: 'tool-success', expectedState: 'success',
      })
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      await closeWorld(browser, scaffold)
    }
  }, 120_000)

  it('captures approval, question, and terminal error states through real replayed product flows', async () => {
    const waitingCases = [
      { name: 'approval-waiting-dark-work-en', fixture: APPROVAL_FIXTURE, selector: '[data-approval-key]', answer: 'Allow once', contentState: 'approval' },
      { name: 'question-waiting-system-work-en', fixture: QUESTION_FIXTURE, selector: '[data-question-key]', answer: 'Blue', contentState: 'question' },
    ] as const
    for (const item of waitingCases) {
      const raw = await readFile(item.fixture, 'utf8')
      const prompt = fixtureUserPrompts(raw)[0]
      if (prompt === undefined) throw new Error(`${item.name} fixture has no user prompt`)
      let replayOverride: string | undefined
      if (item.contentState === 'approval' && process.platform === 'win32') {
        const match = /exactly this text on one line: (.+)\. Use one bash command/.exec(prompt)
        if (match?.[1] === undefined) throw new Error('approval fixture prompt does not expose its expected file contents')
        replayOverride = join(ARTIFACT_ROOT, 'approval-replay.win32.override.json')
        await writeFile(replayOverride, `${JSON.stringify(windowsApprovalReplay(item.fixture, match[1]), null, 2)}\n`)
      }
      const scaffold = await launchWebScaffold({
        nativeWindowsShell: true,
        extraOverlayPath: LUMI_OVERLAY,
        installAnchor: LUMI_INSTALL_ANCHOR,
        replayFixture: item.fixture,
        ...(replayOverride === undefined ? {} : { replayOverride }),
        paceMs: 5,
      })
      await mutateSettings(scaffold, {
        theme: item.contentState === 'approval' ? 'dark' : 'system',
        locale: 'en', layoutMode: 'work', motion: 'reduced', characterVisible: true,
      })
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, locale: 'en-US', colorScheme: 'dark' })
        const tripwire = watchConsole(page)
        await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
        await connectFreshWorkspace(page, scaffold.workspaceCwd)
        if (item.contentState === 'approval') {
          await page.locator('[aria-label^="Access mode"]').click()
          await page.getByRole('menuitem', { name: 'Read Only' }).click()
          await page.getByRole('button', { name: 'Access mode, current: Read Only' }).waitFor({ timeout: 15_000 })
        }
        const settled = scaffold.whenTurnSettled(60_000)
        await page.locator('textarea').first().fill(prompt)
        await page.locator('textarea').first().press('Enter')
        const takeover = page.locator(item.selector)
        await takeover.waitFor({ timeout: 60_000 })
        await captureVisual({
          name: item.name,
          page,
          theme: item.contentState === 'approval' ? 'dark' : 'system',
          colorScheme: 'dark',
          requestedMode: 'work',
          motion: 'reduced',
          characterVisible: true,
          locale: 'en',
          contentState: item.contentState,
          expectedState: 'waiting',
        })
        if (item.contentState === 'approval') {
          await takeover.getByRole('button', { name: item.answer }).click()
        } else {
          await takeover.getByRole('checkbox', { name: item.answer }).click()
          await takeover.getByRole('textbox').fill('Visual matrix answer')
          await takeover.getByRole('textbox').press('Enter')
        }
        await settled
        expect(tripwire.pageErrors).toEqual([])
        expect(tripwire.warnings).toEqual([])
      } finally {
        await closeWorld(browser, scaffold)
      }
    }

    const errorOverride = join(ARTIFACT_ROOT, 'error-replay.override.json')
    await writeFile(errorOverride, `${JSON.stringify({
      patches: [{ at: 0, entry: { kind: 'throw', chunks: [], message: 'Visual matrix provider failure', code: 'AUTH' } }],
    }, null, 2)}\n`)
    const errorRaw = await readFile(ERROR_FIXTURE, 'utf8')
    const errorPrompt = fixtureUserPrompts(errorRaw)[0]
    if (errorPrompt === undefined) throw new Error('lumi visual error fixture has no user prompt')
    const errorScaffold = await launchWebScaffold({
      nativeWindowsShell: true,
      extraOverlayPath: LUMI_OVERLAY,
      installAnchor: LUMI_INSTALL_ANCHOR,
      replayFixture: ERROR_FIXTURE,
      replayOverride: errorOverride,
    })
    await mutateSettings(errorScaffold, {
      theme: 'dark', locale: 'zh', layoutMode: 'work', motion: 'reduced', characterVisible: true,
    })
    const errorBrowser = await chromium.launch()
    try {
      const page = await errorBrowser.newPage({ viewport: { width: 1024, height: 768 }, locale: 'zh-CN', colorScheme: 'dark' })
      const tripwire = watchConsole(page)
      await page.goto(errorScaffold.baseUrl, { waitUntil: 'load' })
      // Host preference wins over the English fixture prompt and proves the
      // same failure surface remains usable under the Chinese shell.
      await connectFreshWorkspaceZh(page, errorScaffold.workspaceCwd)
      const settled = errorScaffold.whenTurnSettled(60_000)
      await page.locator('textarea').first().fill(errorPrompt)
      await page.locator('textarea').first().press('Enter')
      await settled
      await captureVisual({
        name: 'turn-error-dark-forced-work-zh', page, theme: 'dark', colorScheme: 'dark',
        requestedMode: 'work', motion: 'reduced', characterVisible: true, locale: 'zh',
        contentState: 'turn-error', expectedState: 'error', expectedCharacterVisible: false,
      })
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      await closeWorld(errorBrowser, errorScaffold)
    }
  }, 240_000)
})
