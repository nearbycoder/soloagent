import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderPlus,
  LoaderCircle,
  Plus,
  Settings2,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOrchestration } from '@renderer/hooks/use-orchestration'
import { useSmokeChecks } from '@renderer/hooks/use-smoke-checks'
import { useOrchestratorStore } from '@renderer/stores/orchestrator-store'
import { PatchDiff } from '@pierre/diffs/react'
import type {
  GitDiffFileChange,
  GitDiffSummary,
  ProjectRecord,
  TerminalSession
} from '../../../../shared/ipc/types'
import { AssistantChatPanel } from '../chat/assistant-chat-panel'
import { Button } from '../ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { TerminalTabs } from '../terminal/TerminalTabs'
import { FileTreePanel } from './file-tree-panel'
import {
  getAccentTintOverlay,
  getProjectInitial,
  normalizeAccentColor
} from './project-appearance-utils'
import { useTheme } from './theme-provider'
import { WindowChrome } from './window-chrome'

const HOME_PROJECT_SCOPE = '__home__'
const SPACE_STORAGE_KEY = 'soloagent.spaces.v1'
const CENTER_SPLIT_STORAGE_KEY = 'soloagent.centerSplit.topPercent.v1'
const PROJECT_LOGO_KEY_PREFIX = 'project.logo.'
const PROJECT_ACCENT_KEY_PREFIX = 'project.accent.'
const HOME_VISIBILITY_CONFIG_KEY = 'workspace.home.visible'
const MAX_PROJECT_LOGO_FILE_BYTES = 2 * 1024 * 1024
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
type RightSidebarTab = 'git-diff' | 'file-tree'
type ProjectEntry = {
  id?: string
  name: string
  rootPath?: string
  scopeKey: string
}

type NoProjectPlaceholderProps = {
  title: string
  description: string
  compact?: boolean
  onAddProject: () => void
}

function NoProjectPlaceholder({
  title,
  description,
  compact = false,
  onAddProject
}: NoProjectPlaceholderProps): React.JSX.Element {
  return (
    <div
      className={`flex h-full items-center justify-center rounded-md border border-dashed border-border/70 bg-muted/30 p-3 ${
        compact ? 'min-h-[96px]' : 'min-h-[150px]'
      }`}
    >
      <div className="max-w-[360px] space-y-2 text-center">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
        <Button type="button" size="sm" className="h-8 gap-1" onClick={onAddProject}>
          <FolderPlus className="h-3.5 w-3.5" />
          Add Project
        </Button>
      </div>
    </div>
  )
}

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

function getProjectLogoKey(projectId: string): string {
  return `${PROJECT_LOGO_KEY_PREFIX}${projectId}`
}

function getProjectAccentKey(projectId: string): string {
  return `${PROJECT_ACCENT_KEY_PREFIX}${projectId}`
}

type ProjectAvatarProps = {
  name: string
  logoDataUrl?: string
  className?: string
  textClassName?: string
}

