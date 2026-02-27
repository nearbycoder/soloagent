import type { AppSetting } from '../../../shared/ipc/types'
import { SqliteService } from '../sqlite'

export class AppSettingsRepository {
  constructor(private readonly sqlite: SqliteService) {}

  get(key: string): string | undefined {
    const row = this.sqlite
      .instance()
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(key) as { value: string } | undefined
    return row?.value
  }

  set(key: string, value: string): AppSetting {
    this.sqlite
      .instance()
      .prepare(
        `
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `
      )
      .run(key, value, Date.now())

    return { key, value }
  }

  all(): AppSetting[] {
    return this.sqlite
      .instance()
      .prepare('SELECT key, value FROM app_settings ORDER BY key ASC')
      .all() as AppSetting[]
  }
}
