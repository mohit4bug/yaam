import { useCallback, useEffect, useRef, useState } from 'react'
import CommandPanelHeader from '@/components/CommandPanelHeader'
import OutputPanel, { type OutputRow } from '@/components/OutputPanel'
import Sidebar from '@/components/Sidebar'
import SystemMenuPanel from '@/components/SystemMenuPanel'
import { type ActivityCommandName, COMMANDS, type CommandItem, timestamp } from '@/data/commands'

const DEFAULT_SUBSCRIPTION_INTERVAL_MS = 1_500
const MAX_ROWS_PER_TAB = 500
const SYSTEM_MENU_COMMAND: ActivityCommandName = 'check-health'
const DRAG_STRIP_HEIGHT_PX = 34
const SIDEBAR_TOP_PADDING_PX = 14
const RIGHT_PANEL_TOP_PADDING_PX = 4
const WINDOW_CONTROL_SIZE_PX = 28
const FOOTER_HEIGHT_PX = 28

const REQUIRED_INPUT_COMMANDS = new Set<ActivityCommandName>([
  'inspect-process',
  'watch-cpu',
  'test-tcp',
])

const defaultCommand = (): CommandItem => {
  const command = COMMANDS[0]

  if (!command) {
    throw new Error('No commands configured')
  }

  return command
}

const findCommand = (commandName: string): CommandItem => {
  const match = COMMANDS.find(item => item.command === commandName)

  if (!match) {
    return defaultCommand()
  }

  return match
}

type RunState = 'ready' | 'running' | 'success' | 'error'

const statusLabelByState: Record<RunState, string> = {
  ready: 'Ready',
  running: 'Running',
  success: 'Success',
  error: 'Error',
}

const emptyStateCopyByCommand: Partial<
  Record<ActivityCommandName, { title: string; description: string }>
> = {
  'check-health': {
    title: 'System monitor is idle',
    description: 'Start live mode to stream host health snapshots in realtime.',
  },
  'scan-ports': {
    title: 'No port stream yet',
    description: 'Start live mode to watch listening ports and changes.',
  },
  'inspect-process': {
    title: 'No process data yet',
    description: 'Enter a PID and start live mode to monitor that process.',
  },
  'watch-cpu': {
    title: 'CPU watch is idle',
    description: 'Enter a PID and start live mode to track CPU and memory.',
  },
  'test-tcp': {
    title: 'No probe output yet',
    description: 'Enter host:port and start live mode to run continuous checks.',
  },
}

type TabState = {
  input: string
  rows: OutputRow[]
  runState: RunState
  lastRunLabel: string
  subscribed: boolean
  subscriptionId: string | null
  intervalMs: number
  metrics: Record<string, string>
}

type TabStates = Partial<Record<ActivityCommandName, TabState>>

type ActivityMonitorBridge = Window['activityMonitor'] & {
  startCOmmandSub?: Window['activityMonitor']['startCommandSubscription']
  startCommandSub?: Window['activityMonitor']['startCommandSubscription']
  stopCOmmandSub?: Window['activityMonitor']['stopCommandSubscription']
  stopCommandSub?: Window['activityMonitor']['stopCommandSubscription']
}

const createRunId = (): string => `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const createRowId = (): string =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`

const fileSafeTimestamp = (): string => new Date().toISOString().replace(/[:.]/gu, '-')

