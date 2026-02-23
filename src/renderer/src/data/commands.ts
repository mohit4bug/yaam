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

export type CommandItem = {
  title: string
  command: ActivityCommandName
  description: string
  placeholder: string
}

export const COMMANDS: ReadonlyArray<CommandItem> = [
  {
    title: 'System',
    command: 'check-health',
    description: 'Live system overview of host, memory, uptime, and load',
    placeholder: '',
  },
  {
    title: 'Ports',
    command: 'scan-ports',
    description: 'Live listening port view (optional single-port filter)',
    placeholder: '3000 (optional)',
  },
  {
    title: 'Process',
    command: 'inspect-process',
    description: 'Live process details for a specific PID',
    placeholder: '4123',
  },
  {
    title: 'CPU Watch',
    command: 'watch-cpu',
    description: 'Live CPU and memory watch for a target process',
    placeholder: '4123',
  },
  {
    title: 'TCP Probe',
    command: 'test-tcp',
    description: 'Live TCP connectivity probe for host:port',
    placeholder: 'localhost:5432',
  },
]

export const timestamp = (): string =>
  new Date().toLocaleTimeString('en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
