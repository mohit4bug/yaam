import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type WebContents } from 'electron'
import { type ExecuteCommandRequest, executeNativeCommand } from '@/main/nativeCommands'

const APP_ID = 'com.lunaria.activitymonitor'
const COMMAND_OUTPUT_CHANNEL = 'activity:command-output'
const COMMAND_SUBSCRIPTION_TICK_CHANNEL = 'activity:subscription-tick'
const DEFAULT_SUBSCRIPTION_INTERVAL_MS = 1_500
const MIN_SUBSCRIPTION_INTERVAL_MS = 700
const MAX_SUBSCRIPTION_INTERVAL_MS = 15_000

let mainWindow: BrowserWindow | null = null
const commandSubscriptions = new Map<
  string,
  { timer: NodeJS.Timeout; senderId: number; sender: WebContents }
>()
const cleanupRegisteredSenders = new Set<number>()

const currentWindowForEvent = (sender: WebContents): BrowserWindow | null =>
  BrowserWindow.fromWebContents(sender) ?? mainWindow

const stopSubscription = (subscriptionId: string): boolean => {
  const existing = commandSubscriptions.get(subscriptionId)

  if (!existing) {
    return false
  }

  clearInterval(existing.timer)
  commandSubscriptions.delete(subscriptionId)
  return true
}

const stopSubscriptionsForSender = (senderId: number): void => {
  for (const [subscriptionId, subscription] of commandSubscriptions.entries()) {
    if (subscription.senderId !== senderId) {
      continue
    }

    clearInterval(subscription.timer)
    commandSubscriptions.delete(subscriptionId)
  }
}

const createMainWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 1000,
    minHeight: 680,
    resizable: true,
    center: true,
    show: false,
    frame: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    title: 'Dev Command Dashboard',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  mainWindow = window

  return window
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID)
  }

  ipcMain.handle('app:get-platform', () => process.platform)
  ipcMain.handle('app:get-versions', () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }))
  ipcMain.handle('activity:execute-command', (_, request: ExecuteCommandRequest) =>
    executeNativeCommand(request),
  )
  ipcMain.handle(
    'activity:execute-command-stream',
    (event, payload: { runId: string; request: ExecuteCommandRequest }) =>
      executeNativeCommand(payload.request, {
        onOutput: output => {
          event.sender.send(COMMAND_OUTPUT_CHANNEL, {
            runId: payload.runId,
            at: new Date().toISOString(),
            stream: output.stream,
            line: output.line,
          })
        },
      }),
  )
  ipcMain.handle(
    'activity:subscription:start',
    async (
      event,
      payload: { subscriptionId: string; request: ExecuteCommandRequest; intervalMs?: number },
    ) => {
      const sender = event.sender
      const senderId = sender.id
      const intervalMs = Math.max(
        MIN_SUBSCRIPTION_INTERVAL_MS,
        Math.min(
          payload.intervalMs ?? DEFAULT_SUBSCRIPTION_INTERVAL_MS,
          MAX_SUBSCRIPTION_INTERVAL_MS,
        ),
      )

      stopSubscription(payload.subscriptionId)

      if (!cleanupRegisteredSenders.has(senderId)) {
        cleanupRegisteredSenders.add(senderId)
        sender.once('destroyed', () => {
          stopSubscriptionsForSender(senderId)
          cleanupRegisteredSenders.delete(senderId)
        })
      }

      const runTick = async (): Promise<void> => {
        if (sender.isDestroyed()) {
          stopSubscriptionsForSender(senderId)
          return
        }

        const result = await executeNativeCommand(payload.request)

        if (sender.isDestroyed()) {
          stopSubscriptionsForSender(senderId)
          return
        }

        sender.send(COMMAND_SUBSCRIPTION_TICK_CHANNEL, {
          subscriptionId: payload.subscriptionId,
          result,
        })
      }

      const timer = setInterval(() => {
        void runTick()
      }, intervalMs)
      timer.unref()

      commandSubscriptions.set(payload.subscriptionId, { timer, sender, senderId })
      await runTick()

      return {
        started: true as const,
        subscriptionId: payload.subscriptionId,
        intervalMs,
      }
    },
  )
  ipcMain.handle('activity:subscription:stop', (_, subscriptionId: string) =>
    stopSubscription(subscriptionId),
  )
  ipcMain.handle('app:copy-to-clipboard', (_, text: string) => {
    clipboard.writeText(text)
  })
  ipcMain.handle(
    'app:save-output',
    async (event, payload: { content: string; suggestedName: string }) => {
      const targetWindow = currentWindowForEvent(event.sender)
      const saveOptions = {
        title: 'Save Command Output',
        defaultPath: payload.suggestedName,
        filters: [
          { name: 'Log File', extensions: ['log', 'txt'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      }
      const saveResult = targetWindow
        ? await dialog.showSaveDialog(targetWindow, saveOptions)
        : await dialog.showSaveDialog(saveOptions)

      if (saveResult.canceled || !saveResult.filePath) {
        return { canceled: true as const, filePath: null }
      }

      await writeFile(saveResult.filePath, payload.content, 'utf8')
      return { canceled: false as const, filePath: saveResult.filePath }
    },
  )
  ipcMain.handle('app:window-minimize', event => {
    const window = currentWindowForEvent(event.sender)
    if (!window) {
      return
    }

    window.minimize()
  })
  ipcMain.handle('app:window-toggle-maximize', event => {
    const window = currentWindowForEvent(event.sender)

    if (!window) {
      return false
    }

    if (window.isMaximized()) {
      window.unmaximize()
    } else {
      window.maximize()
    }

    return window.isMaximized()
  })
  ipcMain.handle('app:window-close', event => {
    const window = currentWindowForEvent(event.sender)
    if (!window) {
      return
    }

    window.close()
  })
  ipcMain.handle('app:window-is-maximized', event => {
    const window = currentWindowForEvent(event.sender)
    if (!window) {
      return false
    }

    return window.isMaximized()
  })

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  for (const subscriptionId of commandSubscriptions.keys()) {
    stopSubscription(subscriptionId)
  }
})
