import { type Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app, BrowserWindow, crashReporter, dialog, ipcMain, screen, shell, utilityProcess,
  type UtilityProcess,
} from 'electron'
import updaterPackage from 'electron-updater'
import { installCharacterPack, type CharacterPackInstallResult } from './character-pack-import.ts'
import { DESKTOP_RUNTIME_CONFIG } from './config.ts'
import {
  HarnessLifecycleController, type HarnessLoadingState, type HarnessProcess,
} from './harness-lifecycle.ts'
import { DESKTOP_EVENT_CHANNELS, DESKTOP_INVOKE_CHANNELS } from './ipc.ts'
import {
  createDesktopLogStream, createMainLogStream, pruneDesktopDiagnostics,
} from './diagnostics.ts'
import { ensureDesktopPaths, type DesktopPaths } from './paths.ts'
import {
  readWindowPlacement, resolveWindowPlacement, windowPlacementPath, writeWindowPlacement,
} from './window-state.ts'
import { startDesktopUpdater } from './updater.ts'

const { autoUpdater } = updaterPackage

const APP_NAME = 'Lumi'
const root = fileURLToPath(new URL('..', import.meta.url))
const loadingPage = join(root, 'assets', 'loading.html')
const preload = join(root, 'lib', 'preload.cjs')
const workerEntry = join(root, 'lib', 'harness-worker.js')

const desktopCopy = {
  en: {
    starting: 'Starting Harness and Lumi…',
    restarting: 'Restarting Harness…',
    retrying: (attempt: number, total: number) => `Harness disconnected. Retrying (${attempt}/${total})…`,
    launchFailed: 'Lumi could not start. Use the recovery actions below or open the logs for details.',
    rendererExited: (reason: string) => `The interface process exited: ${reason}.`,
    updateTitle: 'Lumi update ready',
    updateMessage: (version: string) => `Lumi ${version} was downloaded and its signature was verified.`,
    updateDetail: 'Restart now to finish updating, or install automatically after you quit Lumi.',
    updateNow: 'Restart now',
    updateLater: 'Later',
    selectPack: 'Select a Character Pack v1 folder',
  },
  zh: {
    starting: '正在启动 Harness 与 Lumi…',
    restarting: '正在重新启动 Harness…',
    retrying: (attempt: number, total: number) => `Harness 连接中断，正在重试（${attempt}/${total}）…`,
    launchFailed: 'Lumi 未能启动。请使用下面的恢复操作，或打开日志查看详情。',
    rendererExited: (reason: string) => `界面进程已退出：${reason}。`,
    updateTitle: 'Lumi 更新已就绪',
    updateMessage: (version: string) => `Lumi ${version} 已下载并通过签名校验。`,
    updateDetail: '现在重启即可完成更新，也可以在退出 Lumi 后自动安装。',
    updateNow: '现在重启',
    updateLater: '稍后',
    selectPack: '选择 Character Pack v1 文件夹',
  },
} as const

function currentDesktopLocale(): keyof typeof desktopCopy {
  return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function loadingMessage(state: HarnessLoadingState): string {
  const copy = desktopCopy[currentDesktopLocale()]
  return state.kind === 'restarting' ? copy.restarting : copy.retrying(state.attempt, state.total)
}

interface WindowState {
  maximized: boolean
  fullscreen: boolean
}

let mainWindow: BrowserWindow | undefined
let paths: DesktopPaths | undefined
let mainLog: Writable | undefined
let harnessLog: Writable | undefined
let windowSaveTimer: ReturnType<typeof setTimeout> | undefined
let allowQuit = false
let lastHarnessUrl: string | undefined

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  mainLog?.write(`${new Date().toISOString()} ${level} ${message}\n`)
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
    await mainWindow.loadFile(loadingPage, {
      query: { mode, detail, diagnostics, locale: currentDesktopLocale() },
    })
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('ERR_ABORTED')) throw error
  }
}

function failure(stage: string, message: string, stack?: string): void {
  const diagnostics = [`stage: ${stage}`, `message: ${message}`, ...(stack === undefined ? [] : [`stack:\n${stack}`])].join('\n')
  log('ERROR', diagnostics)
  void showLaunchPage('error', desktopCopy[currentDesktopLocale()].launchFailed, diagnostics)
}

function attachWorkerOutput(child: UtilityProcess): void {
  if (harnessLog === undefined) return
  harnessLog.write(`\n${new Date().toISOString()} INFO utility process starting\n`)
  child.stdout?.pipe(harnessLog, { end: false })
  child.stderr?.pipe(harnessLog, { end: false })
}

interface ElectronHarnessProcess extends HarnessProcess {
  child: UtilityProcess
}

