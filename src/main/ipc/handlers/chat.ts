import { app, ipcMain } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
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

const chatUploadAttachmentSchema = z.object({
  scopeKey: z.string().trim().min(1),
  spaceId: z.string().trim().min(1),
  projectId: z.string().trim().min(1).optional(),
  fileName: z.string().trim().min(1),
  dataUrl: z.string().trim().min(1)
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

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function decodeImageDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/)
  if (!match) {
    throw new Error('Invalid image attachment payload.')
  }

  const mimeType = match[1].toLowerCase()
  const base64Payload = match[2]
  const bytes = Buffer.from(base64Payload, 'base64')
  if (!bytes.length) {
    throw new Error('Image attachment is empty.')
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error('Image attachment exceeds the 8MB limit.')
  }

  return { mimeType, bytes }
}

function extensionFromMimeType(mimeType: string): string {
  if (mimeType === 'image/jpeg') return '.jpg'
  if (mimeType === 'image/png') return '.png'
  if (mimeType === 'image/gif') return '.gif'
  if (mimeType === 'image/webp') return '.webp'
  if (mimeType === 'image/bmp') return '.bmp'
  if (mimeType === 'image/svg+xml') return '.svg'
  return ''
}

async function storeChatAttachment(input: z.infer<typeof chatUploadAttachmentSchema>): Promise<{
  fileName: string
  url: string
  bytes: number
}> {
  const { mimeType, bytes } = decodeImageDataUrl(input.dataUrl)
  const safeScope = sanitizePathSegment(input.scopeKey) || 'scope'
  const safeSpace = sanitizePathSegment(input.spaceId) || 'space'
  const safeProject = input.projectId ? sanitizePathSegment(input.projectId) : ''
  const attachmentsDir = join(
    app.getPath('userData'),
    'chat-attachments',
    safeScope,
    safeSpace,
    safeProject || '_'
  )
  await mkdir(attachmentsDir, { recursive: true })

  const sourceName = basename(input.fileName)
  const sourceExt = extname(sourceName).toLowerCase()
  const mimeExt = extensionFromMimeType(mimeType)
  const extension = mimeExt || sourceExt || '.img'
  const baseName =
    sourceExt.length > 0
      ? sourceName.slice(0, Math.max(0, sourceName.length - sourceExt.length))
      : sourceName
  const normalizedBaseName = baseName.trim() || 'image'
  const safeBaseName = sanitizePathSegment(normalizedBaseName) || 'image'
  const finalName = `${safeBaseName}-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`
  const filePath = join(attachmentsDir, finalName)

  await writeFile(filePath, bytes)

  return {
    fileName: sourceName,
    url: pathToFileURL(filePath).toString(),
    bytes: bytes.length
  }
}

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

  ipcMain.handle(ipcChannels.chat.uploadAttachment, (_, rawInput) =>
    safeInvoke(async () => {
      const input = chatUploadAttachmentSchema.parse(rawInput)
      return await storeChatAttachment(input)
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
