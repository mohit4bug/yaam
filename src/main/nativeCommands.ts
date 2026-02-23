import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import {
  arch,
  cpus,
  freemem,
  hostname,
  loadavg,
  networkInterfaces,
  platform,
  release,
  totalmem,
  uptime,
} from 'node:os'

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
  signal: NodeJS.Signals | null
  lines: string[]
}

export type CommandOutputStream = 'stdout' | 'stderr' | 'system'

type CommandOutputEvent = {
  stream: CommandOutputStream
  line: string
}

type ExecuteCommandOptions = {
  onOutput?: (event: CommandOutputEvent) => void
}

type CommandExecutionOutput = {
  success: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  lines: string[]
}

type ProcessResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
}

type RunProcessOptions = {
  timeoutMs?: number
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
}

const DEFAULT_TIMEOUT_MS = 8_000
const TCP_TIMEOUT_MS = 5_000
const MAX_PARENT_DEPTH = 12

const splitOutput = (text: string): string[] =>
  text
    .split(/\r?\n/u)
    .map(line => line.trimEnd())
    .filter(Boolean)

const formatBytesPrecise = (value: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let amount = value

  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }

  if (index === 0) {
    return `${Math.max(0, Math.round(amount))} B`
  }

  return `${amount.toFixed(2)} ${units[index]}`
}

const formatPercent = (value: number, fractionDigits = 2): string =>
  `${Math.max(0, value).toFixed(fractionDigits)}%`

const formatDuration = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const remainingSeconds = total % 60

  const parts: string[] = []

  if (days > 0) {
    parts.push(`${days}d`)
  }
  if (hours > 0 || parts.length > 0) {
    parts.push(`${hours}h`)
  }
  if (minutes > 0 || parts.length > 0) {
    parts.push(`${minutes}m`)
  }
  parts.push(`${remainingSeconds}s`)

  return parts.join(' ')
}

const parseWholeNumber = (value: string): number | null => {
  const cleaned = value.replaceAll(',', '').replace(/\.$/u, '').trim()

  if (!/^\d+$/u.test(cleaned)) {
    return null
  }

  const parsed = Number(cleaned)

  if (!Number.isFinite(parsed)) {
    return null
  }

  return parsed
}

const parseFloatingNumber = (value: string): number | null => {
  const cleaned = value.trim()

  if (!/^\d+(?:\.\d+)?$/u.test(cleaned)) {
    return null
  }

  const parsed = Number(cleaned)

  if (!Number.isFinite(parsed)) {
    return null
  }

  return parsed
}

const parseMemoryUnitAmount = (amount: string, unit: string): number | null => {
  const parsedAmount = parseFloatingNumber(amount)

  if (parsedAmount === null) {
    return null
  }

  const exponentByUnit: Record<string, number> = {
    B: 0,
    K: 1,
    M: 2,
    G: 3,
    T: 4,
    P: 5,
  }
  const normalizedUnit = unit.toUpperCase()
  const exponent = exponentByUnit[normalizedUnit]

  if (typeof exponent !== 'number') {
    return null
  }

  return Math.round(parsedAmount * 1024 ** exponent)
}

const normalizeVmStatKey = (key: string): string => key.replaceAll('"', '').trim().toLowerCase()

type VmStatSnapshot = {
  pageSize: number
  values: Record<string, number>
}

const parseVmStat = (output: string): VmStatSnapshot | null => {
  const lines = splitOutput(output)
  const headerLine = lines.find(line => line.includes('page size of'))

  if (!headerLine) {
    return null
  }

  const pageSizeMatch = headerLine.match(/page size of\s+(\d+)\s+bytes/iu)
  const pageSize = pageSizeMatch && pageSizeMatch[1] ? parseWholeNumber(pageSizeMatch[1]) : null

  if (!pageSize) {
    return null
  }

  const values: Record<string, number> = {}

  for (const line of lines) {
    const separator = line.indexOf(':')

    if (separator <= 0) {
      continue
    }

    const key = normalizeVmStatKey(line.slice(0, separator))
    const valueMatch = line.slice(separator + 1).match(/([0-9][0-9,]*)/u)

    if (!valueMatch || !valueMatch[1]) {
      continue
    }

    const value = parseWholeNumber(valueMatch[1])

    if (value === null) {
      continue
    }

    values[key] = value
  }

  return { pageSize, values }
}

