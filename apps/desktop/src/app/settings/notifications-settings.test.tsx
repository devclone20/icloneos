// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { settings as ar } from '@/i18n/ar/settings'
import { settings } from '@/i18n/en/settings'
import { settings as ja } from '@/i18n/ja/settings'
import { settings as ptPt } from '@/i18n/pt-PT/settings'
import { settings as zhHant } from '@/i18n/zh-hant/settings'
import { settings as zh } from '@/i18n/zh/settings'

import { NotificationsSettings } from './notifications-settings'

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

describe('Machine › Notifications on the one row component', () => {
  it('Notifications: the master switch, one switch per kind, the sound row', () => {
    const { container } = render(<NotificationsSettings />)
    const { loose, rows, titles } = rowsOf(container)
    const n = settings.notifications

    expect(titles[0]).toBe(n.enableAll)
    expect(titles).toContain(n.completionSoundTitle)
    expect(rows[0].querySelector('[role="switch"]')).not.toBeNull()
    expect(loose).toEqual([])

    for (const kind of Object.values(n.kinds)) {
      const row = rows[titles.indexOf(kind.label)]

      expect(row?.querySelector('[role="switch"]')).not.toBeNull()
      expect(row?.textContent).toContain(kind.description)
    }
  })

  it('every kind is a sentence in all six locales, never naming the runtime', () => {
    const kinds = Object.keys(settings.notifications.kinds) as (keyof typeof settings.notifications.kinds)[]

    for (const locale of [ar, ja, zh, zhHant, ptPt]) {
      for (const kind of kinds) {
        const entry = locale?.notifications?.kinds?.[kind]

        expect(entry?.label).toBeTruthy()
        expect(entry?.description).toBeTruthy()
        expect(entry?.label).not.toBe(settings.notifications.kinds[kind].label)
        expect(entry?.description).not.toBe(settings.notifications.kinds[kind].description)
      }
    }

    for (const locale of [settings, ar, ja, zh, zhHant, ptPt]) {
      expect(JSON.stringify(locale?.notifications?.kinds) + locale?.notifications?.focusedHint).not.toMatch(/hermes/i)
    }
  })
})
