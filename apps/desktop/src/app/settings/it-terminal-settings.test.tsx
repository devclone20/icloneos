// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { settings } from '@/i18n/en/settings'

import { ItTerminalSettings } from './it-terminal-settings'

vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: 'en', t: { settings } }) }))

// Front I-D anatomy pin (moved out of hud-settings.test.tsx in r4): every row of the pane is THE row (SettingRow)
// with its one sentence, and no control lives outside a row.
function rowsOf(container: HTMLElement) {
  const rows = [...container.querySelectorAll<HTMLElement>('[data-setting-row]')]

  return {
    loose: [...container.querySelectorAll<HTMLElement>('button, input, select, textarea, [role="switch"]')].filter(
      control => !control.closest('[data-setting-row]')
    ),
    rows,
    titles: rows.map(row => row.querySelector('.font-medium')?.textContent ?? '')
  }
}

afterEach(cleanup)

describe('Machine › iT on the one row component', () => {
  it('iT: five rows, the working-folder field trails its sentence', () => {
    const { container } = render(<ItTerminalSettings />)
    const { loose, rows, titles } = rowsOf(container)
    const c = settings.itTerminal

    expect(titles).toEqual([c.connectsTitle, c.usingTitle, c.cwdTitle, c.commandTitle, c.agentTitle])
    expect(rows[2].querySelector('input')?.getAttribute('aria-label')).toBe(c.cwdTitle)
    expect(container.textContent).toContain(c.cwdHint)
    expect(loose).toEqual([])
  })
})
