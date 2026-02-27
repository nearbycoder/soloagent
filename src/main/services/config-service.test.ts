import { describe, expect, it } from 'vitest'
import type { AppSetting } from '../../shared/ipc/types'
import { ConfigService } from './config-service'

class FakeAppSettingsRepository {
  private readonly values = new Map<string, string>()

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.values.set(key, value)
    }
  }

  get(key: string): string | undefined {
    return this.values.get(key)
  }

  set(key: string, value: string): AppSetting {
    this.values.set(key, value)
    return { key, value }
  }

  all(): AppSetting[] {
    return [...this.values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value }))
  }
}

function createService(initial: Record<string, string> = {}): {
  service: ConfigService
  repository: FakeAppSettingsRepository
} {
  const repository = new FakeAppSettingsRepository(initial)
  const service = new ConfigService(
    repository as unknown as ConstructorParameters<typeof ConfigService>[0]
  )
  return { service, repository }
}

describe('ConfigService', () => {
  it('returns theme from setting when valid', () => {
    const { service } = createService({ theme: 'dark' })
    expect(service.getThemePreference()).toBe('dark')
  })

  it('falls back to default theme for invalid stored value', () => {
    const { service } = createService({ theme: 'neon' })
    expect(service.getThemePreference()).toBe('system')
  })

  it('writes theme via setThemePreference', () => {
    const { service, repository } = createService()

    const written = service.setThemePreference('light')

    expect(written).toEqual({ key: 'theme', value: 'light' })
    expect(repository.get('theme')).toBe('light')
  })

  it('reads and writes arbitrary settings', () => {
    const { service } = createService({ 'workspace.home.visible': '1' })

    expect(service.get('workspace.home.visible')).toBe('1')
    expect(service.set('workspace.home.visible', '0')).toEqual({
      key: 'workspace.home.visible',
      value: '0'
    })
    expect(service.get('workspace.home.visible')).toBe('0')
  })

  it('returns all settings in repository order', () => {
    const { service } = createService({ b: '2', a: '1' })

    expect(service.all()).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' }
    ])
  })
})
