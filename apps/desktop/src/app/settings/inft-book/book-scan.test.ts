import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { INftCardData } from '@/app/home/collections'

import { FIXTURE_ADDRESS, fixtureBridge, fixtureId } from './book-fixture'

vi.mock('@/app/home/privy-session', async () => {
  const { atom: makeAtom } = await import('nanostores')
  const $privySession = makeAtom<{ status: 'in' | 'out'; address?: string }>({ status: 'out' })
  const $inftRoster = makeAtom<INftCardData[]>([])

  return { $inftRoster, $privySession }
})

type Bridge = ReturnType<typeof fixtureBridge>['bookScan']

async function boot(bookScan: Bridge) {
  vi.resetModules()
  window.localStorage.clear()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { iclonePrivy: { bookScan } }

  const privy = await import('@/app/home/privy-session')

  privy.$privySession.set({ status: 'in', address: FIXTURE_ADDRESS })

  const scan = await import('./book-scan')
  const store = await import('./book-store')

  return { privy, scan, store }
}

beforeEach(async () => {
  vi.restoreAllMocks()
  // The mocked roster atom outlives a module boot: every test starts with an empty roster.
  ;(await import('@/app/home/privy-session')).$inftRoster.set([])
})

describe('the Book scan (G5)', () => {
  it('reads a 1 000-item wallet page by page; the first page is visible before the last is asked for', async () => {
    const fixture = fixtureBridge(1_000)
    let sizeWhenLastAsked = -1

    const bookScan: Bridge = (address, cursor) => {
      if (cursor?.params?.page === 19) {
        sizeWhenLastAsked = store.$bookItems.get().size
      }

      return fixture.bookScan(address, cursor)
    }

    const { scan, store } = await boot(bookScan)

    await scan.startBookScan()

    expect(store.$bookItems.get().size).toBe(1_000)
    expect(store.$bookScan.get()).toMatchObject({ status: 'done', error: null })
    expect(fixture.requested).toEqual(Array.from({ length: 20 }, (_, i) => i))
    expect(sizeWhenLastAsked).toBe(950)
  })

  it('stops at the 5 000 ceiling and says it was capped — never done, so it never prunes', async () => {
    const fixture = fixtureBridge(6_000)
    const { scan, store } = await boot(fixture.bookScan)

    store.seedOnce(FIXTURE_ADDRESS, [fixtureId(5_500)])
    await scan.startBookScan()

    expect(store.$bookItems.get().size).toBe(5_000)
    expect(store.$bookScan.get().status).toBe('capped')
    expect(store.selectionFor(store.$bookChecked.get(), FIXTURE_ADDRESS)?.ids).toEqual([fixtureId(5_500)])
  })

  it('O1: a complete Book scan writes the upgrade seed once; so does a capped one (N1: the most the app reads)', async () => {
    const capped = await boot(fixtureBridge(6_000).bookScan)

    await capped.scan.startBookScan()
    expect(capped.store.$bookScan.get().status).toBe('capped')
    expect(capped.store.selectionFor(capped.store.$bookChecked.get(), FIXTURE_ADDRESS)).toEqual({ ids: [], kept: 0 })

    const complete = await boot(fixtureBridge(120).bookScan)

    await complete.scan.startBookScan()
    expect(complete.store.selectionFor(complete.store.$bookChecked.get(), FIXTURE_ADDRESS)).toEqual({
      ids: [],
      kept: 0
    })
  })

  it('K71: the ceiling reached inside the LAST page is capped, not done, and prunes nothing', async () => {
    // 20 roster cards the indexer does not list (an RPC-only find) + a 4 990-item wallet: the last page crosses 5 000.
    const fixture = fixtureBridge(4_990)
    const { privy, scan, store } = await boot(fixture.bookScan)

    privy.$inftRoster.set(
      Array.from({ length: 20 }, (_, i) => ({
        id: `base:0x00000000000000000000000000000000000000aa:${i + 1}`,
        name: `rpc ${i}`,
        collection: 'C',
        chain: 'Base',
        imageUrl: '',
        configured: false
      }))
    )
    store.checkShown(FIXTURE_ADDRESS, [{ id: fixtureId(4_989) }])
    await scan.startBookScan()

    expect(store.$bookItems.get().size).toBe(5_000)
    expect(store.$bookItems.get().has(fixtureId(4_989))).toBe(false)
    expect(store.$bookScan.get().status).toBe('capped')
    expect([...store.checkedSet(FIXTURE_ADDRESS)]).toEqual([fixtureId(4_989)])
  })

  it('exactly 5 000 is the whole wallet: done, not capped', async () => {
    const { scan, store } = await boot(fixtureBridge(5_000).bookScan)

    await scan.startBookScan()

    expect(store.$bookScan.get().status).toBe('done')
  })

  it('a failed page 3 keeps pages 1-2 and offers retry from page 3; the retry finishes the wallet', async () => {
    const failing = new Set([2])
    const fixture = fixtureBridge(1_000, failing)
    const { scan, store } = await boot(fixture.bookScan)

    await scan.startBookScan()

    expect(store.$bookItems.get().size).toBe(100)
    expect(store.$bookScan.get()).toMatchObject({ status: 'partial', cursor: { params: { page: 2 } } })
    failing.clear()
    await scan.retryBookScan()
    expect(store.$bookItems.get().size).toBe(1_000)
    expect(fixture.requested.filter(page => page < 2)).toEqual([0, 1])
  })

  it('a partial scan prunes 0 checked ids; a complete scan prunes exactly the missing ones', async () => {
    const failing = new Set([2])
    const fixture = fixtureBridge(1_000, failing)
    const { scan, store } = await boot(fixture.bookScan)
    const gone = `base:0xdead:1`

    store.checkShown(FIXTURE_ADDRESS, [{ id: fixtureId(0) }, { id: fixtureId(900) }, { id: gone }])
    await scan.startBookScan()
    expect([...store.checkedSet(FIXTURE_ADDRESS)]).toEqual([fixtureId(0), fixtureId(900), gone])
    failing.clear()
    await scan.retryBookScan()
    expect([...store.checkedSet(FIXTURE_ADDRESS)]).toEqual([fixtureId(0), fixtureId(900)])
  })

  it('K65: an indexer that answers empty pages with a fresh cursor forever stops at the page cap, retryable', async () => {
    let calls = 0

    const bookScan: Bridge = (_address, cursor) => {
      calls += 1

      const page = typeof cursor?.params?.page === 'number' ? cursor.params.page : 0

      // A safety stop for the test itself, far past the cap: an uncapped loop fails here instead of hanging.
      return Promise.resolve(
        calls > 1_000
          ? { ok: false, items: [], cursor, done: false, error: 'test stop' }
          : { ok: true, items: [], cursor: { chain: 'Base', params: { page: page + 1 } }, done: false }
      )
    }

    const { scan, store } = await boot(bookScan)

    await scan.startBookScan()

    expect(calls).toBe(110)
    expect(store.$bookScan.get()).toMatchObject({
      status: 'partial',
      error: 'page cap',
      cursor: { params: { page: 110 } }
    })
  })

  it('K65: a next cursor equal to the one just sent stops the scan, keeping what was read', async () => {
    let calls = 0
    const fixture = fixtureBridge(1_000)

    const bookScan: Bridge = async (address, cursor) => {
      calls += 1

      const page = await fixture.bookScan(address, cursor)

      return cursor?.params?.page === 2 ? { ...page, cursor } : page
    }

    const { scan, store } = await boot(bookScan)

    await scan.startBookScan()

    expect(calls).toBe(3)
    expect(store.$bookItems.get().size).toBe(150)
    expect(store.$bookScan.get()).toMatchObject({ status: 'partial', error: 'cursor repeated' })
  })

  it('K65: a second chain gets its own page budget', async () => {
    const asked: string[] = []

    const bookScan: Bridge = (_address, cursor) => {
      const chain = cursor?.chain ?? 'Base'
      const page = typeof cursor?.params?.page === 'number' ? cursor.params.page : 0

      asked.push(chain)

      if (chain === 'Base' && page === 99) {
        return Promise.resolve({ ok: true, items: [], cursor: { chain: 'Robinhood', params: null }, done: false })
      }

      return Promise.resolve({
        ok: true,
        items: [],
        cursor: chain === 'Robinhood' && page === 49 ? null : { chain, params: { page: page + 1 } },
        done: chain === 'Robinhood' && page === 49
      })
    }

    const { scan, store } = await boot(bookScan)

    await scan.startBookScan()

    expect(asked.filter(chain => chain === 'Base')).toHaveLength(100)
    expect(asked.filter(chain => chain === 'Robinhood')).toHaveLength(50)
    expect(store.$bookScan.get().status).toBe('done')
  })

  it('K21: a refused sender (main answers null) ends as a retryable partial scan, never stuck on scanning', async () => {
    const fixture = fixtureBridge(200)
    let refuse = true

    const bookScan: Bridge = (address, cursor) =>
      refuse && cursor?.params?.page === 2
        ? (Promise.resolve(null) as unknown as ReturnType<Bridge>)
        : fixture.bookScan(address, cursor)

    const { scan, store } = await boot(bookScan)

    await scan.startBookScan()

    expect(store.$bookItems.get().size).toBe(100)
    expect(store.$bookScan.get()).toMatchObject({
      status: 'partial',
      error: 'refused',
      cursor: { params: { page: 2 } }
    })

    refuse = false
    await scan.retryBookScan()
    expect(store.$bookScan.get().status).toBe('done')
    expect(store.$bookItems.get().size).toBe(200)
  })

  it('sign-out mid-scan writes 0 items (ticket)', async () => {
    let release: () => void = () => undefined
    const fixture = fixtureBridge(1_000)

    const bookScan: Bridge = (address, cursor) =>
      cursor === null
        ? new Promise(resolve => {
            release = () => void fixture.bookScan(address, cursor).then(resolve)
          })
        : fixture.bookScan(address, cursor)

    const { privy, scan, store } = await boot(bookScan)
    const running = scan.startBookScan()

    privy.$privySession.set({ status: 'out' })
    release()
    await running

    expect(store.$bookItems.get().size).toBe(0)
    expect(store.$bookScan.get().status).toBe('idle')
  })

  it('an account switch mid-scan drops the old wallet pages', async () => {
    let release: () => void = () => undefined
    const fixture = fixtureBridge(100)

    const bookScan: Bridge = (address, cursor) =>
      new Promise(resolve => {
        release = () => void fixture.bookScan(address, cursor).then(resolve)
      })

    const { privy, scan, store } = await boot(bookScan)
    const running = scan.startBookScan()

    privy.$privySession.set({ status: 'in', address: '0x000000000000000000000000000000000000beef' })
    release()
    await running

    expect(store.$bookItems.get().size).toBe(0)
  })

  it('the roster seeds the Book at once and its (on-chain) card wins over the indexer copy', async () => {
    const fixture = fixtureBridge(50)
    const { privy, scan, store } = await boot(fixture.bookScan)
    privy.$inftRoster.set([
      {
        id: fixtureId(4),
        name: 'from roster',
        collection: 'C',
        chain: 'Base',
        imageUrl: 'https://chain/4.png',
        configured: false
      }
    ])
    await scan.startBookScan()

    expect(store.$bookItems.get().get(fixtureId(4))?.imageUrl).toBe('https://chain/4.png')
    expect(store.$bookItems.get().size).toBe(50)
  })
})
