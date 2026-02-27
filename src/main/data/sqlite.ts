import { app } from 'electron'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrations } from './migrations'

export class SqliteService {
  private db: DatabaseSync

  constructor() {
    const dbPath = join(app.getPath('userData'), 'soloagent.db')
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.runMigrations()
  }

  private runMigrations(): void {
    this.db.exec(migrations[0])
    const selectStmt = this.db.prepare('SELECT name FROM schema_migrations WHERE name = ?')
    const insertStmt = this.db.prepare(
      'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)'
    )

    for (let index = 1; index < migrations.length; index += 1) {
      const name = `migration_${index}`
      const exists = selectStmt.get(name) as { name: string } | undefined
      if (exists) continue
      this.db.exec(migrations[index])
      insertStmt.run(name, Date.now())
    }
  }

  instance(): DatabaseSync {
    return this.db
  }

  close(): void {
    this.db.close()
  }
}
