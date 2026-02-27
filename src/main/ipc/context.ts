import { ChatHistoryRepository } from '../data/repositories/chat-history-repository'
import { AgentOrchestratorService } from '../services/agent-orchestrator-service'
import { ConfigService } from '../services/config-service'
import { LoggerService } from '../services/logger'
import { ProjectService } from '../services/project-service'
import { TelemetryService } from '../services/telemetry'
import { TerminalSessionService } from '../services/terminal-session-service'

export type IpcContext = {
  logger: LoggerService
  telemetry: TelemetryService
  terminals: TerminalSessionService
  agents: AgentOrchestratorService
  config: ConfigService
  projects: ProjectService
  chatHistory: ChatHistoryRepository
}
