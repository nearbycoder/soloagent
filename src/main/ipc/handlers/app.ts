import { execFile, execFileSync } from 'node:child_process'
import { open, readdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { z } from 'zod'
import { ipcChannels } from '../../../shared/ipc/channels'
import type {
  FileReadResult,
  FileTreeEntry,
  GitCommitResult,
  GitCreatePrResult,
  GitPushResult,
  GitDiffFilePatchResult,
  GitDiffFileChange,
  GitDiffHunk,
  GitDiffSummary
} from '../../../shared/ipc/types'
import {
  resolveGitAutofill,
  type GitAutofillContext,
  type GitAutofillDiffSummary
} from '../../services/git-autofill-service'
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
const gitCommitInputSchema = z.object({
  cwd: z.string().trim().min(1),
  message: z.string().optional()
})
const gitCreatePrInputSchema = z.object({
  cwd: z.string().trim().min(1),
  title: z.string().optional(),
  body: z.string().optional()
})
const gitPushInputSchema = z.object({
  cwd: z.string().trim().min(1)
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

type ChildProcessFailure = {
  code?: string | number
  status?: number
  stdout?: string | Buffer
  stderr?: string | Buffer
  message?: string
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function getChildProcessOutput(error: unknown): string {
  const maybeError = error as ChildProcessFailure
  const stderrText =
    typeof maybeError?.stderr === 'string'
      ? maybeError.stderr
      : Buffer.isBuffer(maybeError?.stderr)
        ? maybeError.stderr.toString('utf8')
        : ''
  const stdoutText =
    typeof maybeError?.stdout === 'string'
      ? maybeError.stdout
      : Buffer.isBuffer(maybeError?.stdout)
        ? maybeError.stdout.toString('utf8')
        : ''
  const messageText = typeof maybeError?.message === 'string' ? maybeError.message : ''

  return trimToUndefined([stderrText, stdoutText, messageText].filter(Boolean).join('\n')) || ''
}

export function mapGhExecutionError(error: unknown): Error {
  const maybeError = error as ChildProcessFailure
  if (maybeError?.code === 'ENOENT') {
    return new Error('Install GitHub CLI (`gh`) and authenticate with `gh auth login`.')
  }

  const output = getChildProcessOutput(error)
  const normalized = output.toLowerCase()
  const sameBranchMatch = output.match(
    /head branch "([^"]+)" is the same as base branch "([^"]+)"/i
  )
  if (sameBranchMatch?.[1] && sameBranchMatch?.[2]) {
    return new Error(
      `Current branch "${sameBranchMatch[1]}" matches base "${sameBranchMatch[2]}". Switch to a feature branch before creating a PR.`
    )
  }

  if (
    normalized.includes('not logged in') ||
    normalized.includes('not logged into any hosts') ||
    normalized.includes('authentication failed') ||
    normalized.includes('gh auth login')
  ) {
    return new Error('GitHub CLI authentication required. Run `gh auth login` and retry.')
  }

  return new Error(output || 'GitHub CLI command failed.')
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

function execFileTextAsync(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as ChildProcessFailure
          failure.stdout = typeof stdout === 'string' ? stdout : undefined
          failure.stderr = typeof stderr === 'string' ? stderr : undefined
          reject(failure)
          return
        }
        resolve(typeof stdout === 'string' ? stdout : '')
      }
    )
  })
}

