/**
 * v0.0.9 G design verdict GF-M1 (MAJOR): the pinned (sticky) user prompt at the top of the Message thread was
 * translucent (--ic-surface-glass under an --ic-accent-soft bubble), so the scrolled reply text drew through it and
 * neither line could be read, in both skins. The sticky row must paint an opaque slab: a surface token that resolves
 * to a colour with no transparency in every skin (ic-tokens.css), so no thread text shows inside it.
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { STICKY_HUMAN_ROW_CLASS } from './user-message'

const TOKENS = fs.readFileSync(path.resolve(__dirname, '../../../app/home/ic-tokens.css'), 'utf8')

/** Every declaration of `name` per selector block, in source order. */
function declarations(name: string): { selector: string; value: string }[] {
  const out: { selector: string; value: string }[] = []
  const block = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null

  while ((match = block.exec(TOKENS))) {
    const decl = new RegExp(`(?:^|;|\\s)${name.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+);`).exec(match[2])

    if (decl) {
      out.push({ selector: match[1].trim().split('\n').pop()!.trim(), value: decl[1].trim() })
    }
  }

  return out
}

/** Follow var() chains through the first declaration of each primitive, to the literal it names. */
function resolve(value: string, depth = 0): string {
  const ref = /^var\((--[\w-]+)\)$/.exec(value)

  if (!ref || depth > 8) {
    return value
  }

  const next = declarations(ref[1])[0]

  return next ? resolve(next.value, depth + 1) : value
}

const opaque = (literal: string) =>
  /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(literal) || /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i.test(literal)

describe('the sticky user prompt paints an opaque slab', () => {
  it('uses the opaque surface token, never the glass one', () => {
    const background = /(?:^|\s)bg-\((--[\w-]+)\)/.exec(STICKY_HUMAN_ROW_CLASS)?.[1]

    expect(background).toBe('--ic-surface')
    expect(STICKY_HUMAN_ROW_CLASS).not.toContain('--ic-surface-glass')
  })

  it('--ic-surface is opaque in every skin that declares it (dark root and light)', () => {
    const found = declarations('--ic-surface')

    expect(found.length).toBeGreaterThanOrEqual(2)

    for (const { selector, value } of found) {
      const literal = resolve(value)

      expect(opaque(literal), `${selector}: --ic-surface resolves to ${literal}`).toBe(true)
    }
  })
})
