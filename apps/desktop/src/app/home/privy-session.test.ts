import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ADDRESS = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'
const KEY = 'iclone.privy.lastSession'

const switchInft = vi.fn((..._args: unknown[]) => Promise.resolve({ slug: '', personaApplied: true }))
const scan = vi.fn((_address: string) => Promise.resolve({ ok: true, items: [] }))
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

async function boot(status?: () => Promise<unknown>) {
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
      },
      ...(status ? { status } : {})
    }
  }

  return import('./privy-session')
}

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  window.localStorage.clear()
  switchInft.mockClear()
  scan.mockClear()
  push = null
})

describe('privy session restore', () => {
  it('a remembered wallet survives a reload: restoring, then the partition confirms and the iNFT is re-summoned', async () => {
    let answer: (value: unknown) => void = () => undefined

    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS, label: 'owner' }))

    const store = await boot(() => new Promise(resolve => (answer = resolve)))

    // The remembered identity is a placeholder only: restoring, not signed in.
    expect(store.$privySession.get().status).toBe('out')
    expect(store.$privyRestoring.get()).toBe(true)
    answer({ status: 'in', address: ADDRESS, userId: 'u', label: 'owner' })
    await vi.waitFor(() => expect(store.$privyRestoring.get()).toBe(false))
    expect(store.$privySession.get()).toMatchObject({ status: 'in', address: ADDRESS })
    await vi.waitFor(() => expect(switchInft).toHaveBeenCalledWith(card, { origin: 'restore' }))
    expect(scan).toHaveBeenCalledWith(ADDRESS)
  })

  it('a localStorage value alone never counts as signed in (restoring ends within 10 s)', async () => {
    vi.useFakeTimers()
    window.localStorage.setItem(KEY, JSON.stringify({ address: '0x000000000000000000000000000000000000dEaD' }))

    const store = await boot()

    expect(store.$privyRestoring.get()).toBe(true)
    await vi.advanceTimersByTimeAsync(store.RESTORE_TIMEOUT_MS)
    expect(store.$privyRestoring.get()).toBe(false)
    expect(store.$privySession.get().status).toBe('out')
    expect(scan).not.toHaveBeenCalled()
    expect(switchInft).not.toHaveBeenCalled()
  })

  it('the partition says signed out: the remembered wallet is forgotten', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS }))

    const store = await boot(() => Promise.resolve({ status: 'out', address: null, userId: null, label: null }))

    await vi.waitFor(() => expect(store.$privyRestoring.get()).toBe(false))
    expect(store.$privySession.get().status).toBe('out')
    expect(window.localStorage.getItem(KEY)).toBeNull()
    expect(scan).not.toHaveBeenCalled()
  })

  it('without a status relay, a session push during restoring signs in', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS }))

    const store = await boot()

    expect(store.$privyRestoring.get()).toBe(true)
    push?.({ status: 'in', address: ADDRESS, userId: 'u', label: null })
    await vi.waitFor(() => expect(store.$privyRestoring.get()).toBe(false))
    expect(store.$privySession.get()).toMatchObject({ status: 'in', address: ADDRESS })
  })

  it('the partition restores a session even when nothing was remembered', async () => {
    const store = await boot(() => Promise.resolve({ status: 'in', address: ADDRESS, userId: 'u', label: null }))

    await vi.waitFor(() => expect(store.$privySession.get()).toMatchObject({ status: 'in', address: ADDRESS }))
    expect(store.$privyRestoring.get()).toBe(false)
  })

  it('a sign-in push is remembered; sign-out forgets it', async () => {
    const store = await boot()

    expect(store.$privySession.get().status).toBe('out')
    push?.({ status: 'in', address: ADDRESS, userId: 'u', label: 'owner' })
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? '{}')).toEqual({ address: ADDRESS, label: 'owner' })
    store.logoutPrivy()
    expect(window.localStorage.getItem(KEY)).toBeNull()
    expect(store.$privyRestoring.get()).toBe(false)
  })

  it('a corrupt or foreign entry is ignored (no restore, no throw)', async () => {
    window.localStorage.setItem(KEY, '{"address":"not-an-address"}')

    const store = await boot()

    expect(store.$privySession.get().status).toBe('out')
    expect(store.$privyRestoring.get()).toBe(false)
    expect(scan).not.toHaveBeenCalled()
  })

  it('an "out" push from the partition forgets the remembered wallet', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS }))

    const store = await boot()

    push?.({ status: 'out', address: null, userId: null, label: null })
    expect(store.$privySession.get().status).toBe('out')
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it("main's 'in' after the 10 s placeholder is still applied (the placeholder alone is bounded)", async () => {
    vi.useFakeTimers()
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS, label: 'owner' }))

    const store = await boot(
      () =>
        new Promise(resolve => setTimeout(() => resolve({ status: 'in', address: ADDRESS, label: 'owner' }), 15_000))
    )

    expect(store.walletPrompt(store.$privySession.get().status, store.$privyRestoring.get()).connect).toBe(false)
    await vi.advanceTimersByTimeAsync(store.RESTORE_TIMEOUT_MS)
    expect(store.$privyRestoring.get()).toBe(false)
    expect(store.$privySession.get().status).toBe('out')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.$privySession.get()).toMatchObject({ status: 'in', address: ADDRESS })
    expect(scan).toHaveBeenCalledWith(ADDRESS)
  })

  it("main's late 'out' forgets the remembered wallet", async () => {
    vi.useFakeTimers()
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS }))

    const store = await boot(
      () =>
        new Promise(resolve =>
          setTimeout(() => resolve({ status: 'out', address: null, userId: null, label: null }), 12_000)
        )
    )

    await vi.advanceTimersByTimeAsync(store.RESTORE_TIMEOUT_MS)
    expect(window.localStorage.getItem(KEY)).not.toBeNull()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it('a late answer never overrides a session change made meanwhile (sign-out at 11 s, then a stale in)', async () => {
    vi.useFakeTimers()
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS }))

    const store = await boot(
      () => new Promise(resolve => setTimeout(() => resolve({ status: 'in', address: ADDRESS, label: null }), 15_000))
    )

    await vi.advanceTimersByTimeAsync(11_000)
    store.logoutPrivy()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.$privySession.get().status).toBe('out')
    expect(scan).not.toHaveBeenCalled()
  })

  it('main cannot tell (null): the placeholder ends, signed out, the remembered wallet is kept for the next boot', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ address: ADDRESS }))

    const store = await boot(() => Promise.resolve(null))

    await vi.waitFor(() => expect(store.$privyRestoring.get()).toBe(false))
    expect(store.$privySession.get().status).toBe('out')
    expect(window.localStorage.getItem(KEY)).not.toBeNull()
  })

  it('nothing remembered: main is asked silently — no "restoring" placeholder, the connect button stays', async () => {
    let answer: (value: unknown) => void = () => undefined
    const status = vi.fn(() => new Promise(resolve => (answer = resolve)))
    const store = await boot(status)

    expect(status).toHaveBeenCalledTimes(1)
    expect(store.$privyRestoring.get()).toBe(false)
    expect(store.walletPrompt('out', store.$privyRestoring.get())).toEqual({
      prompt: 'connect',
      connect: true
    })
    answer({ status: 'out', address: null, userId: null, label: null })
    await vi.waitFor(() => expect(store.$privySession.get().status).toBe('out'))
  })
})

