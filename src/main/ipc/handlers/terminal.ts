import { ipcMain } from 'electron'
import { z } from 'zod'
import { ipcChannels } from '../../../shared/ipc/channels'
import { safeInvoke } from '../../utils/ipc-result'
import type { IpcContext } from '../context'

const createSchema = z.object({
  title: z.string().optional(),
  cwd: z.string().optional(),
  parentTerminalId: z.string().uuid().optional(),
  shell: z.string().optional(),
  cols: z.number().min(20).max(400).optional(),
  rows: z.number().min(5).max(200).optional()
})

const writeSchema = z.object({
  terminalId: z.string().uuid(),
  data: z.string()
})

const resizeSchema = z.object({
  terminalId: z.string().uuid(),
  cols: z.number().min(20).max(400),
  rows: z.number().min(5).max(200)
})

const closeSchema = z.object({
  terminalId: z.string().uuid()
})

const renameSchema = z.object({
  terminalId: z.string().uuid(),
  title: z.string().trim().min(1).max(60)
})

export function registerTerminalHandlers(context: IpcContext): void {
  ipcMain.handle(ipcChannels.terminal.create, (_, rawInput) =>
    safeInvoke(() => {
      const input = createSchema.parse(rawInput ?? {})
      const selectedProject = context.projects.current()
      const projectRoot = context.projects.currentRootPath()

      if (input.parentTerminalId) {
        const parentSession = context.terminals.getSession(input.parentTerminalId)
        if (!parentSession) {
          throw new Error('Split target terminal was not found.')
        }
        const selectedProjectId = selectedProject?.id
        if (
          (selectedProjectId && parentSession.projectId !== selectedProjectId) ||
          (!selectedProjectId && parentSession.projectId)
        ) {
          throw new Error('Cannot create split for terminal outside current project scope.')
        }

        return context.terminals.createSession({
          ...input,
          parentTerminalId: parentSession.id,
          cwd: input.cwd || parentSession.cwd || projectRoot,
          projectId: parentSession.projectId
        })
      }

      return context.terminals.createSession({
        ...input,
        cwd: input.cwd || projectRoot,
        projectId: selectedProject?.id
      })
    })
  )

  ipcMain.handle(ipcChannels.terminal.write, (_, rawInput) =>
    safeInvoke(() => {
      const input = writeSchema.parse(rawInput)
      context.terminals.write(input)
      return true
    })
  )

  ipcMain.handle(ipcChannels.terminal.resize, (_, rawInput) =>
    safeInvoke(() => {
      const input = resizeSchema.parse(rawInput)
      context.terminals.resize(input)
      return true
    })
  )

  ipcMain.handle(ipcChannels.terminal.close, (_, rawInput) =>
    safeInvoke(() => {
      const input = closeSchema.parse(rawInput)
      context.terminals.close(input)
      return true
    })
  )

  ipcMain.handle(ipcChannels.terminal.rename, (_, rawInput) =>
    safeInvoke(() => {
      const input = renameSchema.parse(rawInput)
      return context.terminals.rename(input)
    })
  )

  ipcMain.handle(ipcChannels.terminal.list, () =>
    safeInvoke(() => {
      const selectedProject = context.projects.current()
      return context.terminals.list(selectedProject?.id)
    })
  )
}
