import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IcloneAgentUpdateCheck, IcloneUpdatePolicyInfo } from '@/types/iclone-updates'

import {
  $agentCompatFlag,
  $agentUpdate,
  __resetAgentUpdate,
  agentUpdateTargetSha,
  applyAgentUpdate,
  checkAgentUpdate,
  loadLastAgentCheck,
  restoreOffered,
  restoreVerifiedAgent,
  watchAgentCompatFlag
} from './agent-update'

const applyUpdates = vi.fn()
const policy = vi.hoisted(() => ({ current: { policy: 'curated' } as null | { policy: string } }))

vi.mock('./updates', () => ({
  $updateOverlayTarget: { set: vi.fn() },
  $updatePolicy: { get: () => policy.current },
  applyUpdates: () => applyUpdates(),
  isCuratedPolicy: (info: null | { policy: string }) => info?.policy !== 'developer',
  setUpdateOverlayOpen: vi.fn()
}))

function makeCheck(overrides: Partial<IcloneAgentUpdateCheck> = {}): IcloneAgentUpdateCheck {
  return {
    checkedAt: '2026-10-19T00:00:00.000Z',
    compat: { findings: [], verdict: 'GREEN' },
    error: null,
    installed: {
      branch: 'main',
      date: '2026-10-06T10:00:00Z',
      dirty: false,
      sha: '1ac3f97aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      version: '0.21.5',
      verifiedWithRelease: true
    },
    latest: {
      commitsNewer: 12,
      date: '2026-10-18T10:00:00Z',
      releaseTag: 'v0.21.0',
      sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      version: '0.22.0'
    },
    updateAvailable: true,
    verified: { sha: '1ac3f97aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', version: '0.21.5' },
    ...overrides
  }
}

function installBridge(bridge: Record<string, unknown>) {
  ;(window as unknown as { hermesDesktop: Record<string, unknown> }).hermesDesktop = bridge
}