const readVmStatValue = (snapshot: VmStatSnapshot, keys: string[]): number => {
  for (const key of keys) {
    const value = snapshot.values[normalizeVmStatKey(key)]

    if (typeof value === 'number') {
      return value
    }
  }

  return 0
}

const parseSwapUsageUsedBytes = (output: string): number | null => {
  const match = output.match(/\bused\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*([BKMGTP])\b/iu)

  if (!match || !match[1] || !match[2]) {
    return null
  }

  return parseMemoryUnitAmount(match[1], match[2])
}

const parseTopCpuUsage = (
  output: string,
): { userPercent: number; systemPercent: number; idlePercent: number } | null => {
  const cpuLine = splitOutput(output).find(line => line.startsWith('CPU usage:'))

  if (!cpuLine) {
    return null
  }

  const match = cpuLine.match(
    /CPU usage:\s*([0-9]+(?:\.[0-9]+)?)%\s*user,\s*([0-9]+(?:\.[0-9]+)?)%\s*sys,\s*([0-9]+(?:\.[0-9]+)?)%\s*idle/iu,
  )

  if (!match || !match[1] || !match[2] || !match[3]) {
    return null
  }

  const userPercent = parseFloatingNumber(match[1])
  const systemPercent = parseFloatingNumber(match[2])
  const idlePercent = parseFloatingNumber(match[3])

  if (userPercent === null || systemPercent === null || idlePercent === null) {
    return null
  }

  return { userPercent, systemPercent, idlePercent }
}

const parseMemoryFreePercent = (output: string): number | null => {
  const match = output.match(/memory free percentage:\s*([0-9]+(?:\.[0-9]+)?)%/iu)

  if (!match || !match[1]) {
    return null
  }

  return parseFloatingNumber(match[1])
}

type DarwinHealthSnapshot = {
  totalBytes: number
  memoryUsedBytes: number
  freeMemoryBytes: number
  memoryUsedPercent: number
  appMemoryBytes: number
  wiredMemoryBytes: number
  compressedMemoryBytes: number
  cachedFilesBytes: number
  swapUsedBytes: number
  cpuUserPercent: number | null
  cpuSystemPercent: number | null
  cpuIdlePercent: number | null
  cpuBusyPercent: number | null
  memoryPressureEstimatePercent: number | null
}

