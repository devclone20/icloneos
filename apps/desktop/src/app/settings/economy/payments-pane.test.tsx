import fs from 'node:fs'
import path from 'node:path'

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConsentDoorSheet } from '@/components/consent/door-sheet'
import { accepted, fakeConsentBridge } from '@/components/consent/fixtures'
import { resetConsentStore } from '@/components/consent/store'
import { TRANSLATIONS } from '@/i18n/catalog'
import { ownWords } from '@/i18n/define-locale'
import { enPermissions } from '@/i18n/en/enPermissions'
import { payments as en } from '@/i18n/en/payments'
import { CATALOGUE_LOCALES } from '@/i18n/languages'
import type { Locale } from '@/i18n/types'
import type { PaymentsTranslations } from '@/i18n/types/payments'
import {
  formatUsdc,
  mandateDoorTarget,
  parseUsdc,
  type PaymentsBridge,
  type PaymentsSettingsView,
  type PaymentsStatusView,
  settingsDoorTarget,
  sheetText,
  spendDoorTarget
} from '@/iclone-shared/payments'
import { paymentsSheetCopy, SHEET_LOCALES } from '@/iclone-shared/payments-sheet-copy'
import { $payments } from '@/store/payments'

import { momentText } from './payments-format'
import { PaymentsPane } from './payments-pane'

const PAYEE = '0x1111111111111111111111111111111111111111'
const JTI = 'c'.repeat(32)

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

