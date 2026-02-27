import { spawn } from 'node:child_process'
import type { ChatCompleteInput, ChatCompleteResult, ChatToolCall } from '../../shared/ipc/types'

export type SpawnedCodexProcess = {
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  on(event: 'error', listener: (error: Error) => void): SpawnedCodexProcess
  on(event: 'close', listener: (code: number | null) => void): SpawnedCodexProcess
  kill(signal?: NodeJS.Signals | number): boolean
  killed: boolean
}

export type SpawnCodexProcess = (
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2]
) => SpawnedCodexProcess

export type RunningChatRequest = {
  child: SpawnedCodexProcess
  aborted: boolean
}

function defaultSpawnCodex(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2]
): SpawnedCodexProcess {
  const child = spawn(command, args, options)
  if (!child.stdout || !child.stderr) {
    throw new Error('Codex process did not provide stdio streams.')
  }
  return child as unknown as SpawnedCodexProcess
}

const MAX_TOOL_DETAIL_CHARS = 600

type JsonObject = Record<string, unknown>

function asRecord(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as JsonObject
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function truncateDetail(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.trim()
  if (!normalized) return undefined
  return normalized.length > MAX_TOOL_DETAIL_CHARS
    ? `${normalized.slice(0, MAX_TOOL_DETAIL_CHARS)}...`
    : normalized
}

function normalizeToolStatus(value: unknown): ChatToolCall['status'] | undefined {
  const raw = asString(value)?.trim().toLowerCase()
  if (!raw) {
    return undefined
  }

  if (raw === 'failed' || raw === 'error') {
    return 'failed'
  }
  if (raw === 'completed' || raw === 'done' || raw === 'success') {
    return 'completed'
  }
  if (raw === 'in_progress' || raw === 'running' || raw === 'pending' || raw === 'started') {
    return 'in_progress'
  }
  return undefined
}

function toTitleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((chunk) => chunk[0]?.toUpperCase() + chunk.slice(1))
    .join(' ')
}

function buildToolTitle(itemType: string, item: JsonObject): string {
  if (itemType === 'command_execution') {
    const command = asString(item.command)?.trim()
    if (command) {
      return command
    }
  }

  const directName = asString(item.name)?.trim()
  if (directName) {
    return directName
  }

  const toolName = asString(item.tool_name)?.trim()
  if (toolName) {
    return toolName
  }

  const functionName = asString(asRecord(item.function)?.name)?.trim()
  if (functionName) {
    return functionName
  }

  return toTitleCase(itemType)
}

function buildToolDetails(itemType: string, item: JsonObject): string | undefined {
  if (itemType === 'command_execution') {
    return (
      truncateDetail(asString(item.aggregated_output)) ||
      truncateDetail(asString(item.output)) ||
      truncateDetail(asString(item.stderr))
    )
  }

  return (
    truncateDetail(asString(item.summary)) ||
    truncateDetail(asString(item.message)) ||
    truncateDetail(asString(item.input)) ||
    truncateDetail(asString(item.arguments))
  )
}

function inferToolStatus(
  eventType: string,
  item: JsonObject,
  currentStatus: ChatToolCall['status']
): ChatToolCall['status'] {
  let nextStatus: ChatToolCall['status'] = currentStatus

  if (eventType === 'item.completed') {
    nextStatus = 'completed'
  } else if (eventType === 'item.failed') {
    nextStatus = 'failed'
  } else if (eventType === 'item.started' || eventType === 'item.updated') {
    nextStatus = 'in_progress'
  }

  const explicitStatus = normalizeToolStatus(item.status)
  if (explicitStatus) {
    nextStatus = explicitStatus
  }

  const exitCode = asNumber(item.exit_code)
  if (typeof exitCode === 'number') {
    if (exitCode !== 0) {
      nextStatus = 'failed'
    } else if (eventType === 'item.completed') {
      nextStatus = 'completed'
    }
  }

  const errorValue = item.error
  const errorMessage = asString(errorValue) || asString(asRecord(errorValue)?.message)
  if (errorMessage?.trim()) {
    nextStatus = 'failed'
  }

  return nextStatus
}

