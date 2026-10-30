/**
 * V3-FX FX-5: the "Step n of 3" badge never overlaps anything in the consent sheet header. It used to sit absolutely
 * in the sheet's top-right corner while the header reserved a fixed 3.5 rem for it at the logical END — too narrow
 * for "Step 2 of 3" and on the wrong side in Arabic (RTL). The badge is now laid out in the header's own flex row,
 * so nothing has to guess a width for it. Layout only (no colour, radius or shadow change).
 *
 * Ruling 69 (owner, 2026-10-25, supersedes 61 and 59's two-language reading): the app ships in ENGLISH ONLY, so the
 * language switcher that used to share this row is no longer drawn (language-switcher.tsx returns null) and a
 * starting pt-PT opens the sheet in English. What is still worth pinning is the layout itself — the badge is in the
 * row, never absolute, with no fixed-width guess left behind — and that an inherited pt-PT reads English.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import { enConsent } from '@/i18n/en'
import { ptPtConsent } from '@/i18n/pt-PT/consent'

import { fakeSetup } from '../setup/fixtures'

import { accepted, fakeConsentBridge } from './fixtures'
import { resetConsentStore } from './store'

import { ConsentSheet } from './index'

afterEach(() => {
  cleanup()
  resetConsentStore()
})

const BADGE = '[data-consent-step-badge]'

async function sheetIn(locale: 'en' | 'pt-PT') {
  fakeConsentBridge(null)

  const { container } = render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <ConsentSheet />
    </I18nProvider>
  )

  const stepName = () => container.querySelector('[data-consent-step]')?.getAttribute('data-consent-step')

  await waitFor(() => expect(stepName()).toBe('terms'))

  return { container, stepName }
}

/** The badge is laid out in the header's own flex row — never absolutely positioned over it, never in the title. */
function expectBadgeInHeaderRow(container: HTMLElement, text: string) {
  const badges = container.querySelectorAll(BADGE)

  expect(badges).toHaveLength(1)

  const badge = badges[0] as HTMLElement
  const row = badge.parentElement as HTMLElement

  expect(badge.textContent).toBe(text)
  expect(badge.className).not.toMatch(/\babsolute\b/)
  expect(row.className).toMatch(/\bflex\b/)
  expect(row.contains(container.querySelector('#consent-title'))).toBe(false)
  // No fixed-width guess left over from the days of an absolutely placed badge.
  expect(container.innerHTML).not.toMatch(/\bme-14\b/)
}

describe('FX-5: the step badge is laid out in the header row, never over it', () => {
  // Ruling 69: both boots read the English bank — a starting pt-PT (an old saved choice, a pt system) opens English.
  for (const locale of ['en', 'pt-PT'] as const) {
    it(`${locale} boot: step 1 and step 2 carry the badge in the header row, in English`, async () => {
      const { container, stepName } = await sheetIn(locale)
      const bank = enConsent

      expectBadgeInHeaderRow(container, bank.sheet.step(1, 2))
      expect(container.textContent).not.toContain(ptPtConsent.sheet.step(1, 2))

      fireEvent.click(container.querySelector('[role="checkbox"]') as HTMLElement)
      await act(async () => {
        fireEvent.click(
          [...container.querySelectorAll('button')].find(b => b.textContent === bank.sheet.continue) as HTMLElement
        )
      })
      await waitFor(() => expect(stepName()).toBe('permissions'))
      expectBadgeInHeaderRow(container, bank.sheet.step(2, 2))
      expect(container.textContent).not.toContain(ptPtConsent.sheet.step(2, 2))
    })
  }

  for (const [locale, bank] of [['en', enConsent]] as const) {
    it(`${locale}: all three steps of a fresh install — terms, Privacy and Set up — carry the badge in the header row`, async () => {
      fakeSetup(null)

      const { container } = render(
        <I18nProvider configClient={null} initialLocale={locale}>
          <ConsentSheet />
        </I18nProvider>
      )

      const stepName = () => container.querySelector('[data-consent-step]')?.getAttribute('data-consent-step')

      await waitFor(() => expect(stepName()).toBe('terms'))
      expectBadgeInHeaderRow(container, bank.sheet.step(1, 3))
      fireEvent.click(container.querySelector('[role="checkbox"]') as HTMLElement)
      await act(async () => {
        fireEvent.click(
          [...container.querySelectorAll('button')].find(b => b.textContent === bank.sheet.continue) as HTMLElement
        )
      })
      await waitFor(() => expect(stepName()).toBe('permissions'))
      expectBadgeInHeaderRow(container, bank.sheet.step(2, 3))
      await act(async () => {
        fireEvent.click(
          [...container.querySelectorAll('button')].find(b => b.textContent === bank.sheet.skip) as HTMLElement
        )
      })
      await waitFor(() => expect(stepName()).toBe('setup'))
      expectBadgeInHeaderRow(container, bank.sheet.step(3, 3))
      // Nothing of the sheet sits absolutely over the header any more.
      expect(container.querySelector('[data-consent-step] > span.absolute')).toBeNull()
    })
  }

  it('a single-step sheet (policy update) shows no badge', async () => {
    fakeConsentBridge(accepted({ policyVersion: '0.9' }))
    const { container } = render(<ConsentSheet />)

    await waitFor(() =>
      expect(container.querySelector('[data-consent-step]')?.getAttribute('data-consent-step')).toBe('terms')
    )
    expect(container.querySelector(BADGE)).toBeNull()
  })
})
