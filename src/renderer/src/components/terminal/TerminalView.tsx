import { useEffect, useRef, useState } from 'react'
import { useOrchestratorStore } from '@renderer/stores/orchestrator-store'
import { FitAddon, Ghostty, Terminal, init, type ITheme } from 'ghostty-web'
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url'

type TerminalViewProps = {
  terminalId: string
  colorMode: 'light' | 'dark'
  isFocused?: boolean
  isVisible?: boolean
  onFocusRequest?: () => void
}

const MAX_REPLAY_CHARS = 80_000
const MAX_WRITE_CHUNK_CHARS = 4096
const TERMINAL_FONT_SIZE = 13
const TERMINAL_SCROLLBACK = 4000
const TOUCH_SCROLL_PIXELS_PER_LINE = 18
const OVERLAP_PROBE_CHARS = 512
const MIN_OVERLAP_TRUST_CHARS = 64

type GhosttyBootstrap = {
  ghostty?: Ghostty
}

let ghosttyBootstrapPromise: Promise<GhosttyBootstrap> | null = null

function ensureGhosttyInit(): Promise<GhosttyBootstrap> {
  if (!ghosttyBootstrapPromise) {
    ghosttyBootstrapPromise = Ghostty.load(ghosttyWasmUrl)
      .then((ghostty) => ({ ghostty }))
      .catch(async (error) => {
        console.warn('Ghostty.load(url) failed, falling back to init()', error)
        await init()
        return {}
      })
      .catch((error) => {
        ghosttyBootstrapPromise = null
        throw error
      })
  }
  return ghosttyBootstrapPromise
}

void ensureGhosttyInit().catch(() => {
  // Keep first terminal open responsive by warming WASM in the background.
})

function stripInitialShellPadding(data: string): string {
  // Some zsh prompts emit startup padding (spaces + CR) before first prompt paint.
  // Keep this scoped to the beginning so normal command output is unaffected.
  return data.replace(/^[ \t]{16,}\r+/, '')
}

