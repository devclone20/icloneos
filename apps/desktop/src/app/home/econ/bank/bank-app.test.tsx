import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type * as AcpSetup from '@/app/home/acp-setup'
import { SETTINGS_ROUTE } from '@/app/routes'

import {
  cli3ds,
  CLI_LIMIT,
  CLI_LIST,
  CLI_NOT_AUTHENTICATED,
  CLI_NOT_SIGNED_UP,
  CLI_PROFILE,
  CLI_REAUTH,
  CLI_REQUEST_CAPTURED,
  CLI_REQUEST_OPEN,
  CLI_WHOAMI
} from './bank-cli-fixtures'

const runAcp = vi.fn()
const agentcardAccountState = vi.fn(async (): Promise<null | string> => null)

/** The iNFT kv store (`card-signup`), in memory. */
const kv = new Map<string, Record<string, unknown>>()

vi.mock('../../acp-setup', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runAcp: (...args: unknown[]) => runAcp(...args),
  agentcardAccountState: () => agentcardAccountState(),
  inftKvGet: async (inftId: string) => ({ ok: true, value: kv.get(inftId) ?? null }),
  inftKvSet: async (inftId: string, _key: string, value: Record<string, unknown>) => {
    kv.set(inftId, value)

    return { ok: true, value }
  },
  inftKvDelete: async (inftId: string) => {
    kv.delete(inftId)

    return { ok: true, value: null }
  }
}))

vi.mock('../../../chat/composer/focus', () => ({
  requestComposerFocus: () => undefined,
  requestComposerInsert: () => undefined
}))

const { default: BankApp } = await import('./bank-app')
const { $acpConfigMap } = await import('../../acp-setup')

interface CliAnswer {
  ok: boolean
  code: null | number
  stdout: string
  stderr: string
  error?: string
}

function printed(json: unknown): CliAnswer {
  return { code: 0, ok: true, stderr: '', stdout: JSON.stringify(json) }
}

/** Per-test answers by command; a function answer may hold the call open. */
let answers: Record<string, (argv: string[]) => CliAnswer | Promise<CliAnswer>> = {}

function readyCard() {
  answers = {
    'card 3ds': () => printed(cli3ds(new Date(Date.now() - 60_000).toISOString())),
    'card get': argv => {
      const id = argv[3]
      const row = [CLI_REQUEST_CAPTURED, CLI_REQUEST_OPEN].find(request => request.id === id)

      return printed(row ?? { error: 'not found' })
    },
    'card limit': () => printed(CLI_LIMIT),
    'card list': () => printed(CLI_LIST),
    'card profile': () => printed(CLI_PROFILE),
    'card whoami': () => printed(CLI_WHOAMI)
  }
}

beforeEach(() => {
  runAcp.mockImplementation(async (_inftId: string, argv: string[]) => {
    const answer = answers[argv.slice(0, 2).join(' ')]

    return answer ? answer(argv) : printed({ error: 'unexpected command' })
  })
})

afterEach(() => {
  runAcp.mockReset()
  answers = {}
  kv.clear()
})

let slugSeq = 0

function mount() {
  slugSeq += 1

  return render(
    <MemoryRouter>
      <BankApp expanded={false} identity={null} inftId="base:0xabc:7" refreshKey={0} slug={`bank-app-${slugSeq}`} />
    </MemoryRouter>
  )
}

function asideOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.e-aside')
}

test('the hero says how much of the limit is left, and the 3DS row shows the amount and the countdown', async () => {
  readyCard()
  mount()

  expect(await screen.findByText('$38.00 of $50.00 left')).toBeTruthy()
  expect(await screen.findByText('USD 12.00')).toBeTruthy()
  expect(screen.getByText(/^[34]:\d\d left$/)).toBeTruthy()
  expect(screen.queryByText(/Unknown merchant/)).toBeNull()
})

