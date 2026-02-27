import { create } from 'zustand'
import type {
  AgentEvent,
  AgentRecord,
  TerminalEvent,
  TerminalSession
} from '../../../shared/ipc/types'

const HOME_PROJECT_SCOPE = '__home__'
const MAX_TERMINAL_BUFFER_CHARS = 250_000
const SESSION_STORAGE_KEY = 'soloagent.orchestrator.session'
const MAX_PERSISTED_BUFFER_CHARS = 60_000
const PERSIST_DEBOUNCE_MS = 400

function toScopeKey(projectId?: string): string {
  return projectId || HOME_PROJECT_SCOPE
}

type PersistedStoreSlice = {
  terminalOutputByScope: Record<string, Record<string, string>>
  terminalScopeById: Record<string, string>
  activeTerminalByScope: Record<string, string | undefined>
}

function readPersistedSlice(): PersistedStoreSlice | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedStoreSlice
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function writePersistedSlice(state: StoreState): void {
  if (typeof window === 'undefined') return
  try {
    const trimmedByScope: Record<string, Record<string, string>> = {}
    for (const [scope, outputs] of Object.entries(state.terminalOutputByScope)) {
      trimmedByScope[scope] = {}
      for (const [terminalId, buffer] of Object.entries(outputs)) {
        trimmedByScope[scope][terminalId] = buffer.slice(-MAX_PERSISTED_BUFFER_CHARS)
      }
    }
    const payload: PersistedStoreSlice = {
      terminalOutputByScope: trimmedByScope,
      terminalScopeById: state.terminalScopeById,
      activeTerminalByScope: state.activeTerminalByScope
    }
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Ignore storage errors (quota, privacy mode, etc.)
  }
}

