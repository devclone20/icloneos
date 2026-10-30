/**
 * JM-r2-1: the payments pane reads its words from the provider's catalogue (the boot bundle keeps English only; every
 * other catalogue arrives as its own chunk through K99's loader). This file unmocks the test environment's preloading
 * loader (vitest.setup.ts) and imports FRESH modules, so it sees the app's real async path.
 *
 * Ruling 69 (owner, 2026-10-25, supersedes 61): the app ships in ENGLISH ONLY. The first row below therefore pins the
 * NEW rule — a pushed pt-PT (as `initialLocale`, and again through `setLocale`) is clamped, the pane stays English and
 * no other catalogue's chunk is ever fetched — while the pt-PT row keeps its teeth by FORCING the catalogue
 * (`vi.mock('@/i18n')`, the repo's idiom) rather than selecting a language, since its point is the words and the
 * numbers, not the picker. A language comes back in G-31.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as I18nModule from '@/i18n'
import { payments as ar } from '@/i18n/ar/payments'
import { payments as en } from '@/i18n/en/payments'
import { payments as ja } from '@/i18n/ja/payments'
import { ptPt as ptPtCatalogue } from '@/i18n/pt-PT'
import { payments as ptPt } from '@/i18n/pt-PT/payments'
import type { Locale, Translations } from '@/i18n/types'
import type { PaymentsTranslations } from '@/i18n/types/payments'
import { payments as zhHant } from '@/i18n/zh-hant/payments'
import { payments as zh } from '@/i18n/zh/payments'
import type { PaymentsBridge, PaymentsSettingsView, PaymentsStatusView } from '@/iclone-shared/payments'

import { momentText, usdcLabel } from './payments-format'

// The real loader, not the test environment's preloading one.
vi.unmock('@/i18n/locale-loader')

/** The catalogue a row forces. Left null, `useI18n` is the REAL hook, so the clamp row sees the real provider. */
let shown: { locale: Locale; t: Translations } | null = null

vi.mock('@/i18n', async importOriginal => {
  const actual = await importOriginal<typeof I18nModule>()

  return {
    ...actual,
    useI18n: () => {
      const live = actual.useI18n()

      return shown === null ? live : { ...live, ...shown }
    }
  }
})

const PAYEE = '0x1111111111111111111111111111111111111111'

const SETTINGS: PaymentsSettingsView = {
  signer: 'pocket',
  network: 'eip155:84532',
  mainnetEnabled: false,
  perTxMicros: 1_000_000,
  perDayMicros: 5_000_000,
  perAgentDayMicros: 2_000_000,
  payees: [PAYEE],
  origins: ['https://shop.example'],
  mandateStorage: 'local',
  v1Servers: 'refuse',
  stop: false
}

const STATUS: PaymentsStatusView = {
  schema: 1,
  ready: true,
  reason: null,
  pocket: '0x9999999999999999999999999999999999999999',
  network: 'eip155:84532',
  stopped: false,
  ledgerOk: true,
  todayMicros: 250_000,
  agents: [{ agent: 'agent-a', micros: 250_000 }],
  unprotectedProfiles: []
}

const WORDS: Record<Locale, PaymentsTranslations> = { en, zh, 'zh-hant': zhHant, ja, ar, 'pt-PT': ptPt }

function install(over: Partial<PaymentsBridge> = {}) {
  const bridge = {
    status: vi.fn(async () => STATUS),
    limits: vi.fn(async () => SETTINGS),
    mandates: vi.fn(async () => []),
    setLimits: vi.fn(async (_shown: PaymentsSettingsView, next: PaymentsSettingsView) => ({
      ok: true as const,
      settings: next
    })),
    requestMandate: vi.fn(async () => ({ ok: true as const, jti: 'd'.repeat(32) })),
    revoke: vi.fn(async () => ({ ok: true as const })),
    stop: vi.fn(async () => ({ ok: true as const })),
    onChanged: vi.fn(() => () => undefined),
    ...over
  } satisfies PaymentsBridge

  Object.assign(window, {
    hermesDesktop: { ...(window as { hermesDesktop?: object }).hermesDesktop, payments: bridge }
  })
}