const readDarwinHealthSnapshot = async (): Promise<DarwinHealthSnapshot | null> => {
  try {
    const [vmStatResult, sysctlResult, topResult, memoryPressureResult] = await Promise.all([
      runProcess('vm_stat', []),
      runProcess('sysctl', ['vm.swapusage', 'hw.memsize']),
      runProcess('top', ['-l', '1', '-n', '0']),
      runProcess('memory_pressure', ['-Q']),
    ])

    if (vmStatResult.exitCode !== 0 || sysctlResult.exitCode !== 0) {
      return null
    }

    const vmStatSnapshot = parseVmStat(vmStatResult.stdout)

    if (!vmStatSnapshot) {
      return null
    }

    const totalMatch = sysctlResult.stdout.match(/hw\.memsize:\s*(\d+)/u)
    const totalBytes = totalMatch && totalMatch[1] ? parseWholeNumber(totalMatch[1]) : null

    if (totalBytes === null) {
      return null
    }

    const pagesFree = readVmStatValue(vmStatSnapshot, ['Pages free'])
    const pagesActive = readVmStatValue(vmStatSnapshot, ['Pages active'])
    const pagesInactive = readVmStatValue(vmStatSnapshot, ['Pages inactive'])
    const pagesSpeculative = readVmStatValue(vmStatSnapshot, ['Pages speculative'])
    const pagesThrottled = readVmStatValue(vmStatSnapshot, ['Pages throttled'])
    const pagesWired = readVmStatValue(vmStatSnapshot, ['Pages wired down'])
    const pagesPurgeable = readVmStatValue(vmStatSnapshot, ['Pages purgeable'])
    const pagesFileBacked = readVmStatValue(vmStatSnapshot, ['File-backed pages'])
    const pagesCompressed = readVmStatValue(vmStatSnapshot, [
      'Pages occupied by compressor',
      'Pages used by VM compressor',
    ])
    const pageSize = vmStatSnapshot.pageSize

    // App Memory + Wired + Compressed follows Activity Monitor's "Memory Used" split.
    const appMemoryPages = Math.max(
      0,
      pagesActive +
        pagesInactive +
        pagesSpeculative +
        pagesThrottled -
        pagesPurgeable -
        pagesFileBacked,
    )
    const appMemoryBytes = appMemoryPages * pageSize
    const wiredMemoryBytes = pagesWired * pageSize
    const compressedMemoryBytes = pagesCompressed * pageSize
    const memoryUsedBytes = appMemoryBytes + wiredMemoryBytes + compressedMemoryBytes
    const cachedFilesBytes = (pagesFileBacked + pagesPurgeable) * pageSize
    const freeMemoryBytes = (pagesFree + pagesSpeculative) * pageSize
    const memoryUsedPercent = (memoryUsedBytes / totalBytes) * 100
    const swapUsedBytes = parseSwapUsageUsedBytes(sysctlResult.stdout) ?? 0
    const cpuUsage = topResult.exitCode === 0 ? parseTopCpuUsage(topResult.stdout) : null
    const memoryFreePercent =
      memoryPressureResult.exitCode === 0
        ? parseMemoryFreePercent(memoryPressureResult.stdout)
        : null
    const memoryPressureEstimatePercent =
      memoryFreePercent === null ? null : Math.max(0, Math.min(100, 100 - memoryFreePercent))

    return {
      totalBytes,
      memoryUsedBytes,
      freeMemoryBytes,
      memoryUsedPercent,
      appMemoryBytes,
      wiredMemoryBytes,
      compressedMemoryBytes,
      cachedFilesBytes,
      swapUsedBytes,
      cpuUserPercent: cpuUsage ? cpuUsage.userPercent : null,
      cpuSystemPercent: cpuUsage ? cpuUsage.systemPercent : null,
      cpuIdlePercent: cpuUsage ? cpuUsage.idlePercent : null,
      cpuBusyPercent: cpuUsage ? Math.max(0, 100 - cpuUsage.idlePercent) : null,
      memoryPressureEstimatePercent,
    }
  } catch {
    return null
  }
}

const isErrnoException = (value: unknown): value is NodeJS.ErrnoException =>
  value instanceof Error && 'code' in value

const emitOutput = (
  options: ExecuteCommandOptions | undefined,
  stream: CommandOutputStream,
  line: string,
): void => {
  if (!line) {
    return
  }

  if (!options || !options.onOutput) {
    return
  }

  options.onOutput({ stream, line })
}

const parsePid = (raw: string): number => {
  const input = raw.trim()

  if (!/^\d+$/u.test(input)) {
    throw new Error('PID must be a positive integer.')
  }

  const pid = Number(input)

  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('PID must be a positive integer.')
  }

  return pid
}

const parsePort = (raw: string): number | null => {
  const input = raw.trim()

  if (input.length === 0) {
    return null
  }

  if (!/^\d+$/u.test(input)) {
    throw new Error('Port must be numeric.')
  }

  const port = Number(input)

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Port must be between 1 and 65535.')
  }

  return port
}

