import { execFileSync } from 'node:child_process'
import { open, readdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { z } from 'zod'
import { ipcChannels } from '../../../shared/ipc/channels'
import type {
  FileReadResult,
  FileTreeEntry,
  GitDiffFilePatchResult,
  GitDiffFileChange,
  GitDiffHunk,
  GitDiffSummary
} from '../../../shared/ipc/types'
import { safeInvoke } from '../../utils/ipc-result'
import type { IpcContext } from '../context'

const gitDiffInputSchema = z.object({
  cwd: z.string().trim().min(1)
})
const gitDiffFilePatchInputSchema = z.object({
  cwd: z.string().trim().min(1),
  path: z.string().trim().min(1),
  status: z.string().trim().optional()
})
const fileTreeInputSchema = z.object({
  cwd: z.string().trim().min(1),
  relativePath: z.string().default('')
})
const fileTreeSearchInputSchema = z.object({
  cwd: z.string().trim().min(1),
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(500).default(200)
})
const fileReadInputSchema = z.object({
  cwd: z.string().trim().min(1),
  path: z.string().trim().min(1),
  maxBytes: z
    .number()
    .int()
    .min(8 * 1024)
    .max(2 * 1024 * 1024)
    .default(512 * 1024)
})
const FILE_TREE_ALWAYS_HIDDEN_NAMES = new Set(['.git'])
const FILE_TREE_MAX_SCANNED_DIRECTORIES = 3000

type MutableGitDiffFileChange = GitDiffFileChange & {
  additions: number
  deletions: number
  hunks: GitDiffHunk[]
  patch?: string
}

type FileTreeGitStatus = NonNullable<FileTreeEntry['gitStatus']>

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

function runGitAllowingStatus(cwd: string, args: string[], allowedStatuses: number[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024
    })
  } catch (error) {
    const maybeError = error as {
      status?: number
      stdout?: string | Buffer
      message?: string
    }

    if (typeof maybeError.status === 'number' && allowedStatuses.includes(maybeError.status)) {
      if (typeof maybeError.stdout === 'string') {
        return maybeError.stdout
      }
      if (Buffer.isBuffer(maybeError.stdout)) {
        return maybeError.stdout.toString('utf8')
      }
      return ''
    }

    const message =
      error instanceof Error && error.message
        ? error.message
        : 'Git command failed for the selected project.'
    throw new Error(message)
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

function parseBranchStatus(branchLine: string | undefined): {
  branch: string
  ahead: number
  behind: number
} {
  if (!branchLine) {
    return { branch: 'unknown', ahead: 0, behind: 0 }
  }

  const withoutPrefix = branchLine.startsWith('## ')
    ? branchLine.slice(3).trim()
    : branchLine.trim()
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

function parseStatusOutput(
  statusOutput: string,
  filesByPath: Map<string, MutableGitDiffFileChange>
): void {
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

    const path = rawPath.includes(' -> ')
      ? rawPath.split(' -> ').at(-1)?.trim() || rawPath
      : rawPath
    ensureFile(filesByPath, path, normalizeStatus(code))
  }
}

function toFileTreeGitStatus(value: string): FileTreeGitStatus | undefined {
  if (
    value === 'modified' ||
    value === 'added' ||
    value === 'deleted' ||
    value === 'renamed' ||
    value === 'copied' ||
    value === 'typechange' ||
    value === 'conflict' ||
    value === 'untracked'
  ) {
    return value
  }
  return undefined
}

function getWorkingTreeStatusByPath(cwd: string): Map<string, FileTreeGitStatus> {
  const statusOutput = runGitOptional(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
  const statusByPath = new Map<string, FileTreeGitStatus>()

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

    const normalizedPath = (
      rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1)?.trim() || rawPath : rawPath
    ).replace(/\\/g, '/')

    const status = toFileTreeGitStatus(normalizeStatus(code))
    if (!status) {
      continue
    }

    statusByPath.set(normalizedPath, status)
  }

  return statusByPath
}

