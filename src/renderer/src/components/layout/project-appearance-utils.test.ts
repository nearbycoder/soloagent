import { describe, expect, it } from 'vitest'
import {
  getAccentTintOverlay,
  getProjectInitial,
  hexToRgb,
  normalizeAccentColor
} from './project-appearance-utils'

describe('project-appearance-utils', () => {
  describe('normalizeAccentColor', () => {
    it('normalizes 6-char hex values and lowercases output', () => {
      expect(normalizeAccentColor('A1B2C3')).toBe('#a1b2c3')
      expect(normalizeAccentColor('  #FfEeDd  ')).toBe('#ffeedd')
    })

    it('expands 3-char hex values', () => {
      expect(normalizeAccentColor('#AbC')).toBe('#aabbcc')
      expect(normalizeAccentColor('0f8')).toBe('#00ff88')
    })

    it('returns empty string for invalid values', () => {
      expect(normalizeAccentColor('')).toBe('')
      expect(normalizeAccentColor('not-a-color')).toBe('')
      expect(normalizeAccentColor('#12345')).toBe('')
      expect(normalizeAccentColor('#1234567')).toBe('')
    })
  })

  describe('hexToRgb', () => {
    it('parses valid 6-char hex values', () => {
      expect(hexToRgb('#aabbcc')).toEqual({ r: 170, g: 187, b: 204 })
      expect(hexToRgb('112233')).toEqual({ r: 17, g: 34, b: 51 })
    })

    it('returns null for invalid values', () => {
      expect(hexToRgb('')).toBeNull()
      expect(hexToRgb('#abc')).toBeNull()
      expect(hexToRgb('#zzzzzz')).toBeNull()
    })
  })

  describe('getAccentTintOverlay', () => {
    it('returns a linear-gradient for valid color input', () => {
      expect(getAccentTintOverlay('#112233', 0.25)).toBe(
        'linear-gradient(rgba(17, 34, 51, 0.25), rgba(17, 34, 51, 0.25))'
      )
    })

    it('returns undefined for invalid color input', () => {
      expect(getAccentTintOverlay('#xyzxyz', 0.2)).toBeUndefined()
      expect(getAccentTintOverlay('', 0.2)).toBeUndefined()
    })
  })

  describe('getProjectInitial', () => {
    it('returns first trimmed character uppercased', () => {
      expect(getProjectInitial('soloagent')).toBe('S')
      expect(getProjectInitial('  hubz.team')).toBe('H')
    })

    it('returns fallback for empty names', () => {
      expect(getProjectInitial('')).toBe('?')
      expect(getProjectInitial('   ')).toBe('?')
    })
  })
})
