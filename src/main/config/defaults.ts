import type { ThemePreference } from '../../shared/ipc/types'

export const defaultConfig = {
  theme: 'system' as ThemePreference,
  maxTerminalSessions: 12,
  maxBufferedOutputChunks: 2000
}