function normalizeNameStatusCode(code: string): string {
  if (code.startsWith('R')) return 'renamed'
  if (code.startsWith('C')) return 'copied'
  if (code.startsWith('A')) return 'added'
  if (code.startsWith('D')) return 'deleted'
  if (code.startsWith('T')) return 'typechange'
  if (code.startsWith('U')) return 'conflict'
  if (code.startsWith('M')) return 'modified'
  return 'modified'
}

function parseNameStatusOutput(
  output: string,
  filesByPath: Map<string, MutableGitDiffFileChange>
): void {
  const lines = output.split('\n')
  for (const line of lines) {
    if (!line.trim()) {
      continue
    }

    const [rawCode, firstPath, secondPath] = line.split('\t')
    const code = rawCode?.trim()
    if (!code) {
      continue
    }

    // Rename/copy lines include both old and new paths; we list the destination path.
    const path = (secondPath || firstPath || '').trim()
    if (!path) {
      continue
    }

    ensureFile(filesByPath, path, normalizeNameStatusCode(code))
  }
}

function parseUntrackedFilesOutput(
  output: string,
  filesByPath: Map<string, MutableGitDiffFileChange>
): void {
  const lines = output.split('\n')
  for (const line of lines) {
    const path = line.trim()
    if (!path) {
      continue
    }
    ensureFile(filesByPath, path, 'untracked')
  }
}

function parseNumstatOutput(
  numstatOutput: string,
  filesByPath: Map<string, MutableGitDiffFileChange>
): void {
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

function parseDiffHunks(
  diffOutput: string,
  filesByPath: Map<string, MutableGitDiffFileChange>
): void {
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

function parseDiffPatches(
  diffOutput: string,
  filesByPath: Map<string, MutableGitDiffFileChange>
): void {
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

function summarizePatchLineChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  const lines = patch.split('\n')
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue
    }
    if (line.startsWith('+')) {
      additions += 1
      continue
    }
    if (line.startsWith('-')) {
      deletions += 1
    }
  }

  return { additions, deletions }
}

function buildGitDiffSummary(cwd: string): GitDiffSummary {
  const statusOutput = runGit(cwd, [
    'status',
    '--porcelain=v1',
    '--branch',
    '--untracked-files=all'
  ])
  const trackedNameStatus = runGitOptional(cwd, ['diff', '--name-status', 'HEAD'])
  const untrackedFiles = runGitOptional(cwd, ['ls-files', '--others', '--exclude-standard'])
  const numstatUnstaged = runGit(cwd, ['diff', '--numstat'])
  const numstatStaged = runGit(cwd, ['diff', '--cached', '--numstat'])
  const hunksUnstaged = runGit(cwd, ['diff', '--unified=0', '--no-color'])
  const hunksStaged = runGit(cwd, ['diff', '--cached', '--unified=0', '--no-color'])

  const filesByPath = new Map<string, MutableGitDiffFileChange>()
  const branchLine = statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .find((line) => line.startsWith('## '))
  const { branch, ahead, behind } = parseBranchStatus(branchLine)

  parseStatusOutput(statusOutput, filesByPath)
  parseNameStatusOutput(trackedNameStatus, filesByPath)
  parseUntrackedFilesOutput(untrackedFiles, filesByPath)
  parseNumstatOutput(numstatUnstaged, filesByPath)
  parseNumstatOutput(numstatStaged, filesByPath)
  parseDiffHunks(hunksUnstaged, filesByPath)
  parseDiffHunks(hunksStaged, filesByPath)

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

function buildGitDiffFilePatch(cwd: string, path: string, status?: string): GitDiffFilePatchResult {
  const normalizedPath = normalizeRelativePath(path)
  if (!normalizedPath) {
    throw new Error('Invalid diff file path.')
  }

  const patch =
    status === 'untracked'
      ? runGitAllowingStatus(
          cwd,
          ['diff', '--no-index', '--no-color', '--unified=3', '--', '/dev/null', normalizedPath],
          [1]
        ).trimEnd()
      : runGitOptional(cwd, [
          'diff',
          'HEAD',
          '--no-color',
          '--unified=3',
          '--',
          normalizedPath
        ]).trimEnd()

  if (!patch) {
    return {
      path: normalizedPath,
      additions: 0,
      deletions: 0,
      hunks: [],
      patch: undefined
    }
  }

  const parsed = new Map<string, MutableGitDiffFileChange>()
  parseDiffHunks(patch, parsed)
  parseDiffPatches(patch, parsed)

  const parsedEntry = parsed.get(normalizedPath)
  const { additions, deletions } = summarizePatchLineChanges(patch)

  return {
    path: normalizedPath,
    additions,
    deletions,
    hunks: parsedEntry?.hunks || [],
    patch: parsedEntry?.patch || patch
  }
}

function normalizeRelativePath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').trim()
  if (!normalized || normalized === '.') {
    return ''
  }
  return normalized
}

