import { randomUUID } from 'node:crypto'
import type { ChatHistoryMessage, ChatHistoryReplaceInput } from '../../../shared/ipc/types'
import { SqliteService } from '../sqlite'

export class ChatHistoryRepository {
  constructor(private readonly sqlite: SqliteService) {}

  list(scopeKey: string, spaceId: string): ChatHistoryMessage[] {
    const rows = this.sqlite
      .instance()
      .prepare(
        `
        SELECT message_id, role, content, created_at
        FROM chat_history_messages
        WHERE scope_key = ? AND space_id = ?
        ORDER BY sort_index ASC, created_at ASC
        `
      )
      .all(scopeKey, spaceId) as Array<{
      message_id: string
      role: 'system' | 'user' | 'assistant'
      content: string
      created_at: number
    }>

    return rows.map((row) => ({
      id: row.message_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at
    }))
  }

  replace(input: ChatHistoryReplaceInput): void {
    const db = this.sqlite.instance()
    const deleteStmt = db.prepare(
      `
      DELETE FROM chat_history_messages
      WHERE scope_key = ? AND space_id = ?
      `
    )
    const insertStmt = db.prepare(
      `
      INSERT INTO chat_history_messages (
        id,
        scope_key,
        space_id,
        project_id,
        message_id,
        sort_index,
        role,
        content,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )

    db.exec('BEGIN')
    try {
      deleteStmt.run(input.scopeKey, input.spaceId)

      input.messages.forEach((message, index) => {
        insertStmt.run(
          randomUUID(),
          input.scopeKey,
          input.spaceId,
          input.projectId || null,
          message.id,
          index,
          message.role,
          message.content,
          message.createdAt
        )
      })

      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
