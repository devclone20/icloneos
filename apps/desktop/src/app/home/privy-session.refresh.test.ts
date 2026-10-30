// The Home roster after V3-H r2 (critic MAJOR-1, MEDIUM-1): the full wallet scan
// runs on sign-in and Rescan only; the 3-minute refresh sends main the checked
// ids and applies page 1 + ownerOf verdicts; an incomplete scan merges and never
// drops a checked iNFT; the O1 seed waits for a complete scan and the guard's records.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fixtureId, fixtureItem } from '@/app/settings/inft-book/book-fixture'
import { homeCards } from '@/app/settings/inft-book/book-model'
import type { HomeTickResult } from '@/app/settings/inft-book/book-types'
import { slugForInft } from '@/iclone-shared/inft-slug'

import type { InftScanResult } from './inft-scan'

const ADDRESS = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'
const OTHER = '0x1111111111111111111111111111111111111111'

const spies = vi.hoisted(() => ({
  remembered: { value: null as null | string },
  configured: { value: {} as Record<string, { configured: boolean }> }
}))

vi.mock('./inft-profile', () => ({ buildAllProfiles: () => Promise.resolve() }))
vi.mock('./inft-switch', () => ({ switchInft: () => Promise.resolve(), deselectInft: vi.fn() }))
vi.mock('./econ/badges', () => ({ clearEconBadges: vi.fn() }))
vi.mock('./econ/prefetch', () => ({ forgetPrefetch: vi.fn() }))
vi.mock('./ownership', async () => {
  const { atom } = await import('nanostores')
  const { slugForInft } = await import('@/iclone-shared/inft-slug')

  return {
    $ownership: atom({}),
    observeOwnership: () => Promise.resolve(),
    ownershipForId: (map: Record<string, unknown>, id: string) => map[slugForInft(id)] ?? null,
    startOwnershipSync: vi.fn(),
    withDeactivatedCards: <T>(cards: T[]) => cards
  }
})
vi.mock('./acp-setup', async () => {
  const { atom } = await import('nanostores')
  const $acpConfigMap = atom<Record<string, { configured: boolean }>>({})

  return {
    $acpConfigMap,
    refreshAcpConfigMap: () => {
      $acpConfigMap.set(spies.configured.value)

      return Promise.resolve()
    }
  }
})
vi.mock('./stage-store', async () => {
  const { atom } = await import('nanostores')

  return { $activeInft: atom(null), HERMES_CHOICE: 'hermes', recallInftChoice: () => spies.remembered.value }
})

const agent = (i: number) => ({ ...fixtureItem(i), model: `https://m/${i}.glb` })
const wallet = (n: number) => Array.from({ length: n }, (_, i) => agent(i))

const full = (agents: InftScanResult['agents'], complete: boolean): InftScanResult => ({
  ok: true,
  source: 'indexer',
  agents,
  complete
})

interface Bridges {
  scan: (address: string) => Promise<InftScanResult>
  scanTick?: (address: string, ids: string[]) => Promise<HomeTickResult>
  ownershipList?: () => Promise<unknown[]>
}

async function boot(bridges: Bridges) {
  vi.resetModules()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    iclonePrivy: {
      open: vi.fn(),
      logout: vi.fn(() => Promise.resolve({ ok: true })),
      scan: bridges.scan,
      scanTick: bridges.scanTick,
      resolveProfile: vi.fn(),
      onSession: () => () => undefined
    },
    ...(bridges.ownershipList ? { icloneOwnership: { list: bridges.ownershipList } } : {})
  }

  const session = await import('./privy-session')
  const book = await import('@/app/settings/inft-book/book-store')

  session.$privySession.set({ status: 'in', address: ADDRESS })

  return { book, session }
}

const rosterIds = (session: Awaited<ReturnType<typeof boot>>['session']) => session.$inftRoster.get().map(c => c.id)

beforeEach(() => {
  window.localStorage.clear()
  spies.remembered.value = null
  spies.configured.value = {}
})

