import { BrowserWindow } from 'electron'
import { ipcChannels } from '../../shared/ipc/channels'
import type { IpcContext } from './context'
import { registerAgentHandlers } from './handlers/agent'
import { registerAppHandlers } from './handlers/app'
import { registerChatHandlers } from './handlers/chat'
import { registerConfigHandlers } from './handlers/config'
import { registerProjectHandlers } from './handlers/project'
import { registerTerminalHandlers } from './handlers/terminal'

function isDisposedFrameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('Render frame was disposed') ||
    message.includes('Object has been destroyed') ||
    message.includes('WebContents was destroyed')
  )
}

function sendWindowEvent(window: BrowserWindow, channel: string, payload: unknown): void {
  if (window.isDestroyed()) return

  const { webContents } = window
  if (webContents.isDestroyed()) return

  try {
    webContents.send(channel, payload)
  } catch (error) {
    if (!isDisposedFrameError(error)) {
      console.warn(`[ipc] Failed to send ${channel}`, error)
    }
  }
}

export function registerIpcHandlers(context: IpcContext): void {
  registerTerminalHandlers(context)
  registerAgentHandlers(context)
  registerChatHandlers(context)
  registerConfigHandlers(context)
  registerAppHandlers(context)
  registerProjectHandlers(context)

  context.terminals.onEvent((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      sendWindowEvent(window, ipcChannels.terminal.event, event)
    }
  })

  context.agents.onEvent((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      sendWindowEvent(window, ipcChannels.agent.event, event)
    }
  })
}
