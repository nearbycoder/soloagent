import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergePosixPathValues, resolveCommandExecutable } from './shell-env'

describe('shell-env', () => {
  it('prefers login shell path ordering and de-duplicates entries', () => {
    const merged = mergePosixPathValues(
      '/usr/bin:/opt/homebrew/bin:/custom/bin',
      '/custom/bin:/usr/local/bin',
      '/Users/test',
      ':'
    )

    const parts = merged.split(':')
    expect(parts[0]).toBe('/custom/bin')
    expect(parts[1]).toBe('/usr/local/bin')
    expect(parts.filter((entry) => entry === '/custom/bin')).toHaveLength(1)
    expect(parts).toContain('/opt/homebrew/bin')
    expect(parts).toContain('/Users/test/.pyenv/bin')
  })

  it('adds known fallback segments when shell path is unavailable', () => {
    const merged = mergePosixPathValues(undefined, undefined, '/Users/test', ':')
    const parts = merged.split(':')

    expect(parts).toContain('/opt/homebrew/bin')
    expect(parts).toContain('/usr/local/bin')
    expect(parts).toContain('/Users/test/.local/bin')
  })

  it('resolves executable from PATH', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'shell-env-test-'))
    try {
      const codexPath = join(tempDir, 'codex')
      writeFileSync(codexPath, '#!/bin/sh\nexit 0\n', { encoding: 'utf8' })
      chmodSync(codexPath, 0o755)

      const env: NodeJS.ProcessEnv = { PATH: tempDir, SHELL: '/bin/zsh' }
      const resolved = resolveCommandExecutable('codex', env)
      expect(resolved).toBe(codexPath)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