describe('an incomplete full scan merges with the last good roster', () => {
  it('page 3 fails on the next scan: a checked iNFT from page 3 stays on the roster (and on Home)', async () => {
    const answers = [full(wallet(150), true), full(wallet(100), false)]
    const { book, session } = await boot({ scan: () => Promise.resolve(answers.shift()!) })

    await session.rescan()
    book.checkShown(ADDRESS, [{ id: fixtureId(5) }, { id: fixtureId(120) }])
    await session.rescan()

    expect(session.$inftRoster.get()).toHaveLength(150)
    expect(rosterIds(session)).toContain(fixtureId(120))
    expect(session.$inftRosterStatus.get()).toBe('ready')
  })

  it('a complete scan replaces the roster (a sent iNFT leaves)', async () => {
    const answers = [full(wallet(150), true), full(wallet(100), true)]
    const { session } = await boot({ scan: () => Promise.resolve(answers.shift()!) })

    await session.rescan()
    await session.rescan()

    expect(session.$inftRoster.get()).toHaveLength(100)
  })

  it("never merges another wallet's cards", async () => {
    const answers = [full(wallet(150), true), full(wallet(10), false)]
    const { session } = await boot({ scan: () => Promise.resolve(answers.shift()!) })

    await session.rescan()
    session.$privySession.set({ status: 'in', address: OTHER })
    await session.rescan()

    expect(session.$inftRoster.get()).toHaveLength(10)
  })
})

describe('the 3-minute refresh (refreshRoster)', () => {
  it('sends only the checked ids, appends page-1 arrivals, drops a proven-gone card, keeps an unknown one', async () => {
    const scanTick = vi.fn((_address: string, _ids: string[]) =>
      Promise.resolve<HomeTickResult>({
        ok: true,
        skipped: false,
        arrivals: [agent(0), agent(300)],
        owners: { [fixtureId(5)]: 'gone', [fixtureId(9)]: 'unknown', [fixtureId(7)]: 'held' }
      })
    )

    const scan = vi.fn(() => Promise.resolve(full(wallet(150), true)))
    const { book, session } = await boot({ scan, scanTick })

    await session.rescan()
    book.checkShown(ADDRESS, [{ id: fixtureId(5) }, { id: fixtureId(7) }, { id: fixtureId(9) }])

    const statuses: string[] = []
    const stop = session.$inftRosterStatus.listen(status => statuses.push(status))

    await session.refreshRoster()
    stop()

    expect(scan).toHaveBeenCalledTimes(1)
    expect(scanTick).toHaveBeenCalledWith(ADDRESS, [fixtureId(5), fixtureId(7), fixtureId(9)])

    const ids = rosterIds(session)

    expect(ids).toHaveLength(150)
    expect(ids).not.toContain(fixtureId(5))
    expect(ids).toContain(fixtureId(9))
    expect(ids.at(-1)).toBe(fixtureId(300))
    // No loading flicker: the refresh never touches the status.
    expect(statuses).toEqual([])
  })

  it('is skipped while a full scan is in flight (no overlapping scans)', async () => {
    let finish: (value: InftScanResult) => void = () => undefined

    const scanTick = vi.fn(() =>
      Promise.resolve<HomeTickResult>({ ok: true, skipped: false, arrivals: [], owners: {} })
    )

    const { session } = await boot({ scan: () => new Promise(resolve => (finish = resolve)), scanTick })

    const pending = session.rescan()

    await session.refreshRoster()
    await session.refreshRoster()
    expect(scanTick).not.toHaveBeenCalled()

    finish(full(wallet(3), true))
    await pending
    await session.refreshRoster()
    expect(scanTick).toHaveBeenCalledTimes(1)
  })

  it('two refreshes never overlap; main saying "skipped" changes nothing', async () => {
    let finish: (value: HomeTickResult) => void = () => undefined
    const scanTick = vi.fn(() => new Promise<HomeTickResult>(resolve => (finish = resolve)))
    const { session } = await boot({ scan: () => Promise.resolve(full(wallet(3), true)), scanTick })

    await session.rescan()

    const first = session.refreshRoster()

    await session.refreshRoster()
    expect(scanTick).toHaveBeenCalledTimes(1)
    finish({ ok: true, skipped: true, arrivals: [agent(99)], owners: {} })
    await first
    expect(session.$inftRoster.get()).toHaveLength(3)
  })

  it('a refresh that lands after sign-out writes nothing', async () => {
    let finish: (value: HomeTickResult) => void = () => undefined

    const { session } = await boot({
      scan: () => Promise.resolve(full(wallet(3), true)),
      scanTick: () => new Promise(resolve => (finish = resolve))
    })

    await session.rescan()

    const pending = session.refreshRoster()

    session.logoutPrivy()
    finish({ ok: true, skipped: false, arrivals: [agent(50)], owners: {} })
    await pending
    expect(session.$inftRoster.get()).toEqual([])
  })
})

