import { appendFileSync, createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app, BrowserWindow, ipcMain, screen, shell, utilityProcess,
  type UtilityProcess,
} from 'electron'
import { DESKTOP_RUNTIME_CONFIG } from './config.ts'
import {
  HarnessLifecycleController, type HarnessProcess,
} from './harness-lifecycle.ts'
import { DESKTOP_EVENT_CHANNELS, DESKTOP_INVOKE_CHANNELS } from './ipc.ts'
import { dailyLogPath, ensureDesktopPaths, type DesktopPaths } from './paths.ts'
import {
  readWindowPlacement, resolveWindowPlacement, windowPlacementPath, writeWindowPlacement,
} from './window-state.ts'

const APP_NAME = 'DeepSeek Harness · Anime'
const root = fileURLToPath(new URL('..', import.meta.url))
const loadingPage = join(root, 'assets', 'loading.html')
const preload = join(root, 'lib', 'preload.cjs')
const workerEntry = join(root, 'lib', 'harness-worker.js')

interface WindowState {
  maximized: boolean
  fullscreen: boolean
}

let mainWindow: BrowserWindow | undefined
let paths: DesktopPaths | undefined
let harnessLog: WriteStream | undefined
let windowSaveTimer: ReturnType<typeof setTimeout> | undefined
let allowQuit = false
let lastHarnessUrl: string | undefined

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  if (paths === undefined) return
  appendFileSync(dailyLogPath(paths.logs, 'main'), `${new Date().toISOString()} ${level} ${message}\n`, 'utf8')
}

function stateOf(window: BrowserWindow): WindowState {
  return { maximized: window.isMaximized(), fullscreen: window.isFullScreen() }
}

function publishWindowState(window: BrowserWindow): void {
  if (!window.isDestroyed()) window.webContents.send(DESKTOP_EVENT_CHANNELS.stateChanged, stateOf(window))
}

async function showLaunchPage(mode: 'loading' | 'error', detail = '', diagnostics = ''): Promise<void> {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  try {
    await mainWindow.loadFile(loadingPage, { query: { mode, detail, diagnostics } })
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('ERR_ABORTED')) throw error
  }
}

function failure(stage: string, message: string, stack?: string): void {
  const diagnostics = [`stage: ${stage}`, `message: ${message}`, ...(stack === undefined ? [] : [`stack:\n${stack}`])].join('\n')
  log('ERROR', diagnostics)
  void showLaunchPage('error', message.split('\n')[0] ?? message, diagnostics)
}

function attachWorkerOutput(child: UtilityProcess): void {
  if (paths === undefined) return
  harnessLog = createWriteStream(dailyLogPath(paths.logs, 'harness'), { flags: 'a' })
  harnessLog.write(`\n${new Date().toISOString()} INFO utility process starting\n`)
  child.stdout?.pipe(harnessLog, { end: false })
  child.stderr?.pipe(harnessLog, { end: false })
}

interface ElectronHarnessProcess extends HarnessProcess {
  child: UtilityProcess
}

function spawnHarnessProcess(): ElectronHarnessProcess {
  const child = utilityProcess.fork(workerEntry, [], {
    env: { ...process.env, DSH_ANIME_APP_VERSION: app.getVersion() },
    cwd: process.cwd(),
    stdio: 'pipe',
    serviceName: 'DeepSeek Harness',
  })
  return {
    child,
    postMessage: (command) => { child.postMessage(command) },
    kill: () => { child.kill() },
    onMessage: (listener) => { child.on('message', listener) },
    onError: (listener) => { child.on('error', (type, location) => { listener(type, location) }) },
    onExit: (listener) => { child.on('exit', listener) },
  }
}

const lifecycle = new HarnessLifecycleController(DESKTOP_RUNTIME_CONFIG, {
  spawn: spawnHarnessProcess,
  onSpawn(process) {
    lastHarnessUrl = undefined
    log('INFO', 'starting Harness utility process')
    attachWorkerOutput((process as ElectronHarnessProcess).child)
  },
  onReady(url) {
    lastHarnessUrl = url
    log('INFO', `Harness ready at ${url}`)
    void mainWindow?.loadURL(url).catch((error: unknown) => {
      failure('browser-load', error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : undefined)
    })
  },
  onLog(level, message) {
    log(level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : 'INFO', message)
  },
  onLoading(message) { void showLaunchPage('loading', message) },
  onFailure: failure,
  onExit(code) {
    harnessLog?.write(`${new Date().toISOString()} INFO utility process exited with code ${code}\n`)
    harnessLog?.end()
    harnessLog = undefined
    log(code === 0 ? 'INFO' : 'ERROR', `Harness utility process exited with code ${code}`)
  },
})