test("a second selection never shows the first request's detail, even while its own read is pending", async () => {
  readyCard()

  const pending: { release?: () => void } = {}

  const getOpen = new Promise<CliAnswer>(resolve => {
    pending.release = () => resolve(printed({ ...CLI_REQUEST_OPEN, status: 'captured' }))
  })

  const readDetail = answers['card get']

  answers['card get'] = argv => (argv[3] === CLI_REQUEST_OPEN.id ? getOpen : readDetail(argv))

  const { container } = mount()

  // Open first by default, so the captured one lives under "All".
  fireEvent.click(await screen.findByRole('tab', { name: /All/ }))
  fireEvent.click(await screen.findByText('sr_8f2c4…'))

  await waitFor(() => expect(asideOf(container)?.textContent).toContain(CLI_REQUEST_CAPTURED.id))

  fireEvent.click(screen.getByText('sr_1b9e7…'))

  await waitFor(() => expect(asideOf(container)?.textContent).toContain(CLI_REQUEST_OPEN.id))
  expect(asideOf(container)?.textContent).not.toContain(CLI_REQUEST_CAPTURED.id)
  expect(within(asideOf(container)!).getByText('issued')).toBeTruthy()

  pending.release?.()

  await waitFor(() => expect(within(asideOf(container)!).getByText('captured')).toBeTruthy())
  expect(asideOf(container)?.textContent).toContain(CLI_REQUEST_OPEN.id)
})

test('a transient whoami failure on a cold open offers "Try again" instead of an endless skeleton', async () => {
  answers = {
    'card whoami': () => ({ code: null, error: 'acp timed out after 30s', ok: false, stderr: '', stdout: '' })
  }

  const { container } = mount()

  expect(await screen.findByText('Try again')).toBeTruthy()
  expect(container.querySelector('[aria-busy="true"]')).toBeNull()

  readyCard()
  fireEvent.click(screen.getByText('Try again'))

  expect(await screen.findByText('$38.00 of $50.00 left')).toBeTruthy()
  expect(screen.queryByText('Try again')).toBeNull()
})

