import { useEffect } from 'react'

export function useSmokeChecks(): void {
  useEffect(() => {
    if (!window.api) {
      console.warn('Preload API is unavailable; skipping smoke checks.')
      return
    }

    void (async () => {
      const checks = await Promise.all([
        window.api.app.health(),
        window.api.terminal.list(),
        window.api.agent.list(),
        window.api.config.all()
      ])

      const failed = checks.filter((result) => !result.ok)
      if (failed.length > 0) {
        console.warn('IPC smoke checks reported failures', failed)
      }
    })()
  }, [])
}
