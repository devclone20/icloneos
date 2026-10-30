import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { $agentIdentity } from '../agent'
import { $econBadges } from '../badges'
import { writeSnapshot } from '../snapshot'
import type { AgentIdentity } from '../types'

const runAcp = vi.fn()
const requestComposerInsert = vi.fn()

vi.mock('../../acp-setup', () => ({ runAcp: (...args: unknown[]) => runAcp(...args) }))

vi.mock('../../../chat/composer/focus', () => ({
  requestComposerFocus: () => undefined,
  requestComposerInsert: (...args: unknown[]) => requestComposerInsert(...args)
}))

const { default: MarketApp } = await import('./market-app')
const data = await import('./market-data')

const ME = '0x1111000000000000000000000000000000000001'

const AGENT = {
  id: '1042',
  name: 'Otto AI',
  description: 'Crypto research desk.',
  imageUrl: '',
  walletAddress: '0x5bB4B0bd6FFbF4D1a1b8F4E6b2F0cA7d9E1f2A3b',
  lastActiveAt: '2999-12-31T00:00:00.000Z',
  rating: 4.8,
  chains: [{ chainId: 8453, active: true }],
  offerings: [
    {
      id: 'off-1',
      name: 'Crypto news report',
      deliverable: 'A markdown report',
      requirements: {
        type: 'object',
        required: ['ticker'],
        properties: { ticker: { type: 'string', description: 'Token ticker' } }
      },
      slaMinutes: 30,
      priceType: 'fixed',
      priceValue: 0.01,
      requiredFunds: false
    }
  ],
  resources: [
    {
      id: 'res-1',
      agentId: '1042',
      name: 'Price feed',
      description: 'Live token prices.',
      url: 'https://api.otto.example/price',
      params: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] }
    }
  ]
}

/** The iNFT's own offering, as `acp offering list --json` prints it. */
const OWN = {
  id: 'off-1',
  agentId: 'agent-1',
  name: 'Crypto news report',
  description: 'A daily digest.',
  deliverable: 'A markdown report',
  requirements: {
    type: 'object',
    properties: { ticker: { type: 'string', description: 'Token ticker' } },
    required: ['ticker']
  },
  slaMinutes: 30,
  priceType: 'fixed',
  priceValue: 0.01,
  requiredFunds: false,
  isHidden: false,
  subscriptions: []
}

const JOBS = [
  {
    chainId: 8453,
    onChainJobId: '501',
    jobStatus: 'budget_set',
    clientAddress: ME,
    providerAddress: AGENT.walletAddress,
    providerName: 'Otto AI',
    serviceName: 'Crypto news report',
    budget: '10000'
  },
  {
    chainId: 8453,
    onChainJobId: '502',
    jobStatus: 'completed',
    clientAddress: ME,
    providerAddress: '0x9999000000000000000000000000000000000009',
    serviceName: 'Meme pack'
  }
]

// Per-test overrides: a command prefix → the JSON it prints.
let overrides: Record<string, unknown> = {}

function answer(argv: string[]): unknown {
  const command = argv.slice(0, 2).join(' ')
  const joined = argv.join(' ')

  for (const [prefix, value] of Object.entries(overrides)) {
    if (joined.startsWith(prefix)) {
      return value
    }
  }

  if (argv[0] === 'browse') {
    if (argv[1] === 'nothing-matches') {
      return { data: [] }
    }

    const count = Number(argv[3]) === 24 && argv[1] === 'many' ? 24 : Number(argv[3]) === 48 ? 30 : 1

    return count === 1
      ? { data: [AGENT] }
      : { data: Array.from({ length: count }, (_, index) => ({ ...AGENT, id: `a-${index}`, name: `Agent ${index}` })) }
  }

  if (command === 'job list') {
    return { jobs: [] }
  }

  if (command === 'offering list') {
    return []
  }

  if (command === 'chain list') {
    return { environment: 'mainnet', chains: [{ id: 8453, name: 'Base', family: 'evm' }] }
  }

  return { error: 'unexpected command' }
}