// R16 — the card never "disappears": only the service's own 400 is "No card yet".
test('an expired Virtuals session keeps a known card, dimmed, with "Sign in again" — never "No card yet" or a signup', async () => {
  const slug = 'bank-app-expired-known'

  seedKnownCard(slug)
  answers = { 'card whoami': () => printed(JSON.parse(CLI_NOT_AUTHENTICATED)) }
  const { container } = render(bankAt(slug))

  expect(await screen.findByText(/Sign in to Virtuals again to use the card/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy()
  expect(container.querySelector('.bk-gate--expired .bk-card')).toBeTruthy()
  expect(screen.queryByText('No card yet')).toBeNull()
  expect(screen.queryByText(/Setup needed/i)).toBeNull()
  expect(screen.queryByText(/Sign up/)).toBeNull()
})

test('R16.F5 m2: an expired Virtuals session with no card ever seen is the plain sign-in gate, never a card visual', async () => {
  answers = { 'card whoami': () => printed(JSON.parse(CLI_NOT_AUTHENTICATED)) }
  const { container } = mount()

  expect(await screen.findByText(/Sign in to Virtuals again to read AgentCard/)).toBeTruthy()
  expect(screen.getByText('Sign-in required')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy()
  expect(container.querySelector('.bk-card')).toBeNull()
  expect(container.querySelector('.bk-gate--expired')).toBeNull()
  expect(screen.queryByText('No card yet')).toBeNull()
  expect(screen.queryByText(/Sign up/)).toBeNull()
})

test('a whoami that cannot answer paints "Checking the card…", never the signup steps', async () => {
  answers = {
    'card whoami': () => ({ code: null, error: 'timed out after 60s', ok: false, stderr: '', stdout: '' })
  }
  mount()

  expect(await screen.findByText('Checking the card…')).toBeTruthy()
  expect(screen.queryByText('No card yet')).toBeNull()
  expect(screen.queryByText(/Sign up/)).toBeNull()
})

test('only the card service\'s own "not set up" paints "No card yet"', async () => {
  answers = { 'card whoami': () => printed({ error: CLI_NOT_SIGNED_UP }) }
  mount()

  expect(await screen.findByText('No card yet')).toBeTruthy()
  expect(screen.queryByText(/Sign in to Virtuals again/)).toBeNull()
})

// R16 r3 — a lapsed AgentCard sign-in (401 REAUTH) never takes the card the owner opened off the screen.
function bankAt(slug: string, refreshKey = 0) {
  return (
    <MemoryRouter>
      <BankApp expanded={false} identity={null} inftId="base:0xabc:6" refreshKey={refreshKey} slug={slug} />
    </MemoryRouter>
  )
}

/** main's sticky `cardKnown`: this agent's card was seen ready before. */
function seedKnownCard(slug: string) {
  $acpConfigMap.set({
    ...$acpConfigMap.get(),
    [slug]: {
      authenticated: true,
      cardKnown: true,
      cardKnownAt: 1,
      cardReady: true,
      cardState: 'ready',
      checkedAt: 1,
      cli: true,
      configured: true,
      slug
    }
  })
}

test('a ready card that then answers REAUTH stays painted, dimmed, with the sign-in line and its actions', async () => {
  readyCard()
  const view = render(bankAt('bank-app-ready-then-reauth'))

  expect(await screen.findByText('$38.00 of $50.00 left')).toBeTruthy()

  answers['card whoami'] = () => printed({ error: CLI_REAUTH })
  view.rerender(bankAt('bank-app-ready-then-reauth', 1))

  expect(await screen.findByText(/Sign in to AgentCard again — a sign-in link was sent to/)).toBeTruthy()
  expect(view.container.querySelector('.bk-gate--expired .bk-card')).toBeTruthy()
  expect(screen.queryByText('Sign-in required')).toBeNull()
  expect(screen.getByRole('button', { name: 'Open Setup' })).toBeTruthy()
  expect(screen.getByRole('button', { name: /fetch the link/ })).toBeTruthy()
  expect(screen.queryByText('No card yet')).toBeNull()
  expect(screen.queryByText(/Sign up/)).toBeNull()
})

/** The card back's rows as label → value, read from the DOM (the face is a static `role="img"`). */
function cardBack(container: HTMLElement): Record<string, string> {
  const rows = container.querySelectorAll('.bk-gate--expired .bk-card__back-row')

  return Object.fromEntries(
    [...rows].map(row => [row.children[0]?.textContent ?? '', row.children[1]?.textContent ?? ''])
  )
}

test('R16.F5 m2: a dimmed card whose limit was never read says "Signed out" and "—", never "Active"', async () => {
  const slug = 'bank-app-expired-no-limit'

  seedKnownCard(slug)
  answers = { 'card whoami': () => printed(JSON.parse(CLI_NOT_AUTHENTICATED)) }
  const { container } = render(bankAt(slug))

  await screen.findByText(/Sign in to Virtuals again to use the card/)

  expect(cardBack(container)).toEqual({ 'Last spend limit': '—', Status: 'Signed out' })
})

test('R16.F5 m2: a known card that answers REAUTH keeps its last limit on the dimmed back, with no stale spend', async () => {
  readyCard()
  const view = render(bankAt('bank-app-f5-last-limit'))

  expect(await screen.findByText('$38.00 of $50.00 left')).toBeTruthy()

  answers['card whoami'] = () => printed({ error: CLI_REAUTH })
  view.rerender(bankAt('bank-app-f5-last-limit', 1))

  await screen.findByText(/Sign in to AgentCard again — a sign-in link was sent to/)

  expect(cardBack(view.container)).toEqual({ 'Last spend limit': '$50.00', Status: 'Signed out' })
})

test("#6's legacy {cardReady:true} status with a REAUTH whoami paints the known card, not the bare gate", async () => {
  const slug = 'bank-app-legacy-6'

  $acpConfigMap.set({
    ...$acpConfigMap.get(),
    [slug]: {
      authenticated: true,
      cardReady: true,
      checkedAt: 1,
      cli: true,
      configured: true,
      email: 'agent-6@example.com',
      slug
    }
  })
  answers = { 'card whoami': () => printed({ error: CLI_REAUTH }) }
  const { container } = render(bankAt(slug))

  expect(await screen.findByText(/Sign in to AgentCard again/)).toBeTruthy()
  expect(container.querySelector('.bk-gate--expired .bk-card')).toBeTruthy()
  expect(screen.queryByText('No card yet')).toBeNull()
})

test("main's sticky cardKnown on a signin-pending status keeps the card visual after a REAUTH", async () => {
  const slug = 'bank-app-sticky-known'

  $acpConfigMap.set({
    ...$acpConfigMap.get(),
    [slug]: {
      authenticated: true,
      cardKnown: true,
      cardKnownAt: 1,
      cardReady: false,
      cardState: 'signin-pending',
      checkedAt: 1,
      cli: true,
      configured: true,
      email: 'agent-6@example.com',
      slug
    }
  })
  answers = { 'card whoami': () => printed({ error: CLI_REAUTH }) }
  const { container } = render(bankAt(slug))

  expect(await screen.findByText(/Sign in to AgentCard again/)).toBeTruthy()
  expect(container.querySelector('.bk-gate--expired .bk-card')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Open Setup' })).toBeTruthy()
  expect(screen.queryByText('Sign-in required')).toBeNull()
  expect(screen.queryByText(/Sign up/)).toBeNull()
})

test("R16.r4: main's cardKnown beside a blocked or stateless status keeps the card visual after a REAUTH", async () => {
  for (const [slug, extra] of [
    ['bank-app-known-blocked', { cardHttpStatus: 429, cardState: 'blocked' as const }],
    ['bank-app-known-stale', { cardStale: true }]
  ] as const) {
    $acpConfigMap.set({
      ...$acpConfigMap.get(),
      [slug]: {
        authenticated: true,
        cardKnown: true,
        cardReady: false,
        checkedAt: 1,
        cli: true,
        configured: true,
        email: 'agent-6@example.com',
        slug,
        ...extra
      }
    })
    answers = { 'card whoami': () => printed({ error: CLI_REAUTH }) }
    const view = render(bankAt(slug))

    expect(await screen.findByText(/Sign in to AgentCard again/)).toBeTruthy()
    expect(view.container.querySelector('.bk-gate--expired .bk-card')).toBeTruthy()
    expect(screen.queryByText('Sign-in required')).toBeNull()
    view.unmount()
  }
})

test('R16.r4: a bare 401 on a ready card keeps the card, never "a sign-in link was sent"', async () => {
  const slug = 'bank-app-bare-401'

  $acpConfigMap.set({
    ...$acpConfigMap.get(),
    [slug]: {
      authenticated: true,
      cardKnown: true,
      cardReady: true,
      cardState: 'ready',
      checkedAt: 1,
      cli: true,
      configured: true,
      email: 'agent-6@example.com',
      slug
    }
  })
  answers = { ...answers, 'card whoami': () => printed({ error: 'HTTP 401: Unauthorized' }) }
  const { container } = render(bankAt(slug))

  await waitFor(() => expect(container.querySelector('.bk-card')).toBeTruthy())
  expect(screen.queryByText(/sign-in link was sent/)).toBeNull()
  expect(screen.queryByText('Sign-in required')).toBeNull()
})

function LocationProbe() {
  const { pathname, search } = useLocation()

  return <output data-testid="location">{pathname + search}</output>
}

test("R16.F5 m3: the dimmed card's sign-in opens this iNFT's card sign-in in Setup", async () => {
  seedKnownCard('bank-app-f5-open-setup')
  answers = { 'card whoami': () => printed(JSON.parse(CLI_NOT_AUTHENTICATED)) }

  const { container } = render(
    <MemoryRouter>
      <BankApp expanded={false} identity={null} inftId="base:0xabc:7" refreshKey={0} slug="bank-app-f5-open-setup" />
      <LocationProbe />
    </MemoryRouter>
  )

  await screen.findByText(/Sign in to Virtuals again to use the card/)
  expect(container.querySelector('.bk-gate--expired .bk-card')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))

  expect(screen.getByTestId('location').textContent).toBe(
    `${SETTINGS_ROUTE}?tab=economyos&inft=base%3A0xabc%3A7&step=signin`
  )
})

test('a REAUTH with no card ever seen is the plain sign-in gate, without a card visual', async () => {
  answers = { 'card whoami': () => printed({ error: CLI_REAUTH }) }
  const { container } = mount()

  expect(await screen.findByText('Sign-in required')).toBeTruthy()
  expect(container.querySelector('.bk-card')).toBeNull()
  expect(container.querySelector('.bk-gate--expired')).toBeNull()
  expect(screen.queryByText(/Sign in to AgentCard again/)).toBeNull()
})

/** The commands the window ran, as `root sub` pairs. */
const ran = () => runAcp.mock.calls.map(call => (call[1] as string[]).slice(0, 2).join(' '))

test('doc 07 #9: opening a signed-out card reads only — no sign-in e-mail, and no "sent" time it cannot prove', async () => {
  answers = { 'card whoami': () => printed({ email: 'pat@example.com', verified: false }) }
  render(bankAt('bank-app-open-sends-nothing'))

  expect(await screen.findByText(/A sign-in link was sent to/)).toBeTruthy()
  await waitFor(() => expect(ran()).toContain('card whoami'))
  expect(ran()).not.toContain('card signup')
  expect(screen.queryByText(/· sent /)).toBeNull()
  expect(screen.getByRole('button', { name: 'Resend link' }).getAttribute('aria-disabled')).toBeNull()
})

test('doc 07 #9: the link goes out on the click, once; "sent" comes from the confirmed answer; Resend waits a minute', async () => {
  readyCard()
  const view = render(bankAt('bank-app-resend-link'))

  expect(await screen.findByText('$38.00 of $50.00 left')).toBeTruthy()

  answers['card whoami'] = () => printed({ error: CLI_REAUTH })
  view.rerender(bankAt('bank-app-resend-link', 1))

  expect(await screen.findByText(/Sign in to AgentCard again — a sign-in link was sent to/)).toBeTruthy()
  expect(screen.queryByText(/· sent /)).toBeNull()
  expect(ran()).not.toContain('card signup')

  const answer: { release?: () => void } = {}

  answers['card signup'] = () =>
    new Promise<CliAnswer>(resolve => {
      answer.release = () => resolve(printed({ state: 'st-42', nextStep: { hint: 'Magic link sent' } }))
    })

  fireEvent.click(screen.getByRole('button', { name: 'Resend link' }))

  // Held from the click on, but nothing is called "sent" before the CLI says so.
  await waitFor(() => expect(answer.release).toBeTypeOf('function'))
  expect(screen.getByRole('button', { name: /Resend in \d+ s/ }).getAttribute('aria-disabled')).toBe('true')
  expect(screen.queryByText(/· sent /)).toBeNull()

  answer.release?.()

  expect(await screen.findByText(/· sent just now/)).toBeTruthy()
  expect(screen.getByRole('button', { name: /Resend in \d+ s/ }).getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: /Resend in \d+ s/ }))

  const signups = runAcp.mock.calls.filter(call => (call[1] as string[])[1] === 'signup')

  expect(signups).toHaveLength(1)
  expect(signups[0]?.[1]).toEqual(['card', 'signup', '--email', 'pat@example.com', '--json'])
  expect(kv.get('base:0xabc:6')).toMatchObject({ phase: 'polling', source: 'local', state: 'st-42' })
})

test('V3-L M2: the one-minute wait survives a re-mount — the reopened window shows it and sends 0, then 1 after it', async () => {
  const t0 = Date.now()

  vi.useFakeTimers({ toFake: ['Date'] })

  try {
    vi.setSystemTime(t0)
    answers = {
      'card whoami': () => printed({ email: 'pat@example.com', verified: false }),
      'card signup': () => printed({ state: 'st-7' })
    }

    const first = render(bankAt('bank-app-remount-wait'))

    fireEvent.click(await screen.findByRole('button', { name: 'Resend link' }))
    await waitFor(() => expect(kv.get('base:0xabc:6')).toMatchObject({ state: 'st-7' }))
    expect(await screen.findByText(/· sent just now/)).toBeTruthy()
    first.unmount()

    // The window is closed and reopened 20 s later: the minute is read back from the record.
    vi.setSystemTime(t0 + 20_000)
    const second = render(bankAt('bank-app-remount-wait'))
    const waiting = await screen.findByRole('button', { name: /Resend in \d+ s/ })

    expect(waiting.getAttribute('aria-disabled')).toBe('true')
    expect(waiting.textContent).toMatch(/Resend in 4\d s/)
    fireEvent.click(waiting)
    second.unmount()

    // Even a click that reaches the send (a third mount before the record is read) runs no signup.
    vi.setSystemTime(t0 + 30_000)
    const { sendSignInLink } = await import('@/app/settings/inft-setup-card-resend')

    const refused = await sendSignInLink('base:0xabc:6', 'pat@example.com')

    expect(refused.kind).toBe('wait')
    expect(refused.kind === 'wait' && refused.until - t0).toBeGreaterThanOrEqual(60_000)
    expect(refused.kind === 'wait' && refused.until - t0).toBeLessThan(61_000)
    expect(runAcp.mock.calls.filter(call => (call[1] as string[])[1] === 'signup')).toHaveLength(1)

    vi.setSystemTime(t0 + 61_000)
    render(bankAt('bank-app-remount-wait'))
    // Once the reopened window has read the record, the button is live again.
    await screen.findByRole('button', { name: 'Resend link' })
    await act(() => new Promise(resolve => setTimeout(resolve, 50)))
    fireEvent.click(screen.getByRole('button', { name: 'Resend link' }))
    await waitFor(() => expect(runAcp.mock.calls.filter(call => (call[1] as string[])[1] === 'signup')).toHaveLength(2))
  } finally {
    vi.useRealTimers()
  }
})

test('K74: a link that goes out after the window switched iNFTs stamps nothing on the new one', async () => {
  answers = { 'card whoami': () => printed({ email: 'pat@example.com', verified: false }) }

  const answer: { release?: () => void } = {}

  answers['card signup'] = () =>
    new Promise<CliAnswer>(resolve => {
      answer.release = () => resolve(printed({ state: 'st-k74' }))
    })

  const at = (inftId: string) => (
    <MemoryRouter>
      <BankApp expanded={false} identity={null} inftId={inftId} refreshKey={0} slug="bank-app-k74" />
    </MemoryRouter>
  )

  const view = render(at('base:0xabc:6'))

  fireEvent.click(await screen.findByRole('button', { name: 'Resend link' }))
  await waitFor(() => expect(answer.release).toBeTypeOf('function'))

  // The owner switches to another iNFT while the first one's link is still going out.
  view.rerender(at('base:0xabc:7'))
  await screen.findByRole('button', { name: /Resend/ })
  answer.release?.()
  await waitFor(() => expect(kv.get('base:0xabc:6')).toMatchObject({ state: 'st-k74' }))
  await act(() => new Promise(resolve => setTimeout(resolve, 50)))

  expect(screen.queryByText(/· sent /)).toBeNull()
})

test('doc 07 #9: a refused send stamps nothing and says why', async () => {
  answers = {
    'card whoami': () => printed({ email: 'pat@example.com', verified: false }),
    'card signup': () => printed({ error: 'HTTP 429: Too Many Requests' })
  }
  render(bankAt('bank-app-resend-refused'))

  fireEvent.click(await screen.findByRole('button', { name: 'Resend link' }))

  expect(await screen.findByText(/limiting this account/)).toBeTruthy()
  expect(screen.queryByText(/· sent /)).toBeNull()
  expect(screen.getByRole('button', { name: /Resend in \d+ s/ }).getAttribute('aria-disabled')).toBe('true')
})

test('V3-L m4: the clock set back an hour while the Bank is open — Resend still waits at most its minute', async () => {
  const t0 = Date.now()

  vi.useFakeTimers({ toFake: ['Date'] })

  try {
    vi.setSystemTime(t0)
    answers = {
      'card whoami': () => printed({ email: 'pat@example.com', verified: false }),
      'card signup': () => printed({ state: 'st-m4' })
    }
    render(bankAt('bank-app-clock-back'))

    fireEvent.click(await screen.findByRole('button', { name: 'Resend link' }))
    await waitFor(() => expect(kv.get('base:0xabc:6')).toMatchObject({ state: 'st-m4' }))
    await screen.findByRole('button', { name: /Resend in \d+ s/ })

    // One hour back, the window still open: a tick sees the step back and keeps what was left (the faked
    // clock stands still, so all 60 s), never adds the hour.
    vi.setSystemTime(t0 - 3_600_000)
    await act(() => new Promise(resolve => setTimeout(resolve, 1_200)))
    expect(screen.getByRole('button', { name: /Resend/ }).textContent).toBe('Resend in 60 s')

    // A minute after the step back the button is live again.
    vi.setSystemTime(t0 - 3_600_000 + 61_000)
    expect(await screen.findByRole('button', { name: 'Resend link' }, { timeout: 2_500 })).toBeTruthy()
  } finally {
    vi.useRealTimers()
  }
})

test('V3-L: the Bank setup names both paths inside its existing hint line — no element of its own', async () => {
  answers = { 'card whoami': () => printed({ error: CLI_NOT_SIGNED_UP }) }
  const { container } = mount()

  const hint = (await screen.findByText(/Two ways to set up AgentCard/)).closest('p')

  expect(hint?.className).toBe('bk-gate__hint')
  expect(hint?.textContent).toMatch(
    /^Set up AgentCard once and .* Two ways to set up AgentCard: .*acp card.*agentcard signup/
  )
  // Unknown (no clear CLI answer): the two-paths sentence alone, no guessed account state after it.
  expect(hint?.textContent).not.toMatch(/Your own AgentCard account/)
  // The gate has exactly the hint lines it had before V3-L: the noCard hint only.
  expect(container.querySelectorAll('.bk-gate p.bk-gate__hint')).toHaveLength(1)
})

test('V3-L m3: a state main does not produce (an older build\'s "blocked") reads as unknown, never as a sentence', async () => {
  const actual = await vi.importActual<typeof AcpSetup>('../../acp-setup')
  const bridge = window.hermesDesktop
  const answer = vi.fn(async (): Promise<unknown> => ({ state: 'blocked', checkedAt: 1 }))

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { ...bridge, icloneAcp: { ...bridge?.icloneAcp, agentcardStatus: answer } }
  })

  try {
    expect(await actual.agentcardAccountState()).toBeNull()
    answer.mockResolvedValue({ state: 'kyc-required', checkedAt: 1 })
    expect(await actual.agentcardAccountState()).toBe('kyc-required')
  } finally {
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: bridge })
  }
})

test("V3-L M3: the owner's own agentcard account state is one sentence next to the acp card state, in both gates", async () => {
  agentcardAccountState.mockResolvedValue('signed-out')
  answers = { 'card whoami': () => printed({ error: CLI_NOT_SIGNED_UP }) }
  const none = mount()

  const line = await screen.findByText(/Your own AgentCard account is signed out\./)

  expect(line.className).toBe('bk-gate__hint')
  expect(line.textContent).toContain('agentcard signup')
  none.unmount()

  agentcardAccountState.mockResolvedValue('kyc-required')
  answers = { 'card whoami': () => printed({ email: 'pat@example.com', verified: false }) }
  const { container } = render(bankAt('bank-app-agentcard-pending'))

  const pending = await screen.findByText(/needs identity verification \(KYC\)\./)

  expect(pending.textContent).toMatch(/^A sign-in link was sent to/)
  expect(container.querySelectorAll('.bk-gate p.bk-gate__hint')).toHaveLength(1)
  agentcardAccountState.mockResolvedValue(null)
})