const parseHostPort = (raw: string): { host: string; port: number } => {
  const input = raw.trim()

  if (!input) {
    throw new Error('Provide target as host:port.')
  }

  const separator = input.lastIndexOf(':')

  if (separator <= 0 || separator === input.length - 1) {
    throw new Error('Target must be in host:port format.')
  }

  const host = input.slice(0, separator).trim()
  const portRaw = input.slice(separator + 1).trim()

  if (!host) {
    throw new Error('Host is required.')
  }

  const port = parsePort(portRaw)

  if (!port) {
    throw new Error('Port is required.')
  }

  return { host, port }
}

const readBufferedLines = (
  chunk: string,
  remaining: string,
  onLine?: (line: string) => void,
): string => {
  const combined = `${remaining}${chunk}`
  const parts = combined.split(/\r?\n/u)

  if (parts.length === 0) {
    return combined
  }

  const nextRemainder = parts.pop() ?? ''

  for (const line of parts) {
    if (!line) {
      continue
    }

    if (onLine) {
      onLine(line)
    }
  }

  return nextRemainder
}

const runProcess = async (
  executable: string,
  args: string[],
  options?: RunProcessOptions,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const timeoutMs =
      options && typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_TIMEOUT_MS
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let stdoutRemainder = ''
    let stderrRemainder = ''

    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        stdout += chunk
        stdoutRemainder = readBufferedLines(
          chunk,
          stdoutRemainder,
          options ? options.onStdoutLine : undefined,
        )
      })
    }

    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => {
        stderr += chunk
        stderrRemainder = readBufferedLines(
          chunk,
          stderrRemainder,
          options ? options.onStderrLine : undefined,
        )
      })
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')

      const hardKillTimer = setTimeout(() => {
        child.kill('SIGKILL')
      }, 300)
      hardKillTimer.unref()
    }, timeoutMs)
    timeoutHandle.unref()

    child.on('error', error => {
      clearTimeout(timeoutHandle)
      reject(error)
    })

    child.on('close', (exitCode, signal) => {
      clearTimeout(timeoutHandle)

      const pendingStdout = stdoutRemainder.trim()
      const pendingStderr = stderrRemainder.trim()

      if (pendingStdout) {
        if (options && options.onStdoutLine) {
          options.onStdoutLine(pendingStdout)
        }
      }
      if (pendingStderr) {
        if (options && options.onStderrLine) {
          options.onStderrLine(pendingStderr)
        }
      }

      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        signal,
        timedOut,
      })
    })
  })

const formatProcessResult = (
  processResult: ProcessResult,
  timeoutMs: number,
  options?: {
    stderrPrefix?: string
    transformStdoutLine?: (line: string) => string
  },
): CommandExecutionOutput => {
  const lines: string[] = []
  const stdoutLines = splitOutput(processResult.stdout)
  const stderrLines = splitOutput(processResult.stderr)
  const stderrPrefix = options && options.stderrPrefix ? options.stderrPrefix : 'stderr:'

  if (processResult.timedOut) {
    lines.push(`Command timed out after ${timeoutMs}ms.`)
  }

  if (stdoutLines.length > 0) {
    lines.push(
      ...stdoutLines.map(line =>
        options && options.transformStdoutLine ? options.transformStdoutLine(line) : line,
      ),
    )
  }

  if (stderrLines.length > 0) {
    lines.push(...stderrLines.map(line => `${stderrPrefix} ${line}`))
  }

  if (lines.length === 0) {
    lines.push('(No output)')
  }

  const successfulExit = processResult.exitCode === 0

  return {
    success: successfulExit && !processResult.timedOut,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    lines,
  }
}

const runProcessCommand = async (
  executable: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options?: {
    stderrPrefix?: string
    transformStdoutLine?: (line: string) => string
    onOutput?: (event: CommandOutputEvent) => void
  },
): Promise<CommandExecutionOutput> => {
  try {
    const processResult = await runProcess(executable, args, {
      timeoutMs,
      onStdoutLine: line => {
        const transformed =
          options && options.transformStdoutLine ? options.transformStdoutLine(line) : line
        if (options && options.onOutput) {
          options.onOutput({ stream: 'stdout', line: transformed })
        }
      },
      onStderrLine: line => {
        if (options && options.onOutput) {
          options.onOutput({ stream: 'stderr', line })
        }
      },
    })
    return formatProcessResult(processResult, timeoutMs, options)
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return {
        success: false,
        exitCode: null,
        signal: null,
        lines: [`Native utility "${executable}" is not available on this machine.`],
      }
    }

    throw error
  }
}

