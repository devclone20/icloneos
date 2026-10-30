import { describe, expect, it } from 'vitest'

import { INFT_WIZARD_COPY } from './inft-setup-wizard-copy'

type Leaf = [path: string, value: string]

function leaves(node: unknown, prefix = ''): Leaf[] {
  if (typeof node === 'function') {
    return [[prefix, String((node as (arg: never) => string)('x' as never))]]
  }

  if (typeof node === 'string') {
    return [[prefix, node]]
  }

  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    leaves(value, prefix ? `${prefix}.${key}` : key)
  )
}

// Paths that are a chain name plus an address in every language.
const UNTRANSLATED = new Set(['wallet.evm', 'wallet.sol'])

describe('iNFT setup wizard copy', () => {
  const en = new Map(leaves(INFT_WIZARD_COPY.en))

  it.each(['ar', 'ja', 'zh', 'zh-hant', 'pt-PT'] as const)('%s carries every sentence in its own language', locale => {
    const other = new Map(leaves(INFT_WIZARD_COPY[locale]))

    expect([...other.keys()]).toEqual([...en.keys()])

    for (const [path, value] of other) {
      expect(value.trim(), path).not.toBe('')

      if (!UNTRANSLATED.has(path)) {
        expect(value, `${locale} ${path} is still English`).not.toBe(en.get(path))
      }
    }
  })

  it('keeps every title to one sentence', () => {
    for (const [path, value] of en) {
      if (path.endsWith('.title')) {
        expect(value.replace(/\.$/, ''), path).not.toMatch(/[.!?]\s/)
      }
    }
  })
})
