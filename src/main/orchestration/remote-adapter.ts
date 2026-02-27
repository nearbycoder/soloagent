import type { AgentRecord, StartAgentInput } from '../../shared/ipc/types'
import type { ProviderAdapter, ProviderStartContext } from './provider-adapter'

export class RemoteAdapterStub implements ProviderAdapter {
  id = 'remote' as const

  async start(
    input: StartAgentInput,
    context: ProviderStartContext
  ): Promise<Partial<AgentRecord>> {
    return {
      name: input.name,
      provider: 'remote',
      terminalId: context.terminalId,
      status: 'running'
    }
  }

  async stop(agent: AgentRecord): Promise<void> {
    void agent
    return Promise.resolve()
  }
}
