import { execFileSync } from 'node:child_process'
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { z } from 'zod'
import { ipcChannels } from '../../../shared/ipc/channels'
import type { GitDiffFileChange, GitDiffHunk, GitDiffSummary } from '../../../shared/ipc/types'
import { safeInvoke } from '../../utils/ipc-result'
import type { IpcContext } from '../context'

const gitDiffInputSchema = z.object({
  cwd: z.string().trim().min(1)
})

type MutableGitDiffFileChange = GitDiffFileChange & {
  additions: number
  deletions: number
  hunks: GitDiffHunk[]
  patch?: string
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024
    })
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : 'Git command failed for the selected project.'
    throw new Error(message)
  }
}

function runGitOptional(cwd: string, args: string[]): string {
  try {
    return runGit(cwd, args)
  } catch {
    return ''
  }
}

function normalizeStatus(code: string): string {
  if (code === '??') return 'untracked'

  const compact = code.replace(/\s/g, '')
  if (compact.includes('U')) return 'conflict'
  if (compact.includes('R')) return 'renamed'
  if (compact.includes('C')) return 'copied'
  if (compact.includes('A')) return 'added'
  if (compact.includes('D')) return 'deleted'
  if (compact.includes('T')) return 'typechange'
  if (compact.includes('M')) return 'modified'

  return 'modified'
}

function ensureFile(
  filesByPath: Map<string, MutableGitDiffFileChange>,
  path: string,
  status = 'modified'
): MutableGitDiffFileChange {
  const existing = filesByPath.get(path)
  if (existing) {
    if (existing.status === 'modified' && status !== 'modified') {
      existing.status = status
    }
    return existing
  }

  const created: MutableGitDiffFileChange = {
    path,
    status,
    additions: 0,
    deletions: 0,
    hunks: [],
    patch: undefined
  }
  filesByPath.set(path, created)
  return created
}

function parseBranchStatus(branchLine: string | undefined): { branch: string; ahead: number; behind: number } {
  if (!branchLine) {
    return { branch: 'unknown', ahead: 0, behind: 0 }
  }

  const withoutPrefix = branchLine.startsWith('## ') ? branchLine.slice(3).trim() : branchLine.trim()
  const bracketMatch = withoutPrefix.match(/\[(.+)\]/)
  const aheadMatch = bracketMatch?.[1]?.match(/ahead (\d+)/)
  const behindMatch = bracketMatch?.[1]?.match(/behind (\d+)/)
  const rawBranch = withoutPrefix.split('...')[0].split('[')[0].trim()

  return {
    branch: rawBranch || 'unknown',
    ahead: aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0,
    behind: behindMatch ? Number.parseInt(behindMatch[1], 10) : 0
  }
}

function parseStatusOutput(statusOutput: string, filesByPath: Map<string, MutableGitDiffFileChange>): void {
  const lines = statusOutput.split('\n').map((line) => line.trimEnd())
  for (const line of lines) {
    if (!line || line.startsWith('## ')) {
      continue
    }

    const code = line.slice(0, 2)
    if (code === '!!') {
      continue
    }

    const rawPath = line.slice(3).trim()
    if (!rawPath) {
      continue
    }

    const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1)?.trim() || rawPath : rawPath
    ensureFile(filesByPath, path, normalizeStatus(code))
  }
}

function parseNumstatOutput(numstatOutput: string, filesByPath: Map<string, MutableGitDiffFileChange>): void {
  const lines = numstatOutput.split('\n')
  for (const line of lines) {
    if (!line.trim()) {
      continue
    }

    const [rawAdditions, rawDeletions, ...pathParts] = line.split('\t')
    const path = pathParts.join('\t').trim()
    if (!path) {
      continue
    }

    const additions = rawAdditions === '-' ? 0 : Number.parseInt(rawAdditions, 10) || 0
    const deletions = rawDeletions === '-' ? 0 : Number.parseInt(rawDeletions, 10) || 0

    const entry = ensureFile(filesByPath, path)
    entry.additions += additions
    entry.deletions += deletions
  }
}

function parseDiffHunks(diffOutput: string, filesByPath: Map<string, MutableGitDiffFileChange>): void {
  const lines = diffOutput.split('\n')
  let currentPath: string | undefined

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
      if (!match) {
        currentPath = undefined
        continue
      }
      currentPath = match[2]
      ensureFile(filesByPath, currentPath)
      continue
    }

    if (!currentPath || !line.startsWith('@@ ')) {
      continue
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (!hunkMatch) {
      continue
    }

    const oldStart = Number.parseInt(hunkMatch[1], 10)
    const oldLines = Number.parseInt(hunkMatch[2] || '1', 10)
    const newStart = Number.parseInt(hunkMatch[3], 10)
    const newLines = Number.parseInt(hunkMatch[4] || '1', 10)

    ensureFile(filesByPath, currentPath).hunks.push({
      oldStart,
      oldLines,
      newStart,
      newLines
    })
  }
}

