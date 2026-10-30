import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopBootProgress, DesktopBootstrapEvent, DesktopBootstrapState } from '@/global'

import { awaitBackendBoot, type BootActivityBridge, subscribeBackendBootActivity } from './backend-boot-activity'
import type { IdleActivitySignal } from './with-timeout'

function progress(phase: string, running = true): DesktopBootProgress {
  return { error: null, fakeMode: false, message: phase, phase, progress: 50, running, timestamp: Date.now() }
}

function fakeBridge(snapshots: { progress?: DesktopBootProgress; bootstrap?: Partial<DesktopBootstrapState> } = {}) {
  const progressListeners = new Set<(payload: DesktopBootProgress) => void>()
  const bootstrapListeners = new Set<(payload: DesktopBootstrapEvent) => void>()

  const bridge: BootActivityBridge = {
    getBootProgress: async () => snapshots.progress ?? progress('backend.resolve'),
    getBootstrapState: async () => ({ setupChoice: null, ...snapshots.bootstrap }) as DesktopBootstrapState,
    onBootProgress: callback => {
      progressListeners.add(callback)

      return () => progressListeners.delete(callback)
    },
    onBootstrapEvent: callback => {
      bootstrapListeners.add(callback)

      return () => bootstrapListeners.delete(callback)
    }
  }

  return {
    bridge,
    emitBootstrap: (event: DesktopBootstrapEvent) => bootstrapListeners.forEach(listener => listener(event)),
    emitProgress: (payload: DesktopBootProgress) => progressListeners.forEach(listener => listener(payload)),
    listenerCount: () => progressListeners.size + bootstrapListeners.size
  }
}

describe('subscribeBackendBootActivity', () => {
  it('maps install events to install, other heartbeats to activity, the setup choice to hold/release', async () => {
    const fake = fakeBridge()
    const signals: IdleActivitySignal[] = []
    const off = subscribeBackendBootActivity(fake.bridge)(signal => signals.push(signal))
    await Promise.resolve()

    fake.emitProgress(progress('backend.resolve'))
    fake.emitBootstrap({ type: 'stage', name: 'python-deps', state: 'running' })
    fake.emitBootstrap({ type: 'log', stage: 'python-deps', line: '  agent-browser:   2.5%' })
    fake.emitProgress(progress('bootstrap.choice'))
    fake.emitBootstrap({ type: 'setup-choice', active: true })
    fake.emitBootstrap({ type: 'manifest', stages: [], protocolVersion: 1 })
    fake.emitProgress(progress('backend.wait'))

    fake.emitProgress(progress('backend.dependencies'))

    expect(signals).toEqual(['activity', 'install', 'install', 'hold', 'release', 'install', 'activity', 'install'])
    off?.()
    expect(fake.listenerCount()).toBe(0)
    fake.emitProgress(progress('backend.wait'))
    expect(signals).toHaveLength(8)
  })

  it('holds from the snapshot when the choice was already on screen before subscribing (renderer reload)', async () => {
    const fake = fakeBridge({ bootstrap: { setupChoice: { activeRoot: '/x', platform: 'darwin' } } })
    const signals: IdleActivitySignal[] = []
    subscribeBackendBootActivity(fake.bridge)(signal => signals.push(signal))
    await vi.waitFor(() => expect(signals).toEqual(['hold']))
  })

  it('a hold-changing event that lands before the snapshot is newer and wins over it (a stale choice never holds)', async () => {
    let resolveSnapshot!: (state: DesktopBootstrapState) => void
    const fake = fakeBridge()
    fake.bridge.getBootstrapState = () => new Promise(resolve => (resolveSnapshot = resolve))
    const signals: IdleActivitySignal[] = []
    subscribeBackendBootActivity(fake.bridge)(signal => signals.push(signal))
    fake.emitBootstrap({ type: 'manifest', stages: [], protocolVersion: 1 })
    resolveSnapshot({ setupChoice: { activeRoot: '/x', platform: 'darwin' } } as DesktopBootstrapState)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(signals).toEqual(['install'])
  })

  it.each([
    ['a log line', { type: 'log', stage: 'python-deps', line: 'stray' }],
    ['a stage row', { type: 'stage', name: 'venv', state: 'running' }],
    ['a stage-alive heartbeat', { type: 'stage-alive', stage: 'python-deps', idleMs: 0 }]
  ] as [string, DesktopBootstrapEvent][])(
    'K142 round 2 (kept from main): reopened while the choice shows, %s first still leaves the choice holding',
    async (_name, stray) => {
      let resolveSnapshot!: (state: DesktopBootstrapState) => void
      const fake = fakeBridge()
      fake.bridge.getBootstrapState = () => new Promise(resolve => (resolveSnapshot = resolve))
      const signals: IdleActivitySignal[] = []
      subscribeBackendBootActivity(fake.bridge)(signal => signals.push(signal))
      fake.emitBootstrap(stray)
      resolveSnapshot({ setupChoice: { activeRoot: '/x', platform: 'darwin' } } as DesktopBootstrapState)
      await new Promise(resolve => setTimeout(resolve, 0))
      // Held now; a further stray event while the choice shows does not lift it.
      fake.emitBootstrap(stray)
      expect(signals.at(-1)).toBe('hold')
      expect(signals.includes('release')).toBe(false)
    }
  )
})

