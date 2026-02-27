import { ipcMain } from 'electron'
import { z } from 'zod'
import { ipcChannels } from '../../../shared/ipc/channels'
import { safeInvoke } from '../../utils/ipc-result'
import type { IpcContext } from '../context'

const getSchema = z.object({
  key: z.string().min(1)
})

const setSchema = z.object({
  key: z.string().min(1),
  value: z.string()
})

export function registerConfigHandlers(context: IpcContext): void {
  ipcMain.handle(ipcChannels.config.get, (_, rawInput) =>
    safeInvoke(() => {
      const input = getSchema.parse(rawInput)
      return context.config.get(input.key)
    })
  )

  ipcMain.handle(ipcChannels.config.set, (_, rawInput) =>
    safeInvoke(() => {
      const input = setSchema.parse(rawInput)
      return context.config.set(input.key, input.value)
    })
  )

  ipcMain.handle(ipcChannels.config.all, () => safeInvoke(() => context.config.all()))
}
