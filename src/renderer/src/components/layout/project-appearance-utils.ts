export function normalizeAccentColor(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`
  const shortHex = /^#([0-9a-f]{3})$/i.exec(withHash)
  if (shortHex) {
    const [r, g, b] = shortHex[1].split('')
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }

  return /^#[0-9a-f]{6}$/i.test(withHash) ? withHash.toLowerCase() : ''
}

export function hexToRgb(value: string): { r: number; g: number; b: number } | null {
  if (!value) {
    return null
  }
  const hex = value.trim().replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(hex)) {
    return null
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16)
  }
}

export function getAccentTintOverlay(color: string, alpha: number): string | undefined {
  const rgb = hexToRgb(color)
  if (!rgb) {
    return undefined
  }
  return `linear-gradient(rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha}), rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha}))`
}

export function getProjectInitial(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    return '?'
  }
  return trimmed.charAt(0).toUpperCase()
}