function resolveDirectoryInRoot(cwd: string, rawRelativePath: string): string {
  const normalizedRelativePath = normalizeRelativePath(rawRelativePath)
  const targetPath = resolve(cwd, normalizedRelativePath || '.')
  const relativeToRoot = relative(cwd, targetPath)

  if (
    isAbsolute(relativeToRoot) ||
    relativeToRoot === '..' ||
    relativeToRoot.startsWith(`..${sep}`)
  ) {
    throw new Error('Invalid file tree path.')
  }

  return targetPath
}

function getGitIgnoredPaths(cwd: string, paths: string[]): Set<string> {
  if (paths.length === 0) {
    return new Set()
  }

  const normalizedPaths = paths.map((path) => path.replace(/\\/g, '/'))
  const input = `${normalizedPaths.join('\n')}\n`

  try {
    const output = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024
    })

    return new Set(
      output
        .split('\n')
        .map((line) => line.trim().replace(/\\/g, '/'))
        .filter(Boolean)
    )
  } catch (error) {
    const maybeError = error as {
      status?: number
      stdout?: string | Buffer
    }
    if (maybeError.status === 1 || maybeError.status === 128) {
      const stdoutText =
        typeof maybeError.stdout === 'string'
          ? maybeError.stdout
          : Buffer.isBuffer(maybeError.stdout)
            ? maybeError.stdout.toString('utf8')
            : ''

      if (!stdoutText.trim()) {
        return new Set()
      }

      return new Set(
        stdoutText
          .split('\n')
          .map((line) => line.trim().replace(/\\/g, '/'))
          .filter(Boolean)
      )
    }

    const message = error instanceof Error ? error.message : 'Failed to evaluate gitignore rules.'
    throw new Error(message)
  }
}

function filterGitIgnoredFileTreeEntries(cwd: string, entries: FileTreeEntry[]): FileTreeEntry[] {
  if (entries.length === 0) {
    return entries
  }

  const pathsForCheck = entries.map((entry) =>
    entry.type === 'directory' ? `${entry.path}/` : entry.path
  )
  const ignoredPaths = getGitIgnoredPaths(cwd, pathsForCheck)

  return entries.filter((entry) => {
    if (FILE_TREE_ALWAYS_HIDDEN_NAMES.has(entry.name)) {
      return false
    }

    return !ignoredPaths.has(entry.path) && !ignoredPaths.has(`${entry.path}/`)
  })
}

function matchesQuery(path: string, query: string): boolean {
  const normalizedPath = path.toLowerCase()
  return normalizedPath.includes(query)
}

async function searchFileTreeEntries(
  cwd: string,
  query: string,
  limit: number
): Promise<FileTreeEntry[]> {
  const normalizedQuery = query.toLowerCase()
  const workingTreeStatusByPath = getWorkingTreeStatusByPath(cwd)
  const results: FileTreeEntry[] = []
  const queue: string[] = ['']
  let scannedDirectories = 0

  while (
    queue.length > 0 &&
    scannedDirectories < FILE_TREE_MAX_SCANNED_DIRECTORIES &&
    results.length < limit
  ) {
    const currentRelativePath = queue.shift() || ''
    const currentDirectoryPath = resolveDirectoryInRoot(cwd, currentRelativePath)
    scannedDirectories += 1

    let entries
    try {
      entries = await readdir(currentDirectoryPath, { withFileTypes: true })
    } catch {
      continue
    }

    const visibleEntries = filterGitIgnoredFileTreeEntries(
      cwd,
      entries
        .filter((entry) => entry.isDirectory() || entry.isFile())
        .map((entry) => {
          const path = currentRelativePath ? `${currentRelativePath}/${entry.name}` : entry.name
          const normalizedPath = path.replace(/\\/g, '/')
          return {
            name: entry.name,
            path: normalizedPath,
            type: entry.isDirectory() ? 'directory' : 'file'
          } satisfies FileTreeEntry
        })
    )

    for (const entry of visibleEntries) {
      if (entry.type === 'directory') {
        queue.push(entry.path)
        continue
      }

      if (!matchesQuery(entry.path, normalizedQuery)) {
        continue
      }

      results.push({
        ...entry,
        gitStatus: workingTreeStatusByPath.get(entry.path)
      })

      if (results.length >= limit) {
        break
      }
    }
  }

  return results.sort((left, right) => left.path.localeCompare(right.path))
}

