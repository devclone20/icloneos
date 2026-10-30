import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// Read from disk: the ui project stubs CSS imports (even `?raw`) to ''.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const indexHtml = read('../../../index.html')
const tokensCss = read('../home/ic-tokens.css')

const night = /--ic-ink-900:\s*(#[0-9a-f]{6})\s*;/i.exec(tokensCss)?.[1]?.toLowerCase()

describe('first paint', () => {
  it('pre-paints OUR night before any script runs', () => {
    const root = /<html[^>]*\sstyle="([^"]*)"/i.exec(indexHtml)?.[1] ?? ''

    expect(night).toMatch(/^#[0-9a-f]{6}$/)
    expect(root.toLowerCase()).toContain(`background-color: ${night}`)
    expect(root).toContain('color-scheme: dark')
    expect(indexHtml.toLowerCase()).toContain(`<meta name="theme-color" content="${night}" />`)
  })

  it('paints the boot void — pure black, the --ic-black token — until #root has content', () => {
    const black = /--ic-black:\s*(#[0-9a-f]{6})\s*;/i.exec(tokensCss)?.[1]?.toLowerCase()
    const style = /<style>([\s\S]*?)<\/style>/i.exec(indexHtml)?.[1] ?? ''
    const voidRule = /html:has\(>\s*body\s*>\s*#root:empty\)\s*\{([^}]*)\}/.exec(style)?.[1] ?? ''

    expect(black).toBe('#000000')
    // !important: it must outrank the night pre-paint inline on <html> (and the
    // glass rule's transparent !important) for exactly as long as #root is empty.
    expect(voidRule.replace(/\s+/g, ' ').trim().toLowerCase()).toBe(`background-color: ${black} !important;`)
    // Nothing else may light the first frame.
    expect(style).not.toMatch(/gradient|box-shadow|filter|url\(/i)
  })

  it('reads no upstream boot colour from storage', () => {
    expect(indexHtml).not.toMatch(/hermes-boot-(background|color-scheme)/)
    expect(indexHtml).not.toMatch(/localStorage/)
  })
})
