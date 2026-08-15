import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(desktopRoot, '..', '..')
const artifacts = join(repositoryRoot, 'artifacts', 'qa')
const home = join(artifacts, 'desktop-e2e-home')
const userData = join(home, 'electron-user-data')
const screenshot = join(artifacts, 'lumi-desktop.png')
const narrowScreenshot = join(artifacts, 'lumi-desktop-narrow.png')
mkdirSync(artifacts, { recursive: true })
mkdirSync(userData, { recursive: true })
writeFileSync(
  join(userData, 'lumi-window-state.json'),
  `${JSON.stringify({ x: 80, y: 80, width: 1440, height: 920, maximized: false })}\n`,
)

const electronExecutable = createRequire(import.meta.url)('electron') as string

async function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (open: boolean): void => { socket.destroy(); resolveOpen(open) }
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
    socket.setTimeout(500, () => { done(false) })
  })
}

async function waitForClosedPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!await portIsOpen(port)) return
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  assert.fail(`Harness port ${port} remained open`)
}

async function waitForSecondInstanceExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  const timeout = setTimeout(() => { child.kill() }, 15_000)
  try {
    const [code] = await once(child, 'exit')
    return code as number | null
  } finally {
    clearTimeout(timeout)
  }
}

const application = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`, '--force-device-scale-factor=1.25'],
  cwd: desktopRoot,
  env: {
    ...process.env,
    DSH_HOME: home,
    ELECTRON_CACHE: process.env.ELECTRON_CACHE ?? join(home, 'electron-cache'),
  },
  timeout: 90_000,
})

const observedPorts = new Set<number>()
let finalPort: number | undefined

async function harnessProcesses(): Promise<Array<{ pid: number; serviceName?: string }>> {
  return application.evaluate(({ app }) => app.getAppMetrics()
    .filter(metric => metric.type === 'Utility' && metric.name === 'Lumi Harness')
    .map(metric => ({ pid: metric.pid, serviceName: metric.serviceName })))
}

async function waitForHarnessProcess(excludedPid?: number): Promise<{ pid: number; serviceName?: string }> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const process = (await harnessProcesses()).find(candidate => candidate.pid !== excludedPid)
    if (process !== undefined) return process
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  assert.fail('Harness utility process did not appear')
}

async function killHarnessProcess(): Promise<number> {
  return application.evaluate(({ app }) => {
    const metric = app.getAppMetrics().find(candidate => candidate.type === 'Utility' && candidate.name === 'Lumi Harness')
    if (metric === undefined) throw new Error('Harness utility process is missing')
    process.kill(metric.pid)
    return metric.pid
  })
}

function recordHarnessUrl(url: string): number {
  const parsed = new URL(url)
  assert.equal(parsed.hostname, '127.0.0.1')
  const port = Number(parsed.port)
  assert.ok(Number.isInteger(port) && port > 0)
  observedPorts.add(port)
  finalPort = port
  return port
}

try {
  const page = await application.firstWindow()
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//u, { timeout: 90_000 })
  await page.locator('[data-desktop="true"] [data-lumi-conversation]').waitFor({ timeout: 90_000 })
  const initialPort = recordHarnessUrl(page.url())
  assert.equal(await portIsOpen(initialPort), true)
  assert.equal((await harnessProcesses()).length, 1)
  const disclosure = page.getByRole('button', { name: '继续' })
  try {
    await disclosure.waitFor({ state: 'visible', timeout: 1_000 })
    await disclosure.click()
  } catch {
    // Returning test profiles may have accepted the one-time disclosure already.
  }
  const fullAccessDialog = page.getByRole('dialog', { name: /Full access/u })
  if (await fullAccessDialog.isVisible().catch(() => false)) {
    await fullAccessDialog.getByRole('checkbox').check()
    await fullAccessDialog.getByRole('button', { name: /(?:启用|Enable) Full access/u }).click()
  }
  for (let overlay = 0; overlay < 3; overlay += 1) {
    const presentation = page.locator('[role="presentation"]:visible').last()
    if (await presentation.count() === 0) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
  }

  const rendererBoundary = await page.evaluate(() => ({
    nodeRequire: typeof (window as unknown as { require?: unknown }).require,
    apiKeys: Object.keys(window.dshDesktop ?? {}).sort(),
    appKeys: Object.keys(window.dshDesktop?.app ?? {}).sort(),
    windowKeys: Object.keys(window.dshDesktop?.window ?? {}).sort(),
    platform: window.dshDesktop?.platform,
  }))
  assert.equal(rendererBoundary.nodeRequire, 'undefined')
  assert.deepEqual(rendererBoundary.apiKeys, ['app', 'appVersion', 'platform', 'window'])
  assert.deepEqual(rendererBoundary.appKeys, ['openCharacterPacksFolder', 'openLogsFolder', 'restartHarness'])
  assert.deepEqual(rendererBoundary.windowKeys, ['close', 'getState', 'minimize', 'onStateChanged', 'toggleMaximize'])
  assert.equal(rendererBoundary.platform, 'win32')
  assert.ok(await page.evaluate(() => window.devicePixelRatio) >= 1.2)
  const bondProgress = page.getByRole('progressbar', { name: /(?:默契|Bond)/u })
  await bondProgress.waitFor()
  assert.equal(await bondProgress.getAttribute('aria-valuemin'), '0')
  assert.equal(await bondProgress.getAttribute('aria-valuemax'), '100')
  assert.equal(await page.getByRole('img', { name: /Lumi/u }).count(), 1)
  assert.equal(await page.getByRole('button', { name: '场景模式' }).first().getAttribute('aria-pressed'), 'true')
  assert.equal(await page.getByRole('button', { name: '工作模式' }).first().getAttribute('aria-pressed'), 'false')

  await page.evaluate(() => window.dshDesktop?.window.minimize())
  const secondInstance = spawn(electronExecutable, [desktopRoot, `--user-data-dir=${userData}`], {
    cwd: desktopRoot,
    env: { ...process.env, DSH_HOME: home, ELECTRON_CACHE: process.env.ELECTRON_CACHE ?? join(home, 'electron-cache') },
    stdio: 'ignore',
  })
  assert.equal(await waitForSecondInstanceExit(secondInstance), 0)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const restored = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return window !== undefined && !window.isMinimized() && window.isVisible()
    })
    if (restored) break
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  assert.equal((await harnessProcesses()).length, 1)

  const state = await page.evaluate(() => window.dshDesktop?.window.getState())
  assert.deepEqual(state, { maximized: false, fullscreen: false })
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1440, 900) })
  await page.waitForFunction(() => window.innerWidth >= 1400)
  await page.evaluate(() => { window.dshDesktop?.window.toggleMaximize() })
  await page.waitForFunction(async () => (await window.dshDesktop?.window.getState())?.maximized === true)
  await page.evaluate(() => { window.dshDesktop?.window.toggleMaximize() })
  await page.waitForFunction(async () => (await window.dshDesktop?.window.getState())?.maximized === false)
  assert.equal(await page.locator('[data-character-state]').getAttribute('data-character-state'), 'idle')
  await page.getByRole('banner').getByRole('button', { name: '工作模式' }).click()
  await page.waitForFunction(() => document.querySelector('[data-character-state]')?.getAttribute('data-mode') === 'work')
  await page.getByRole('banner').getByRole('button', { name: '场景模式' }).click()
  await page.waitForFunction(() => document.querySelector('[data-character-state]')?.getAttribute('data-mode') === 'scene')
  await page.screenshot({ path: screenshot, fullPage: true })

  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(900, 640)
  })
  await page.waitForFunction(() => window.innerWidth <= 1099)
  const lumiSidebar = page.locator('[data-lumi-sidebar]')
  await lumiSidebar.waitFor()
  await page.waitForFunction(() => document.querySelector('[data-lumi-sidebar]')?.getAttribute('data-collapsed') === 'true')
  // SidebarRoot keeps its prior width for a 150ms crossfade before the stable
  // icon rail replaces it. The acceptance screenshot must represent the
  // settled narrow layout, not the intentional transition frame.
  await page.waitForTimeout(250)
  const sidebarBox = await lumiSidebar.boundingBox()
  assert.ok(sidebarBox !== null && sidebarBox.width >= 55 && sidebarBox.width <= 57)
  await page.screenshot({ path: narrowScreenshot, fullPage: true })

  await application.evaluate(({ shell }) => {
    const state = globalThis as typeof globalThis & { __dshOpenedExternal?: string[] }
    state.__dshOpenedExternal = []
    Object.defineProperty(shell, 'openExternal', {
      configurable: true,
      value: Function('url', 'globalThis.__dshOpenedExternal.push(url); return Promise.resolve()'),
    })
  })
  await page.evaluate(() => { window.open('https://example.com/lumi-desktop-e2e', '_blank') })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const opened = await application.evaluate(
      () => (globalThis as typeof globalThis & { __dshOpenedExternal?: string[] }).__dshOpenedExternal ?? [],
    )
    if (opened.length > 0) break
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  assert.deepEqual(
    await application.evaluate(() => (globalThis as typeof globalThis & { __dshOpenedExternal?: string[] }).__dshOpenedExternal),
    ['https://example.com/lumi-desktop-e2e'],
  )

  const browserPagePromise = application.waitForEvent('window')
  await application.evaluate(async ({ BrowserWindow }, url) => {
    const state = globalThis as typeof globalThis & { __dshBrowserWindow?: Electron.BrowserWindow }
    const browserWindow = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    state.__dshBrowserWindow = browserWindow
    await browserWindow.loadURL(url)
  }, page.url())
  const browserPage = await browserPagePromise
  await browserPage.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        addEventListener() {},
        removeEventListener() {},
        cancel() {},
        pause() {},
        resume() {},
        speak() {},
        getVoices() { return [] },
      },
    })
  })
  await browserPage.reload({ waitUntil: 'domcontentloaded' })
  await browserPage.locator('[data-lumi-conversation]').waitFor({ timeout: 30_000 })
  assert.equal(await browserPage.evaluate(() => window.dshDesktop), undefined)
  assert.equal(await browserPage.locator('[data-desktop="true"]').count(), 0)
  assert.equal(await browserPage.getByRole('button', { name: /(?:角色包|Character packs)/u }).count(), 0)
  await browserPage.getByRole('button', { name: /^(?:设置|Settings)$/u }).click()
  const settingsDialog = browserPage.getByRole('dialog', { name: /^(?:设置|Settings)$/u })
  const general = settingsDialog.getByRole('button', { name: /^(?:通用设置|General)$/u })
  if (await general.count() > 0) await general.click()
  await settingsDialog.getByText(/(?:系统没有可用语音|No system voice is available)/u).waitFor()
  await application.evaluate(() => {
    const state = globalThis as typeof globalThis & { __dshBrowserWindow?: Electron.BrowserWindow }
    state.__dshBrowserWindow?.destroy()
  })

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => {} },
    })
  })
  let previousPort = initialPort
  for (let crash = 0; crash < 2; crash += 1) {
    const oldPid = await killHarnessProcess()
    await page.waitForURL(/^file:/u, { timeout: 15_000 })
    await waitForHarnessProcess(oldPid)
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//u, { timeout: 30_000 })
    await page.locator('[data-desktop="true"] [data-lumi-conversation]').waitFor({ timeout: 30_000 })
    const nextPort = recordHarnessUrl(page.url())
    await waitForClosedPort(previousPort)
    previousPort = nextPort
  }
  await killHarnessProcess()
  await page.waitForURL(/loading\.html\?mode=error/u, { timeout: 15_000 })
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.focus() })
  await page.bringToFront()
  await page.locator('#copy').click()
  await page.locator('#copy').getByText('已复制').waitFor()
  await page.locator('#restart').click()
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//u, { timeout: 30_000 })
  await page.locator('[data-desktop="true"] [data-lumi-conversation]').waitFor({ timeout: 30_000 })
  const recoveredPort = recordHarnessUrl(page.url())
  await waitForClosedPort(previousPort)
  assert.equal((await harnessProcesses()).length, 1)
  assert.equal(await portIsOpen(recoveredPort), true)

  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 80, y: 80, width: 1280, height: 720 })
  })
  await new Promise(resolveWait => setTimeout(resolveWait, 700))
} finally {
  await application.close()
}

assert.ok(finalPort !== undefined)
await waitForClosedPort(finalPort)
const placement = JSON.parse(readFileSync(join(userData, 'lumi-window-state.json'), 'utf8')) as Record<string, unknown>
assert.equal(placement['x'], 80)
assert.equal(placement['y'], 80)
assert.equal(placement['maximized'], false)
assert.ok(typeof placement['width'] === 'number' && Math.abs(placement['width'] - 1280) <= 2)
assert.ok(typeof placement['height'] === 'number' && Math.abs(placement['height'] - 720) <= 2)
assert.equal(existsSync(join(home, 'lumi', 'packs')), true)
const mainLog = join(home, 'logs', 'lumi-desktop', `main-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}.log`)
const log = readFileSync(mainLog, 'utf8')
assert.match(log, /Harness ready at http:\/\/127\.0\.0\.1:\d+/u)
assert.match(log, /Harness disconnected with code/u)
assert.match(log, /Harness utility process exited with code 0/u)
console.log(`Desktop E2E passed across ${observedPorts.size} loopback ports. Screenshots: ${screenshot}, ${narrowScreenshot}`)