beforeEach(() => {
  runAcp.mockImplementation(async (_inftId: string, argv: string[]) => ({
    ok: true,
    code: 0,
    stdout: JSON.stringify(answer(argv)),
    stderr: ''
  }))
})

afterEach(() => {
  runAcp.mockReset()
  requestComposerInsert.mockReset()
  overrides = {}
  vi.useRealTimers()
})

let slugSeq = 0

function identityOf(id: string): AgentIdentity {
  return {
    id,
    name: 'Pat',
    description: '',
    imageUrl: '',
    walletAddress: ME,
    solWalletAddress: '',
    role: '',
    rating: null,
    createdAt: '',
    builderCode: ''
  }
}

function nextSlug(): string {
  slugSeq += 1

  return `market-test-${slugSeq}`
}

function app(slug: string, identity: AgentIdentity | null) {
  return (
    <MemoryRouter>
      <MarketApp expanded={false} identity={identity} inftId="8453:0xabc:7" refreshKey={0} slug={slug} />
    </MemoryRouter>
  )
}

function mount(options: { identity?: AgentIdentity | null; slug?: string } = {}) {
  const slug = options.slug ?? nextSlug()
  const view = render(app(slug, options.identity ?? null))

  return { ...view, slug }
}

function commands(): string[] {
  return runAcp.mock.calls.map(call => (call[1] as string[]).join(' '))
}

const FEATURED = 'browse agent --top-k 24 --online all --mode mixed --json'

function seedSnapshot(slug: string, agentId: string) {
  const agents = data.shapeAgents({ data: [{ ...AGENT, name: 'Snapshot Otto' }] })
  const jobs = data.shapeJobs({ jobs: JOBS })

  const built = data.buildSnapshot({
    agentId,
    featured: { data: agents, at: Date.now() - 3 * 3_600_000 },
    jobs: { data: jobs, at: Date.now() - 3 * 3_600_000 },
    offerings: { data: [], at: Date.now() - 3 * 3_600_000 },
    chains: [{ id: 8453, name: 'Base', family: 'evm' }]
  })!

  writeSnapshot('acp', slug, data.SNAPSHOT_VERSION, built.data, built.at)
}

test('opens on the featured marketplace, never empty, and only ever reads', async () => {
  mount()

  expect(await screen.findByText('Otto AI')).toBeTruthy()
  expect(screen.getByText('Featured on ACP')).toBeTruthy()

  await waitFor(() => expect(commands()).toContain('offering list --json'))

  // The search paints first; the chain names and the rail counts queue behind it.
  expect(commands()).toEqual([FEATURED, 'chain list --json', 'job list --all --json', 'offering list --json'])
  expect(commands().every(command => !/^(client|provider)\b/.test(command))).toBe(true)
  expect(commands().every(command => command.endsWith('--json'))).toBe(true)
})

test('paints the last snapshot before the CLI answers, then revalidates the search', async () => {
  const slug = nextSlug()

  seedSnapshot(slug, 'agent-1')
  runAcp.mockImplementation(() => new Promise(() => undefined))
  mount({ identity: identityOf('agent-1'), slug })

  // Synchronously, on the first frame — no skeleton, no wait.
  expect(screen.getByText('Snapshot Otto')).toBeTruthy()
  expect(screen.getByText('Featured on ACP')).toBeTruthy()
  expect(within(screen.getByRole('button', { name: /My jobs/ })).getByText('1')).toBeTruthy()
  await waitFor(() => expect(commands()[0]).toBe(FEATURED))
  expect($econBadges.get()[slug]?.acp).toBe(1)
})

test('never paints a snapshot that belongs to another agent', () => {
  const slug = nextSlug()

  seedSnapshot(slug, 'agent-1')
  runAcp.mockImplementation(() => new Promise(() => undefined))
  mount({ identity: identityOf('agent-2'), slug })

  expect(screen.queryByText('Snapshot Otto')).toBeNull()
})

