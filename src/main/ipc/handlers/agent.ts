import { ipcMain } from 'electron'
import { z } from 'zod'
import { ipcChannels } from '../../../shared/ipc/channels'
import { safeInvoke } from '../../utils/ipc-result'
import type { IpcContext } from '../context'

const startSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(['local-cli', 'remote']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional()
})

const idSchema = z.object({
  agentId: z.string().uuid()
})

const assignSchema = z.object({
  agentId: z.string().uuid(),
  terminalId: z.string().uuid()
})

const profileSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(['local-cli', 'remote']),
  command: z.string().optional(),
  args: z.array(z.string()).optional()
})

const deleteProfileSchema = z.object({
  profileId: z.string().uuid()
})

const enqueueTaskSchema = z.object({
  title: z.string().min(1),
  profileId: z
    .string()
    .uuid()
    .nullish()
    .transform((value) => value ?? undefined),
  agentId: z
    .string()
    .uuid()
    .nullish()
    .transform((value) => value ?? undefined)
})

export function registerAgentHandlers(context: IpcContext): void {
  ipcMain.handle(ipcChannels.agent.start, (_, rawInput, terminalId) =>
    safeInvoke(async () => {
      const input = startSchema.parse(rawInput)
      const selectedProject = context.projects.current()
      const scopedTerminals = context.terminals.list(selectedProject?.id)
      if (terminalId && !scopedTerminals.some((terminal) => terminal.id === terminalId)) {
        throw new Error('Cannot assign agent to terminal outside current project scope.')
      }
      return context.agents.start(input, terminalId, selectedProject?.id)
    })
  )

  ipcMain.handle(ipcChannels.agent.stop, (_, rawInput) =>
    safeInvoke(async () => {
      const input = idSchema.parse(rawInput)
      const selectedProject = context.projects.current()
      const scopedAgents = context.agents.list(selectedProject?.id)
      if (!scopedAgents.some((agent) => agent.id === input.agentId)) {
        throw new Error('Cannot stop agent outside current project scope.')
      }
      return context.agents.stop(input)
    })
  )

  ipcMain.handle(ipcChannels.agent.restart, (_, rawInput) =>
    safeInvoke(async () => {
      const input = idSchema.parse(rawInput)
      const selectedProject = context.projects.current()
      const scopedAgents = context.agents.list(selectedProject?.id)
      if (!scopedAgents.some((agent) => agent.id === input.agentId)) {
        throw new Error('Cannot restart agent outside current project scope.')
      }
      return context.agents.restart(input)
    })
  )

  ipcMain.handle(ipcChannels.agent.assignTerminal, (_, rawInput) =>
    safeInvoke(() => {
      const input = assignSchema.parse(rawInput)
      const selectedProject = context.projects.current()
      const scopedTerminals = context.terminals.list(selectedProject?.id)
      if (!scopedTerminals.some((terminal) => terminal.id === input.terminalId)) {
        throw new Error('Cannot assign terminal outside current project scope.')
      }
      return context.agents.assignTerminal(input, selectedProject?.id)
    })
  )

  ipcMain.handle(ipcChannels.agent.list, () =>
    safeInvoke(() => {
      const selectedProject = context.projects.current()
      return context.agents.list(selectedProject?.id)
    })
  )

  ipcMain.handle(ipcChannels.agent.createProfile, (_, rawInput) =>
    safeInvoke(() => {
      const input = profileSchema.parse(rawInput)
      const selectedProject = context.projects.current()
      return context.agents.createProfile(input, selectedProject?.id)
    })
  )

  ipcMain.handle(ipcChannels.agent.listProfiles, () =>
    safeInvoke(() => {
      const selectedProject = context.projects.current()
      return context.agents.listProfiles(selectedProject?.id)
    })
  )

  ipcMain.handle(ipcChannels.agent.deleteProfile, (_, rawInput) =>
    safeInvoke(() => {
      const input = deleteProfileSchema.parse(rawInput)
      const selectedProject = context.projects.current()
      return context.agents.deleteProfile(input, selectedProject?.id)
    })
  )

  ipcMain.handle(ipcChannels.agent.enqueueTask, (_, rawInput) =>
    safeInvoke(() => {
      const input = enqueueTaskSchema.parse(rawInput)
      const selectedProject = context.projects.current()
      return context.agents.enqueueTask(input, selectedProject?.id)
    })
  )

  ipcMain.handle(ipcChannels.agent.listTasks, () =>
    safeInvoke(() => {
      const selectedProject = context.projects.current()
      return context.agents.listTasks(selectedProject?.id)
    })
  )
}