function ProjectAvatar({
  name,
  logoDataUrl,
  className = 'h-5 w-5',
  textClassName = 'text-[11px]'
}: ProjectAvatarProps): React.JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/70 bg-muted ${className}`}
      aria-hidden="true"
    >
      {logoDataUrl ? (
        <img src={logoDataUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className={`font-bold text-foreground ${textClassName}`}>
          {getProjectInitial(name)}
        </span>
      )}
    </span>
  )
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
  const [projectLogosById, setProjectLogosById] = useState<Record<string, string>>({})
  const [projectAccentColorsById, setProjectAccentColorsById] = useState<Record<string, string>>({})
  const [homeVisible, setHomeVisible] = useState(true)
  const [selectedProjectId, setSelectedProjectId] = useState<string>()
  const [projectSettingsProjectId, setProjectSettingsProjectId] = useState<string | null>(null)
  const [projectSettingsNameDraft, setProjectSettingsNameDraft] = useState('')
  const [projectSettingsLogoDraft, setProjectSettingsLogoDraft] = useState('')
  const [projectSettingsAccentDraft, setProjectSettingsAccentDraft] = useState('')
  const [projectSettingsSaving, setProjectSettingsSaving] = useState(false)
  const [projectSettingsError, setProjectSettingsError] = useState('')
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
  const [gitCommitDraft, setGitCommitDraft] = useState('')
  const [gitPrTitleDraft, setGitPrTitleDraft] = useState('')
  const [gitPrBodyDraft, setGitPrBodyDraft] = useState('')
  const [gitComposerStatus, setGitComposerStatus] = useState('')
  const [gitComposerStatusTone, setGitComposerStatusTone] = useState<'success' | 'error' | null>(
    null
  )
  const [gitCommitSubmitting, setGitCommitSubmitting] = useState(false)
  const [gitPrSubmitting, setGitPrSubmitting] = useState(false)
  const [gitPushSubmitting, setGitPushSubmitting] = useState(false)
  const [expandedGitDiffFiles, setExpandedGitDiffFiles] = useState<Record<string, boolean>>({})
  const [gitDiffPatchLoadingByPath, setGitDiffPatchLoadingByPath] = useState<
    Record<string, boolean>
  >({})
  const [gitDiffModalFileIndex, setGitDiffModalFileIndex] = useState<number | null>(null)
  const [rightSidebarTab, setRightSidebarTab] = useState<RightSidebarTab>('git-diff')
  const [chatStreamingByScope, setChatStreamingByScope] = useState<ChatStreamingByScope>({})
  const [centerTopPercent, setCenterTopPercent] = useState<number>(() =>
    readPersistedCenterTopPercent()
  )
  const [isResizingCenter, setIsResizingCenter] = useState(false)
  const centerPanelRef = useRef<HTMLDivElement | null>(null)
  const projectLogoInputRef = useRef<HTMLInputElement | null>(null)
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
  const selectedProjectAccentColor = useMemo(() => {
    return projectAccentColorsById[projectScopeKey]
  }, [projectAccentColorsById, projectScopeKey])
  const projectSettingsProject = useMemo(
    () =>
      projectSettingsProjectId
        ? projectSettingsProjectId === HOME_PROJECT_SCOPE
          ? undefined
          : projects.find((project) => project.id === projectSettingsProjectId)
        : undefined,
    [projectSettingsProjectId, projects]
  )
  const projectSettingsIsHome = projectSettingsProjectId === HOME_PROJECT_SCOPE
  const projectSettingsDisplayName = projectSettingsProject?.name || 'Home'
  const projectSettingsRootPath =
    projectSettingsProject?.rootPath || 'Home scope (no project directory)'

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
  const noProjectAvailable = !homeVisible && projects.length === 0
  const leftPanelVisible = noProjectAvailable || !leftCollapsed
  const effectiveLeftCollapsed = !leftPanelVisible
  const effectiveRightCollapsed = noProjectAvailable ? true : rightCollapsed
  const effectiveTerminalCollapsed = noProjectAvailable ? true : terminalPanelCollapsed

  const gridTemplateColumns = useMemo(() => {
    if (noProjectAvailable) {
      return leftPanelVisible ? '300px' : 'minmax(0, 1fr)'
    }

    const columns: string[] = []
    if (leftPanelVisible) {
      columns.push('300px')
    }
    columns.push('minmax(0, 1fr)')
    if (!effectiveRightCollapsed) {
      columns.push('280px')
    }
    return columns.join(' ')
  }, [effectiveRightCollapsed, leftPanelVisible, noProjectAvailable])

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
      setGitDiffPatchLoadingByPath({})
      return
    }

    setGitDiffLoading(true)
    const response = await window.api.app.gitDiff({ cwd })
    if (!response.ok) {
      setGitDiff(null)
      setGitDiffError(response.error.message || 'Unable to load git diff.')
      setGitDiffLoading(false)
      setGitDiffPatchLoadingByPath({})
      return
    }

    setGitDiff(response.data)
    setGitDiffError('')
    setGitDiffLoading(false)
    setGitDiffPatchLoadingByPath({})
  }, [selectedProject?.rootPath])

  const handleGitCommit = useCallback(async (): Promise<void> => {
    if (!window.api) {
      return
    }

    const cwd = selectedProject?.rootPath
    if (!cwd) {
      setGitComposerStatusTone('error')
      setGitComposerStatus('Select a project before committing.')
      return
    }

    setGitCommitSubmitting(true)
    setGitComposerStatusTone(null)
    setGitComposerStatus('Creating commit...')

    try {
      const response = await window.api.app.gitCommit({
        cwd,
        message: gitCommitDraft.trim() || undefined
      })
      if (!response.ok) {
        setGitComposerStatusTone('error')
        setGitComposerStatus(response.error.message || 'Commit failed.')
        return
      }

      setGitCommitDraft('')
      setGitComposerStatusTone('success')
      setGitComposerStatus(`Committed ${response.data.commitHash}: ${response.data.commitMessage}`)
      await loadGitDiff()
    } finally {
      setGitCommitSubmitting(false)
    }
  }, [gitCommitDraft, loadGitDiff, selectedProject?.rootPath])

  const handleGitCreatePr = useCallback(async (): Promise<void> => {
    if (!window.api) {
      return
    }

    const cwd = selectedProject?.rootPath
    if (!cwd) {
      setGitComposerStatusTone('error')
      setGitComposerStatus('Select a project before creating a PR.')
      return
    }

    setGitPrSubmitting(true)
    setGitComposerStatusTone(null)
    setGitComposerStatus('Creating pull request...')

    try {
      const response = await window.api.app.gitCreatePr({
        cwd,
        title: gitPrTitleDraft.trim() || undefined,
        body: gitPrBodyDraft.trim() || undefined
      })
      if (!response.ok) {
        setGitComposerStatusTone('error')
        setGitComposerStatus(response.error.message || 'Pull request creation failed.')
        return
      }

      setGitPrTitleDraft(response.data.title)
      setGitPrBodyDraft(response.data.body)
      setGitComposerStatusTone('success')
      setGitComposerStatus(
        response.data.url
          ? `Pull request created: ${response.data.url}`
          : `Pull request created from ${response.data.headBranch}.`
      )
      await loadGitDiff()
    } finally {
      setGitPrSubmitting(false)
    }
  }, [gitPrBodyDraft, gitPrTitleDraft, loadGitDiff, selectedProject?.rootPath])

  const handleGitPush = useCallback(async (): Promise<void> => {
    if (!window.api) {
      return
    }

    const cwd = selectedProject?.rootPath
    if (!cwd) {
      setGitComposerStatusTone('error')
      setGitComposerStatus('Select a project before pushing.')
      return
    }

    setGitPushSubmitting(true)
    setGitComposerStatusTone(null)
    setGitComposerStatus('Pushing main branch...')

    try {
      const response = await window.api.app.gitPush({ cwd })
      if (!response.ok) {
        setGitComposerStatusTone('error')
        setGitComposerStatus(response.error.message || 'Push failed.')
        return
      }

      setGitComposerStatusTone('success')
      setGitComposerStatus(`Pushed ${response.data.branch} to ${response.data.remote}.`)
      await loadGitDiff()
    } finally {
      setGitPushSubmitting(false)
    }
  }, [loadGitDiff, selectedProject?.rootPath])

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
  const gitComposerBusy = gitCommitSubmitting || gitPrSubmitting || gitPushSubmitting
  const canCommitInComposer = Boolean(selectedProject?.rootPath) && !gitComposerBusy
  const isMainGitBranch = gitDiff?.branch === 'main'
  const showPrComposer = !isMainGitBranch
  const canPushMainInComposer =
    Boolean(selectedProject?.rootPath) &&
    !gitComposerBusy &&
    isMainGitBranch &&
    Boolean(gitDiff?.clean) &&
    (gitDiff?.ahead ?? 0) > 0
  const canCreatePrInComposer =
    Boolean(selectedProject?.rootPath) &&
    !gitComposerBusy &&
    Boolean(gitDiff?.clean) &&
    showPrComposer
  const gitComposerProgressLabel = gitCommitSubmitting
    ? 'Thinking about your commit...'
    : gitPrSubmitting
      ? 'Thinking about your pull request...'
      : gitPushSubmitting
        ? 'Pushing latest main changes...'
        : ''

  const getDiffFileKey = useCallback(
    (path: string) => `${selectedProject?.id || HOME_PROJECT_SCOPE}:${path}`,
    [selectedProject?.id]
  )

  const applyGitDiffFilePatch = useCallback((patchedFile: GitDiffFileChange): void => {
    setGitDiff((current) => {
      if (!current) {
        return current
      }

      let changed = false
      const nextFiles = current.files.map((file) => {
        if (file.path !== patchedFile.path) {
          return file
        }

        changed = true
        return {
          ...file,
          additions:
            file.additions === 0 && file.deletions === 0 ? patchedFile.additions : file.additions,
          deletions:
            file.additions === 0 && file.deletions === 0 ? patchedFile.deletions : file.deletions,
          hunks: patchedFile.hunks.length > 0 ? patchedFile.hunks : file.hunks,
          patch: patchedFile.patch
        }
      })

      if (!changed) {
        return current
      }

      const totalAdditions = nextFiles.reduce((sum, file) => sum + file.additions, 0)
      const totalDeletions = nextFiles.reduce((sum, file) => sum + file.deletions, 0)

      return {
        ...current,
        files: nextFiles,
        totalAdditions,
        totalDeletions
      }
    })
  }, [])

  const ensureGitDiffPatch = useCallback(
    async (path: string): Promise<boolean> => {
      if (!window.api) {
        return false
      }

      const cwd = selectedProject?.rootPath
      if (!cwd) {
        return false
      }

      const existingFile = gitDiffFiles.find((file) => file.path === path)
      if (!existingFile) {
        return false
      }

      if (existingFile.patch && existingFile.patch.trim().length > 0) {
        return true
      }

      const fileKey = getDiffFileKey(path)
      if (gitDiffPatchLoadingByPath[fileKey]) {
        return false
      }

      setGitDiffPatchLoadingByPath((state) => ({
        ...state,
        [fileKey]: true
      }))

      try {
        const response = await window.api.app.gitDiffFilePatch({
          cwd,
          path,
          status: existingFile.status
        })
        if (!response.ok) {
          setActionStatus(response.error.message || 'Unable to load file diff.')
          return false
        }

        applyGitDiffFilePatch({
          ...existingFile,
          additions: response.data.additions,
          deletions: response.data.deletions,
          hunks: response.data.hunks,
          patch: response.data.patch
        })

        return Boolean(response.data.patch && response.data.patch.trim().length > 0)
      } finally {
        setGitDiffPatchLoadingByPath((state) => {
          const next = { ...state }
          delete next[fileKey]
          return next
        })
      }
    },
    [
      applyGitDiffFilePatch,
      getDiffFileKey,
      gitDiffFiles,
      gitDiffPatchLoadingByPath,
      selectedProject?.rootPath
    ]
  )

  const toggleGitDiffFile = useCallback(
    async (path: string): Promise<void> => {
      const hasPatch = await ensureGitDiffPatch(path)
      if (!hasPatch) {
        return
      }
      const key = getDiffFileKey(path)
      setExpandedGitDiffFiles((state) => ({
        ...state,
        [key]: !state[key]
      }))
    },
    [ensureGitDiffPatch, getDiffFileKey]
  )

  const openGitDiffModal = useCallback(
    async (path: string): Promise<void> => {
      const hasPatch = await ensureGitDiffPatch(path)
      if (!hasPatch) {
        return
      }
      const fileIndex = gitDiffFiles.findIndex((file) => file.path === path)
      if (fileIndex < 0) {
        return
      }
      setGitDiffModalFileIndex(fileIndex)
    },
    [ensureGitDiffPatch, gitDiffFiles]
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
        const [projectsResponse, currentProjectResponse, homeVisibilityResponse] =
          await Promise.all([
            window.api.project.list(),
            window.api.project.current(),
            window.api.config.get(HOME_VISIBILITY_CONFIG_KEY)
          ])

        const listedProjects = projectsResponse.ok ? projectsResponse.data : []
        if (projectsResponse.ok) {
          setProjects(listedProjects)
        }

        const homeIsVisible = !homeVisibilityResponse.ok || homeVisibilityResponse.data !== '0'
        setHomeVisible(homeIsVisible)

        let currentProjectId = currentProjectResponse.ok
          ? currentProjectResponse.data?.id
          : undefined
        if (!homeIsVisible && !currentProjectId && listedProjects.length > 0) {
          const fallbackProjectId = listedProjects[0]?.id
          if (fallbackProjectId) {
            const selectResponse = await window.api.project.select({ projectId: fallbackProjectId })
            currentProjectId = selectResponse.ok
              ? selectResponse.data?.id || fallbackProjectId
              : fallbackProjectId
          }
        }

        const currentScopeKey = toScopeKey(currentProjectId)
        setSelectedProjectId(currentProjectId)
        setProjectScope(currentProjectId)
        loadSidebarPrefs(currentProjectId)

        const [activeTerminalResponse] = await Promise.all([
          window.api.config.get(`workspace.activeTerminal.${currentScopeKey}`),
          refresh()
        ])

        if (activeTerminalResponse.ok && activeTerminalResponse.data) {
          setActiveTerminal(activeTerminalResponse.data)
        }
        if (homeIsVisible || currentProjectId) {
          await ensureProjectHasTerminal(currentProjectId)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown startup error'
        setActionStatus(`Load failed: ${message}`)
      }
    })()
  }, [ensureProjectHasTerminal, refresh, setActiveTerminal, setProjectScope])

  useEffect(() => {
    if (!window.api) {
      return
    }

    let cancelled = false
    void window.api.config.all().then((response) => {
      if (!response.ok || cancelled) {
        return
      }

      const validProjectIds = new Set([
        HOME_PROJECT_SCOPE,
        ...projects.map((project) => project.id)
      ])
      const nextProjectLogosById: Record<string, string> = {}
      const nextProjectAccentColorsById: Record<string, string> = {}
      for (const setting of response.data) {
        if (setting.key.startsWith(PROJECT_LOGO_KEY_PREFIX)) {
          const projectId = setting.key.slice(PROJECT_LOGO_KEY_PREFIX.length)
          if (!projectId || !validProjectIds.has(projectId) || !setting.value) {
            continue
          }

          nextProjectLogosById[projectId] = setting.value
          continue
        }

        if (!setting.key.startsWith(PROJECT_ACCENT_KEY_PREFIX)) {
          continue
        }

        const projectId = setting.key.slice(PROJECT_ACCENT_KEY_PREFIX.length)
        const normalized = normalizeAccentColor(setting.value)
        if (!projectId || !validProjectIds.has(projectId) || !normalized) {
          continue
        }
        nextProjectAccentColorsById[projectId] = normalized
      }

      setProjectLogosById(nextProjectLogosById)
      setProjectAccentColorsById(nextProjectAccentColorsById)
    })

    return () => {
      cancelled = true
    }
  }, [projects])

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
    setGitCommitDraft('')
    setGitPrTitleDraft('')
    setGitPrBodyDraft('')
    setGitComposerStatus('')
    setGitComposerStatusTone(null)
    setGitCommitSubmitting(false)
    setGitPrSubmitting(false)
    setGitPushSubmitting(false)
  }, [projectScopeKey])

  useEffect(() => {
    if (!selectedProject?.rootPath || rightCollapsed || rightSidebarTab !== 'git-diff') {
      return
    }

    const initialTimer = window.setTimeout(() => {
      void loadGitDiff()
    }, 140)
    const timer = window.setInterval(() => {
      void loadGitDiff()
    }, 4000)

    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(timer)
    }
  }, [loadGitDiff, rightCollapsed, rightSidebarTab, selectedProject?.rootPath])

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
    if (projectScopeKey === HOME_PROJECT_SCOPE && !homeVisible) {
      return
    }

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
  }, [homeVisible, projectScopeKey])

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
    if (homeVisible || nextProjectId) {
      await ensureProjectHasTerminal(nextProjectId)
    }
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
    setProjectLogosById((state) => {
      const next = { ...state }
      delete next[projectId]
      return next
    })
    setProjectAccentColorsById((state) => {
      const next = { ...state }
      delete next[projectId]
      return next
    })
    if (projectSettingsProjectId === projectId) {
      setProjectSettingsProjectId(null)
      setProjectSettingsNameDraft('')
      setProjectSettingsLogoDraft('')
      setProjectSettingsAccentDraft('')
      setProjectSettingsError('')
    }
    void Promise.all([
      window.api.config.set(getProjectLogoKey(projectId), ''),
      window.api.config.set(getProjectAccentKey(projectId), '')
    ])
    if (selectedProjectId === projectId) {
      const remainingProjectId = projects.find((project) => project.id !== projectId)?.id
      if (remainingProjectId) {
        await selectProject(remainingProjectId)
      } else if (homeVisible) {
        await selectProject(undefined)
      } else {
        await window.api.project.select(undefined)
        setSelectedProjectId(undefined)
        setProjectScope(undefined)
        loadSidebarPrefs(undefined)
        setActiveTerminal(undefined)
      }
      setActionStatus('Project removed.')
      return
    }
    await refresh()
    setActionStatus('Project removed.')
  }

  const deleteHomeScope = useCallback(async (): Promise<void> => {
    if (!window.api) {
      return
    }

    const confirmed = window.confirm(
      'Delete "Home"? This closes Home tabs, removes Home spaces, and clears Home styling.'
    )
    if (!confirmed) {
      return
    }

    const homeTerminals = terminals.filter((terminal) => !terminal.projectId)
    const homeTerminalsById = new Map(homeTerminals.map((terminal) => [terminal.id, terminal]))
    const homeTerminalDepth = (terminalId: string): number => {
      let depth = 0
      let cursor = homeTerminalsById.get(terminalId)
      while (cursor?.parentTerminalId) {
        depth += 1
        cursor = homeTerminalsById.get(cursor.parentTerminalId)
      }
      return depth
    }

    const closeOrder = [...homeTerminals].sort(
      (a, b) => homeTerminalDepth(b.id) - homeTerminalDepth(a.id)
    )
    for (const terminal of closeOrder) {
      await closeTerminal(terminal.id)
    }

    setSpaceState((state) => ({
      ...state,
      spacesByScope: {
        ...state.spacesByScope,
        [HOME_PROJECT_SCOPE]: []
      },
      activeSpaceByScope: {
        ...state.activeSpaceByScope,
        [HOME_PROJECT_SCOPE]: undefined
      },
      terminalSpaceByScope: {
        ...state.terminalSpaceByScope,
        [HOME_PROJECT_SCOPE]: {}
      }
    }))

    if (projectScopeKey === HOME_PROJECT_SCOPE) {
      setActiveTerminal(undefined)
    }

    setProjectLogosById((state) => {
      const next = { ...state }
      delete next[HOME_PROJECT_SCOPE]
      return next
    })
    setProjectAccentColorsById((state) => {
      const next = { ...state }
      delete next[HOME_PROJECT_SCOPE]
      return next
    })

    if (projectSettingsProjectId === HOME_PROJECT_SCOPE) {
      setProjectSettingsProjectId(null)
      setProjectSettingsNameDraft('')
      setProjectSettingsLogoDraft('')
      setProjectSettingsAccentDraft('')
      setProjectSettingsError('')
    }

    const [, , visibilityResponse] = await Promise.all([
      window.api.config.set(getProjectLogoKey(HOME_PROJECT_SCOPE), ''),
      window.api.config.set(getProjectAccentKey(HOME_PROJECT_SCOPE), ''),
      window.api.config.set(HOME_VISIBILITY_CONFIG_KEY, '0')
    ])
    setHomeVisible(false)

    if (projectScopeKey === HOME_PROJECT_SCOPE) {
      const fallbackProjectId = projects[0]?.id
      if (fallbackProjectId) {
        await selectProject(fallbackProjectId)
      } else {
        const clearSelectionResponse = await window.api.project.select(undefined)
        const nextProjectId = clearSelectionResponse.ok
          ? clearSelectionResponse.data?.id
          : undefined
        setSelectedProjectId(nextProjectId)
        setProjectScope(nextProjectId)
        loadSidebarPrefs(nextProjectId)
        setActiveTerminal(undefined)
      }
    }

    await refresh()
    setActionStatus(
      visibilityResponse.ok
        ? 'Home removed.'
        : `Home removed, but visibility preference failed: ${visibilityResponse.error.message}`
    )
  }, [
    closeTerminal,
    projects,
    projectScopeKey,
    projectSettingsProjectId,
    refresh,
    selectProject,
    terminals,
    setActiveTerminal
  ])

  const deleteProjectEntry = useCallback(
    async (entry: ProjectEntry): Promise<void> => {
      if (entry.id) {
        await deleteProject(entry.id)
        return
      }
      await deleteHomeScope()
    },
    [deleteHomeScope, deleteProject]
  )

  const openProjectSettings = useCallback(
    (scopeKey: string): void => {
      const project =
        scopeKey === HOME_PROJECT_SCOPE
          ? undefined
          : projects.find((entry) => entry.id === scopeKey)
      if (scopeKey !== HOME_PROJECT_SCOPE && !project) {
        return
      }

      setProjectSettingsProjectId(scopeKey)
      setProjectSettingsNameDraft(project?.name || 'Home')
      setProjectSettingsLogoDraft(projectLogosById[scopeKey] || '')
      setProjectSettingsAccentDraft(projectAccentColorsById[scopeKey] || '')
      setProjectSettingsError('')
    },
    [projectAccentColorsById, projectLogosById, projects]
  )

  const closeProjectSettings = useCallback((): void => {
    if (projectSettingsSaving) {
      return
    }

    setProjectSettingsProjectId(null)
    setProjectSettingsNameDraft('')
    setProjectSettingsLogoDraft('')
    setProjectSettingsAccentDraft('')
    setProjectSettingsError('')
    if (projectLogoInputRef.current) {
      projectLogoInputRef.current.value = ''
    }
  }, [projectSettingsSaving])

  const saveProjectSettings = useCallback(async (): Promise<void> => {
    if (!window.api || !projectSettingsProjectId) {
      return
    }

    const normalizedName = projectSettingsNameDraft.trim()
    const savingHomeSettings = projectSettingsProjectId === HOME_PROJECT_SCOPE
    const normalizedAccentColor = normalizeAccentColor(projectSettingsAccentDraft)
    if (projectSettingsAccentDraft && !normalizedAccentColor) {
      setProjectSettingsError('Accent color must be a valid hex color.')
      return
    }
    if (!savingHomeSettings && !normalizedName) {
      setProjectSettingsError('Project name is required.')
      return
    }

    setProjectSettingsSaving(true)
    setProjectSettingsError('')

    if (!savingHomeSettings) {
      const updateResponse = await window.api.project.update({
        projectId: projectSettingsProjectId,
        name: normalizedName
      })
      if (!updateResponse.ok || !updateResponse.data) {
        setProjectSettingsError(
          updateResponse.ok ? 'Unable to update project.' : updateResponse.error.message
        )
        setProjectSettingsSaving(false)
        return
      }

      setProjects((previous) =>
        previous.map((project) =>
          project.id === projectSettingsProjectId ? updateResponse.data! : project
        )
      )
    }

    const [logoResponse, accentResponse] = await Promise.all([
      window.api.config.set(getProjectLogoKey(projectSettingsProjectId), projectSettingsLogoDraft),
      window.api.config.set(getProjectAccentKey(projectSettingsProjectId), normalizedAccentColor)
    ])

    if (logoResponse.ok) {
      setProjectLogosById((state) => {
        const next = { ...state }
        if (projectSettingsLogoDraft) {
          next[projectSettingsProjectId] = projectSettingsLogoDraft
        } else {
          delete next[projectSettingsProjectId]
        }
        return next
      })
    }

    if (accentResponse.ok) {
      setProjectAccentColorsById((state) => {
        const next = { ...state }
        if (normalizedAccentColor) {
          next[projectSettingsProjectId] = normalizedAccentColor
        } else {
          delete next[projectSettingsProjectId]
        }
        return next
      })
    }

    const saveErrors: string[] = []
    if (!logoResponse.ok) {
      saveErrors.push(`logo save failed: ${logoResponse.error.message}`)
    }
    if (!accentResponse.ok) {
      saveErrors.push(`accent save failed: ${accentResponse.error.message}`)
    }
    if (saveErrors.length > 0) {
      const failurePrefix = savingHomeSettings
        ? 'Home settings updated, but'
        : 'Project renamed, but'
      setProjectSettingsError(`${failurePrefix} ${saveErrors.join('; ')}`)
      setProjectSettingsSaving(false)
      return
    }

    setProjectSettingsSaving(false)
    setProjectSettingsProjectId(null)
    setProjectSettingsNameDraft('')
    setProjectSettingsLogoDraft('')
    setProjectSettingsAccentDraft('')
    setProjectSettingsError('')
    setActionStatus(
      savingHomeSettings ? 'Home settings saved.' : `Project settings saved for ${normalizedName}.`
    )
  }, [
    projectSettingsAccentDraft,
    projectSettingsLogoDraft,
    projectSettingsNameDraft,
    projectSettingsProjectId
  ])

  useEffect(() => {
    if (!projectSettingsProjectId) {
      return
    }
    if (projectSettingsProjectId === HOME_PROJECT_SCOPE) {
      return
    }

    const exists = projects.some((project) => project.id === projectSettingsProjectId)
    if (!exists) {
      setProjectSettingsProjectId(null)
      setProjectSettingsNameDraft('')
      setProjectSettingsLogoDraft('')
      setProjectSettingsAccentDraft('')
      setProjectSettingsError('')
    }
  }, [projectSettingsProjectId, projects])

  useEffect(() => {
    if (!projectSettingsProjectId) {
      return
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeProjectSettings()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [closeProjectSettings, projectSettingsProjectId])

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
    const entries: ProjectEntry[] = []
    if (homeVisible) {
      entries.push({ id: undefined, name: 'Home', scopeKey: HOME_PROJECT_SCOPE })
    }

    for (const project of projects) {
      entries.push({
        id: project.id,
        name: project.name,
        rootPath: project.rootPath,
        scopeKey: toScopeKey(project.id)
      })
    }

    return entries
  }, [homeVisible, projects])

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
        leftCollapsed={effectiveLeftCollapsed}
        rightCollapsed={effectiveRightCollapsed}
        terminalCollapsed={effectiveTerminalCollapsed}
        isDarkMode={resolvedTheme === 'dark'}
        activeAccentColor={selectedProjectAccentColor}
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
        {leftPanelVisible ? (
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

              {projectEntries.length === 0 ? (
                <NoProjectPlaceholder
                  compact
                  title="No Projects Yet"
                  description="Add a project to create spaces and start working."
                  onAddProject={() => void addProject()}
                />
              ) : (
                <div className="space-y-1.5">
                  {projectEntries.map((entry) => {
                    const isSelected = (selectedProjectId || undefined) === entry.id
                    const isExpanded = expandedProjectScopes[entry.scopeKey] ?? isSelected
                    const projectIsActive = Boolean(projectActivityByScope[entry.scopeKey])
                    const entryAccentColor = projectAccentColorsById[entry.scopeKey]
                    const entryAccentTint = entryAccentColor
                      ? getAccentTintOverlay(entryAccentColor, isSelected ? 0.17 : 0.12)
                      : undefined
                    const spacesForEntry =
                      spaceState.spacesByScope[entry.scopeKey] ||
                      (isSelected ? spacesForCurrentScope : [])
                    const entryActiveSpaceId =
                      spaceState.activeSpaceByScope[entry.scopeKey] || spacesForEntry[0]?.id

                    return (
                      <div
                        key={entry.scopeKey}
                        className={`overflow-hidden rounded-md border border-border/60 ${
                          isSelected ? 'bg-accent/30' : 'bg-transparent'
                        }`}
                      >
                        {entryAccentColor ? (
                          <div
                            className="h-1 w-full bg-card/95"
                            style={{
                              backgroundImage: entryAccentTint
                            }}
                          />
                        ) : null}
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
                            <ProjectAvatar
                              name={entry.name}
                              logoDataUrl={projectLogosById[entry.scopeKey]}
                              className="h-5 w-5"
                              textClassName="text-[11px]"
                            />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                              {entry.name}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <ActivityIndicator active={projectIsActive} />
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="h-5 w-5 shrink-0 text-muted-foreground opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
                                aria-label={`Settings for ${entry.name}`}
                                title={`Settings for ${entry.name}`}
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  openProjectSettings(entry.scopeKey)
                                }}
                              >
                                <Settings2 className="h-3 w-3" />
                              </Button>
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
                                  void deleteProjectEntry(entry)
                                }}
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
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
              )}

              {showActionStatus ? (
                <div className="rounded-md border border-border/70 bg-muted/50 p-2 text-xs text-muted-foreground">
                  {actionStatus}
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {!noProjectAvailable ? (
          <div
            ref={centerPanelRef}
            className="grid min-h-0 gap-1"
            style={
              terminalPanelCollapsed
                ? { gridTemplateRows: 'minmax(0, 1fr)' }
                : {
                    gridTemplateRows: `${centerTopPercent}% ${CENTER_SPLITTER_PX}px minmax(0, 1fr)`
                  }
            }
          >
            <Card className="min-h-0 flex flex-col overflow-hidden">
              <CardContent className="min-h-0 flex-1 p-2">
                {noProjectAvailable ? (
                  <NoProjectPlaceholder
                    title="No Project Selected"
                    description="Add a project to start chatting in a workspace."
                    onAddProject={() => void addProject()}
                  />
                ) : (
                  <AssistantChatPanel
                    activeScopeKey={projectScopeKey}
                    activeSpaceId={activeSpaceId}
                    sessions={chatSessions}
                    colorMode={resolvedTheme}
                    onStreamingChange={handleChatStreamingChange}
                  />
                )}
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
                  {noProjectAvailable ? (
                    <NoProjectPlaceholder
                      title="No Terminal Workspace"
                      description="Add a project to open terminals and run commands."
                      onAddProject={() => void addProject()}
                    />
                  ) : (
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
                  )}
                </CardContent>
              </Card>
            ) : null}
          </div>
        ) : null}

        {!noProjectAvailable && !rightCollapsed ? (
          <Card className="min-h-0 flex flex-col overflow-hidden">
            <CardContent className="min-h-0 flex-1 overflow-hidden p-1.5">
              {noProjectAvailable ? (
                <NoProjectPlaceholder
                  title="No Project Insights"
                  description="Add a project to browse files and review diffs."
                  onAddProject={() => void addProject()}
                />
              ) : (
                <Tabs
                  value={rightSidebarTab}
                  onValueChange={(value) => setRightSidebarTab(value as RightSidebarTab)}
                  className="flex h-full min-h-0 flex-col"
                >
                  <TabsList className="grid h-7 w-full grid-cols-2 rounded-md bg-muted/80 p-0.5">
                    <TabsTrigger
                      value="git-diff"
                      className="h-full w-full rounded-sm px-2 py-0 text-[11px] leading-none data-[state=active]:shadow-sm"
                    >
                      Git Diff
                    </TabsTrigger>
                    <TabsTrigger
                      value="file-tree"
                      className="h-full w-full rounded-sm px-2 py-0 text-[11px] leading-none data-[state=active]:shadow-sm"
                    >
                      File Tree
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent
                    value="git-diff"
                    className="mt-1.5 min-h-0 flex-1 overflow-y-auto space-y-2 text-xs"
                  >
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
                        <div className="space-y-2 rounded-md border border-border/70 p-2">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {showPrComposer ? 'Commit & PR Composer' : 'Commit Composer'}
                          </div>

                          <div className="space-y-1.5 rounded-md border border-border/70 p-2">
                            <div className="flex items-center gap-2">
                              <div className="text-xs font-medium">Commit</div>
                              <div
                                className={`ml-auto grid min-w-0 gap-1.5 ${
                                  isMainGitBranch ? 'w-[13rem] max-w-full grid-cols-2' : 'w-[7rem] max-w-full grid-cols-1'
                                }`}
                              >
                                {isMainGitBranch ? (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    className="h-7 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
                                    onClick={() => void handleGitPush()}
                                    disabled={!canPushMainInComposer}
                                  >
                                    {gitPushSubmitting ? 'Pushing...' : 'Push to Main'}
                                  </Button>
                                ) : null}
                                <Button
                                  type="button"
                                  size="sm"
                                  className="h-7 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
                                  onClick={() => void handleGitCommit()}
                                  disabled={!canCommitInComposer || Boolean(gitDiff.clean)}
                                >
                                  {gitCommitSubmitting ? 'Committing...' : 'Commit'}
                                </Button>
                              </div>
                            </div>
                            <textarea
                              value={gitCommitDraft}
                              onChange={(event) => setGitCommitDraft(event.target.value)}
                              placeholder="feat(scope): concise summary"
                              disabled={gitComposerBusy}
                              rows={2}
                              className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60"
                            />
                            <div className="text-[11px] text-muted-foreground">
                              If empty, message is auto-generated.
                            </div>
                            {isMainGitBranch ? (
                              <div className="text-[11px] text-muted-foreground">
                                On `main`, push committed changes directly when ready.
                              </div>
                            ) : null}
                          </div>

                          {showPrComposer ? (
                            <div className="space-y-1.5 rounded-md border border-border/70 p-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-xs font-medium">Pull Request</div>
                                <Button
                                  type="button"
                                  size="sm"
                                  className="h-7"
                                  onClick={() => void handleGitCreatePr()}
                                  disabled={!canCreatePrInComposer}
                                >
                                  {gitPrSubmitting ? 'Creating...' : 'Create PR'}
                                </Button>
                              </div>
                              <input
                                value={gitPrTitleDraft}
                                onChange={(event) => setGitPrTitleDraft(event.target.value)}
                                placeholder="PR title"
                                disabled={gitComposerBusy}
                                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60"
                              />
                              <textarea
                                value={gitPrBodyDraft}
                                onChange={(event) => setGitPrBodyDraft(event.target.value)}
                                placeholder="PR description"
                                disabled={gitComposerBusy}
                                rows={5}
                                className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60"
                              />
                              <div className="text-[11px] text-muted-foreground">
                                Missing fields are auto-generated.
                              </div>
                            </div>
                          ) : null}

                          {gitComposerStatus ? (
                            <div
                              className={`max-w-full overflow-hidden whitespace-pre-wrap break-all rounded-md border p-2 text-[11px] ${
                                gitComposerStatusTone === 'error'
                                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                                  : gitComposerStatusTone === 'success'
                                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                    : 'border-border/70 bg-muted/40 text-muted-foreground'
                              }`}
                            >
                              {gitComposerBusy ? (
                                <div className="flex items-center gap-1.5">
                                  <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
                                  <span className="min-w-0 truncate">{gitComposerProgressLabel}</span>
                                </div>
                              ) : null}
                              <div>{gitComposerStatus}</div>
                            </div>
                          ) : null}
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
                              const isPatchLoading = Boolean(gitDiffPatchLoadingByPath[diffFileKey])
                              const hasPatch = Boolean(file.patch && file.patch.trim().length > 0)
                              const canLoadPatch = Boolean(selectedProject?.rootPath)
                              const canOpenPatch = hasPatch || canLoadPatch

                              return (
                                <div
                                  key={file.path}
                                  className="rounded-md border border-border/70 p-1.5"
                                >
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
                                        onClick={() => void openGitDiffModal(file.path)}
                                        disabled={!canOpenPatch || isPatchLoading}
                                      >
                                        {isPatchLoading ? 'Loading...' : 'Full'}
                                      </button>
                                      <button
                                        type="button"
                                        className="rounded-sm border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                        onClick={() => void toggleGitDiffFile(file.path)}
                                        disabled={!canOpenPatch || isPatchLoading}
                                      >
                                        {isPatchLoading
                                          ? 'Loading...'
                                          : hasPatch
                                            ? expanded
                                              ? 'Hide Diff'
                                              : 'Show Diff'
                                            : 'Load Diff'}
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
                  </TabsContent>

                  <TabsContent value="file-tree" className="mt-1.5 min-h-0 flex-1 overflow-hidden">
                    <FileTreePanel
                      projectRootPath={selectedProject?.rootPath}
                      scopeKey={projectScopeKey}
                      spaceId={activeSpaceId}
                      colorMode={resolvedTheme}
                    />
                  </TabsContent>
                </Tabs>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>

      {projectSettingsProjectId ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3"
          onClick={() => closeProjectSettings()}
        >
          <div
            className="flex w-[min(620px,100%)] max-w-full flex-col overflow-hidden rounded-lg border border-border/70 bg-background shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">Project Settings</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {projectSettingsRootPath}
                </div>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => closeProjectSettings()}
                title="Close"
                aria-label="Close project settings"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="max-h-[70vh] overflow-y-auto p-3">
              <div className="space-y-1.5 rounded-md border border-border/70 p-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  General
                </div>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">Project Name</span>
                  <input
                    value={projectSettingsNameDraft}
                    disabled={projectSettingsIsHome}
                    onChange={(event) => {
                      setProjectSettingsNameDraft(event.target.value)
                      if (projectSettingsError) {
                        setProjectSettingsError('')
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void saveProjectSettings()
                      }
                    }}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    maxLength={120}
                  />
                </label>
                {projectSettingsIsHome ? (
                  <div className="text-[11px] text-muted-foreground">
                    Home name is fixed. Use logo and accent settings below.
                  </div>
                ) : null}
              </div>

              <div className="mt-2 space-y-2 rounded-md border border-border/70 p-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Space Logo
                </div>
                <div className="flex items-center gap-3">
                  <ProjectAvatar
                    name={projectSettingsNameDraft || projectSettingsDisplayName}
                    logoDataUrl={projectSettingsLogoDraft || undefined}
                    className="h-16 w-16 rounded-lg"
                    textClassName="text-2xl"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={projectLogoInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        event.target.value = ''
                        if (!file) {
                          return
                        }

                        if (!file.type.startsWith('image/')) {
                          setProjectSettingsError('Please choose an image file.')
                          return
                        }
                        if (file.size > MAX_PROJECT_LOGO_FILE_BYTES) {
                          setProjectSettingsError('Logo must be 2 MB or smaller.')
                          return
                        }

                        const reader = new FileReader()
                        reader.onload = () => {
                          if (typeof reader.result !== 'string') {
                            setProjectSettingsError('Unable to read image data.')
                            return
                          }
                          setProjectSettingsLogoDraft(reader.result)
                          setProjectSettingsError('')
                        }
                        reader.onerror = () => {
                          setProjectSettingsError('Unable to read selected image.')
                        }
                        reader.readAsDataURL(file)
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="h-8 gap-1"
                      onClick={() => projectLogoInputRef.current?.click()}
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Upload Logo
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8"
                      disabled={!projectSettingsLogoDraft}
                      onClick={() => {
                        setProjectSettingsLogoDraft('')
                        setProjectSettingsError('')
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Accepted: image files up to 2 MB.
                </div>
              </div>

              <div className="mt-2 space-y-2 rounded-md border border-border/70 p-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Accent Color
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className="h-9 w-9 shrink-0 rounded-md border border-border/70 bg-muted/40"
                    style={{
                      backgroundColor: projectSettingsAccentDraft || undefined
                    }}
                    aria-hidden="true"
                  />
                  <input
                    type="color"
                    aria-label="Project accent color"
                    value={projectSettingsAccentDraft || '#64748b'}
                    onChange={(event) => {
                      setProjectSettingsAccentDraft(normalizeAccentColor(event.target.value))
                      setProjectSettingsError('')
                    }}
                    className="h-8 w-11 shrink-0 cursor-pointer rounded-md border border-input bg-background p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  />
                  <div className="min-w-0 flex-1 truncate rounded-md border border-border/70 bg-muted/30 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                    {projectSettingsAccentDraft || 'No accent'}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8"
                    disabled={!projectSettingsAccentDraft}
                    onClick={() => {
                      setProjectSettingsAccentDraft('')
                      setProjectSettingsError('')
                    }}
                  >
                    Clear
                  </Button>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  The active title bar and this project card will use a subtle tint.
                </div>
              </div>

              <div className="mt-2 rounded-md border border-dashed border-border/70 bg-muted/30 p-2 text-xs text-muted-foreground">
                Additional settings will appear here.
              </div>

              {projectSettingsError ? (
                <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                  {projectSettingsError}
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border/70 px-3 py-2">
              <Button type="button" variant="ghost" onClick={() => closeProjectSettings()}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void saveProjectSettings()}
                disabled={projectSettingsSaving || projectSettingsNameDraft.trim().length === 0}
              >
                {projectSettingsSaving ? 'Saving...' : 'Save Settings'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

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
                  <span> </span>
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
                  <div>No patch content loaded for this file.</div>
                  <Button
                    type="button"
                    size="sm"
                    className="mt-2 h-7"
                    onClick={() => void ensureGitDiffPatch(gitDiffModalFile.path)}
                    disabled={Boolean(
                      gitDiffPatchLoadingByPath[getDiffFileKey(gitDiffModalFile.path)]
                    )}
                  >
                    {gitDiffPatchLoadingByPath[getDiffFileKey(gitDiffModalFile.path)]
                      ? 'Loading...'
                      : 'Load Diff'}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