function install(over: Partial<PaymentsBridge> = {}) {
  const bridge = {
    status: vi.fn(async () => STATUS),
    limits: vi.fn(async () => SETTINGS),
    mandates: vi.fn(async () => [
      {
        jti: JTI,
        agent: 'agent-a',
        issuedAt: '2026-10-21T10:00:00.000Z',
        expiresAt: '2026-10-21T11:00:00.000Z',
        revoked: false,
        budget: '2.00',
        range: { min: '0.01', max: '1.00' },
        payees: [PAYEE]
      }
    ]),
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

  return bridge
}

afterEach(() => {
  delete (window as { hermesDesktop?: { payments?: unknown } }).hermesDesktop?.payments
  $payments.set({ status: 'loading', state: null, settings: null, mandates: [] })
  resetConsentStore()
})

const q = (selector: string) => window.document.querySelector(selector)

async function shown() {
  render(<PaymentsPane />)
  await waitFor(() => expect(q('[data-payments-today]')).toBeTruthy())
}

describe('wire-pane: Settings › Economy › Payments', () => {
  it('wire-pane: shows status, today against the daily cap, the three caps in USDC, stop, both lists and the mandates', async () => {
    install()
    await shown()

    expect(screen.getByText(en.status.ready)).toBeTruthy()
    expect(q('[data-payments-today]')?.textContent).toBe(en.status.todayValue('0.25', '5.00'))
    expect((q('[data-payments-cap="perTxMicros"]') as HTMLInputElement).value).toBe('1.00')
    expect((q('[data-payments-cap="perDayMicros"]') as HTMLInputElement).value).toBe('5.00')
    expect((q('[data-payments-cap="perAgentDayMicros"]') as HTMLInputElement).value).toBe('2.00')
    expect(q('[data-payments-stop]')?.getAttribute('aria-checked')).toBe('false')
    // The payee shows in the allowlist, as a choice for a new mandate and in that mandate's review.
    expect(screen.getAllByText(PAYEE)).toHaveLength(3)
    expect(screen.getByText('https://shop.example')).toBeTruthy()
    // The signed mandate's row, and the new mandate's review (it starts for the agent that spent today).
    expect(screen.getAllByText(en.mandates.forAgent('agent-a'))).toHaveLength(2)
    expect(screen.getByText(en.mandates.terms('2.00', momentText('2026-10-21T11:00:00.000Z', 'en')))).toBeTruthy()
  })

  it('wire-pane: Save sends what the form was filled against and the edit, inside the click; main’s answer is shown', async () => {
    const bridge = install()

    await shown()
    fireEvent.change(q('[data-payments-cap="perTxMicros"]')!, { target: { value: '0.5' } })
    await act(async () => {
      fireEvent.click(q('[data-payments-save]')!)
    })

    expect(bridge.setLimits).toHaveBeenCalledTimes(1)
    expect(bridge.setLimits).toHaveBeenCalledWith(SETTINGS, { ...SETTINGS, perTxMicros: 500_000 })
    await waitFor(() => expect(q('[data-payments-feedback="ok"]')?.textContent).toBe(en.saved))
  })

  it('wire-pane: a malformed amount is never sent; a refusal from main is said in words', async () => {
    const bridge = install({ setLimits: vi.fn(async () => ({ ok: false as const, reason: 'door_denied' as const })) })

    await shown()
    fireEvent.change(q('[data-payments-cap="perDayMicros"]')!, { target: { value: '1e3' } })
    fireEvent.click(q('[data-payments-save]')!)
    expect(bridge.setLimits).not.toHaveBeenCalled()
    expect(screen.getByText(en.caps.invalid)).toBeTruthy()

    fireEvent.change(q('[data-payments-cap="perDayMicros"]')!, { target: { value: '9' } })
    await act(async () => {
      fireEvent.click(q('[data-payments-save]')!)
    })
    await waitFor(() => expect(q('[data-payments-feedback="refused"]')?.textContent).toBe(en.refusals.door_denied))
  })

  it('wire-pane: add and remove a payee and a site; a non-address is refused in the pane', async () => {
    const bridge = install()

    await shown()
    fireEvent.change(q('[data-payments-add-input="payees"]')!, { target: { value: '0x12' } })
    fireEvent.click(q('[data-payments-add="payees"]')!)
    expect(screen.getByText(en.allowlist.invalidPayee)).toBeTruthy()

    const upper = `0x${'AB'.repeat(20)}`

    fireEvent.change(q('[data-payments-add-input="payees"]')!, { target: { value: upper } })
    await act(async () => {
      fireEvent.click(q('[data-payments-add="payees"]')!)
    })
    expect(bridge.setLimits).toHaveBeenLastCalledWith(SETTINGS, { ...SETTINGS, payees: [PAYEE, upper.toLowerCase()] })

    fireEvent.change(q('[data-payments-add-input="origins"]')!, { target: { value: 'https://api.example/path?x=1' } })
    await act(async () => {
      fireEvent.click(q('[data-payments-add="origins"]')!)
    })
    expect(bridge.setLimits).toHaveBeenLastCalledWith(SETTINGS, {
      ...SETTINGS,
      origins: ['https://shop.example', 'https://api.example']
    })

    await act(async () => {
      fireEvent.click(q('[data-payments-remove="payees"]')!)
    })
    expect(bridge.setLimits).toHaveBeenLastCalledWith(SETTINGS, { ...SETTINGS, payees: [] })
  })

  it('Jm1: a full list or a repeat is stopped in the pane; a refusal from main shows the reason and the named entries', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`)

    const bridge = install({
      limits: vi.fn(async () => ({ ...SETTINGS, payees: fifty })),
      setLimits: vi.fn(async () => ({
        ok: false as const,
        reason: 'allowlist' as const,
        problems: [
          { list: 'origins' as const, kind: 'entries' as const, count: 2, entries: ['"https://x.example/"'], more: 0 }
        ]
      }))
    })

    await shown()
    fireEvent.change(q('[data-payments-add-input="payees"]')!, { target: { value: `0x${'ab'.repeat(20)}` } })
    fireEvent.click(q('[data-payments-add="payees"]')!)
    expect(screen.getByText(en.allowlist.full(50))).toBeTruthy()
    fireEvent.change(q('[data-payments-add-input="payees"]')!, {
      target: { value: fifty[3].toUpperCase().replace('0X', '0x') }
    })
    fireEvent.click(q('[data-payments-add="payees"]')!)
    expect(screen.getByText(en.allowlist.listed)).toBeTruthy()
    expect(bridge.setLimits).not.toHaveBeenCalled()

    fireEvent.change(q('[data-payments-add-input="origins"]')!, { target: { value: 'https://api.example' } })
    await act(async () => {
      fireEvent.click(q('[data-payments-add="origins"]')!)
    })
    await waitFor(() =>
      expect(q('[data-payments-feedback="refused"]')?.textContent).toBe(
        `${en.refusals.allowlist} ${en.allowlist.problems.entries(en.allowlist.origins, '"https://x.example/"', 0)}`
      )
    )
  })

  it('wire-pane: the stop switch and revoke call main; every control that writes carries the click lock', async () => {
    const bridge = install()

    await shown()
    await act(async () => {
      fireEvent.click(q('[data-payments-stop]')!)
    })
    expect(bridge.stop).toHaveBeenCalledWith(true)
    await act(async () => {
      fireEvent.click(q(`[data-payments-revoke="${JTI}"]`)!)
    })
    expect(bridge.revoke).toHaveBeenCalledWith(JTI)

    const writers = window.document.querySelectorAll(
      '[data-payments-save], [data-payments-add], [data-payments-remove], [data-payments-revoke], [data-payments-stop], [data-payments-sign-mandate]'
    )

    // save, add ×2, remove ×2 (one payee, one site), revoke, stop, sign a mandate
    expect(writers.length).toBe(8)

    for (const control of writers) {
      expect(control.closest('[data-payments-confirm]')).toBeTruthy()
    }
  })

  it('wire-pane: the web build (no bridge) says payments are a desktop feature', async () => {
    render(<PaymentsPane />)
    await waitFor(() => expect(screen.getByText(en.desktopOnly)).toBeTruthy())
  })

  it('wire-pane: S24 — the pane adds no colour, radius, shadow or border of its own', () => {
    const source = fs.readFileSync(path.join(__dirname, 'payments-pane.tsx'), 'utf8')
    const classes = [...source.matchAll(/className="([^"]*)"/g)].map(match => match[1]).join(' ')

    expect(classes).not.toMatch(/\b(bg-|rounded|shadow|border|ring-|text-\[#|text-\(--e-|from-|to-)/)
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|style=\{/)
  })

  it('wire-pane: USDC words round-trip, and malformed amounts are refused', () => {
    expect([formatUsdc(1_000_000), formatUsdc(500_000), formatUsdc(1), formatUsdc(0)]).toEqual([
      '1.00',
      '0.50',
      '0.000001',
      '0.00'
    ])

    for (const text of ['1', '1.5', '0.000001', '999999999.999999']) {
      expect(formatUsdc(parseUsdc(text)!)).toBe(formatUsdc(parseUsdc(formatUsdc(parseUsdc(text)!))!))
    }

    for (const bad of ['', '-1', '1e3', '1.0000001', '0x10', '01', 'Infinity', ' . ']) {
      expect(parseUsdc(bad)).toBeNull()
    }
  })
})

describe('mandate-issue: a new mandate from the pane', () => {
  const OTHER = '0x2222222222222222222222222222222222222222'
  const field = (name: string) => q(`[data-payments-mandate-field="${name}"]`) as HTMLInputElement

  afterEach(() => vi.useRealTimers())

  it('mandate-issue: starts from the caps and the allowlist, and the review says every term in plain words, every payee in full', async () => {
    install({ limits: vi.fn(async () => ({ ...SETTINGS, payees: [PAYEE, OTHER] })) })
    await shown()

    expect(field('agent').value).toBe('agent-a')
    expect(field('budget').value).toBe('2.00')
    expect(field('min').value).toBe('0.000001')
    expect(field('max').value).toBe('1.00')
    expect(q(`[data-payments-mandate-payee="${PAYEE}"]`)?.getAttribute('aria-checked')).toBe('true')
    expect(q(`[data-payments-mandate-payee="${OTHER}"]`)?.getAttribute('aria-checked')).toBe('true')

    const start = Date.parse(new Date(field('notBefore').value).toISOString())
    const end = Date.parse(new Date(field('expiresAt').value).toISOString())

    expect(end - start).toBe(86_400_000)

    const review = q('[data-payments-mandate-review]')?.textContent ?? ''

    for (const words of [
      en.issue.summary.agent('agent-a'),
      en.issue.summary.budget('2.00'),
      en.issue.summary.range('0.000001', '1.00'),
      en.issue.summary.payees(2),
      PAYEE,
      OTHER,
      en.issue.summary.caps('1.00', '5.00', '2.00')
    ]) {
      expect(review).toContain(words)
    }

    expect(review).not.toContain('…')
  })

  it('mandate-issue: Sign sends the checked terms inside the click, and main’s answer is said', async () => {
    const bridge = install()

    await shown()
    fireEvent.change(field('budget'), { target: { value: '0.5' } })
    fireEvent.change(field('max'), { target: { value: '0.25' } })
    await act(async () => {
      fireEvent.click(q('[data-payments-sign-mandate]')!)
    })

    expect(bridge.requestMandate).toHaveBeenCalledTimes(1)
    expect(bridge.requestMandate).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'agent-a', budget: '0.50', min: '0.000001', max: '0.25', payees: [PAYEE] })
    )
    expect(q('[data-payments-sign-mandate]')?.closest('[data-payments-confirm]')).toBeTruthy()
    await waitFor(() => expect(q('[data-payments-feedback="ok"]')?.textContent).toBe(en.issue.signed))
    // Signed: the form returns to the caps' defaults.
    expect(field('budget').value).toBe('2.00')
  })

  it('mandate-issue: bad terms are never sent and are said in words; a refusal from main is said too', async () => {
    const bridge = install({
      requestMandate: vi.fn(async () => ({ ok: false as const, reason: 'door_denied' as const }))
    })

    await shown()

    const tries: [string, string, keyof typeof en.issue.problems][] = [
      ['agent', 'Agent A', 'agent'],
      ['max', '3', 'amount'],
      ['min', '0', 'amount']
    ]

    for (const [name, value, problem] of tries) {
      const before = field(name).value

      fireEvent.change(field(name), { target: { value } })
      fireEvent.click(q('[data-payments-sign-mandate]')!)
      expect(screen.getByText(en.issue.problems[problem])).toBeTruthy()
      fireEvent.change(field(name), { target: { value: before } })
    }

    fireEvent.click(q(`[data-payments-mandate-payee="${PAYEE}"]`)!)
    fireEvent.click(q('[data-payments-sign-mandate]')!)
    expect(screen.getByText(en.issue.problems.payees)).toBeTruthy()
    fireEvent.click(q(`[data-payments-mandate-payee="${PAYEE}"]`)!)

    fireEvent.change(field('notAfter'), { target: { value: '2001-01-01T00:00' } })
    fireEvent.click(q('[data-payments-sign-mandate]')!)
    expect(screen.getByText(en.issue.problems.dates)).toBeTruthy()
    expect(bridge.requestMandate).not.toHaveBeenCalled()
  })

  it('mandate-issue: with no payee on the allowlist the pane says to add one; not ready ⇒ Sign is off', async () => {
    install({
      limits: vi.fn(async () => ({ ...SETTINGS, payees: [] })),
      status: vi.fn(async () => ({ ...STATUS, ready: false, reason: 'sealing_off' as const }))
    })
    await shown()

    expect(screen.getByText(en.issue.noPayees)).toBeTruthy()
    expect((q('[data-payments-sign-mandate]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('wire-pane: the payments words in every locale', () => {
  it('wire-pane: the catalogue’s payments domain is English’s own bank', () => {
    expect(TRANSLATIONS.en.payments).toBe(en)
  })

  type Leaf = ((...args: never[]) => string) | string

  const leaves = (node: object, prefix = ''): Map<string, Leaf> => {
    const out = new Map<string, Leaf>()

    for (const [key, value] of Object.entries(node)) {
      const at = prefix ? `${prefix}.${key}` : key

      if (typeof value === 'object' && value !== null) {
        for (const [inner, leaf] of leaves(value as object, at)) {
          out.set(inner, leaf)
        }
      } else {
        out.set(at, value as Leaf)
      }
    }

    return out
  }

  const render2 = (leaf: Leaf) => (typeof leaf === 'string' ? leaf : (leaf as (...a: unknown[]) => string)('1.00', 'X'))
  const english = leaves(en)
  const locales = Object.keys(TRANSLATIONS) as Locale[]
  // The locale's OWN payments words (the catalogue's domain before the English fallback is merged in).
  const own = (locale: Locale) => ownWords(TRANSLATIONS[locale]).payments as PaymentsTranslations

  it('wire-pane: one catalogue per app locale, pt-PT included', () => {
    expect([...locales].sort()).toEqual([...CATALOGUE_LOCALES].sort())
  })

  it.each(locales.filter(locale => locale !== 'en'))(
    'wire-pane: %s has the same keys, kinds, and its own words',
    locale => {
      const theirs = leaves(own(locale))

      expect([...theirs.keys()].sort()).toEqual([...english.keys()].sort())

      for (const [key, leaf] of english) {
        const mine = theirs.get(key) as Leaf

        expect({ key, kind: typeof mine }).toEqual({ key, kind: typeof leaf })
        expect({ key, empty: render2(mine).trim() === '' }).toEqual({ key, empty: false })

        if (render2(leaf).length > 12) {
          expect({ key, same: render2(mine) === render2(leaf) }).toEqual({ key, same: false })
        }
      }
    }
  )
})

describe('J6: the mandate is on the sheet before the signature', () => {
  // Twelve payees: the target is far past the 160-character preview other classes get.
  const payees = [
    PAYEE,
    ...Array.from(
      { length: 11 },
      (_, i) =>
        `0x${String(i + 2)
          .repeat(40)
          .slice(0, 40)}`
    )
  ]

  const facts = {
    agent: 'agent-a',
    resource: 'https://shop.example/paid/one',
    payTo: PAYEE,
    micros: 100_000,
    network: 'eip155:84532',
    networkLabel: 'Base Sepolia',
    mandate: {
      jti: JTI,
      expiresAt: '2026-10-21T11:00:00.000Z',
      payees,
      budget: '2.00',
      budgetLeft: '1.40',
      range: { min: '0.01', max: '1.00' }
    }
  }

  const ask = (target: string, cls: '$' | 'X' = '$') => ({
    id: 'perm-pay',
    key: 'spendTrade' as const,
    reason: 'An x402 payment, under the mandate below',
    inft: 'agent-a',
    at: '2026-10-21T10:00:00.000Z',
    expiresAt: '2026-10-21T10:02:00.000Z',
    permission: {
      cls,
      tool: 'x402-pay',
      target,
      mode: 'manual' as const,
      project: null,
      session: null,
      subagent: null,
      scopes: ['once' as const]
    }
  })

  it('J6: the real door sheet renders the whole $ target unclipped: amount, payee list, budget left, range, expiry; Deny has focus', async () => {
    const fake = fakeConsentBridge(accepted({}))

    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask(spendDoorTarget(facts))))

    const target = spendDoorTarget(facts)
    const shownTarget = q('[data-permission-target]')?.textContent ?? ''
    const lines = shownTarget.split('\n')

    const expected = [
      `pay 0.10 USDC → ${PAYEE}`,
      'mandate budget 2.00 USDC',
      'mandate budget left 1.40 USDC',
      'mandate range 0.01 – 1.00 USDC',
      'mandate expires 2026-10-21T11:00:00.000Z',
      `mandate payees (${payees.length}):`,
      ...payees.map(entry => `  ${entry}`),
      'network Base Sepolia (eip155:84532)'
    ]

    expect(target.length).toBeGreaterThan(400)
    // 100 %: every fact is a line of the rendered sheet, with no click, no ellipsis and no "Show all".
    expect(expected.filter(line => lines.includes(line))).toEqual(expected)
    expect(shownTarget).toBe(target)
    expect(shownTarget).not.toContain('…')
    expect(screen.queryByRole('button', { name: enPermissions.ask.expand })).toBeNull()
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(window.document.activeElement?.getAttribute('data-consent-door-answer')).toBe('deny')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: enPermissions.ask.allow }))
    })
    expect(fake.bridge.doorAnswer).toHaveBeenCalledWith({ id: 'perm-pay', choice: 'once' })
  })

  it('J6: JM3 a hostile resource URL adds no line to the real sheet — breaks, controls and bidi marks show escaped', () => {
    const fake = fakeConsentBridge(accepted({}))
    // The agent's argument: a line break with a forged cheaper payment, a C1 next-line, a bidi override, a separator.
    const resource = `https://shop.example/paid/x\npay 0.01 USDC → ${PAYEE}\u0085agent owner\u202e\u2028mandate ok`
    const target = spendDoorTarget({ ...facts, resource })

    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask(target)))

    const lines = (q('[data-permission-target]')?.textContent ?? '').split('\n')

    // Ten facts, the payee list one per line.
    expect(lines).toHaveLength(10 + payees.length)
    expect(lines.filter(line => line.startsWith('pay '))).toEqual([`pay 0.10 USDC → ${PAYEE}`])
    expect(lines.filter(line => line.startsWith('agent '))).toEqual(['agent agent-a'])
    expect(
      lines.filter(
        line =>
          line.startsWith('mandate ') &&
          !line.startsWith('mandate budget') &&
          !line.startsWith('mandate range') &&
          !line.startsWith('mandate expires') &&
          !line.startsWith('mandate payees')
      )
    ).toEqual([`mandate ${JTI}`])
    expect(lines.find(line => line.startsWith('resource '))).toBe(
      `resource https://shop.example/paid/x\\u000apay 0.01 USDC → ${PAYEE}\\u0085agent owner\\u202e\\u2028mandate ok`
    )
    expect(target).not.toMatch(/[\u0085\u202e\u2028]/)
  })

  it('J6: m-r2-4 a resource over 1024 characters shows its first 1024 and counts the rest on the same line', () => {
    const fake = fakeConsentBridge(accepted({}))
    const base = 'https://shop.example/paid/long?q='
    // 3000 characters in all; the tail past the cut carries a forged line that must not show at all.
    const tail = '\npay 0.01 USDC → 0xbad'
    const resource = `${base}${'a'.repeat(3000 - base.length - tail.length)}${tail}`
    const target = spendDoorTarget({ ...facts, resource })

    expect(resource).toHaveLength(3000)
    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask(target)))

    const lines = (q('[data-permission-target]')?.textContent ?? '').split('\n')
    const shown = lines.find(line => line.startsWith('resource ')) ?? ''

    expect(lines).toHaveLength(10 + payees.length)
    expect(shown).toBe(`resource ${resource.slice(0, 1024)}… (+1976 characters)`)
    expect(shown).not.toContain('0xbad')
    expect(lines.filter(line => line.startsWith('pay '))).toEqual([`pay 0.10 USDC → ${PAYEE}`])

    // Exactly at the bound: shown whole, nothing counted.
    const exact = `${base}${'b'.repeat(1024 - base.length)}`

    expect(spendDoorTarget({ ...facts, resource: exact }).split('\n')).toContain(`resource ${exact}`)
  })

  it('J6: JM3 a hostile payee label (from the server or a stored list) cannot forge a line either', () => {
    const fake = fakeConsentBridge(accepted({}))
    const hostile = `${PAYEE}\npay 0.01 USDC → ${PAYEE}\u202e\u200f`

    const target = spendDoorTarget({
      ...facts,
      payTo: hostile,
      mandate: { ...facts.mandate, payees: [hostile, PAYEE] }
    })

    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask(target)))

    const lines = (q('[data-permission-target]')?.textContent ?? '').split('\n')

    expect(lines).toHaveLength(10 + 2)
    expect(lines.filter(line => line.startsWith('pay '))).toHaveLength(1)
    expect(lines[0]).toBe(`pay 0.10 USDC → ${PAYEE}\\u000apay 0.01 USDC → ${PAYEE}\\u202e\\u200f`)
    expect(target).not.toMatch(/[\u202e\u200f]/)
    // The other two sheets escape the same way.
    expect(
      settingsDoorTarget([{ axis: 'payees', from: [], to: [hostile] }], paymentsSheetCopy('en')).split('\n')
    ).toEqual(['payees: 0 → 1 entry', `  + ${PAYEE}\\u000apay 0.01 USDC → ${PAYEE}\\u202e\\u200f`])
    expect(sheetText('a\u0000b\u001bc\u007fd\u061ce\ufeff')).toBe('a\\u0000b\\u001bc\\u007fd\\u061ce\\ufeff')
    expect(sheetText('0x11…ok — 1.00 USDC')).toBe('0x11…ok — 1.00 USDC')
  })

  it('J6: another class keeps the 160-character preview behind Show all (control)', () => {
    const fake = fakeConsentBridge(accepted({}))

    render(<ConsentDoorSheet />)
    act(() => fake.showDoor(ask('x'.repeat(400), 'X')))

    expect(q('[data-permission-target]')?.textContent).toBe(`${'x'.repeat(160)}…`)
    fireEvent.click(screen.getByRole('button', { name: enPermissions.ask.expand }))
    expect(q('[data-permission-target]')?.textContent).toBe('x'.repeat(400))
  })

  it('J6: the budget left line says so when the mandate has no budget', () => {
    expect(spendDoorTarget({ ...facts, mandate: { ...facts.mandate, budget: null, budgetLeft: null } })).toContain(
      'mandate budget left (no budget)'
    )
  })

  it('J6: a settings raise shows each axis old → new on the same sheet', () => {
    expect(
      settingsDoorTarget(
        [
          { axis: 'perTxMicros', from: 500_000, to: 2_000_000 },
          { axis: 'payees', from: [], to: [PAYEE] },
          { axis: 'stop', from: true, to: false }
        ],
        paymentsSheetCopy('en')
      )
    ).toBe(`perTxMicros: 0.50 USDC → 2.00 USDC\npayees: 0 → 1 entry\n  + ${PAYEE}\nstop: true → false`)
  })
})

