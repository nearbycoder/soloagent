import { ipcMain } from 'electron'
import { z } from 'zod'
import { ipcChannels } from '../../../shared/ipc/channels'
import { safeInvoke } from '../../utils/ipc-result'
import type { IpcContext } from '../context'

const createSchema = z.object({
  name: z.string().optional(),
  rootPath: z.string().min(1)
})

const deleteSchema = z.object({
  projectId: z.string().uuid()
})

const updateSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(120)
})

const selectSchema = z.object({
  projectId: z.string().uuid().optional()
})

export function registerProjectHandlers(context: IpcContext): void {
  ipcMain.handle(ipcChannels.project.create, (_, rawInput) =>
    safeInvoke(() => {
      const input = createSchema.parse(rawInput)
      return context.projects.create(input)
    })
  )

  ipcMain.handle(ipcChannels.project.list, () => safeInvoke(() => context.projects.list()))

  ipcMain.handle(ipcChannels.project.update, (_, rawInput) =>
    safeInvoke(() => {
      const input = updateSchema.parse(rawInput)
      return context.projects.update(input)
    })
  )

  ipcMain.handle(ipcChannels.project.delete, (_, rawInput) =>
    safeInvoke(() => {
      const input = deleteSchema.parse(rawInput)
      return context.projects.delete(input)
    })
  )

  ipcMain.handle(ipcChannels.project.select, (_, rawInput) =>
    safeInvoke(() => {
      const input = selectSchema.parse(rawInput ?? {})
      return context.projects.select(input)
    })
  )

  ipcMain.handle(ipcChannels.project.current, () => safeInvoke(() => context.projects.current()))
}
