export interface RuntimeVersions {
  electron: string
  chrome: string
  node: string
}

export type ActivityCommandName =
  | 'scan-ports'
  | 'inspect-process'
  | 'terminate'
  | 'force-kill'
  | 'check-health'
  | 'test-tcp'
  | 'show-parent'
  | 'open-files'
  | 'binary-path'
  | 'watch-cpu'

export interface ExecuteCommandRequest {
  command: ActivityCommandName
  argument: string
}

export interface ExecuteCommandResult {
  command: ActivityCommandName
  argument: string
  startedAt: string
  finishedAt: string
  durationMs: number
  success: boolean
  exitCode: number | null
  signal: string | null
  lines: string[]
}

export type CommandOutputStream = 'stdout' | 'stderr' | 'system'

export interface CommandOutputMessage {
  runId: string
  at: string
  stream: CommandOutputStream
  line: string
}

export interface ExecuteCommandStreamPayload {
  runId: string
  request: ExecuteCommandRequest
}

export interface StartCommandSubscriptionPayload {
  subscriptionId: string
  request: ExecuteCommandRequest
  intervalMs?: number
}

export interface StartCommandSubscriptionResult {
  started: boolean
  subscriptionId: string
  intervalMs: number
}

export interface CommandSubscriptionTick {
  subscriptionId: string
  result: ExecuteCommandResult
}

export interface SaveOutputPayload {
  content: string
  suggestedName: string
}

export interface SaveOutputResult {
  canceled: boolean
  filePath: string | null
}

export interface ActivityMonitorApi {
  getPlatform: () => Promise<string>
  getVersions: () => Promise<RuntimeVersions>
  executeCommand: (request: ExecuteCommandRequest) => Promise<ExecuteCommandResult>
  executeCommandStream: (payload: ExecuteCommandStreamPayload) => Promise<ExecuteCommandResult>
  onCommandOutput: (listener: (message: CommandOutputMessage) => void) => () => void
  startCommandSubscription: (
    payload: StartCommandSubscriptionPayload,
  ) => Promise<StartCommandSubscriptionResult>
  stopCommandSubscription: (subscriptionId: string) => Promise<boolean>
  onCommandSubscriptionTick: (listener: (message: CommandSubscriptionTick) => void) => () => void
  startCOmmandSub?: (
    payload: StartCommandSubscriptionPayload,
  ) => Promise<StartCommandSubscriptionResult>
  startCommandSub?: (
    payload: StartCommandSubscriptionPayload,
  ) => Promise<StartCommandSubscriptionResult>
  stopCOmmandSub?: (subscriptionId: string) => Promise<boolean>
  stopCommandSub?: (subscriptionId: string) => Promise<boolean>
  copyToClipboard: (text: string) => Promise<void>
  saveOutput: (payload: SaveOutputPayload) => Promise<SaveOutputResult>
  minimizeWindow: () => Promise<void>
  toggleMaximizeWindow: () => Promise<boolean>
  closeWindow: () => Promise<void>
  isWindowMaximized: () => Promise<boolean>
}

declare global {
  interface Window {
    activityMonitor: ActivityMonitorApi
  }
}
