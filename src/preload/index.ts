import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { ipcChannels } from '../shared/ipc/channels'
import type {
  AgentEvent,
  AssignAgentTerminalInput,
  ChatAbortInput,
  ChatCompleteInput,
  ChatEvent,
  ChatHistoryReplaceInput,
  ChatHistoryScopeInput,
  ChatUploadAttachmentInput,
  CloseTerminalInput,
  CreateTerminalInput,
  RenameTerminalInput,
  CreateAgentProfileInput,
  DeleteAgentProfileInput,
  DeleteProjectInput,
  UpdateProjectInput,
  EnqueueAgentTaskInput,
  GitCommitInput,
  GitCreatePrInput,
  GitPushInput,
  GitDiffFilePatchInput,
  FileReadInput,
  FileTreeInput,
  FileTreeSearchInput,
  GitDiffInput,
  ResizeTerminalInput,
  RestartAgentInput,
  StartAgentInput,
  StopAgentInput,
  CreateProjectInput,
  SelectProjectInput,
  TerminalEvent,
  WriteTerminalInput
} from '../shared/ipc/types'

type Unsubscribe = () => void

const appApi = {
  health: () => ipcRenderer.invoke(ipcChannels.app.health),
  metrics: () => ipcRenderer.invoke(ipcChannels.app.metrics),
  logs: () => ipcRenderer.invoke(ipcChannels.app.logs),
  gitDiff: (input: GitDiffInput) => ipcRenderer.invoke(ipcChannels.app.gitDiff, input),
  gitDiffFilePatch: (input: GitDiffFilePatchInput) =>
    ipcRenderer.invoke(ipcChannels.app.gitDiffFilePatch, input),
  gitCommit: (input: GitCommitInput) => ipcRenderer.invoke(ipcChannels.app.gitCommit, input),
  gitCreatePr: (input: GitCreatePrInput) => ipcRenderer.invoke(ipcChannels.app.gitCreatePr, input),
  gitPush: (input: GitPushInput) => ipcRenderer.invoke(ipcChannels.app.gitPush, input),
  fileTree: (input: FileTreeInput) => ipcRenderer.invoke(ipcChannels.app.fileTree, input),
  fileTreeSearch: (input: FileTreeSearchInput) =>
    ipcRenderer.invoke(ipcChannels.app.fileTreeSearch, input),
  fileRead: (input: FileReadInput) => ipcRenderer.invoke(ipcChannels.app.fileRead, input),
  platform: () => ipcRenderer.invoke(ipcChannels.app.platform),
  windowMinimize: () => ipcRenderer.invoke(ipcChannels.app.windowMinimize),
  windowMaximize: () => ipcRenderer.invoke(ipcChannels.app.windowMaximize),
  windowUnmaximize: () => ipcRenderer.invoke(ipcChannels.app.windowUnmaximize),
  windowToggleMaximize: () => ipcRenderer.invoke(ipcChannels.app.windowToggleMaximize),
  windowClose: () => ipcRenderer.invoke(ipcChannels.app.windowClose),
  windowIsMaximized: () => ipcRenderer.invoke(ipcChannels.app.windowIsMaximized),
  selectDirectory: () => ipcRenderer.invoke(ipcChannels.app.selectDirectory)
}

const terminalApi = {
  create: (input: CreateTerminalInput) => ipcRenderer.invoke(ipcChannels.terminal.create, input),
  write: (input: WriteTerminalInput) => ipcRenderer.invoke(ipcChannels.terminal.write, input),
  resize: (input: ResizeTerminalInput) => ipcRenderer.invoke(ipcChannels.terminal.resize, input),
  rename: (input: RenameTerminalInput) => ipcRenderer.invoke(ipcChannels.terminal.rename, input),
  close: (input: CloseTerminalInput) => ipcRenderer.invoke(ipcChannels.terminal.close, input),
  list: () => ipcRenderer.invoke(ipcChannels.terminal.list),
  onEvent: (callback: (event: TerminalEvent) => void): Unsubscribe => {
    const handler = (_event: Electron.IpcRendererEvent, data: TerminalEvent): void => callback(data)
    ipcRenderer.on(ipcChannels.terminal.event, handler)
    return (): void => {
      ipcRenderer.removeListener(ipcChannels.terminal.event, handler)
    }
  }
}

