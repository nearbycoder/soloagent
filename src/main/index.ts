import { app, shell, BrowserWindow, Menu, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { AgentProfilesRepository } from './data/repositories/agent-profiles-repository'
import { AppSettingsRepository } from './data/repositories/app-settings-repository'
import { ChatHistoryRepository } from './data/repositories/chat-history-repository'
import { ProjectsRepository } from './data/repositories/projects-repository'
import { SqliteService } from './data/sqlite'
import { registerIpcHandlers } from './ipc/router'
import { AgentOrchestratorService } from './services/agent-orchestrator-service'
import { ConfigService } from './services/config-service'
import { LoggerService } from './services/logger'
import { PtyProcessService } from './services/pty-process-service'
import { ProjectService } from './services/project-service'
import { ensureShellPathInProcessEnv } from './services/shell-env'
import { TelemetryService } from './services/telemetry'
import { TerminalSessionService } from './services/terminal-session-service'
import {
  applyWindowBackgroundToAllWindows,
  resolveWindowBackgroundColor
} from './utils/window-theme'

ensureShellPathInProcessEnv()

const logger = new LoggerService()
const telemetry = new TelemetryService()
const sqlite = new SqliteService()
const settingsRepository = new AppSettingsRepository(sqlite)
const profilesRepository = new AgentProfilesRepository(sqlite)
const projectsRepository = new ProjectsRepository(sqlite)
const chatHistoryRepository = new ChatHistoryRepository(sqlite)
const configService = new ConfigService(settingsRepository)
const projectService = new ProjectService(projectsRepository, settingsRepository)
const ptyProcessService = new PtyProcessService()
const terminalService = new TerminalSessionService(ptyProcessService, telemetry, settingsRepository)
const agentService = new AgentOrchestratorService(telemetry, profilesRepository)

let mainWindow: BrowserWindow | null = null
let ipcRegistered = false
let hasShutdownServices = false
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'mailto:'])

function shutdownMainServices(): void {
  if (hasShutdownServices) {
    return
  }

  hasShutdownServices = true
  // Avoid native PTY kill calls during app teardown; child processes terminate as the app exits.
  terminalService.disposeAll({ terminateProcesses: false })
  logger.info('Disposed terminal sessions')
  sqlite.close()
  logger.info('SQLite connection closed')
}

function createApplicationMenu(): Menu {
  const template =
    process.platform === 'darwin'
      ? [
          { role: 'appMenu' as const },
          { role: 'fileMenu' as const },
          { role: 'editMenu' as const },
          { role: 'viewMenu' as const },
          { role: 'windowMenu' as const }
        ]
      : [
          { role: 'fileMenu' as const },
          { role: 'editMenu' as const },
          { role: 'viewMenu' as const }
        ]

  return Menu.buildFromTemplate(template)
}

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)
  } catch {
    return false
  }
}

function isAllowedAppNavigation(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      const devOrigin = new URL(process.env['ELECTRON_RENDERER_URL']).origin
      return url.origin === devOrigin
    }
    return url.protocol === 'file:'
  } catch {
    return false
  }
}

if (process.platform === 'darwin') {
  const originalStderrWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    if (text.includes('representedObject is not a WeakPtrToElectronMenuModelAsNSObject')) {
      return true
    }
    return originalStderrWrite(chunk, ...(args as []))
  }) as typeof process.stderr.write
}

function createWindow(): void {
  const themePreference = configService.getThemePreference()
  const backgroundColor = resolveWindowBackgroundColor(
    themePreference,
    nativeTheme.shouldUseDarkColors
  )
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    frame: false,
    autoHideMenuBar: process.platform !== 'darwin',
    backgroundColor,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isAllowedExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppNavigation(url)) {
      return
    }

    event.preventDefault()
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url)
    }
  })

  if (!ipcRegistered) {
    registerIpcHandlers({
      logger,
      telemetry,
      terminals: terminalService,
      agents: agentService,
      config: configService,
      projects: projectService,
      chatHistory: chatHistoryRepository
    })
    ipcRegistered = true
  }

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')
  Menu.setApplicationMenu(createApplicationMenu())
  logger.info('Application ready')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window, { zoom: true })
  })

  nativeTheme.on('updated', () => {
    if (configService.getThemePreference() !== 'system') {
      return
    }
    applyWindowBackgroundToAllWindows('system', nativeTheme.shouldUseDarkColors)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  shutdownMainServices()
})

app.on('window-all-closed', () => {
  app.quit()
})
