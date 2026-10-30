// G8: the Book row is lazy (opening Settings never loads it) and reachable by
// search in all six languages; L7i: the inftBook catalogue is complete in each.
import { describe, expect, it, vi } from 'vitest'

import { TRANSLATIONS } from '@/i18n/catalog'
import type { Locale } from '@/i18n/types'

import { buildPaneSearchEntries, filterSettingsSearchEntries } from '../settings-search'

const loaded = vi.hoisted(() => ({ book: false }))

vi.mock('./index', () => {
  loaded.book = true

  return { InftBookView: () => null }
})

type Leaf = ((...args: never[]) => string) | readonly string[] | string

function leaves(node: object, prefix = ''): Map<string, Leaf> {
  const out = new Map<string, Leaf>()

  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [inner, leaf] of leaves(value, path)) {
        out.set(inner, leaf)
      }
    } else {
      out.set(path, value as Leaf)
    }
  }

  return out
}

const locales = Object.keys(TRANSLATIONS) as Locale[]

// K105: loading the Settings pane registry, sized from its isolated p95 × 3 (measured 2026-10-21 at load ≈ 11:
// 8.5–9.4 s), so a loaded full suite does not turn it red on time alone.
vi.setConfig({ testTimeout: 30_000 })

describe('Settings › iNFT Book', () => {
  it('loading the Settings panes does not load the Book', async () => {
    const { buildSettingsNavRows, settingsPaneSearchRows } = await import('../panes')

    expect(settingsPaneSearchRows(TRANSLATIONS.en).some(row => row.id === 'inft-book')).toBe(true)
    expect(typeof buildSettingsNavRows).toBe('function')
    expect(loaded.book).toBe(false)
  })

  it.each(locales)('search finds "iNFT Book" in %s', async locale => {
    const { settingsPaneSearchRows } = await import('../panes')
    const entries = buildPaneSearchEntries(settingsPaneSearchRows(TRANSLATIONS[locale]), () => false)

    expect(filterSettingsSearchEntries(entries, 'iNFT Book')[0]?.id).toBe('pane:inft-book')
  })

  it('there are six locales', () => {
    expect([...locales].sort()).toEqual(['ar', 'en', 'ja', 'pt-PT', 'zh', 'zh-hant'])
  })

  const english = leaves(TRANSLATIONS.en.inftBook)

  it.each(locales.filter(locale => locale !== 'en'))('%s has every inftBook key, translated', locale => {
    const local = leaves(TRANSLATIONS[locale].inftBook)

    expect([...local.keys()].sort()).toEqual([...english.keys()].sort())

    for (const [path, leaf] of english) {
      const mine = local.get(path)

      expect(typeof mine, path).toBe(typeof leaf)

      // The proper noun and the rule's own name stay; every sentence is the locale's own.
      if (typeof leaf === 'string' && path !== 'navLabel') {
        expect(mine, `${locale}.${path}`).not.toBe(leaf)
      }

      if (typeof leaf === 'function' && typeof mine === 'function') {
        const sample = (fn: (...args: never[]) => string) => (fn as (...args: unknown[]) => string)(3, 7)

        expect(sample(mine), `${locale}.${path}`).not.toBe(sample(leaf))
      }
    }
  })
})
