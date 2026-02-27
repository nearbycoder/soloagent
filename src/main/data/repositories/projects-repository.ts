import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type {
  CreateProjectInput,
  DeleteProjectInput,
  ProjectRecord,
  UpdateProjectInput
} from '../../../shared/ipc/types'
import { SqliteService } from '../sqlite'

export class ProjectsRepository {
  constructor(private readonly sqlite: SqliteService) {}

  create(input: CreateProjectInput): ProjectRecord {
    const normalizedPath = input.rootPath.trim()
    const project: ProjectRecord = {
      id: randomUUID(),
      name: input.name?.trim() || basename(normalizedPath) || 'Project',
      rootPath: normalizedPath,
      createdAt: Date.now()
    }

    this.sqlite
      .instance()
      .prepare(
        `
        INSERT INTO projects (id, name, root_path, created_at)
        VALUES (?, ?, ?, ?)
        `
      )
      .run(project.id, project.name, project.rootPath, project.createdAt)

    return project
  }

  list(): ProjectRecord[] {
    const rows = this.sqlite
      .instance()
      .prepare(
        `
        SELECT id, name, root_path, created_at
        FROM projects
        ORDER BY created_at DESC
        `
      )
      .all() as Array<{
      id: string
      name: string
      root_path: string
      created_at: number
    }>

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      createdAt: row.created_at
    }))
  }

  get(projectId: string): ProjectRecord | undefined {
    const row = this.sqlite
      .instance()
      .prepare(
        `
        SELECT id, name, root_path, created_at
        FROM projects
        WHERE id = ?
        `
      )
      .get(projectId) as
      | {
          id: string
          name: string
          root_path: string
          created_at: number
        }
      | undefined

    if (!row) return undefined

    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      createdAt: row.created_at
    }
  }

  update(input: UpdateProjectInput): ProjectRecord | undefined {
    const normalizedName = input.name.trim()
    if (!normalizedName) {
      return undefined
    }

    const result = this.sqlite
      .instance()
      .prepare('UPDATE projects SET name = ? WHERE id = ?')
      .run(normalizedName, input.projectId)

    if (result.changes <= 0) {
      return undefined
    }

    return this.get(input.projectId)
  }

  delete(input: DeleteProjectInput): boolean {
    const result = this.sqlite
      .instance()
      .prepare('DELETE FROM projects WHERE id = ?')
      .run(input.projectId)
    return result.changes > 0
  }
}