describe('O1, the upgrade seed (MEDIUM-1)', () => {
  it('a partial first scan writes no seed; the next complete scan seeds, once', async () => {
    spies.remembered.value = fixtureId(120)

    const answers = [full(wallet(100), false), full(wallet(150), true), full(wallet(150), true)]
    const { book, session } = await boot({ scan: () => Promise.resolve(answers.shift()!) })

    await session.rescan()
    expect(book.selectionFor(book.$bookChecked.get(), ADDRESS)).toBeNull()

    await session.rescan()
    expect(book.selectionFor(book.$bookChecked.get(), ADDRESS)).toEqual({ ids: [fixtureId(120)], kept: 1 })

    spies.remembered.value = fixtureId(1)
    await session.rescan()
    expect(book.selectionFor(book.$bookChecked.get(), ADDRESS)?.ids).toEqual([fixtureId(120)])
  })

  it("waits for the ownership guard's records: main not answering writes no seed; its records count once it does", async () => {
    const slug = `base-${fixtureId(42).split(':')[1]}-43`
    const lists = [() => Promise.reject(new Error('not ready')), () => Promise.resolve([{ slug, state: 'held' }])]

    const { book, session } = await boot({
      scan: () => Promise.resolve(full(wallet(60), true)),
      ownershipList: () => lists.shift()!()
    })

    await session.rescan()
    expect(book.selectionFor(book.$bookChecked.get(), ADDRESS)).toBeNull()

    await session.rescan()
    expect(book.selectionFor(book.$bookChecked.get(), ADDRESS)).toEqual({ ids: [fixtureId(42)], kept: 1 })
  })
})