function ownedWindow(sender: Electron.WebContents): BrowserWindow | undefined {
  const window = BrowserWindow.fromWebContents(sender)
  return window === null || window !== mainWindow ? undefined : window
}

async function openFolder(path: string): Promise<void> {
  const error = await shell.openPath(path)
  if (error !== '') throw new Error(error)
}

function registerIpc(): void {
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.minimize, (event) => { ownedWindow(event.sender)?.minimize() })
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.toggleMaximize, (event) => {
    const window = ownedWindow(event.sender)
    if (window === undefined) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.close, (event) => { ownedWindow(event.sender)?.close() })
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getState, (event) => {
    const window = ownedWindow(event.sender)
    return window === undefined ? { maximized: false, fullscreen: false } : stateOf(window)
  })
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.restartHarness, async (event) => {
    if (ownedWindow(event.sender) !== undefined) await lifecycle.restart()
  })
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.openLogs, async (event) => {
    if (ownedWindow(event.sender) !== undefined && paths !== undefined) await openFolder(paths.logs)
  })
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.openPacks, async (event) => {
    if (ownedWindow(event.sender) !== undefined && paths !== undefined) await openFolder(paths.characterPacks)
  })
}

function createWindow(): BrowserWindow {
  const userData = app.getPath('userData')
  const placementPath = windowPlacementPath(userData)
  const displays = screen.getAllDisplays().map(display => display.bounds)
  const placement = resolveWindowPlacement(
    readWindowPlacement(placementPath), displays, screen.getPrimaryDisplay().workArea, DESKTOP_RUNTIME_CONFIG.window,
  )
  const isMac = process.platform === 'darwin'
  const window = new BrowserWindow({
    title: APP_NAME,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    minWidth: DESKTOP_RUNTIME_CONFIG.window.minWidth,
    minHeight: DESKTOP_RUNTIME_CONFIG.window.minHeight,
    show: false,
    frame: isMac,
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : {}),
    backgroundColor: '#eef5fb',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const persist = (): void => {
    if (window.isDestroyed()) return
    const bounds = window.getNormalBounds()
    try { writeWindowPlacement(placementPath, { ...bounds, maximized: window.isMaximized() }) }
    catch (error) { log('WARN', `window placement could not be saved: ${String(error)}`) }
  }
  const schedulePersist = (): void => {
    if (windowSaveTimer !== undefined) clearTimeout(windowSaveTimer)
    windowSaveTimer = setTimeout(() => { windowSaveTimer = undefined; persist() }, DESKTOP_RUNTIME_CONFIG.windowSaveDelayMs)
  }
  window.once('ready-to-show', () => {
    if (placement.maximized) window.maximize()
    window.show()
  })
  window.on('move', schedulePersist)
  window.on('resize', schedulePersist)
  window.on('maximize', () => { schedulePersist(); publishWindowState(window) })
  window.on('unmaximize', () => { schedulePersist(); publishWindowState(window) })
  window.on('enter-full-screen', () => { publishWindowState(window) })
  window.on('leave-full-screen', () => { publishWindowState(window) })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//u.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('http://127.0.0.1:') || url.startsWith('file:')
    if (allowed) return
    event.preventDefault()
    if (/^https?:\/\//u.test(url)) void shell.openExternal(url)
  })
  window.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3 || validatedURL !== lastHarnessUrl) return
    failure('browser-disconnect', `${description} (${code})`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    failure('renderer-exit', `界面进程已退出：${details.reason}。`)
  })
  window.on('close', () => {
    if (windowSaveTimer !== undefined) clearTimeout(windowSaveTimer)
    windowSaveTimer = undefined
    persist()
  })
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
  return window
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.on('before-quit', (event) => {
    if (allowQuit) return
    event.preventDefault()
    allowQuit = true
    void lifecycle.shutdown().finally(() => { app.quit() })
  })
  app.on('window-all-closed', () => { app.quit() })

  void app.whenReady().then(async () => {
    paths = ensureDesktopPaths()
    process.env.DSH_ANIME_APP_VERSION = app.getVersion()
    log('INFO', `desktop ${app.getVersion()} starting`)
    registerIpc()
    mainWindow = createWindow()
    await showLaunchPage('loading', '正在启动 Harness…')
    lifecycle.start()
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    failure('desktop-startup', message, error instanceof Error ? error.stack : undefined)
  })
}
