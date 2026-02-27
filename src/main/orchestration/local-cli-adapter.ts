import type { AgentRecord, StartAgentInput } from '../../shared/ipc/types'
import type { ProviderAdapter, ProviderStartContext } from './provider-adapter'

export class LocalCliAdapter implements ProviderAdapter {
  id = 'local-cli' as const

  async start(
    input: StartAgentInput,
    context: ProviderStartContext
  ): Promise<Partial<AgentRecord>> {
    return {
      name: input.name,
      provider: 'local-cli',
      command: input.command,
      args: input.args,
      terminalId: context.terminalId,
      status: 'running'
    }
  }

  async stop(): Promise<void> {
    return Promise.resolve()
  }
}
