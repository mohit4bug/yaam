import { useEffect, useRef, useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

type SystemMenuPanelProps = {
  metrics: Readonly<Record<string, string>>
  isLive: boolean
  intervalMs: number
}

type TrendPoint = {
  at: string
  cpuBusy: number | null
  memoryUsed: number | null
  loadPerCore: number | null
}

const MAX_TREND_POINTS = 90

const ORDERED_KEYS = [
  'Host',
  'OS',
  'Architecture',
  'CPU Cores',
  'Uptime',
  'CPU Usage',
  'CPU Busy',
  'CPU User',
  'CPU System',
  'CPU Idle',
  'Memory',
  'Memory Used Percent',
  'App Memory',
  'Wired Memory',
  'Compressed',
  'Cached Files',
  'Free Memory',
  'Swap Used',
  'Memory Pressure Estimate',
  'External Network Interfaces',
  'Load Average (1m/5m/15m)',
  'Load Per Core (1m)',
] as const

const METRIC_CARD_CLASS = 'h-[62px] rounded-sm border border-border/70 bg-background/55 p-2.5'
const CHART_CARD_CLASS = 'rounded-sm border border-border/70 bg-background/55 p-2.5'
const METRIC_LABEL_CLASS =
  'm-0 h-3.5 overflow-hidden text-[9.5px] leading-3.5 font-medium text-muted-foreground'
const METRIC_VALUE_CLASS = 'mt-1 mb-0 h-4.5 overflow-hidden text-[12px] leading-4.5 text-foreground'

const CHART_STRONG = 'hsl(var(--chart-1))'
const CHART_MEDIUM = 'hsl(var(--chart-3))'
const CHART_FIFTH = 'hsl(var(--chart-5))'
const CHART_AXIS = 'hsl(var(--muted-foreground) / 0.72)'
const CHART_GRID = 'hsl(var(--border) / 0.45)'
const TOOLTIP_BG = 'hsl(var(--card) / 0.96)'
const TOOLTIP_BORDER = 'hsl(var(--border) / 0.72)'

const parseBytes = (raw: string): number | null => {
  const match = raw.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)$/iu)

  if (!match || !match[1] || !match[2]) {
    return null
  }

  const amount = Number(match[1])
  const unit = match[2].toUpperCase()
  const exponentByUnit: Record<string, number> = {
    B: 0,
    KB: 1,
    MB: 2,
    GB: 3,
    TB: 4,
  }
  const exponent = exponentByUnit[unit]

  if (!Number.isFinite(amount) || typeof exponent !== 'number') {
    return null
  }

  return amount * 1024 ** exponent
}

const parsePercent = (raw: string | undefined, max: number | null = 100): number | null => {
  if (!raw) {
    return null
  }

  const match = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*%/u)

  if (!match || !match[1]) {
    return null
  }

  const parsed = Number(match[1])

  if (!Number.isFinite(parsed)) {
    return null
  }

  const nonNegative = Math.max(0, parsed)

  if (typeof max === 'number') {
    return Math.min(max, nonNegative)
  }

  return nonNegative
}

const parseMemoryUsedPercent = (memoryValue: string | undefined): number | null => {
  if (!memoryValue) {
    return null
  }

  const match = memoryValue.match(/^(.+?)\s+used\s*\/\s*(.+?)\s+total(?:\s*\(.+\))?$/iu)

  if (!match || !match[1] || !match[2]) {
    return null
  }

  const usedBytes = parseBytes(match[1])
  const totalBytes = parseBytes(match[2])

  if (usedBytes === null || totalBytes === null || totalBytes <= 0) {
    return null
  }

  return Math.max(0, Math.min(100, (usedBytes / totalBytes) * 100))
}

const parseLoadPerCorePercent = (
  loadValue: string | undefined,
  cpuCoresValue: string | undefined,
): number | null => {
  if (!loadValue) {
    return null
  }

  const cores = Math.max(1, Number.parseInt(cpuCoresValue ?? '1', 10) || 1)
  const values = loadValue
    .split('/')
    .map(item => Number.parseFloat(item.trim()))
    .filter(value => Number.isFinite(value))

  const first = values[0]

  if (typeof first !== 'number') {
    return null
  }

  return Math.max(0, (first / cores) * 100)
}

const averageTrend = (
  points: ReadonlyArray<TrendPoint>,
  key: keyof Pick<TrendPoint, 'cpuBusy' | 'memoryUsed' | 'loadPerCore'>,
): number | null => {
  const values = points.map(point => point[key]).filter((value): value is number => value !== null)

  if (values.length === 0) {
    return null
  }

  const total = values.reduce((sum, value) => sum + value, 0)

  return total / values.length
}

const trendDelta = (
  points: ReadonlyArray<TrendPoint>,
  key: keyof Pick<TrendPoint, 'cpuBusy' | 'memoryUsed' | 'loadPerCore'>,
): number | null => {
  const values = points.map(point => point[key]).filter((value): value is number => value !== null)

  if (values.length < 2) {
    return null
  }

  const latest = values[values.length - 1]
  const previous = values[values.length - 2]

  if (typeof latest !== 'number' || typeof previous !== 'number') {
    return null
  }

  return latest - previous
}

