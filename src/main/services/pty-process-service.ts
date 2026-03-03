import os from 'node:os'
import { basename } from 'node:path'
import type { IPty } from 'node-pty'
import { spawn } from 'node-pty'
import { ensureShellPathInProcessEnv } from './shell-env'

type SpawnOptions = {
  cwd: string
  cols: number
  rows: number
  shell?: string
}

type DisposeOptions = {
  terminateProcesses?: boolean
}

const DEFAULT_SHELL =
  process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')

function resolveShellArgs(shell: string): string[] {
  if (process.platform === 'win32') {
    return []
  }

  const shellName = basename(shell).toLowerCase()
  if (
    shellName === 'zsh' ||
    shellName === 'bash' ||
    shellName === 'sh' ||
    shellName === 'ksh' ||
    shellName === 'fish'
  ) {
    return ['-l']
  }

  return []
}

export class PtyProcessService {
  private readonly processes = new Map<string, IPty>()
  private readonly maxProcesses: number

  constructor(maxProcesses = 12) {
    this.maxProcesses = maxProcesses
  }

  createProcess(id: string, options: SpawnOptions): IPty {
    if (this.processes.size >= this.maxProcesses) {
      throw new Error(`Terminal limit reached (${this.maxProcesses})`)
    }

    const shell = options.shell || DEFAULT_SHELL
    ensureShellPathInProcessEnv()
    const proc = spawn(shell, resolveShellArgs(shell), {
      name: 'xterm-color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'ghostty-web',
        // Prevent zsh from rendering the inverse-video "%" eol marker in embedded terminals.
        PROMPT_EOL_MARK: ''
      }
    })

    this.processes.set(id, proc)
    proc.onExit(() => {
      this.processes.delete(id)
    })
    return proc
  }

  getProcess(id: string): IPty | undefined {
    return this.processes.get(id)
  }

  resize(id: string, cols: number, rows: number): void {
    const proc = this.processes.get(id)
    if (!proc) return
    proc.resize(Math.max(20, cols), Math.max(5, rows))
  }

  write(id: string, data: string): void {
    const proc = this.processes.get(id)
    if (!proc) return
    proc.write(data)
  }

  kill(id: string): void {
    const proc = this.processes.get(id)
    if (!proc) return
    try {
      proc.kill()
    } finally {
      this.processes.delete(id)
    }
  }

  disposeAll(options: DisposeOptions = {}): void {
    const { terminateProcesses = true } = options
    if (!terminateProcesses) {
      this.processes.clear()
      return
    }
    for (const id of this.processes.keys()) {
      this.kill(id)
    }
  }

  count(): number {
    return this.processes.size
  }

  getDefaultCwd(): string {
    return os.homedir()
  }
}