test('a sign-in failure shows the gate over hydrated data', async () => {
  const slug = nextSlug()

  seedSnapshot(slug, 'agent-1')
  overrides = { browse: { error: 'HTTP 401: {"message":"REAUTH:1b2c3d4e-0000-4000-8000-000000000000"}' } }
  mount({ identity: identityOf('agent-1'), slug })

  expect(await screen.findByText('Sign-in needed')).toBeTruthy()
  expect(screen.queryByText('Snapshot Otto')).toBeNull()
})

test('the timer refreshes jobs, never the search', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval', 'Date'] })
  mount()
  await screen.findByText('Otto AI')
  await waitFor(() => expect(commands()).toContain('offering list --json'))

  // Past the featured TTL (10 min): a browse on the timer would spawn again.
  await act(() => vi.advanceTimersByTimeAsync(11 * 60_000))

  expect(commands().filter(command => command.startsWith('browse'))).toHaveLength(1)
  expect(commands().filter(command => command === 'job list --all --json').length).toBeGreaterThan(1)
})

test('shows more results: 24 → 48 on the same search', async () => {
  const { slug } = mount()

  await screen.findByText('Otto AI')

  const box = screen.getByRole('searchbox')

  fireEvent.change(box, { target: { value: 'many' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  await screen.findByText('Agent 23')
  fireEvent.click(screen.getByRole('button', { name: /Show more results/ }))

  expect(await screen.findByText('Agent 29')).toBeTruthy()
  expect(commands()).toContain('browse many --top-k 48 --online all --mode mixed --json')
  expect(JSON.parse(window.localStorage.getItem(`iclone.market.params.${slug}`) ?? '{}')).toMatchObject({
    query: 'many',
    topK: 48
  })
})

test('resumes the last search per iNFT, and Reset forgets it', async () => {
  const first = mount()

  await screen.findByText('Otto AI')
  fireEvent.click(screen.getByRole('tab', { name: 'Online' }))
  await waitFor(() => expect(commands()).toContain('browse agent --top-k 24 --online online --mode mixed --json'))
  first.unmount()
  runAcp.mockClear()

  mount({ slug: first.slug })

  // The resumed search is the one read on open — here straight from the cache.
  expect(screen.getByRole('tab', { name: 'Online' }).getAttribute('aria-selected')).toBe('true')
  expect(await screen.findByText('Otto AI')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Reset search and filters' }))

  expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.queryByRole('button', { name: 'Reset search and filters' })).toBeNull()
  expect(window.localStorage.getItem(`iclone.market.params.${first.slug}`)).toBeNull()
  expect(commands().some(command => command.startsWith('browse'))).toBe(false)
})

test('My jobs opens on what needs me, searches, and finds the provider on ACP', async () => {
  overrides = { 'job list': { jobs: JOBS } }

  const { slug } = mount({ identity: identityOf('agent-1') })

  await screen.findByText('Otto AI')
  fireEvent.click(screen.getByRole('button', { name: /My jobs/ }))

  expect(await screen.findByText('Crypto news report')).toBeTruthy()
  expect(screen.queryByText('Meme pack')).toBeNull()
  expect($econBadges.get()[slug]?.acp).toBe(1)

  fireEvent.click(screen.getByRole('tab', { name: /All/ }))
  expect(await screen.findByText('Meme pack')).toBeTruthy()

  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'meme' } })
  await waitFor(() => expect(screen.queryByText('Crypto news report')).toBeNull())
  expect(screen.getByText('Meme pack')).toBeTruthy()

  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
  fireEvent.click(await screen.findByText('Crypto news report'))
  fireEvent.click(await screen.findByRole('button', { name: 'Find Otto AI on ACP' }))

  const detail = await screen.findByRole('region', { name: 'Offerings' })

  expect(within(detail).getByText('Crypto news report')).toBeTruthy()
  expect(commands()).toContain('browse Otto AI --top-k 24 --online all --mode mixed --json')
})

test('prefetch warms the exact read the window makes, and badges from the snapshot', async () => {
  const slug = nextSlug()

  seedSnapshot(slug, 'agent-1')
  $agentIdentity.set({ ...$agentIdentity.get(), [slug]: identityOf('agent-1') })

  await data.prefetch('8453:0xabc:7', slug)

  expect(commands()).toEqual([FEATURED])
  expect($econBadges.get()[slug]?.acp).toBe(1)

  mount({ identity: identityOf('agent-1'), slug })

  expect(await screen.findByText('Otto AI')).toBeTruthy()
  await waitFor(() => expect(commands()).toContain('job list --all --json'))
  expect(commands().filter(command => command === FEATURED)).toHaveLength(1)
})

