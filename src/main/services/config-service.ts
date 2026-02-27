import type { AppSetting, ThemePreference } from '../../shared/ipc/types'
import { defaultConfig } from '../config/defaults'
import { AppSettingsRepository } from '../data/repositories/app-settings-repository'

export class ConfigService {
  constructor(private readonly appSettingsRepository: AppSettingsRepository) {}

  getThemePreference(): ThemePreference {
    const value = this.appSettingsRepository.get('theme')
    if (value === 'light' || value === 'dark' || value === 'system') {
      return value
    }
    return defaultConfig.theme
  }

  setThemePreference(value: ThemePreference): AppSetting {
    return this.appSettingsRepository.set('theme', value)
  }

  get(key: string): string | undefined {
    return this.appSettingsRepository.get(key)
  }

  set(key: string, value: string): AppSetting {
    return this.appSettingsRepository.set(key, value)
  }

  all(): AppSetting[] {
    return this.appSettingsRepository.all()
  }
}
