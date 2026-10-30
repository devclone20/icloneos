import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { on: () => undefined }, ipcMain: { handle: () => undefined } }))

import type { SupervisorState, WorkFixView } from '../../src/iclone-shared/acp-work'
import { type AcpWatchEvent, createAcpWatch, WATCH_ARGV, type WatchChild } from '../iclone-acp-watch'

import { createSupervisor } from './supervisor'

interface FakeChild extends WatchChild {
  err: PassThrough
  out: PassThrough
  exit(code: number | null): void
  signals: string[]
}

function fakeChild(): FakeChild {
  const out = new PassThrough()
  const err = new PassThrough()
  let settle: (value: { code: number | null }) => void = () => undefined
  const done = new Promise<{ code: number | null }>(resolve => (settle = resolve))

  const child: FakeChild = {
    out,
    err,
    stdout: out,
    stderr: err,
    pid: 4242,
    signals: [],
    done,
    kill: signal => {
      child.signals.push(signal ?? 'SIGTERM')
      settle({ code: null })
    },
    exit: code => settle({ code })
  }

  return child
}

const SLUG = 'robinhood-1'

const flush = async () => {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
}

function harness() {
  const children: FakeChild[] = []
  const streaming = new Set<string>()
  const states: SupervisorState[] = []
  const fixes: WorkFixView[] = []
  const events: AcpWatchEvent[] = []
  const yielded: string[] = []
  const argvs: Array<readonly string[]> = []

  const start = (_slug: string, argv: readonly string[]) => {
    const child = fakeChild()

    argvs.push(argv)
    children.push(child)

    return Promise.resolve(child)
  }

  const supervisor = createSupervisor({
    start,
    streaming,
    keychainPromptShowing: () => false,
    yieldWindowWatch: slug => yielded.push(slug),
    emit: event => events.push(event),
    onState: (_slug, state) => states.push(state),
    onFix: (_slug, fix) => fixes.push(fix),
    log: () => undefined
  })

  const alive = () => children.filter(child => child.signals.length === 0)

  return { supervisor, children, streaming, states, fixes, events, yielded, argvs, start, alive }
}

