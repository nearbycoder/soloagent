import { describe, expect, it } from 'vitest'
import {
  buildFallbackCommitMessage,
  buildFallbackPrBody,
  resolveGitAutofill,
  type GitAutofillContext
} from './git-autofill-service'

function makeContext(overrides: Partial<GitAutofillContext> = {}): GitAutofillContext {
  return {
    cwd: '/tmp/project',
    branch: 'feature/example',
    statusOutput: '## feature/example',
    diffSummary: {
      changedFiles: 2,
      totalAdditions: 14,
      totalDeletions: 3,
      files: [
        { path: 'src/app.ts', status: 'modified', additions: 12, deletions: 2 },
        { path: 'README.md', status: 'modified', additions: 2, deletions: 1 }
      ]
    },
    stagedPatch: '',
    unstagedPatch: '',
    latestCommitMessage: 'feat: previous message',
    latestCommitPatch: '',
    ...overrides
  }
}

describe('git-autofill-service', () => {
  it('builds a conventional commit fallback from diff stats', () => {
    const message = buildFallbackCommitMessage(makeContext().diffSummary)
    expect(message.startsWith('chore:')).toBe(true)
    expect(message).toContain('update')
  })

  it('builds deterministic PR body fallback', () => {
    const body = buildFallbackPrBody('feat: add new settings panel', makeContext())
    expect(body).toContain('## Summary')
    expect(body).toContain('## Testing')
    expect(body).toContain('Not run in app')
  })

  it('preserves user-provided fields and fills missing ones when codex is unavailable', async () => {
    const result = await resolveGitAutofill(
      {
        commitMessage: 'feat(ui): add quick actions',
        prTitle: 'Custom PR Title',
        prBody: ''
      },
      makeContext(),
      {
        runCodexPrompt: async () => {
          throw new Error('Codex unavailable')
        }
      }
    )

    expect(result.commitMessage).toBe('feat(ui): add quick actions')
    expect(result.prTitle).toBe('Custom PR Title')
    expect(result.prBody).toContain('## Summary')
  })

  it('handles empty diff context safely', async () => {
    const result = await resolveGitAutofill(
      {
        commitMessage: '',
        prTitle: '',
        prBody: ''
      },
      makeContext({
        diffSummary: {
          changedFiles: 0,
          totalAdditions: 0,
          totalDeletions: 0,
          files: []
        },
        latestCommitMessage: ''
      }),
      {
        runCodexPrompt: async () => ''
      }
    )

    expect(result.commitMessage.length).toBeGreaterThan(0)
    expect(result.prTitle.length).toBeGreaterThan(0)
    expect(result.prBody).toContain('Not run in app')
  })
})
