import type { ModelMessage, StreamChunk } from '@tanstack/ai'
import type { ConnectionAdapter, UIMessage } from '@tanstack/ai-client'
import { useChat } from '@tanstack/ai-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import remarkGfm from 'remark-gfm'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatHistoryMessage, ChatMessage, ChatToolCall } from '../../../../shared/ipc/types'
import type { ChatReasoningEffort } from '../../../../shared/ipc/types'
import { AgentChatIndicator } from '../agents-ui/agent-chat-indicator'
import { Button } from '../ui/button'
import {
  buildRenderableMessages,
  getMessageText,
  isToolTraceContent,
  shouldVirtualizeChatMessages,
  TOOL_TRACE_PREFIX,
  stripToolTracePrefix
} from './chat-render-utils'

type AssistantChatPanelProps = {
  activeScopeKey: string
  activeSpaceId?: string
  sessions: AssistantChatSessionBinding[]
  colorMode: 'light' | 'dark'
  accentColor?: string
  onStreamingChange?: (scopeKey: string, spaceId: string, isStreaming: boolean) => void
}

type AssistantChatSessionBinding = {
  scopeKey: string
  spaceId: string
  projectId?: string
  projectPath?: string
}

type AssistantChatSessionProps = {
  projectPath?: string
  scopeKey: string
  spaceId: string
  projectId?: string
  colorMode: 'light' | 'dark'
  accentColor?: string
  onStreamingChange?: (scopeKey: string, spaceId: string, isStreaming: boolean) => void
}

type ModelOption = {
  value: string
  label: string
}

const MODEL_OPTIONS: ModelOption[] = [
  { value: 'gpt-5.3-codex', label: 'GPT-5.3-Codex' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2-Codex' },
  { value: 'gpt-5.1-codex-max', label: 'GPT-5.1-Codex-Max' },
  { value: 'gpt-5.2', label: 'GPT-5.2' },
  { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1-Codex-Mini' }
]
const REASONING_EFFORT_OPTIONS: ModelOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]
const DEFAULT_MODEL = MODEL_OPTIONS[0]?.value || 'gpt-5.3-codex'
const DEFAULT_REASONING_EFFORT: ChatReasoningEffort = 'high'
const STREAM_CHUNK_SIZE = 24
const STREAM_DELAY_MS = 12
const AUTO_SCROLL_THRESHOLD_PX = 96
const PROMPT_MIN_HEIGHT_PX = 30
const PROMPT_MAX_HEIGHT_PX = 160
const TOOL_TRACE_VERSION = 1
const MAX_IMAGE_ATTACHMENTS = 4
const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024
const SUPPORTED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']
const MARKDOWN_PLUGINS = [remarkGfm]
const CHAT_INFLIGHT_STORAGE_PREFIX = 'soloagent:chat:inflight'
const CHAT_INFLIGHT_TTL_MS = 15 * 60 * 1000
const CHAT_RECOVERY_POLL_MS = 1250
const CHAT_RECOVERY_TIMEOUT_MS = 2 * 60 * 1000
const attachmentDataUrlCache = new Map<string, string>()
const attachmentDataUrlPending = new Map<string, Promise<string>>()

type InflightChatMarker = {
  requestId: string
  startedAt: number
}

type ToolTracePayloadItem = {
  title: string
  status: ChatToolCall['status']
  exitCode?: number
  details?: string
}

type ToolTracePayload = {
  version: number
  summary: string
  items: ToolTracePayloadItem[]
}

type ChatMessageRenderItem = {
  id: string
  kind: 'message'
  role: UIMessage['role']
  text: string
  isToolTrace: boolean
}

type LiveToolRenderItem = {
  id: string
  kind: 'live-tools'
  payload: ToolTracePayload
}

type LiveProgressRenderItem = {
  id: string
  kind: 'live-progress'
  entries: string[]
}

type ChatRenderItem = ChatMessageRenderItem | LiveToolRenderItem | LiveProgressRenderItem
type PendingImageAttachment = {
  id: string
  name: string
  mimeType: string
  size: number
  dataUrl: string
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function createAttachmentId(): string {
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function isImageFile(file: File): boolean {
  if (file.type.toLowerCase().startsWith('image/')) {
    return true
  }

  const lowercaseName = file.name.toLowerCase()
  return SUPPORTED_IMAGE_EXTENSIONS.some((extension) => lowercaseName.endsWith(extension))
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => {
      reject(new Error(`Failed to read ${file.name}.`))
    }
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      if (!result) {
        reject(new Error(`Failed to read ${file.name}.`))
        return
      }
      resolve(result)
    }
    reader.readAsDataURL(file)
  })
}

function escapeMarkdownImageAlt(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, ' ').replace(/[()[\]]+/g, ' ').trim()
  return normalized || 'Attachment'
}

function chunkText(text: string, chunkSize: number): string[] {
  if (!text) {
    return []
  }

  const chunks: string[] = []
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize))
  }
  return chunks
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function getInflightStorageKey(scopeKey: string, spaceId: string): string {
  return `${CHAT_INFLIGHT_STORAGE_PREFIX}:${scopeKey}:${spaceId}`
}

function parseInflightChatMarker(raw: string | null): InflightChatMarker | null {
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Partial<InflightChatMarker>
    if (
      !parsed ||
      typeof parsed.requestId !== 'string' ||
      parsed.requestId.trim().length === 0 ||
      typeof parsed.startedAt !== 'number' ||
      !Number.isFinite(parsed.startedAt)
    ) {
      return null
    }

    return {
      requestId: parsed.requestId.trim(),
      startedAt: parsed.startedAt
    }
  } catch {
    return null
  }
}

function areHistoryMessagesEqual(
  left: ChatHistoryMessage[],
  right: ChatHistoryMessage[]
): boolean {
  if (left.length !== right.length) {
    return false
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftMessage = left[index]
    const rightMessage = right[index]
    if (!leftMessage || !rightMessage) {
      return false
    }
    if (
      leftMessage.id !== rightMessage.id ||
      leftMessage.role !== rightMessage.role ||
      leftMessage.content !== rightMessage.content ||
      leftMessage.createdAt !== rightMessage.createdAt
    ) {
      return false
    }
  }

  return true
}

function getTextFromModelMessageContent(content: ModelMessage['content']): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map((part) => {
      if (part && part.type === 'text' && typeof part.content === 'string') {
        return part.content
      }
      return ''
    })
    .join('')
    .trim()
}

function formatToolCallStatus(status: ChatToolCall['status']): string {
  if (status === 'failed') return 'failed'
  if (status === 'completed') return 'completed'
  return 'running'
}

function summarizeToolCalls(toolCalls: ChatToolCall[]): string {
  const total = toolCalls.length
  if (total === 0) {
    return 'No tool calls'
  }

  const completed = toolCalls.filter((tool) => tool.status === 'completed').length
  const failed = toolCalls.filter((tool) => tool.status === 'failed').length
  const running = total - completed - failed
  const parts = [`${total} tool call${total === 1 ? '' : 's'}`]

  if (completed > 0) {
    parts.push(`${completed} completed`)
  }
  if (failed > 0) {
    parts.push(`${failed} failed`)
  }
  if (running > 0) {
    parts.push(`${running} running`)
  }

  return parts.join(' - ')
}