test('searches on Enter and remembers the query under the iNFT’s own key', async () => {
  const { slug } = mount()

  await screen.findByText('Otto AI')

  const box = screen.getByRole('searchbox')

  fireEvent.change(box, { target: { value: 'nothing-matches' } })
  fireEvent.keyDown(box, { key: 'Enter' })

  expect(await screen.findByText('No agents match “nothing-matches”')).toBeTruthy()
  expect(JSON.parse(window.localStorage.getItem(`iclone.market.recent.${slug}`) ?? '[]')).toContain('nothing-matches')
  expect(window.localStorage.getItem('iclone.market.recent')).toBeNull()
})

test('shows an agent’s offering as a form preview and hands the hire to the iNFT', async () => {
  mount()
  fireEvent.click(await screen.findByText('Otto AI'))

  const detail = await screen.findByRole('region', { name: 'Offerings' })

  expect(within(detail).getByText('Crypto news report')).toBeTruthy()
  expect(within(detail).getByText('ticker')).toBeTruthy()
  expect(within(detail).getByText('required')).toBeTruthy()

  fireEvent.click(within(detail).getByRole('button', { name: /Hire via/ }))

  expect(requestComposerInsert).toHaveBeenCalledTimes(1)

  const brief = String(requestComposerInsert.mock.calls[0][0])

  expect(brief).toContain('hire Otto AI (agent 1042) for the offering "Crypto news report" (offering off-1)')
  expect(brief).toContain('acp client create-job')
  expect(runAcp.mock.calls.some(call => (call[1] as string[])[0] === 'client')).toBe(false)
})

test('My jobs says what to do next when there are none', async () => {
  mount()
  await screen.findByText('Otto AI')

  fireEvent.click(screen.getByRole('button', { name: 'My jobs' }))

  expect(await screen.findByText('No jobs yet')).toBeTruthy()
})

test('prefetch warms the stored search the window opens on, then the featured feed', async () => {
  const slug = nextSlug()

  window.localStorage.setItem(
    `iclone.market.params.${slug}`,
    JSON.stringify({ ...data.DEFAULT_PARAMS, query: 'many', topK: 48 })
  )

  await data.prefetch('8453:0xabc:7', slug)

  expect(commands()).toEqual(['browse many --top-k 48 --online all --mode mixed --json', FEATURED])

  mount({ slug })

  expect(await screen.findByText('Agent 29')).toBeTruthy()
  await waitFor(() => expect(commands()).toContain('offering list --json'))
  expect(commands().filter(command => command.startsWith('browse'))).toHaveLength(2)

  // A stored chain filter narrows the featured answer: one read serves both.
  const narrowed = nextSlug()

  window.localStorage.setItem(`iclone.market.params.${narrowed}`, JSON.stringify({ chainId: 8453 }))
  runAcp.mockClear()
  await data.prefetch('8453:0xabc:7', narrowed)

  expect(commands()).toEqual([FEATURED])
})

test('a chain filter narrows the answer on screen without asking the CLI again', async () => {
  overrides = {
    browse: { data: [AGENT, { ...AGENT, id: 'sol-1', name: 'Sol Agent', chains: [{ chainId: 501, active: true }] }] }
  }

  mount()

  expect(await screen.findByText('Sol Agent')).toBeTruthy()
  await screen.findByRole('option', { name: 'Base' })

  const spawned = commands().filter(command => command.startsWith('browse')).length

  fireEvent.change(screen.getByRole('combobox', { name: 'Chain' }), { target: { value: '8453' } })

  await waitFor(() => expect(screen.queryByText('Sol Agent')).toBeNull())
  expect(screen.getByText('Otto AI')).toBeTruthy()
  expect(commands().filter(command => command.startsWith('browse'))).toHaveLength(spawned)
  expect(commands().some(command => command.includes('--chain-ids'))).toBe(false)
})

