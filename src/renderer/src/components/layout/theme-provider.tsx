/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren
} from 'react'
import type { ThemePreference } from '../../../../shared/ipc/types'

const THEME_STORAGE_KEY = 'soloagent.theme'

type ThemeContextValue = {
  theme: ThemePreference
  setTheme: (theme: ThemePreference) => Promise<void>
  resolvedTheme: 'light' | 'dark'
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [theme, setThemeState] = useState<ThemePreference>(() => {
    const cached = localStorage.getItem(THEME_STORAGE_KEY)
    if (cached === 'light' || cached === 'dark' || cached === 'system') {
      return cached
    }
    return 'system'
  })
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  useEffect(() => {
    if (!window.api) {
      return
    }

    void (async () => {
      const response = await window.api.config.get('theme')
      if (
        response.ok &&
        (response.data === 'light' || response.data === 'dark' || response.data === 'system')
      ) {
        setThemeState(response.data)
      } else {
        const cached = localStorage.getItem(THEME_STORAGE_KEY)
        if (cached === 'light' || cached === 'dark' || cached === 'system') {
          setThemeState(cached)
        }
      }
    })()
  }, [])

  const resolvedTheme = useMemo<'light' | 'dark'>(() => {
    if (theme === 'system') {
      return systemPrefersDark ? 'dark' : 'light'
    }
    return theme
  }, [theme, systemPrefersDark])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark')
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [resolvedTheme, theme])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (): void => setSystemPrefersDark(media.matches)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [])

  const setTheme = useCallback(async (nextTheme: ThemePreference) => {
    setThemeState(nextTheme)
    if (window.api) {
      await window.api.config.set('theme', nextTheme)
    }
  }, [])

  const value = useMemo(
    () => ({
      theme,
      setTheme,
      resolvedTheme
    }),
    [theme, setTheme, resolvedTheme]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return context
}