describe('the 3-minute timer', () => {
  it('signed in for 9 minutes: 1 full scan (sign-in), 3 refreshes — never another full scan', async () => {
    vi.useFakeTimers()

    try {
      const scan = vi.fn(() => Promise.resolve(full(wallet(3), true)))

      const scanTick = vi.fn(() =>
        Promise.resolve<HomeTickResult>({ ok: true, skipped: false, arrivals: [], owners: {} })
      )

      const { session } = await boot({ scan, scanTick })

      await session.rescan()
      await vi.advanceTimersByTimeAsync(9 * 60_000)

      expect(scan).toHaveBeenCalledTimes(1)
      expect(scanTick).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

const OFFLINE: InftScanResult = { ok: true, source: 'none', agents: [], complete: false }
const idle = () => Promise.resolve<HomeTickResult>({ ok: true, skipped: false, arrivals: [], owners: {} })

/** The first `n` of `wallet(150)` set up (a configured Virtuals CLI). */
function configure(n: number) {
  spies.configured.value = Object.fromEntries(
    Array.from({ length: n }, (_, i) => [slugForInft(fixtureId(i)), { configured: true }])
  )
}

async function withFakeTime(run: () => Promise<void>) {
  vi.useFakeTimers()

  try {
    await run()
  } finally {
    vi.useRealTimers()
  }
}

describe('N1: the sign-in scan recovers on its own (capped backoff)', () => {
  it('120 configured, offline at sign-in, then online: within 30 s the seed lands and Home shows the 120', () =>
    withFakeTime(async () => {
      configure(120)

      const answers = [OFFLINE, full(wallet(150), true)]
      const scan = vi.fn(() => Promise.resolve(answers.shift() ?? full(wallet(150), true)))
      const { book, session } = await boot({ scan, scanTick: idle })

      await session.rescan({ present: true })
      expect(book.selectionFor(book.$bookChecked.get(), ADDRESS)).toBeNull()
      expect(session.$inftRoster.get()).toEqual([])

      await vi.advanceTimersByTimeAsync(30_000)

      expect(scan).toHaveBeenCalledTimes(2)

      const seeded = book.selectionFor(book.$bookChecked.get(), ADDRESS)

      expect(seeded?.ids).toHaveLength(120)
      expect(homeCards(session.$inftRoster.get(), new Set(seeded?.ids))).toHaveLength(120)

      // Seeded: no more full scans, only the 3-minute refresh.
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(scan).toHaveBeenCalledTimes(2)
    }))

  it('the backoff: 30 s, 1 min, 2 min, 5 min, then every 15 min while the scan stays incomplete', () =>
    withFakeTime(async () => {
      const at: number[] = []
      const start = Date.now()

      const scan = vi.fn(() => {
        at.push((Date.now() - start) / 1_000)

        return Promise.resolve(full(wallet(50), false))
      })

      const { session } = await boot({ scan, scanTick: idle })

      await session.rescan()
      await vi.advanceTimersByTimeAsync(40 * 60_000)

      expect(at).toEqual([0, 30, 90, 210, 510, 1_410, 2_310])
    }))

  it('never two full scans at once: slow incomplete retries and the 3-minute ticks stay serial', () =>
    withFakeTime(async () => {
      let running = 0
      let most = 0

      const scan = vi.fn(async () => {
        running += 1
        most = Math.max(most, running)
        await new Promise(resolve => setTimeout(resolve, 45_000))
        running -= 1

        return full(wallet(50), false)
      })

      const scanTick = vi.fn(idle)
      const { session } = await boot({ scan, scanTick })

      const first = session.rescan()

      // A manual Rescan (the Book's) 15 s before the first retry is due, still running when it would fire.
      await vi.advanceTimersByTimeAsync(60_000)
      const manual = session.rescan()

      await vi.advanceTimersByTimeAsync(20 * 60_000)
      await Promise.all([first, manual])

      expect(scan.mock.calls.length).toBeGreaterThanOrEqual(5)
      expect(most).toBe(1)
      // The refresh never ran beside a full scan either.
      expect(scanTick.mock.calls.length).toBeLessThan(7)
    }))

  it('sign-out cancels the pending retry; a wallet switch restarts the backoff for the new wallet only', () =>
    withFakeTime(async () => {
      const scan = vi.fn((_address: string) => Promise.resolve(full(wallet(50), false)))
      const { session } = await boot({ scan, scanTick: idle })

      await session.rescan()

      const pending = vi.getTimerCount()

      session.logoutPrivy()
      // The retry timer itself is gone, not merely ignored when it fires — and so is the 3-minute refresh (K75).
      expect(vi.getTimerCount()).toBe(pending - 2)
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(scan).toHaveBeenCalledTimes(1)

      session.$privySession.set({ status: 'in', address: ADDRESS })
      await session.rescan()
      session.$privySession.set({ status: 'in', address: OTHER })
      await session.rescan()
      await vi.advanceTimersByTimeAsync(30_000)

      expect(scan.mock.calls.map(([address]) => address)).toEqual([ADDRESS, ADDRESS, OTHER, OTHER])
    }))

  // Each test boots a fresh module (vi.resetModules), and earlier modules' window listeners stay attached,
  // so these call the exported handler directly and check the wiring once, by reference.
  it('K75: the 3-minute refresh runs only while signed in, and skips a tick while the window is hidden', () =>
    withFakeTime(async () => {
      const scanTick = vi.fn(idle)
      const { session } = await boot({ scan: () => Promise.resolve(full(wallet(3), true)), scanTick })

      await session.rescan()
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)

      await vi.advanceTimersByTimeAsync(9 * 60_000)
      expect(scanTick).not.toHaveBeenCalled()

      hidden.mockReturnValue(false)
      await vi.advanceTimersByTimeAsync(3 * 60_000)
      expect(scanTick).toHaveBeenCalledTimes(1)

      session.logoutPrivy()
      expect(vi.getTimerCount()).toBe(0)
      hidden.mockRestore()
    }))

  it('K75: only the primary window owns the refresh', async () => {
    const { session } = await boot({ scan: () => Promise.resolve(OFFLINE), scanTick: idle })

    expect(session.isRosterOwnerWindow()).toBe(true)

    const windows = await import('@/store/windows')
    const peer = vi.spyOn(windows, 'isPeerInstanceWindow').mockReturnValue(true)

    expect(session.isRosterOwnerWindow()).toBe(false)
    peer.mockRestore()
  })

  it('K19: the session module listens for the window going back online', async () => {
    const listen = vi.spyOn(window, 'addEventListener')
    const { session } = await boot({ scan: () => Promise.resolve(OFFLINE), scanTick: idle })

    expect(listen).toHaveBeenCalledWith('online', session.onBackOnline)
    listen.mockRestore()
  })

  it('K19: back online after a long outage, the parked retry runs at once and its backoff restarts at 30 s', () =>
    withFakeTime(async () => {
      const at: number[] = []
      const start = Date.now()
      let online = false

      const scan = vi.fn(() => {
        at.push((Date.now() - start) / 1_000)

        return Promise.resolve(online ? full(wallet(50), true) : OFFLINE)
      })

      const { session } = await boot({ scan, scanTick: idle })

      await session.rescan()
      // 0, 30, 90, 210, 510 — and the next try is parked on the 15-minute step (1 410 s).
      await vi.advanceTimersByTimeAsync(1_000_000)
      expect(at).toEqual([0, 30, 90, 210, 510])

      session.onBackOnline()
      await vi.advanceTimersByTimeAsync(0)
      expect(at).toEqual([0, 30, 90, 210, 510, 1_000])

      // Still failing: the next try is 30 s later, not at 1 410 s.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(at).toEqual([0, 30, 90, 210, 510, 1_000, 1_030])

      online = true
      session.onBackOnline()
      await vi.advanceTimersByTimeAsync(0)
      expect(at).toEqual([0, 30, 90, 210, 510, 1_000, 1_030, 1_030])
      expect(session.$inftRosterStatus.get()).toBe('ready')
    }))

  it('K19: online with no retry pending, or after sign-out, starts nothing', () =>
    withFakeTime(async () => {
      const scan = vi.fn(() => Promise.resolve(OFFLINE))
      const { session } = await boot({ scan, scanTick: idle })

      session.onBackOnline()
      await vi.advanceTimersByTimeAsync(0)
      expect(scan).not.toHaveBeenCalled()

      await session.rescan()
      session.logoutPrivy()
      session.onBackOnline()
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(scan).toHaveBeenCalledTimes(1)
    }))

  it('K21: a refused scan (main answers null) is a plain error and a retry, never a TypeError', () =>
    withFakeTime(async () => {
      const answers: (InftScanResult | null)[] = [null]
      const scan = vi.fn(() => Promise.resolve(answers.length ? answers.shift()! : full(wallet(3), true)))
      const { session } = await boot({ scan: scan as unknown as Bridges['scan'], scanTick: idle })

      await session.rescan()
      expect(session.$inftRosterStatus.get()).toBe('error')
      expect(session.$inftRosterError.get()).toBe('The wallet scan was refused.')

      await vi.advanceTimersByTimeAsync(30_000)
      expect(scan).toHaveBeenCalledTimes(2)
      expect(session.$inftRosterStatus.get()).toBe('ready')
    }))

  it('a failed scan (ok: false) is retried the same way', () =>
    withFakeTime(async () => {
      configure(3)

      const answers: InftScanResult[] = [{ ok: false, source: 'none', agents: [], error: 'offline' }]
      const scan = vi.fn(() => Promise.resolve(answers.shift() ?? full(wallet(150), true)))
      const { book, session } = await boot({ scan, scanTick: idle })

      await session.rescan()
      expect(session.$inftRosterStatus.get()).toBe('error')
      await vi.advanceTimersByTimeAsync(30_000)

      expect(session.$inftRosterStatus.get()).toBe('ready')
      expect(book.selectionFor(book.$bookChecked.get(), ADDRESS)?.ids).toHaveLength(3)
    }))
})

describe('N1: a wallet past the 5 000 ceiling is seeded', () => {
  it('a capped Home scan (first 5 000 of a larger wallet) writes the seed and schedules no retry', () =>
    withFakeTime(async () => {
      configure(10)

      const scan = vi.fn(() =>
        Promise.resolve<InftScanResult>({
          ok: true,
          source: 'indexer',
          agents: wallet(5_000),
          complete: false,
          capped: true
        })
      )

      const { book, session } = await boot({ scan, scanTick: idle })

      await session.rescan()
      expect(book.selectionFor(book.$bookChecked.get(), ADDRESS)?.ids).toHaveLength(10)

      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(scan).toHaveBeenCalledTimes(1)
    }))
})

describe('K20: once the Book has a selection, an incomplete or failed scan is not retried on a timer', () => {
  it('seeded wallet, indexer stays incomplete: 0 timed full scans in 2 h (was 13)', () =>
    withFakeTime(async () => {
      const scan = vi.fn(() => Promise.resolve(full(wallet(50), false)))
      const { book, session } = await boot({ scan, scanTick: idle })

      book.seedOnce(ADDRESS, [fixtureId(1)])
      await session.rescan()
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)

      expect(scan).toHaveBeenCalledTimes(1)
    }))

  it('seeded wallet, scan throws or main refuses: no timed retry either', () =>
    withFakeTime(async () => {
      const answers: (() => Promise<InftScanResult>)[] = [
        () => Promise.reject(new Error('indexer down')),
        () => Promise.resolve(null as unknown as InftScanResult)
      ]

      for (const answer of answers) {
        const scan = vi.fn(answer)
        const { book, session } = await boot({ scan, scanTick: idle })

        book.seedOnce(ADDRESS, [fixtureId(1)])
        await session.rescan()
        await vi.advanceTimersByTimeAsync(60 * 60_000)

        expect(scan).toHaveBeenCalledTimes(1)
        session.$privySession.set({ status: 'out' })
      }
    }))

  it('the seed landing mid-backoff stops the retries that were already scheduled', () =>
    withFakeTime(async () => {
      const scan = vi.fn(() => Promise.resolve(full(wallet(50), false)))
      const { book, session } = await boot({ scan, scanTick: idle })

      await session.rescan()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(scan).toHaveBeenCalledTimes(2)

      book.seedOnce(ADDRESS, [fixtureId(1)])
      await vi.advanceTimersByTimeAsync(60_000)
      // The retry already armed runs once, sees the selection, and arms nothing more.
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
      expect(scan).toHaveBeenCalledTimes(3)
    }))
})

describe('K19, the two guards with no test before (V3-K critic r1 m4)', () => {
  it('back online while a full scan is already running: that scan decides, no second scan starts', () =>
    withFakeTime(async () => {
      let finish: (result: InftScanResult) => void = () => undefined

      const answers: (() => Promise<InftScanResult>)[] = [
        () => Promise.resolve(OFFLINE),
        () => new Promise<InftScanResult>(resolve => (finish = resolve))
      ]

      const scan = vi.fn(() => (answers.shift() ?? (() => Promise.resolve(OFFLINE)))())
      const { session } = await boot({ scan, scanTick: idle })

      await session.rescan()
      expect(scan).toHaveBeenCalledTimes(1)

      // A Rescan starts a full scan that does not answer yet; the parked seed retry is still there.
      void session.rescan()
      await vi.advanceTimersByTimeAsync(0)
      expect(scan).toHaveBeenCalledTimes(2)

      session.onBackOnline()
      await vi.advanceTimersByTimeAsync(0)
      expect(scan).toHaveBeenCalledTimes(2)

      finish(full(wallet(10), true))
      await vi.advanceTimersByTimeAsync(0)
      expect(session.$inftRosterStatus.get()).toBe('ready')
    }))

  it('back online after the session moved to another wallet: the old wallet’s retry is cancelled, nothing scans', () =>
    withFakeTime(async () => {
      const scan = vi.fn(() => Promise.resolve(OFFLINE))
      const { session } = await boot({ scan, scanTick: idle })

      await session.rescan()
      expect(scan).toHaveBeenCalledTimes(1)

      session.$privySession.set({ status: 'in', address: OTHER })
      session.onBackOnline()
      await vi.advanceTimersByTimeAsync(0)
      expect(scan).toHaveBeenCalledTimes(1)

      // Cancelled, not merely skipped: the 30 s retry of the old wallet never fires either.
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(scan).toHaveBeenCalledTimes(1)
    }))
})