function buildToolTracePayload(toolCalls: ChatToolCall[]): ToolTracePayload {
  return {
    version: TOOL_TRACE_VERSION,
    summary: summarizeToolCalls(toolCalls),
    items: toolCalls.map((tool) => ({
      title: tool.title,
      status: tool.status,
      exitCode: tool.exitCode,
      details: tool.details
    }))
  }
}

function parseToolTracePayload(content: string): ToolTracePayload | undefined {
  if (!isToolTraceContent(content)) {
    return undefined
  }

  const raw = stripToolTracePrefix(content).trim()
  if (!raw) {
    return undefined
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ToolTracePayload>
    if (
      !parsed ||
      parsed.version !== TOOL_TRACE_VERSION ||
      typeof parsed.summary !== 'string' ||
      !Array.isArray(parsed.items)
    ) {
      return undefined
    }

    const items: ToolTracePayloadItem[] = []
    for (const item of parsed.items) {
      if (!item || typeof item !== 'object') {
        continue
      }

      const candidate = item as Partial<ToolTracePayloadItem>
      if (
        typeof candidate.title !== 'string' ||
        (candidate.status !== 'in_progress' &&
          candidate.status !== 'completed' &&
          candidate.status !== 'failed')
      ) {
        continue
      }

      items.push({
        title: candidate.title,
        status: candidate.status,
        exitCode: typeof candidate.exitCode === 'number' ? candidate.exitCode : undefined,
        details: typeof candidate.details === 'string' ? candidate.details : undefined
      })
    }

    return {
      version: TOOL_TRACE_VERSION,
      summary: parsed.summary,
      items
    }
  } catch {
    return undefined
  }
}

function formatToolCallsMessage(toolCalls: ChatToolCall[]): string {
  return `${TOOL_TRACE_PREFIX}${JSON.stringify(buildToolTracePayload(toolCalls))}`
}

function toChatMessages(messages: Array<UIMessage> | Array<ModelMessage>): ChatMessage[] {
  const normalized: ChatMessage[] = []

  for (const message of messages as Array<UIMessage | ModelMessage>) {
    if ('parts' in message) {
      const role = message.role
      if (role !== 'system' && role !== 'user' && role !== 'assistant') {
        continue
      }

      const content = getMessageText(message)

      if (!content) {
        continue
      }

      if (role === 'assistant' && isToolTraceContent(content)) {
        continue
      }

      normalized.push({ role, content })
      continue
    }

    const role = message.role
    if (role !== 'user' && role !== 'assistant') {
      continue
    }

    const content = getTextFromModelMessageContent(message.content)
    if (!content) {
      continue
    }

    normalized.push({ role, content })
  }

  return normalized
}

function toPersistedChatMessages(messages: UIMessage[]): ChatHistoryMessage[] {
  const now = Date.now()
  const persisted: ChatHistoryMessage[] = []

  messages.forEach((message, index) => {
    const role = message.role
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return
    }

    const content = getMessageText(message)
    if (!content) {
      return
    }

    const createdAt =
      message.createdAt instanceof Date && Number.isFinite(message.createdAt.getTime())
        ? message.createdAt.getTime()
        : now + index

    persisted.push({
      id: message.id,
      role,
      content,
      createdAt
    })
  })

  return persisted
}

function toUiMessages(messages: ChatHistoryMessage[]): UIMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    parts: [{ type: 'text', content: message.content }],
    createdAt: new Date(message.createdAt)
  }))
}

function extractMarkdownCodeLanguage(className?: string): string | undefined {
  const match = /language-([a-zA-Z0-9_+-]+)/.exec(className || '')
  return match?.[1]
}

function isAllowedMarkdownHref(href?: string): boolean {
  if (!href) {
    return false
  }

  try {
    const url = new URL(href)
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:'
  } catch {
    return false
  }
}

function isAllowedMarkdownImageSrc(src?: string): boolean {
  if (!src) {
    return false
  }

  try {
    const url = new URL(src)
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'data:') {
      return true
    }
    if (url.protocol === 'file:') {
      return decodeURIComponent(url.pathname).includes('/chat-attachments/')
    }
    return false
  } catch {
    return false
  }
}

function transformMarkdownUrl(url: string): string {
  if (isAllowedMarkdownHref(url) || isAllowedMarkdownImageSrc(url)) {
    return url
  }
  return ''
}

function isFileAttachmentUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'file:'
  } catch {
    return false
  }
}

async function resolveAttachmentDataUrl(src: string): Promise<string> {
  const cached = attachmentDataUrlCache.get(src)
  if (cached) {
    return cached
  }

  const existing = attachmentDataUrlPending.get(src)
  if (existing) {
    return await existing
  }

  const next = (async () => {
    if (!window.api) {
      throw new Error('Preload API unavailable.')
    }

    const response = await window.api.chat.resolveAttachment({ url: src })
    if (!response.ok) {
      throw new Error(response.error.message || 'Failed to resolve image attachment.')
    }

    attachmentDataUrlCache.set(src, response.data.dataUrl)
    return response.data.dataUrl
  })()

  attachmentDataUrlPending.set(src, next)
  try {
    return await next
  } finally {
    attachmentDataUrlPending.delete(src)
  }
}

function MarkdownAttachmentImage({
  src,
  alt
}: {
  src: string
  alt?: string
}): React.JSX.Element {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(() =>
    isFileAttachmentUrl(src) ? attachmentDataUrlCache.get(src) || null : src
  )

  useEffect(() => {
    let cancelled = false

    if (!isFileAttachmentUrl(src)) {
      setResolvedSrc(src)
      return () => {
        cancelled = true
      }
    }

    if (attachmentDataUrlCache.has(src)) {
      setResolvedSrc(attachmentDataUrlCache.get(src) || '')
      return () => {
        cancelled = true
      }
    }

    setResolvedSrc(null)
    void resolveAttachmentDataUrl(src)
      .then((dataUrl) => {
        if (!cancelled) {
          setResolvedSrc(dataUrl)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedSrc('')
        }
      })

    return () => {
      cancelled = true
    }
  }, [src])

  if (resolvedSrc === null) {
    return <span className="text-muted-foreground">{alt || 'Loading image attachment...'}</span>
  }

  if (!resolvedSrc) {
    return <span className="text-muted-foreground">{alt || 'Image attachment unavailable.'}</span>
  }

  return (
    <img
      src={resolvedSrc}
      alt={alt || 'Attachment'}
      loading="lazy"
      className="max-h-64 w-auto rounded-md border border-border/70 bg-background/60"
    />
  )
}

function isReasoningEffort(value: string): value is ChatReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high'
}

function hexToHslChannels(hexColor: string): { h: number; s: number; l: number } | null {
  const hex = hexColor.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return null
  }

  const r = Number.parseInt(hex.slice(0, 2), 16) / 255
  const g = Number.parseInt(hex.slice(2, 4), 16) / 255
  const b = Number.parseInt(hex.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const lightness = (max + min) / 2

  if (delta === 0) {
    return { h: 0, s: 0, l: Math.round(lightness * 100) }
  }

  const saturation = delta / (1 - Math.abs(2 * lightness - 1))
  let hue = 0
  if (max === r) {
    hue = ((g - b) / delta) % 6
  } else if (max === g) {
    hue = (b - r) / delta + 2
  } else {
    hue = (r - g) / delta + 4
  }

  const normalizedHue = Math.round((hue * 60 + 360) % 360)
  return {
    h: normalizedHue,
    s: Math.round(saturation * 100),
    l: Math.round(lightness * 100)
  }
}

