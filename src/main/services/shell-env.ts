import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import os from 'node:os'
import { delimiter, join } from 'node:path'

const COMMON_POSIX_PATH_SEGMENTS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
]

const HOME_RELATIVE_PATH_SEGMENTS = ['.local/bin', '.cargo/bin', '.pyenv/bin']

let hasHydratedProcessPath = false

function splitPath(pathValue: string | undefined, pathDelimiter: string): string[] {
  if (!pathValue) {
    return []
  }
  return pathValue
    .split(pathDelimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function dedupePath(pathEntries: string[]): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const entry of pathEntries) {
    if (seen.has(entry)) {
      continue
    }
    seen.add(entry)
    deduped.push(entry)
  }
  return deduped
}

function isExecutableFile(pathValue: string | undefined): boolean {
  if (!pathValue) {
    return false
  }

  try {
    accessSync(pathValue, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findExecutableInPath(command: string, pathValue: string | undefined): string | undefined {
  for (const directory of splitPath(pathValue, delimiter)) {
    const candidate = join(directory, command)
    if (isExecutableFile(candidate)) {
      return candidate
    }
  }
  return undefined
}

function readLoginShellPath(env: NodeJS.ProcessEnv): string | undefined {
  const shell = env.SHELL || '/bin/zsh'
  try {
    const output = execFileSync(shell, ['-lc', 'printf "%s" "$PATH"'], {
      encoding: 'utf8',
      timeout: 2_500,
      env
    })
    const pathValue = output.trim()
    return pathValue.length > 0 ? pathValue : undefined
  } catch {
    return undefined
  }
}

function readLoginShellCommandPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(command)) {
    return undefined
  }

  const shell = env.SHELL || '/bin/zsh'
  try {
    const output = execFileSync(shell, ['-lc', `command -v ${command} || true`], {
      encoding: 'utf8',
      timeout: 2_500,
      env
    })
    const candidate = output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('/'))

    return isExecutableFile(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

function codexCommandCandidates(env: NodeJS.ProcessEnv): string[] {
  const homeDir = os.homedir()
  const resourcesPath =
    typeof process.resourcesPath === 'string' && process.resourcesPath.trim()
      ? process.resourcesPath
      : undefined

  return [
    env.CODEX_BIN,
    env.CODEX_PATH,
    resourcesPath ? join(resourcesPath, 'codex') : undefined,
    '/Applications/Codex.app/Contents/Resources/codex',
    join(homeDir, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
    join(homeDir, '.local', 'bin', 'codex'),
    join(homeDir, '.bun', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex'
  ].filter((value): value is string => Boolean(value))
}

export function mergePosixPathValues(
  currentPath: string | undefined,
  shellPath: string | undefined,
  homeDir = os.homedir(),
  pathDelimiter = delimiter
): string {
  const homeSegments = HOME_RELATIVE_PATH_SEGMENTS.map((segment) => `${homeDir}/${segment}`)
  const mergedEntries = dedupePath([
    ...splitPath(shellPath, pathDelimiter),
    ...splitPath(currentPath, pathDelimiter),
    ...homeSegments,
    ...COMMON_POSIX_PATH_SEGMENTS
  ])

  return mergedEntries.join(pathDelimiter)
}

export function ensureShellPathInProcessEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    return env.PATH || ''
  }

  const isProcessEnv = env === process.env
  if (isProcessEnv && hasHydratedProcessPath) {
    return env.PATH || ''
  }

  const shellPath = readLoginShellPath(env)
  env.PATH = mergePosixPathValues(env.PATH, shellPath)
  if (isProcessEnv) {
    hasHydratedProcessPath = true
  }

  return env.PATH
}

export function resolveCommandExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!command || command.includes('/')) {
    return command
  }

  ensureShellPathInProcessEnv(env)

  const fromPath = findExecutableInPath(command, env.PATH)
  if (fromPath) {
    return fromPath
  }

  const fromLoginShell = readLoginShellCommandPath(command, env)
  if (fromLoginShell) {
    return fromLoginShell
  }

  if (command === 'codex') {
    const fromCandidates = codexCommandCandidates(env).find((candidate) =>
      isExecutableFile(candidate)
    )
    if (fromCandidates) {
      return fromCandidates
    }
  }

  return command
}