export function buildCodexPrompt(messages: ChatCompleteInput['messages']): string {
  const transcript = messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content.trim()}`)
    .join('\n\n')

  return [
    'Continue the conversation below.',
    'Respond only as ASSISTANT to the latest USER message.',
    transcript,
    'ASSISTANT:'
  ].join('\n\n')
}

export async function runCodexCompletion(
  input: ChatCompleteInput,
  runningRequests: Map<string, RunningChatRequest>,
  onToolCallUpdate?: (toolCall: ChatToolCall) => void,
  spawnCodex: SpawnCodexProcess = defaultSpawnCodex
): Promise<ChatCompleteResult> {
  const existingRequest = runningRequests.get(input.requestId)
  if (existingRequest) {
    existingRequest.aborted = true
    if (!existingRequest.child.killed) {
      existingRequest.child.kill('SIGTERM')
    }
    runningRequests.delete(input.requestId)
  }

  const prompt = buildCodexPrompt(input.messages)
  const reasoningEffort = input.reasoningEffort || 'high'
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'workspace-write',
    '-m',
    input.model,
    '-c',
    `model_reasoning_effort="${reasoningEffort}"`
  ]

  if (input.cwd) {
    args.push('-C', input.cwd)
  }
  args.push(prompt)

  return await new Promise((resolve, reject) => {
    const child = spawnCodex('codex', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    })
    const runningRequest: RunningChatRequest = { child, aborted: false }
    runningRequests.set(input.requestId, runningRequest)

    let stdoutBuffer = ''
    let stderrBuffer = ''
    const assistantMessages: string[] = []
    const errors: string[] = []
    const toolCallsById = new Map<string, ChatToolCall>()
    const toolCallOrder: string[] = []

    const clearRunningRequest = (): boolean => {
      const current = runningRequests.get(input.requestId)
      if (current?.child === child) {
        runningRequests.delete(input.requestId)
        return current.aborted
      }
      return runningRequest.aborted
    }

    const parseJsonLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) {
        return
      }

      try {
        const parsed = asRecord(JSON.parse(trimmed))
        const parsedType = asString(parsed?.type)
        if (!parsed || !parsedType) {
          return
        }

        const item = asRecord(parsed.item)
        const itemType = asString(item?.type)

        if (parsedType === 'item.completed' && itemType === 'agent_message') {
          const itemText = asString(item?.text)
          if (itemText?.trim()) {
            assistantMessages.push(itemText.trim())
          }
          return
        }

        if (parsedType === 'item.completed' && itemType === 'error') {
          const itemMessage = asString(item?.message)
          if (itemMessage?.trim()) {
            errors.push(itemMessage.trim())
          }
          return
        }

        if (parsedType.startsWith('item.') && item && itemType && itemType !== 'agent_message') {
          const rawItemId = asString(item.id)?.trim()
          const toolCallId =
            rawItemId && rawItemId.length > 0
              ? rawItemId
              : `${itemType}-${toolCallOrder.length + 1}`

          if (!toolCallsById.has(toolCallId)) {
            toolCallsById.set(toolCallId, {
              id: toolCallId,
              type: itemType,
              title: buildToolTitle(itemType, item),
              status: 'in_progress',
              details: buildToolDetails(itemType, item),
              exitCode: asNumber(item.exit_code)
            })
            toolCallOrder.push(toolCallId)
          } else {
            const existing = toolCallsById.get(toolCallId)
            if (existing) {
              existing.title = buildToolTitle(itemType, item) || existing.title
              const details = buildToolDetails(itemType, item)
              if (details) {
                existing.details = details
              }
              const exitCode = asNumber(item.exit_code)
              if (typeof exitCode === 'number') {
                existing.exitCode = exitCode
              }
            }
          }

          const current = toolCallsById.get(toolCallId)
          if (current) {
            current.status = inferToolStatus(parsedType, item, current.status)
            onToolCallUpdate?.({ ...current })
          }
        }

        const topLevelMessage = asString(parsed.message)
        if (parsedType === 'error' && topLevelMessage?.trim()) {
          errors.push(topLevelMessage.trim())
          return
        }

        const turnFailedError = asRecord(parsed.error)
        const turnFailedMessage = asString(turnFailedError?.message)
        if (
          parsedType === 'turn.failed' &&
          typeof turnFailedMessage === 'string' &&
          turnFailedMessage.trim()
        ) {
          errors.push(turnFailedMessage.trim())
        }
      } catch {
        // Ignore non-JSON diagnostics/warnings.
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      let newlineIndex = stdoutBuffer.indexOf('\n')
      while (newlineIndex !== -1) {
        parseJsonLine(stdoutBuffer.slice(0, newlineIndex))
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
        newlineIndex = stdoutBuffer.indexOf('\n')
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8')
    })

    child.on('error', (error: Error) => {
      const wasAborted = clearRunningRequest()
      if (wasAborted) {
        reject(new Error('Chat request aborted.'))
        return
      }
      reject(error)
    })

    child.on('close', (code: number | null) => {
      const wasAborted = clearRunningRequest()
      if (wasAborted) {
        reject(new Error('Chat request aborted.'))
        return
      }

      if (stdoutBuffer.trim()) {
        parseJsonLine(stdoutBuffer)
      }

      if (code !== 0) {
        const reason = errors[0] || stderrBuffer.trim() || `codex exited with code ${code}`
        reject(new Error(reason))
        return
      }

      const text = assistantMessages.join('\n\n').trim()
      if (!text) {
        const reason = errors[0] || stderrBuffer.trim() || 'Codex returned no assistant response.'
        reject(new Error(reason))
        return
      }

      resolve({
        text,
        model: input.model,
        toolCalls: toolCallOrder
          .map((id) => toolCallsById.get(id))
          .filter((tool): tool is ChatToolCall => Boolean(tool))
      })
    })
  })
}