const runScanPorts = async (
  argument: string,
  options?: ExecuteCommandOptions,
): Promise<CommandExecutionOutput> => {
  const targetPort = parsePort(argument)

  if (platform() === 'win32') {
    const result = await runProcessCommand('netstat', ['-ano', '-p', 'tcp'], DEFAULT_TIMEOUT_MS, {
      onOutput: options ? options.onOutput : undefined,
    })

    const firstLine = result.lines[0]
    const isNativeUtilityMissing =
      typeof firstLine === 'string' && firstLine.startsWith('Native utility')

    if (!targetPort || result.lines.length === 0 || isNativeUtilityMissing) {
      return result
    }

    const filtered = result.lines.filter(line => line.includes(`:${targetPort}`))

    return {
      ...result,
      success: filtered.length > 0,
      lines:
        filtered.length > 0 ? filtered : [`No listening TCP sockets found for port ${targetPort}.`],
    }
  }

  if (targetPort) {
    return runProcessCommand(
      'lsof',
      ['-nP', `-iTCP:${targetPort}`, '-sTCP:LISTEN'],
      DEFAULT_TIMEOUT_MS,
      {
        onOutput: options ? options.onOutput : undefined,
      },
    )
  }

  return runProcessCommand('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], DEFAULT_TIMEOUT_MS, {
    onOutput: options ? options.onOutput : undefined,
  })
}

const runInspectProcess = async (
  argument: string,
  options?: ExecuteCommandOptions,
): Promise<CommandExecutionOutput> => {
  const pid = parsePid(argument)

  if (platform() === 'win32') {
    return runProcessCommand('tasklist', ['/FI', `PID eq ${pid}`, '/V'], DEFAULT_TIMEOUT_MS, {
      onOutput: options ? options.onOutput : undefined,
    })
  }

  return runProcessCommand(
    'ps',
    ['-p', String(pid), '-o', 'pid,ppid,comm,%cpu,%mem,state,etime'],
    DEFAULT_TIMEOUT_MS,
    {
      onOutput: options ? options.onOutput : undefined,
    },
  )
}

const runTerminate = async (
  argument: string,
  force: boolean,
  options?: ExecuteCommandOptions,
): Promise<CommandExecutionOutput> => {
  const pid = parsePid(argument)

  if (platform() === 'win32') {
    return runProcessCommand(
      'taskkill',
      force ? ['/PID', String(pid), '/F'] : ['/PID', String(pid)],
      DEFAULT_TIMEOUT_MS,
      {
        onOutput: options ? options.onOutput : undefined,
      },
    )
  }

  const signal = force ? '-KILL' : '-TERM'
  return runProcessCommand('kill', [signal, String(pid)], DEFAULT_TIMEOUT_MS, {
    onOutput: options ? options.onOutput : undefined,
  })
}