describe('wallet prompt', () => {
  it('restoring hides the connect button and says so', async () => {
    const { walletPrompt } = await boot()

    expect(walletPrompt('out', true)).toEqual({ prompt: 'restoringWallet', connect: false })
    expect(walletPrompt('in', false).connect).toBe(false)
    expect(walletPrompt('out', false).connect).toBe(true)
  })

  it('keeps saying restoring until the scan settles when a card is remembered', async () => {
    const { walletPrompt } = await boot()
    const restoringInft = { prompt: 'restoring', connect: false }

    expect(walletPrompt('in', false, 'idle', 'card-7')).toEqual(restoringInft)
    expect(walletPrompt('in', false, 'loading', 'card-7')).toEqual(restoringInft)
    expect(walletPrompt('in', false, 'ready', 'card-7').prompt).toBe('summon')
    expect(walletPrompt('in', false, 'error', 'card-7').prompt).toBe('summon')
    expect(walletPrompt('in', false, 'loading', 'hermes').prompt).toBe('summon')
    expect(walletPrompt('in', false, 'loading', null).prompt).toBe('summon')
    expect(walletPrompt('out', false, 'loading', 'card-7').connect).toBe(true)
  })
})

describe('signed out since the update (V3-0b item 3)', () => {
  const OUT = { status: 'out', address: null, userId: null, label: null }

  it("shows the hint when main's status answer is 'out' after the update", async () => {
    const store = await boot(() => Promise.resolve({ ...OUT, afterUpdate: true }))

    await vi.waitFor(() => expect(store.$privySignedOutByUpdate.get()).toBe(true))
    expect(store.walletPrompt('out', false, 'ready', null, store.$privySignedOutByUpdate.get())).toEqual({
      prompt: 'signedOutByUpdate',
      connect: true
    })
  })

  it('shows nothing for a plain signed-out answer', async () => {
    const status = vi.fn(() => Promise.resolve(OUT))
    const store = await boot(status)

    await vi.waitFor(() => expect(status).toHaveBeenCalled())
    await vi.waitFor(() => expect(store.$privySession.get().status).toBe('out'))
    expect(store.$privySignedOutByUpdate.get()).toBe(false)
    expect(store.walletPrompt('out', false, 'ready', null, false).prompt).toBe('connect')
  })

  it('a sign-in, or a sign-out by hand, ends the hint', async () => {
    const store = await boot(() => Promise.resolve({ ...OUT, afterUpdate: true }))

    await vi.waitFor(() => expect(store.$privySignedOutByUpdate.get()).toBe(true))
    push?.({ status: 'in', address: ADDRESS, userId: 'u', label: null })
    expect(store.$privySignedOutByUpdate.get()).toBe(false)

    push?.({ ...OUT, afterUpdate: true })
    store.logoutPrivy()
    expect(store.$privySignedOutByUpdate.get()).toBe(false)
  })

  it('never overrides restoring or signed in', async () => {
    const { walletPrompt } = await boot()

    expect(walletPrompt('out', true, 'ready', null, true).prompt).toBe('restoringWallet')
    expect(walletPrompt('in', false, 'ready', null, true).prompt).toBe('summon')
  })
})
