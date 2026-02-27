export const ipcChannels = {
  terminal: {
    create: 'terminal:create',
    write: 'terminal:write',
    resize: 'terminal:resize',
    rename: 'terminal:rename',
    close: 'terminal:close',
    list: 'terminal:list',
    event: 'terminal:event'
  },
  project: {
    create: 'project:create',
    list: 'project:list',
    update: 'project:update',
    delete: 'project:delete',
    select: 'project:select',
    current: 'project:current'
  },
  agent: {
    start: 'agent:start',
    stop: 'agent:stop',
    restart: 'agent:restart',
    assignTerminal: 'agent:assign-terminal',
    list: 'agent:list',
    event: 'agent:event',
    enqueueTask: 'agent:enqueue-task',
    listTasks: 'agent:list-tasks',
    createProfile: 'agent:create-profile',
    listProfiles: 'agent:list-profiles',
    deleteProfile: 'agent:delete-profile'
  },
  chat: {
    complete: 'chat:complete',
    abort: 'chat:abort',
    event: 'chat:event',
    historyGet: 'chat:history:get',
    historyReplace: 'chat:history:replace'
  },
  config: {
    get: 'config:get',
    set: 'config:set',
    all: 'config:all'
  },
  app: {
    health: 'app:health',
    metrics: 'app:metrics',
    logs: 'app:logs',
    gitDiff: 'app:git:diff',
    gitDiffFilePatch: 'app:git:diff-file-patch',
    fileTree: 'app:file-tree',
    fileTreeSearch: 'app:file-tree:search',
    fileRead: 'app:file-read',
    platform: 'app:platform',
    windowMinimize: 'app:window:minimize',
    windowMaximize: 'app:window:maximize',
    windowUnmaximize: 'app:window:unmaximize',
    windowToggleMaximize: 'app:window:toggle-maximize',
    windowClose: 'app:window:close',
    windowIsMaximized: 'app:window:is-maximized',
    selectDirectory: 'app:select-directory'
  }
} as const

export type IpcChannels = typeof ipcChannels