const agentApi = {
  start: (input: StartAgentInput, terminalId?: string) =>
    ipcRenderer.invoke(ipcChannels.agent.start, input, terminalId),
  stop: (input: StopAgentInput) => ipcRenderer.invoke(ipcChannels.agent.stop, input),
  restart: (input: RestartAgentInput) => ipcRenderer.invoke(ipcChannels.agent.restart, input),
  assignTerminal: (input: AssignAgentTerminalInput) =>
    ipcRenderer.invoke(ipcChannels.agent.assignTerminal, input),
  list: () => ipcRenderer.invoke(ipcChannels.agent.list),
  createProfile: (input: CreateAgentProfileInput) =>
    ipcRenderer.invoke(ipcChannels.agent.createProfile, input),
  listProfiles: () => ipcRenderer.invoke(ipcChannels.agent.listProfiles),
  deleteProfile: (input: DeleteAgentProfileInput) =>
    ipcRenderer.invoke(ipcChannels.agent.deleteProfile, input),
  enqueueTask: (input: EnqueueAgentTaskInput) =>
    ipcRenderer.invoke(ipcChannels.agent.enqueueTask, input),
  listTasks: () => ipcRenderer.invoke(ipcChannels.agent.listTasks),
  onEvent: (callback: (event: AgentEvent) => void): Unsubscribe => {
    const handler = (_event: Electron.IpcRendererEvent, data: AgentEvent): void => callback(data)
    ipcRenderer.on(ipcChannels.agent.event, handler)
    return (): void => {
      ipcRenderer.removeListener(ipcChannels.agent.event, handler)
    }
  }
}

const configApi = {
  get: (key: string) => ipcRenderer.invoke(ipcChannels.config.get, { key }),
  set: (key: string, value: string) => ipcRenderer.invoke(ipcChannels.config.set, { key, value }),
  all: () => ipcRenderer.invoke(ipcChannels.config.all)
}

const chatApi = {
  complete: (input: ChatCompleteInput) => ipcRenderer.invoke(ipcChannels.chat.complete, input),
  abort: (input: ChatAbortInput) => ipcRenderer.invoke(ipcChannels.chat.abort, input),
  uploadAttachment: (input: ChatUploadAttachmentInput) =>
    ipcRenderer.invoke(ipcChannels.chat.uploadAttachment, input),
  historyGet: (input: ChatHistoryScopeInput) =>
    ipcRenderer.invoke(ipcChannels.chat.historyGet, input),
  historyReplace: (input: ChatHistoryReplaceInput) =>
    ipcRenderer.invoke(ipcChannels.chat.historyReplace, input),
  onEvent: (callback: (event: ChatEvent) => void): Unsubscribe => {
    const handler = (_event: Electron.IpcRendererEvent, data: ChatEvent): void => callback(data)
    ipcRenderer.on(ipcChannels.chat.event, handler)
    return (): void => {
      ipcRenderer.removeListener(ipcChannels.chat.event, handler)
    }
  }
}

const projectApi = {
  create: (input: CreateProjectInput) => ipcRenderer.invoke(ipcChannels.project.create, input),
  list: () => ipcRenderer.invoke(ipcChannels.project.list),
  update: (input: UpdateProjectInput) => ipcRenderer.invoke(ipcChannels.project.update, input),
  delete: (input: DeleteProjectInput) => ipcRenderer.invoke(ipcChannels.project.delete, input),
  select: (input?: SelectProjectInput) => ipcRenderer.invoke(ipcChannels.project.select, input),
  current: () => ipcRenderer.invoke(ipcChannels.project.current)
}

const api = {
  app: appApi,
  terminal: terminalApi,
  agent: agentApi,
  chat: chatApi,
  config: configApi,
  project: projectApi
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('Failed to expose custom preload API', error)
  }

  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
  } catch (error) {
    // Keep app API available even if toolkit electronAPI fails in sandboxed contexts.
    console.error('Failed to expose toolkit electron API', error)
  }
} else {
  // @ts-expect-error defined in d.ts
  window.electron = electronAPI
  // @ts-expect-error defined in d.ts
  window.api = api
}