afterEach(() => {
  delete (window as { hermesDesktop?: { payments?: unknown } }).hermesDesktop?.payments
  shown = null
})

const q = (selector: string) => window.document.querySelector(selector)

describe('JM-r2-1 / ruling 69: the payments pane through the locale loader, in the one shipped language', () => {
  // Ruling 69: a pt-PT push is clamped before it reaches the words — mounted as `initialLocale` and pushed again
  // through `setLocale` — so the pane shows English, and no other catalogue's chunk is ever fetched (nothing of the
  // five unshipped catalogues enters the window). Reopening a language is G-31; until then this IS the behaviour.
  it('ruling 69: a pushed pt-PT is clamped — English words, and no other catalogue’s chunk is fetched', async () => {
    vi.resetModules()

    const loader = await import('@/i18n/locale-loader')
    const { I18nProvider, useI18n } = await import('@/i18n')
    const { PaymentsPane } = await import('./payments-pane')

    const unshipped = ['zh', 'zh-hant', 'ja', 'ar', 'pt-PT'] as const

    // Cold: no non-English chunk is in before the pane asks for one.
    for (const locale of unshipped) {
      expect(loader.loadedTranslations(locale)).toBeNull()
    }

    install()

    let switchTo: (locale: Locale) => Promise<void> = async () => undefined
    let live: Locale = 'pt-PT'

    function Switch() {
      const i18n = useI18n()

      switchTo = i18n.setLocale
      live = i18n.locale

      return null
    }

    // A saved or pushed pt-PT — an old choice, an upstream catalogue — opens the English pane.
    render(
      <I18nProvider configClient={null} initialLocale="pt-PT">
        <Switch />
        <PaymentsPane />
      </I18nProvider>
    )

    const expectEnglish = async () =>
      await waitFor(() => {
        expect(q('[data-payments-today]')?.textContent).toBe(
          en.status.todayValue(usdcLabel(250_000, 'en'), usdcLabel(5_000_000, 'en'))
        )
        expect(screen.getByText(en.status.ready)).toBeTruthy()
        expect(screen.getAllByText(en.caps.title).length).toBeGreaterThan(0)
        expect(screen.getByText(en.stop.title)).toBeTruthy()
      })

    await expectEnglish()
    expect(live).toBe('en')
    // The pt-PT words are really different, so the English assertions above are proof and not a coincidence.
    expect(ptPt.caps.title).not.toBe(en.caps.title)
    expect(screen.queryByText(ptPt.caps.title)).toBeNull()

    // Pushing it again, the way an old renderer or an upstream surface would, changes nothing.
    await act(async () => {
      await switchTo('pt-PT')
    })

    await expectEnglish()
    expect(live).toBe('en')
    expect(screen.queryByText(ptPt.caps.title)).toBeNull()

    // Nothing was downloaded for a language the app does not ship.
    for (const locale of unshipped) {
      expect({ locale, chunk: loader.loadedTranslations(locale) }).toEqual({ locale, chunk: null })
    }
  })
})

