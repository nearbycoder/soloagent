import { describe, expect, it } from 'vitest'
import type {
  CreateProjectInput,
  DeleteProjectInput,
  ProjectRecord,
  UpdateProjectInput
} from '../../shared/ipc/types'
import { ProjectService } from './project-service'

const SELECTED_PROJECT_KEY = 'project.selectedId'

type SettingsMap = Record<string, string>

class FakeProjectsRepository {
  private readonly projects = new Map<string, ProjectRecord>()

  constructor(initial: ProjectRecord[] = []) {
    for (const project of initial) {
      this.projects.set(project.id, project)
    }
  }

  create(input: CreateProjectInput): ProjectRecord {
    const id = `project-${this.projects.size + 1}`
    const project: ProjectRecord = {
      id,
      name: input.name?.trim() || 'Project',
      rootPath: input.rootPath,
      createdAt: Date.now()
    }
    this.projects.set(id, project)
    return project
  }

  list(): ProjectRecord[] {
    return [...this.projects.values()]
  }

  get(projectId: string): ProjectRecord | undefined {
    return this.projects.get(projectId)
  }

  update(input: UpdateProjectInput): ProjectRecord | undefined {
    const existing = this.projects.get(input.projectId)
    if (!existing) {
      return undefined
    }

    const name = input.name.trim()
    if (!name) {
      return undefined
    }

    const next: ProjectRecord = { ...existing, name }
    this.projects.set(existing.id, next)
    return next
  }

  delete(input: DeleteProjectInput): boolean {
    return this.projects.delete(input.projectId)
  }
}

class FakeAppSettingsRepository {
  readonly values: SettingsMap

  constructor(initial: SettingsMap = {}) {
    this.values = { ...initial }
  }

  get(key: string): string | undefined {
    return this.values[key]
  }

  set(key: string, value: string): { key: string; value: string } {
    this.values[key] = value
    return { key, value }
  }
}

function createProject(id: string, rootPath = `/tmp/${id}`, name = id): ProjectRecord {
  return {
    id,
    name,
    rootPath,
    createdAt: 1
  }
}

function createService(
  options: {
    projects?: ProjectRecord[]
    settings?: SettingsMap
  } = {}
): {
  service: ProjectService
  settings: FakeAppSettingsRepository
} {
  const projects = new FakeProjectsRepository(options.projects)
  const settings = new FakeAppSettingsRepository(options.settings)

  const service = new ProjectService(
    projects as unknown as ConstructorParameters<typeof ProjectService>[0],
    settings as unknown as ConstructorParameters<typeof ProjectService>[1]
  )

  return { service, settings }
}

describe('ProjectService', () => {
  it('stores selected project id for valid select', () => {
    const alpha = createProject('alpha')
    const { service, settings } = createService({ projects: [alpha] })

    const selected = service.select({ projectId: alpha.id })

    expect(selected).toEqual(alpha)
    expect(settings.values[SELECTED_PROJECT_KEY]).toBe(alpha.id)
  })

  it('clears selected id when selecting empty or missing id', () => {
    const alpha = createProject('alpha')
    const { service, settings } = createService({
      projects: [alpha],
      settings: { [SELECTED_PROJECT_KEY]: alpha.id }
    })

    expect(service.select({ projectId: '   ' })).toBeUndefined()
    expect(settings.values[SELECTED_PROJECT_KEY]).toBe('')

    settings.values[SELECTED_PROJECT_KEY] = alpha.id
    expect(service.select({})).toBeUndefined()
    expect(settings.values[SELECTED_PROJECT_KEY]).toBe('')
  })

  it('does not change selected id when selecting unknown project', () => {
    const alpha = createProject('alpha')
    const { service, settings } = createService({
      projects: [alpha],
      settings: { [SELECTED_PROJECT_KEY]: alpha.id }
    })

    const selected = service.select({ projectId: 'missing' })

    expect(selected).toBeUndefined()
    expect(settings.values[SELECTED_PROJECT_KEY]).toBe(alpha.id)
  })

  it('clears selected id if deleting selected project', () => {
    const alpha = createProject('alpha')
    const { service, settings } = createService({
      projects: [alpha],
      settings: { [SELECTED_PROJECT_KEY]: alpha.id }
    })

    expect(service.delete({ projectId: alpha.id })).toBe(true)
    expect(settings.values[SELECTED_PROJECT_KEY]).toBe('')
  })

  it('preserves selected id if deleting a different project', () => {
    const alpha = createProject('alpha')
    const beta = createProject('beta')
    const { service, settings } = createService({
      projects: [alpha, beta],
      settings: { [SELECTED_PROJECT_KEY]: alpha.id }
    })

    expect(service.delete({ projectId: beta.id })).toBe(true)
    expect(settings.values[SELECTED_PROJECT_KEY]).toBe(alpha.id)
  })

  it('resolves current and currentRootPath from selected setting', () => {
    const alpha = createProject('alpha', '/repo/alpha', 'Alpha')
    const { service } = createService({
      projects: [alpha],
      settings: { [SELECTED_PROJECT_KEY]: alpha.id }
    })

    expect(service.current()).toEqual(alpha)
    expect(service.currentRootPath()).toBe('/repo/alpha')
  })

  it('returns undefined current for invalid selected id', () => {
    const alpha = createProject('alpha')
    const { service } = createService({
      projects: [alpha],
      settings: { [SELECTED_PROJECT_KEY]: 'missing' }
    })

    expect(service.current()).toBeUndefined()
    expect(service.currentRootPath()).toBeUndefined()
  })
})
