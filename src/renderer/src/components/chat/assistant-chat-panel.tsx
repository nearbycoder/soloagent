import type { ModelMessage, StreamChunk } from '@tanstack/ai'
import type { ConnectionAdapter, UIMessage } from '@tanstack/ai-client'
import { useChat } from '@tanstack/ai-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, ChevronDown, Search } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import remarkGfm from 'remark-gfm'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatHistoryMessage, ChatMessage, ChatToolCall } from '../../../../shared/ipc/types'
import type { ChatReasoningEffort } from '../../../../shared/ipc/types'
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
const MARKDOWN_PLUGINS = [remarkGfm]

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

type ChatRenderItem = ChatMessageRenderItem | LiveToolRenderItem

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
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

function isReasoningEffort(value: string): value is ChatReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high'
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
      <ReactMarkdown skipHtml remarkPlugins={MARKDOWN_PLUGINS} components={markdownComponents}>
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
  onStreamingChange
}: AssistantChatSessionProps): React.JSX.Element {
  const modelInputId = `chat-model-${scopeKey}-${spaceId}`
  const reasoningEffortInputId = `chat-reasoning-${scopeKey}-${spaceId}`
  const [model, setModel] = useState<string>(DEFAULT_MODEL)
  const [reasoningEffort, setReasoningEffort] =
    useState<ChatReasoningEffort>(DEFAULT_REASONING_EFFORT)
  const [prompt, setPrompt] = useState('')
  const [historyReady, setHistoryReady] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [liveToolCalls, setLiveToolCalls] = useState<ChatToolCall[]>([])
  const messageViewportRef = useRef<HTMLDivElement | null>(null)
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const liveToolCallsRef = useRef<ChatToolCall[]>([])
  const shouldAutoScrollRef = useRef(true)

  const connection = useMemo<ConnectionAdapter>(
    () => ({
      async *connect(messages, _data, abortSignal): AsyncIterable<StreamChunk> {
        if (abortSignal?.aborted) {
          return
        }

        const requestId = createRequestId()
        activeRequestIdRef.current = requestId
        setLiveToolCalls([])
        liveToolCallsRef.current = []
        const abortRequest = (): void => {
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
            cwd: projectPath
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
          const messageId = `assistant-${Date.now()}`
          const now = Date.now()
          const assistantText = response.data.text || ''
          const toolCalls = response.data.toolCalls || []
          const resolvedToolCalls = toolCalls.length > 0 ? toolCalls : liveToolCallsRef.current

          yield {
            type: 'RUN_STARTED',
            runId,
            timestamp: now,
            model
          }

          if (resolvedToolCalls.length > 0) {
            const toolMessageId = `tools-${Date.now()}`
            const toolContent = formatToolCallsMessage(resolvedToolCalls)
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
            messageId,
            role: 'assistant',
            timestamp: now,
            model
          }

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
                messageId,
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
              messageId,
              delta: '',
              content: '',
              timestamp: Date.now(),
              model
            }
          }

          yield {
            type: 'TEXT_MESSAGE_END',
            messageId,
            timestamp: Date.now(),
            model
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
          setLiveToolCalls([])
          liveToolCallsRef.current = []
          abortSignal?.removeEventListener('abort', abortRequest)
        }
      }
    }),
    [model, projectPath, reasoningEffort]
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
  const liveToolItem = useMemo<LiveToolRenderItem | null>(() => {
    if (!isLoading || liveToolCalls.length === 0) {
      return null
    }

    return {
      id: 'live-tools',
      kind: 'live-tools',
      payload: buildToolTracePayload(liveToolCalls)
    }
  }, [isLoading, liveToolCalls])
  const renderItems = useMemo<ChatRenderItem[]>(
    () => [...messageItems, ...(liveToolItem ? [liveToolItem] : [])],
    [liveToolItem, messageItems]
  )
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
      if (event.type !== 'tool_call') {
        return
      }
      if (!activeRequestIdRef.current || event.requestId !== activeRequestIdRef.current) {
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
    messages,
    renderItems.length,
    rowVirtualizer,
    shouldVirtualize
  ])

  useEffect(() => {
    resizePromptInput(promptInputRef.current)
  }, [prompt])

  const submitPrompt = async (): Promise<void> => {
    const trimmed = prompt.trim()
    if (!trimmed || isLoading || !historyReady) {
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

    setPrompt('')
    await sendMessage(trimmed)
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
    <div className="flex h-full min-h-0 flex-col gap-1.5">
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
            <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={stop}>
              Stop
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={clear}
            disabled={messages.length === 0 || isLoading || !historyReady}
          >
            Clear
          </Button>
        </div>
      </div>

      <div
        ref={messageViewportRef}
        onScroll={() => {
          const viewport = messageViewportRef.current
          if (!viewport) {
            return
          }
          shouldAutoScrollRef.current = isNearBottom(viewport)
        }}
        className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border/70 bg-muted/20 p-2"
      >
        {messageList}
      </div>

      {historyError || error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {historyError || error?.message}
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
          disabled={isLoading || !historyReady}
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
