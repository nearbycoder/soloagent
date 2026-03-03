export type ThemePreference = 'light' | 'dark' | 'system'

export type TerminalSession = {
  id: string
  title: string
  cwd: string
  projectId?: string
  parentTerminalId?: string
  cols: number
  rows: number
  status: 'running' | 'stopped'
  createdAt: number
}

export type CreateTerminalInput = {
  title?: string
  cwd?: string
  projectId?: string
  parentTerminalId?: string
  shell?: string
  cols?: number
  rows?: number
}

export type WriteTerminalInput = {
  terminalId: string
  data: string
}

export type ResizeTerminalInput = {
  terminalId: string
  cols: number
  rows: number
}

export type CloseTerminalInput = {
  terminalId: string
}

export type RenameTerminalInput = {
  terminalId: string
  title: string
}

export type ProjectRecord = {
  id: string
  name: string
  rootPath: string
  createdAt: number
}

export type CreateProjectInput = {
  name?: string
  rootPath: string
}

export type DeleteProjectInput = {
  projectId: string
}

export type UpdateProjectInput = {
  projectId: string
  name: string
}

export type SelectProjectInput = {
  projectId?: string
}

export type TerminalOutputEvent = {
  type: 'output'
  terminalId: string
  chunk: string
}

export type TerminalExitEvent = {
  type: 'exit'
  terminalId: string
  exitCode: number
}

export type TerminalEvent = TerminalOutputEvent | TerminalExitEvent

export type AgentProvider = 'local-cli' | 'remote'
export type AgentStatus = 'idle' | 'running' | 'stopped' | 'error'

export type AgentRecord = {
  id: string
  name: string
  provider: AgentProvider
  projectId?: string
  command?: string
  args?: string[]
  terminalId?: string
  status: AgentStatus
  createdAt: number
}

export type StartAgentInput = {
  name: string
  provider: AgentProvider
  command?: string
  args?: string[]
  cwd?: string
}

export type StopAgentInput = {
  agentId: string
}

export type RestartAgentInput = {
  agentId: string
}

export type AssignAgentTerminalInput = {
  agentId: string
  terminalId: string
}

export type AgentEvent = {
  type: 'status'
  agentId: string
  status: AgentStatus
  message?: string
}

export type AgentProfile = {
  id: string
  projectId?: string
  name: string
  provider: AgentProvider
  command?: string
  args?: string[]
  createdAt: number
}

export type CreateAgentProfileInput = {
  name: string
  provider: AgentProvider
  command?: string
  args?: string[]
}

export type DeleteAgentProfileInput = {
  profileId: string
}

export type AgentTaskStatus = 'queued' | 'running' | 'completed' | 'failed'

export type AgentTask = {
  id: string
  projectId?: string
  title: string
  profileId?: string
  agentId?: string
  status: AgentTaskStatus
  createdAt: number
  startedAt?: number
  completedAt?: number
}

export type EnqueueAgentTaskInput = {
  title: string
  profileId?: string
  agentId?: string
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ChatReasoningEffort = 'low' | 'medium' | 'high'

export type ChatCompleteInput = {
  requestId: string
  model: string
  reasoningEffort?: ChatReasoningEffort
  messages: ChatMessage[]
  cwd?: string
}

export type ChatToolCall = {
  id: string
  type: string
  title: string
  status: 'in_progress' | 'completed' | 'failed'
  details?: string
  exitCode?: number
}

export type ChatCompleteSegment = {
  text: string
  toolCalls: ChatToolCall[]
}

export type ChatCompleteResult = {
  text: string
  model: string
  toolCalls: ChatToolCall[]
  segments?: ChatCompleteSegment[]
}

export type ChatAbortInput = {
  requestId: string
}

export type ChatUploadAttachmentInput = {
  scopeKey: string
  spaceId: string
  projectId?: string
  fileName: string
  dataUrl: string
}

export type ChatUploadAttachmentResult = {
  fileName: string
  url: string
  bytes: number
}

export type ChatToolCallEvent = {
  type: 'tool_call'
  requestId: string
  toolCall: ChatToolCall
}

export type ChatEvent = ChatToolCallEvent

export type ChatHistoryMessage = {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string
  createdAt: number
}

export type ChatHistoryScopeInput = {
  scopeKey: string
  spaceId: string
  projectId?: string
}

export type ChatHistoryReplaceInput = ChatHistoryScopeInput & {
  messages: ChatHistoryMessage[]
}

export type GitDiffInput = {
  cwd: string
}

export type GitDiffFilePatchInput = {
  cwd: string
  path: string
  status?: string
}

export type GitDiffFilePatchResult = {
  path: string
  additions: number
  deletions: number
  hunks: GitDiffHunk[]
  patch?: string
}

export type GitCommitInput = {
  cwd: string
  message?: string
}

export type GitCommitResult = {
  commitMessage: string
  commitHash: string
}

export type GitCreatePrInput = {
  cwd: string
  title?: string
  body?: string
}

export type GitCreatePrResult = {
  title: string
  body: string
  url?: string
  baseBranch?: string
  headBranch: string
}

export type GitPushInput = {
  cwd: string
}

export type GitPushResult = {
  remote: string
  branch: string
}

export type FileTreeInput = {
  cwd: string
  relativePath?: string
}

export type FileTreeSearchInput = {
  cwd: string
  query: string
  limit?: number
}

export type FileReadInput = {
  cwd: string
  path: string
  maxBytes?: number
}

export type FileTreeEntry = {
  name: string
  path: string
  type: 'file' | 'directory'
  gitStatus?:
    | 'modified'
    | 'added'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'typechange'
    | 'conflict'
    | 'untracked'
}

export type FileReadResult = {
  path: string
  content: string
  truncated: boolean
}

export type GitDiffHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
}

export type GitDiffFileChange = {
  path: string
  status: string
  additions: number
  deletions: number
  hunks: GitDiffHunk[]
  patch?: string
}

export type GitDiffSummary = {
  branch: string
  ahead: number
  behind: number
  files: GitDiffFileChange[]
  changedFiles: number
  totalAdditions: number
  totalDeletions: number
  clean: boolean
}

export type AppSetting = {
  key: string
  value: string
}

export type PerformanceMetrics = {
  activeTerminals: number
  activeAgents: number
  outputEventsPerMinute: number
  bufferedChunks: number
}

export type IpcSuccess<T> = {
  ok: true
  data: T
}

export type IpcFailure = {
  ok: false
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type IpcResult<T> = IpcSuccess<T> | IpcFailure