function spawnHarnessProcess(): ElectronHarnessProcess {
  const child = utilityProcess.fork(workerEntry, [], {
    env: { ...process.env, DSH_LUMI_APP_VERSION: app.getVersion() },
    cwd: process.cwd(),
    stdio: 'pipe',
    serviceName: 'Lumi Harness',
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
  onLoading(state) { void showLaunchPage('loading', loadingMessage(state)) },
  onFailure: failure,
  onExit(code) {
    harnessLog?.write(`${new Date().toISOString()} INFO utility process exited with code ${code}\n`)
    log(code === 0 ? 'INFO' : 'ERROR', `Harness utility process exited with code ${code}`)
  },
})

/** Drain both process-wide log streams after their producers have stopped. */
async function closeDesktopLogs(): Promise<void> {
  const streams = [harnessLog, mainLog].filter((stream): stream is Writable => stream !== undefined)
  harnessLog = undefined
  mainLog = undefined
  for (const stream of streams) stream.end()
  await Promise.allSettled(streams.map(stream => finished(stream)))
}

function ownedWindow(sender: Electron.WebContents): BrowserWindow | undefined {
  const window = BrowserWindow.fromWebContents(sender)
  return window === null || window !== mainWindow ? undefined : window
}

async function openFolder(path: string): Promise<void> {
  const error = await shell.openPath(path)
  if (error !== '') throw new Error(error)
}

async function importCharacterPack(window: BrowserWindow): Promise<CharacterPackInstallResult | { kind: 'cancelled' }> {
  if (paths === undefined) return { kind: 'error', code: 'copy-failed', detail: 'desktop paths are unavailable' }
  const desktopPaths = paths
  const choice = await dialog.showOpenDialog(window, {
    title: desktopCopy[currentDesktopLocale()].selectPack,
    properties: ['openDirectory'],
  })
  if (choice.canceled || choice.filePaths[0] === undefined) return { kind: 'cancelled' }
  return installCharacterPack(choice.filePaths[0], desktopPaths, {
    createStagingId: randomUUID,
    logFailure: (message) => { log('ERROR', message) },
  })
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
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.importPack, async (event) => {
    const window = ownedWindow(event.sender)
    return window === undefined ? { kind: 'error', code: 'copy-failed', detail: 'window is unavailable' } : importCharacterPack(window)
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
    failure('renderer-exit', desktopCopy[currentDesktopLocale()].rendererExited(details.reason))
  })
  window.webContents.on('unresponsive', () => { log('WARN', 'renderer became unresponsive') })
  window.webContents.on('responsive', () => { log('INFO', 'renderer became responsive again') })
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
  paths = ensureDesktopPaths()
  const pruned = pruneDesktopDiagnostics(paths.logs, paths.crashes, DESKTOP_RUNTIME_CONFIG.diagnostics)
  mainLog = createMainLogStream(paths.logs, DESKTOP_RUNTIME_CONFIG.diagnostics.maxLogBytes)
  harnessLog = createDesktopLogStream(paths.logs, DESKTOP_RUNTIME_CONFIG.diagnostics.maxLogBytes)
  mainLog.on('error', (error) => { console.error(`Lumi could not write its desktop log: ${error.message}`) })
  harnessLog.on('error', (error) => { log('WARN', `Harness log stream failed: ${error.message}`) })
  app.setPath('crashDumps', paths.crashes)
  crashReporter.start({
    productName: 'Lumi',
    uploadToServer: false,
    compress: false,
    globalExtra: { product: 'Lumi', profile: 'lumi-desktop' },
  })
  log('INFO', `local crash capture ready; pruned ${pruned.logs} logs and ${pruned.crashes} crash reports`)
  process.on('uncaughtExceptionMonitor', (error) => {
    log('ERROR', `uncaught main-process exception:\n${error.stack ?? error.message}`)
  })
  process.on('unhandledRejection', (reason) => {
    log('ERROR', `unhandled main-process rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`)
  })
  app.on('child-process-gone', (_event, details) => {
    log('ERROR', `child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode} service=${details.serviceName ?? ''} name=${details.name ?? ''}`)
  })
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
    void (async () => {
      try { await lifecycle.shutdown() } finally { await closeDesktopLogs(); app.quit() }
    })()
  })
  app.on('window-all-closed', () => { app.quit() })

  void app.whenReady().then(async () => {
    process.env.DSH_LUMI_APP_VERSION = app.getVersion()
    log('INFO', `desktop ${app.getVersion()} starting`)
    const displays = screen.getAllDisplays().map(display => ({
      id: display.id, scaleFactor: display.scaleFactor, bounds: display.bounds,
    }))
    log('INFO', `display metrics: ${JSON.stringify(displays)}`)
    screen.on('display-metrics-changed', (_event, display, changedMetrics) => {
      log('INFO', `display ${display.id} changed ${changedMetrics.join(',')}; scaleFactor=${display.scaleFactor} bounds=${JSON.stringify(display.bounds)}`)
    })
    registerIpc()
    mainWindow = createWindow()
    await showLaunchPage('loading', desktopCopy[currentDesktopLocale()].starting)
    lifecycle.start()
    void startDesktopUpdater(autoUpdater, app.isPackaged, {
      log,
      async confirmInstall(version) {
        const copy = desktopCopy[currentDesktopLocale()]
        const options: Electron.MessageBoxOptions = {
          type: 'info',
          title: copy.updateTitle,
          message: copy.updateMessage(version),
          detail: copy.updateDetail,
          buttons: [copy.updateNow, copy.updateLater],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        }
        const result = mainWindow === undefined
          ? await dialog.showMessageBox(options)
          : await dialog.showMessageBox(mainWindow, options)
        return result.response === 0
      },
    })
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    failure('desktop-startup', message, error instanceof Error ? error.stack : undefined)
  })
}