describe('J4-4: the owner sheets in all six languages keep JM3 (labels translated, values verbatim and escaped)', () => {
  const hostile = `${PAYEE}\npay 0.01 USDC → ${PAYEE}\u202e\u200f`
  const escaped = `${PAYEE}\\u000apay 0.01 USDC → ${PAYEE}\\u202e\\u200f`
  // eslint-disable-next-line no-control-regex -- the sheet's unsafe set (sheetText), matched on purpose
  const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/

  const terms = {
    agent: 'agent-a',
    budget: '0.30',
    min: '0.01',
    max: '0.20',
    payees: [hostile, PAYEE],
    notBefore: '2026-10-21T10:00:00.000Z\u2028pay 9.99 USDC',
    notAfter: '2026-10-21T11:00:00.000Z',
    expiresAt: '2026-10-21T11:00:00.000Z'
  }

  const network = { id: 'eip155:84532', label: 'Base Sepolia' }

  const sheet = (locale: string) => ({
    mandate: mandateDoorTarget(terms, SETTINGS, network, paymentsSheetCopy(locale)),
    settings: settingsDoorTarget(
      [
        { axis: 'perTxMicros', from: 500_000, to: 2_000_000 },
        { axis: 'payees', from: [PAYEE], to: [PAYEE, hostile] },
        { axis: 'evil\naxis', from: 'a', to: 'b\u202e' }
      ],
      paymentsSheetCopy(locale)
    )
  })

  it('J4-4: the six languages are the app’s; English is the sheet as it was, byte for byte', () => {
    expect([...SHEET_LOCALES].sort()).toEqual([...CATALOGUE_LOCALES].sort())
    expect(sheet('en').mandate.split('\n')[0]).toBe('sign an open payment mandate for agent agent-a')
    expect(sheet('en').settings.split('\n')[0]).toBe('perTxMicros: 0.50 USDC → 2.00 USDC')
    expect(sheet('nope')).toEqual(sheet('en'))
  })

  for (const locale of SHEET_LOCALES) {
    it(`J4-4: ${locale} — same lines as English, every value verbatim, nothing forged, no raw control (real sheet DOM)`, () => {
      const words = sheet(locale)
      const english = sheet('en')

      for (const kind of ['mandate', 'settings'] as const) {
        const fake = fakeConsentBridge(accepted({}))
        const { unmount } = render(<ConsentDoorSheet />)

        act(() =>
          fake.showDoor({
            id: `perm-${kind}`,
            key: 'spendTrade' as const,
            reason: 'r',
            inft: 'owner',
            at: '2026-10-21T10:00:00.000Z',
            expiresAt: '2026-10-21T10:02:00.000Z',
            permission: {
              cls: '$' as const,
              tool: `payments.${kind}`,
              target: words[kind],
              mode: 'manual' as const,
              project: null,
              session: null,
              subagent: null,
              scopes: ['once' as const]
            }
          })
        )

        const lines = (q('[data-permission-target]')?.textContent ?? '').split('\n')

        expect(lines).toEqual(words[kind].split('\n'))
        expect(lines).toHaveLength(english[kind].split('\n').length)
        expect(lines.some(line => UNSAFE.test(line))).toBe(false)
        expect(lines.filter(line => line.startsWith('pay '))).toEqual([])
        unmount()
      }

      const mandate = words.mandate.split('\n')

      expect(mandate).toContain(`  ${escaped}`)
      expect(mandate).toContain(`  ${PAYEE}`)
      expect(words.mandate).toContain('2026-10-21T10:00:00.000Z\\u2028pay 9.99 USDC')
      expect(words.mandate).toContain('eip155:84532')

      const settings = words.settings.split('\n')

      expect(settings).toContain(`  + ${escaped}`)
      expect(settings.filter(line => line.startsWith('  + '))).toHaveLength(1)
      expect(settings.some(line => line.includes('evil\\u000aaxis') && line.includes('b\\u202e'))).toBe(true)
      expect(words.settings).toContain(locale === 'ar' ? '0.50 USDC ← 2.00 USDC' : '0.50 USDC → 2.00 USDC')

      if (locale !== 'en') {
        expect(words.mandate).not.toBe(english.mandate)
        expect(words.settings).not.toBe(english.settings)
      }
    })
  }

  it('m-r4-5: the sheet language is one of the six by exact value; an inherited object key is English, never a crash', () => {
    for (const odd of [
      'toString',
      'constructor',
      '__proto__',
      'hasOwnProperty',
      'valueOf',
      'EN',
      'pt',
      'ar ',
      '',
      7,
      null
    ]) {
      expect(paymentsSheetCopy(odd)).toBe(paymentsSheetCopy('en'))
    }

    for (const locale of SHEET_LOCALES) {
      expect(paymentsSheetCopy(locale).settings.change('X', 'A', 'B')).toContain('A')
    }

    expect(paymentsSheetCopy('ar')).not.toBe(paymentsSheetCopy('en'))
  })

  it('m-r4-3: a widening or a cleared stop reads old → new in every language; Arabic, right to left, as A ← B (V3-T3)', () => {
    const arrows: Record<string, string> = {}

    for (const locale of SHEET_LOCALES) {
      const { settings } = paymentsSheetCopy(locale)

      // The values keep their order (old first, new second) in every language; only the arrow follows the reading.
      expect(settings.change('X', '1.00', '2.00').indexOf('1.00')).toBeLessThan(
        settings.change('X', '1.00', '2.00').indexOf('2.00')
      )
      expect(settings.listChange('X', 1, 2).indexOf('1')).toBeLessThan(settings.listChange('X', 1, 2).indexOf('2'))
      arrows[locale] = settings.change('X', 'A', 'B').replace(/^X[:：] ?/, '')
    }

    expect(arrows).toEqual({ en: 'A → B', zh: 'A → B', 'zh-hant': 'A → B', ja: 'A → B', 'pt-PT': 'A → B', ar: 'A ← B' })
    expect(paymentsSheetCopy('ar').settings.listChange('X', 1, 2)).toBe('X: 1 ← 2 إدخالات')
    expect(paymentsSheetCopy('ar').settings.listChange('X', 2, 1)).toBe('X: 2 ← 1 إدخال')
    expect(paymentsSheetCopy('en').settings.listChange('X', 1, 2)).toBe('X: 1 → 2 entries')
  })

  it('J4-4: no label in any language holds a line break, a control or a bidi / invisible mark', () => {
    for (const locale of SHEET_LOCALES) {
      const copy = paymentsSheetCopy(locale)

      const labels = [
        copy.mandate.signFor('A'),
        copy.mandate.budget('B'),
        copy.mandate.range('C', 'D'),
        copy.mandate.payees(1),
        copy.mandate.payees(3),
        copy.mandate.window('E', 'F'),
        copy.mandate.expires('G'),
        copy.mandate.caps('H', 'I', 'J'),
        copy.mandate.network('K', 'L'),
        copy.mandate.revoke,
        ...Object.values(copy.settings.axes),
        copy.settings.change('M', 'N', 'O'),
        copy.settings.listChange('P', 1, 1),
        copy.settings.listChange('P', 1, 2),
        copy.reasons.mandate('Q'),
        copy.reasons.settings,
        copy.reasons.stop
      ]

      for (const label of labels) {
        expect({ locale, label, clean: sheetText(label) === label && !label.includes('\n') }).toEqual({
          locale,
          label,
          clean: true
        })
      }
    }
  })
})

describe('m-r2-2: a profile outside the Hermes home is shown as unprotected', () => {
  it('m-r2-2: the status names each unprotected profile with the reason; none ⇒ no row', async () => {
    install({ status: vi.fn(async () => ({ ...STATUS, unprotectedProfiles: ['inft-out-6', 'inft-out-8'] })) })
    await shown()

    expect(q('[data-payments-unprotected]')?.textContent).toBe('inft-out-6, inft-out-8')
    expect(screen.getByText(en.status.unprotected)).toBeTruthy()
    expect(screen.getByText(en.status.unprotectedHint)).toBeTruthy()
  })

  it('m-r2-2: no unprotected profile, no row', async () => {
    install()
    await shown()

    expect(q('[data-payments-unprotected]')).toBeNull()
    expect(screen.queryByText(en.status.unprotected)).toBeNull()
  })
})
