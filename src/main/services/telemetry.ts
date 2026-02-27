import type { PerformanceMetrics } from '../../shared/ipc/types'

export class TelemetryService {
  private outputEvents = 0
  private minuteWindowStart = Date.now()
  private activeTerminals = 0
  private activeAgents = 0
  private bufferedChunks = 0

  setActiveTerminals(count: number): void {
    this.activeTerminals = count
  }

  setActiveAgents(count: number): void {
    this.activeAgents = count
  }

  setBufferedChunks(count: number): void {
    this.bufferedChunks = count
  }

  onTerminalOutput(): void {
    const now = Date.now()
    if (now - this.minuteWindowStart > 60_000) {
      this.minuteWindowStart = now
      this.outputEvents = 0
    }
    this.outputEvents += 1
  }

  snapshot(): PerformanceMetrics {
    return {
      activeTerminals: this.activeTerminals,
      activeAgents: this.activeAgents,
      outputEventsPerMinute: this.outputEvents,
      bufferedChunks: this.bufferedChunks
    }
  }
}