test('Sign in again (opens Setup) forgets the cached sign-in failure, so the next open asks again', async () => {
  const slug = nextSlug()

  overrides = { browse: { error: 'HTTP 401: {"message":"REAUTH:1b2c3d4e-0000-4000-8000-000000000000"}' } }

  const first = mount({ slug })

  fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }))
  first.unmount()
  overrides = {}
  runAcp.mockClear()
  mount({ slug })

  expect(await screen.findByText('Otto AI')).toBeTruthy()
  expect(commands()).toContain(FEATURED)
})

test('writes the snapshot only when a newer read lands', async () => {
  // Each answer on its own task, so every read renders (and persists) alone.
  runAcp.mockImplementation(async (_inftId: string, argv: string[]) => {
    await new Promise(resolve => setTimeout(resolve, 5))

    return { ok: true, code: 0, stdout: JSON.stringify(answer(argv)), stderr: '' }
  })

  const store = window.localStorage
  const setItem = vi.spyOn(Object.hasOwn(store, 'setItem') ? store : Storage.prototype, 'setItem')
  const { slug } = mount({ identity: identityOf('agent-1') })
  const key = `iclone.econ.snap.${slug}.acp`
  const writes = () => setItem.mock.calls.filter(([name]) => name === key).length

  await screen.findByText('Otto AI')
  await waitFor(() => expect(JSON.parse(store.getItem(key) ?? '{}').data?.offerings).toBeTruthy())

  // One write per read that landed (featured, jobs, offerings) — the chain
  // names arriving in between add no write of their own.
  const before = writes()

  expect(before).toBe(3)
  const box = screen.getByRole('searchbox')

  // A typed search is never persisted, so its answer costs no write.
  fireEvent.change(box, { target: { value: 'nothing-matches' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  expect(await screen.findByText('No agents match “nothing-matches”')).toBeTruthy()

  expect(writes()).toBe(before)
  setItem.mockRestore()
})

test('a re-provisioned iNFT drops the old agent’s lists and reads the new agent’s', async () => {
  overrides = { 'job list': { jobs: JOBS } }

  const view = mount({ identity: identityOf('agent-1') })
  const rail = () => screen.getByRole('button', { name: /My jobs/ })

  await screen.findByText('Otto AI')
  await waitFor(() => expect(within(rail()).getByText('1')).toBeTruthy())

  overrides = { 'job list': { jobs: [] } }
  runAcp.mockClear()
  view.rerender(app(view.slug, identityOf('agent-2')))

  await waitFor(() => expect(commands()).toContain('job list --all --json'))
  await waitFor(() => expect(within(rail()).queryByText('1')).toBeNull())

  const stored = JSON.parse(window.localStorage.getItem(`iclone.econ.snap.${view.slug}.acp`) ?? 'null') as {
    data?: { agentId?: string }
  } | null

  expect(stored?.data?.agentId ?? null).not.toBe('agent-1')
})

function argvOf(root: string): string[][] {
  return runAcp.mock.calls.map(call => call[1] as string[]).filter(argv => argv.slice(0, 2).join(' ') === root)
}

function cardNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.mk-grid .mk-card__name')].map(node => node.textContent ?? '')
}

async function search(text: string) {
  const box = screen.getByRole('searchbox')

  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

async function openOwn(label: RegExp) {
  await screen.findByText('Otto AI')
  fireEvent.click(screen.getByRole('button', { name: label }))
}

const agentsNamed = (ids: number[]) => ids.map(index => ({ ...AGENT, id: `a-${index}`, name: `Agent ${index}` }))

test('Show more merges the wider page: earlier cards keep their places, each agent once', async () => {
  // The service reorders the wider page and repeats an agent in it.
  overrides = {
    'browse many --top-k 48': {
      data: [...agentsNamed(Array.from({ length: 30 }, (_, index) => 29 - index)), ...agentsNamed([5])]
    }
  }

  const { container } = mount()

  await screen.findByText('Otto AI')
  await search('many')
  await screen.findByText('Agent 23')

  expect(screen.getByText('24 shown · up to 48 next')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Show more results/ }))

  await screen.findByText('Agent 29')

  const first = Array.from({ length: 24 }, (_, index) => `Agent ${index}`)

  expect(cardNames(container)).toEqual([
    ...first,
    'Agent 29',
    'Agent 28',
    'Agent 27',
    'Agent 26',
    'Agent 25',
    'Agent 24'
  ])
  // 31 returned for 48 asked: the marketplace has nothing more.
  expect(screen.queryByRole('button', { name: /Show more results/ })).toBeNull()
  expect(screen.getByText('That’s everything the marketplace has for this search.')).toBeTruthy()
  expect(commands()).toContain('browse many --top-k 48 --online all --mode mixed --json')
})

test('a search the marketplace cannot answer falls back to local matches, and says so', async () => {
  overrides = { 'browse crypto news': { data: [] } }

  const { container } = mount()

  await screen.findByText('Otto AI')
  await search('crypto news')

  expect(await screen.findByText(/No marketplace match for “crypto news” — showing local matches/)).toBeTruthy()
  expect(screen.getByText('Local matches for “crypto news”')).toBeTruthy()
  expect(screen.getByText('1 agent · 1 offering match')).toBeTruthy()
  expect(cardNames(container)).toEqual(['Otto AI'])

  // The offering that matched, on the card, with the words marked.
  const match = container.querySelector('.mk-grid .mk-match__name')

  expect(match?.textContent).toBe('Crypto news report')
  expect([...(match?.querySelectorAll('mark.mk-hit') ?? [])].map(node => node.textContent)).toEqual(['Crypto', 'news'])
  expect(screen.queryByRole('button', { name: /Show more results/ })).toBeNull()
})

test('category chips run their search and light up', async () => {
  mount()
  await screen.findByText('Otto AI')

  fireEvent.click(screen.getByRole('button', { name: 'Security' }))

  await waitFor(() => expect(commands()).toContain('browse security audit --top-k 24 --online all --mode mixed --json'))
  expect(screen.getByRole('button', { name: 'Security' }).getAttribute('aria-pressed')).toBe('true')
})

test('the agent detail lists its resources with the params as a form', async () => {
  mount()
  fireEvent.click(await screen.findByText('Otto AI'))

  const resources = await screen.findByRole('region', { name: 'Resources' })

  expect(within(resources).getByText('Price feed')).toBeTruthy()
  expect(within(resources).getByText('https://api.otto.example/price')).toBeTruthy()
  expect(within(resources).getByText('symbol')).toBeTruthy()
  expect(within(resources).getByText('required')).toBeTruthy()
})

test('creating an offering sends exactly the argv the bridge allows', async () => {
  overrides = {
    'subscription list': [],
    'offering create': { id: 'off-new', name: 'Token report' }
  }

  mount({ identity: identityOf('agent-1') })
  await openOwn(/My offerings/)
  await screen.findByText('No offerings yet')
  fireEvent.click(screen.getAllByRole('button', { name: /New offering/ })[0])

  const form = await screen.findByRole('form', { name: 'New offering' })
  const requirements = within(form).getByRole('group', { name: 'Requirements' })

  fireEvent.change(within(form).getByRole('textbox', { name: 'Name' }), { target: { value: 'Token report' } })
  fireEvent.change(within(form).getByRole('textbox', { name: 'Description' }), {
    target: { value: 'A daily digest of one token.' }
  })
  fireEvent.change(within(form).getByRole('textbox', { name: 'Price' }), { target: { value: '0.5' } })
  fireEvent.change(within(form).getByRole('textbox', { name: 'SLA' }), { target: { value: '30' } })
  fireEvent.change(within(requirements).getByRole('textbox', { name: 'Requirements field 1 name' }), {
    target: { value: 'ticker' }
  })
  fireEvent.change(within(requirements).getByRole('textbox', { name: 'Requirements field 1 description' }), {
    target: { value: 'Token ticker' }
  })
  fireEvent.change(within(form).getByRole('textbox', { name: 'Deliverable — plain text' }), {
    target: { value: 'A markdown report' }
  })
  fireEvent.click(within(form).getByRole('switch', { name: /Requires funds up front/ }))
  fireEvent.click(within(form).getByRole('button', { name: 'Create offering' }))

  await waitFor(() => expect(argvOf('offering create')).toHaveLength(1))
  expect(argvOf('offering create')[0]).toEqual([
    'offering',
    'create',
    '--name',
    'Token report',
    '--description',
    'A daily digest of one token.',
    '--price-type',
    'fixed',
    '--price-value',
    '0.5',
    '--sla-minutes',
    '30',
    '--requirements',
    '{"type":"object","properties":{"ticker":{"type":"string","description":"Token ticker"}},"required":["ticker"]}',
    '--deliverable',
    'A markdown report',
    '--required-funds',
    '--no-hidden',
    '--json'
  ])
  expect(await screen.findByText('Created “Token report” — buyers can hire it on ACP.')).toBeTruthy()
  // The list is read again, bypassing the cache the write invalidated.
  expect(commands().filter(command => command === 'offering list --json').length).toBeGreaterThan(1)
})

test('an incomplete offering says what is missing and sends nothing', async () => {
  overrides = { 'subscription list': [] }

  mount({ identity: identityOf('agent-1') })
  await openOwn(/My offerings/)
  await screen.findByText('No offerings yet')
  fireEvent.click(screen.getAllByRole('button', { name: /New offering/ })[0])
  fireEvent.click(await screen.findByRole('button', { name: 'Create offering' }))

  expect(await screen.findByText('Give it a name.')).toBeTruthy()
  expect(screen.getByText('Set a price in USDC.')).toBeTruthy()
  expect(argvOf('offering create')).toHaveLength(0)
})

test('the 41st offering is refused before the CLI is asked', async () => {
  overrides = {
    'offering list': Array.from({ length: 40 }, (_, index) => ({ ...OWN, id: `off-${index}`, name: `Offer ${index}` }))
  }

  mount({ identity: identityOf('agent-1') })
  await openOwn(/My offerings/)
  await screen.findByText('Offer 39')

  const create = screen.getByRole('button', { name: /New offering/ })

  // The button stays a live tooltip trigger (F-r3-C1a): aria-disabled, and the
  // click below is swallowed — no form, no CLI.
  expect(create.getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByText('40 / 40')).toBeTruthy()
  expect(screen.getByText('ACP allows 40 offerings per agent — delete one before adding another.')).toBeTruthy()

  fireEvent.click(create)

  expect(screen.queryByRole('form', { name: 'New offering' })).toBeNull()
  expect(argvOf('offering create')).toHaveLength(0)
})

test('deleting an offering asks once more, then sends --force', async () => {
  overrides = { 'offering list': [OWN], 'offering delete': { success: true } }

  mount({ identity: identityOf('agent-1') })
  await openOwn(/My offerings/)
  fireEvent.click(await screen.findByText('Crypto news report'))
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

  const confirm = screen.getByRole('group', { name: 'Confirm delete' })

  expect(within(confirm).getByText(/Delete “Crypto news report”\?/)).toBeTruthy()
  expect(argvOf('offering delete')).toHaveLength(0)

  fireEvent.click(within(confirm).getByRole('button', { name: /Delete offering/ }))

  await waitFor(() => expect(argvOf('offering delete')).toHaveLength(1))
  expect(argvOf('offering delete')[0]).toEqual(['offering', 'delete', '--offering-id', 'off-1', '--force', '--json'])
  expect(await screen.findByText('Deleted “Crypto news report”.')).toBeTruthy()
})

test('keeping an offering sends nothing', async () => {
  overrides = { 'offering list': [OWN] }

  mount({ identity: identityOf('agent-1') })
  await openOwn(/My offerings/)
  fireEvent.click(await screen.findByText('Crypto news report'))
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
  fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))

  expect(screen.queryByRole('group', { name: 'Confirm delete' })).toBeNull()
  expect(argvOf('offering delete')).toHaveLength(0)
})