const runHealthCheck = async (options?: ExecuteCommandOptions): Promise<CommandExecutionOutput> => {
  const totalMemoryFallback = totalmem()
  const memoryFreeFallback = freemem()
  const memoryUsedFallback = totalMemoryFallback - memoryFreeFallback
  const cpuCoreCount = cpus().length
  const currentPlatform = platform()
  const externalInterfaceCount = Object.values(networkInterfaces())
    .flatMap(group => group ?? [])
    .filter(entry => !entry.internal).length
  const darwinSnapshot = currentPlatform === 'darwin' ? await readDarwinHealthSnapshot() : null
  const displayedTotalMemory = darwinSnapshot ? darwinSnapshot.totalBytes : totalMemoryFallback
  const displayedMemoryUsed = darwinSnapshot ? darwinSnapshot.memoryUsedBytes : memoryUsedFallback
  const displayedMemoryFree = darwinSnapshot ? darwinSnapshot.freeMemoryBytes : memoryFreeFallback
  const displayedMemoryUsedPercent = darwinSnapshot
    ? darwinSnapshot.memoryUsedPercent
    : (displayedMemoryUsed / Math.max(1, displayedTotalMemory)) * 100
  const currentLoadAverage = loadavg()
  const loadPerCorePercent = ((currentLoadAverage[0] ?? 0) / Math.max(1, cpuCoreCount)) * 100

  const lines = [
    `Host: ${hostname()}`,
    `OS: ${currentPlatform} ${release()}`,
    `Architecture: ${arch()}`,
    `CPU Cores: ${cpuCoreCount}`,
    `Uptime: ${formatDuration(uptime())}`,
    `Memory: ${formatBytesPrecise(displayedMemoryUsed)} used / ${formatBytesPrecise(displayedTotalMemory)} total (${formatPercent(displayedMemoryUsedPercent)})`,
    `Memory Used Percent: ${formatPercent(displayedMemoryUsedPercent)}`,
    `Free Memory: ${formatBytesPrecise(displayedMemoryFree)}`,
    `External Network Interfaces: ${externalInterfaceCount}`,
  ]

  if (darwinSnapshot) {
    lines.push(`App Memory: ${formatBytesPrecise(darwinSnapshot.appMemoryBytes)}`)
    lines.push(`Wired Memory: ${formatBytesPrecise(darwinSnapshot.wiredMemoryBytes)}`)
    lines.push(`Compressed: ${formatBytesPrecise(darwinSnapshot.compressedMemoryBytes)}`)
    lines.push(`Cached Files: ${formatBytesPrecise(darwinSnapshot.cachedFilesBytes)}`)
    lines.push(`Swap Used: ${formatBytesPrecise(darwinSnapshot.swapUsedBytes)}`)

    if (
      darwinSnapshot.cpuUserPercent !== null &&
      darwinSnapshot.cpuSystemPercent !== null &&
      darwinSnapshot.cpuIdlePercent !== null
    ) {
      lines.push(
        `CPU Usage: ${formatPercent(darwinSnapshot.cpuUserPercent)} user / ${formatPercent(darwinSnapshot.cpuSystemPercent)} sys / ${formatPercent(darwinSnapshot.cpuIdlePercent)} idle`,
      )
      lines.push(`CPU User: ${formatPercent(darwinSnapshot.cpuUserPercent)}`)
      lines.push(`CPU System: ${formatPercent(darwinSnapshot.cpuSystemPercent)}`)
      lines.push(`CPU Idle: ${formatPercent(darwinSnapshot.cpuIdlePercent)}`)

      if (darwinSnapshot.cpuBusyPercent !== null) {
        lines.push(`CPU Busy: ${formatPercent(darwinSnapshot.cpuBusyPercent)}`)
      }
    }

    if (darwinSnapshot.memoryPressureEstimatePercent !== null) {
      lines.push(
        `Memory Pressure Estimate: ${formatPercent(darwinSnapshot.memoryPressureEstimatePercent)}`,
      )
    }
  }

  if (currentPlatform !== 'win32') {
    lines.push(
      `Load Average (1m/5m/15m): ${currentLoadAverage.map(item => item.toFixed(2)).join(' / ')}`,
    )
    lines.push(`Load Per Core (1m): ${formatPercent(loadPerCorePercent)}`)
  }

  lines.push('Health check completed.')

  for (const line of lines) {
    emitOutput(options, 'system', line)
  }

  return {
    success: true,
    exitCode: 0,
    signal: null,
    lines,
  }
}

