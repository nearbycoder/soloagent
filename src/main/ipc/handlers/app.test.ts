import { describe, expect, it } from 'vitest'
import {
  assertCleanWorkingTree,
  assertNotDetachedHead,
  mapGhExecutionError,
  parsePrUrl,
  resolveBaseBranchCandidate,
  selectPushRemote
} from './app'

describe('app handler git workflow helpers', () => {
  it('prefers upstream remote when selecting push remote', () => {
    expect(selectPushRemote('upstream/feature-branch')).toBe('upstream')
    expect(selectPushRemote(undefined)).toBe('origin')
    expect(selectPushRemote('')).toBe('origin')
  })

  it('resolves base branch in priority order', () => {
    expect(resolveBaseBranchCandidate('origin/develop', 'origin', true, true)).toBe('develop')
    expect(resolveBaseBranchCandidate('', 'origin', true, true)).toBe('main')
    expect(resolveBaseBranchCandidate('', 'origin', false, true)).toBe('master')
    expect(resolveBaseBranchCandidate('', 'origin', false, false)).toBeUndefined()
  })

  it('parses PR url from gh output', () => {
    const output =
      'Creating pull request for feature/test into main\nhttps://github.com/acme/repo/pull/42\n'
    expect(parsePrUrl(output)).toBe('https://github.com/acme/repo/pull/42')
    expect(parsePrUrl('no url here')).toBeUndefined()
  })

  it('guards against dirty tree and detached HEAD', () => {
    expect(() => assertCleanWorkingTree('')).not.toThrow()
    expect(() => assertCleanWorkingTree(' M src/app.ts')).toThrow(
      'Commit changes before creating PR.'
    )

    expect(() => assertNotDetachedHead('feature/test')).not.toThrow()
    expect(() => assertNotDetachedHead('HEAD')).toThrow('Cannot create PR from detached HEAD.')
  })

  it('maps gh missing/auth errors to actionable messages', () => {
    expect(mapGhExecutionError({ code: 'ENOENT', message: 'spawn gh ENOENT' }).message).toContain(
      'Install GitHub CLI'
    )

    expect(
      mapGhExecutionError({ stderr: 'You are not logged into any GitHub hosts.' }).message
    ).toContain('gh auth login')
  })
})