function writeToTerminal(term: Terminal, data: string): void {
  if (!data) return

  try {
    if (data.length <= MAX_WRITE_CHUNK_CHARS) {
      term.write(data)
      return
    }

    for (let i = 0; i < data.length; i += MAX_WRITE_CHUNK_CHARS) {
      term.write(data.slice(i, i + MAX_WRITE_CHUNK_CHARS))
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    if (message.includes('disposed') || message.includes('must be opened')) {
      return
    }
    console.error('Failed to write terminal output chunk', error)
  }
}

function findSuffixPrefixOverlap(previous: string, next: string): number {
  if (!previous || !next) {
    return 0
  }

  const maxOverlap = Math.min(previous.length, next.length)
  const probeLength = Math.min(OVERLAP_PROBE_CHARS, maxOverlap)
  if (probeLength <= 0) {
    return 0
  }

  const probe = next.slice(0, probeLength)
  let searchFrom = previous.length - probeLength

  while (searchFrom >= 0) {
    const idx = previous.lastIndexOf(probe, searchFrom)
    if (idx === -1) {
      break
    }

    const overlap = previous.length - idx
    if (overlap <= next.length && next.startsWith(previous.slice(idx))) {
      return overlap
    }

    searchFrom = idx - 1
  }

  return 0
}

function normalizeReplayOutput(data: string): string {
  if (!data) {
    return data
  }

  let replay = data.length > MAX_REPLAY_CHARS ? data.slice(-MAX_REPLAY_CHARS) : data
  if (data.length > MAX_REPLAY_CHARS) {
    const firstNewline = replay.indexOf('\n')
    if (firstNewline >= 0) {
      replay = replay.slice(firstNewline + 1)
    }
  }

  replay = replay.replace(/^(?:\[[0-9;?]*[ -/]*[@-~])+/, '')
  replay = replay.replace(/^(?:\d{3,4}[hl])+/, '')
  return stripInitialShellPadding(replay)
}

const terminalThemes: Record<'light' | 'dark', ITheme> = {
  light: {
    background: '#ffffff',
    foreground: '#111827',
    cursor: '#111827',
    cursorAccent: '#ffffff',
    selectionBackground: '#dbeafe',
    selectionForeground: '#111827',
    black: '#1f2937',
    red: '#dc2626',
    green: '#059669',
    yellow: '#d97706',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: '#e5e7eb',
    brightBlack: '#4b5563',
    brightRed: '#ef4444',
    brightGreen: '#10b981',
    brightYellow: '#f59e0b',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: '#f9fafb'
  },
  dark: {
    background: '#000000',
    foreground: '#e5e7eb',
    cursor: '#f3f4f6',
    cursorAccent: '#111827',
    selectionBackground: '#374151',
    selectionForeground: '#e5e7eb',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#ffffff'
  }
}

export function TerminalView({
  terminalId,
  colorMode,
  isFocused = true,
  isVisible = true,
  onFocusRequest
}: TerminalViewProps): React.JSX.Element {
  const output = useOrchestratorStore((state) => state.terminalOutput[terminalId] || '')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const touchLastYRef = useRef<number | null>(null)
  const touchLineRemainderRef = useRef(0)
  const [initError, setInitError] = useState<string | null>(null)
  const latestOutputRef = useRef(output)
  const renderedOutputRef = useRef('')

  useEffect(() => {
    latestOutputRef.current = output
  }, [output])

  useEffect(() => {
    if (!containerRef.current) return
    let disposed = false
    let term: Terminal | undefined
    let fitAddon: FitAddon | undefined
    let rafId: number | undefined
    let terminalElement: HTMLDivElement | null = null
    let handleTouchStart: ((event: TouchEvent) => void) | undefined
    let handleTouchMove: ((event: TouchEvent) => void) | undefined
    let handleTouchEnd: (() => void) | undefined

    const setupTerminal = async (): Promise<void> => {
      let ghosttyBootstrap: GhosttyBootstrap
      try {
        ghosttyBootstrap = await ensureGhosttyInit()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown initialization error'
        setInitError(message)
        console.error('Ghostty initialization failed', error)
        return
      }
      if (disposed || !containerRef.current) return

      term = new Terminal({
        ...(ghosttyBootstrap.ghostty ? { ghostty: ghosttyBootstrap.ghostty } : {}),
        cursorBlink: isFocused,
        fontSize: TERMINAL_FONT_SIZE,
        scrollback: TERMINAL_SCROLLBACK,
        theme: terminalThemes[colorMode]
      })
      fitAddon = new FitAddon()
      fitAddonRef.current = fitAddon
      term.loadAddon(fitAddon)
      term.onData((data) => {
        void window.api.terminal.write({ terminalId, data })
      })
      term.onResize(({ cols, rows }) => {
        void window.api.terminal.resize({ terminalId, cols, rows })
      })

      term.open(containerRef.current)
      const termInstance = term
      terminalElement = containerRef.current

      const sendInputToPty = (data: string): void => {
        if (!data) return
        void window.api.terminal.write({ terminalId, data })
      }

      handleTouchStart = (event: TouchEvent): void => {
        if (!event.touches.length) {
          return
        }
        onFocusRequest?.()
        touchLastYRef.current = event.touches[0].clientY
        touchLineRemainderRef.current = 0
      }

      handleTouchMove = (event: TouchEvent): void => {
        if (event.touches.length !== 1 || !term) {
          return
        }

        const y = event.touches[0].clientY
        const lastY = touchLastYRef.current
        touchLastYRef.current = y

        if (lastY === null) {
          return
        }

        const deltaY = y - lastY
        if (Math.abs(deltaY) < 1) {
          return
        }

        const lineDeltaFloat = -deltaY / TOUCH_SCROLL_PIXELS_PER_LINE
        touchLineRemainderRef.current += lineDeltaFloat
        const wholeLineDelta =
          touchLineRemainderRef.current > 0
            ? Math.floor(touchLineRemainderRef.current)
            : Math.ceil(touchLineRemainderRef.current)

        if (wholeLineDelta !== 0) {
          touchLineRemainderRef.current -= wholeLineDelta
          const inAlternateScreen =
            term.getMode(1049) || term.getMode(1047) || term.getMode(47) || false

          if (inAlternateScreen) {
            const stepCount = Math.min(5, Math.max(1, Math.abs(wholeLineDelta)))
            const sequence = wholeLineDelta > 0 ? '\u001b[B' : '\u001b[A'
            sendInputToPty(sequence.repeat(stepCount))
          } else if (term.getScrollbackLength() > 0) {
            term.scrollLines(wholeLineDelta)
          }
        }

        event.preventDefault()
      }

      handleTouchEnd = (): void => {
        touchLastYRef.current = null
        touchLineRemainderRef.current = 0
      }

      terminalElement.addEventListener('touchstart', handleTouchStart, { passive: true })
      terminalElement.addEventListener('touchmove', handleTouchMove, { passive: false })
      terminalElement.addEventListener('touchend', handleTouchEnd, { passive: true })
      terminalElement.addEventListener('touchcancel', handleTouchEnd, { passive: true })

      fitAddon.fit()
      fitAddon.observeResize()
      // A second fit on next frame catches layout changes after tab switches.
      rafId = window.requestAnimationFrame(() => {
        if (!disposed) {
          fitAddon?.fit()
        }
      })
      terminalRef.current = term
      if (isFocused) {
        term.focus()
      } else {
        term.blur()
      }
      setInitError(null)

      const bufferedOutput = latestOutputRef.current
      if (bufferedOutput.length > 0) {
        writeToTerminal(termInstance, normalizeReplayOutput(bufferedOutput))
      }
      renderedOutputRef.current = bufferedOutput
    }

    void setupTerminal()

    return () => {
      disposed = true
      if (terminalElement && handleTouchStart) {
        terminalElement.removeEventListener('touchstart', handleTouchStart)
      }
      if (terminalElement && handleTouchMove) {
        terminalElement.removeEventListener('touchmove', handleTouchMove)
      }
      if (terminalElement && handleTouchEnd) {
        terminalElement.removeEventListener('touchend', handleTouchEnd)
        terminalElement.removeEventListener('touchcancel', handleTouchEnd)
      }
      if (rafId !== undefined) {
        window.cancelAnimationFrame(rafId)
      }
      fitAddon?.dispose()
      term?.dispose()
      fitAddonRef.current = null
      terminalRef.current = null
      renderedOutputRef.current = ''
      touchLastYRef.current = null
      touchLineRemainderRef.current = 0
    }
  }, [terminalId, colorMode])

  useEffect(() => {
    const term = terminalRef.current
    if (!term) return
    const previousOutput = renderedOutputRef.current
    if (output === previousOutput) {
      return
    }

    if (!previousOutput) {
      writeToTerminal(term, normalizeReplayOutput(output))
      renderedOutputRef.current = output
      return
    }

    if (output.startsWith(previousOutput)) {
      const nextChunk = output.slice(previousOutput.length)
      writeToTerminal(term, nextChunk)
      renderedOutputRef.current = output
      return
    }

    const overlap = findSuffixPrefixOverlap(previousOutput, output)
    if (overlap >= MIN_OVERLAP_TRUST_CHARS) {
      const nextChunk = output.slice(overlap)
      writeToTerminal(term, nextChunk)
      renderedOutputRef.current = output
      return
    }

    // Source buffer can be trimmed/rebased. If overlap is too weak to trust,
    // do not rewrite/reset to avoid injecting partial control sequences.
    renderedOutputRef.current = output
  }, [output, terminalId])

  useEffect(() => {
    const term = terminalRef.current
    if (!term) return
    term.options.cursorBlink = isFocused
    if (isFocused) {
      term.focus()
    } else {
      term.blur()
    }
  }, [isFocused])

  useEffect(() => {
    if (!isVisible) {
      return
    }

    const fitAddon = fitAddonRef.current
    if (!fitAddon) {
      return
    }

    const rafId = window.requestAnimationFrame(() => {
      fitAddon.fit()
    })
    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [isVisible])

  return (
    <div
      role="application"
      aria-label={`Terminal ${terminalId}`}
      aria-live="polite"
      className="relative h-full w-full overflow-hidden rounded-lg border border-border/70 bg-card shadow-sm"
      tabIndex={0}
      onMouseDown={() => onFocusRequest?.()}
      onFocusCapture={() => onFocusRequest?.()}
    >
      <div
        className={`absolute inset-[1px] overflow-hidden rounded-[7px] ${
          colorMode === 'dark' ? 'bg-black' : 'bg-white'
        }`}
      >
        <div className="h-full w-full overflow-hidden rounded-[7px] p-2">
          <div
            ref={containerRef}
            className="h-full w-full overflow-hidden rounded-[6px] caret-transparent"
            style={{ caretColor: 'transparent', touchAction: 'none' }}
          />
        </div>
        {initError ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-4 text-center text-xs text-red-200">
            Terminal failed to initialize: {initError}
          </div>
        ) : null}
      </div>
    </div>
  )
}
