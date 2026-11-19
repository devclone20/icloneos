/**
 * v0.0.9 r3 — notification centre header (r1 #8) and empty state (design N7). Red on fb85ac6be6: the memory note was
 * a visible two-line paragraph above the list, "Clear all" was a bare quiet button with no 32px rule, the empty line
 * sat 6px from the plate edge, and an entry's action wore the faint quiet ink.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import { f4bCentre } from '@/i18n/en/v009-f4b'
import { clearNotificationHistory, clearNotifications, notify, openNotificationCentre } from '@/store/notifications'
import { stubResizeObserver } from '@/test/jsdom'
import { read } from '@/test/token-contrast'

import { NotificationStack } from './notifications'

const CSS = read('components/notification-system.css')

const rule = (selector: string) => {
  // r4: the split rules sit inside a media block, so a selector may be indented.
  const found = new RegExp(`\\n[ \\t]*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`).exec(CSS)
  expect(found, selector).not.toBeNull()

  const at = found!.index

  return CSS.slice(at, CSS.indexOf('}', at))
}

function mount() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <NotificationStack />
    </I18nProvider>
  )
}

beforeEach(() => {
  clearNotifications()
  clearNotificationHistory()
  stubResizeObserver()
})

afterEach(() => {
  cleanup()
  clearNotifications()
})

describe('centre header', () => {
  it('the memory note is a Tip on the count line: an info button described by the words, no visible paragraph', () => {
    openNotificationCentre()
    mount()
    const tip = screen.getByRole('button', { name: f4bCentre.memoryTipLabel })
    const note = screen.getByTestId('notification-centre-memory')

    expect(tip.closest('.icn-centre__count')).not.toBeNull()
    expect(document.getElementById(tip.getAttribute('aria-describedby') ?? '')?.textContent).toBe(f4bCentre.memoryNote)
    expect(note.closest('.icpg__sr')).not.toBeNull()
  })

  it('"Clear all" is a 32px target in the plate ink; the empty line sits on the header axis (18px)', () => {
    openNotificationCentre()
    mount()

    expect(screen.getByRole('button', { name: 'Clear all' }).closest('.icn-centre__clear')).not.toBeNull()
    expect(rule('.icn-centre__clear .icpg__btn')).toMatch(/min-height: 32px/)
    expect(rule('.icn-centre__clear .icpg__btn--quiet')).toMatch(/color: var\(--ic-note-ink-2\)/)
    expect(rule('.icn-centre__empty')).toMatch(/padding: 24px 18px/)
    expect(rule('.icn-centre__memory-tip::after')).toMatch(/inset: -7px/)
  })

  it("an entry's own action leads in the plate ink (tone note)", () => {
    notify({ action: { label: 'Open it', onClick: () => undefined }, kind: 'info', message: 'Ready' })
    openNotificationCentre()
    mount()
    const actions = screen.getAllByRole('button', { name: 'Open it' })

    expect(actions.every(a => a.className.includes('icpg__btn--note'))).toBe(true)
  })
})

describe('the banner in a split (design d-r2-2)', () => {
  // Red on fb85ac6be6: one placement for every arrangement, a centred 44rem plate under the band, over both pane heads
  // and the left pane's ×/menu column.
  it('docks into the titlebar band, clear of the band ends, the title never cut', () => {
    const wrap = rule(":root[data-ic-panes='split'] .icn-banner-wrap")
    const band = Number(/--ic-titlebar-band-h: (\d+)px/.exec(read('app/home/ic-tokens.css'))![1])
    const top = Number(/top: (\d+)px/.exec(wrap)![1])
    const plate = rule(":root[data-ic-panes='split'] .icn-banner")
    const [padTop, , padBottom] = /padding: (\d+)px (\d+)px (\d+)px/.exec(plate)!.slice(1).map(Number)
    const button = Number(/height: (\d+)px/.exec(rule(":root[data-ic-panes='split'] .icn-banner .icpg__btn"))![1])

    // The plate's tallest row is a 24px button: top + padding + row + padding stays inside the band, so it never
    // reaches the frame (and the pane heads) below it.
    expect(top + padTop + Math.max(button, 24) + padBottom).toBeLessThanOrEqual(band)
    // r4 (design r3 N8): clear of the band ends by MEASURED insets (window buttons, frame tools), never a magic 200px.
    expect(wrap).toMatch(/left: var\(--icn-dock-inset\)/)
    expect(wrap).toMatch(/right: var\(--icn-dock-inset\)/)
    expect(rule(":root[data-ic-panes='split'] .icn-banner .icn-body")).toMatch(/display: none/)
    // The title is never cut (gate N2, notification-inventory.test): no nowrap/ellipsis rule for it in a split.
    expect(CSS).not.toContain(":root[data-ic-panes='split'] .icn-banner .icn-title")
  })
})
