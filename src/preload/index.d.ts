import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AppSetting,
  AgentProfile,
  AgentTask,
  AgentEvent,
  ChatAbortInput,
  ChatCompleteInput,
  ChatCompleteResult,
  ChatEvent,
  ChatHistoryMessage,
  ChatHistoryReplaceInput,
  ChatHistoryScopeInput,
  CreateProjectInput,
  CreateAgentProfileInput,
  AssignAgentTerminalInput,
  CloseTerminalInput,
  CreateTerminalInput,
  DeleteProjectInput,
  UpdateProjectInput,
  RenameTerminalInput,
  DeleteAgentProfileInput,
  EnqueueAgentTaskInput,
  FileReadInput,
  FileReadResult,
  FileTreeInput,
  FileTreeEntry,
  FileTreeSearchInput,
  GitDiffInput,
  GitDiffSummary,
  IpcResult,
  RestartAgentInput,
  ResizeTerminalInput,
  StartAgentInput,
  StopAgentInput,
  ProjectRecord,
  SelectProjectInput,
  TerminalSession,
  AgentRecord,
  TerminalEvent,
  WriteTerminalInput
} from '../shared/ipc/types'

type AppApi = {
  health: () => Promise<IpcResult<{ status: string; timestamp: number }>>
  metrics: () => Promise<IpcResult<unknown>>
  logs: () => Promise<IpcResult<unknown>>
  gitDiff: (input: GitDiffInput) => Promise<IpcResult<GitDiffSummary>>
  fileTree: (input: FileTreeInput) => Promise<IpcResult<FileTreeEntry[]>>
  fileTreeSearch: (input: FileTreeSearchInput) => Promise<IpcResult<FileTreeEntry[]>>
  fileRead: (input: FileReadInput) => Promise<IpcResult<FileReadResult>>
  platform: () => Promise<IpcResult<string>>
  windowMinimize: () => Promise<IpcResult<boolean>>
  windowMaximize: () => Promise<IpcResult<boolean>>
  windowUnmaximize: () => Promise<IpcResult<boolean>>
  windowToggleMaximize: () => Promise<IpcResult<boolean>>
  windowClose: () => Promise<IpcResult<boolean>>
  windowIsMaximized: () => Promise<IpcResult<boolean>>
  selectDirectory: () => Promise<IpcResult<string | undefined>>
}

type TerminalApi = {
  create: (input: CreateTerminalInput) => Promise<IpcResult<TerminalSession>>
  write: (input: WriteTerminalInput) => Promise<IpcResult<boolean>>
  resize: (input: ResizeTerminalInput) => Promise<IpcResult<boolean>>
  rename: (input: RenameTerminalInput) => Promise<IpcResult<TerminalSession | undefined>>
  close: (input: CloseTerminalInput) => Promise<IpcResult<boolean>>
  list: () => Promise<IpcResult<TerminalSession[]>>
  onEvent: (callback: (event: TerminalEvent) => void) => () => void
}

type AgentApi = {
  start: (input: StartAgentInput, terminalId?: string) => Promise<IpcResult<unknown>>
  stop: (input: StopAgentInput) => Promise<IpcResult<unknown>>
  restart: (input: RestartAgentInput) => Promise<IpcResult<unknown>>
  assignTerminal: (input: AssignAgentTerminalInput) => Promise<IpcResult<unknown>>
  list: () => Promise<IpcResult<AgentRecord[]>>
  createProfile: (input: CreateAgentProfileInput) => Promise<IpcResult<AgentProfile>>
  listProfiles: () => Promise<IpcResult<AgentProfile[]>>
  deleteProfile: (input: DeleteAgentProfileInput) => Promise<IpcResult<boolean>>
  enqueueTask: (input: EnqueueAgentTaskInput) => Promise<IpcResult<AgentTask>>
  listTasks: () => Promise<IpcResult<AgentTask[]>>
  onEvent: (callback: (event: AgentEvent) => void) => () => void
}

type ConfigApi = {
  get: (key: string) => Promise<IpcResult<string | undefined>>
  set: (key: string, value: string) => Promise<IpcResult<unknown>>
  all: () => Promise<IpcResult<AppSetting[]>>
}

type ChatApi = {
  complete: (input: ChatCompleteInput) => Promise<IpcResult<ChatCompleteResult>>
  abort: (input: ChatAbortInput) => Promise<IpcResult<boolean>>
  historyGet: (input: ChatHistoryScopeInput) => Promise<IpcResult<ChatHistoryMessage[]>>
  historyReplace: (input: ChatHistoryReplaceInput) => Promise<IpcResult<boolean>>
  onEvent: (callback: (event: ChatEvent) => void) => () => void
}

type ProjectApi = {
  create: (input: CreateProjectInput) => Promise<IpcResult<ProjectRecord>>
  list: () => Promise<IpcResult<ProjectRecord[]>>
  update: (input: UpdateProjectInput) => Promise<IpcResult<ProjectRecord | undefined>>
  delete: (input: DeleteProjectInput) => Promise<IpcResult<boolean>>
  select: (input?: SelectProjectInput) => Promise<IpcResult<ProjectRecord | undefined>>
  current: () => Promise<IpcResult<ProjectRecord | undefined>>
}

type SoloAgentApi = {
  app: AppApi
  terminal: TerminalApi
  agent: AgentApi
  chat: ChatApi
  config: ConfigApi
  project: ProjectApi
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: SoloAgentApi
  }
}
