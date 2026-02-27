import type {
  CreateProjectInput,
  DeleteProjectInput,
  ProjectRecord,
  SelectProjectInput,
  UpdateProjectInput
} from '../../shared/ipc/types'
import { AppSettingsRepository } from '../data/repositories/app-settings-repository'
import { ProjectsRepository } from '../data/repositories/projects-repository'

const SELECTED_PROJECT_KEY = 'project.selectedId'

export class ProjectService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly appSettingsRepository: AppSettingsRepository
  ) {}

  create(input: CreateProjectInput): ProjectRecord {
    return this.projectsRepository.create(input)
  }

  list(): ProjectRecord[] {
    return this.projectsRepository.list()
  }

  update(input: UpdateProjectInput): ProjectRecord | undefined {
    return this.projectsRepository.update(input)
  }

  delete(input: DeleteProjectInput): boolean {
    const deleted = this.projectsRepository.delete(input)
    if (!deleted) return false

    const selectedId = this.appSettingsRepository.get(SELECTED_PROJECT_KEY)
    if (selectedId === input.projectId) {
      this.appSettingsRepository.set(SELECTED_PROJECT_KEY, '')
    }
    return true
  }

  select(input: SelectProjectInput): ProjectRecord | undefined {
    const projectId = input.projectId?.trim()
    if (!projectId) {
      this.appSettingsRepository.set(SELECTED_PROJECT_KEY, '')
      return undefined
    }

    const project = this.projectsRepository.get(projectId)
    if (!project) {
      return undefined
    }

    this.appSettingsRepository.set(SELECTED_PROJECT_KEY, project.id)
    return project
  }

  current(): ProjectRecord | undefined {
    const selectedId = this.appSettingsRepository.get(SELECTED_PROJECT_KEY)
    if (!selectedId) return undefined
    return this.projectsRepository.get(selectedId)
  }

  currentRootPath(): string | undefined {
    return this.current()?.rootPath
  }
}