const connect = async (child: FakeChild) => {
  child.err.write('Listening for events... connected.\n')
  await flush()
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('the lifecycle supervisor', () => {
  it('online = the listener said connected; it runs `events listen --json` and the window yields first', async () => {
    const h = harness()

    expect(h.supervisor.online(SLUG)).toBe('starting')
    await flush()
    expect(h.argvs).toEqual([WATCH_ARGV])
    expect(h.yielded).toEqual([SLUG])
    await connect(h.children[0])
    expect(h.supervisor.state(SLUG)).toBe('online')
    expect(h.states).toEqual(['starting', 'online'])
  })

  it('online twice is one listener', async () => {
    const h = harness()

    h.supervisor.online(SLUG)
    await flush()
    await connect(h.children[0])
    h.supervisor.online(SLUG)
    await flush()
    expect(h.children).toHaveLength(1)
    expect(h.supervisor.live()).toEqual([SLUG])
  })

  it('forwards job lines (only the safe fields) for the windows and the watchdog', async () => {
    const h = harness()

    h.supervisor.online(SLUG)
    await flush()
    h.children[0].out.write(
      `${JSON.stringify({ jobId: 7, status: 'funded', entry: { event: { type: 'job.funded' } } })}\n`
    )
    await flush()
    expect(h.events.find(event => event.source === 'jobs')).toMatchObject({
      slug: SLUG,
      type: 'job.funded',
      jobId: '7'
    })
  })

  it('survives every window closing: the market window listener stops, the supervisor one stays, count is 1 (I7)', async () => {
    const h = harness()

    const window = createAcpWatch({
      start: h.start,
      streaming: h.streaming,
      keychainPromptShowing: () => false,
      emit: () => undefined,
      log: () => undefined
    })

    // The market window was open and watching this iNFT; the owner puts it online.
    window.watch(SLUG)
    await flush()
    expect(h.children).toHaveLength(1)

    // The real yield: the window's listener lets go of the slug.
    const supervisor = createSupervisor({
      start: h.start,
      streaming: h.streaming,
      keychainPromptShowing: () => false,
      yieldWindowWatch: () => window.stop('the WORK supervisor holds this iNFT online'),
      emit: () => undefined,
      onState: () => undefined,
      onFix: () => undefined,
      log: () => undefined
    })

    supervisor.online(SLUG)
    // The window's child is still releasing its claim: the supervisor waits one backoff step, never overlaps.
    await flush()
    expect(h.alive()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1500)
    await connect(h.children[1])
    expect(h.alive()).toHaveLength(1)
    expect(supervisor.state(SLUG)).toBe('online')

    // Every window closes (initAcpWatch's "window gone" path stops the window watcher).
    window.stop('window gone')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(supervisor.state(SLUG)).toBe('online')
    expect(h.alive()).toHaveLength(1)
    expect(h.streaming.has(SLUG)).toBe(true)
  })

  it('a window watcher that asks while the supervisor holds the slug waits: never a second listener', async () => {
    const h = harness()

    h.supervisor.online(SLUG)
    await flush()
    await connect(h.children[0])

    const window = createAcpWatch({
      start: h.start,
      streaming: h.streaming,
      keychainPromptShowing: () => false,
      emit: () => undefined,
      log: () => undefined
    })

    window.watch(SLUG)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.alive()).toHaveLength(1)
    window.stop('test over')
  })

  it('SIGKILLed listener: a Fix entry with cause and action, back online within 70 s (I8)', async () => {
    const h = harness()

    h.supervisor.online(SLUG)
    await flush()
    await connect(h.children[0])

    for (let round = 0; round < 5; round += 1) {
      const before = h.children.length

      h.children[h.children.length - 1].exit(null)
      await flush()
      expect(h.supervisor.state(SLUG)).toBe('starting')
      await vi.advanceTimersByTimeAsync(70_000)
      expect(h.children.length).toBe(before + 1)
      await connect(h.children[h.children.length - 1])
      expect(h.supervisor.state(SLUG)).toBe('online')
    }

    expect(h.fixes).toHaveLength(5)
    expect(h.fixes[0]).toMatchObject({ cause: 'listener-exited', tried: 'restart-backoff', now: 'starting' })
  })

  it('a signed-out agent stops retrying: failed, with the sign-in fix', async () => {
    const h = harness()

    h.supervisor.online(SLUG)
    await flush()
    h.children[0].err.write('{"error":"Not authenticated","code":"NOT_AUTHENTICATED"}\n')
    await flush()
    await vi.advanceTimersByTimeAsync(6000)
    expect(h.supervisor.state(SLUG)).toBe('failed')
    expect(h.fixes.at(-1)).toMatchObject({ cause: 'needs-sign-in', tried: 'stopped-for-sign-in', now: 'failed' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.children).toHaveLength(1)
  })

  it('reboot restarts the listener and records the owner fix', async () => {
    const h = harness()

    h.supervisor.online(SLUG)
    await flush()
    await connect(h.children[0])
    h.supervisor.reboot(SLUG)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.children).toHaveLength(2)
    expect(h.children[0].signals.length).toBeGreaterThan(0)
    expect(h.fixes).toMatchObject([{ cause: 'owner-reboot', tried: 'restarted' }])
    expect(h.supervisor.reboot('not-online')).toBe('offline')
  })

  it('a drain keeps the listener; stopListener ends it with the state the drain earned', async () => {
    const h = harness()

    h.supervisor.online(SLUG)
    await flush()
    await connect(h.children[0])
    h.supervisor.draining(SLUG, ['5'])
    expect(h.supervisor.state(SLUG)).toBe('draining')
    expect(h.supervisor.blocking(SLUG)).toEqual(['5'])
    expect(h.children[0].signals).toEqual([])
    h.supervisor.stopListener(SLUG, 'offline-safe')
    await flush()
    expect(h.supervisor.state(SLUG)).toBe('offline-safe')
    expect(h.children[0].signals).toEqual(['SIGTERM'])
    expect(h.fixes).toEqual([])
  })

  it('stopAll (app quit) SIGKILLs every listener at once', async () => {
    const h = harness()

    h.supervisor.online(SLUG)
    h.supervisor.online('robinhood-2')
    await flush()
    h.supervisor.stopAll()
    expect(h.children.map(child => child.signals)).toEqual([['SIGKILL'], ['SIGKILL']])
  })
})
