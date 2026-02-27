import { ipcMain } from 'electron'
import { z } from 'zod'
import { ipcChannels } from '../../../shared/ipc/channels'
import { runCodexCompletion, type RunningChatRequest } from '../../services/codex-chat-service'
import { safeInvoke } from '../../utils/ipc-result'
import type { IpcContext } from '../context'

const chatCompleteSchema = z.object({
  requestId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().trim().min(1)
      })
    )
    .min(1),
  cwd: z.string().optional()
})

const chatAbortSchema = z.object({
  requestId: z.string().trim().min(1)
})

const chatHistoryScopeSchema = z.object({
  scopeKey: z.string().trim().min(1),
  spaceId: z.string().trim().min(1),
  projectId: z.string().trim().min(1).optional()
})

const chatHistoryMessageSchema = z.object({
  id: z.string().trim().min(1),
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().trim().min(1),
  createdAt: z.number().int().nonnegative()
})

const chatHistoryReplaceSchema = chatHistoryScopeSchema.extend({
  messages: z.array(chatHistoryMessageSchema)
})

export function registerChatHandlers(context: IpcContext): void {
  const runningRequests = new Map<string, RunningChatRequest>()

  ipcMain.handle(ipcChannels.chat.complete, (event, rawInput) =>
    safeInvoke(async () => {
      const input = chatCompleteSchema.parse(rawInput)
      const selectedProject = context.projects.current()
      const cwd = selectedProject?.rootPath || input.cwd || process.cwd()
      return await runCodexCompletion({ ...input, cwd }, runningRequests, (toolCall) => {
        if (event.sender.isDestroyed()) {
          return
        }
        event.sender.send(ipcChannels.chat.event, {
          type: 'tool_call',
          requestId: input.requestId,
          toolCall
        })
      })
    })
  )

  ipcMain.handle(ipcChannels.chat.abort, (_, rawInput) =>
    safeInvoke(() => {
      const input = chatAbortSchema.parse(rawInput)
      const request = runningRequests.get(input.requestId)
      if (!request) {
        return false
      }

      request.aborted = true

      if (!request.child.killed) {
        request.child.kill('SIGTERM')
      }
      if (!request.child.killed) {
        request.child.kill('SIGKILL')
      }

      return true
    })
  )

  ipcMain.handle(ipcChannels.chat.historyGet, (_, rawInput) =>
    safeInvoke(() => {
      const input = chatHistoryScopeSchema.parse(rawInput)
      return context.chatHistory.list(input.scopeKey, input.spaceId)
    })
  )

  ipcMain.handle(ipcChannels.chat.historyReplace, (_, rawInput) =>
    safeInvoke(() => {
      const input = chatHistoryReplaceSchema.parse(rawInput)
      const sanitizedMessages = input.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content.trim(),
        createdAt: message.createdAt
      }))

      context.chatHistory.replace({
        ...input,
        messages: sanitizedMessages
      })
      return true
    })
  )
}