function parseDiffPatches(diffOutput: string, filesByPath: Map<string, MutableGitDiffFileChange>): void {
  if (!diffOutput.trim()) {
    return
  }

  const matchRegex = /^diff --git a\/(.+?) b\/(.+)$/gm
  const matches = [...diffOutput.matchAll(matchRegex)]

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const nextMatch = matches[index + 1]
    const start = match.index ?? 0
    const end = nextMatch?.index ?? diffOutput.length
    const patch = diffOutput.slice(start, end).trimEnd()
    const path = match[2]
    if (!path || !patch) {
      continue
    }

    const entry = ensureFile(filesByPath, path)
    entry.patch = patch
  }
}

function buildGitDiffSummary(cwd: string): GitDiffSummary {
  const statusOutput = runGit(cwd, ['status', '--porcelain=v1', '--branch'])
  const numstatUnstaged = runGit(cwd, ['diff', '--numstat'])
  const numstatStaged = runGit(cwd, ['diff', '--cached', '--numstat'])
  const hunksUnstaged = runGit(cwd, ['diff', '--unified=0', '--no-color'])
  const hunksStaged = runGit(cwd, ['diff', '--cached', '--unified=0', '--no-color'])
  const fullPatch = runGitOptional(cwd, ['diff', 'HEAD', '--unified=3', '--no-color'])

  const filesByPath = new Map<string, MutableGitDiffFileChange>()
  const branchLine = statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .find((line) => line.startsWith('## '))
  const { branch, ahead, behind } = parseBranchStatus(branchLine)

  parseStatusOutput(statusOutput, filesByPath)
  parseNumstatOutput(numstatUnstaged, filesByPath)
  parseNumstatOutput(numstatStaged, filesByPath)
  parseDiffHunks(hunksUnstaged, filesByPath)
  parseDiffHunks(hunksStaged, filesByPath)
  parseDiffPatches(fullPatch, filesByPath)

  const files = [...filesByPath.values()].sort((left, right) => left.path.localeCompare(right.path))
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0)
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0)

  return {
    branch,
    ahead,
    behind,
    files,
    changedFiles: files.length,
    totalAdditions,
    totalDeletions,
    clean: files.length === 0
  }
}

export function registerAppHandlers(context: IpcContext): void {
  ipcMain.handle(ipcChannels.app.health, () =>
    safeInvoke(() => ({
      status: 'ok',
      timestamp: Date.now()
    }))
  )

  ipcMain.handle(ipcChannels.app.metrics, () => safeInvoke(() => context.telemetry.snapshot()))
  ipcMain.handle(ipcChannels.app.logs, () => safeInvoke(() => context.logger.latest(200)))
  ipcMain.handle(ipcChannels.app.gitDiff, (_, rawInput) =>
    safeInvoke(() => {
      const input = gitDiffInputSchema.parse(rawInput)
      return buildGitDiffSummary(input.cwd)
    })
  )
  ipcMain.handle(ipcChannels.app.platform, () => safeInvoke(() => process.platform))

  ipcMain.handle(ipcChannels.app.windowMinimize, (event) =>
    safeInvoke(() => {
      const window = BrowserWindow.fromWebContents(event.sender)
      window?.minimize()
      return true
    })
  )

  ipcMain.handle(ipcChannels.app.windowMaximize, (event) =>
    safeInvoke(() => {
      const window = BrowserWindow.fromWebContents(event.sender)
      window?.maximize()
      return true
    })
  )

  ipcMain.handle(ipcChannels.app.windowUnmaximize, (event) =>
    safeInvoke(() => {
      const window = BrowserWindow.fromWebContents(event.sender)
      window?.unmaximize()
      return true
    })
  )

  ipcMain.handle(ipcChannels.app.windowToggleMaximize, (event) =>
    safeInvoke(() => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return false
      if (window.isMaximized()) {
        window.unmaximize()
      } else {
        window.maximize()
      }
      return window.isMaximized()
    })
  )

  ipcMain.handle(ipcChannels.app.windowClose, (event) =>
    safeInvoke(() => {
      const window = BrowserWindow.fromWebContents(event.sender)
      window?.close()
      return true
    })
  )

  ipcMain.handle(ipcChannels.app.windowIsMaximized, (event) =>
    safeInvoke(() => {
      const window = BrowserWindow.fromWebContents(event.sender)
      return window?.isMaximized() ?? false
    })
  )

  ipcMain.handle(ipcChannels.app.selectDirectory, (event) =>
    safeInvoke(async () => {
      const window = BrowserWindow.fromWebContents(event.sender)
      const dialogOptions: OpenDialogOptions = {
        title: 'Select Project Root',
        properties: ['openDirectory', 'createDirectory']
      }
      const result = window
        ? await dialog.showOpenDialog(window, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)

      if (result.canceled || result.filePaths.length === 0) {
        return undefined
      }
      return result.filePaths[0]
    })
  )
}