function ThinkingDotCluster(): React.JSX.Element {
  const rows = 2
  const columns = 6

  return (
    <span className="inline-flex flex-col gap-px" aria-hidden="true">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <span key={`row-${rowIndex}`} className="inline-flex items-center gap-px">
          {Array.from({ length: columns }).map((__, columnIndex) => {
            const dotIndex = rowIndex * columns + columnIndex
            const delay = dotIndex * 0.07
            const tone = Math.round((dotIndex / Math.max(1, rows * columns - 1)) * 14 - 7)
            return (
              <AgentChatIndicator
                key={`dot-${rowIndex}-${columnIndex}`}
                size="xxs"
                className="sa-thinking-dot"
                transition={{ delay, duration: 0.1 }}
                style={
                  {
                    '--sa-dot-tone': `${tone}%`,
                    '--sa-dot-delay': `${delay}s`
                  } as React.CSSProperties
                }
              />
            )
          })}
        </span>
      ))}
    </span>
  )
}

const MessageContent = memo(function MessageContent({
  content,
  colorMode
}: {
  content: string
  colorMode: 'light' | 'dark'
}): React.JSX.Element {
  const codeStyle = colorMode === 'dark' ? oneDark : oneLight
  const markdownComponents = useMemo<Components>(
    () => ({
      p: ({ children }) => (
        <p className="whitespace-pre-wrap break-words leading-relaxed">{children}</p>
      ),
      ul: ({ children }) => <ul className="list-disc space-y-1 pl-4">{children}</ul>,
      ol: ({ children }) => <ol className="list-decimal space-y-1 pl-4">{children}</ol>,
      li: ({ children }) => <li className="whitespace-pre-wrap break-words">{children}</li>,
      blockquote: ({ children }) => (
        <blockquote className="border-l-2 border-border/70 pl-3 italic text-muted-foreground">
          {children}
        </blockquote>
      ),
      a: ({ href, children }) => {
        if (!isAllowedMarkdownHref(href)) {
          return <span className="text-muted-foreground">{children}</span>
        }

        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="underline decoration-border underline-offset-2 hover:text-foreground"
          >
            {children}
          </a>
        )
      },
      img: ({ src, alt }) => {
        if (!isAllowedMarkdownImageSrc(src)) {
          return (
            <span className="text-muted-foreground">{alt || 'Image attachment unavailable.'}</span>
          )
        }

        if (src && isFileAttachmentUrl(src)) {
          return <MarkdownAttachmentImage src={src} alt={alt} />
        }

        return <MarkdownAttachmentImage src={src || ''} alt={alt} />
      },
      code: ({ className, children }) => {
        const rawCode = String(children).replace(/\n$/, '')
        const language = extractMarkdownCodeLanguage(className)
        const isBlock = Boolean(language) || rawCode.includes('\n')

        if (!isBlock) {
          return (
            <code className="rounded-sm bg-muted/40 px-1 py-0.5 font-mono text-[11px]">
              {rawCode}
            </code>
          )
        }

        return (
          <div className="overflow-hidden rounded-md border border-border/70 bg-background/70">
            <div className="border-b border-border/70 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              {language || 'code'}
            </div>
            <SyntaxHighlighter
              language={language || 'text'}
              style={codeStyle}
              customStyle={{
                margin: 0,
                padding: '10px',
                fontSize: '12px',
                lineHeight: '1.45',
                background: 'transparent'
              }}
              codeTagProps={{
                style: {
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace'
                }
              }}
              wrapLongLines
            >
              {rawCode}
            </SyntaxHighlighter>
          </div>
        )
      },
      pre: ({ children }) => <>{children}</>,
      table: ({ children }) => (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[11px]">{children}</table>
        </div>
      ),
      thead: ({ children }) => <thead className="border-b border-border/70">{children}</thead>,
      th: ({ children }) => <th className="px-2 py-1 font-medium">{children}</th>,
      td: ({ children }) => (
        <td className="border-t border-border/60 px-2 py-1 align-top">{children}</td>
      )
    }),
    [codeStyle]
  )

  return (
    <div className="space-y-2 [&>*+*]:mt-2">
      <ReactMarkdown
        skipHtml
        remarkPlugins={MARKDOWN_PLUGINS}
        components={markdownComponents}
        urlTransform={transformMarkdownUrl}
      >
        {content || ''}
      </ReactMarkdown>
    </div>
  )
})

MessageContent.displayName = 'MessageContent'

function toolStatusClasses(status: ChatToolCall['status']): string {
  if (status === 'completed') {
    return 'text-emerald-400'
  }
  if (status === 'failed') {
    return 'text-red-400'
  }
  return 'text-amber-300'
}

const ToolTraceContent = memo(function ToolTraceContent({
  payload,
  fallbackText,
  colorMode
}: {
  payload?: ToolTracePayload
  fallbackText?: string
  colorMode: 'light' | 'dark'
}): React.JSX.Element {
  if (!payload) {
    return <MessageContent content={fallbackText || ''} colorMode={colorMode} />
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium">{payload.summary}</div>
      <details className="group overflow-hidden rounded-md border border-border/70 bg-background/40">
        <summary className="cursor-pointer list-none px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            Details
            <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="space-y-2 border-t border-border/70 px-2 py-1.5">
          {payload.items.length === 0 ? (
            <div className="text-[11px] text-muted-foreground">No tool call details.</div>
          ) : (
            payload.items.map((item, index) => (
              <div key={`${item.title}-${index}`} className="space-y-1 text-[11px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{item.title}</span>
                  <span className={toolStatusClasses(item.status)}>
                    {formatToolCallStatus(item.status)}
                  </span>
                  {typeof item.exitCode === 'number' ? (
                    <span className="text-muted-foreground">(exit {item.exitCode})</span>
                  ) : null}
                </div>
                {item.details ? (
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border/60 bg-muted/30 p-1.5 text-[10px] leading-relaxed text-muted-foreground">
                    {item.details}
                  </pre>
                ) : null}
              </div>
            ))
          )}
        </div>
      </details>
    </div>
  )
})

ToolTraceContent.displayName = 'ToolTraceContent'

