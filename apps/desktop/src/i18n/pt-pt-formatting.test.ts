// pt-PT dates and numbers (front V3-T): the app's locale id is a BCP 47 tag, so every formatter that takes the UI
// locale writes European Portuguese — day before month, abbreviated months in lower case, decimal comma.
import { describe, expect, it } from 'vitest'

import { dayLabel, momentLabel } from '@/app/settings/app-atualisation/agent-model'
import { LOCALE_META } from '@/i18n'
import { CATALOGUE_LOCALES } from '@/i18n/languages'

const AT = '2026-10-21T13:05:00Z'

describe('pt-PT formatting (V3-T)', () => {
  // Ruling 69 (owner, 2026-10-25): the app ships in English only, so Portuguese is no longer named in the picker —
  // there is no picker. Its catalogue stays in the tree and its formatters stay correct, which is what makes G-31
  // (offering a language again) a catalogue-free change. Not a regression: a decision.
  it('ruling 69: Portuguese is not offered in the picker, while its catalogue stays in the tree', () => {
    expect(LOCALE_META['pt-PT']).toBeUndefined()
    expect(Object.keys(LOCALE_META)).toEqual(['en'])
    expect(CATALOGUE_LOCALES).toContain('pt-PT')
  })

  it('writes a day as European Portuguese does (CLDR pt-PT: day/month/year, two-digit month)', () => {
    expect(dayLabel(AT, 'pt-PT')).toBe(
      new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'short', year: 'numeric' }).format(Date.parse(AT))
    )
    expect(dayLabel(AT, 'pt-PT')).toBe('21/10/2026')
    expect(dayLabel(AT, 'pt-PT')).not.toBe(dayLabel(AT, 'en'))
  })

  it('writes a moment with the day first and a 24-hour clock', () => {
    const moment = momentLabel(AT, 'pt-PT') ?? ''

    expect(moment).toMatch(/^21\/10\/2026,? \d{2}:05$/)
  })

  it('formats numbers with a decimal comma', () => {
    expect(new Intl.NumberFormat('pt-PT').format(12345.6).replace(/\s/g, ' ')).toBe('12 345,6')
  })
})