test('editing an offering sends only what changed', async () => {
  overrides = { 'offering list': [OWN], 'subscription list': [], 'offering update': { ...OWN, priceValue: 0.02 } }

  mount({ identity: identityOf('agent-1') })
  await openOwn(/My offerings/)
  fireEvent.click(await screen.findByText('Crypto news report'))
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

  const form = await screen.findByRole('form', { name: 'Edit offering' })
  const save = within(form).getByRole('button', { name: 'Save changes' })

  // The saved schema reopens in the builder, and nothing changed yet.
  expect(within(form).getByRole('textbox', { name: 'Requirements field 1 name' })).toHaveProperty('value', 'ticker')
  expect(save.hasAttribute('disabled')).toBe(true)

  fireEvent.change(within(form).getByRole('textbox', { name: 'Price' }), { target: { value: '0.02' } })
  fireEvent.click(save)

  await waitFor(() => expect(argvOf('offering update')).toHaveLength(1))
  expect(argvOf('offering update')[0]).toEqual([
    'offering',
    'update',
    '--offering-id',
    'off-1',
    '--price-value',
    '0.02',
    '--json'
  ])
})

test('a refused write keeps the form and says why', async () => {
  overrides = {
    'subscription list': [],
    'offering create': { error: 'HTTP 400: {"message":"Offering limit of 40 reached"}' }
  }

  mount({ identity: identityOf('agent-1') })
  await openOwn(/My offerings/)
  await screen.findByText('No offerings yet')
  fireEvent.click(screen.getAllByRole('button', { name: /New offering/ })[0])

  const form = await screen.findByRole('form', { name: 'New offering' })

  fireEvent.change(within(form).getByRole('textbox', { name: 'Name' }), { target: { value: 'Token report' } })
  fireEvent.change(within(form).getByRole('textbox', { name: 'Description' }), { target: { value: 'A digest.' } })
  fireEvent.change(within(form).getByRole('textbox', { name: 'Price' }), { target: { value: '1' } })
  fireEvent.click(
    within(within(form).getByRole('group', { name: 'Requirements' })).getByRole('tab', { name: 'Plain text' })
  )
  fireEvent.change(within(form).getByRole('textbox', { name: 'Requirements — plain text' }), {
    target: { value: 'The ticker.' }
  })
  fireEvent.change(within(form).getByRole('textbox', { name: 'Deliverable — plain text' }), {
    target: { value: 'A report.' }
  })
  fireEvent.click(within(form).getByRole('button', { name: 'Create offering' }))

  expect(await within(form).findByText('Offering limit of 40 reached')).toBeTruthy()
  expect(within(form).getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'Token report')
})