const ChatListItem = memo(function ChatListItem({
  item,
  colorMode
}: {
  item: ChatRenderItem
  colorMode: 'light' | 'dark'
}): React.JSX.Element {
  if (item.kind === 'live-progress') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[88%] rounded-xl border border-border/70 bg-background/70 px-2.5 py-2 text-xs text-muted-foreground">
          <div className="mb-1 inline-flex items-center gap-1.5">
            <ThinkingDotCluster />
            <span className="whitespace-nowrap font-medium">Working...</span>
          </div>
          <details className="group rounded-md border border-border/60 bg-muted/20">
            <summary className="cursor-pointer list-none px-2 py-1 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                Updates ({item.entries.length})
                <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
              </span>
            </summary>
            <div className="space-y-1 border-t border-border/60 px-2 py-1.5">
              {item.entries.map((entry, index) => (
                <div key={`${entry}-${index}`} className="whitespace-pre-wrap break-words">
                  {entry}
                </div>
              ))}
            </div>
          </details>
        </div>
      </div>
    )
  }

  if (item.kind === 'live-tools') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[88%] rounded-xl border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-muted-foreground">
          <ToolTraceContent payload={item.payload} colorMode={colorMode} />
        </div>
      </div>
    )
  }

  const isUser = item.role === 'user'
  const toolTracePayload = item.isToolTrace ? parseToolTracePayload(item.text) : undefined
  const bubbleContent = item.text ? stripToolTracePrefix(item.text) : '(no text output)'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[88%] rounded-xl border px-2.5 py-2 text-xs ${
          item.isToolTrace ? 'border-amber-500/30 bg-amber-500/10 text-muted-foreground' : ''
        } ${
          isUser
            ? 'border-blue-500/40 bg-blue-500/15 text-foreground'
            : 'border-border/70 bg-background/70 text-foreground'
        }`}
      >
        {item.isToolTrace ? (
          <ToolTraceContent
            payload={toolTracePayload}
            fallbackText={bubbleContent}
            colorMode={colorMode}
          />
        ) : (
          <MessageContent content={bubbleContent} colorMode={colorMode} />
        )}
      </div>
    </div>
  )
})

ChatListItem.displayName = 'ChatListItem'

function isNearBottom(container: HTMLDivElement): boolean {
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight
  return distance <= AUTO_SCROLL_THRESHOLD_PX
}

function resizePromptInput(element: HTMLTextAreaElement | null): void {
  if (!element) {
    return
  }

  element.style.height = '0px'
  const nextHeight = Math.max(
    PROMPT_MIN_HEIGHT_PX,
    Math.min(element.scrollHeight, PROMPT_MAX_HEIGHT_PX)
  )
  element.style.height = `${nextHeight}px`
  element.style.overflowY = element.scrollHeight > PROMPT_MAX_HEIGHT_PX ? 'auto' : 'hidden'
}

type SearchableModelDropdownProps = {
  id: string
  value: string
  options: ModelOption[]
  disabled?: boolean
  searchable?: boolean
  containerClassName?: string
  onChange: (nextModel: string) => void
}

function SearchableModelDropdown({
  id,
  value,
  options,
  disabled,
  searchable = true,
  containerClassName,
  onChange
}: SearchableModelDropdownProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const filteredOptions = useMemo(() => {
    if (!searchable) {
      return options
    }

    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) {
      return options
    }
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(normalizedQuery) ||
        option.value.toLowerCase().includes(normalizedQuery)
    )
  }, [options, query, searchable])

  const selectedLabel = useMemo(() => {
    const selected = options.find((option) => option.value === value)
    return selected?.label || value
  }, [options, value])

  useEffect(() => {
    if (!searchable) {
      return
    }

    if (!open) {
      return
    }

    const onDocumentPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (!target || !(target instanceof Node)) {
        return
      }
      if (!containerRef.current?.contains(target)) {
        setOpen(false)
        setQuery('')
      }
    }

    const onDocumentKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        setQuery('')
      }
    }

    document.addEventListener('mousedown', onDocumentPointerDown)
    document.addEventListener('keydown', onDocumentKeyDown)
    return (): void => {
      document.removeEventListener('mousedown', onDocumentPointerDown)
      document.removeEventListener('keydown', onDocumentKeyDown)
    }
  }, [open, searchable])

  useEffect(() => {
    if (!open) {
      return
    }

    const timer = window.setTimeout(() => {
      searchInputRef.current?.focus()
    }, 0)

    return (): void => {
      window.clearTimeout(timer)
    }
  }, [open])

  useEffect(() => {
    if (!disabled) {
      return
    }

    setOpen(false)
    setQuery('')
  }, [disabled])

  const selectModel = (nextModel: string): void => {
    onChange(nextModel)
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={containerRef} className={`relative ${containerClassName || 'w-[210px]'}`}>
      <button
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (disabled) {
            return
          }
          setOpen((current) => !current)
        }}
        className={`h-8 w-full rounded-md border border-border/70 bg-background px-2.5 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          disabled ? 'cursor-not-allowed opacity-60' : ''
        }`}
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
              open ? 'rotate-180' : ''
            }`}
          />
        </span>
      </button>

      {open ? (
        <div className="absolute left-0 z-50 mt-1 w-full rounded-md border border-border/80 bg-background text-foreground shadow-xl">
          {searchable ? (
            <div className="border-b border-border/70 p-1">
              <div className="flex items-center gap-1.5 rounded-md border border-border/70 bg-background px-2">
                <Search className="h-3 w-3 text-muted-foreground" />
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') {
                      return
                    }
                    event.preventDefault()
                    const firstMatch = filteredOptions[0]
                    if (!firstMatch) {
                      return
                    }
                    selectModel(firstMatch.value)
                  }}
                  placeholder="Search models..."
                  className="h-7 w-full bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
                />
              </div>
            </div>
          ) : null}

          <div role="listbox" className="max-h-56 overflow-y-auto p-1">
            {filteredOptions.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">No matching models</div>
            ) : (
              filteredOptions.map((option) => {
                const isActive = option.value === value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onClick={() => selectModel(option.value)}
                    className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-[11px] transition-colors ${
                      isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/70'
                    }`}
                  >
                    <Check
                      className={`h-3 w-3 shrink-0 ${isActive ? 'opacity-100' : 'opacity-0'}`}
                    />
                    <span className="truncate">{option.label}</span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function AssistantChatSession({
  projectPath,
  scopeKey,
  spaceId,
  projectId,
  colorMode,
  accentColor,
  onStreamingChange
}: AssistantChatSessionProps): React.JSX.Element {
  const modelInputId = `chat-model-${scopeKey}-${spaceId}`
  const reasoningEffortInputId = `chat-reasoning-${scopeKey}-${spaceId}`
  const [model, setModel] = useState<string>(DEFAULT_MODEL)
  const [reasoningEffort, setReasoningEffort] =
    useState<ChatReasoningEffort>(DEFAULT_REASONING_EFFORT)
  const [prompt, setPrompt] = useState('')
  const [imageAttachments, setImageAttachments] = useState<PendingImageAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [isDropTargetActive, setIsDropTargetActive] = useState(false)
  const [historyReady, setHistoryReady] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [isRecoveringResponse, setIsRecoveringResponse] = useState(false)
  const [liveProgressEntries, setLiveProgressEntries] = useState<string[]>([])
  const [liveToolCalls, setLiveToolCalls] = useState<ChatToolCall[]>([])
  const [activeAssistantMessageId, setActiveAssistantMessageId] = useState<string | null>(null)
  const [activeToolMessageId, setActiveToolMessageId] = useState<string | null>(null)
  const messageViewportRef = useRef<HTMLDivElement | null>(null)
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const suppressAbortForReloadRef = useRef(false)
  const manualStopRequestedRef = useRef(false)
  const liveToolCallsRef = useRef<ChatToolCall[]>([])
  const shouldAutoScrollRef = useRef(true)
  const dropDepthRef = useRef(0)
  const inflightStorageKey = useMemo(() => getInflightStorageKey(scopeKey, spaceId), [scopeKey, spaceId])

  useEffect(() => {
    suppressAbortForReloadRef.current = false
    const markUnload = (): void => {
      suppressAbortForReloadRef.current = true
    }

    window.addEventListener('beforeunload', markUnload)
    window.addEventListener('pagehide', markUnload)
    return (): void => {
      window.removeEventListener('beforeunload', markUnload)
      window.removeEventListener('pagehide', markUnload)
    }
  }, [])

  const connection = useMemo<ConnectionAdapter>(
    () => ({
      async *connect(messages, _data, abortSignal): AsyncIterable<StreamChunk> {
        if (abortSignal?.aborted) {
          return
        }

        const requestId = createRequestId()
        suppressAbortForReloadRef.current = false
        manualStopRequestedRef.current = false
        window.sessionStorage.setItem(
          inflightStorageKey,
          JSON.stringify({ requestId, startedAt: Date.now() } satisfies InflightChatMarker)
        )
        activeRequestIdRef.current = requestId
        setLiveProgressEntries([])
        setLiveToolCalls([])
        setActiveToolMessageId(null)
        setActiveAssistantMessageId(null)
        liveToolCallsRef.current = []
        const abortRequest = (): void => {
          if (suppressAbortForReloadRef.current && !manualStopRequestedRef.current) {
            return
          }
          void window.api.chat.abort({ requestId })
        }
        abortSignal?.addEventListener('abort', abortRequest, { once: true })

        try {
          const normalizedMessages = toChatMessages(messages)
          if (normalizedMessages.length === 0) {
            return
          }

          const response = await window.api.chat.complete({
            requestId,
            model,
            reasoningEffort,
            messages: normalizedMessages,
            cwd: projectPath,
            scopeKey,
            spaceId,
            projectId
          })

          if (!response.ok) {
            if (abortSignal?.aborted || response.error.message === 'Chat request aborted.') {
              return
            }
            throw new Error(response.error.message || 'Chat request failed.')
          }

          if (abortSignal?.aborted) {
            return
          }

          const runId = `run-${Date.now()}`
          const now = Date.now()
          const toolCalls = response.data.toolCalls || []
          const fallbackToolCalls = toolCalls.length > 0 ? toolCalls : liveToolCallsRef.current
          const normalizedSegments =
            Array.isArray(response.data.segments) && response.data.segments.length > 0
              ? response.data.segments
                  .map((segment) => ({
                    text: typeof segment?.text === 'string' ? segment.text : '',
                    toolCalls: Array.isArray(segment?.toolCalls) ? segment.toolCalls : []
                  }))
                  .filter(
                    (segment) => segment.text.trim().length > 0 || segment.toolCalls.length > 0
                  )
              : [{ text: response.data.text || '', toolCalls: fallbackToolCalls }]

          if (normalizedSegments.length === 0) {
            throw new Error('Chat request failed: empty assistant response.')
          }

          yield {
            type: 'RUN_STARTED',
            runId,
            timestamp: now,
            model
          }

          setLiveProgressEntries([])
          setLiveToolCalls([])
          liveToolCallsRef.current = []

          let segmentIndex = 0
          for (const segment of normalizedSegments) {
            const assistantMessageId = `assistant-${now}-${segmentIndex}`
            const segmentToolCalls = segment.toolCalls || []
            const assistantText = segment.text || ''

            if (segmentToolCalls.length > 0) {
              const toolMessageId = `tools-${now}-${segmentIndex}`
              const toolContent = formatToolCallsMessage(segmentToolCalls)
              setActiveToolMessageId(toolMessageId)
              yield {
                type: 'TEXT_MESSAGE_START',
                messageId: toolMessageId,
                role: 'assistant',
                timestamp: Date.now(),
                model
              }
              yield {
                type: 'TEXT_MESSAGE_CONTENT',
                messageId: toolMessageId,
                delta: toolContent,
                content: toolContent,
                timestamp: Date.now(),
                model
              }
              yield {
                type: 'TEXT_MESSAGE_END',
                messageId: toolMessageId,
                timestamp: Date.now(),
                model
              }
            }

            yield {
              type: 'TEXT_MESSAGE_START',
              messageId: assistantMessageId,
              role: 'assistant',
              timestamp: now,
              model
            }
            setActiveAssistantMessageId(assistantMessageId)

            if (assistantText.length > 0) {
              const chunks = chunkText(assistantText, STREAM_CHUNK_SIZE)
              for (const chunk of chunks) {
                if (abortSignal?.aborted) {
                  return
                }
                if (!chunk) {
                  continue
                }
                const timestamp = Date.now()
                yield {
                  type: 'TEXT_MESSAGE_CONTENT',
                  messageId: assistantMessageId,
                  delta: chunk,
                  content: chunk,
                  timestamp,
                  model
                }
                await sleep(STREAM_DELAY_MS)
              }
            } else {
              yield {
                type: 'TEXT_MESSAGE_CONTENT',
                messageId: assistantMessageId,
                delta: '',
                content: '',
                timestamp: Date.now(),
                model
              }
            }

            yield {
              type: 'TEXT_MESSAGE_END',
              messageId: assistantMessageId,
              timestamp: Date.now(),
              model
            }
            segmentIndex += 1
          }

          yield {
            type: 'RUN_FINISHED',
            runId,
            finishReason: 'stop',
            timestamp: Date.now(),
            model
          }
        } finally {
          if (activeRequestIdRef.current === requestId) {
            activeRequestIdRef.current = null
          }
          const inflightMarker = parseInflightChatMarker(window.sessionStorage.getItem(inflightStorageKey))
          if (inflightMarker?.requestId === requestId) {
            window.sessionStorage.removeItem(inflightStorageKey)
          }
          manualStopRequestedRef.current = false
          if (abortSignal?.aborted) {
            setActiveAssistantMessageId(null)
            setLiveProgressEntries([])
            setLiveToolCalls([])
            liveToolCallsRef.current = []
            setActiveToolMessageId(null)
          }
          abortSignal?.removeEventListener('abort', abortRequest)
        }
      }
    }),
    [inflightStorageKey, model, projectId, projectPath, reasoningEffort, scopeKey, spaceId]
  )

  const { messages, sendMessage, clear, stop, setMessages, isLoading, error } = useChat({
    id: `assistant-chat-${scopeKey}-${spaceId}`,
    connection
  })

  const persistedMessages = useMemo(() => toPersistedChatMessages(messages), [messages])
  const messageItems = useMemo<ChatMessageRenderItem[]>(
    () =>
      buildRenderableMessages(messages).map((message) => ({
        id: message.id,
        kind: 'message',
        role: message.role,
        text: message.text,
        isToolTrace: message.isToolTrace
      })),
    [messages]
  )
  const hasPersistedToolTraceForActiveRun = useMemo(() => {
    if (!activeToolMessageId) {
      return false
    }
    return messageItems.some((item) => item.id === activeToolMessageId && item.isToolTrace)
  }, [activeToolMessageId, messageItems])
  const hasToolTraceAfterLatestUser = useMemo(() => {
    let latestUserIndex = -1
    for (let index = 0; index < messageItems.length; index += 1) {
      if (messageItems[index]?.role === 'user') {
        latestUserIndex = index
      }
    }

    for (let index = latestUserIndex + 1; index < messageItems.length; index += 1) {
      if (messageItems[index]?.isToolTrace) {
        return true
      }
    }

    return false
  }, [messageItems])
  const liveProgressItem = useMemo<LiveProgressRenderItem | null>(() => {
    if (!isLoading || liveProgressEntries.length === 0) {
      return null
    }
    return {
      id: 'live-progress',
      kind: 'live-progress',
      entries: liveProgressEntries
    }
  }, [isLoading, liveProgressEntries])
  const liveToolItem = useMemo<LiveToolRenderItem | null>(() => {
    if (
      liveToolCalls.length === 0 ||
      hasPersistedToolTraceForActiveRun ||
      (!isLoading && hasToolTraceAfterLatestUser)
    ) {
      return null
    }

    return {
      id: 'live-tools',
      kind: 'live-tools',
      payload: buildToolTracePayload(liveToolCalls)
    }
  }, [hasPersistedToolTraceForActiveRun, hasToolTraceAfterLatestUser, isLoading, liveToolCalls])
  const liveRuntimeItems = useMemo<ChatRenderItem[]>(() => {
    const items: ChatRenderItem[] = []
    if (liveToolItem) {
      items.push(liveToolItem)
    }
    if (liveProgressItem) {
      items.push(liveProgressItem)
    }
    return items
  }, [liveProgressItem, liveToolItem])
  const renderItems = useMemo<ChatRenderItem[]>(() => {
    if (liveRuntimeItems.length === 0) {
      return messageItems
    }

    const insertBeforeIndexById =
      activeAssistantMessageId !== null
        ? messageItems.findIndex((item) => item.id === activeAssistantMessageId)
        : -1

    let fallbackAssistantIndex = -1
    for (let index = messageItems.length - 1; index >= 0; index -= 1) {
      const item = messageItems[index]
      if (!item) {
        continue
      }
      if (item.role === 'assistant' && !item.isToolTrace) {
        fallbackAssistantIndex = index
        break
      }
    }

    const insertBeforeIndex =
      insertBeforeIndexById >= 0 ? insertBeforeIndexById : fallbackAssistantIndex

    if (insertBeforeIndex < 0) {
      return [...messageItems, ...liveRuntimeItems]
    }

    return [
      ...messageItems.slice(0, insertBeforeIndex),
      ...liveRuntimeItems,
      ...messageItems.slice(insertBeforeIndex)
    ]
  }, [activeAssistantMessageId, liveRuntimeItems, messageItems])
  const showThinkingIndicator =
    isLoading &&
    !activeAssistantMessageId &&
    liveToolCalls.length === 0 &&
    liveProgressEntries.length === 0
  const showRecoveryIndicator = !isLoading && isRecoveringResponse
  const shouldVirtualize = shouldVirtualizeChatMessages(renderItems.length)
  const rowVirtualizer = useVirtualizer({
    count: renderItems.length,
    getScrollElement: () => messageViewportRef.current,
    estimateSize: () => 56,
    overscan: 10,
    getItemKey: (index) => renderItems[index]?.id || `chat-row-${index}`
  })

  useEffect(() => {
    if (!window.api) {
      return
    }

    const off = window.api.chat.onEvent((event) => {
      if (!activeRequestIdRef.current || event.requestId !== activeRequestIdRef.current) {
        return
      }

      if (event.type === 'assistant_progress') {
        const text = event.text.trim()
        if (!text) {
          return
        }

        setLiveProgressEntries((state) => {
          if (state[state.length - 1] === text) {
            return state
          }
          const next = [...state, text]
          return next.length > 24 ? next.slice(next.length - 24) : next
        })
        return
      }

      if (event.type !== 'tool_call') {
        return
      }

      setLiveToolCalls((state) => {
        const existingIndex = state.findIndex((tool) => tool.id === event.toolCall.id)
        if (existingIndex === -1) {
          const next = [...state, event.toolCall]
          liveToolCallsRef.current = next
          return next
        }
        const next = [...state]
        next[existingIndex] = event.toolCall
        liveToolCallsRef.current = next
        return next
      })
    })

    return () => {
      off()
    }
  }, [])

  useEffect(() => {
    if (!onStreamingChange) {
      return
    }

    onStreamingChange(scopeKey, spaceId, isLoading)

    return (): void => {
      onStreamingChange(scopeKey, spaceId, false)
    }
  }, [isLoading, onStreamingChange, scopeKey, spaceId])

  useEffect(() => {
    let cancelled = false
    setHistoryReady(false)
    setHistoryError(null)

    const loadHistory = async (): Promise<void> => {
      const response = await window.api.chat.historyGet({
        scopeKey,
        spaceId,
        projectId
      })
      if (cancelled) {
        return
      }

      if (!response.ok) {
        setMessages([])
        setHistoryError(response.error.message || 'Failed to load chat history.')
        setHistoryReady(true)
        return
      }

      setMessages(toUiMessages(response.data))
      setHistoryReady(true)
    }

    void loadHistory()

    return (): void => {
      cancelled = true
    }
  }, [projectId, scopeKey, setMessages, spaceId])

  useEffect(() => {
    if (!historyReady || isLoading) {
      return
    }

    const marker = parseInflightChatMarker(window.sessionStorage.getItem(inflightStorageKey))
    if (!marker) {
      setIsRecoveringResponse(false)
      return
    }

    if (Date.now() - marker.startedAt > CHAT_INFLIGHT_TTL_MS) {
      window.sessionStorage.removeItem(inflightStorageKey)
      setIsRecoveringResponse(false)
      return
    }

    let cancelled = false
    let pollInFlight = false
    const recoveryStartedAt = Date.now()
    setIsRecoveringResponse(true)

    const pollHistory = async (): Promise<void> => {
      if (cancelled || pollInFlight) {
        return
      }

      const activeMarker = parseInflightChatMarker(window.sessionStorage.getItem(inflightStorageKey))
      if (!activeMarker) {
        setIsRecoveringResponse(false)
        return
      }

      if (
        Date.now() - activeMarker.startedAt > CHAT_INFLIGHT_TTL_MS ||
        Date.now() - recoveryStartedAt > CHAT_RECOVERY_TIMEOUT_MS
      ) {
        window.sessionStorage.removeItem(inflightStorageKey)
        setIsRecoveringResponse(false)
        return
      }

      pollInFlight = true
      try {
        const response = await window.api.chat.historyGet({
          scopeKey,
          spaceId,
          projectId
        })
        if (cancelled || !response.ok) {
          return
        }

        if (!areHistoryMessagesEqual(response.data, persistedMessages)) {
          setMessages(toUiMessages(response.data))
          window.sessionStorage.removeItem(inflightStorageKey)
          setIsRecoveringResponse(false)
        }
      } finally {
        pollInFlight = false
      }
    }

    const intervalId = window.setInterval(() => {
      void pollHistory()
    }, CHAT_RECOVERY_POLL_MS)
    void pollHistory()

    return (): void => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [
    historyReady,
    inflightStorageKey,
    isLoading,
    persistedMessages,
    projectId,
    scopeKey,
    setMessages,
    spaceId
  ])

  useEffect(() => {
    if (!historyReady || isLoading) {
      return
    }

    const timeout = window.setTimeout(() => {
      void window.api.chat.historyReplace({
        scopeKey,
        spaceId,
        projectId,
        messages: persistedMessages
      })
    }, 150)

    return (): void => {
      window.clearTimeout(timeout)
    }
  }, [historyReady, isLoading, persistedMessages, projectId, scopeKey, spaceId])

  useEffect(() => {
    const viewport = messageViewportRef.current
    if (!viewport) {
      return
    }

    if (!shouldAutoScrollRef.current) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      const current = messageViewportRef.current
      if (!current) {
        return
      }

      if (shouldVirtualize && renderItems.length > 0) {
        rowVirtualizer.scrollToIndex(renderItems.length - 1, { align: 'end' })
        return
      }

      current.scrollTop = current.scrollHeight
    })

    return (): void => {
      window.cancelAnimationFrame(frame)
    }
  }, [
    historyReady,
    isLoading,
    liveToolCalls,
    liveProgressEntries,
    messages,
    renderItems.length,
    rowVirtualizer,
    shouldVirtualize
  ])

  useEffect(() => {
    resizePromptInput(promptInputRef.current)
  }, [prompt])

  const clearDropOverlay = (): void => {
    dropDepthRef.current = 0
    setIsDropTargetActive(false)
  }

  const addImageAttachments = async (files: File[]): Promise<void> => {
    if (files.length === 0) {
      return
    }

    if (isLoading) {
      setAttachmentError('Please wait for the current response before attaching images.')
      return
    }

    const imageFiles = files.filter((file) => isImageFile(file))
    if (imageFiles.length === 0) {
      setAttachmentError('Only image files can be attached.')
      return
    }

    setAttachmentError(null)

    const availableSlots = Math.max(0, MAX_IMAGE_ATTACHMENTS - imageAttachments.length)
    if (availableSlots === 0) {
      setAttachmentError(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images per message.`)
      return
    }

    let oversizedCount = 0
    let readFailureCount = 0
    const accepted = imageFiles.slice(0, availableSlots)
    const nextAttachments: PendingImageAttachment[] = []

    for (const file of accepted) {
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        oversizedCount += 1
        continue
      }

      try {
        const dataUrl = await readFileAsDataUrl(file)
        nextAttachments.push({
          id: createAttachmentId(),
          name: file.name,
          mimeType: file.type || 'image/*',
          size: file.size,
          dataUrl
        })
      } catch {
        readFailureCount += 1
      }
    }

    if (nextAttachments.length > 0) {
      setImageAttachments((current) =>
        [...current, ...nextAttachments].slice(0, MAX_IMAGE_ATTACHMENTS)
      )
    }

    const skippedByLimit = Math.max(0, imageFiles.length - accepted.length)
    if (oversizedCount > 0 || readFailureCount > 0 || skippedByLimit > 0) {
      const problems: string[] = []
      if (oversizedCount > 0) {
        problems.push(
          `${oversizedCount} file${oversizedCount === 1 ? '' : 's'} exceeded ${
            MAX_IMAGE_ATTACHMENT_BYTES / (1024 * 1024)
          }MB`
        )
      }
      if (readFailureCount > 0) {
        problems.push(`${readFailureCount} file${readFailureCount === 1 ? '' : 's'} failed to read`)
      }
      if (skippedByLimit > 0) {
        problems.push(
          `${skippedByLimit} file${skippedByLimit === 1 ? '' : 's'} skipped (limit reached)`
        )
      }
      setAttachmentError(problems.join('. '))
    }
  }

  const handleMessageViewportDragEnter = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    dropDepthRef.current += 1
    setIsDropTargetActive(true)
  }

  const handleMessageViewportDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    if (!isDropTargetActive) {
      setIsDropTargetActive(true)
    }
  }

  const handleMessageViewportDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    dropDepthRef.current = Math.max(0, dropDepthRef.current - 1)
    if (dropDepthRef.current === 0) {
      setIsDropTargetActive(false)
    }
  }

  const handleMessageViewportDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    clearDropOverlay()
    const droppedFiles = Array.from(event.dataTransfer.files || [])
    void addImageAttachments(droppedFiles)
  }

  const submitPrompt = async (): Promise<void> => {
    const trimmed = prompt.trim()
    if ((!trimmed && imageAttachments.length === 0) || isLoading || !historyReady) {
      return
    }
    if (!window.api) {
      return
    }

    shouldAutoScrollRef.current = true
    const viewport = messageViewportRef.current
    if (viewport) {
      if (shouldVirtualize && renderItems.length > 0) {
        rowVirtualizer.scrollToIndex(renderItems.length - 1, { align: 'end' })
      } else {
        viewport.scrollTop = viewport.scrollHeight
      }
    }

    try {
      let attachmentMarkdown = ''
      if (imageAttachments.length > 0) {
        const uploadedLinks: string[] = []
        for (const attachment of imageAttachments) {
          const uploadResponse = await window.api.chat.uploadAttachment({
            scopeKey,
            spaceId,
            projectId,
            fileName: attachment.name,
            dataUrl: attachment.dataUrl
          })
          if (!uploadResponse.ok) {
            throw new Error(uploadResponse.error.message || `Failed to upload ${attachment.name}.`)
          }
          uploadedLinks.push(
            `![${escapeMarkdownImageAlt(attachment.name)}](${uploadResponse.data.url})`
          )
        }
        attachmentMarkdown = `\n\nAttached images:\n${uploadedLinks.join('\n')}`
      }

      const composedPrompt = `${trimmed}${attachmentMarkdown}`.trim()
      setPrompt('')
      setAttachmentError(null)
      setImageAttachments([])
      await sendMessage(composedPrompt)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to upload image attachment.'
      setAttachmentError(message)
    }
  }

  const canSubmitPrompt = useMemo(
    () => historyReady && !isLoading && (prompt.trim().length > 0 || imageAttachments.length > 0),
    [historyReady, imageAttachments.length, isLoading, prompt]
  )
  const thinkingDotStyle = useMemo(
    () => {
      const base = hexToHslChannels(accentColor || '#2563eb') || { h: 221, s: 83, l: 53 }
      return {
        '--thinking-dot-h': `${base.h}deg`,
        '--thinking-dot-s': `${Math.max(28, Math.min(100, base.s))}%`,
        '--thinking-dot-l': `${Math.max(32, Math.min(68, base.l))}%`
      } as React.CSSProperties
    },
    [accentColor]
  )

  const handleStop = (): void => {
    manualStopRequestedRef.current = true
    stop()
  }

  const handleClearChat = (): void => {
    clear()
    window.sessionStorage.removeItem(inflightStorageKey)
    setIsRecoveringResponse(false)
    setImageAttachments([])
    setAttachmentError(null)
    clearDropOverlay()
  }

  const messageList = useMemo(() => {
    if (!historyReady) {
      return <div className="text-xs text-muted-foreground">Loading chat history...</div>
    }

    if (renderItems.length === 0) {
      return (
        <div className="text-xs text-muted-foreground">
          Ask anything about this project. Responses run through Codex CLI in this workspace.
        </div>
      )
    }

    if (shouldVirtualize) {
      const virtualRows = rowVirtualizer.getVirtualItems()
      return (
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {virtualRows.map((virtualRow) => {
            const row = renderItems[virtualRow.index]
            if (!row) {
              return null
            }

            return (
              <div
                key={virtualRow.key}
                data-chat-row="1"
                data-chat-index={virtualRow.index}
                data-chat-kind={row.kind}
                ref={rowVirtualizer.measureElement}
                className="absolute left-0 top-0 w-full pb-2"
                style={{
                  transform: `translateY(${virtualRow.start}px)`
                }}
              >
                <ChatListItem item={row} colorMode={colorMode} />
              </div>
            )
          })}
        </div>
      )
    }

    return (
      <div className="space-y-2">
        {renderItems.map((item) => (
          <div key={item.id} data-chat-row="1" data-chat-kind={item.kind}>
            <ChatListItem item={item} colorMode={colorMode} />
          </div>
        ))}
      </div>
    )
  }, [colorMode, historyReady, renderItems, rowVirtualizer, shouldVirtualize])

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5" style={thinkingDotStyle}>
      <div className="flex items-center gap-1.5">
        <label
          className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground"
          htmlFor={modelInputId}
        >
          Model
        </label>
        <SearchableModelDropdown
          id={modelInputId}
          value={model}
          options={MODEL_OPTIONS}
          disabled={isLoading || !historyReady}
          onChange={(nextModel) => setModel(nextModel)}
        />
        <label
          className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground"
          htmlFor={reasoningEffortInputId}
        >
          Reasoning
        </label>
        <SearchableModelDropdown
          id={reasoningEffortInputId}
          value={reasoningEffort}
          options={REASONING_EFFORT_OPTIONS}
          disabled={isLoading || !historyReady}
          searchable={false}
          containerClassName="w-[118px]"
          onChange={(nextReasoningEffort) => {
            if (!isReasoningEffort(nextReasoningEffort)) {
              return
            }
            setReasoningEffort(nextReasoningEffort)
          }}
        />

        <div className="ml-auto flex items-center gap-1">
          {isLoading ? (
            <Button
              size="sm"
              variant="secondary"
              className="h-6 px-2 text-[11px]"
              onClick={handleStop}
            >
              Stop
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={handleClearChat}
            disabled={
              (messages.length === 0 && imageAttachments.length === 0) || isLoading || !historyReady
            }
          >
            Clear
          </Button>
        </div>
      </div>

      <div
        ref={messageViewportRef}
        onDragEnter={handleMessageViewportDragEnter}
        onDragOver={handleMessageViewportDragOver}
        onDragLeave={handleMessageViewportDragLeave}
        onDrop={handleMessageViewportDrop}
        onScroll={() => {
          const viewport = messageViewportRef.current
          if (!viewport) {
            return
          }
          shouldAutoScrollRef.current = isNearBottom(viewport)
        }}
        className="relative min-h-0 flex-1 overflow-y-auto rounded-md border border-border/70 bg-muted/20 p-2"
      >
        {messageList}
        {showThinkingIndicator || showRecoveryIndicator ? (
          <div className="mt-2 flex justify-start" aria-live="polite">
            <div className="inline-flex max-w-[88%] items-center gap-1.5 rounded-xl border border-border/70 bg-background/70 px-2.5 py-2 text-xs text-muted-foreground">
              <ThinkingDotCluster />
              <span className="whitespace-nowrap">
                {showRecoveryIndicator ? 'Recovering in-flight response...' : 'Codex is thinking...'}
              </span>
            </div>
          </div>
        ) : null}
        {isDropTargetActive ? (
          <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-md border-2 border-dashed border-blue-500/60 bg-blue-500/10">
            <div className="rounded-md border border-border/70 bg-background/90 px-3 py-2 text-xs font-medium text-foreground shadow-sm">
              Drop images to attach
            </div>
          </div>
        ) : null}
      </div>

      {historyError || error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {historyError || error?.message}
        </div>
      ) : null}

      {imageAttachments.length > 0 ? (
        <div className="flex flex-wrap gap-2 rounded-md border border-border/70 bg-muted/20 p-2">
          {imageAttachments.map((attachment) => (
            <div
              key={attachment.id}
              className="group relative h-16 w-16 overflow-hidden rounded-md border border-border/70 bg-background"
              title={`${attachment.name} (${Math.max(1, Math.round(attachment.size / 1024))}KB)`}
            >
              <img
                src={attachment.dataUrl}
                alt={attachment.name}
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                className="absolute right-1 top-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm transition-opacity group-hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() =>
                  setImageAttachments((current) =>
                    current.filter((currentAttachment) => currentAttachment.id !== attachment.id)
                  )
                }
                aria-label={`Remove ${attachment.name}`}
                disabled={isLoading}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {attachmentError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {attachmentError}
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <textarea
          ref={promptInputRef}
          rows={1}
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value)
            resizePromptInput(event.currentTarget)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submitPrompt()
            }
          }}
          placeholder="Message Codex..."
          className="h-[30px] flex-1 resize-none rounded-md border border-border/70 bg-background px-2 py-1.5 text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={isLoading || !historyReady}
        />
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => void submitPrompt()}
          disabled={!canSubmitPrompt}
        >
          Send
        </Button>
      </div>
    </div>
  )
}

