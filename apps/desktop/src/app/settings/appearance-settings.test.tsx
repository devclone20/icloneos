// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { $dockWindowSize, setDockWindowSize } from '@/store/dock-window-size'

import { AppearanceSettings } from './appearance-settings'

afterEach(cleanup)

function renderPane() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={client}>
      <AppearanceSettings />
    </QueryClientProvider>
  )
}

// Front I-D r4 anatomy pin: every Appearance row (text size, theme, terminal font, embeds) is a
// SettingRow titled by a sentence; theme cards and segmented choices sit inside their row.
describe('Machine › Appearance on the one row component', () => {
  it('every control sits inside a row and every title is a sentence without a colon', () => {
    const { container } = renderPane()

    const rows = [...container.querySelectorAll<HTMLElement>('[data-setting-row]')]
    const titles = rows.map(row => (row.querySelector('.font-medium')?.textContent ?? '').trim())

    const loose = [...container.querySelectorAll<HTMLElement>('button, input, select, [role="switch"]')].filter(
      control => !control.closest('[data-setting-row]') && !control.closest('h2, h3, [role="radiogroup"]')
    )

    // The critic's rendered-rows probe rule: a card grid of choices (theme, mode) is one control of its section.
    const choices = loose.filter(control => control.closest('.grid') || control.hasAttribute('aria-pressed'))

    expect(rows.length).toBeGreaterThan(8)
    expect(titles.filter(title => !title || title.endsWith(':'))).toEqual([])
    expect(loose.filter(control => !choices.includes(control)).map(control => control.outerHTML.slice(0, 80))).toEqual(
      []
    )
  })
})

// Ruling 69 (owner, 2026-10-25, supersedes 61): the app ships in ENGLISH ONLY, so the picker draws nothing — and a
// row whose control draws nothing is a title, a hint and an empty space. This pane no longer has that row. It comes
// back with the language (G-31); until then its absence is the decision, not a regression.
describe('Machine › Appearance has no Language row (ruling 69)', () => {
  it('no row carries the language title, hint or element id, and nothing empty is left in its place', () => {
    const { container } = renderPane()

    const rows = [...container.querySelectorAll<HTMLElement>('[data-setting-row]')]
    const titles = rows.map(row => (row.querySelector('.font-medium')?.textContent ?? '').trim())

    expect(titles).not.toContain(en.settings.appearance.languageTitle)
    expect(container.textContent ?? '').not.toContain(en.language.description)
    expect(container.querySelector('[id$="appearance.language"]')).toBeNull()
    // Every surviving row still has a control: no row was left behind with an empty slot.
    expect(
      rows.filter(row => !row.querySelector('button, input, select, [role="switch"], [role="radiogroup"]')).length
    ).toBe(0)
  })
})

describe('Machine › Appearance picks how the Dock windows open', () => {
  afterEach(() => setDockWindowSize('maximized'))

  it('one row, two choices, maximized by default; picking one is the choice the next opening reads', () => {
    const words = en.settings.appearance
    const { container } = renderPane()
    const group = screen.getByRole('radiogroup', { name: words.dockWindowSizeTitle })
    const choice = (name: string) => screen.getByRole('radio', { name })

    expect(group.closest('[data-setting-row]')?.id).toMatch(/appearance\.dock-window-size$/)
    expect(container.textContent).toContain(words.dockWindowSizeDesc)
    expect(screen.getAllByRole('radio').filter(radio => group.contains(radio))).toHaveLength(2)
    expect(choice(words.dockWindowSizeMaximized).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(choice(words.dockWindowSizeNormal))
    expect($dockWindowSize.get()).toBe('normal')
    expect(choice(words.dockWindowSizeNormal).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(choice(words.dockWindowSizeMaximized))
    expect($dockWindowSize.get()).toBe('maximized')
  })
})