const formatTime = (input?: string): string => {
  if (!input) {
    return timestamp()
  }

  const date = new Date(input)

  if (Number.isNaN(date.getTime())) {
    return timestamp()
  }

  return date.toLocaleTimeString('en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

const rowsToText = (rows: ReadonlyArray<OutputRow>): string =>
  rows.map(row => `[${row.at}] [${row.source}] [${row.level}] ${row.message}`).join('\n')

const createRow = (
  message: string,
  source: OutputRow['source'],
  level: OutputRow['level'],
  at?: string,
): OutputRow => ({
  id: createRowId(),
  message,
  source,
  level,
  at: formatTime(at),
})

const createEmptyTabState = (): TabState => ({
  input: '',
  rows: [],
  runState: 'ready',
  lastRunLabel: 'Never',
  subscribed: false,
  subscriptionId: null,
  intervalMs: DEFAULT_SUBSCRIPTION_INTERVAL_MS,
  metrics: {},
})

const createInitialTabStates = (): TabStates =>
  COMMANDS.reduce<TabStates>((state, item) => {
    state[item.command] = createEmptyTabState()
    return state
  }, {})

const parseSystemMetrics = (
  lines: ReadonlyArray<string>,
  previous: Readonly<Record<string, string>>,
): Record<string, string> => {
  const metrics = { ...previous }

  for (const line of lines) {
    const separator = line.indexOf(':')

    if (separator <= 0) {
      continue
    }

    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()

    if (!key || !value) {
      continue
    }

    metrics[key] = value
  }

  return metrics
}

const intervalForCommand = (command: ActivityCommandName): number => {
  if (command === SYSTEM_MENU_COMMAND) {
    return 1_000
  }

  if (command === 'test-tcp') {
    return 2_000
  }

  return DEFAULT_SUBSCRIPTION_INTERVAL_MS
}

const resolveStartSubscription = (
  bridge: ActivityMonitorBridge | undefined,
): Window['activityMonitor']['startCommandSubscription'] | undefined => {
  if (!bridge) {
    return undefined
  }

  if (bridge.startCommandSubscription) {
    return bridge.startCommandSubscription
  }

  if (bridge.startCOmmandSub) {
    return bridge.startCOmmandSub
  }

  return bridge.startCommandSub
}

const resolveStopSubscription = (
  bridge: ActivityMonitorBridge | undefined,
): Window['activityMonitor']['stopCommandSubscription'] | undefined => {
  if (!bridge) {
    return undefined
  }

  if (bridge.stopCommandSubscription) {
    return bridge.stopCommandSubscription
  }

  if (bridge.stopCOmmandSub) {
    return bridge.stopCOmmandSub
  }

  return bridge.stopCommandSub
}

function App(): React.JSX.Element {
  const activityMonitor = (window as Window & { activityMonitor?: Window['activityMonitor'] })
    .activityMonitor
  const [activeCommandName, setActiveCommandName] = useState(defaultCommand().command)
  const [tabStates, setTabStates] = useState<TabStates>(() => createInitialTabStates())
  const [platform, setPlatform] = useState('desktop')
  const [isWindowMaximized, setIsWindowMaximized] = useState(false)
  const [headerHeight, setHeaderHeight] = useState(0)
  const subscriptionToCommandRef = useRef(new Map<string, ActivityCommandName>())
  const hasAutoStartedSystemRef = useRef(false)
  const handleToggleLiveRef = useRef<(commandName?: ActivityCommandName) => Promise<void>>(
    async () => {},
  )
  const mainScrollRef = useRef<HTMLDivElement | null>(null)
  const headerRef = useRef<HTMLDivElement | null>(null)

  const activeCommand = findCommand(activeCommandName)
  const activeState = tabStates[activeCommand.command] ?? createEmptyTabState()
  const bridge = activityMonitor as ActivityMonitorBridge | undefined

  const updateTabState = (
    command: ActivityCommandName,
    update: (state: TabState) => TabState,
  ): void => {
    setTabStates(current => {
      const previous = current[command] ?? createEmptyTabState()

      return {
        ...current,
        [command]: update(previous),
      }
    })
  }

  const appendRowForCommand = (
    command: ActivityCommandName,
    message: string,
    source: OutputRow['source'],
    level: OutputRow['level'],
    at?: string,
  ): void => {
    const row = createRow(message, source, level, at)

    updateTabState(command, state => ({
      ...state,
      rows: [...state.rows, row].slice(-MAX_ROWS_PER_TAB),
    }))
  }

  const handleSelectCommand = (item: CommandItem): void => {
    setActiveCommandName(item.command)
  }

  const handleInputChange = (value: string): void => {
    updateTabState(activeCommand.command, state => ({
      ...state,
      input: value,
    }))
  }

  const handleToggleLive = async (
    commandName: ActivityCommandName = activeCommand.command,
  ): Promise<void> => {
    const targetCommand = findCommand(commandName)

    if (!activityMonitor) {
      updateTabState(commandName, state => ({
        ...state,
        runState: 'error',
        rows: [
          createRow('Native bridge unavailable', 'system', 'error'),
          createRow('Electron preload API was not injected. Restart the app.', 'system', 'error'),
        ],
      }))
      return
    }

    const currentState = tabStates[commandName] ?? createEmptyTabState()
    const startSubscription = resolveStartSubscription(bridge)
    const stopSubscription = resolveStopSubscription(bridge)

    if (currentState.subscribed && currentState.subscriptionId && stopSubscription) {
      try {
        await stopSubscription(currentState.subscriptionId)
      } catch {}

      subscriptionToCommandRef.current.delete(currentState.subscriptionId)

      updateTabState(commandName, state => ({
        ...state,
        subscribed: false,
        subscriptionId: null,
        runState: 'ready',
        rows: commandName === SYSTEM_MENU_COMMAND ? [] : state.rows,
        lastRunLabel: commandName === SYSTEM_MENU_COMMAND ? 'Never' : state.lastRunLabel,
        metrics: commandName === SYSTEM_MENU_COMMAND ? {} : state.metrics,
      }))
      return
    }

    const requiresInput = REQUIRED_INPUT_COMMANDS.has(commandName)
    const argument = requiresInput ? currentState.input.trim() : ''

    if (requiresInput && !argument) {
      appendRowForCommand(
        commandName,
        `Input required for ${targetCommand.title}.`,
        'system',
        'error',
      )
      updateTabState(commandName, state => ({
        ...state,
        runState: 'error',
      }))
      return
    }

    const subscriptionId = createRunId()
    const intervalMs = intervalForCommand(commandName)

    try {
      if (!startSubscription) {
        throw new Error(
          'Realtime subscription API unavailable. Restart app to load updated preload bridge.',
        )
      }

      const startResult = await startSubscription({
        subscriptionId,
        intervalMs,
        request: {
          command: commandName,
          argument,
        },
      })

      subscriptionToCommandRef.current.set(subscriptionId, commandName)

      updateTabState(commandName, state => ({
        ...state,
        subscribed: startResult.started,
        subscriptionId: startResult.subscriptionId,
        intervalMs: startResult.intervalMs,
        runState: 'running',
      }))

      appendRowForCommand(
        commandName,
        `Live updates started (${Math.round(startResult.intervalMs / 1000)}s interval).`,
        'system',
        'success',
      )
    } catch (error) {
      appendRowForCommand(
        commandName,
        error instanceof Error ? error.message : 'Failed to start live updates.',
        'system',
        'error',
      )
      updateTabState(commandName, state => ({
        ...state,
        runState: 'error',
      }))
    }
  }

  handleToggleLiveRef.current = handleToggleLive

  const handleCopyOutput = async (): Promise<void> => {
    const rows = activeState.rows

    if (rows.length === 0 || !activityMonitor) {
      return
    }

    try {
      await activityMonitor.copyToClipboard(rowsToText(rows))
      appendRowForCommand(activeCommand.command, 'Output copied to clipboard.', 'system', 'success')
    } catch (error) {
      appendRowForCommand(
        activeCommand.command,
        `Copy failed: ${error instanceof Error ? error.message : 'Unexpected error'}`,
        'system',
        'error',
      )
    }
  }

  const handleSaveOutput = async (): Promise<void> => {
    const rows = activeState.rows

    if (rows.length === 0 || !activityMonitor) {
      return
    }

    const fileName = `activity-monitor-${activeCommand.command}-${fileSafeTimestamp()}.log`

    try {
      const saveResult = await activityMonitor.saveOutput({
        content: rowsToText(rows),
        suggestedName: fileName,
      })

      if (saveResult.canceled || !saveResult.filePath) {
        return
      }

      appendRowForCommand(
        activeCommand.command,
        `Saved output to ${saveResult.filePath}`,
        'system',
        'success',
      )
    } catch (error) {
      appendRowForCommand(
        activeCommand.command,
        `Save failed: ${error instanceof Error ? error.message : 'Unexpected error'}`,
        'system',
        'error',
      )
    }
  }

  const handleClearOutput = (): void => {
    updateTabState(activeCommand.command, state => ({
      ...state,
      rows: [],
      metrics: activeCommand.command === SYSTEM_MENU_COMMAND ? {} : state.metrics,
      runState: state.subscribed ? state.runState : 'ready',
    }))
  }

  const handleResetTab = async (): Promise<void> => {
    const state = tabStates[activeCommand.command] ?? createEmptyTabState()
    const stopSubscription = resolveStopSubscription(bridge)

    if (state.subscribed && state.subscriptionId && stopSubscription) {
      try {
        await stopSubscription(state.subscriptionId)
      } catch {}

      subscriptionToCommandRef.current.delete(state.subscriptionId)
    }

    updateTabState(activeCommand.command, () => createEmptyTabState())
  }

  const handleMinimize = (): void => {
    if (!activityMonitor) {
      return
    }

    void activityMonitor.minimizeWindow()
  }

  const handleToggleMaximize = async (): Promise<void> => {
    if (!activityMonitor) {
      return
    }

    const next = await activityMonitor.toggleMaximizeWindow()
    setIsWindowMaximized(next)
  }

  const handleClose = (): void => {
    if (!activityMonitor) {
      return
    }

    void activityMonitor.closeWindow()
  }

  const updateHeaderHeight = useCallback((): void => {
    const element = headerRef.current

    if (!element) {
      setHeaderHeight(0)
      return
    }

    setHeaderHeight(Math.ceil(element.getBoundingClientRect().height))
  }, [])

  useEffect(() => {
    if (!activityMonitor || !activityMonitor.onCommandSubscriptionTick) {
      return
    }

    const unsubscribe = activityMonitor.onCommandSubscriptionTick(message => {
      const command = subscriptionToCommandRef.current.get(message.subscriptionId)

      if (!command) {
        return
      }

      const lines = message.result.lines.length > 0 ? message.result.lines : ['(No output)']
      const nextRows = lines.map(line => {
        const isErrorLine = line.startsWith('stderr:') || !message.result.success

        return createRow(
          line,
          line.startsWith('stderr:') ? 'stderr' : 'system',
          isErrorLine ? 'error' : 'info',
          message.result.finishedAt,
        )
      })

      setTabStates(current => {
        const previous = current[command] ?? createEmptyTabState()

        return {
          ...current,
          [command]: {
            ...previous,
            rows: [...previous.rows, ...nextRows].slice(-MAX_ROWS_PER_TAB),
            runState: message.result.success ? 'success' : 'error',
            lastRunLabel: formatTime(message.result.finishedAt),
            metrics:
              command === SYSTEM_MENU_COMMAND
                ? parseSystemMetrics(lines, previous.metrics)
                : previous.metrics,
          },
        }
      })
    })

    return () => {
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    return () => {
      if (!activityMonitor) {
        return
      }

      for (const subscriptionId of subscriptionToCommandRef.current.keys()) {
        void activityMonitor.stopCommandSubscription(subscriptionId)
      }

      subscriptionToCommandRef.current.clear()
    }
  }, [])

  useEffect(() => {
    updateHeaderHeight()
  }, [updateHeaderHeight])

  useEffect(() => {
    const element = headerRef.current

    if (!element || typeof ResizeObserver === 'undefined') {
      return
    }

    const resizeObserver = new ResizeObserver(() => {
      updateHeaderHeight()
    })

    resizeObserver.observe(element)

    return () => {
      resizeObserver.disconnect()
    }
  }, [updateHeaderHeight])

  useEffect(() => {
    let isMounted = true

    const applyEnvironment = async (): Promise<void> => {
      if (!activityMonitor) {
        setPlatform('desktop')
        document.body.dataset.platform = 'desktop'
        return
      }

      try {
        const [resolvedPlatform, maximized] = await Promise.all([
          activityMonitor.getPlatform(),
          activityMonitor.isWindowMaximized(),
        ])

        if (!isMounted) {
          return
        }

        setPlatform(resolvedPlatform)
        setIsWindowMaximized(maximized)
        document.body.dataset.platform = resolvedPlatform
      } catch {
        if (!isMounted) {
          return
        }

        setPlatform('desktop')
        document.body.dataset.platform = 'desktop'
      }
    }

    const handleResize = (): void => {
      if (!activityMonitor) {
        return
      }

      void activityMonitor
        .isWindowMaximized()
        .then(maximized => {
          if (!isMounted) {
            return
          }

          setIsWindowMaximized(maximized)
        })
        .catch(() => {})
    }

    window.addEventListener('resize', handleResize)
    void applyEnvironment()

    return () => {
      isMounted = false
      window.removeEventListener('resize', handleResize)
      delete document.body.dataset.platform
    }
  }, [])

  useEffect(() => {
    if (activeCommand.command !== SYSTEM_MENU_COMMAND) {
      return
    }

    if (!activityMonitor || hasAutoStartedSystemRef.current) {
      return
    }

    hasAutoStartedSystemRef.current = true
    void handleToggleLiveRef.current(SYSTEM_MENU_COMMAND)
  }, [activeCommand.command])

  const statusLabel = activeState.subscribed
    ? `Live • ${statusLabelByState[activeState.runState]}`
    : statusLabelByState[activeState.runState]
  const showInput = REQUIRED_INPUT_COMMANDS.has(activeCommand.command)
  const hasMetrics = Object.keys(activeState.metrics).length > 0
  const canClear = activeState.rows.length > 0 || hasMetrics
  const canReset =
    activeState.subscribed ||
    activeState.input.trim().length > 0 ||
    activeState.rows.length > 0 ||
    hasMetrics ||
    activeState.lastRunLabel !== 'Never'
  const hasStartedActivity =
    activeState.subscribed || activeState.lastRunLabel !== 'Never' || activeState.rows.length > 0
  const isSystemCommand = activeCommand.command === SYSTEM_MENU_COMMAND
  const showSystemPanel = isSystemCommand && activeState.subscribed
  const showOutputPanel = !showSystemPanel
  const emptyStateCopy = emptyStateCopyByCommand[activeCommand.command] ?? {
    title: `${activeCommand.title} monitor is idle`,
    description: `Start live mode to stream ${activeCommand.title.toLowerCase()} updates.`,
  }
  const liveLabel = activeState.subscribed
    ? `Live every ${Math.max(1, Math.round(activeState.intervalMs / 1000))}s`
    : 'Live paused'
  const statusDotClass =
    activeState.runState === 'success'
      ? 'bg-green-500'
      : activeState.runState === 'error'
        ? 'bg-red-500'
        : activeState.runState === 'running'
          ? 'bg-amber-500'
          : 'bg-sky-400'
  const topTitleOffsetPx = DRAG_STRIP_HEIGHT_PX + SIDEBAR_TOP_PADDING_PX
  const topSurfaceClass = 'bg-(--main-bg)'
  const topStripClass = topSurfaceClass
  const windowControlsTopPx = Math.max(
    1,
    Math.floor((DRAG_STRIP_HEIGHT_PX - WINDOW_CONTROL_SIZE_PX) / 2),
  )

  return (
    <main className="h-full bg-transparent select-none [-webkit-app-region:drag]">
      <div
        className="grid h-full"
        style={{ gridTemplateColumns: 'var(--sidebar-w) minmax(0, 1fr)' }}
      >
        <Sidebar
          activeCommand={activeCommandName}
          commands={COMMANDS}
          onSelect={handleSelectCommand}
          platform={platform}
          runState={activeState.runState}
          statusLabel={statusLabel}
          lastRunLabel={activeState.lastRunLabel}
          topTitleOffsetPx={topTitleOffsetPx}
        />

        <section className="relative h-screen min-w-0 overflow-hidden bg-(--main-bg) [-webkit-app-region:no-drag]">
          <div
            className={`absolute inset-x-0 top-0 z-30 [-webkit-app-region:drag] ${topStripClass}`}
            style={{ height: DRAG_STRIP_HEIGHT_PX }}
          />
          {platform !== 'darwin' ? (
            <div
              className="absolute right-4 z-50 flex gap-1.5 [-webkit-app-region:no-drag]"
              style={{ top: windowControlsTopPx }}
            >
              <button
                className="h-6 w-6 cursor-pointer appearance-none rounded-sm border border-(--line) bg-accent/30 text-[11px] leading-none text-(--text-muted) shadow-none"
                onClick={handleMinimize}
                type="button"
              >
                —
              </button>
              <button
                className="h-6 w-6 cursor-pointer appearance-none rounded-sm border border-(--line) bg-accent/30 text-[11px] leading-none text-(--text-muted) shadow-none"
                onClick={() => void handleToggleMaximize()}
                type="button"
              >
                {isWindowMaximized ? '❐' : '□'}
              </button>
              <button
                className="h-6 w-6 cursor-pointer appearance-none rounded-sm border border-(--line) bg-accent/30 text-[11px] leading-none text-destructive shadow-none"
                onClick={handleClose}
                type="button"
              >
                ×
              </button>
            </div>
          ) : null}
          <div
            className={`absolute inset-x-0 z-20 ${topSurfaceClass}`}
            ref={headerRef}
            style={{ top: DRAG_STRIP_HEIGHT_PX }}
          >
            <div className="px-5 pb-3" style={{ paddingTop: RIGHT_PANEL_TOP_PADDING_PX }}>
              <CommandPanelHeader
                command={activeCommand}
                hasOutput={activeState.rows.length > 0}
                input={activeState.input}
                isLive={activeState.subscribed}
                onCopyOutput={() => void handleCopyOutput()}
                onInputChange={handleInputChange}
                onClearOutput={handleClearOutput}
                onResetTab={() => void handleResetTab()}
                onSaveOutput={() => void handleSaveOutput()}
                onToggleLive={() => void handleToggleLive()}
                placeholder={activeCommand.placeholder}
                canClear={canClear}
                canReset={canReset}
                showInput={showInput}
              />
            </div>
          </div>
          <div
            className="absolute inset-x-0 overflow-y-auto"
            ref={mainScrollRef}
            style={{ top: DRAG_STRIP_HEIGHT_PX + headerHeight, bottom: FOOTER_HEIGHT_PX }}
          >
            <div className={`flex min-h-full min-w-0 flex-col px-5 pb-5 ${topSurfaceClass}`}>
              {showSystemPanel ? (
                <SystemMenuPanel
                  intervalMs={activeState.intervalMs}
                  isLive={activeState.subscribed}
                  metrics={activeState.metrics}
                />
              ) : null}

              {showOutputPanel ? (
                <OutputPanel
                  emptyDescription={emptyStateCopy.description}
                  emptyTitle={emptyStateCopy.title}
                  hasStartedActivity={hasStartedActivity}
                  rows={activeState.rows}
                />
              ) : null}
            </div>
          </div>

          <footer
            aria-live="polite"
            className={`absolute inset-x-0 bottom-0 z-30 flex h-7 items-center justify-between gap-2 border-t border-(--line) px-3.5 text-[10px] leading-3.25 text-(--text-dim) ${topSurfaceClass}`}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={`h-2 w-2 border border-(--line) ${statusDotClass}`} />
              <span>{statusLabel}</span>
              <span className="h-2.5 w-px bg-(--line)" />
              <span>{activeCommand.title}</span>
            </div>
            <div className="flex min-w-0 items-center justify-end gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap">
              <span>{liveLabel}</span>
              <span className="h-2.5 w-px bg-(--line)" />
              <span>{`${activeState.rows.length} rows`}</span>
              <span className="h-2.5 w-px bg-(--line)" />
              <span>{`Last run ${activeState.lastRunLabel}`}</span>
            </div>
          </footer>
        </section>
      </div>
    </main>
  )
}

export default App
