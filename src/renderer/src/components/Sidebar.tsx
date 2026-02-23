import type { CommandItem } from '@/data/commands'

type SidebarProps = {
  activeCommand: string
  commands: ReadonlyArray<CommandItem>
  onSelect: (item: CommandItem) => void
  statusLabel: string
  lastRunLabel: string
  platform: string
  runState: 'ready' | 'running' | 'success' | 'error'
  topTitleOffsetPx: number
}

function Sidebar({
  activeCommand,
  commands,
  onSelect,
  statusLabel,
  lastRunLabel,
  platform,
  runState,
  topTitleOffsetPx,
}: SidebarProps): React.JSX.Element {
  const sidebarTone = platform === 'darwin' ? 'bg-transparent' : 'bg-sidebar/75'
  const statusTone =
    runState === 'success'
      ? 'text-emerald-400'
      : runState === 'error'
        ? 'text-rose-400'
        : runState === 'running'
          ? 'text-amber-400'
          : 'text-blue-400'

  return (
    <aside
      className={`sticky top-0 flex h-screen min-h-0 flex-col overflow-y-auto border-r border-(--line) px-2 pb-3 [-webkit-app-region:drag] ${sidebarTone}`}
      style={{ paddingTop: topTitleOffsetPx }}
    >
      <div className="mb-4 px-2 [-webkit-app-region:drag]">
        <div className="flex h-7 items-center">
          <h1 className="m-0 text-[16px] leading-5.5 font-semibold text-(--text) [-webkit-app-region:no-drag]">
            Command Panel
          </h1>
        </div>
        <p className="mt-0.5 mb-0 text-[10.5px] leading-3.5 text-(--text-dim) [-webkit-app-region:no-drag]">
          System-level developer tools
        </p>
      </div>

      <p className="px-2 pt-2 pb-1 text-[10px] font-semibold text-(--text-dim) [-webkit-app-region:drag]">
        Commands
      </p>

      <nav className="flex min-h-0 flex-1 flex-col gap-px overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [-webkit-app-region:no-drag]">
        {commands.map(item => {
          const isActive = activeCommand === item.command
          const rowClass = isActive
            ? `relative flex h-7 items-center rounded-sm border-0 bg-(--row-active) px-2 text-left text-[11.5px] leading-4.5 font-medium text-(--text) [-webkit-app-region:no-drag]
              before:absolute before:left-0 before:top-1/2 before:h-3.5 before:w-0.5 before:-translate-y-1/2 before:rounded-sm before:bg-(--active-indicator) before:content-['']`
            : 'relative flex h-7 items-center rounded-sm border-0 bg-transparent px-2 text-left text-[11.5px] leading-4.5 text-(--text-muted) [-webkit-app-region:no-drag]'

          return (
            <button
              className={`${rowClass} appearance-none shadow-none`}
              key={item.command}
              onClick={() => onSelect(item)}
              type="button"
            >
              {item.title}
            </button>
          )
        })}
      </nav>

      <footer className="pt-2 [-webkit-app-region:drag]">
        <p className="m-0 text-[10px] leading-3.5 text-(--text-dim)">Status</p>
        <p className={`mt-0.5 mb-1.5 text-[11px] leading-4 ${statusTone}`}>{statusLabel}</p>
        <p className="m-0 text-[10px] leading-3.5 text-(--text-dim)">Last run</p>
        <p className="mt-0.5 mb-1.5 text-[11px] leading-4 text-(--text-muted)">{lastRunLabel}</p>
        <p className="m-0 text-[10px] leading-3.5 text-(--text-dim)">
          {`${commands.length} commands loaded`}
        </p>
      </footer>
    </aside>
  )
}

export default Sidebar
