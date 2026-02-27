import os from 'node:os'
import type { IPty } from 'node-pty'
import { spawn } from 'node-pty'

type SpawnOptions = {
  cwd: string
  cols: number
  rows: number
  shell?: string
}

const DEFAULT_SHELL =
  process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')

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
    const proc = spawn(shell, [], {
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

  disposeAll(): void {
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
