/**
 * v0.0.9 W1b (F5 partial names): a whole-wallet scan that could not read a chain to the end carries main's
 * `incomplete` list; the session keeps it in `$inftScanMissing` for the Collection's partial alert, and empties it on
 * a complete scan, a failed scan and sign-out. Red on the old code: neither `$inftScanMissing` nor `scanMissingFrom`
 * existed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ADDRESS = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'

const scan = vi.fn((_address: string): Promise<unknown> => Promise.resolve({ ok: true, agents: [] }))
const card = { id: 'base:0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631:7', name: 'iNFT #7', modelUrl: 'm.glb' }

vi.mock('./inft-switch', () => ({ switchInft: vi.fn(() => Promise.resolve({})), deselectInft: vi.fn() }))
vi.mock('./inft-profile', () => ({ buildAllProfiles: vi.fn() }))
vi.mock('./inft-scan', () => ({ toInftCards: () => [card] }))
vi.mock('./econ/badges', () => ({ clearEconBadges: vi.fn() }))
vi.mock('./econ/prefetch', () => ({ forgetPrefetch: vi.fn() }))
vi.mock('./stage-store', async () => {
  const { atom } = await import('nanostores')

  return { $activeInft: atom(null), HERMES_CHOICE: 'hermes', recallInftChoice: () => null }
})

let push: ((payload: unknown) => void) | null = null

async function boot() {
  vi.resetModules()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    iclonePrivy: {
      open: vi.fn(),
      logout: vi.fn(() => Promise.resolve({ ok: true })),
      scan,
      resolveProfile: vi.fn(),
      onSession: (callback: (payload: unknown) => void) => {
        push = callback

        return () => undefined
      }
    }
  }

  return import('./privy-session')
}

beforeEach(() => {
  window.localStorage.clear()
  scan.mockReset()
  push = null
})

describe('scanMissingFrom', () => {
  it('keeps short strings only, at most 8; anything else reads as none', async () => {
    const { scanMissingFrom } = await boot()

    expect(scanMissingFrom({ incomplete: ['Robinhood'] })).toEqual(['Robinhood'])
    expect(scanMissingFrom({ incomplete: ['Base', 7, '', 'x'.repeat(41), null] })).toEqual(['Base'])
    expect(scanMissingFrom({ incomplete: Array.from({ length: 12 }, (_, i) => `c${i}`) })).toHaveLength(8)
    expect(scanMissingFrom({ incomplete: 'Robinhood' })).toEqual([])
    expect(scanMissingFrom({})).toEqual([])
    expect(scanMissingFrom(null)).toEqual([])
  })
})

describe('$inftScanMissing', () => {
  it('an incomplete scan names its unread chains; the next complete scan clears them', async () => {
    scan.mockImplementationOnce(() =>
      Promise.resolve({ ok: true, source: 'indexer', agents: [], incomplete: ['Robinhood'] })
    )
    scan.mockImplementation(() => Promise.resolve({ ok: true, source: 'indexer', agents: [], complete: true }))

    const store = await boot()

    push!({ status: 'in', address: ADDRESS, userId: 'u', label: 'owner' })
    await vi.waitFor(() => expect(store.$inftRosterStatus.get()).toBe('ready'))
    expect(store.$inftScanMissing.get()).toEqual(['Robinhood'])

    await store.rescan()
    expect(store.$inftScanMissing.get()).toEqual([])
  })

  it('a failed scan clears the names (the error state speaks instead)', async () => {
    scan.mockImplementationOnce(() =>
      Promise.resolve({ ok: true, source: 'indexer', agents: [], incomplete: ['Base'] })
    )
    scan.mockImplementation(() => Promise.resolve({ ok: false, error: 'indexer down' }))

    const store = await boot()

    push!({ status: 'in', address: ADDRESS, userId: 'u', label: 'owner' })
    await vi.waitFor(() => expect(store.$inftScanMissing.get()).toEqual(['Base']))

    await store.rescan()
    expect(store.$inftRosterStatus.get()).toBe('error')
    expect(store.$inftScanMissing.get()).toEqual([])
  })

  it('sign-out clears the names', async () => {
    scan.mockImplementation(() => Promise.resolve({ ok: true, source: 'indexer', agents: [], incomplete: ['Base'] }))

    const store = await boot()

    push!({ status: 'in', address: ADDRESS, userId: 'u', label: 'owner' })
    await vi.waitFor(() => expect(store.$inftScanMissing.get()).toEqual(['Base']))

    push!({ status: 'out', address: null, userId: null, label: null })
    await vi.waitFor(() => expect(store.$inftScanMissing.get()).toEqual([]))
  })
})
