import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderPlus,
  Plus,
  Trash2,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOrchestration } from '@renderer/hooks/use-orchestration'
import { useSmokeChecks } from '@renderer/hooks/use-smoke-checks'
import { useOrchestratorStore } from '@renderer/stores/orchestrator-store'
import { PatchDiff } from '@pierre/diffs/react'
import type { GitDiffSummary, ProjectRecord, TerminalSession } from '../../../../shared/ipc/types'
import { AssistantChatPanel } from '../chat/assistant-chat-panel'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { TerminalTabs } from '../terminal/TerminalTabs'
import { useTheme } from './theme-provider'
import { WindowChrome } from './window-chrome'

const HOME_PROJECT_SCOPE = '__home__'
const SPACE_STORAGE_KEY = 'soloagent.spaces.v1'
const CENTER_SPLIT_STORAGE_KEY = 'soloagent.centerSplit.topPercent.v1'
const DEFAULT_CENTER_TOP_PERCENT = 50
const MIN_CENTER_TOP_PX = 140
const MIN_CENTER_BOTTOM_PX = 180
const CENTER_SPLITTER_PX = 6

type SpaceDefinition = {
  id: string
  name: string
}

type SpaceState = {
  spacesByScope: Record<string, SpaceDefinition[]>
  activeSpaceByScope: Record<string, string | undefined>
  terminalSpaceByScope: Record<string, Record<string, string>>
}

type ChatStreamingByScope = Record<string, Record<string, boolean>>

function ActivityIndicator({ active }: { active: boolean }): React.JSX.Element | null {
  if (!active) {
    return null
  }

  return (
    <span className="relative inline-flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
    </span>
  )
}

function toScopeKey(projectId?: string): string {
  return projectId || HOME_PROJECT_SCOPE
}

function makeSpaceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `space-${crypto.randomUUID()}`
  }
  return `space-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createSpace(index: number): SpaceDefinition {
  return {
    id: makeSpaceId(),
    name: `Space ${index}`
  }
}

function readPersistedSpaceState(): SpaceState {
  if (typeof window === 'undefined') {
    return {
      spacesByScope: {},
      activeSpaceByScope: {},
      terminalSpaceByScope: {}
    }
  }

  try {
    const raw = window.localStorage.getItem(SPACE_STORAGE_KEY)
    if (!raw) {
      return {
        spacesByScope: {},
        activeSpaceByScope: {},
        terminalSpaceByScope: {}
      }
    }

    const parsed = JSON.parse(raw) as SpaceState
    if (!parsed || typeof parsed !== 'object') {
      return {
        spacesByScope: {},
        activeSpaceByScope: {},
        terminalSpaceByScope: {}
      }
    }

    return {
      spacesByScope: parsed.spacesByScope || {},
      activeSpaceByScope: parsed.activeSpaceByScope || {},
      terminalSpaceByScope: parsed.terminalSpaceByScope || {}
    }
  } catch {
    return {
      spacesByScope: {},
      activeSpaceByScope: {},
      terminalSpaceByScope: {}
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function readPersistedCenterTopPercent(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_CENTER_TOP_PERCENT
  }

  const raw = window.localStorage.getItem(CENTER_SPLIT_STORAGE_KEY)
  if (!raw) {
    return DEFAULT_CENTER_TOP_PERCENT
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CENTER_TOP_PERCENT
  }

  return clamp(parsed, 20, 80)
}

export function DashboardLayout(): React.JSX.Element {
  useSmokeChecks()
  const { refresh, createTerminal, closeTerminal, renameTerminal } = useOrchestration()
  const { setTheme, resolvedTheme } = useTheme()
  const terminals = useOrchestratorStore((s) => s.terminals)
  const projectScopeId = useOrchestratorStore((s) => s.projectScopeId)
  const activeTerminalId = useOrchestratorStore((s) => s.activeTerminalId)
  const setProjectScope = useOrchestratorStore((s) => s.setProjectScope)
  const setActiveTerminal = useOrchestratorStore((s) => s.setActiveTerminal)
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string>()
  const [actionStatus, setActionStatus] = useState<string>('')
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [terminalPanelCollapsed, setTerminalPanelCollapsed] = useState(false)
  const [expandedProjectScopes, setExpandedProjectScopes] = useState<Record<string, boolean>>({})
  const [spaceState, setSpaceState] = useState<SpaceState>(() => readPersistedSpaceState())
  const [editingSpace, setEditingSpace] = useState<{ scopeKey: string; spaceId: string } | null>(
    null
  )
  const [spaceNameDraft, setSpaceNameDraft] = useState('')
  const [gitDiff, setGitDiff] = useState<GitDiffSummary | null>(null)
  const [gitDiffLoading, setGitDiffLoading] = useState(false)
  const [gitDiffError, setGitDiffError] = useState('')
  const [expandedGitDiffFiles, setExpandedGitDiffFiles] = useState<Record<string, boolean>>({})
  const [gitDiffModalFileIndex, setGitDiffModalFileIndex] = useState<number | null>(null)
  const [chatStreamingByScope, setChatStreamingByScope] = useState<ChatStreamingByScope>({})
  const [centerTopPercent, setCenterTopPercent] = useState<number>(() =>
    readPersistedCenterTopPercent()
  )
  const [isResizingCenter, setIsResizingCenter] = useState(false)
  const centerPanelRef = useRef<HTMLDivElement | null>(null)
  const apiReady = Boolean(window.api)
  const projectScopeKey = toScopeKey(projectScopeId)

  const rootTerminals = useMemo(
    () => terminals.filter((terminal) => !terminal.parentTerminalId),
    [terminals]
  )

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId),
    [projects, selectedProjectId]
  )

  const spacesForCurrentScope = spaceState.spacesByScope[projectScopeKey] || []
  const activeSpaceId =
    spaceState.activeSpaceByScope[projectScopeKey] ||
    (spacesForCurrentScope.length > 0 ? spacesForCurrentScope[0].id : undefined)
  const terminalSpaceMap = spaceState.terminalSpaceByScope[projectScopeKey] || {}

  const rootTerminalsInActiveSpace = useMemo(() => {
    if (!activeSpaceId) return []
    return rootTerminals.filter((terminal) => terminalSpaceMap[terminal.id] === activeSpaceId)
  }, [activeSpaceId, rootTerminals, terminalSpaceMap])

  const terminalsInActiveSpace = useMemo(() => {
    const rootIds = new Set(rootTerminalsInActiveSpace.map((terminal) => terminal.id))
    return terminals.filter((terminal) => {
      if (!terminal.parentTerminalId) {
        return rootIds.has(terminal.id)
      }
      return rootIds.has(terminal.parentTerminalId)
    })
  }, [rootTerminalsInActiveSpace, terminals])

  const activeTerminal = useMemo(
    () =>
      rootTerminalsInActiveSpace.find((terminal) => terminal.id === activeTerminalId) ||
      rootTerminalsInActiveSpace[0],
    [activeTerminalId, rootTerminalsInActiveSpace]
  )

  const spaceActivityByScope = chatStreamingByScope

  const projectActivityByScope = useMemo(() => {
    const next: Record<string, boolean> = {}
    for (const [scopeKey, spaceActivity] of Object.entries(spaceActivityByScope)) {
      next[scopeKey] = Object.values(spaceActivity).some(Boolean)
    }
    return next
  }, [spaceActivityByScope])

  const gridTemplateColumns = useMemo(() => {
    const columns: string[] = []
    if (!leftCollapsed) {
      columns.push('300px')
    }
    columns.push('minmax(0, 1fr)')
    if (!rightCollapsed) {
      columns.push('280px')
    }
    return columns.join(' ')
  }, [leftCollapsed, rightCollapsed])

  const setProjectExpanded = useCallback((scopeKey: string, expanded: boolean): void => {
    setExpandedProjectScopes((state) => ({
      ...state,
      [scopeKey]: expanded
    }))
  }, [])

  const toggleProjectExpanded = useCallback((scopeKey: string): void => {
    setExpandedProjectScopes((state) => ({
      ...state,
      [scopeKey]: !(state[scopeKey] ?? false)
    }))
  }, [])

  const loadSidebarPrefs = (projectId?: string): void => {
    const scopeKey = toScopeKey(projectId)
    setLeftCollapsed(localStorage.getItem(`soloagent.sidebar.left.${scopeKey}`) === '1')
    setRightCollapsed(localStorage.getItem(`soloagent.sidebar.right.${scopeKey}`) === '1')
  }

  const ensureProjectHasTerminal = useCallback(
    async (projectId?: string): Promise<void> => {
      if (!window.api) return
      const terminalsResponse = await window.api.terminal.list()
      if (!terminalsResponse.ok) return
      if (terminalsResponse.data.length > 0) return
      await createTerminal({ projectId })
    },
    [createTerminal]
  )

  const loadGitDiff = useCallback(async (): Promise<void> => {
    if (!window.api) {
      return
    }

    const cwd = selectedProject?.rootPath
    if (!cwd) {
      setGitDiff(null)
      setGitDiffError('')
      setGitDiffLoading(false)
      return
    }

    setGitDiffLoading(true)
    const response = await window.api.app.gitDiff({ cwd })
    if (!response.ok) {
      setGitDiff(null)
      setGitDiffError(response.error.message || 'Unable to load git diff.')
      setGitDiffLoading(false)
      return
    }

    setGitDiff(response.data)
    setGitDiffError('')
    setGitDiffLoading(false)
  }, [selectedProject?.rootPath])

  const diffTheme = resolvedTheme === 'dark' ? 'github-dark' : 'github-light'

  const patchDiffOptions = useMemo(
    () => ({
      theme: diffTheme,
      themeType: resolvedTheme,
      diffStyle: 'unified' as const,
      diffIndicators: 'bars' as const,
      disableBackground: false,
      disableLineNumbers: false,
      disableFileHeader: true,
      hunkSeparators: 'line-info' as const,
      lineDiffType: 'word' as const,
      overflow: 'wrap' as const,
      expansionLineCount: 4
    }),
    [diffTheme, resolvedTheme]
  )

  const gitDiffFiles = gitDiff?.files || []
  const gitDiffModalOpen = gitDiffModalFileIndex !== null
  const gitDiffModalFile =
    gitDiffModalOpen && gitDiffModalFileIndex !== null
      ? gitDiffFiles[gitDiffModalFileIndex]
      : undefined
  const hasMultipleDiffFiles = gitDiffFiles.length > 1

  const getDiffFileKey = useCallback(
    (path: string) => `${selectedProject?.id || HOME_PROJECT_SCOPE}:${path}`,
    [selectedProject?.id]
  )

  const toggleGitDiffFile = useCallback(
    (path: string): void => {
      const key = getDiffFileKey(path)
      setExpandedGitDiffFiles((state) => ({
        ...state,
        [key]: !state[key]
      }))
    },
    [getDiffFileKey]
  )

  const openGitDiffModal = useCallback(
    (path: string): void => {
      const fileIndex = gitDiffFiles.findIndex((file) => file.path === path)
      if (fileIndex < 0) {
        return
      }
      setGitDiffModalFileIndex(fileIndex)
    },
    [gitDiffFiles]
  )

  const closeGitDiffModal = useCallback((): void => {
    setGitDiffModalFileIndex(null)
  }, [])

  const showPreviousDiffFile = useCallback((): void => {
    if (gitDiffFiles.length === 0) {
      return
    }

    setGitDiffModalFileIndex((current) => {
      if (current === null) {
        return 0
      }
      return (current - 1 + gitDiffFiles.length) % gitDiffFiles.length
    })
  }, [gitDiffFiles.length])

  const showNextDiffFile = useCallback((): void => {
    if (gitDiffFiles.length === 0) {
      return
    }

    setGitDiffModalFileIndex((current) => {
      if (current === null) {
        return 0
      }
      return (current + 1) % gitDiffFiles.length
    })
  }, [gitDiffFiles.length])

  useEffect(() => {
    if (!window.api) return
    void (async () => {
      try {
        const [projectsResponse, currentProjectResponse] = await Promise.all([
          window.api.project.list(),
          window.api.project.current()
        ])

        const currentProjectId = currentProjectResponse.ok
          ? currentProjectResponse.data?.id
          : undefined
        const currentScopeKey = toScopeKey(currentProjectId)
        setSelectedProjectId(currentProjectId)
        setProjectScope(currentProjectId)
        loadSidebarPrefs(currentProjectId)

        const [activeTerminalResponse] = await Promise.all([
          window.api.config.get(`workspace.activeTerminal.${currentScopeKey}`),
          refresh()
        ])

        if (projectsResponse.ok) {
          setProjects(projectsResponse.data)
        }
        if (activeTerminalResponse.ok && activeTerminalResponse.data) {
          setActiveTerminal(activeTerminalResponse.data)
        }
        await ensureProjectHasTerminal(currentProjectId)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown startup error'
        setActionStatus(`Load failed: ${message}`)
      }
    })()
  }, [ensureProjectHasTerminal, refresh, setActiveTerminal, setProjectScope])

  useEffect(() => {
    void loadGitDiff()
  }, [loadGitDiff])

  useEffect(() => {
    if (!gitDiff) {
      setExpandedGitDiffFiles({})
      return
    }

    setExpandedGitDiffFiles((state) => {
      const nextState: Record<string, boolean> = {}
      for (const file of gitDiff.files) {
        const key = getDiffFileKey(file.path)
        if (state[key]) {
          nextState[key] = true
        }
      }
      return nextState
    })
  }, [getDiffFileKey, gitDiff])

  useEffect(() => {
    if (gitDiffFiles.length === 0) {
      setGitDiffModalFileIndex(null)
      return
    }

    setGitDiffModalFileIndex((current) => {
      if (current === null) {
        return current
      }
      if (current < gitDiffFiles.length) {
        return current
      }
      return gitDiffFiles.length - 1
    })
  }, [gitDiffFiles.length])

  useEffect(() => {
    if (!gitDiffModalOpen) {
      return
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeGitDiffModal()
        return
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        showPreviousDiffFile()
        return
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        showNextDiffFile()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [closeGitDiffModal, gitDiffModalOpen, showNextDiffFile, showPreviousDiffFile])

  useEffect(() => {
    if (!selectedProject?.rootPath || rightCollapsed) {
      return
    }

    const timer = window.setInterval(() => {
      void loadGitDiff()
    }, 3000)

    return () => {
      window.clearInterval(timer)
    }
  }, [loadGitDiff, rightCollapsed, selectedProject?.rootPath])

  useEffect(() => {
    if (!window.api) return
    const key = `workspace.activeTerminal.${projectScopeKey}`
    void window.api.config.set(key, activeTerminalId || '')
  }, [activeTerminalId, projectScopeKey])

  useEffect(() => {
    localStorage.setItem(`soloagent.sidebar.left.${projectScopeKey}`, leftCollapsed ? '1' : '0')
  }, [leftCollapsed, projectScopeKey])

  useEffect(() => {
    localStorage.setItem(`soloagent.sidebar.right.${projectScopeKey}`, rightCollapsed ? '1' : '0')
  }, [projectScopeKey, rightCollapsed])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(SPACE_STORAGE_KEY, JSON.stringify(spaceState))
  }, [spaceState])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(CENTER_SPLIT_STORAGE_KEY, String(centerTopPercent))
  }, [centerTopPercent])

  useEffect(() => {
    if (!editingSpace) {
      return
    }

    const scopedSpaces = spaceState.spacesByScope[editingSpace.scopeKey] || []
    const exists = scopedSpaces.some((space) => space.id === editingSpace.spaceId)
    if (!exists) {
      setEditingSpace(null)
      setSpaceNameDraft('')
    }
  }, [editingSpace, spaceState.spacesByScope])

  useEffect(() => {
    setExpandedProjectScopes((state) => {
      if (state[projectScopeKey]) {
        return state
      }
      return {
        ...state,
        [projectScopeKey]: true
      }
    })
  }, [projectScopeKey])

  const handleChatStreamingChange = useCallback(
    (scopeKey: string, spaceId: string, isStreaming: boolean): void => {
      setChatStreamingByScope((state) => {
        const scoped = { ...(state[scopeKey] || {}) }
        const wasStreaming = Boolean(scoped[spaceId])

        if (isStreaming) {
          if (wasStreaming) {
            return state
          }

          scoped[spaceId] = true
          return {
            ...state,
            [scopeKey]: scoped
          }
        }

        if (!wasStreaming) {
          return state
        }

        delete scoped[spaceId]
        if (Object.keys(scoped).length === 0) {
          const next = { ...state }
          delete next[scopeKey]
          return next
        }

        return {
          ...state,
          [scopeKey]: scoped
        }
      })
    },
    []
  )

  useEffect(() => {
    setSpaceState((state) => {
      const existing = state.spacesByScope[projectScopeKey]
      if (existing) {
        if (existing.length > 0) {
          if (state.activeSpaceByScope[projectScopeKey]) {
            return state
          }
          return {
            ...state,
            activeSpaceByScope: {
              ...state.activeSpaceByScope,
              [projectScopeKey]: existing[0].id
            }
          }
        }

        if (state.activeSpaceByScope[projectScopeKey] !== undefined) {
          return {
            ...state,
            activeSpaceByScope: {
              ...state.activeSpaceByScope,
              [projectScopeKey]: undefined
            }
          }
        }

        return state
      }

      const defaultSpace = createSpace(1)
      return {
        ...state,
        spacesByScope: {
          ...state.spacesByScope,
          [projectScopeKey]: [defaultSpace]
        },
        activeSpaceByScope: {
          ...state.activeSpaceByScope,
          [projectScopeKey]: defaultSpace.id
        },
        terminalSpaceByScope: {
          ...state.terminalSpaceByScope,
          [projectScopeKey]: state.terminalSpaceByScope[projectScopeKey] || {}
        }
      }
    })
  }, [projectScopeKey])

  useEffect(() => {
    if (spacesForCurrentScope.length === 0) return

    setSpaceState((state) => {
      const scopedMap = { ...(state.terminalSpaceByScope[projectScopeKey] || {}) }
      const rootIds = new Set(rootTerminals.map((terminal) => terminal.id))
      const fallbackSpaceId =
        state.activeSpaceByScope[projectScopeKey] || spacesForCurrentScope[0]?.id

      if (!fallbackSpaceId) {
        return state
      }

      let changed = false

      for (const terminalId of Object.keys(scopedMap)) {
        if (!rootIds.has(terminalId)) {
          delete scopedMap[terminalId]
          changed = true
        }
      }

      for (const terminal of rootTerminals) {
        if (!scopedMap[terminal.id]) {
          scopedMap[terminal.id] = fallbackSpaceId
          changed = true
        }
      }

      const currentActiveSpace = state.activeSpaceByScope[projectScopeKey]
      const activeSpaceValid =
        !!currentActiveSpace &&
        spacesForCurrentScope.some((space) => space.id === currentActiveSpace)
      if (!activeSpaceValid) {
        changed = true
      }

      if (!changed) {
        return state
      }

      return {
        ...state,
        activeSpaceByScope: {
          ...state.activeSpaceByScope,
          [projectScopeKey]: activeSpaceValid ? currentActiveSpace : fallbackSpaceId
        },
        terminalSpaceByScope: {
          ...state.terminalSpaceByScope,
          [projectScopeKey]: scopedMap
        }
      }
    })
  }, [projectScopeKey, rootTerminals, spacesForCurrentScope])

  useEffect(() => {
    if (!activeTerminal && activeTerminalId) {
      setActiveTerminal(undefined)
      return
    }

    if (activeTerminal && activeTerminal.id !== activeTerminalId) {
      setActiveTerminal(activeTerminal.id)
    }
  }, [activeTerminal, activeTerminalId, setActiveTerminal])

  const addProject = async (): Promise<void> => {
    if (!window.api) {
      setActionStatus('Preload API unavailable. Restart dev server.')
      return
    }

    const directoryResponse = await window.api.app.selectDirectory()
    if (!directoryResponse.ok) {
      setActionStatus(`Project selection failed: ${directoryResponse.error.message}`)
      return
    }
    if (!directoryResponse.data) {
      setActionStatus('Project selection cancelled.')
      return
    }

    const createResponse = await window.api.project.create({
      rootPath: directoryResponse.data
    })
    if (!createResponse.ok) {
      setActionStatus(`Create project failed: ${createResponse.error.message}`)
      return
    }

    const created = createResponse.data
    setProjects((previous) => [created, ...previous])
    await selectProject(created.id)
  }

  const selectProject = async (projectId?: string): Promise<void> => {
    if (!window.api) return
    const response = await window.api.project.select(projectId ? { projectId } : undefined)
    if (!response.ok) {
      setActionStatus(`Select project failed: ${response.error.message}`)
      return
    }
    const nextProjectId = response.data?.id
    const nextScopeKey = toScopeKey(nextProjectId)

    setSelectedProjectId(nextProjectId)
    setProjectScope(nextProjectId)
    setProjectExpanded(nextScopeKey, true)
    loadSidebarPrefs(nextProjectId)

    const activeTerminalResponse = await window.api.config.get(
      `workspace.activeTerminal.${nextScopeKey}`
    )
    setActiveTerminal(
      activeTerminalResponse.ok ? activeTerminalResponse.data || undefined : undefined
    )

    await refresh()
    await ensureProjectHasTerminal(nextProjectId)
    setActionStatus(
      response.data ? `Project selected: ${response.data.name}` : 'Project scope cleared.'
    )
  }

  const deleteProject = async (projectId: string): Promise<void> => {
    if (!window.api) return
    const projectName = projects.find((project) => project.id === projectId)?.name || 'this project'
    const confirmed = window.confirm(
      `Remove "${projectName}" from SoloAgent? This will not delete files on disk.`
    )
    if (!confirmed) {
      return
    }

    const response = await window.api.project.delete({ projectId })
    if (!response.ok || !response.data) {
      setActionStatus('Delete project failed.')
      return
    }

    setProjects((previous) => previous.filter((project) => project.id !== projectId))
    if (selectedProjectId === projectId) {
      await selectProject(undefined)
      setActionStatus('Project removed.')
      return
    }
    await refresh()
    setActionStatus('Project removed.')
  }

  const createSpaceInCurrentScope = useCallback(async (): Promise<void> => {
    const previousActiveSpaceId = activeSpaceId
    const previousActiveTerminalId = activeTerminal?.id
    const nextSpace = createSpace(spacesForCurrentScope.length + 1)

    setSpaceState((state) => {
      const existing = state.spacesByScope[projectScopeKey] || []

      return {
        ...state,
        spacesByScope: {
          ...state.spacesByScope,
          [projectScopeKey]: [...existing, nextSpace]
        },
        activeSpaceByScope: {
          ...state.activeSpaceByScope,
          [projectScopeKey]: nextSpace.id
        },
        terminalSpaceByScope: {
          ...state.terminalSpaceByScope,
          [projectScopeKey]: state.terminalSpaceByScope[projectScopeKey] || {}
        }
      }
    })
    setActiveTerminal(undefined)

    const created = await createTerminal({ projectId: selectedProjectId })
    if (!created || created.parentTerminalId) {
      setActionStatus('Failed to create initial terminal for new space.')
      setSpaceState((state) => {
        const existing = state.spacesByScope[projectScopeKey] || []
        const filtered = existing.filter((space) => space.id !== nextSpace.id)
        const nextActive = previousActiveSpaceId || filtered[0]?.id
        const scopedMap = { ...(state.terminalSpaceByScope[projectScopeKey] || {}) }
        for (const [terminalId, spaceId] of Object.entries(scopedMap)) {
          if (spaceId === nextSpace.id) {
            delete scopedMap[terminalId]
          }
        }

        return {
          ...state,
          spacesByScope: {
            ...state.spacesByScope,
            [projectScopeKey]: filtered
          },
          activeSpaceByScope: {
            ...state.activeSpaceByScope,
            [projectScopeKey]: nextActive
          },
          terminalSpaceByScope: {
            ...state.terminalSpaceByScope,
            [projectScopeKey]: scopedMap
          }
        }
      })
      setActiveTerminal(previousActiveTerminalId)
      return
    }

    setSpaceState((state) => ({
      ...state,
      terminalSpaceByScope: {
        ...state.terminalSpaceByScope,
        [projectScopeKey]: {
          ...(state.terminalSpaceByScope[projectScopeKey] || {}),
          [created.id]: nextSpace.id
        }
      }
    }))
    setActiveTerminal(created.id)
  }, [
    activeSpaceId,
    activeTerminal?.id,
    createTerminal,
    projectScopeKey,
    selectedProjectId,
    setActiveTerminal,
    spacesForCurrentScope.length
  ])

  const renameSpace = useCallback((scopeKey: string, spaceId: string, nextName: string): void => {
    setSpaceState((state) => {
      const scopedSpaces = state.spacesByScope[scopeKey] || []
      return {
        ...state,
        spacesByScope: {
          ...state.spacesByScope,
          [scopeKey]: scopedSpaces.map((space) =>
            space.id === spaceId ? { ...space, name: nextName } : space
          )
        }
      }
    })
    setActionStatus(`Renamed space to ${nextName}.`)
  }, [])

  const deleteSpaceInCurrentScope = useCallback(
    async (spaceId: string): Promise<void> => {
      const deletingSpace = spacesForCurrentScope.find((space) => space.id === spaceId)
      if (!deletingSpace) {
        return
      }

      if (spacesForCurrentScope.length <= 1) {
        const rootTerminalsInDeletingSpace = rootTerminals.filter(
          (terminal) => terminalSpaceMap[terminal.id] === spaceId
        )
        const tabCount = rootTerminalsInDeletingSpace.length
        const tabMessage =
          tabCount > 0
            ? ` ${tabCount} tab${tabCount === 1 ? '' : 's'} in this space will be closed.`
            : ''
        const confirmed = window.confirm(`Delete "${deletingSpace.name}"?${tabMessage}`)
        if (!confirmed) {
          return
        }

        setSpaceState((state) => {
          const scopedSpaces = state.spacesByScope[projectScopeKey] || []
          const scopedMap = { ...(state.terminalSpaceByScope[projectScopeKey] || {}) }
          for (const [terminalId, mappedSpaceId] of Object.entries(scopedMap)) {
            if (mappedSpaceId === spaceId) {
              delete scopedMap[terminalId]
            }
          }

          return {
            ...state,
            spacesByScope: {
              ...state.spacesByScope,
              [projectScopeKey]: scopedSpaces.filter((space) => space.id !== spaceId)
            },
            activeSpaceByScope: {
              ...state.activeSpaceByScope,
              [projectScopeKey]: undefined
            },
            terminalSpaceByScope: {
              ...state.terminalSpaceByScope,
              [projectScopeKey]: scopedMap
            }
          }
        })
        setActiveTerminal(undefined)

        for (const terminal of rootTerminalsInDeletingSpace) {
          await closeTerminal(terminal.id)
        }

        setActionStatus(`Deleted space ${deletingSpace.name}.`)
        return
      }

      const fallbackSpace = spacesForCurrentScope.find((space) => space.id !== spaceId)
      if (!fallbackSpace) {
        setActionStatus('No destination space available.')
        return
      }

      const confirmed = window.confirm(
        `Delete "${deletingSpace.name}"? Tabs in this space will move to "${fallbackSpace.name}".`
      )
      if (!confirmed) {
        return
      }

      const fallbackSpaceId = fallbackSpace.id
      setSpaceState((state) => {
        const scopedSpaces = state.spacesByScope[projectScopeKey] || []
        const remainingSpaces = scopedSpaces.filter((space) => space.id !== spaceId)
        const scopedMap = { ...(state.terminalSpaceByScope[projectScopeKey] || {}) }
        for (const [terminalId, mappedSpaceId] of Object.entries(scopedMap)) {
          if (mappedSpaceId === spaceId) {
            scopedMap[terminalId] = fallbackSpaceId
          }
        }

        const currentActive = state.activeSpaceByScope[projectScopeKey]
        const nextActive =
          currentActive === spaceId || !currentActive
            ? fallbackSpaceId
            : remainingSpaces.some((space) => space.id === currentActive)
              ? currentActive
              : fallbackSpaceId

        return {
          ...state,
          spacesByScope: {
            ...state.spacesByScope,
            [projectScopeKey]: remainingSpaces
          },
          activeSpaceByScope: {
            ...state.activeSpaceByScope,
            [projectScopeKey]: nextActive
          },
          terminalSpaceByScope: {
            ...state.terminalSpaceByScope,
            [projectScopeKey]: scopedMap
          }
        }
      })

      setActionStatus(`Deleted space ${deletingSpace.name}.`)
    },
    [
      closeTerminal,
      projectScopeKey,
      rootTerminals,
      setActiveTerminal,
      spacesForCurrentScope,
      terminalSpaceMap
    ]
  )

  const commitSpaceRename = useCallback(
    (scopeKey: string, spaceId: string, currentName: string): void => {
      const nextName = spaceNameDraft.trim()
      if (!nextName) {
        setActionStatus('Space name cannot be empty.')
        setEditingSpace(null)
        setSpaceNameDraft('')
        return
      }

      if (nextName !== currentName) {
        renameSpace(scopeKey, spaceId, nextName)
      }

      setEditingSpace(null)
      setSpaceNameDraft('')
    },
    [renameSpace, spaceNameDraft]
  )

  const selectSpace = useCallback(
    (spaceId: string): void => {
      setSpaceState((state) => ({
        ...state,
        activeSpaceByScope: {
          ...state.activeSpaceByScope,
          [projectScopeKey]: spaceId
        }
      }))

      const nextTerminal = rootTerminals.find(
        (terminal) => terminalSpaceMap[terminal.id] === spaceId
      )
      setActiveTerminal(nextTerminal?.id)
    },
    [projectScopeKey, rootTerminals, setActiveTerminal, terminalSpaceMap]
  )

  const startCenterResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (!centerPanelRef.current) {
        return
      }

      event.preventDefault()

      const bounds = centerPanelRef.current.getBoundingClientRect()
      if (bounds.height <= 0) {
        return
      }

      const startY = event.clientY
      const startPercent = centerTopPercent
      const previousUserSelect = document.body.style.userSelect
      const previousCursor = document.body.style.cursor

      setIsResizingCenter(true)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'row-resize'

      const onPointerMove = (moveEvent: PointerEvent): void => {
        const deltaPx = moveEvent.clientY - startY
        const rawPercent = startPercent + (deltaPx / bounds.height) * 100
        const minPercent = (MIN_CENTER_TOP_PX / bounds.height) * 100
        const maxPercent = 100 - (MIN_CENTER_BOTTOM_PX / bounds.height) * 100
        const safeMax = Math.max(minPercent, maxPercent)
        setCenterTopPercent(clamp(rawPercent, minPercent, safeMax))
      }

      const stopResize = (): void => {
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', stopResize)
        window.removeEventListener('pointercancel', stopResize)
        document.body.style.userSelect = previousUserSelect
        document.body.style.cursor = previousCursor
        setIsResizingCenter(false)
      }

      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', stopResize)
      window.addEventListener('pointercancel', stopResize)
    },
    [centerTopPercent]
  )

  const handleCreateTab = useCallback(async (): Promise<TerminalSession | undefined> => {
    if (!activeSpaceId) {
      await createSpaceInCurrentScope()
      return undefined
    }

    let created = await createTerminal({
      projectId: selectedProjectId,
      parentTerminalId: undefined
    })
    if (!created) {
      return created
    }

    // Guardrail: tab creation should never produce a split child.
    if (created.parentTerminalId) {
      await closeTerminal(created.id)
      created = await createTerminal({ projectId: selectedProjectId, parentTerminalId: undefined })
      if (!created || created.parentTerminalId) {
        setActionStatus('Failed to create a new tab. Please try again.')
        return undefined
      }
    }

    setSpaceState((state) => ({
      ...state,
      terminalSpaceByScope: {
        ...state.terminalSpaceByScope,
        [projectScopeKey]: {
          ...(state.terminalSpaceByScope[projectScopeKey] || {}),
          [created.id]: activeSpaceId
        }
      }
    }))
    setActiveTerminal(created.id)

    return created
  }, [
    activeSpaceId,
    closeTerminal,
    createSpaceInCurrentScope,
    createTerminal,
    projectScopeKey,
    selectedProjectId,
    setActiveTerminal
  ])

  const handleCloseTerminal = useCallback(
    async (terminalId: string): Promise<void> => {
      const closingActive = activeTerminalId === terminalId
      await closeTerminal(terminalId)

      if (closingActive) {
        const next = rootTerminalsInActiveSpace.filter((terminal) => terminal.id !== terminalId)[0]
        setActiveTerminal(next?.id)
      }
    },
    [activeTerminalId, closeTerminal, rootTerminalsInActiveSpace, setActiveTerminal]
  )

  const handleCreateSplit = useCallback(
    (parentTerminalId: string): Promise<TerminalSession | undefined> =>
      createTerminal({ projectId: selectedProjectId, parentTerminalId }),
    [createTerminal, selectedProjectId]
  )

  const handleRenameTerminal = useCallback(
    async (terminalId: string, title: string): Promise<void> => {
      await renameTerminal(terminalId, title)
    },
    [renameTerminal]
  )

  const handleCloseTerminalRequest = useCallback(
    (terminalId: string): void => {
      void handleCloseTerminal(terminalId)
    },
    [handleCloseTerminal]
  )

  const handleRenameTerminalRequest = useCallback(
    (terminalId: string, title: string): void => {
      void handleRenameTerminal(terminalId, title)
    },
    [handleRenameTerminal]
  )

  const projectEntries = useMemo(() => {
    const entries: Array<{ id?: string; name: string; rootPath?: string; scopeKey: string }> = [
      { id: undefined, name: 'Home', scopeKey: HOME_PROJECT_SCOPE }
    ]

    for (const project of projects) {
      entries.push({
        id: project.id,
        name: project.name,
        rootPath: project.rootPath,
        scopeKey: toScopeKey(project.id)
      })
    }

    return entries
  }, [projects])

  const chatSessions = useMemo(() => {
    const sessions: Array<{
      scopeKey: string
      spaceId: string
      projectId?: string
      projectPath?: string
    }> = []

    for (const entry of projectEntries) {
      const spaces = spaceState.spacesByScope[entry.scopeKey] || []
      for (const space of spaces) {
        sessions.push({
          scopeKey: entry.scopeKey,
          spaceId: space.id,
          projectId: entry.id,
          projectPath: entry.rootPath
        })
      }
    }

    return sessions
  }, [projectEntries, spaceState.spacesByScope])

  const showActionStatus = useMemo(() => {
    if (!actionStatus) return false
    const normalized = actionStatus.toLowerCase()
    return (
      normalized.includes('failed') ||
      normalized.includes('unavailable') ||
      normalized.includes('cannot') ||
      normalized.includes('no destination') ||
      normalized.includes('required') ||
      normalized.includes('load failed')
    )
  }, [actionStatus])

  return (
    <div className="flex h-screen flex-col">
      <WindowChrome
        leftCollapsed={leftCollapsed}
        rightCollapsed={rightCollapsed}
        terminalCollapsed={terminalPanelCollapsed}
        isDarkMode={resolvedTheme === 'dark'}
        onToggleLeft={() => setLeftCollapsed((value) => !value)}
        onToggleRight={() => setRightCollapsed((value) => !value)}
        onToggleTerminal={() => setTerminalPanelCollapsed((value) => !value)}
        onToggleTheme={(checked) => void setTheme(checked ? 'dark' : 'light')}
      />
      <div
        className="grid min-h-0 flex-1 gap-1.5 p-1.5"
        style={{
          gridTemplateColumns
        }}
      >
        {!leftCollapsed ? (
          <Card className="min-h-0 overflow-hidden">
            <CardHeader className="px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="truncate text-sm">Projects</CardTitle>
                <Button
                  size="icon"
                  variant="secondary"
                  className="h-7 w-7 shrink-0"
                  onClick={() => void addProject()}
                  aria-label="New Project"
                  title="New Project"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="min-h-0 space-y-1.5 overflow-y-auto px-2.5 pb-2 pt-0">
              {!apiReady ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                  Preload API is unavailable. Restart dev server after this update.
                </div>
              ) : null}

              <div className="space-y-1.5">
                {projectEntries.map((entry) => {
                  const isSelected = (selectedProjectId || undefined) === entry.id
                  const isExpanded = expandedProjectScopes[entry.scopeKey] ?? isSelected
                  const projectIsActive = Boolean(projectActivityByScope[entry.scopeKey])
                  const spacesForEntry =
                    spaceState.spacesByScope[entry.scopeKey] ||
                    (isSelected ? spacesForCurrentScope : [])
                  const entryActiveSpaceId =
                    spaceState.activeSpaceByScope[entry.scopeKey] || spacesForEntry[0]?.id
                  const entryTerminalSpaceMap =
                    spaceState.terminalSpaceByScope[entry.scopeKey] || {}

                  return (
                    <div
                      key={entry.scopeKey}
                      className={`rounded-md border border-border/60 ${
                        isSelected ? 'bg-accent/30' : 'bg-transparent'
                      }`}
                    >
                      <div className="group flex items-center gap-1 px-1 py-0.5">
                        <button
                          type="button"
                          onClick={() => {
                            if (!isSelected) {
                              void selectProject(entry.id)
                              return
                            }
                            setProjectExpanded(entry.scopeKey, true)
                          }}
                          className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                            isSelected ? 'text-accent-foreground' : 'hover:bg-accent/40'
                          }`}
                          title={entry.rootPath}
                        >
                          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {entry.name}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <ActivityIndicator active={projectIsActive} />
                            {entry.id ? (
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="h-5 w-5 shrink-0 text-muted-foreground opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto hover:text-destructive"
                                aria-label={`Remove ${entry.name}`}
                                title={`Remove ${entry.name}`}
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  void deleteProject(entry.id as string)
                                }}
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            ) : null}
                            <span className="text-xs text-muted-foreground">
                              ({spacesForEntry.length})
                            </span>
                          </div>
                        </button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 shrink-0"
                          onClick={() => toggleProjectExpanded(entry.scopeKey)}
                          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${entry.name}`}
                          title={`${isExpanded ? 'Collapse' : 'Expand'} ${entry.name}`}
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </Button>
                      </div>

                      {isExpanded ? (
                        <div className="space-y-1 border-t border-border/60 px-1.5 py-1.5">
                          <div className="flex items-center justify-between px-0.5 pb-0.5">
                            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              Spaces
                            </span>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-5 w-5"
                              onClick={() => createSpaceInCurrentScope()}
                              aria-label={`New space in ${entry.name}`}
                              disabled={!isSelected}
                              title={isSelected ? undefined : 'Select project to add spaces'}
                            >
                              <Plus className="h-3 w-3" />
                            </Button>
                          </div>

                          {spacesForEntry.map((space) => {
                            const tabCount = Object.values(entryTerminalSpaceMap).filter(
                              (mappedSpaceId) => mappedSpaceId === space.id
                            ).length
                            const spaceIsActive = Boolean(
                              spaceActivityByScope[entry.scopeKey]?.[space.id]
                            )
                            const isEditingSpace =
                              editingSpace?.scopeKey === entry.scopeKey &&
                              editingSpace.spaceId === space.id

                            return (
                              <div
                                key={space.id}
                                className={`group flex w-full items-center justify-between rounded-md px-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                                  entryActiveSpaceId === space.id
                                    ? 'bg-accent text-accent-foreground'
                                    : 'hover:bg-accent/40'
                                }`}
                              >
                                {isEditingSpace ? (
                                  <input
                                    autoFocus
                                    value={spaceNameDraft}
                                    onChange={(event) => setSpaceNameDraft(event.target.value)}
                                    onBlur={() =>
                                      commitSpaceRename(entry.scopeKey, space.id, space.name)
                                    }
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.preventDefault()
                                        commitSpaceRename(entry.scopeKey, space.id, space.name)
                                      }
                                      if (event.key === 'Escape') {
                                        event.preventDefault()
                                        setEditingSpace(null)
                                        setSpaceNameDraft('')
                                      }
                                    }}
                                    className="h-7 w-full rounded-sm border border-input bg-background px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    aria-label={`Rename ${space.name}`}
                                  />
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSpaceState((state) => ({
                                          ...state,
                                          activeSpaceByScope: {
                                            ...state.activeSpaceByScope,
                                            [entry.scopeKey]: space.id
                                          }
                                        }))
                                        if (isSelected) {
                                          selectSpace(space.id)
                                          return
                                        }
                                        void selectProject(entry.id)
                                      }}
                                      className="flex min-w-0 flex-1 items-center justify-between text-left"
                                    >
                                      <span
                                        className="truncate text-xs font-medium"
                                        onDoubleClick={(event) => {
                                          event.preventDefault()
                                          event.stopPropagation()
                                          setEditingSpace({
                                            scopeKey: entry.scopeKey,
                                            spaceId: space.id
                                          })
                                          setSpaceNameDraft(space.name)
                                        }}
                                        title={`Double-click to rename ${space.name}`}
                                      >
                                        {space.name}
                                      </span>
                                      <span className="ml-2 flex items-center gap-2 text-xs text-muted-foreground">
                                        <ActivityIndicator active={spaceIsActive} />
                                        <span>{tabCount} tabs</span>
                                      </span>
                                    </button>
                                    <Button
                                      type="button"
                                      size="icon"
                                      variant="ghost"
                                      className="h-5 w-5 shrink-0 text-muted-foreground opacity-0 transition-opacity pointer-events-none disabled:opacity-0 group-hover:opacity-100 group-hover:disabled:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto hover:text-destructive"
                                      onClick={() => void deleteSpaceInCurrentScope(space.id)}
                                      aria-label={`Delete ${space.name}`}
                                      title={`Delete ${space.name}`}
                                      disabled={!isSelected}
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  </>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>

              {showActionStatus ? (
                <div className="rounded-md border border-border/70 bg-muted/50 p-2 text-xs text-muted-foreground">
                  {actionStatus}
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        <div
          ref={centerPanelRef}
          className="grid min-h-0 gap-1"
          style={
            terminalPanelCollapsed
              ? { gridTemplateRows: 'minmax(0, 1fr)' }
              : { gridTemplateRows: `${centerTopPercent}% ${CENTER_SPLITTER_PX}px minmax(0, 1fr)` }
          }
        >
          <Card className="min-h-0 flex flex-col overflow-hidden">
            <CardContent className="min-h-0 flex-1 p-2">
              <AssistantChatPanel
                activeScopeKey={projectScopeKey}
                activeSpaceId={activeSpaceId}
                sessions={chatSessions}
                colorMode={resolvedTheme}
                onStreamingChange={handleChatStreamingChange}
              />
            </CardContent>
          </Card>

          {!terminalPanelCollapsed ? (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize chat and terminal panels"
              onPointerDown={startCenterResize}
              className={`rounded-sm border border-border/70 bg-muted/60 transition-colors ${
                isResizingCenter ? 'bg-accent' : 'hover:bg-accent/70'
              } cursor-row-resize`}
            />
          ) : null}

          {!terminalPanelCollapsed ? (
            <Card className="min-h-0 flex flex-col overflow-hidden">
              <CardContent className="min-h-0 flex-1 overflow-hidden p-2">
                <TerminalTabs
                  terminals={terminalsInActiveSpace}
                  activeTerminalId={activeTerminal?.id}
                  colorMode={resolvedTheme}
                  onActiveTerminalChange={setActiveTerminal}
                  onCreateTab={handleCreateTab}
                  onCreateSplit={handleCreateSplit}
                  onCloseTerminal={handleCloseTerminalRequest}
                  onRenameTerminal={handleRenameTerminalRequest}
                />
              </CardContent>
            </Card>
          ) : null}
        </div>

        {!rightCollapsed ? (
          <Card className="min-h-0 flex flex-col overflow-hidden">
            <CardHeader className="px-3 py-2">
              <CardTitle className="truncate text-sm">Git Diff</CardTitle>
              <CardDescription className="text-xs">
                {selectedProject
                  ? gitDiff
                    ? `${gitDiff.branch}  ${gitDiff.changedFiles} file${gitDiff.changedFiles === 1 ? '' : 's'} changed`
                    : 'Working tree changes in this branch.'
                  : 'Select a project to inspect branch changes.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 overflow-y-auto space-y-2 px-3 pb-3 pt-0 text-xs">
              {!selectedProject ? (
                <div className="rounded-md border border-border/70 bg-muted/40 p-2 text-muted-foreground">
                  Choose a project from the left sidebar to view git changes.
                </div>
              ) : gitDiffError ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive">
                  {gitDiffError}
                </div>
              ) : gitDiffLoading && !gitDiff ? (
                <div className="rounded-md border border-border/70 bg-muted/40 p-2 text-muted-foreground">
                  Loading diff...
                </div>
              ) : gitDiff ? (
                <>
                  <div className="rounded-md border p-1.5">
                    <div className="font-medium">Branch</div>
                    <div className="text-muted-foreground">
                      {gitDiff.branch}
                      {gitDiff.ahead > 0 || gitDiff.behind > 0
                        ? `  (ahead ${gitDiff.ahead}, behind ${gitDiff.behind})`
                        : ''}
                    </div>
                  </div>
                  <div className="rounded-md border p-1.5">
                    <div className="font-medium">Line Changes</div>
                    <div className="text-muted-foreground">
                      <span className="text-emerald-500">+{gitDiff.totalAdditions}</span>
                      {'  '}
                      <span className="text-red-500">-{gitDiff.totalDeletions}</span>
                    </div>
                  </div>

                  {gitDiff.clean ? (
                    <div className="rounded-md border border-border/70 bg-muted/40 p-2 text-muted-foreground">
                      Working tree is clean.
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {gitDiffFiles.map((file) => {
                        const diffFileKey = getDiffFileKey(file.path)
                        const expanded = expandedGitDiffFiles[diffFileKey] || false
                        const hasPatch = Boolean(file.patch && file.patch.trim().length > 0)

                        return (
                          <div key={file.path} className="rounded-md border border-border/70 p-1.5">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate font-medium">{file.path}</div>
                                <div className="text-[11px] capitalize text-muted-foreground">
                                  {file.status}
                                </div>
                              </div>
                              <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                                <div className="text-emerald-500">+{file.additions}</div>
                                <div className="text-red-500">-{file.deletions}</div>
                              </div>
                            </div>

                            <div className="mt-1 flex items-center justify-between gap-2">
                              <div className="min-w-0 truncate text-[10px] text-muted-foreground">
                                {file.hunks.length > 0
                                  ? `${file.hunks.length} hunk${file.hunks.length === 1 ? '' : 's'}`
                                  : 'No parsed hunks'}
                              </div>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  className="rounded-sm border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                  onClick={() => openGitDiffModal(file.path)}
                                  disabled={!hasPatch}
                                >
                                  Full
                                </button>
                                <button
                                  type="button"
                                  className="rounded-sm border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                  onClick={() => toggleGitDiffFile(file.path)}
                                  disabled={!hasPatch}
                                >
                                  {hasPatch ? (expanded ? 'Hide Diff' : 'Show Diff') : 'No Patch'}
                                </button>
                              </div>
                            </div>

                            {expanded && hasPatch ? (
                              <div className="mt-1.5 overflow-hidden rounded-sm border border-border/70 bg-background/60">
                                <PatchDiff
                                  patch={file.patch || ''}
                                  options={patchDiffOptions}
                                  className="text-[11px]"
                                />
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </>
              ) : (
                <div className="rounded-md border border-border/70 bg-muted/40 p-2 text-muted-foreground">
                  No diff data available.
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>

      {gitDiffModalOpen && gitDiffModalFile ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3"
          onClick={closeGitDiffModal}
        >
          <div
            className="flex h-[92vh] w-[min(1380px,100%)] flex-col overflow-hidden rounded-lg border border-border/70 bg-background shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{gitDiffModalFile.path}</div>
                <div className="text-[11px] capitalize text-muted-foreground">
                  <span>{gitDiffModalFile.status}</span>
                  <span>{' • '}</span>
                  <span className="text-emerald-500">+{gitDiffModalFile.additions}</span>
                  <span>{' '}</span>
                  <span className="text-red-500">-{gitDiffModalFile.deletions}</span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <span className="mr-1 text-[11px] text-muted-foreground">
                  {(gitDiffModalFileIndex || 0) + 1} / {gitDiffFiles.length}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={showPreviousDiffFile}
                  disabled={!hasMultipleDiffFiles}
                  title="Previous file"
                  aria-label="Previous file"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={showNextDiffFile}
                  disabled={!hasMultipleDiffFiles}
                  title="Next file"
                  aria-label="Next file"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={closeGitDiffModal}
                  title="Close"
                  aria-label="Close diff viewer"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-3">
              {gitDiffModalFile.patch && gitDiffModalFile.patch.trim().length > 0 ? (
                <div className="overflow-hidden rounded-sm border border-border/70 bg-background/60">
                  <PatchDiff
                    patch={gitDiffModalFile.patch}
                    options={patchDiffOptions}
                    className="text-xs"
                  />
                </div>
              ) : (
                <div className="rounded-md border border-border/70 bg-muted/40 p-2 text-xs text-muted-foreground">
                  No patch content available for this file.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
