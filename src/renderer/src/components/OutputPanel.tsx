import { useEffect, useRef } from 'react'

export type OutputRow = {
  id: string
  at: string
  source: 'stdout' | 'stderr' | 'system'
  level: 'info' | 'error' | 'success'
  message: string
}

type OutputPanelProps = {
  rows: ReadonlyArray<OutputRow>
  hasStartedActivity: boolean
  emptyTitle: string
  emptyDescription: string
}

const sourceTone: Record<OutputRow['source'], string> = {
  stdout: 'text-primary',
  stderr: 'text-destructive',
  system: 'text-muted-foreground',
}

const levelToneForRow = (row: OutputRow): string => {
  if (row.level === 'error' || row.source === 'stderr') {
    return 'text-rose-400'
  }

  const warningPattern = /\bwarn(?:ing)?\b/iu

  if (warningPattern.test(row.message)) {
    return 'text-amber-400'
  }

  if (row.level === 'success') {
    return 'text-emerald-400'
  }

  return 'text-sky-400'
}

function OutputPanel({
  rows,
  hasStartedActivity,
  emptyTitle,
  emptyDescription,
}: OutputPanelProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!scrollRef.current) {
      return
    }

    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  })

  if (!hasStartedActivity) {
    return (
      <div className="mt-3 flex min-h-0 flex-1 items-center justify-center">
        <div className="flex max-w-sm flex-col items-center gap-2 px-6 py-5 text-center">
          <div className="h-6 w-6 rounded-sm border border-border/70 bg-muted/30" />
          <p className="m-0 text-sm font-medium text-foreground">{emptyTitle}</p>
          <p className="m-0 text-[11px] leading-4.5 text-muted-foreground">{emptyDescription}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-3 flex min-h-0 flex-none">
      <div className="h-[clamp(260px,52vh,440px)] w-full overflow-hidden rounded-sm border border-border/70 bg-card/70 text-card-foreground">
        <div className="h-full overflow-y-auto overflow-x-hidden" ref={scrollRef}>
          <table className="w-full table-fixed border-collapse">
            <thead className="sticky top-0 z-10 bg-background/85 backdrop-blur-md">
              <tr className="text-left text-[10.5px] text-muted-foreground">
                <th className="w-24 px-2.5 py-1.5 font-semibold">Time</th>
                <th className="w-20 px-2.5 py-1.5 font-semibold">Source</th>
                <th className="w-20 px-2.5 py-1.5 font-semibold">Level</th>
                <th className="px-2.5 py-1.5 font-semibold">Message</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="px-2.5 py-3 text-[11px] text-muted-foreground" colSpan={4}>
                    Waiting for the first live activity tick...
                  </td>
                </tr>
              ) : null}

              {rows.map(row => (
                <tr className="text-[11px]" key={row.id}>
                  <td className="px-2.5 py-1.5 text-muted-foreground">{row.at}</td>
                  <td className={`px-2.5 py-1.5 ${sourceTone[row.source]}`}>{row.source}</td>
                  <td className={`px-2.5 py-1.5 ${levelToneForRow(row)}`}>{row.level}</td>
                  <td className="px-2.5 py-1.5 leading-4.5 text-foreground">{row.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default OutputPanel