const runTcpTest = async (
  argument: string,
  options?: ExecuteCommandOptions,
): Promise<CommandExecutionOutput> => {
  const { host, port } = parseHostPort(argument)
  const start = Date.now()

  return new Promise(resolve => {
    const socket = createConnection({ host, port })
    let settled = false

    const settle = (output: CommandExecutionOutput): void => {
      if (settled) {
        return
      }

      settled = true
      socket.destroy()
      resolve(output)
    }

    socket.setTimeout(TCP_TIMEOUT_MS)

    socket.on('connect', () => {
      emitOutput(options, 'system', `Connected to ${host}:${port}.`)
      emitOutput(options, 'system', `Round trip estimate: ${Date.now() - start}ms.`)
      settle({
        success: true,
        exitCode: 0,
        signal: null,
        lines: [`Connected to ${host}:${port}.`, `Round trip estimate: ${Date.now() - start}ms.`],
      })
    })

    socket.on('timeout', () => {
      emitOutput(options, 'stderr', `Connection timed out after ${TCP_TIMEOUT_MS}ms.`)
      settle({
        success: false,
        exitCode: 1,
        signal: null,
        lines: [`Connection timed out after ${TCP_TIMEOUT_MS}ms.`],
      })
    })

    socket.on('error', error => {
      emitOutput(options, 'stderr', `Connection failed: ${error.message}`)
      settle({
        success: false,
        exitCode: 1,
        signal: null,
        lines: [`Connection failed: ${error.message}`],
      })
    })
  })
}

const readUnixProcess = async (
  pid: number,
): Promise<{ pid: number; parentPid: number; command: string } | null> => {
  const processResult = await runProcess('ps', [
    '-p',
    String(pid),
    '-o',
    'pid=',
    '-o',
    'ppid=',
    '-o',
    'comm=',
  ])
  const firstLine = splitOutput(processResult.stdout)[0]

  if (!firstLine) {
    return null
  }

  const match = firstLine.match(/^(\d+)\s+(\d+)\s+(.+)$/u)
  const commandName = match && match[3] ? match[3].trim() : ''

  if (!match || !commandName) {
    return null
  }

  return {
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    command: commandName,
  }
}

const readWindowsProcess = async (
  pid: number,
): Promise<{ pid: number; parentPid: number; command: string } | null> => {
  const command =
    `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ` +
    'Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'
  const processResult = await runProcess('powershell', ['-NoProfile', '-Command', command])
  const payload = processResult.stdout.trim()

  if (!payload || payload === 'null') {
    return null
  }

  try {
    const parsed = JSON.parse(payload) as
      | { ProcessId: number; ParentProcessId: number; Name: string }
      | Array<{ ProcessId: number; ParentProcessId: number; Name: string }>
    const item = Array.isArray(parsed) ? parsed[0] : parsed

    if (!item) {
      return null
    }

    return {
      pid: Number(item.ProcessId),
      parentPid: Number(item.ParentProcessId),
      command: String(item.Name),
    }
  } catch {
    return null
  }
}

const runShowParent = async (
  argument: string,
  options?: ExecuteCommandOptions,
): Promise<CommandExecutionOutput> => {
  const initialPid = parsePid(argument)
  let currentPid = initialPid
  const chain: Array<{ pid: number; parentPid: number; command: string }> = []

  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const current =
      platform() === 'win32'
        ? await readWindowsProcess(currentPid)
        : await readUnixProcess(currentPid)

    if (!current) {
      break
    }

    chain.push(current)

    if (current.parentPid <= 0 || current.parentPid === current.pid) {
      break
    }

    currentPid = current.parentPid
  }

  if (chain.length === 0) {
    emitOutput(options, 'stderr', `Process ${initialPid} not found.`)
    return {
      success: false,
      exitCode: 1,
      signal: null,
      lines: [`Process ${initialPid} not found.`],
    }
  }

  const summary = chain.map(item => `${item.pid}(${item.command})`).join(' <- ')
  emitOutput(options, 'system', 'Parent chain:')
  emitOutput(options, 'system', summary)

  return {
    success: true,
    exitCode: 0,
    signal: null,
    lines: ['Parent chain:', summary],
  }
}

