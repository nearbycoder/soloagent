import { useCallback, useEffect, useRef } from 'react'
import type {
  CreateTerminalInput,
  StartAgentInput,
  TerminalSession
} from '../../../shared/ipc/types'
import { useOrchestratorStore } from '../stores/orchestrator-store'

export function useOrchestration(): {
  refresh: () => Promise<void>
  createTerminal: (input?: CreateTerminalInput) => Promise<TerminalSession | undefined>
  closeTerminal: (terminalId: string) => Promise<void>
  renameTerminal: (terminalId: string, title: string) => Promise<void>
  startAgent: (input: StartAgentInput, terminalId?: string) => Promise<void>
} {
  const setTerminals = useOrchestratorStore((s) => s.setTerminals)
  const upsertTerminal = useOrchestratorStore((s) => s.upsertTerminal)
  const setAgents = useOrchestratorStore((s) => s.setAgents)
  const setActiveTerminal = useOrchestratorStore((s) => s.setActiveTerminal)
  const pushTerminalEvent = useOrchestratorStore((s) => s.pushTerminalEvent)
  const applyAgentEvent = useOrchestratorStore((s) => s.applyAgentEvent)
  const outputBufferRef = useRef<Record<string, string>>({})
  const outputFlushFrameRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    if (!window.api) {
      return
    }

    const [terminalResponse, agentResponse] = await Promise.all([
      window.api.terminal.list(),
      window.api.agent.list()
    ])

    if (terminalResponse.ok) {
      setTerminals(terminalResponse.data)
    }
    if (agentResponse.ok) {
      setAgents(agentResponse.data)
    }
  }, [setAgents, setTerminals])

  useEffect(() => {
    if (!window.api) {
      return
    }

    const flushBufferedTerminalOutput = (): void => {
      if (outputFlushFrameRef.current !== null) {
        window.cancelAnimationFrame(outputFlushFrameRef.current)
        outputFlushFrameRef.current = null
      }

      const buffered = outputBufferRef.current
      const terminalIds = Object.keys(buffered)
      if (terminalIds.length === 0) {
        return
      }

      outputBufferRef.current = {}

      for (const terminalId of terminalIds) {
        const chunk = buffered[terminalId]
        if (!chunk) {
          continue
        }
        pushTerminalEvent({ type: 'output', terminalId, chunk })
      }
    }

    const scheduleOutputFlush = (): void => {
      if (outputFlushFrameRef.current !== null) {
        return
      }

      outputFlushFrameRef.current = window.requestAnimationFrame(() => {
        outputFlushFrameRef.current = null
        flushBufferedTerminalOutput()
      })
    }

    const offTerminal = window.api.terminal.onEvent((event) => {
      if (event.type === 'output') {
        outputBufferRef.current[event.terminalId] =
          (outputBufferRef.current[event.terminalId] || '') + event.chunk
        scheduleOutputFlush()
        return
      }

      flushBufferedTerminalOutput()
      pushTerminalEvent(event)
      if (event.type === 'exit') {
        void refresh()
      }
    })
    const offAgent = window.api.agent.onEvent((event) => applyAgentEvent(event))
    return () => {
      flushBufferedTerminalOutput()
      offTerminal()
      offAgent()
    }
  }, [applyAgentEvent, pushTerminalEvent, refresh])

  const createTerminal = useCallback(
    async (input: CreateTerminalInput = {}) => {
      if (!window.api) {
        return undefined
      }

      const response = await window.api.terminal.create(input)
      if (response.ok) {
        upsertTerminal(response.data)
        void refresh()
        if (!input.parentTerminalId) {
          setActiveTerminal(response.data.id)
        }
        return response.data
      }
      return undefined
    },
    [refresh, setActiveTerminal, upsertTerminal]
  )

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      if (!window.api) {
        return
      }

      const response = await window.api.terminal.close({ terminalId })
      if (response.ok) {
        await refresh()
      }
    },
    [refresh]
  )

  const renameTerminal = useCallback(
    async (terminalId: string, title: string) => {
      if (!window.api) {
        return
      }

      const response = await window.api.terminal.rename({ terminalId, title })
      if (response.ok) {
        await refresh()
      }
    },
    [refresh]
  )

  const startAgent = useCallback(
    async (input: StartAgentInput, terminalId?: string) => {
      if (!window.api) {
        return
      }

      const response = await window.api.agent.start(input, terminalId)
      if (response.ok) {
        await refresh()
      }
    },
    [refresh]
  )

  return { refresh, createTerminal, closeTerminal, renameTerminal, startAgent }
}