describe('agent update store', () => {
  beforeEach(() => {
    __resetAgentUpdate()
    applyUpdates.mockReset()
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'hermesDesktop')
  })

  it('never calls main on import: the state starts idle and unchecked', () => {
    const check = vi.fn()
    installBridge({ agentUpdate: { apply: vi.fn(), check, gesture: vi.fn(), lastCheck: vi.fn() } })

    expect($agentUpdate.get()).toMatchObject({ check: null, phase: 'idle' })
    expect(check).not.toHaveBeenCalled()
  })

  it('reports a missing bridge without throwing', async () => {
    installBridge({})

    await expect(checkAgentUpdate()).resolves.toBeNull()
    expect($agentUpdate.get()).toMatchObject({ fault: 'bridge', phase: 'error' })
  })

  it('dedupes clicks while a check is in flight and stores the answer', async () => {
    let resolve: (value: IcloneAgentUpdateCheck) => void = () => undefined
    const check = vi.fn(() => new Promise<IcloneAgentUpdateCheck>(r => (resolve = r)))
    installBridge({ agentUpdate: { apply: vi.fn(), check, gesture: vi.fn(), lastCheck: vi.fn() } })

    const first = checkAgentUpdate()
    const second = checkAgentUpdate()

    expect(first).toBe(second)
    expect($agentUpdate.get().phase).toBe('checking')
    resolve(makeCheck())
    await first

    expect(check).toHaveBeenCalledTimes(1)
    expect($agentUpdate.get()).toMatchObject({ phase: 'checked' })
    expect(agentUpdateTargetSha($agentUpdate.get())).toBe('b'.repeat(40))
  })

  it('keeps an offline answer as an error phase with the installed facts', async () => {
    const offline = makeCheck({ error: 'offline', latest: null, updateAvailable: false })
    installBridge({
      agentUpdate: { apply: vi.fn(), check: vi.fn(async () => offline), gesture: vi.fn(), lastCheck: vi.fn() }
    })

    await checkAgentUpdate()

    expect($agentUpdate.get()).toMatchObject({ check: offline, phase: 'error' })
    expect(agentUpdateTargetSha($agentUpdate.get())).toBeNull()
  })

  it('maps a thrown IPC to a failed fault', async () => {
    installBridge({
      agentUpdate: {
        apply: vi.fn(),
        check: vi.fn(async () => Promise.reject(new Error('boom'))),
        gesture: vi.fn(),
        lastCheck: vi.fn()
      }
    })

    await expect(checkAgentUpdate()).resolves.toBeNull()
    expect($agentUpdate.get()).toMatchObject({ fault: 'failed', phase: 'error' })
  })

  it('reads back the persisted answer only while idle', async () => {
    const persisted = makeCheck({ updateAvailable: false })
    const lastCheck = vi.fn(async () => persisted)
    installBridge({ agentUpdate: { apply: vi.fn(), check: vi.fn(), gesture: vi.fn(), lastCheck } })

    await loadLastAgentCheck()
    expect($agentUpdate.get()).toMatchObject({ check: persisted, phase: 'checked' })

    await loadLastAgentCheck()
    expect(lastCheck).toHaveBeenCalledTimes(1)
  })

  it('mints the gesture synchronously, then applies the exact target sha', async () => {
    const order: string[] = []

    const gesture = vi.fn(() => {
      order.push('gesture')

      return Promise.resolve({ gesture: { expiresAt: 1, token: 'tok' }, ok: true as const })
    })

    const apply = vi.fn(async () => ({ compat: null, ok: true as const }))
    installBridge({ agentUpdate: { apply, check: vi.fn(), gesture, lastCheck: vi.fn() } })
    $agentUpdate.set({ ...$agentUpdate.get(), check: makeCheck(), phase: 'checked' })

    const pending = applyAgentUpdate('b'.repeat(40))
    order.push('returned')

    expect(order).toEqual(['gesture', 'returned'])
    expect($agentUpdate.get().phase).toBe('applying')
    await pending

    expect(apply).toHaveBeenCalledWith({ gestureToken: 'tok', targetSha: 'b'.repeat(40) })
  })

  it('refuses without a gesture and re-checks on a stale target', async () => {
    const check = vi.fn(async () => makeCheck())
    const apply = vi.fn(async () => ({ error: 'stale-check' as const, message: 'stale', ok: false as const }))

    const gesture = vi
      .fn()
      .mockResolvedValueOnce({ error: 'no-user-activation', ok: false })
      .mockResolvedValueOnce({ gesture: { expiresAt: 1, token: 't' }, ok: true })

    installBridge({ agentUpdate: { apply, check, gesture, lastCheck: vi.fn() } })
    $agentUpdate.set({ ...$agentUpdate.get(), check: makeCheck(), phase: 'checked' })

    await applyAgentUpdate('x')
    expect(apply).not.toHaveBeenCalled()
    expect($agentUpdate.get()).toMatchObject({ applyError: { error: 'gesture' }, phase: 'checked' })

    await expect(applyAgentUpdate('x')).resolves.toMatchObject({ error: 'stale-check', ok: false })
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('offers Restore under a curated policy off Windows, never under developer and never on Windows', () => {
    const curated = { pin: { sha: 'a'.repeat(40) }, policy: 'curated' } as unknown as IcloneUpdatePolicyInfo
    const developer = { ...curated, policy: 'developer' } as unknown as IcloneUpdatePolicyInfo

    expect(restoreOffered(curated, false)).toBe(true)
    expect(restoreOffered(curated, true)).toBe(false)
    expect(restoreOffered(developer, false)).toBe(false)
    expect(restoreOffered(null, false)).toBe(true)
  })

  it('rolls back to the pin only where the pinned door exists (curated POSIX)', () => {
    policy.current = { policy: 'developer' }
    expect(restoreVerifiedAgent(false)).toBe(false)
    policy.current = { policy: 'curated' }
    expect(restoreVerifiedAgent(true)).toBe(false)
    expect(applyUpdates).not.toHaveBeenCalled()

    expect(restoreVerifiedAgent(false)).toBe(true)
    expect(applyUpdates).toHaveBeenCalledTimes(1)
  })

  it('subscribes to the passive compat flag where preload exposes it (icloneUpdates.compat) and unsubscribes', async () => {
    const off = vi.fn()
    let push: (flag: { at: string; red: boolean; verdict: 'RED' }) => void = () => undefined
    installBridge({ compat: { flag: vi.fn(async () => ({ red: true })), onFlag: vi.fn() } })
    expect(watchAgentCompatFlag()).toBeTypeOf('function')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect($agentCompatFlag.get()).toBeNull()

    installBridge({
      icloneUpdates: {
        compat: {
          flag: vi.fn(async () => null),
          onFlag: vi.fn(cb => {
            push = cb

            return off
          })
        }
      }
    })

    const stop = watchAgentCompatFlag()
    push({ at: 'now', red: true, verdict: 'RED' })

    expect($agentCompatFlag.get()).toMatchObject({ red: true })
    stop()
    expect(off).toHaveBeenCalled()
  })
})
