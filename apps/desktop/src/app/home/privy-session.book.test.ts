// The iNFT Book rule inside the wallet scan (V3-H item 6, gate G6): a scan of
// 1 000 builds profiles only for checked + active, observes ownership for all,
// and auto-summons only among the checked.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fixtureId, fixtureItem } from '@/app/settings/inft-book/book-fixture'

const ADDRESS = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'

const spies = vi.hoisted(() => ({
  buildAllProfiles: vi.fn((_cards: { id: string }[]) => Promise.resolve()),
  observeOwnership: vi.fn((_wallet: string, _cards: { id: string }[]) => Promise.resolve()),
  switchInft: vi.fn((_card: { id: string }, _opts: unknown) => Promise.resolve()),
  remembered: { value: null as null | string },
  configured: { value: {} as Record<string, { configured: boolean }> }
}))

vi.mock('./inft-profile', () => ({ buildAllProfiles: spies.buildAllProfiles }))
vi.mock('./inft-switch', () => ({ switchInft: spies.switchInft, deselectInft: vi.fn() }))
vi.mock('./econ/badges', () => ({ clearEconBadges: vi.fn() }))
vi.mock('./econ/prefetch', () => ({ forgetPrefetch: vi.fn() }))
vi.mock('./ownership', async () => {
  const { atom } = await import('nanostores')

  return {
    $ownership: atom({}),
    observeOwnership: spies.observeOwnership,
    ownershipForId: () => null,
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

const agents = Array.from({ length: 1_000 }, (_, i) => ({ ...fixtureItem(i), model: `https://m/${i}.glb` }))

async function signIn() {
  vi.resetModules()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    iclonePrivy: {
      open: vi.fn(),
      logout: vi.fn(() => Promise.resolve({ ok: true })),
      scan: () => Promise.resolve({ ok: true, source: 'indexer', agents, complete: true }),
      resolveProfile: vi.fn(),
      onSession: () => () => undefined
    }
  }

  const session = await import('./privy-session')
  const book = await import('@/app/settings/inft-book/book-store')

  return { book, session }
}

async function scanAsSignIn(session: Awaited<ReturnType<typeof signIn>>['session']) {
  session.$privySession.set({ status: 'in', address: ADDRESS })
  await session.rescan({ present: true })
}

const ids = (calls: { id: string }[]) => calls.map(card => card.id)

beforeEach(() => {
  window.localStorage.clear()
  spies.buildAllProfiles.mockClear()
  spies.observeOwnership.mockClear()
  spies.switchInft.mockClear()
  spies.remembered.value = null
  spies.configured.value = {}
})

describe('a wallet scan under the iNFT Book rule', () => {
  it('builds profiles only for the checked iNFTs and observes ownership for all 1 000', async () => {
    const { book, session } = await signIn()

    book.seedOnce(ADDRESS, [fixtureId(10), fixtureId(500)])
    await scanAsSignIn(session)

    expect(spies.buildAllProfiles).toHaveBeenCalledTimes(1)
    expect(ids(spies.buildAllProfiles.mock.calls[0]![0])).toEqual([fixtureId(10), fixtureId(500)])
    expect(spies.observeOwnership.mock.calls[0]![1]).toHaveLength(1_000)
  })

  it('auto-summon picks among the checked only (the remembered one, when checked)', async () => {
    const { book, session } = await signIn()

    spies.remembered.value = fixtureId(500)
    book.seedOnce(ADDRESS, [fixtureId(10), fixtureId(500)])
    await scanAsSignIn(session)

    expect(spies.switchInft).toHaveBeenCalledTimes(1)
    expect(spies.switchInft.mock.calls[0]![0].id).toBe(fixtureId(500))
  })

  it('a remembered iNFT that is not checked is not summoned; the first checked one is', async () => {
    const { book, session } = await signIn()

    spies.remembered.value = fixtureId(3)
    book.seedOnce(ADDRESS, [fixtureId(10)])
    book.toggleBook(ADDRESS, fixtureId(10))
    book.toggleBook(ADDRESS, fixtureId(20))
    await scanAsSignIn(session)

    expect(spies.switchInft.mock.calls[0]![0].id).toBe(fixtureId(20))
  })

  it('nothing checked: no summon, no profile built', async () => {
    const { book, session } = await signIn()

    book.seedOnce(ADDRESS, [])
    await scanAsSignIn(session)

    expect(spies.switchInft).not.toHaveBeenCalled()
    expect(spies.buildAllProfiles.mock.calls[0]![0]).toEqual([])
  })

  it('first run after the upgrade (O1 b): configured + last summoned are kept, written once', async () => {
    const { book, session } = await signIn()

    spies.remembered.value = fixtureId(7)
    spies.configured.value = { [`base-${fixtureId(42).split(':')[1]}-43`]: { configured: true } }
    await scanAsSignIn(session)

    expect(book.selectionFor(book.$bookChecked.get(), ADDRESS)).toEqual({
      ids: [fixtureId(7), fixtureId(42)],
      kept: 2
    })

    spies.remembered.value = fixtureId(8)
    await session.rescan()
    expect(book.selectionFor(book.$bookChecked.get(), ADDRESS)?.ids).toEqual([fixtureId(7), fixtureId(42)])
  })
})
