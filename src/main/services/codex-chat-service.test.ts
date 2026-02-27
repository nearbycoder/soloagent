import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { ChatCompleteInput, ChatToolCall } from '../../shared/ipc/types'
import {
  buildCodexPrompt,
  runCodexCompletion,
  type RunningChatRequest,
  type SpawnCodexProcess,
  type SpawnedCodexProcess
} from './codex-chat-service'

class MockCodexProcess extends EventEmitter implements SpawnedCodexProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  readonly killSignals: NodeJS.Signals[] = []

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true
    if (typeof signal === 'string') {
      this.killSignals.push(signal)
    }
    return true
  }

  emitStdout(line: string): void {
    this.stdout.write(Buffer.from(line, 'utf8'))
  }

  emitStderr(line: string): void {
    this.stderr.write(Buffer.from(line, 'utf8'))
  }

  finish(code: number | null): void {
    this.emit('close', code)
  }
}

function makeInput(overrides: Partial<ChatCompleteInput> = {}): ChatCompleteInput {
  return {
    requestId: 'req-1',
    model: 'gpt-5-codex',
    messages: [{ role: 'user', content: 'Hello there' }],
    cwd: '/tmp/project',
    ...overrides
  }
}

describe('codex-chat-service', () => {
  it('builds a codex prompt from messages', () => {
    const prompt = buildCodexPrompt([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Fix this bug.' }
    ])

    expect(prompt).toContain('Continue the conversation below.')
    expect(prompt).toContain('SYSTEM:\nYou are helpful.')
    expect(prompt).toContain('USER:\nFix this bug.')
    expect(prompt.endsWith('ASSISTANT:')).toBe(true)
  })

  it('returns assistant text and parsed tool calls from streamed codex JSON', async () => {
    const process = new MockCodexProcess()
    const spawnCalls: Array<{
      command: string
      args: string[]
      options: Parameters<SpawnCodexProcess>[2]
    }> = []
    const spawnCodex: SpawnCodexProcess = (command, args, options) => {
      spawnCalls.push({ command, args: [...args], options })
      return process
    }

    const toolUpdates: ChatToolCall[] = []
    const runningRequests = new Map<string, RunningChatRequest>()
    const completionPromise = runCodexCompletion(
      makeInput(),
      runningRequests,
      (toolCall) => toolUpdates.push(toolCall),
      spawnCodex
    )

    process.emitStdout(
      `${JSON.stringify({
        type: 'item.started',
        item: {
          id: 'tool-1',
          type: 'command_execution',
          command: 'npm run test'
        }
      })}\n`
    )
    process.emitStdout(
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'tool-1',
          type: 'command_execution',
          command: 'npm run test',
          exit_code: 0,
          aggregated_output: 'All tests passed.'
        }
      })}\n`
    )
    process.emitStdout(
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'Done. Tests are green.'
        }
      })}\n`
    )
    process.finish(0)

    const result = await completionPromise

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]?.command).toBe('codex')
    expect(spawnCalls[0]?.args).toContain('exec')
    expect(spawnCalls[0]?.args).toContain('--json')
    expect(spawnCalls[0]?.args).toContain('workspace-write')
    expect(spawnCalls[0]?.args).toContain('-C')
    expect(spawnCalls[0]?.args).toContain('/tmp/project')
    expect(spawnCalls[0]?.args).toContain('model_reasoning_effort="high"')
    expect(spawnCalls[0]?.options).toMatchObject({
      stdio: ['ignore', 'pipe', 'pipe']
    })

    expect(result.text).toBe('Done. Tests are green.')
    expect(result.model).toBe('gpt-5-codex')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]).toMatchObject({
      id: 'tool-1',
      title: 'npm run test',
      status: 'completed',
      exitCode: 0
    })
    expect(result.toolCalls[0]?.details).toBe('All tests passed.')

    expect(toolUpdates.length).toBeGreaterThanOrEqual(2)
    expect(toolUpdates[0]?.status).toBe('in_progress')
    expect(toolUpdates.at(-1)?.status).toBe('completed')
  })

  it('passes custom reasoning effort to codex exec', async () => {
    const process = new MockCodexProcess()
    const spawnCalls: Array<{ args: string[] }> = []
    const spawnCodex: SpawnCodexProcess = (_command, args) => {
      spawnCalls.push({ args: [...args] })
      return process
    }

    const runningRequests = new Map<string, RunningChatRequest>()
    const completionPromise = runCodexCompletion(
      makeInput({ reasoningEffort: 'low' }),
      runningRequests,
      undefined,
      spawnCodex
    )

    process.emitStdout(
      `${JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Reasoning set.' }
      })}\n`
    )
    process.finish(0)

    await expect(completionPromise).resolves.toMatchObject({ text: 'Reasoning set.' })
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]?.args).toContain('model_reasoning_effort="low"')
  })

  it('kills an in-flight request when same request id is reused', async () => {
    const previous = new MockCodexProcess()
    const replacement = new MockCodexProcess()
    const spawnCodex: SpawnCodexProcess = () => replacement
    const runningRequests = new Map<string, RunningChatRequest>([
      ['req-1', { child: previous, aborted: false }]
    ])

    const completionPromise = runCodexCompletion(
      makeInput(),
      runningRequests,
      undefined,
      spawnCodex
    )

    expect(previous.killSignals).toEqual(['SIGTERM'])

    replacement.emitStdout(
      `${JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Replacement request completed.' }
      })}\n`
    )
    replacement.finish(0)

    await expect(completionPromise).resolves.toMatchObject({
      text: 'Replacement request completed.'
    })
    expect(runningRequests.size).toBe(0)
  })

  it('rejects when codex exits non-zero and emits structured error', async () => {
    const process = new MockCodexProcess()
    const spawnCodex: SpawnCodexProcess = () => process
    const runningRequests = new Map<string, RunningChatRequest>()
    const completionPromise = runCodexCompletion(
      makeInput(),
      runningRequests,
      undefined,
      spawnCodex
    )

    process.emitStdout(
      `${JSON.stringify({
        type: 'item.completed',
        item: { type: 'error', message: 'Permission denied' }
      })}\n`
    )
    process.finish(1)

    await expect(completionPromise).rejects.toThrow('Permission denied')
    expect(runningRequests.size).toBe(0)
  })

  it('rejects with aborted message when request is marked aborted before close', async () => {
    const process = new MockCodexProcess()
    const spawnCodex: SpawnCodexProcess = () => process
    const runningRequests = new Map<string, RunningChatRequest>()
    const completionPromise = runCodexCompletion(
      makeInput(),
      runningRequests,
      undefined,
      spawnCodex
    )

    const running = runningRequests.get('req-1')
    expect(running).toBeDefined()
    if (!running) {
      throw new Error('Expected running request to exist')
    }
    running.aborted = true
    process.finish(0)

    await expect(completionPromise).rejects.toThrow('Chat request aborted.')
  })

  it('rejects when codex exits successfully but no assistant response is produced', async () => {
    const process = new MockCodexProcess()
    const spawnCodex: SpawnCodexProcess = () => process
    const runningRequests = new Map<string, RunningChatRequest>()
    const completionPromise = runCodexCompletion(
      makeInput(),
      runningRequests,
      undefined,
      spawnCodex
    )

    process.emitStdout(
      `${JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'pwd', exit_code: 0 }
      })}\n`
    )
    process.finish(0)

    await expect(completionPromise).rejects.toThrow('Codex returned no assistant response.')
  })
})
