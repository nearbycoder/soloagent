import { TerminalView } from './TerminalView'
import type { TerminalSession } from '../../../../shared/ipc/types'

type TerminalSplitGridProps = {
  terminals: TerminalSession[]
  colorMode: 'light' | 'dark'
}

export function TerminalSplitGrid({
  terminals,
  colorMode
}: TerminalSplitGridProps): React.JSX.Element {
  const visible = terminals.slice(0, 4)
  const columns =
    visible.length <= 1 ? 'grid-cols-1' : visible.length <= 2 ? 'grid-cols-2' : 'grid-cols-2'

  if (visible.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
        Create terminals to open a split workspace.
      </div>
    )
  }

  return (
    <div className={`grid h-full min-h-0 gap-2 ${columns}`}>
      {visible.map((terminal) => (
        <div key={terminal.id} className="min-h-0">
          <TerminalView
            terminalId={terminal.id}
            colorMode={colorMode}
          />
        </div>
      ))}
    </div>
  )
}
