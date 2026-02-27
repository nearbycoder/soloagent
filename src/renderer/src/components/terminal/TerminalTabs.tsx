import { Columns2, Plus, X } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { TerminalView } from './TerminalView'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import type { TerminalSession } from '../../../../shared/ipc/types'

type TerminalTabsProps = {
  terminals: TerminalSession[]
  activeTerminalId?: string
  colorMode: 'light' | 'dark'
  onActiveTerminalChange: (terminalId: string) => void
  onCreateTab: () => Promise<TerminalSession | undefined>
  onCreateSplit: (parentTerminalId: string) => Promise<TerminalSession | undefined>
  onCloseTerminal: (terminalId: string) => void
  onRenameTerminal: (terminalId: string, title: string) => void
}

export const TerminalTabs = memo(function TerminalTabs({
  terminals,
  activeTerminalId,
  colorMode,
  onActiveTerminalChange,
  onCreateTab,
  onCreateSplit,
  onCloseTerminal,
  onRenameTerminal
}: TerminalTabsProps): React.JSX.Element {
  const [editingTerminalId, setEditingTerminalId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null)
  const previousPaneOrderRef = useRef<string[]>([])
  const previousRootTerminalIdRef = useRef<string | null>(null)

  const rootTerminals = useMemo(
    () => terminals.filter((terminal) => !terminal.parentTerminalId),
    [terminals]
  )
  const splitChildrenByParent = useMemo(() => {
    const grouped: Record<string, TerminalSession[]> = {}
    for (const terminal of terminals) {
      if (!terminal.parentTerminalId) continue
      grouped[terminal.parentTerminalId] = [...(grouped[terminal.parentTerminalId] || []), terminal]
    }
    for (const value of Object.values(grouped)) {
      value.sort((a, b) => a.createdAt - b.createdAt)
    }
    return grouped
  }, [terminals])

  const fallbackTerminal = rootTerminals[0]
  const currentTerminalId = activeTerminalId || fallbackTerminal?.id
  const activePaneOrder = useMemo(() => {
    if (!currentTerminalId) {
      return []
    }

    const rootTerminal =
      rootTerminals.find((terminal) => terminal.id === currentTerminalId) || rootTerminals[0]
    if (!rootTerminal) {
      return []
    }

    const splitChildren = splitChildrenByParent[rootTerminal.id] || []
    return [rootTerminal.id, ...splitChildren.map((terminal) => terminal.id)]
  }, [currentTerminalId, rootTerminals, splitChildrenByParent])

  useEffect(() => {
    if (!currentTerminalId || activePaneOrder.length === 0) {
      previousPaneOrderRef.current = activePaneOrder
      previousRootTerminalIdRef.current = currentTerminalId || null
      return
    }

    const previousPaneOrder = previousPaneOrderRef.current
    const previousRootTerminalId = previousRootTerminalIdRef.current
    const switchedRootTerminal =
      previousRootTerminalId !== null && previousRootTerminalId !== currentTerminalId

    setFocusedPaneId((previousFocusedPaneId) => {
      if (switchedRootTerminal) {
        return currentTerminalId
      }

      if (previousFocusedPaneId && activePaneOrder.includes(previousFocusedPaneId)) {
        return previousFocusedPaneId
      }

      if (previousFocusedPaneId) {
        const removedIndex = previousPaneOrder.indexOf(previousFocusedPaneId)
        if (removedIndex >= 0) {
          for (let index = removedIndex - 1; index >= 0; index -= 1) {
            const candidate = previousPaneOrder[index]
            if (activePaneOrder.includes(candidate)) {
              return candidate
            }
          }

          for (let index = removedIndex + 1; index < previousPaneOrder.length; index += 1) {
            const candidate = previousPaneOrder[index]
            if (activePaneOrder.includes(candidate)) {
              return candidate
            }
          }
        }
      }

      return currentTerminalId
    })

    previousPaneOrderRef.current = activePaneOrder
    previousRootTerminalIdRef.current = currentTerminalId
  }, [activePaneOrder, currentTerminalId])

  if (!fallbackTerminal || !currentTerminalId) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-1">
        <div
          role="tablist"
          aria-label="Terminal tabs"
          className="terminal-tabs-scrollbar inline-flex h-8 items-center justify-start rounded-md bg-muted p-0.5 text-muted-foreground"
        >
          <button
            type="button"
            aria-label="New terminal tab"
            className="relative z-20 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void onCreateTab()
            }}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          Create a terminal to begin.
        </div>
      </div>
    )
  }

  const currentTerminal =
    rootTerminals.find((terminal) => terminal.id === currentTerminalId) || fallbackTerminal

  const commitRename = (terminalId: string): void => {
    const normalized = draftTitle.trim()
    if (normalized) {
      onRenameTerminal(terminalId, normalized)
    }
    setEditingTerminalId(null)
    setDraftTitle('')
  }

  return (
    <Tabs
      value={currentTerminalId}
      onValueChange={onActiveTerminalChange}
      className="flex h-full min-h-0 flex-col gap-1"
    >
      <TabsList
        aria-label="Terminal tabs"
        className="terminal-tabs-scrollbar h-8 justify-start p-0.5"
      >
        {rootTerminals.map((terminal) => (
          <div key={terminal.id} className="group relative">
            {editingTerminalId === terminal.id ? (
              <input
                autoFocus
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                onBlur={() => commitRename(terminal.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitRename(terminal.id)
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setEditingTerminalId(null)
                    setDraftTitle('')
                  }
                }}
                className="h-7 w-28 rounded-sm border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Rename ${terminal.title}`}
              />
            ) : (
              <TabsTrigger
                value={terminal.id}
                className="h-7 px-2.5 py-1 text-xs pr-[46px]"
                onDoubleClick={() => {
                  setEditingTerminalId(terminal.id)
                  setDraftTitle(terminal.title)
                }}
              >
                {terminal.title}
              </TabsTrigger>
            )}
            <div className="pointer-events-none absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
              <button
                type="button"
                aria-label={`Split ${terminal.title}`}
                className="h-5 w-5 rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation()
                  void onCreateSplit(terminal.id)
                }}
                disabled={(splitChildrenByParent[terminal.id]?.length || 0) >= 3}
              >
                <Columns2 className="mx-auto h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Close ${terminal.title}`}
                className="h-5 w-5 rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onCloseTerminal(terminal.id)}
              >
                <X className="mx-auto h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          aria-label="New terminal tab"
          className="relative z-20 ml-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void onCreateTab()
          }}
        >
          <Plus className="h-4 w-4" />
        </button>
      </TabsList>

      {rootTerminals.map((rootTerminal) => {
        const splitChildren = splitChildrenByParent[rootTerminal.id] || []
        const paneTerminals = [rootTerminal, ...splitChildren]
        const isActiveRoot = rootTerminal.id === currentTerminal.id
        const fallbackFocusedPaneId = paneTerminals[0]?.id
        const effectiveFocusedPaneId =
          isActiveRoot && paneTerminals.some((pane) => pane.id === focusedPaneId)
            ? focusedPaneId
            : isActiveRoot
              ? fallbackFocusedPaneId
              : undefined

        return (
          <TabsContent
            key={rootTerminal.id}
            value={rootTerminal.id}
            className="mt-1 min-h-0 flex-1 overflow-hidden"
          >
            <div
              className={`grid h-full min-h-0 gap-1 ${
                paneTerminals.length <= 1
                  ? 'grid-cols-1'
                  : paneTerminals.length === 2
                    ? 'grid-cols-2'
                    : 'grid-cols-2 grid-rows-2'
              }`}
            >
              {paneTerminals.map((pane) => (
                <div key={pane.id} className="relative min-h-0">
                  {pane.parentTerminalId ? (
                    <button
                      type="button"
                      aria-label={`Close split ${pane.title}`}
                      className="chrome-no-drag absolute right-2 top-2 z-20 rounded-sm bg-background/80 p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onCloseTerminal(pane.id)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  <TerminalView
                    terminalId={pane.id}
                    colorMode={colorMode}
                    isVisible={isActiveRoot}
                    isFocused={effectiveFocusedPaneId === pane.id}
                    onFocusRequest={() => setFocusedPaneId(pane.id)}
                  />
                </div>
              ))}
            </div>
          </TabsContent>
        )
      })}
    </Tabs>
  )
})

TerminalTabs.displayName = 'TerminalTabs'