const formatMetricPercent = (value: number | null): string =>
  value === null ? 'n/a' : `${value.toFixed(2)}%`

const formatDeltaPercent = (value: number | null): string =>
  value === null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`

function SystemMenuPanel({ metrics, isLive, intervalMs }: SystemMenuPanelProps): React.JSX.Element {
  const entries = ORDERED_KEYS.map(key => ({ key, value: metrics[key] })).filter(entry =>
    Boolean(entry.value),
  )
  const isLoaded = entries.length > 0
  const frequencySeconds = Math.max(1, Math.round(intervalMs / 1_000))

  const memoryUsedPercent =
    parsePercent(metrics['Memory Used Percent']) ?? parseMemoryUsedPercent(metrics.Memory)
  const cpuBusyPercent = (() => {
    const explicitBusy = parsePercent(metrics['CPU Busy'])

    if (explicitBusy !== null) {
      return explicitBusy
    }

    const user = parsePercent(metrics['CPU User'])
    const system = parsePercent(metrics['CPU System'])

    if (user === null || system === null) {
      return null
    }

    return Math.max(0, Math.min(100, user + system))
  })()
  const loadPerCoreFallback = parseLoadPerCorePercent(
    metrics['Load Average (1m/5m/15m)'],
    metrics['CPU Cores'],
  )
  const loadPerCorePercent =
    parsePercent(metrics['Load Per Core (1m)'], null) ?? loadPerCoreFallback

  const [trendPoints, setTrendPoints] = useState<TrendPoint[]>([])
  const previousSignatureRef = useRef('')

  useEffect(() => {
    if (!isLoaded) {
      previousSignatureRef.current = ''
      setTrendPoints([])
      return
    }

    if (
      cpuBusyPercent === null &&
      memoryUsedPercent === null &&
      typeof loadPerCorePercent !== 'number'
    ) {
      return
    }

    const signature = [
      metrics.Uptime ?? '',
      metrics['CPU Busy'] ?? '',
      metrics['CPU User'] ?? '',
      metrics['CPU System'] ?? '',
      metrics['Memory Used Percent'] ?? '',
      metrics.Memory ?? '',
      metrics['Load Per Core (1m)'] ?? '',
      metrics['Load Average (1m/5m/15m)'] ?? '',
    ].join('|')

    if (signature === previousSignatureRef.current) {
      return
    }

    previousSignatureRef.current = signature
    const point: TrendPoint = {
      at: new Date().toLocaleTimeString('en-GB', {
        hour12: false,
        minute: '2-digit',
        second: '2-digit',
      }),
      cpuBusy: cpuBusyPercent,
      memoryUsed: memoryUsedPercent,
      loadPerCore: typeof loadPerCorePercent === 'number' ? loadPerCorePercent : null,
    }

    setTrendPoints(current => [...current.slice(-(MAX_TREND_POINTS - 1)), point])
  }, [
    isLoaded,
    cpuBusyPercent,
    memoryUsedPercent,
    loadPerCorePercent,
    metrics.Uptime,
    metrics['CPU Busy'],
    metrics['CPU User'],
    metrics['CPU System'],
    metrics['Memory Used Percent'],
    metrics.Memory,
    metrics['Load Per Core (1m)'],
    metrics['Load Average (1m/5m/15m)'],
  ])

  const trendYAxisMax = (() => {
    const trendPeak = trendPoints.reduce((peak, point) => {
      const cpu = point.cpuBusy ?? 0
      const memory = point.memoryUsed ?? 0
      const load = point.loadPerCore ?? 0
      return Math.max(peak, cpu, memory, load)
    }, 0)
    const raw = Math.max(100, trendPeak)
    return Math.ceil(raw / 10) * 10
  })()
  const recentPoints = trendPoints.slice(-20)
  const latestPoint = trendPoints[trendPoints.length - 1]
  const cpuAvg = averageTrend(recentPoints, 'cpuBusy')
  const memoryAvg = averageTrend(recentPoints, 'memoryUsed')
  const loadAvg = averageTrend(recentPoints, 'loadPerCore')
  const cpuDelta = trendDelta(recentPoints, 'cpuBusy')
  const memoryDelta = trendDelta(recentPoints, 'memoryUsed')
  const loadDelta = trendDelta(recentPoints, 'loadPerCore')

  if (!isLoaded) {
    return (
      <div className="mt-3 px-1">
        <p className="m-0 text-[11px] text-muted-foreground">
          {isLive
            ? 'Loading system menu... tuning sensors for high-accuracy points.'
            : 'System menu is hidden until live metrics arrive.'}
        </p>
      </div>
    )
  }

  return (
    <section className="mt-3 rounded-sm border border-border/70 bg-card/65 p-3">
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="m-0 text-[12px] font-semibold text-foreground">System Menu</h3>
        <p className="m-0 text-[10.5px] text-muted-foreground">
          {isLive ? `Live every ${frequencySeconds}s` : 'Live paused'}
        </p>
      </div>

      <div className="mb-2 grid grid-cols-1 gap-2 md:grid-cols-3">
        <article className="rounded-sm border border-border/70 bg-background/55 p-2">
          <p className="m-0 text-[9.5px] text-muted-foreground">CPU Busy</p>
          <p className="m-0 mt-0.5 text-[12px] text-foreground">
            {formatMetricPercent(latestPoint ? latestPoint.cpuBusy : null)}
          </p>
          <p className="m-0 mt-0.5 text-[9px] text-muted-foreground">
            avg {formatMetricPercent(cpuAvg)} • Δ {formatDeltaPercent(cpuDelta)}
          </p>
        </article>
        <article className="rounded-sm border border-border/70 bg-background/55 p-2">
          <p className="m-0 text-[9.5px] text-muted-foreground">Memory Used</p>
          <p className="m-0 mt-0.5 text-[12px] text-foreground">
            {formatMetricPercent(latestPoint ? latestPoint.memoryUsed : null)}
          </p>
          <p className="m-0 mt-0.5 text-[9px] text-muted-foreground">
            avg {formatMetricPercent(memoryAvg)} • Δ {formatDeltaPercent(memoryDelta)}
          </p>
        </article>
        <article className="rounded-sm border border-border/70 bg-background/55 p-2">
          <p className="m-0 text-[9.5px] text-muted-foreground">Load/Core (1m)</p>
          <p className="m-0 mt-0.5 text-[12px] text-foreground">
            {formatMetricPercent(latestPoint ? latestPoint.loadPerCore : null)}
          </p>
          <p className="m-0 mt-0.5 text-[9px] text-muted-foreground">
            avg {formatMetricPercent(loadAvg)} • Δ {formatDeltaPercent(loadDelta)}
          </p>
        </article>
      </div>

      <div className="mb-2">
        <article className={CHART_CARD_CLASS}>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="m-0 text-[10px] font-medium text-muted-foreground">
              Realtime Trend (Points)
            </p>
            <p className="m-0 text-[10px] text-foreground">
              {trendPoints.length > 0
                ? `${trendPoints.length} points`
                : 'Waiting for first measurement'}
            </p>
          </div>
          <div className="h-37.5">
            <ResponsiveContainer height="100%" width="100%">
              <LineChart data={trendPoints} margin={{ top: 6, right: 10, bottom: 4, left: 8 }}>
                <CartesianGrid stroke={CHART_GRID} strokeDasharray="2 2" vertical={false} />
                <XAxis
                  axisLine={false}
                  dataKey="at"
                  interval="preserveStartEnd"
                  minTickGap={18}
                  tick={{ fill: CHART_AXIS, fontSize: 9 }}
                  tickLine={false}
                />
                <YAxis
                  axisLine={false}
                  domain={[0, trendYAxisMax]}
                  tick={{ fill: CHART_AXIS, fontSize: 9 }}
                  tickLine={false}
                  width={26}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: TOOLTIP_BG,
                    border: `1px solid ${TOOLTIP_BORDER}`,
                    borderRadius: 4,
                    fontSize: 10,
                    padding: '6px 8px',
                  }}
                  labelStyle={{ color: CHART_AXIS }}
                />
                <Legend
                  formatter={value => (
                    <span className="text-[9px] text-muted-foreground">{value}</span>
                  )}
                  iconSize={8}
                  verticalAlign="top"
                  wrapperStyle={{ paddingBottom: 4 }}
                />
                <Line
                  activeDot={false}
                  connectNulls={false}
                  dataKey="cpuBusy"
                  dot={false}
                  isAnimationActive={false}
                  name="CPU Busy"
                  stroke={CHART_STRONG}
                  strokeWidth={1.8}
                  type="monotone"
                />
                <Line
                  activeDot={false}
                  connectNulls={false}
                  dataKey="memoryUsed"
                  dot={false}
                  isAnimationActive={false}
                  name="Memory Used"
                  stroke={CHART_MEDIUM}
                  strokeDasharray="5 2"
                  strokeWidth={1.7}
                  type="monotone"
                />
                <Line
                  activeDot={false}
                  connectNulls={false}
                  dataKey="loadPerCore"
                  dot={false}
                  isAnimationActive={false}
                  name="Load/Core (1m)"
                  stroke={CHART_FIFTH}
                  strokeDasharray="2 2"
                  strokeWidth={1.4}
                  type="monotone"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </article>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {entries.map(entry => (
          <article className={METRIC_CARD_CLASS} key={entry.key}>
            <p className={METRIC_LABEL_CLASS}>{entry.key}</p>
            <p className={`${METRIC_VALUE_CLASS} truncate`}>{entry.value}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

export default SystemMenuPanel
