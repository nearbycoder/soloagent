import type { IpcResult } from '../../shared/ipc/types'

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

export function fail(code: string, message: string, details?: unknown): IpcResult<never> {
  return { ok: false, error: { code, message, details } }
}

export async function safeInvoke<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    const data = await fn()
    return ok(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown IPC error'
    return fail('IPC_ERROR', message)
  }
}