describe('J4-5: the pane shows no words of main’s and writes numbers and dates the locale’s way', () => {
  const EXPIRES = '2026-11-20T10:00:00.000Z'

  // Ruling 69 (owner, 2026-10-25): the pane can no longer be SELECTED into Portuguese, so the pt-PT catalogue is
  // handed to it directly. The teeth are unchanged: a word of main's, an English refusal line, an en-US decimal
  // point or an ISO timestamp on screen still turns this red.
  it('J4-5: pt-PT — the not-ready reason and a list refusal in pt-PT, a decimal comma, dd/mm/yyyy', async () => {
    vi.resetModules()

    shown = { locale: 'pt-PT', t: ptPtCatalogue }

    const { PaymentsPane } = await import('./payments-pane')

    install({
      status: vi.fn(async () => ({
        ...STATUS,
        ready: false,
        reason: 'sealing_off' as const,
        todayMicros: 1_234_500_000
      })),
      limits: vi.fn(async () => ({ ...SETTINGS, perDayMicros: 2_500_000_000 })),
      mandates: vi.fn(async () => [
        {
          jti: 'c'.repeat(32),
          agent: 'agent-a',
          issuedAt: '2026-10-21T10:00:00.000Z',
          expiresAt: EXPIRES,
          revoked: false,
          budget: '10.00',
          range: { min: '0.01', max: '1.00' },
          payees: [PAYEE]
        }
      ]),
      setLimits: vi.fn(async () => ({
        ok: false as const,
        reason: 'allowlist' as const,
        problems: [
          { list: 'origins' as const, kind: 'entries' as const, count: 3, entries: ['"https://x.example/"'], more: 2 },
          { list: 'payees' as const, kind: 'too_many' as const, count: 51, entries: [], more: 0 }
        ]
      }))
    })

    render(<PaymentsPane />)

    await waitFor(() => expect(screen.getByText(ptPt.status.notReady.sealing_off)).toBeTruthy())

    const today = q('[data-payments-today]')?.textContent ?? ''
    const terms = ptPt.mandates.terms(usdcLabel(10_000_000, 'pt-PT'), momentText(EXPIRES, 'pt-PT'))

    // CLDR pt-PT groups from five digits on (minimumGroupingDigits 2): a decimal comma, no point.
    expect(today).toBe('1234,50 de 2500,00 USDC')
    expect(screen.getByText(terms)).toBeTruthy()
    expect(momentText(EXPIRES, 'pt-PT')).toMatch(/^20\/11\/2026,? \d{2}:\d{2}$/)
    expect(terms).not.toContain(EXPIRES)
    expect(window.document.body.textContent).not.toContain('Keychain setting off')
    expect(window.document.body.textContent).not.toContain('2026-11-20T')

    fireEvent.change(q('[data-payments-add-input="origins"]')!, { target: { value: 'https://api.example' } })
    await act(async () => {
      fireEvent.click(q('[data-payments-add="origins"]')!)
    })

    await waitFor(() =>
      expect(q('[data-payments-feedback="refused"]')?.textContent).toBe(
        [
          ptPt.refusals.allowlist,
          ptPt.allowlist.problems.entries(ptPt.allowlist.origins, '"https://x.example/"', 2),
          ptPt.allowlist.problems.tooMany(ptPt.allowlist.payees, 51, 50)
        ].join(' ')
      )
    )
    expect(q('[data-payments-feedback="refused"]')?.textContent).not.toMatch(/ more\)|entries, at most/)
  })

  it('J4-5: every locale words each not-ready code and each list problem in its own language', () => {
    for (const locale of ['zh', 'zh-hant', 'ja', 'ar', 'pt-PT'] as const) {
      const words = WORDS[locale]

      for (const code of ['sealing_off', 'keys_unavailable', 'disabled', 'socket_down'] as const) {
        expect({ locale, code, same: words.status.notReady[code] === en.status.notReady[code] }).toEqual({
          locale,
          code,
          same: false
        })
      }

      expect(words.allowlist.problems.notList('L')).not.toBe(en.allowlist.problems.notList('L'))
      expect(words.allowlist.problems.tooMany('L', 51, 50)).not.toBe(en.allowlist.problems.tooMany('L', 51, 50))
      expect(words.allowlist.problems.entries('L', '"e"', 2)).toContain('"e"')
      expect(words.allowlist.problems.entries('L', '"e"', 2)).not.toBe(en.allowlist.problems.entries('L', '"e"', 2))
    }
  })
})
