import { spawn } from 'node:child_process'
import { ensureShellPathInProcessEnv, resolveCommandExecutable } from './shell-env'

const DEFAULT_CODEX_MODEL = 'gpt-5.3-codex'
const MAX_STAGED_PATCH_CHARS = 10_000
const MAX_UNSTAGED_PATCH_CHARS = 10_000
const MAX_HEAD_PATCH_CHARS = 10_000
const MAX_STATUS_CHARS = 1_500
const MAX_FILES_IN_PROMPT = 40
const MAX_PR_BODY_FILES = 8
const MAX_FILE_PATH_PREVIEW = 120
const MAX_SUBJECT_LENGTH = 72
const CODEX_AUTOFILL_TIMEOUT_MS = 45_000
const CODEX_AUTOFILL_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export type GitAutofillFileSummary = {
  path: string
  status?: string
  additions: number
  deletions: number
}

export type GitAutofillDiffSummary = {
  changedFiles: number
  totalAdditions: number
  totalDeletions: number
  files: GitAutofillFileSummary[]
}

export type GitAutofillContext = {
  cwd: string
  branch?: string
  statusOutput?: string
  diffSummary?: GitAutofillDiffSummary
  stagedPatch?: string
  unstagedPatch?: string
  latestCommitMessage?: string
  latestCommitPatch?: string
}

export type GitAutofillInput = {
  commitMessage?: string
  prTitle?: string
  prBody?: string
}

export type GitAutofillResult = {
  commitMessage: string
  prTitle: string
  prBody: string
}

type CodexAutofillPayload = {
  commit_message?: string
  pr_title?: string
  pr_body?: string
}

export type GitAutofillOptions = {
  runCodexPrompt?: (prompt: string, cwd: string) => Promise<string>
  onWarn?: (message: string) => void
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function shorten(value: string | undefined, maxChars: number): string {
  if (!value) {
    return ''
  }

  const trimmed = value.trim()
  if (trimmed.length <= maxChars) {
    return trimmed
  }

  return `${trimmed.slice(0, maxChars)}\n...[truncated]`
}

function toSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function extractSubject(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const firstLine = value
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine || undefined
}

function truncateSubject(value: string): string {
  if (value.length <= MAX_SUBJECT_LENGTH) {
    return value
  }
  return `${value.slice(0, MAX_SUBJECT_LENGTH - 3).trimEnd()}...`
}

function sanitizePath(path: string): string {
  const normalized = toSingleLine(path)
  if (normalized.length <= MAX_FILE_PATH_PREVIEW) {
    return normalized
  }
  return `...${normalized.slice(-(MAX_FILE_PATH_PREVIEW - 3))}`
}

function summarizeDiffLine(summary: GitAutofillDiffSummary | undefined): string {
  if (!summary || summary.changedFiles <= 0) {
    return 'No file-level diff summary was available.'
  }

  return `${summary.changedFiles} file${summary.changedFiles === 1 ? '' : 's'} changed (+${summary.totalAdditions}/-${summary.totalDeletions}).`
}

function summarizeFiles(summary: GitAutofillDiffSummary | undefined, maxFiles: number): string {
  if (!summary || summary.files.length === 0) {
    return ''
  }

  const topFiles = summary.files
    .slice()
    .sort((left, right) => right.additions + right.deletions - (left.additions + left.deletions))
    .slice(0, maxFiles)

  if (topFiles.length === 0) {
    return ''
  }

  const lines = topFiles.map((file) => {
    const status = file.status || 'modified'
    return `- ${sanitizePath(file.path)} (${status}, +${file.additions}/-${file.deletions})`
  })

  return lines.join('\n')
}

function conventionalFallbackSummary(summary: GitAutofillDiffSummary | undefined): string {
  if (!summary || summary.changedFiles <= 0) {
    return 'update project files'
  }

  if (summary.changedFiles === 1) {
    const firstFile = summary.files[0]
    if (firstFile?.path) {
      return `update ${sanitizePath(firstFile.path)}`
    }
  }

  return `update ${summary.changedFiles} files`
}

export function buildFallbackCommitMessage(summary?: GitAutofillDiffSummary): string {
  return truncateSubject(`chore: ${conventionalFallbackSummary(summary)}`)
}

export function buildFallbackPrTitle(
  commitMessage: string | undefined,
  context: GitAutofillContext
): string {
  const commitSubject = extractSubject(commitMessage)
  if (commitSubject) {
    return truncateSubject(toSingleLine(commitSubject))
  }

  const headSubject = extractSubject(context.latestCommitMessage)
  if (headSubject) {
    return truncateSubject(toSingleLine(headSubject))
  }

  return truncateSubject(buildFallbackCommitMessage(context.diffSummary))
}

export function buildFallbackPrBody(title: string, context: GitAutofillContext): string {
  const summaryLine = summarizeDiffLine(context.diffSummary)
  const filesSummary = summarizeFiles(context.diffSummary, MAX_PR_BODY_FILES)
  const fileLines = filesSummary
    ? `\n### Files\n${filesSummary}`
    : context.latestCommitMessage
      ? `\n### Latest Commit\n- ${toSingleLine(extractSubject(context.latestCommitMessage) || '')}`
      : ''

  return [
    '## Summary',
    `- ${toSingleLine(title)}`,
    `- ${summaryLine}`,
    fileLines,
    '',
    '## Testing',
    '- Not run in app.'
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function buildCodexPrompt(context: GitAutofillContext): string {
  const branch = trimToUndefined(context.branch) || 'unknown'
  const statusOutput = shorten(context.statusOutput, MAX_STATUS_CHARS)
  const stagedPatch = shorten(context.stagedPatch, MAX_STAGED_PATCH_CHARS)
  const unstagedPatch = shorten(context.unstagedPatch, MAX_UNSTAGED_PATCH_CHARS)
  const latestCommitPatch = shorten(context.latestCommitPatch, MAX_HEAD_PATCH_CHARS)
  const latestCommitMessage = shorten(context.latestCommitMessage, 2_000)

  const summary = context.diffSummary
  const selectedFiles = summary
    ? {
        ...summary,
        files: summary.files.slice(0, MAX_FILES_IN_PROMPT)
      }
    : undefined

  const summaryJson = selectedFiles ? JSON.stringify(selectedFiles, null, 2) : 'null'

  return [
    'You are writing Git metadata for a code change.',
    'Return only strict JSON (no markdown, no comments) with keys:',
    '{"commit_message":"...","pr_title":"...","pr_body":"..."}',
    'Use concise, imperative style and Conventional Commit format for commit_message.',
    'If context is incomplete, still infer a safe, neutral response.',
    '',
    `Branch: ${branch}`,
    '',
    'Status (--porcelain --branch):',
    statusOutput || '(empty)',
    '',
    'Diff Summary:',
    summaryJson,
    '',
    'Staged Patch (truncated):',
    stagedPatch || '(empty)',
    '',
    'Unstaged Patch (truncated):',
    unstagedPatch || '(empty)',
    '',
    'Latest Commit Message:',
    latestCommitMessage || '(empty)',
    '',
    'Latest Commit Patch (truncated):',
    latestCommitPatch || '(empty)'
  ].join('\n')
}

function extractJsonObjectCandidate(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) {
    return undefined
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) {
    const candidate = fencedMatch[1].trim()
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      return candidate
    }
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed
  }

  let depth = 0
  let startIndex = -1
  let inString = false
  let escaped = false

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (char === '"') {
      inString = !inString
      continue
    }

    if (inString) {
      continue
    }

    if (char === '{') {
      if (depth === 0) {
        startIndex = index
      }
      depth += 1
      continue
    }

    if (char === '}') {
      if (depth > 0) {
        depth -= 1
        if (depth === 0 && startIndex >= 0) {
          return trimmed.slice(startIndex, index + 1)
        }
      }
    }
  }

  return undefined
}

