/**
 * v0.0.9 (F2 for F5): `retryInftScan()` — the Collection's Retry scans the signed-in wallet NOW. It presents the
 * remembered iNFT only when no scan of this wallet has landed yet (the sign-in scan failed), never over a scan that
 * already decided the stage. Red on the old code: the export did not exist.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ADDRESS = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'

const switchInft = vi.fn((..._args: unknown[]) => Promise.resolve({ slug: '', personaApplied: true }))
const scan = vi.fn((_address: string): Promise<unknown> => Promise.resolve({ ok: true, items: [] }))
const card = { id: '46630:0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631:7', name: 'iNFT #7', modelUrl: 'm.glb' }

vi.mock('./inft-switch', () => ({ switchInft, deselectInft: vi.fn() }))
vi.mock('./inft-profile', () => ({ buildAllProfiles: vi.fn() }))
vi.mock('./inft-scan', () => ({ toInftCards: () => [card] }))
vi.mock('./econ/badges', () => ({ clearEconBadges: vi.fn() }))
vi.mock('./econ/prefetch', () => ({ forgetPrefetch: vi.fn() }))
vi.mock('./stage-store', async () => {
  const { atom } = await import('nanostores')

  return { $activeInft: atom(null), HERMES_CHOICE: 'hermes', recallInftChoice: () => card.id }
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
  switchInft.mockClear()
  scan.mockReset()
  scan.mockImplementation(() => Promise.resolve({ ok: true, items: [] }))
  push = null
})

describe('retryInftScan', () => {
  it('signed out: nothing is scanned', async () => {
    const store = await boot()

    await store.retryInftScan()
    expect(scan).not.toHaveBeenCalled()
  })

  it('the sign-in scan failed: Retry scans now and presents the remembered iNFT (the restore that never ran)', async () => {
    scan.mockImplementationOnce(() => Promise.resolve({ ok: false, error: 'indexer down' }))

    const store = await boot()

    push!({ status: 'in', address: ADDRESS, userId: 'u', label: 'owner' })
    await vi.waitFor(() => expect(store.$inftRosterStatus.get()).toBe('error'))
    expect(switchInft).not.toHaveBeenCalled()

    await store.retryInftScan()

    expect(scan).toHaveBeenCalledTimes(2)
    expect(store.$inftRosterStatus.get()).toBe('ready')
    await vi.waitFor(() => expect(switchInft).toHaveBeenCalledWith(card, { origin: 'restore' }))
  })

  it('after a scan landed, Retry re-scans but never re-summons over the stage the owner has', async () => {
    const store = await boot()

    push!({ status: 'in', address: ADDRESS, userId: 'u', label: 'owner' })
    await vi.waitFor(() => expect(switchInft).toHaveBeenCalledTimes(1))

    await store.retryInftScan()

    expect(scan).toHaveBeenCalledTimes(2)
    expect(switchInft).toHaveBeenCalledTimes(1)
  })
})
