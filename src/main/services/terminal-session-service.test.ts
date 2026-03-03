import { describe, expect, it } from 'vitest'
import { TerminalSessionService } from './terminal-session-service'

type ExitPayload = { exitCode: number }

type PersistedSetting = {
  key: string
  value: string
}

class FakePtyProcess {
  private onExitHandler?: (payload: ExitPayload) => void
  private onDataHandler?: (chunk: string) => void

  onData(handler: (chunk: string) => void): void {
    this.onDataHandler = handler
  }

  onExit(handler: (payload: ExitPayload) => void): void {
    this.onExitHandler = handler
  }

  emitData(chunk: string): void {
    this.onDataHandler?.(chunk)
  }

  emitExit(exitCode: number): void {
    this.onExitHandler?.({ exitCode })
  }
}

class FakePtyProcessService {
  readonly processes = new Map<string, FakePtyProcess>()
  readonly writes: { terminalId: string; data: string }[] = []
  readonly resizes: { terminalId: string; cols: number; rows: number }[] = []
  killCalls = 0

  createProcess(id: string): FakePtyProcess {
    const proc = new FakePtyProcess()
    this.processes.set(id, proc)
    return proc
  }

  getDefaultCwd(): string {
    return '/tmp'
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.resizes.push({ terminalId, cols, rows })
  }

  write(terminalId: string, data: string): void {
    this.writes.push({ terminalId, data })
  }

  kill(id: string): void {
    this.killCalls += 1
    this.processes.delete(id)
  }

  disposeAll(options: { terminateProcesses?: boolean } = {}): void {
    if (options.terminateProcesses === false) {
      this.processes.clear()
      return
    }
    for (const id of [...this.processes.keys()]) {
      this.kill(id)
    }
  }
}

class FakeTelemetryService {
  outputEvents = 0
  lastActiveTerminals = 0

  onTerminalOutput(): void {
    this.outputEvents += 1
  }

  setActiveTerminals(count: number): void {
    this.lastActiveTerminals = count
  }
}

class FakeAppSettingsRepository {
  readonly values = new Map<string, string>()
  readonly setCalls: PersistedSetting[] = []
  throwOnSet?: Error

  get(key: string): string | undefined {
    return this.values.get(key)
  }

  set(key: string, value: string): PersistedSetting {
    if (this.throwOnSet) {
      throw this.throwOnSet
    }

    const record = { key, value }
    this.values.set(key, value)
    this.setCalls.push(record)
    return record
  }
}

function createService(options: { writeError?: Error } = {}): {
  service: TerminalSessionService
  pty: FakePtyProcessService
  settings: FakeAppSettingsRepository
} {
  const pty = new FakePtyProcessService()
  const telemetry = new FakeTelemetryService()
  const settings = new FakeAppSettingsRepository()
  settings.throwOnSet = options.writeError

  const service = new TerminalSessionService(
    pty as unknown as ConstructorParameters<typeof TerminalSessionService>[0],
    telemetry as unknown as ConstructorParameters<typeof TerminalSessionService>[1],
    settings as unknown as ConstructorParameters<typeof TerminalSessionService>[2]
  )

  return { service, pty, settings }
}

describe('TerminalSessionService', () => {
  it('numbers default terminal titles per project scope', () => {
    const { service } = createService()

    const home = service.createSession({})
    const project = service.createSession({ projectId: 'project-1' })
    const projectSecond = service.createSession({ projectId: 'project-1' })

    expect(home.title).toBe('Terminal 1')
    expect(project.title).toBe('Terminal 1')
    expect(projectSecond.title).toBe('Terminal 2')
  })

  it('does not persist layout when a late process exit arrives during disposeAll', () => {
    const { service, pty, settings } = createService()
    const session = service.createSession({ title: 'Shell' })
    const proc = pty.processes.get(session.id)

    expect(proc).toBeDefined()
    expect(settings.setCalls).toHaveLength(1)

    settings.setCalls.length = 0
    service.disposeAll()
    proc?.emitExit(0)

    expect(settings.setCalls).toHaveLength(0)
  })

  it('ignores database closed errors while persisting layout', () => {
    const { service } = createService({ writeError: new Error('database is not open') })

    expect(() => service.createSession({ title: 'Shell' })).not.toThrow()
  })

  it('can dispose without terminating child PTY processes', () => {
    const { service, pty } = createService()
    service.createSession({ title: 'Shell' })

    service.disposeAll({ terminateProcesses: false })

    expect(pty.killCalls).toBe(0)
    expect(pty.processes.size).toBe(0)
  })

  it('rethrows non-database persistence errors', () => {
    const { service } = createService({ writeError: new Error('write failed') })

    expect(() => service.createSession({ title: 'Shell' })).toThrow('write failed')
  })
})