async function listFileTreeEntries(cwd: string, relativePath: string): Promise<FileTreeEntry[]> {
  const normalizedRelativePath = normalizeRelativePath(relativePath)
  const directoryPath = resolveDirectoryInRoot(cwd, normalizedRelativePath)
  const workingTreeStatusByPath = getWorkingTreeStatusByPath(cwd)
  const entries = await readdir(directoryPath, { withFileTypes: true })

  return filterGitIgnoredFileTreeEntries(
    cwd,
    entries
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => {
        const childPath = normalizedRelativePath
          ? `${normalizedRelativePath}/${entry.name}`
          : entry.name
        const normalizedPath = childPath.replace(/\\/g, '/')
        const type: FileTreeEntry['type'] = entry.isDirectory() ? 'directory' : 'file'
        return {
          name: entry.name,
          path: normalizedPath,
          type,
          gitStatus: type === 'file' ? workingTreeStatusByPath.get(normalizedPath) : undefined
        }
      })
  ).sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1
    }
    return left.name.localeCompare(right.name)
  })
}

function isLikelyBinary(buffer: Buffer): boolean {
  const probeLength = Math.min(buffer.length, 1024)
  for (let index = 0; index < probeLength; index += 1) {
    if (buffer[index] === 0) {
      return true
    }
  }
  return false
}

async function readProjectFile(
  cwd: string,
  path: string,
  maxBytes: number
): Promise<FileReadResult> {
  const normalizedPath = normalizeRelativePath(path)
  if (!normalizedPath) {
    throw new Error('Invalid file path.')
  }

  const absolutePath = resolveDirectoryInRoot(cwd, normalizedPath)
  const file = await open(absolutePath, 'r')
  try {
    const probeBuffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await file.read(probeBuffer, 0, maxBytes + 1, 0)
    const raw = probeBuffer.subarray(0, bytesRead)

    if (isLikelyBinary(raw)) {
      throw new Error('Binary files are not supported in preview.')
    }

    const truncated = bytesRead > maxBytes
    const content = (truncated ? raw.subarray(0, maxBytes) : raw).toString('utf8')

    return {
      path: normalizedPath,
      content,
      truncated
    }
  } finally {
    await file.close()
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
  ipcMain.handle(ipcChannels.app.gitDiffFilePatch, (_, rawInput) =>
    safeInvoke(() => {
      const input = gitDiffFilePatchInputSchema.parse(rawInput)
      return buildGitDiffFilePatch(input.cwd, input.path, input.status)
    })
  )
  ipcMain.handle(ipcChannels.app.fileTree, (_, rawInput) =>
    safeInvoke(async () => {
      const input = fileTreeInputSchema.parse(rawInput)
      return listFileTreeEntries(input.cwd, input.relativePath)
    })
  )
  ipcMain.handle(ipcChannels.app.fileTreeSearch, (_, rawInput) =>
    safeInvoke(async () => {
      const input = fileTreeSearchInputSchema.parse(rawInput)
      return searchFileTreeEntries(input.cwd, input.query, input.limit)
    })
  )
  ipcMain.handle(ipcChannels.app.fileRead, (_, rawInput) =>
    safeInvoke(async () => {
      const input = fileReadInputSchema.parse(rawInput)
      return readProjectFile(input.cwd, input.path, input.maxBytes)
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