function parseCodexPayload(raw: string): CodexAutofillPayload | undefined {
  const candidate = extractJsonObjectCandidate(raw)
  if (!candidate) {
    return undefined
  }

  try {
    const parsed = JSON.parse(candidate) as CodexAutofillPayload
    if (!parsed || typeof parsed !== 'object') {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

async function runCodexPrompt(prompt: string, cwd: string): Promise<string> {
  ensureShellPathInProcessEnv()
  const codexCommand = resolveCommandExecutable('codex')
  return await new Promise((resolve, reject) => {
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '-m',
      DEFAULT_CODEX_MODEL,
      '-c',
      'model_reasoning_effort="low"',
      prompt
    ]
    const child = spawn(codexCommand, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let didTimeout = false
    let didOverflow = false

    const timeout = setTimeout(() => {
      didTimeout = true
      child.kill('SIGTERM')
    }, CODEX_AUTOFILL_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      stdoutBytes += Buffer.byteLength(text)
      if (stdoutBytes > CODEX_AUTOFILL_MAX_OUTPUT_BYTES) {
        didOverflow = true
        child.kill('SIGTERM')
        return
      }
      stdout += text
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      stderrBytes += Buffer.byteLength(text)
      if (stderrBytes > CODEX_AUTOFILL_MAX_OUTPUT_BYTES) {
        didOverflow = true
        child.kill('SIGTERM')
        return
      }
      stderr += text
    })

    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    child.once('close', (code) => {
      clearTimeout(timeout)

      if (didTimeout) {
        reject(new Error('Codex autofill timed out after 45s.'))
        return
      }

      if (didOverflow) {
        reject(new Error('Codex autofill output exceeded size limit.'))
        return
      }

      if (code !== 0) {
        reject(
          new Error(trimToUndefined(stderr) || `Codex autofill failed with exit code ${code}.`)
        )
        return
      }

      resolve(stdout)
    })
  })
}

export async function resolveGitAutofill(
  input: GitAutofillInput,
  context: GitAutofillContext,
  options: GitAutofillOptions = {}
): Promise<GitAutofillResult> {
  const commitMessage = trimToUndefined(input.commitMessage)
  const prTitle = trimToUndefined(input.prTitle)
  const prBody = trimToUndefined(input.prBody)

  const needsAutofill = !commitMessage || !prTitle || !prBody

  let codexPayload: CodexAutofillPayload | undefined
  if (needsAutofill) {
    const runner = options.runCodexPrompt || runCodexPrompt
    const prompt = buildCodexPrompt(context)
    try {
      const response = await runner(prompt, context.cwd)
      codexPayload = parseCodexPayload(response)
      if (!codexPayload) {
        options.onWarn?.('Codex autofill returned non-JSON output. Falling back.')
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      options.onWarn?.(`Codex autofill failed: ${reason}`)
      codexPayload = undefined
    }
  }

  const fallbackCommit = buildFallbackCommitMessage(context.diffSummary)
  const resolvedCommit =
    commitMessage || trimToUndefined(codexPayload?.commit_message) || fallbackCommit

  const fallbackPrTitle = buildFallbackPrTitle(resolvedCommit, context)
  const resolvedPrTitle = prTitle || trimToUndefined(codexPayload?.pr_title) || fallbackPrTitle

  const fallbackPrBody = buildFallbackPrBody(resolvedPrTitle, context)
  const resolvedPrBody = prBody || trimToUndefined(codexPayload?.pr_body) || fallbackPrBody

  return {
    commitMessage: resolvedCommit,
    prTitle: resolvedPrTitle,
    prBody: resolvedPrBody
  }
}