function trimTerminalBuffer(buffer: string): string {
  if (buffer.length <= MAX_TERMINAL_BUFFER_CHARS) {
    return buffer
  }

  let trimmed = buffer.slice(-MAX_TERMINAL_BUFFER_CHARS)
  const firstNewline = trimmed.indexOf('\n')
  if (firstNewline >= 0) {
    // Drop potentially partial first line to avoid broken ANSI/control fragments at buffer boundary.
    trimmed = trimmed.slice(firstNewline + 1)
  }

  // Remove common CSI remnants that can appear if an escape sequence was cut at the boundary.
  trimmed = trimmed.replace(/^(?:\[[0-9;?]*[ -/]*[@-~])+/, '')
  trimmed = trimmed.replace(/^(?:\d{3,4}[hl])+/, '')
  return trimmed
}

type StoreState = {
  projectScopeId?: string
  terminals: TerminalSession[]
  terminalOutput: Record<string, string>
  terminalOutputByScope: Record<string, Record<string, string>>
  terminalScopeById: Record<string, string>
  agents: AgentRecord[]
  activeTerminalId?: string
  activeTerminalByScope: Record<string, string | undefined>
  activeWorkspaceId: 'single' | 'split'
  setProjectScope: (projectId?: string) => void
  setTerminals: (terminals: TerminalSession[]) => void
  upsertTerminal: (terminal: TerminalSession) => void
  pushTerminalEvent: (event: TerminalEvent) => void
  setAgents: (agents: AgentRecord[]) => void
  applyAgentEvent: (event: AgentEvent) => void
  setActiveTerminal: (terminalId?: string) => void
  setWorkspace: (workspace: 'single' | 'split') => void
}

export const useOrchestratorStore = create<StoreState>((set) => ({
  projectScopeId: undefined,
  terminals: [],
  terminalOutput: {},
  terminalOutputByScope: {},
  terminalScopeById: {},
  agents: [],
  activeTerminalByScope: {},
  activeWorkspaceId: 'single',
  setProjectScope: (projectId) =>
    set((state) => {
      const scopeKey = toScopeKey(projectId)
      return {
        projectScopeId: projectId,
        terminals: [],
        agents: [],
        activeTerminalId: state.activeTerminalByScope[scopeKey],
        terminalOutput: state.terminalOutputByScope[scopeKey] || {}
      }
    }),
  setTerminals: (terminals) =>
    set((state) => {
      const scopeKey = toScopeKey(state.projectScopeId)
      const nextTerminalIds = new Set(terminals.map((terminal) => terminal.id))
      const mappedScopes = { ...state.terminalScopeById }
      for (const [terminalId, mappedScope] of Object.entries(mappedScopes)) {
        if (mappedScope === scopeKey && !nextTerminalIds.has(terminalId)) {
          delete mappedScopes[terminalId]
        }
      }
      for (const terminal of terminals) {
        mappedScopes[terminal.id] = scopeKey
      }

      const scopedOutput = state.terminalOutputByScope[scopeKey] || {}
      const prunedScopedOutput: Record<string, string> = {}
      for (const [terminalId, buffer] of Object.entries(scopedOutput)) {
        if (nextTerminalIds.has(terminalId)) {
          prunedScopedOutput[terminalId] = buffer
        }
      }

      const nextActiveTerminalId =
        state.activeTerminalId && terminals.some((t) => t.id === state.activeTerminalId)
          ? state.activeTerminalId
          : terminals[0]?.id

      return {
        terminals,
        terminalScopeById: mappedScopes,
        terminalOutputByScope: {
          ...state.terminalOutputByScope,
          [scopeKey]: prunedScopedOutput
        },
        activeTerminalId: nextActiveTerminalId,
        activeTerminalByScope: {
          ...state.activeTerminalByScope,
          [scopeKey]: nextActiveTerminalId
        },
        terminalOutput: prunedScopedOutput
      }
    }),
  upsertTerminal: (terminal) =>
    set((state) => {
      const scopeKey = toScopeKey(terminal.projectId)
      const currentScopeKey = toScopeKey(state.projectScopeId)
      const nextScopeMap = {
        ...state.terminalScopeById,
        [terminal.id]: scopeKey
      }

      const nextTerminalOutputByScope = state.terminalOutputByScope[scopeKey]
        ? state.terminalOutputByScope
        : {
            ...state.terminalOutputByScope,
            [scopeKey]: {}
          }

      if (scopeKey !== currentScopeKey) {
        return {
          terminalScopeById: nextScopeMap,
          terminalOutputByScope: nextTerminalOutputByScope
        }
      }

      const existingIndex = state.terminals.findIndex((existing) => existing.id === terminal.id)
      const nextTerminals =
        existingIndex >= 0
          ? state.terminals.map((existing) => (existing.id === terminal.id ? terminal : existing))
          : [...state.terminals, terminal].sort((a, b) => a.createdAt - b.createdAt)

      return {
        terminals: nextTerminals,
        terminalScopeById: nextScopeMap,
        terminalOutputByScope: nextTerminalOutputByScope
      }
    }),
  pushTerminalEvent: (event) =>
    set((state) => {
      const scopeKey = state.terminalScopeById[event.terminalId] || toScopeKey(state.projectScopeId)
      const currentScopeKey = toScopeKey(state.projectScopeId)
      if (event.type === 'output') {
        const scopedOutput = state.terminalOutputByScope[scopeKey] || {}
        const previous = scopedOutput[event.terminalId] || ''
        // Keep terminal buffers bounded in renderer memory.
        const next = trimTerminalBuffer(previous + event.chunk)
        const nextScopedOutput = {
          ...scopedOutput,
          [event.terminalId]: next
        }
        return {
          terminalOutputByScope: {
            ...state.terminalOutputByScope,
            [scopeKey]: nextScopedOutput
          },
          terminalOutput: scopeKey === currentScopeKey ? nextScopedOutput : state.terminalOutput
        }
      }

      const scopedOutput = state.terminalOutputByScope[scopeKey] || {}
      const nextScopedOutput = { ...scopedOutput }
      delete nextScopedOutput[event.terminalId]

      const nextScopeMap = { ...state.terminalScopeById }
      delete nextScopeMap[event.terminalId]

      const nextTerminalOutputByScope = {
        ...state.terminalOutputByScope,
        [scopeKey]: nextScopedOutput
      }

      const nextTerminals =
        scopeKey === currentScopeKey
          ? state.terminals.filter((terminal) => terminal.id !== event.terminalId)
          : state.terminals

      const nextActiveByScope = { ...state.activeTerminalByScope }
      let nextActiveTerminalId = state.activeTerminalId
      if (nextActiveByScope[scopeKey] === event.terminalId) {
        if (scopeKey === currentScopeKey) {
          nextActiveTerminalId = nextTerminals[0]?.id
          nextActiveByScope[scopeKey] = nextActiveTerminalId
        } else {
          nextActiveByScope[scopeKey] = undefined
        }
      }

      return {
        terminals: nextTerminals,
        terminalScopeById: nextScopeMap,
        terminalOutputByScope: nextTerminalOutputByScope,
        terminalOutput: scopeKey === currentScopeKey ? nextScopedOutput : state.terminalOutput,
        activeTerminalId: nextActiveTerminalId,
        activeTerminalByScope: nextActiveByScope
      }
    }),
  setAgents: (agents) => set({ agents }),
  applyAgentEvent: (event) =>
    set((state) => ({
      agents: state.agents.map((agent) =>
        agent.id === event.agentId ? { ...agent, status: event.status } : agent
      )
    })),
  setActiveTerminal: (terminalId) =>
    set((state) => ({
      activeTerminalId: terminalId,
      activeTerminalByScope: {
        ...state.activeTerminalByScope,
        [toScopeKey(state.projectScopeId)]: terminalId
      }
    })),
  setWorkspace: (workspace) => set({ activeWorkspaceId: workspace })
}))

const persistedSlice = readPersistedSlice()

if (persistedSlice) {
  useOrchestratorStore.setState((state) => {
    const currentScopeKey = toScopeKey(state.projectScopeId)
    return {
      terminalOutputByScope: persistedSlice.terminalOutputByScope,
      terminalScopeById: persistedSlice.terminalScopeById,
      activeTerminalByScope: persistedSlice.activeTerminalByScope,
      terminalOutput: persistedSlice.terminalOutputByScope[currentScopeKey] || {},
      activeTerminalId: persistedSlice.activeTerminalByScope[currentScopeKey]
    }
  })
}

if (typeof window !== 'undefined') {
  let persistTimer: number | undefined
  let latestState: StoreState | null = null

  const flushPersistedState = (): void => {
    persistTimer = undefined
    if (!latestState) {
      return
    }
    writePersistedSlice(latestState)
    latestState = null
  }

  useOrchestratorStore.subscribe((state) => {
    latestState = state
    if (persistTimer !== undefined) {
      return
    }
    persistTimer = window.setTimeout(flushPersistedState, PERSIST_DEBOUNCE_MS)
  })

  window.addEventListener('beforeunload', () => {
    if (persistTimer !== undefined) {
      window.clearTimeout(persistTimer)
      persistTimer = undefined
    }
    if (latestState) {
      writePersistedSlice(latestState)
      latestState = null
    }
  })
}
