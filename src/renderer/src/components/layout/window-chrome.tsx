import { Minus, Moon, PanelBottom, PanelLeft, PanelRight, Square, Sun, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { getAccentTintOverlay } from './project-appearance-utils'

type WindowChromeProps = {
  leftCollapsed: boolean
  rightCollapsed: boolean
  terminalCollapsed: boolean
  isDarkMode: boolean
  activeAccentColor?: string
  onToggleLeft: () => void
  onToggleRight: () => void
  onToggleTerminal: () => void
  onToggleTheme: (checked: boolean) => void
}

export function WindowChrome({
  leftCollapsed,
  rightCollapsed,
  terminalCollapsed,
  isDarkMode,
  activeAccentColor,
  onToggleLeft,
  onToggleRight,
  onToggleTerminal,
  onToggleTheme
}: WindowChromeProps): React.JSX.Element {
  const [platform, setPlatform] = useState('darwin')
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!window.api) return
    void (async () => {
      const [platformResponse, maximizedResponse] = await Promise.all([
        window.api.app.platform(),
        window.api.app.windowIsMaximized()
      ])
      if (platformResponse.ok) {
        setPlatform(platformResponse.data)
      }
      if (maximizedResponse.ok) {
        setIsMaximized(maximizedResponse.data)
      }
    })()
  }, [])

  const handleToggleMaximize = async (): Promise<void> => {
    if (!window.api) return
    const response = await window.api.app.windowToggleMaximize()
    if (response.ok) {
      setIsMaximized(response.data)
    }
  }

  const tintOverlay = activeAccentColor ? getAccentTintOverlay(activeAccentColor, 0.17) : undefined

  return (
    <header
      className="chrome-drag flex h-10 items-center justify-between border-b border-border/80 bg-card/95 px-3"
      style={{ backgroundImage: tintOverlay }}
    >
      <div className="chrome-no-drag flex items-center gap-2">
        {platform === 'darwin' ? (
          <div className="flex items-center gap-2 pl-1">
            <button
              type="button"
              aria-label="Close window"
              className="h-3 w-3 rounded-full bg-[#ff5f57] transition-opacity hover:opacity-80"
              onClick={() => void window.api?.app.windowClose()}
            />
            <button
              type="button"
              aria-label="Minimize window"
              className="h-3 w-3 rounded-full bg-[#febc2e] transition-opacity hover:opacity-80"
              onClick={() => void window.api?.app.windowMinimize()}
            />
            <button
              type="button"
              aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
              className="h-3 w-3 rounded-full bg-[#28c840] transition-opacity hover:opacity-80"
              onClick={() => void handleToggleMaximize()}
            />
          </div>
        ) : (
          <div className="h-7 w-20" />
        )}
      </div>

      <div className="pointer-events-none text-sm font-semibold tracking-wide text-foreground/90">
        SoloAgent
      </div>

      <div className="chrome-no-drag flex items-center gap-1">
        <div className="flex items-center px-1 pt-0.5">
          <Switch
            aria-label="Toggle light and dark mode"
            checked={isDarkMode}
            onCheckedChange={onToggleTheme}
            className="relative overflow-hidden border border-border/70 bg-muted/70 data-[state=checked]:bg-muted/70 data-[state=unchecked]:bg-muted/70"
          >
            <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              {isDarkMode ? (
                <Moon className="h-2.5 w-2.5 text-sky-300" />
              ) : (
                <Sun className="h-2.5 w-2.5 text-amber-500" />
              )}
            </span>
          </Switch>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label={leftCollapsed ? 'Expand left sidebar' : 'Collapse left sidebar'}
          onClick={onToggleLeft}
        >
          <PanelLeft className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label={terminalCollapsed ? 'Expand terminal panel' : 'Collapse terminal panel'}
          onClick={onToggleTerminal}
        >
          <PanelBottom className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label={rightCollapsed ? 'Expand right sidebar' : 'Collapse right sidebar'}
          onClick={onToggleRight}
        >
          <PanelRight className="h-4 w-4" />
        </Button>

        {platform !== 'darwin' ? (
          <>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label="Minimize window"
              onClick={() => void window.api?.app.windowMinimize()}
            >
              <Minus className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
              onClick={() => void handleToggleMaximize()}
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 hover:bg-destructive/20"
              aria-label="Close window"
              onClick={() => void window.api?.app.windowClose()}
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        ) : null}
      </div>
    </header>
  )
}