test('My resources publishes a new endpoint and hands changes to the iNFT', async () => {
  overrides = {
    'resource list': [],
    'resource create': { id: 'res-9', name: 'Price feed' }
  }

  mount({ identity: identityOf('agent-1') })
  await openOwn(/My resources/)
  await waitFor(() => expect(commands()).toContain('resource list --json'))
  fireEvent.click((await screen.findAllByRole('button', { name: /New resource/ }))[0])

  const form = await screen.findByRole('form', { name: 'New resource' })

  fireEvent.change(within(form).getByRole('textbox', { name: 'Name' }), { target: { value: 'Price feed' } })
  fireEvent.change(within(form).getByRole('textbox', { name: 'Description' }), { target: { value: 'Live prices.' } })
  fireEvent.change(within(form).getByRole('textbox', { name: 'URL' }), {
    target: { value: 'https://api.example.com/price' }
  })
  fireEvent.click(within(form).getByRole('button', { name: 'Add field' }))
  fireEvent.change(within(form).getByRole('textbox', { name: 'Params field 1 name' }), { target: { value: 'symbol' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Publish resource' }))

  await waitFor(() => expect(argvOf('resource create')).toHaveLength(1))
  expect(argvOf('resource create')[0]).toEqual([
    'resource',
    'create',
    '--name',
    'Price feed',
    '--description',
    'Live prices.',
    '--url',
    'https://api.example.com/price',
    '--params',
    '{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]}',
    '--no-hidden',
    '--json'
  ])
  expect(await screen.findByText('Published “Price feed”.')).toBeTruthy()
})
