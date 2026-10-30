// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ar } from '@/i18n/ar'
import { en } from '@/i18n/en'
import { settings } from '@/i18n/en/settings'
import { ja } from '@/i18n/ja'
import { ptPt } from '@/i18n/pt-PT'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'
import { KEYBIND_ACTIONS, KEYBIND_READONLY } from '@/lib/keybinds/actions'

import { KeybindSettings } from './keybind-settings'

afterEach(cleanup)

// Front I-D r4 anatomy pin: the intro, the search field and every shortcut are rows on SettingRow,
// each titled by a sentence, with the binding control at the trailing edge.
describe('Machine › Keyboard shortcuts on the one row component', () => {
  it('opens with the intro and the search row, and no control lives outside a row', () => {
    const { container } = render(<KeybindSettings />)
    const rows = [...container.querySelectorAll<HTMLElement>('[data-setting-row]')]
    const titles = rows.map(row => row.querySelector('.font-medium')?.textContent ?? '')

    const loose = [...container.querySelectorAll<HTMLElement>('button, input, select, [role="switch"]')].filter(
      control => !control.closest('[data-setting-row]')
    )

    expect(titles.slice(0, 2)).toEqual([settings.keybindsPane.introTitle, settings.keybindsPane.searchTitle])
    expect(rows[1].querySelector('input')).not.toBeNull()
    expect(rows.length).toBeGreaterThan(2)
    expect(titles.every(title => title.trim().length > 0 && !title.trim().endsWith(':'))).toBe(true)
    expect(loose.map(control => control.outerHTML.slice(0, 80))).toEqual([])
  })
})

describe('keyboard shortcut names in every language (I-D r6)', () => {
  it('names every registered action in all six locales, so no row is ever titled by its raw id', async () => {
    const { KEYBIND_ACTIONS } = await import('@/lib/keybinds/actions')
    const { keybinds: en } = await import('@/i18n/en/keybinds')

    const locales = {
      ar: (await import('@/i18n/ar/keybinds')).keybinds,
      ja: (await import('@/i18n/ja/keybinds')).keybinds,
      zh: (await import('@/i18n/zh/keybinds')).keybinds,
      'zh-hant': (await import('@/i18n/zh-hant/keybinds')).keybinds,
      'pt-PT': (await import('@/i18n/pt-PT/keybinds')).keybinds
    }

    const named = KEYBIND_ACTIONS.map(action => action.id).filter(id => id in en.actions)

    const missing = Object.entries(locales).flatMap(([locale, words]) =>
      named.filter(id => !words?.actions?.[id]).map(id => `${locale}:${id}`)
    )

    expect(named.length).toBeGreaterThan(40)
    expect(missing).toEqual([])
  })
})

describe('Settings sidebar names in every language (I-D r7)', () => {
  it('every sidebar name of the English catalogue exists in ar, ja, zh, zh-hant and pt-PT, so no rail entry falls back to English', async () => {
    const { settings: en } = await import('@/i18n/en/settings')

    const locales = {
      ar: (await import('@/i18n/ar/settings')).settings,
      ja: (await import('@/i18n/ja/settings')).settings,
      zh: (await import('@/i18n/zh/settings')).settings,
      'zh-hant': (await import('@/i18n/zh-hant/settings')).settings,
      'pt-PT': (await import('@/i18n/pt-PT/settings')).settings
    }

    const keys = Object.keys(en.nav)

    const missing = Object.entries(locales).flatMap(([locale, words]) =>
      keys.filter(key => !(words?.nav as Record<string, string> | undefined)?.[key]).map(key => `${locale}:${key}`)
    )

    expect(missing).toEqual([])
  })
})

describe('Rebind buttons are named by their action (U4-p2b-04)', () => {
  it('gives every Rebind button a distinct accessible name that ends with the row title', () => {
    const { container } = render(<KeybindSettings />)

    const names = [...container.querySelectorAll<HTMLElement>('[data-setting-row] button[aria-label^="Rebind: "]')].map(
      button => button.getAttribute('aria-label') as string
    )

    expect(names.length).toBeGreaterThan(10)
    expect(new Set(names).size).toBe(names.length)
    expect(container.querySelectorAll('[data-setting-row][id^="keybind-"]').length).toBe(names.length)
  })
})

describe('one hint line per shortcut row, six locales (U2-p2b-10)', () => {
  it('names every built-in action and fixed shortcut, and nothing else', () => {
    const ids = [...KEYBIND_ACTIONS.map(action => action.id), ...KEYBIND_READONLY.map(shortcut => shortcut.id)]

    for (const t of [en, ja, zh, zhHant, ar, ptPt]) {
      const hints = t.settings.keybindHints

      expect(ids.filter(id => !hints[id]?.trim())).toEqual([])
      expect(Object.keys(hints).filter(id => !ids.includes(id))).toEqual([])
    }
  })
})
