import { randomUUID } from 'node:crypto'
import { AppSettingsRepository } from '../data/repositories/app-settings-repository'
import type {
  CloseTerminalInput,
  CreateTerminalInput,
  ResizeTerminalInput,
  RenameTerminalInput,
  TerminalEvent,
  TerminalSession,
  WriteTerminalInput
} from '../../shared/ipc/types'
import { PtyProcessService } from './pty-process-service'
import { TelemetryService } from './telemetry'

type Listener = (event: TerminalEvent) => void
type PersistedTerminalLayoutItem = {
  id: string
  title: string
  cwd: string
  projectId?: string
  parentTerminalId?: string
  cols: number
  rows: number
  createdAt: number
}

type DisposeOptions = {
  terminateProcesses?: boolean
}

function isDatabaseNotOpenError(error: unknown): boolean {
  return error instanceof Error && /database is not open/i.test(error.message)
}

function sanitizeTerminalChunk(chunk: string): string {
  // Strip private-use glyphs (commonly prompt theme icons that render as empty boxes).
  return chunk.replace(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, '')
}

const HOME_PROJECT_SCOPE = '__home__'

export class TerminalSessionService {
  private readonly sessions = new Map<string, TerminalSession>()
  private readonly listeners = new Set<Listener>()
  private readonly restoredScopes = new Set<string>()
  private isDisposing = false

  constructor(
    private readonly ptyService: PtyProcessService,
    private readonly telemetry: TelemetryService,
    private readonly appSettingsRepository: AppSettingsRepository
  ) {}

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: TerminalEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private toScopeKey(projectId?: string): string {
    return projectId || HOME_PROJECT_SCOPE
  }

  private toLayoutStorageKey(projectId?: string): string {
    return `workspace.terminalLayout.${this.toScopeKey(projectId)}`
  }

  private scopedSessions(projectId?: string): TerminalSession[] {
    return [...this.sessions.values()]
      .filter((session) => (projectId ? session.projectId === projectId : !session.projectId))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  private nextScopedTerminalTitle(projectId?: string): string {
    return `Terminal ${this.scopedSessions(projectId).length + 1}`
  }

  private persistScopeLayout(projectId?: string): void {
    if (this.isDisposing) {
      return
    }

    const scoped = this.scopedSessions(projectId)
    const serialized: PersistedTerminalLayoutItem[] = scoped.map((session) => ({
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      projectId: session.projectId,
      parentTerminalId: session.parentTerminalId,
      cols: session.cols,
      rows: session.rows,
      createdAt: session.createdAt
    }))
    try {
      this.appSettingsRepository.set(this.toLayoutStorageKey(projectId), JSON.stringify(serialized))
    } catch (error) {
      if (isDatabaseNotOpenError(error)) {
        return
      }
      throw error
    }
  }

  private readScopeLayout(projectId?: string): PersistedTerminalLayoutItem[] {
    const raw = this.appSettingsRepository.get(this.toLayoutStorageKey(projectId))
    if (!raw) return []

    try {
      const parsed = JSON.parse(raw) as PersistedTerminalLayoutItem[]
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (item) =>
          item &&
          typeof item === 'object' &&
          typeof item.id === 'string' &&
          typeof item.cwd === 'string' &&
          typeof item.cols === 'number' &&
          typeof item.rows === 'number' &&
          typeof item.createdAt === 'number'
      )
    } catch {
      return []
    }
  }

  private createSessionInternal(
    input: CreateTerminalInput,
    seed?: { id?: string; createdAt?: number; title?: string }
  ): TerminalSession {
    const id = seed?.id && !this.sessions.has(seed.id) ? seed.id : randomUUID()
    const cols = input.cols ?? 120
    const rows = input.rows ?? 32
    const cwd = input.cwd || this.ptyService.getDefaultCwd()
    const session: TerminalSession = {
      id,
      title: seed?.title || input.title || this.nextScopedTerminalTitle(input.projectId),
      cwd,
      projectId: input.projectId,
      parentTerminalId: input.parentTerminalId,
      cols,
      rows,
      status: 'running',
      createdAt: seed?.createdAt ?? Date.now()
    }

    const proc = this.ptyService.createProcess(id, {
      cols,
      rows,
      cwd,
      shell: input.shell
    })

    proc.onData((chunk) => {
      const sanitizedChunk = sanitizeTerminalChunk(chunk)
      if (!sanitizedChunk) return
      this.telemetry.onTerminalOutput()
      this.emit({ type: 'output', terminalId: id, chunk: sanitizedChunk })
    })

    proc.onExit(({ exitCode }) => {
      // Terminal may already be removed by explicit close.
      if (!this.sessions.has(id)) return
      this.handleProcessExit(id, exitCode)
    })

    this.sessions.set(id, session)
    this.telemetry.setActiveTerminals(this.countRunning())
    return session
  }

