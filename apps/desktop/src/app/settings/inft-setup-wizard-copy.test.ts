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

// v0.0.9 W1b (F1-B item 6): the CLI ships inside the app, so step 1 has no Install / Check for updates / Update now.
// Its old words must not linger in the catalogue (a dead key invites a dead button back). Red on the old copy.
describe('iNFT setup wizard copy · retired CLI install words', () => {
  const RETIRED = ['title', 'hint', 'ready', 'install', 'checkUpdate', 'updateNow', 'updateAvailable']

  it.each(Object.keys(INFT_WIZARD_COPY) as (keyof typeof INFT_WIZARD_COPY)[])('%s has none of them', locale => {
    const cli = INFT_WIZARD_COPY[locale].cli as Record<string, unknown>

    for (const key of RETIRED) {
      expect(cli[key], `${locale} cli.${key}`).toBeUndefined()
    }

    expect(Object.keys(cli).sort()).toEqual(['checking', 'keychain', 'notTaught', 'reteach', 'taught', 'unknownError'])
  })
})
