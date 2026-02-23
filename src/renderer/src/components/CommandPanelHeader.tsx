import type { CommandItem } from '@/data/commands'

type CommandPanelHeaderProps = {
  command: CommandItem
  input: string
  showInput: boolean
  onToggleLive: () => void
  onInputChange: (value: string) => void
  onCopyOutput: () => void
  onSaveOutput: () => void
  onClearOutput: () => void
  onResetTab: () => void
  isLive: boolean
  hasOutput: boolean
  canClear: boolean
  canReset: boolean
  placeholder: string
}

function CommandPanelHeader({
  command,
  input,
  showInput,
  onToggleLive,
  onInputChange,
  onCopyOutput,
  onSaveOutput,
  onClearOutput,
  onResetTab,
  isLive,
  hasOutput,
  canClear,
  canReset,
  placeholder,
}: CommandPanelHeaderProps): React.JSX.Element {
  const actionButtonClass =
    'inline-flex h-6 shrink-0 select-none items-center justify-center whitespace-nowrap appearance-none rounded-sm border border-border bg-background px-2 text-[11px] text-foreground shadow-none disabled:pointer-events-none disabled:opacity-50'
  const liveButtonClass =
    'inline-flex h-6 shrink-0 select-none items-center justify-center whitespace-nowrap appearance-none rounded-sm border border-transparent bg-primary px-2.5 text-[11px] font-medium text-primary-foreground shadow-none disabled:pointer-events-none disabled:opacity-50'

  return (
    <header className="flex-none">
      <div className="flex h-6 items-center justify-between">
        <h2 className="m-0 text-[16px] leading-5.5 font-semibold text-(--text) [-webkit-app-region:no-drag]">
          {command.title}
        </h2>
        <div className="flex items-center gap-1.5 [-webkit-app-region:no-drag]">
          <button
            className={actionButtonClass}
            disabled={!hasOutput}
            onClick={onCopyOutput}
            title="Copy output"
            type="button"
          >
            Copy
          </button>
          <button
            className={actionButtonClass}
            disabled={!hasOutput}
            onClick={onSaveOutput}
            title="Save output"
            type="button"
          >
            Save
          </button>
          <button
            className={actionButtonClass}
            disabled={!canClear}
            onClick={onClearOutput}
            title="Clear output"
            type="button"
          >
            Clear
          </button>
          <button
            className={actionButtonClass}
            disabled={!canReset}
            onClick={onResetTab}
            title="Reset tab"
            type="button"
          >
            Reset
          </button>
          <button className={liveButtonClass} onClick={onToggleLive} type="button">
            {isLive ? 'Stop Live' : 'Start Live'}
          </button>
        </div>
      </div>

      <p className="mt-1.5 mb-0 text-[11px] leading-4 text-(--text-dim) [-webkit-app-region:no-drag]">
        {command.description}
      </p>

      {showInput ? (
        <div className="mt-2.5 [-webkit-app-region:no-drag]">
          <input
            className="h-6 w-70 max-w-full min-w-0 appearance-none rounded-sm border border-input bg-transparent px-2 py-1 text-[11px] text-foreground shadow-none placeholder:text-(--text-dim) disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 dark:bg-input/30 dark:disabled:bg-input/80"
            onChange={event => onInputChange(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter') {
                return
              }

              event.preventDefault()
              onToggleLive()
            }}
            placeholder={placeholder || command.placeholder}
            value={input}
          />
        </div>
      ) : null}
    </header>
  )
}

export default CommandPanelHeader
