import { randomUUID } from 'node:crypto'
import type {
  AgentProfile,
  AgentEvent,
  AgentRecord,
  AgentStatus,
  AgentTask,
  AssignAgentTerminalInput,
  CreateAgentProfileInput,
  DeleteAgentProfileInput,
  EnqueueAgentTaskInput,
  RestartAgentInput,
  StartAgentInput,
  StopAgentInput
} from '../../shared/ipc/types'
import { AgentProfilesRepository } from '../data/repositories/agent-profiles-repository'
import { LocalCliAdapter } from '../orchestration/local-cli-adapter'
import { RemoteAdapterStub } from '../orchestration/remote-adapter'
import type { ProviderAdapter } from '../orchestration/provider-adapter'
import { TelemetryService } from './telemetry'

type Listener = (event: AgentEvent) => void

export class AgentOrchestratorService {
  private readonly agents = new Map<string, AgentRecord>()
  private readonly tasks = new Map<string, AgentTask>()
  private readonly listeners = new Set<Listener>()
  private readonly adapters: Record<'local-cli' | 'remote', ProviderAdapter>
  private processingQueue = false

  constructor(
    private readonly telemetry: TelemetryService,
    private readonly profilesRepository: AgentProfilesRepository
  ) {
    this.adapters = {
      'local-cli': new LocalCliAdapter(),
      remote: new RemoteAdapterStub()
    }
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(agentId: string, status: AgentStatus, message?: string): void {
    for (const listener of this.listeners) {
      listener({ type: 'status', agentId, status, message })
    }
  }

  async start(
    input: StartAgentInput,
    terminalId?: string,
    projectId?: string
  ): Promise<AgentRecord> {
    const id = randomUUID()
    const assignedTerminalId = terminalId || randomUUID()
    const adapter = this.adapters[input.provider]
    const base = await adapter.start(input, { terminalId: assignedTerminalId })
    const record: AgentRecord = {
      id,
      name: input.name,
      provider: input.provider,
      projectId,
      command: base.command || input.command,
      args: base.args || input.args,
      terminalId: base.terminalId || assignedTerminalId,
      status: base.status || 'running',
      createdAt: Date.now()
    }
    this.agents.set(id, record)
    this.telemetry.setActiveAgents(this.runningCount())
    this.emit(id, record.status, 'Agent started')
    return record
  }

  async stop(input: StopAgentInput): Promise<AgentRecord | undefined> {
    const record = this.agents.get(input.agentId)
    if (!record) return undefined
    await this.adapters[record.provider].stop(record)
    record.status = 'stopped'
    this.telemetry.setActiveAgents(this.runningCount())
    this.emit(record.id, 'stopped', 'Agent stopped')
    return record
  }

  async restart(input: RestartAgentInput): Promise<AgentRecord | undefined> {
    const record = this.agents.get(input.agentId)
    if (!record) return undefined
    await this.stop({ agentId: record.id })
    record.status = 'running'
    this.telemetry.setActiveAgents(this.runningCount())
    this.emit(record.id, 'running', 'Agent restarted')
    return record
  }

  assignTerminal(input: AssignAgentTerminalInput, projectId?: string): AgentRecord | undefined {
    const record = this.agents.get(input.agentId)
    if (!record) return undefined
    if ((projectId && record.projectId !== projectId) || (!projectId && record.projectId)) {
      return undefined
    }
    record.terminalId = input.terminalId
    this.emit(record.id, record.status, 'Terminal assigned')
    return record
  }

  list(projectId?: string): AgentRecord[] {
    return [...this.agents.values()]
      .filter((agent) => (projectId ? agent.projectId === projectId : !agent.projectId))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  createProfile(input: CreateAgentProfileInput, projectId?: string): AgentProfile {
    return this.profilesRepository.create(input, projectId)
  }

  listProfiles(projectId?: string): AgentProfile[] {
    return this.profilesRepository.list(projectId)
  }

  deleteProfile(input: DeleteAgentProfileInput, projectId?: string): boolean {
    return this.profilesRepository.delete(input, projectId)
  }

  enqueueTask(input: EnqueueAgentTaskInput, projectId?: string): AgentTask {
    const task: AgentTask = {
      id: randomUUID(),
      projectId,
      title: input.title,
      profileId: input.profileId,
      agentId: input.agentId,
      status: 'queued',
      createdAt: Date.now()
    }
    this.tasks.set(task.id, task)
    this.processTaskQueue()
    return task
  }

  listTasks(projectId?: string): AgentTask[] {
    return [...this.tasks.values()]
      .filter((task) => (projectId ? task.projectId === projectId : !task.projectId))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  private async processTaskQueue(): Promise<void> {
    if (this.processingQueue) return
    this.processingQueue = true

    try {
      while (true) {
        const nextTask = [...this.tasks.values()]
          .filter((task) => task.status === 'queued')
          .sort((a, b) => a.createdAt - b.createdAt)[0]

        if (!nextTask) {
          break
        }

        nextTask.status = 'running'
        nextTask.startedAt = Date.now()

        // Placeholder processing for phase 2 queue scaffolding.
        await new Promise((resolve) => setTimeout(resolve, 350))

        nextTask.status = 'completed'
        nextTask.completedAt = Date.now()
      }
    } finally {
      this.processingQueue = false
    }
  }

  runningCount(): number {
    return [...this.agents.values()].filter((a) => a.status === 'running').length
  }
}
