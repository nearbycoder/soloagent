import { randomUUID } from 'node:crypto'
import type {
  AgentProfile,
  CreateAgentProfileInput,
  DeleteAgentProfileInput
} from '../../../shared/ipc/types'
import { SqliteService } from '../sqlite'

export class AgentProfilesRepository {
  constructor(private readonly sqlite: SqliteService) {}

  create(input: CreateAgentProfileInput, projectId?: string): AgentProfile {
    const profile: AgentProfile = {
      id: randomUUID(),
      projectId,
      name: input.name,
      provider: input.provider,
      command: input.command,
      args: input.args,
      createdAt: Date.now()
    }

    this.sqlite
      .instance()
      .prepare(
        `
        INSERT INTO agent_profiles (id, project_id, name, provider, command, args_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        profile.id,
        profile.projectId ?? null,
        profile.name,
        profile.provider,
        profile.command ?? null,
        JSON.stringify(profile.args ?? []),
        profile.createdAt
      )

    return profile
  }

  list(projectId?: string): AgentProfile[] {
    const rows = this.sqlite
      .instance()
      .prepare(
        `
        SELECT id, project_id, name, provider, command, args_json, created_at
        FROM agent_profiles
        WHERE (project_id = ? OR (project_id IS NULL AND ? IS NULL))
        ORDER BY created_at DESC
        `
      )
      .all(projectId ?? null, projectId ?? null) as Array<{
      id: string
      project_id: string | null
      name: string
      provider: AgentProfile['provider']
      command: string | null
      args_json: string | null
      created_at: number
    }>

    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id ?? undefined,
      name: row.name,
      provider: row.provider,
      command: row.command ?? undefined,
      args: row.args_json ? (JSON.parse(row.args_json) as string[]) : [],
      createdAt: row.created_at
    }))
  }

  delete(input: DeleteAgentProfileInput, projectId?: string): boolean {
    const result = this.sqlite
      .instance()
      .prepare(
        `
        DELETE FROM agent_profiles
        WHERE id = ?
          AND (project_id = ? OR (project_id IS NULL AND ? IS NULL))
        `
      )
      .run(input.profileId, projectId ?? null, projectId ?? null)
    return result.changes > 0
  }

  get(profileId: string, projectId?: string): AgentProfile | undefined {
    const row = this.sqlite
      .instance()
      .prepare(
        `
        SELECT id, project_id, name, provider, command, args_json, created_at
        FROM agent_profiles
        WHERE id = ?
          AND (project_id = ? OR (project_id IS NULL AND ? IS NULL))
        `
      )
      .get(profileId, projectId ?? null, projectId ?? null) as
      | {
          id: string
          project_id: string | null
          name: string
          provider: AgentProfile['provider']
          command: string | null
          args_json: string | null
          created_at: number
        }
      | undefined

    if (!row) return undefined

    return {
      id: row.id,
      projectId: row.project_id ?? undefined,
      name: row.name,
      provider: row.provider,
      command: row.command ?? undefined,
      args: row.args_json ? (JSON.parse(row.args_json) as string[]) : [],
      createdAt: row.created_at
    }
  }
}