async function runGitAsync(cwd: string, args: string[]): Promise<string> {
  try {
    return await execFileTextAsync('git', args, cwd)
  } catch (error) {
    const message =
      trimToUndefined(getChildProcessOutput(error)) ||
      'Git command failed for the selected project.'
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

async function runGitOptionalAsync(cwd: string, args: string[]): Promise<string> {
  try {
    return await runGitAsync(cwd, args)
  } catch {
    return ''
  }
}

async function runGhAsync(cwd: string, args: string[]): Promise<string> {
  try {
    return await execFileTextAsync('gh', args, cwd)
  } catch (error) {
    throw mapGhExecutionError(error)
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

async function gitRefExistsAsync(cwd: string, ref: string): Promise<boolean> {
  try {
    await execFileTextAsync('git', ['show-ref', '--verify', '--quiet', ref], cwd)
    return true
  } catch (error) {
    const maybeError = error as ChildProcessFailure
    if (maybeError?.status === 1 || maybeError?.code === 1) {
      return false
    }
    const message =
      error instanceof Error && error.message ? error.message : `Unable to verify git ref ${ref}.`
    throw new Error(message)
  }
}

function parseUpstreamRemote(upstreamRef: string | undefined): string | undefined {
  const normalized = trimToUndefined(upstreamRef)
  if (!normalized) {
    return undefined
  }
  const slashIndex = normalized.indexOf('/')
  if (slashIndex <= 0) {
    return undefined
  }
  return normalized.slice(0, slashIndex)
}

export function selectPushRemote(upstreamRef: string | undefined): string {
  return parseUpstreamRemote(upstreamRef) || 'origin'
}

function parseRemoteHeadBaseBranch(
  remoteHeadRef: string | undefined,
  remote: string
): string | undefined {
  const normalized = trimToUndefined(remoteHeadRef)
  if (!normalized) {
    return undefined
  }

  const prefix = `${remote}/`
  if (!normalized.startsWith(prefix)) {
    return undefined
  }

  const candidate = normalized.slice(prefix.length).trim()
  return candidate.length > 0 ? candidate : undefined
}

export function resolveBaseBranchCandidate(
  remoteHeadRef: string | undefined,
  remote: string,
  hasMain: boolean,
  hasMaster: boolean
): string | undefined {
  const fromRemoteHead = parseRemoteHeadBaseBranch(remoteHeadRef, remote)
  if (fromRemoteHead) {
    return fromRemoteHead
  }
  if (hasMain) {
    return 'main'
  }
  if (hasMaster) {
    return 'master'
  }
  return undefined
}

export function parsePrUrl(rawOutput: string): string | undefined {
  const match = rawOutput.match(/https?:\/\/[^\s]+/g)
  if (!match || match.length === 0) {
    return undefined
  }
  return trimToUndefined(match[match.length - 1])
}

export function assertCleanWorkingTree(statusOutput: string): void {
  if (trimToUndefined(statusOutput)) {
    throw new Error('Commit changes before creating PR.')
  }
}

export function assertNotDetachedHead(branch: string): void {
  if (branch.trim() === 'HEAD') {
    throw new Error('Cannot create PR from detached HEAD.')
  }
}

export function assertHeadDiffersFromBaseBranch(headBranch: string, baseBranch?: string): void {
  if (!baseBranch) {
    return
  }
  if (headBranch.trim() === baseBranch.trim()) {
    throw new Error(
      `Current branch "${headBranch}" matches base "${baseBranch}". Switch to a feature branch before creating a PR.`
    )
  }
}

export function assertMainBranch(branch: string): void {
  if (branch.trim() !== 'main') {
    throw new Error('Push to main is only available when you are on the main branch.')
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

function buildDiffSummaryFromNumstatOutput(numstatOutput: string): GitAutofillDiffSummary {
  const files: GitAutofillDiffSummary['files'] = []
  const lines = numstatOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  let totalAdditions = 0
  let totalDeletions = 0

  for (const line of lines) {
    const [rawAdditions, rawDeletions, ...pathParts] = line.split('\t')
    const path = pathParts.join('\t').trim()
    if (!path) {
      continue
    }

    const additions = rawAdditions === '-' ? 0 : Number.parseInt(rawAdditions, 10) || 0
    const deletions = rawDeletions === '-' ? 0 : Number.parseInt(rawDeletions, 10) || 0

    totalAdditions += additions
    totalDeletions += deletions
    files.push({
      path,
      status: 'modified',
      additions,
      deletions
    })
  }

  return {
    changedFiles: files.length,
    totalAdditions,
    totalDeletions,
    files
  }
}

function buildDiffSummaryFromWorkingTree(
  statusOutput: string,
  numstatStaged: string,
  numstatUnstaged: string
): GitAutofillDiffSummary {
  const filesByPath = new Map<
    string,
    {
      path: string
      status?: string
      additions: number
      deletions: number
    }
  >()

  const ensureSummaryFile = (
    path: string,
    status = 'modified'
  ): { path: string; status?: string; additions: number; deletions: number } => {
    const existing = filesByPath.get(path)
    if (existing) {
      if ((!existing.status || existing.status === 'modified') && status !== 'modified') {
        existing.status = status
      }
      return existing
    }

    const created = { path, status, additions: 0, deletions: 0 }
    filesByPath.set(path, created)
    return created
  }

  for (const line of statusOutput.split('\n').map((entry) => entry.trimEnd())) {
    if (!line || line.startsWith('## ')) {
      continue
    }
    const code = line.slice(0, 2)
    if (code === '!!') {
      continue
    }
    const rawPath = line.slice(3).trim()
    const normalizedPath = rawPath.includes(' -> ')
      ? rawPath.split(' -> ').at(-1)?.trim() || rawPath
      : rawPath
    if (!normalizedPath) {
      continue
    }
    ensureSummaryFile(normalizedPath, normalizeStatus(code))
  }

  const applyNumstat = (numstatOutput: string): void => {
    for (const line of numstatOutput
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean)) {
      const [rawAdditions, rawDeletions, ...pathParts] = line.split('\t')
      const path = pathParts.join('\t').trim()
      if (!path) {
        continue
      }
      const entry = ensureSummaryFile(path)
      const additions = rawAdditions === '-' ? 0 : Number.parseInt(rawAdditions, 10) || 0
      const deletions = rawDeletions === '-' ? 0 : Number.parseInt(rawDeletions, 10) || 0
      entry.additions += additions
      entry.deletions += deletions
    }
  }

  applyNumstat(numstatStaged)
  applyNumstat(numstatUnstaged)

  const files = [...filesByPath.values()].sort((left, right) => left.path.localeCompare(right.path))
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0)
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0)

  return {
    changedFiles: files.length,
    totalAdditions,
    totalDeletions,
    files
  }
}

async function buildWorkingTreeAutofillContext(cwd: string): Promise<GitAutofillContext> {
  const statusOutput = await runGitAsync(cwd, [
    'status',
    '--porcelain=v1',
    '--branch',
    '--untracked-files=all'
  ])
  const branchLine = statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .find((line) => line.startsWith('## '))
  const { branch } = parseBranchStatus(branchLine)
  const [
    numstatStaged,
    numstatUnstaged,
    stagedPatch,
    unstagedPatch,
    latestCommitMessage,
    latestCommitPatch
  ] = await Promise.all([
    runGitAsync(cwd, ['diff', '--cached', '--numstat']),
    runGitAsync(cwd, ['diff', '--numstat']),
    runGitOptionalAsync(cwd, ['diff', '--cached', '--unified=3', '--no-color']),
    runGitOptionalAsync(cwd, ['diff', '--unified=3', '--no-color']),
    runGitOptionalAsync(cwd, ['log', '-1', '--pretty=%B']),
    runGitOptionalAsync(cwd, ['show', '--format=', '--unified=3', '--no-color', 'HEAD'])
  ])

  return {
    cwd,
    branch,
    statusOutput,
    diffSummary: buildDiffSummaryFromWorkingTree(statusOutput, numstatStaged, numstatUnstaged),
    stagedPatch,
    unstagedPatch,
    latestCommitMessage: latestCommitMessage.trim(),
    latestCommitPatch
  }
}

async function buildHeadAutofillContext(cwd: string, branch: string): Promise<GitAutofillContext> {
  const [headNumstat, statusOutput, latestCommitMessage, latestCommitPatch] = await Promise.all([
    runGitOptionalAsync(cwd, ['show', '--numstat', '--format=', 'HEAD']),
    runGitOptionalAsync(cwd, ['status', '--porcelain=v1', '--branch', '--untracked-files=all']),
    runGitOptionalAsync(cwd, ['log', '-1', '--pretty=%B']),
    runGitOptionalAsync(cwd, ['show', '--format=', '--unified=3', '--no-color', 'HEAD'])
  ])

  return {
    cwd,
    branch,
    statusOutput,
    diffSummary: buildDiffSummaryFromNumstatOutput(headNumstat),
    latestCommitMessage: latestCommitMessage.trim(),
    latestCommitPatch,
    stagedPatch: '',
    unstagedPatch: ''
  }
}

async function resolvePushRemoteForBranch(cwd: string): Promise<string> {
  const upstreamRef = await runGitOptionalAsync(cwd, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}'
  ])
  return selectPushRemote(upstreamRef)
}

async function resolveBaseBranchForRemote(
  cwd: string,
  remote: string
): Promise<string | undefined> {
  const remoteHeadRef = await runGitOptionalAsync(cwd, [
    'symbolic-ref',
    '--quiet',
    '--short',
    `refs/remotes/${remote}/HEAD`
  ])

  const [hasLocalMain, hasRemoteMain, hasLocalMaster, hasRemoteMaster] = await Promise.all([
    gitRefExistsAsync(cwd, 'refs/heads/main'),
    gitRefExistsAsync(cwd, `refs/remotes/${remote}/main`),
    gitRefExistsAsync(cwd, 'refs/heads/master'),
    gitRefExistsAsync(cwd, `refs/remotes/${remote}/master`)
  ])

  return resolveBaseBranchCandidate(
    remoteHeadRef,
    remote,
    hasLocalMain || hasRemoteMain,
    hasLocalMaster || hasRemoteMaster
  )
}

async function ensureGhAuthenticated(cwd: string): Promise<void> {
  await runGhAsync(cwd, ['auth', 'status'])
}

async function executeGitCommit(
  cwd: string,
  message: string | undefined,
  onWarn?: (message: string) => void
): Promise<GitCommitResult> {
  const statusOutput = (await runGitAsync(cwd, ['status', '--porcelain=v1'])).trim()
  if (!statusOutput) {
    throw new Error('No local changes to commit.')
  }

  const context = await buildWorkingTreeAutofillContext(cwd)
  const autofill = await resolveGitAutofill(
    {
      commitMessage: message,
      prTitle: context.latestCommitMessage || 'Update project changes',
      prBody: '## Summary\n- Not run in app.\n\n## Testing\n- Not run in app.'
    },
    context,
    {
      onWarn
    }
  )

  await runGitAsync(cwd, ['add', '-A'])
  await runGitAsync(cwd, ['commit', '-m', autofill.commitMessage])
  const commitHash = (await runGitAsync(cwd, ['rev-parse', '--short', 'HEAD'])).trim()

  return {
    commitMessage: autofill.commitMessage,
    commitHash
  }
}

async function executeGitCreatePr(
  cwd: string,
  title: string | undefined,
  body: string | undefined,
  onWarn?: (message: string) => void
): Promise<GitCreatePrResult> {
  assertCleanWorkingTree((await runGitAsync(cwd, ['status', '--porcelain=v1'])).trim())

  const branch = (await runGitAsync(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  assertNotDetachedHead(branch)

  const remote = await resolvePushRemoteForBranch(cwd)
  await runGitAsync(cwd, ['push', '-u', remote, 'HEAD'])

  await ensureGhAuthenticated(cwd)
  const baseBranch = await resolveBaseBranchForRemote(cwd, remote)
  assertHeadDiffersFromBaseBranch(branch, baseBranch)
  const context = await buildHeadAutofillContext(cwd, branch)
  const autofill = await resolveGitAutofill(
    {
      commitMessage: context.latestCommitMessage || 'chore: update project files',
      prTitle: title,
      prBody: body
    },
    context,
    {
      onWarn
    }
  )

  const args = ['pr', 'create', '--title', autofill.prTitle, '--body', autofill.prBody]
  if (baseBranch) {
    args.push('--base', baseBranch)
  }
  const output = await runGhAsync(cwd, args)

  return {
    title: autofill.prTitle,
    body: autofill.prBody,
    url: parsePrUrl(output),
    baseBranch,
    headBranch: branch
  }
}

async function executeGitPush(cwd: string): Promise<GitPushResult> {
  const statusOutput = (await runGitAsync(cwd, ['status', '--porcelain=v1'])).trim()
  if (trimToUndefined(statusOutput)) {
    throw new Error('Commit changes before pushing to main.')
  }

  const branch = (await runGitAsync(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  assertNotDetachedHead(branch)
  assertMainBranch(branch)

  const remote = await resolvePushRemoteForBranch(cwd)
  await runGitAsync(cwd, ['push', '-u', remote, 'HEAD'])

  return {
    remote,
    branch
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
  ipcMain.handle(ipcChannels.app.gitCommit, (_, rawInput) =>
    safeInvoke(async () => {
      const input = gitCommitInputSchema.parse(rawInput)
      return await executeGitCommit(input.cwd, input.message, (message) =>
        context.logger.warn(message)
      )
    })
  )
  ipcMain.handle(ipcChannels.app.gitCreatePr, (_, rawInput) =>
    safeInvoke(async () => {
      const input = gitCreatePrInputSchema.parse(rawInput)
      return await executeGitCreatePr(input.cwd, input.title, input.body, (message) =>
        context.logger.warn(message)
      )
    })
  )
  ipcMain.handle(ipcChannels.app.gitPush, (_, rawInput) =>
    safeInvoke(async () => {
      const input = gitPushInputSchema.parse(rawInput)
      return await executeGitPush(input.cwd)
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
