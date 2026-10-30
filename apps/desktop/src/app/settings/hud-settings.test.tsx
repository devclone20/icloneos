// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { settings } from '@/i18n/en/settings'

import { HudSettings } from './hud-settings'

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: { settings } }) }))
vi.mock('@/store/hud', () => ({ canUseHud: () => true, resetHudLayout: vi.fn(), toggleHud: vi.fn() }))
vi.mock('../hud/handoff', () => ({ hudTargetSessionId: () => null }))

const CONTROLS = 'button, input, select, textarea, [role="switch"], [role="combobox"], [role="radiogroup"]'

// Front I-D r1 anatomy pin: every row of a Machine pane is THE row (SettingRow), the title is the
// approved one sentence, and no control lives outside a row except section-heading actions.
function anatomy(container: HTMLElement) {
  const rows = [...container.querySelectorAll<HTMLElement>('[data-setting-row]')]
  const titles = rows.map(row => row.querySelector('.font-medium')?.textContent ?? '')

  const loose = [...container.querySelectorAll<HTMLElement>(CONTROLS)].filter(
    control => !control.closest('[data-setting-row]') && !control.closest('h2, h3, [data-nav-heading]')
  )

  return { loose, rows, titles }
}

afterEach(cleanup)

describe('Machine panes on the one row component', () => {
  it('HUD: every row is a SettingRow with its sentence and a trailing control where it has one', () => {
    const { container } = render(<HudSettings navigate={vi.fn()} />)
    const { loose, rows, titles } = anatomy(container)
    const h = settings.hud

    expect(titles).toEqual([
      h.introTitle,
      h.openTitle,
      h.resetTitle,
      h.holdTitle,
      h.frostTitle,
      h.clickThroughTitle,
      h.rebindTitle,
      h.keys.toggle.title,
      h.keys.snap.title,
      h.keys.exit.title,
      h.keys.close.title,
      h.bandTitle,
      h.handoffTitle
    ])
    expect(rows[4].querySelector('[role="switch"]')).not.toBeNull()
    expect(rows[3].querySelector('input[type="range"]')?.getAttribute('aria-label')).toBe(h.holdAria)
    expect(container.textContent).toContain(h.frostHint)
    expect(loose.map(control => control.textContent)).toEqual([])
  })

  it('every title in the group is one sentence: no trailing period, no dev-speak', () => {
    const sentences = [
      ...Object.values(settings.itTerminal).filter((_, i) => i % 2 === 0),
      settings.hud.introTitle,
      settings.hud.holdTitle,
      settings.keybindsPane.introTitle,
      settings.appearance.uiScaleTitle,
      settings.gateway.remoteUrlTitle,
      settings.connections.launchModeTitle
    ]

    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/\.$|PTY|\bOS\b|\bHEAD\b/)
    }
  })
})