export const AssistantChatPanel = memo(function AssistantChatPanel({
  activeScopeKey,
  activeSpaceId,
  sessions,
  colorMode,
  accentColor,
  onStreamingChange
}: AssistantChatPanelProps): React.JSX.Element {
  const scopeSessions = useMemo(
    () => sessions.filter((session) => session.scopeKey === activeScopeKey),
    [activeScopeKey, sessions]
  )
  const resolvedActiveSession = useMemo(() => {
    if (activeSpaceId) {
      const explicit = scopeSessions.find((session) => session.spaceId === activeSpaceId)
      if (explicit) {
        return explicit
      }
    }
    return scopeSessions[0]
  }, [activeSpaceId, scopeSessions])
  const activeSessionKey = resolvedActiveSession
    ? `${resolvedActiveSession.scopeKey}:${resolvedActiveSession.spaceId}`
    : undefined

  return (
    <div className="h-full min-h-0">
      {sessions.map((session) => {
        const sessionKey = `${session.scopeKey}:${session.spaceId}`
        return (
          <div
            key={sessionKey}
            className={sessionKey === activeSessionKey ? 'h-full min-h-0' : 'hidden'}
          >
            <AssistantChatSession
              projectPath={session.projectPath}
              scopeKey={session.scopeKey}
              spaceId={session.spaceId}
              projectId={session.projectId}
              colorMode={colorMode}
              accentColor={accentColor}
              onStreamingChange={onStreamingChange}
            />
          </div>
        )
      })}
      {!resolvedActiveSession ? (
        <div className="flex h-full min-h-0 items-center justify-center rounded-md border border-border/70 bg-muted/20 p-3">
          <div className="text-xs text-muted-foreground">Select a space to start chatting.</div>
        </div>
      ) : null}
    </div>
  )
})

AssistantChatPanel.displayName = 'AssistantChatPanel'
