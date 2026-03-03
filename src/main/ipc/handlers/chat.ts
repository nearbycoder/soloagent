import { app, ipcMain } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ipcChannels } from '../../../shared/ipc/channels'
import type { ChatCompleteResult, ChatHistoryMessage } from '../../../shared/ipc/types'
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
  cwd: z.string().optional(),
  scopeKey: z.string().trim().min(1).optional(),
  spaceId: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1).optional()
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
const chatResolveAttachmentSchema = z.object({
  url: z.string().trim().min(1)
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

function buildCompletionHistoryMessages(
  input: z.infer<typeof chatCompleteSchema>,
  completion: ChatCompleteResult
): ChatHistoryMessage[] {
  const baseTimestamp = Date.now()
  const messages: ChatHistoryMessage[] = []

  input.messages.forEach((message, index) => {
    const content = message.content.trim()
    if (!content) {
      return
    }

    messages.push({
      id: `${input.requestId}:context:${index + 1}`,
      role: message.role,
      content,
      createdAt: baseTimestamp + index
    })
  })

  const segments =
    Array.isArray(completion.segments) && completion.segments.length > 0
      ? completion.segments
      : [{ text: completion.text, toolCalls: [] }]

  let assistantIndex = 0
  for (const segment of segments) {
    const content = segment.text.trim()
    if (!content) {
      continue
    }

    assistantIndex += 1
    messages.push({
      id: `${input.requestId}:assistant:${assistantIndex}`,
      role: 'assistant',
      content,
      createdAt: baseTimestamp + input.messages.length + assistantIndex
    })
  }

  return messages
}

function getAttachmentsRootDir(): string {
  return resolve(app.getPath('userData'), 'chat-attachments')
}

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
  const attachmentsDir = join(getAttachmentsRootDir(), safeScope, safeSpace, safeProject || '_')
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

function mimeTypeFromExtension(extension: string): string {
  const normalized = extension.toLowerCase()
  if (normalized === '.jpg' || normalized === '.jpeg') return 'image/jpeg'
  if (normalized === '.png') return 'image/png'
  if (normalized === '.gif') return 'image/gif'
  if (normalized === '.webp') return 'image/webp'
  if (normalized === '.bmp') return 'image/bmp'
  if (normalized === '.svg') return 'image/svg+xml'
  return 'application/octet-stream'
}

function assertAttachmentPathInRoot(filePath: string): void {
  const root = getAttachmentsRootDir()
  const target = resolve(filePath)
  const relativePath = relative(root, target)
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error('Invalid attachment path.')
  }
}

async function resolveChatAttachmentDataUrl(
  input: z.infer<typeof chatResolveAttachmentSchema>
): Promise<{ dataUrl: string; bytes: number; mimeType: string }> {
  let filePath = ''
  try {
    const parsed = new URL(input.url)
    if (parsed.protocol !== 'file:') {
      throw new Error('Unsupported attachment URL.')
    }
    filePath = fileURLToPath(parsed)
  } catch {
    throw new Error('Invalid attachment URL.')
  }

  assertAttachmentPathInRoot(filePath)

  const bytes = await readFile(filePath)
  if (!bytes.length) {
    throw new Error('Attachment file is empty.')
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error('Attachment file exceeds the 8MB limit.')
  }

  const mimeType = mimeTypeFromExtension(extname(filePath))
  return {
    dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
    bytes: bytes.length,
    mimeType
  }
}

export function registerChatHandlers(context: IpcContext): void {
  const runningRequests = new Map<string, RunningChatRequest>()

  ipcMain.handle(ipcChannels.chat.complete, (event, rawInput) =>
    safeInvoke(async () => {
      const input = chatCompleteSchema.parse(rawInput)
      const selectedProject = context.projects.current()
      const cwd = selectedProject?.rootPath || input.cwd || process.cwd()
      const completion = await runCodexCompletion(
        { ...input, cwd },
        runningRequests,
        (toolCall) => {
          if (event.sender.isDestroyed()) {
            return
          }
          event.sender.send(ipcChannels.chat.event, {
            type: 'tool_call',
            requestId: input.requestId,
            toolCall
          })
        },
        undefined,
        (text) => {
          if (event.sender.isDestroyed()) {
            return
          }
          event.sender.send(ipcChannels.chat.event, {
            type: 'assistant_progress',
            requestId: input.requestId,
            text
          })
        }
      )

      if (input.scopeKey && input.spaceId) {
        const historyMessages = buildCompletionHistoryMessages(input, completion)
        if (historyMessages.length > 0) {
          context.chatHistory.replace({
            scopeKey: input.scopeKey,
            spaceId: input.spaceId,
            projectId: input.projectId,
            messages: historyMessages
          })
        }
      }

      return completion
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
  ipcMain.handle(ipcChannels.chat.resolveAttachment, (_, rawInput) =>
    safeInvoke(async () => {
      const input = chatResolveAttachmentSchema.parse(rawInput)
      return await resolveChatAttachmentDataUrl(input)
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
