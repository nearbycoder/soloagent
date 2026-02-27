import { BrowserWindow } from 'electron'
import type { ThemePreference } from '../../shared/ipc/types'

const WINDOW_BACKGROUND_LIGHT = '#ffffff'
const WINDOW_BACKGROUND_DARK = '#09090b'

export function resolveWindowBackgroundColor(
  themePreference: ThemePreference,
  systemPrefersDark: boolean
): string {
  if (themePreference === 'dark') {
    return WINDOW_BACKGROUND_DARK
  }
  if (themePreference === 'light') {
    return WINDOW_BACKGROUND_LIGHT
  }
  return systemPrefersDark ? WINDOW_BACKGROUND_DARK : WINDOW_BACKGROUND_LIGHT
}

export function applyWindowBackgroundToAllWindows(
  themePreference: ThemePreference,
  systemPrefersDark: boolean
): void {
  const color = resolveWindowBackgroundColor(themePreference, systemPrefersDark)
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    window.setBackgroundColor(color)
  }
}