  private restoreScopeLayoutIfNeeded(projectId?: string): void {
    const scopeKey = this.toScopeKey(projectId)
    if (this.restoredScopes.has(scopeKey)) return
    this.restoredScopes.add(scopeKey)

    if (this.scopedSessions(projectId).length > 0) return

    const layout = this.readScopeLayout(projectId)
    if (!layout.length) return

    const sorted = [...layout].sort((a, b) => a.createdAt - b.createdAt)
    const restoredIds = new Set<string>()
    const pending = [...sorted]
    let progressed = true

    while (pending.length > 0 && progressed) {
      progressed = false

      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const item = pending[index]
        const parentReady =
          !item.parentTerminalId ||
          restoredIds.has(item.parentTerminalId) ||
          this.sessions.has(item.parentTerminalId)

        if (!parentReady) continue

        this.createSessionInternal(
          {
            title: item.title,
            cwd: item.cwd,
            projectId: item.projectId,
            parentTerminalId:
              item.parentTerminalId &&
              (restoredIds.has(item.parentTerminalId) || this.sessions.has(item.parentTerminalId))
                ? item.parentTerminalId
                : undefined,
            cols: item.cols,
            rows: item.rows
          },
          { id: item.id, createdAt: item.createdAt, title: item.title }
        )

        restoredIds.add(item.id)
        pending.splice(index, 1)
        progressed = true
      }
    }

    // If any entries had invalid/missing parent references, restore as root terminals.
    for (const item of pending) {
      this.createSessionInternal(
        {
          title: item.title,
          cwd: item.cwd,
          projectId: item.projectId,
          cols: item.cols,
          rows: item.rows
        },
        { id: item.id, createdAt: item.createdAt, title: item.title }
      )
    }

    this.telemetry.setActiveTerminals(this.countRunning())
  }

  private closeSessionTree(terminalId: string, rootExitCode: number): void {
    const session = this.sessions.get(terminalId)
    if (!session) return

    const idsToClose = new Set<string>([terminalId])
    const affectedScopeKeys = new Set<string>([this.toScopeKey(session.projectId)])
    let hasNewChildren = true
    while (hasNewChildren) {
      hasNewChildren = false
      for (const candidate of this.sessions.values()) {
        if (candidate.parentTerminalId && idsToClose.has(candidate.parentTerminalId)) {
          if (!idsToClose.has(candidate.id)) {
            idsToClose.add(candidate.id)
            affectedScopeKeys.add(this.toScopeKey(candidate.projectId))
            hasNewChildren = true
          }
        }
      }
    }

    for (const id of idsToClose) {
      this.sessions.delete(id)
      this.ptyService.kill(id)
      this.emit({ type: 'exit', terminalId: id, exitCode: id === terminalId ? rootExitCode : 0 })
    }

    for (const scopeKey of affectedScopeKeys) {
      this.persistScopeLayout(scopeKey === HOME_PROJECT_SCOPE ? undefined : scopeKey)
    }

    this.telemetry.setActiveTerminals(this.countRunning())
  }

  private handleProcessExit(terminalId: string, exitCode: number): void {
    const session = this.sessions.get(terminalId)
    if (!session) return

    if (!session.parentTerminalId) {
      const directChildren = [...this.sessions.values()]
        .filter((candidate) => candidate.parentTerminalId === terminalId)
        .sort((a, b) => a.createdAt - b.createdAt)

      if (directChildren.length > 0) {
        const promotedRoot = directChildren[0]
        const affectedScopeKeys = new Set<string>([this.toScopeKey(session.projectId)])
        affectedScopeKeys.add(this.toScopeKey(promotedRoot.projectId))

        promotedRoot.parentTerminalId = undefined
        promotedRoot.createdAt = session.createdAt

        for (const sibling of directChildren.slice(1)) {
          sibling.parentTerminalId = promotedRoot.id
          affectedScopeKeys.add(this.toScopeKey(sibling.projectId))
        }

        this.sessions.delete(terminalId)
        this.ptyService.kill(terminalId)
        this.emit({ type: 'exit', terminalId, exitCode })

        for (const scopeKey of affectedScopeKeys) {
          this.persistScopeLayout(scopeKey === HOME_PROJECT_SCOPE ? undefined : scopeKey)
        }

        this.telemetry.setActiveTerminals(this.countRunning())
        return
      }
    }

    this.closeSessionTree(terminalId, exitCode)
  }

  createSession(input: CreateTerminalInput): TerminalSession {
    const session = this.createSessionInternal(input)
    this.persistScopeLayout(session.projectId)
    return session
  }

  write(input: WriteTerminalInput): void {
    this.ptyService.write(input.terminalId, input.data)
  }

  resize(input: ResizeTerminalInput): void {
    this.ptyService.resize(input.terminalId, input.cols, input.rows)
    const session = this.sessions.get(input.terminalId)
    if (session) {
      session.cols = input.cols
      session.rows = input.rows
      this.persistScopeLayout(session.projectId)
    }
  }

  close(input: CloseTerminalInput): void {
    this.closeSessionTree(input.terminalId, 0)
  }

  rename(input: RenameTerminalInput): TerminalSession | undefined {
    const session = this.sessions.get(input.terminalId)
    if (!session) return undefined
    const normalized = input.title.trim()
    if (!normalized) return session
    session.title = normalized
    this.persistScopeLayout(session.projectId)
    return session
  }

  getSession(terminalId: string): TerminalSession | undefined {
    return this.sessions.get(terminalId)
  }

  list(projectId?: string): TerminalSession[] {
    this.restoreScopeLayoutIfNeeded(projectId)
    return this.scopedSessions(projectId)
  }

  countRunning(): number {
    return [...this.sessions.values()].filter((s) => s.status === 'running').length
  }

  disposeAll(options: DisposeOptions = {}): void {
    this.isDisposing = true
    for (const session of this.sessions.values()) {
      session.status = 'stopped'
    }
    this.sessions.clear()
    this.ptyService.disposeAll(options)
    this.telemetry.setActiveTerminals(0)
  }
}
