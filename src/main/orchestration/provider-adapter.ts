import type { AgentRecord, StartAgentInput } from '../../shared/ipc/types'

export type ProviderStartContext = {
  terminalId: string
}

export interface ProviderAdapter {
  id: 'local-cli' | 'remote'
  start(input: StartAgentInput, context: ProviderStartContext): Promise<Partial<AgentRecord>>
  stop(agent: AgentRecord): Promise<void>
}