describe('K142: what lifts a hold', () => {
  it.each([
    ['dismissed', { type: 'dismissed' }],
    ['the choice closing', { type: 'setup-choice', active: false }],
    ['a failed install', { type: 'failed', error: 'x' }],
    ['the install starting', { type: 'manifest', stages: [], protocolVersion: 1 }]
  ] as [string, DesktopBootstrapEvent][])(
    '%s while the choice shows lifts the hold (the clock runs again)',
    async (_name, event) => {
      const fake = fakeBridge()
      const signals: IdleActivitySignal[] = []
      subscribeBackendBootActivity(fake.bridge)(signal => signals.push(signal))
      fake.emitBootstrap({ type: 'setup-choice', active: true })
      fake.emitBootstrap(event)
      expect(signals.slice(0, 2)).toEqual(['hold', 'release'])
    }
  )
})

describe('awaitBackendBoot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a first launch reporting every 10 s for 3 minutes completes; the listeners are released', async () => {
    const fake = fakeBridge()
    let resolve!: (value: string) => void
    const work = new Promise<string>(res => (resolve = res))
    let outcome: unknown = 'pending'
    awaitBackendBoot(fake.bridge, work, 'Timed out connecting to Hermes backend').then(
      value => (outcome = value),
      error => (outcome = error)
    )

    for (let i = 0; i < 18; i += 1) {
      await vi.advanceTimersByTimeAsync(10_000)
      fake.emitBootstrap({ type: 'log', stage: 'python-deps', line: `tick ${i}` })
    }

    expect(outcome).toBe('pending')
    resolve('conn')
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome).toBe('conn')
    expect(fake.listenerCount()).toBe(0)
  })

  it('once install activity was seen, only MAIN going silent for 120 s fails the renderer (ruling 42 r2)', async () => {
    const fake = fakeBridge()
    let outcome: unknown = 'pending'
    awaitBackendBoot(fake.bridge, new Promise(() => undefined), 'Timed out connecting to Hermes backend').catch(
      error => (outcome = error)
    )
    await vi.advanceTimersByTimeAsync(30_000)
    fake.emitBootstrap({ type: 'stage', name: 'python-deps', state: 'running' })
    await vi.advanceTimersByTimeAsync(119_999)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect((outcome as Error).message).toBe('Timed out connecting to Hermes backend')
    expect(fake.listenerCount()).toBe(0)
  })

  it("a boot with nothing to install keeps the 45 s total: main's plain steps do not stretch it", async () => {
    const fake = fakeBridge()
    let outcome: unknown = 'pending'
    awaitBackendBoot(fake.bridge, new Promise(() => undefined), 'Timed out connecting to Hermes backend').catch(
      error => (outcome = error)
    )

    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(10_000)
      fake.emitProgress(progress('backend.wait'))
    }

    await vi.advanceTimersByTimeAsync(5_000)
    expect((outcome as Error).message).toBe('Timed out connecting to Hermes backend')
  })

  it('main owns the install verdict: 20 minutes of stage heartbeats never time out the renderer', async () => {
    const fake = fakeBridge()
    let reject!: (error: Error) => void
    let outcome: unknown = 'pending'
    awaitBackendBoot(
      fake.bridge,
      new Promise((_resolve, rej) => (reject = rej)),
      'Timed out connecting to Hermes backend'
    ).catch(error => (outcome = error))

    for (let i = 0; i < 120; i += 1) {
      fake.emitBootstrap({ type: 'stage-alive', stage: 'python-deps', idleMs: 0 })
      await vi.advanceTimersByTimeAsync(10_000)
    }

    expect(outcome).toBe('pending')
    // Main's verdict (the install failed at its ceiling) is what ends the wait.
    reject(new Error("Hermes bootstrap failed at stage 'python-deps': [iclone-install-watchdog] ceiling 900 s reached"))
    await vi.advanceTimersByTimeAsync(0)
    expect((outcome as Error).message).toContain('ceiling 900 s reached')
    expect(fake.listenerCount()).toBe(0)
  })
})