const runOpenFiles = async (
  argument: string,
  options?: ExecuteCommandOptions,
): Promise<CommandExecutionOutput> => {
  const pid = parsePid(argument)

  if (platform() === 'win32') {
    emitOutput(
      options,
      'stderr',
      'Open file listing is currently supported on macOS and Linux only.',
    )
    return {
      success: false,
      exitCode: 1,
      signal: null,
      lines: ['Open file listing is currently supported on macOS and Linux only.'],
    }
  }

  return runProcessCommand('lsof', ['-nP', '-p', String(pid)], DEFAULT_TIMEOUT_MS, {
    onOutput: options ? options.onOutput : undefined,
  })
}

const runBinaryPath = async (
  argument: string,
  options?: ExecuteCommandOptions,
): Promise<CommandExecutionOutput> => {
  const pid = parsePid(argument)

  if (platform() === 'win32') {
    const command = `(Get-Process -Id ${pid}).Path`
    return runProcessCommand(
      'powershell',
      ['-NoProfile', '-Command', command],
      DEFAULT_TIMEOUT_MS,
      {
        onOutput: options ? options.onOutput : undefined,
      },
    )
  }

  return runProcessCommand('ps', ['-p', String(pid), '-o', 'command='], DEFAULT_TIMEOUT_MS, {
    onOutput: options ? options.onOutput : undefined,
  })
}

const runWatchCpu = async (
  argument: string,
  options?: ExecuteCommandOptions,
): Promise<CommandExecutionOutput> => {
  const pid = parsePid(argument)

  if (platform() === 'win32') {
    return runProcessCommand(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      DEFAULT_TIMEOUT_MS,
      {
        onOutput: options ? options.onOutput : undefined,
      },
    )
  }

  return runProcessCommand(
    'ps',
    ['-p', String(pid), '-o', 'pid=,%cpu=,%mem=,etime=,state=,comm='],
    DEFAULT_TIMEOUT_MS,
    {
      onOutput: options ? options.onOutput : undefined,
    },
  )
}

const runSelectedCommand = async (
  request: ExecuteCommandRequest,
  options?: ExecuteCommandOptions,
): Promise<CommandExecutionOutput> => {
  const argument = request.argument.trim()

  if (request.command === 'scan-ports') {
    return runScanPorts(argument, options)
  }

  if (request.command === 'inspect-process') {
    return runInspectProcess(argument, options)
  }

  if (request.command === 'terminate') {
    return runTerminate(argument, false, options)
  }

  if (request.command === 'force-kill') {
    return runTerminate(argument, true, options)
  }

  if (request.command === 'check-health') {
    return runHealthCheck(options)
  }

  if (request.command === 'test-tcp') {
    return runTcpTest(argument, options)
  }

  if (request.command === 'show-parent') {
    return runShowParent(argument, options)
  }

  if (request.command === 'open-files') {
    return runOpenFiles(argument, options)
  }

  if (request.command === 'binary-path') {
    return runBinaryPath(argument, options)
  }

  return runWatchCpu(argument, options)
}

export const executeNativeCommand = async (
  request: ExecuteCommandRequest,
  options?: ExecuteCommandOptions,
): Promise<ExecuteCommandResult> => {
  const startedAtDate = new Date()

  try {
    const output = await runSelectedCommand(request, options)
    const finishedAtDate = new Date()

    return {
      command: request.command,
      argument: request.argument.trim(),
      startedAt: startedAtDate.toISOString(),
      finishedAt: finishedAtDate.toISOString(),
      durationMs: finishedAtDate.getTime() - startedAtDate.getTime(),
      success: output.success,
      exitCode: output.exitCode,
      signal: output.signal,
      lines: output.lines,
    }
  } catch (error) {
    const finishedAtDate = new Date()
    const message = error instanceof Error ? error.message : 'Unexpected error'
    emitOutput(options, 'stderr', message)

    return {
      command: request.command,
      argument: request.argument.trim(),
      startedAt: startedAtDate.toISOString(),
      finishedAt: finishedAtDate.toISOString(),
      durationMs: finishedAtDate.getTime() - startedAtDate.getTime(),
      success: false,
      exitCode: 1,
      signal: null,
      lines: [message],
    }
  }
}
