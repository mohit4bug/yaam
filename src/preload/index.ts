import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActivityMonitorApi,
  CommandOutputMessage,
  CommandSubscriptionTick,
} from '@/preload/index.d'

const COMMAND_OUTPUT_CHANNEL = 'activity:command-output'
const COMMAND_SUBSCRIPTION_TICK_CHANNEL = 'activity:subscription-tick'
const commandOutputListeners = new Set<(message: CommandOutputMessage) => void>()
const commandSubscriptionTickListeners = new Set<(message: CommandSubscriptionTick) => void>()

ipcRenderer.on(COMMAND_OUTPUT_CHANNEL, (_, message: CommandOutputMessage) => {
  for (const listener of commandOutputListeners) {
    listener(message)
  }
})

ipcRenderer.on(COMMAND_SUBSCRIPTION_TICK_CHANNEL, (_, message: CommandSubscriptionTick) => {
  for (const listener of commandSubscriptionTickListeners) {
    listener(message)
  }
})

const startSubscription = (
  payload: Parameters<ActivityMonitorApi['startCommandSubscription']>[0],
) => ipcRenderer.invoke('activity:subscription:start', payload)

const stopSubscription = (
  subscriptionId: Parameters<ActivityMonitorApi['stopCommandSubscription']>[0],
) => ipcRenderer.invoke('activity:subscription:stop', subscriptionId)

const activityMonitorApi: ActivityMonitorApi = {
  getPlatform: () => ipcRenderer.invoke('app:get-platform'),
  getVersions: () => ipcRenderer.invoke('app:get-versions'),
  executeCommand: request => ipcRenderer.invoke('activity:execute-command', request),
  executeCommandStream: payload => ipcRenderer.invoke('activity:execute-command-stream', payload),
  onCommandOutput: listener => {
    commandOutputListeners.add(listener)

    return () => {
      commandOutputListeners.delete(listener)
    }
  },
  startCommandSubscription: startSubscription,
  stopCommandSubscription: stopSubscription,
  onCommandSubscriptionTick: listener => {
    commandSubscriptionTickListeners.add(listener)

    return () => {
      commandSubscriptionTickListeners.delete(listener)
    }
  },
  startCOmmandSub: startSubscription,
  startCommandSub: startSubscription,
  stopCOmmandSub: stopSubscription,
  stopCommandSub: stopSubscription,
  copyToClipboard: text => ipcRenderer.invoke('app:copy-to-clipboard', text),
  saveOutput: payload => ipcRenderer.invoke('app:save-output', payload),
  minimizeWindow: () => ipcRenderer.invoke('app:window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('app:window-toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('app:window-close'),
  isWindowMaximized: () => ipcRenderer.invoke('app:window-is-maximized'),
}

contextBridge.exposeInMainWorld('activityMonitor', activityMonitorApi)
