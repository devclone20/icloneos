import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, arg?: unknown) => unknown>(),
  quit: [] as Array<{ fn: (event: QuitEvent) => void; name: string; once: boolean }>,
  sent: [] as Array<{ channel: string; payload: unknown }>
}))

vi.mock('electron', () => ({
  app: {
    on: (name: string, fn: (event: QuitEvent) => void) =>
      (name === 'before-quit' || name === 'will-quit') && electron.quit.push({ fn, name, once: false }),
    once: (name: string, fn: (event: QuitEvent) => void) =>
      (name === 'before-quit' || name === 'will-quit') && electron.quit.push({ fn, name, once: true })
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: (channel: string, payload: unknown) => electron.sent.push({ channel, payload }) }
      }
    ]
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, arg?: unknown) => unknown) => electron.handlers.set(channel, fn)
  }
}))

import { lineRedactor } from './iclone-acp-ipc'
import {
  type AcpWatchEvent,
  BACKOFF_MAX_MS,
  createAcpWatch,
  eventFromLine,
  initAcpWatch,
  isFatalStderrLine,
  KEYCHAIN_CHECK_MS,
  KILL_GRACE_MS,
  nextBackoff,
  RECYCLE_MS,
  STABLE_MS,
  WATCH_ARGV,
  type WatchChild
} from './iclone-acp-watch'

interface FakeChild extends WatchChild {
  out: PassThrough
  err: PassThrough
  killed: boolean
  signals: string[]
  exit(code?: number): void
}

/** `ignores`: 'SIGTERM' = the CLI's hung async shutdown; 'all' = a child that never exits. */
function fakeChild(ignores: 'none' | 'SIGTERM' | 'all' = 'none'): FakeChild {
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
    killed: false,
    signals: [],
    done,
    kill: signal => {
      child.signals.push(signal ?? 'SIGTERM')

      if (ignores === 'all' || (ignores === 'SIGTERM' && signal !== 'SIGKILL')) {
        return
      }

      child.killed = true
      child.exit(null as unknown as number)
    },
    exit: code => settle({ code: code ?? null })
  }

  return child
}

const JOB_LINE = JSON.stringify({
  jobId: 42,
  chainId: 8453,
  status: 'TRANSACTION',
  legacy: false,
  roles: ['provider'],
  availableTools: ['wait'],
  entry: { kind: 'system', event: { type: 'job.funded', amount: 1 }, timestamp: 1 }
})

const CHAT_LINE = JSON.stringify({
  jobId: '42',
  status: 'NEGOTIATION',
  entry: { kind: 'message', from: '0xabc0000000000000000000000000000000000def', content: 'secret words' }
})

function harness(ignores: 'none' | 'SIGTERM' | 'all' = 'none') {
  const children: FakeChild[] = []
  const events: AcpWatchEvent[] = []
  const streaming = new Set<string>()
  const keychain = vi.fn(() => false)

  const start = vi.fn(async (_slug: string, _argv: readonly string[]) => {
    const child = fakeChild(ignores)

    children.push(child)

    return child
  })

  const watcher = createAcpWatch({
    start,
    emit: event => events.push(event),
    streaming,
    keychainPromptShowing: keychain,
    log: () => undefined
  })

  return { children, events, streaming, keychain, start, watcher }
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
}

type QuitEvent = { defaultPrevented: boolean; preventDefault: () => void }

/** Emits an app quit event the way Electron does: an app.once listener hears it once, an app.on listener every time; every
 *  listener sees the same event, so one that called preventDefault() earlier is visible to the next (`prevented` = main's
 *  own quit handler, registered first, already cancelled this pass). */
function emitQuit(name: 'before-quit' | 'will-quit', prevented = false) {
  const event: QuitEvent = {
    defaultPrevented: prevented,
    preventDefault() {
      event.defaultPrevented = true
    }
  }

  for (const listener of [...electron.quit]) {
    if (listener.name !== name) {
      continue
    }

    if (listener.once) {
      electron.quit.splice(electron.quit.indexOf(listener), 1)
    }

    listener.fn(event)
  }
}

const beforeQuit = (prevented = false) => emitQuit('before-quit', prevented)
const willQuit = () => emitQuit('will-quit')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('eventFromLine', () => {
  it('keeps only slug, source, type, jobId, status, at', () => {
    expect(eventFromLine('inft-6', JOB_LINE, 5)).toEqual({
      slug: 'inft-6',
      source: 'jobs',
      type: 'job.funded',
      jobId: '42',
      status: 'TRANSACTION',
      at: 5
    })
  })

  it('maps a room chat line to job.message and never carries its words or address', () => {
    const event = eventFromLine('inft-6', CHAT_LINE, 5)

    expect(event?.type).toBe('job.message')
    expect(JSON.stringify(event)).not.toMatch(/secret|0xabc/)
  })

  it('drops non-JSON, arrays, a missing or odd jobId and foreign event types', () => {
    expect(eventFromLine('s', 'Listening for events...', 1)).toBeNull()
    expect(eventFromLine('s', '[1]', 1)).toBeNull()
    expect(eventFromLine('s', JSON.stringify({ entry: {} }), 1)).toBeNull()
    expect(eventFromLine('s', JSON.stringify({ jobId: '4 2' }), 1)).toBeNull()
    expect(eventFromLine('s', JSON.stringify({ jobId: 1, entry: { event: { type: 'wallet.drain' } } }), 1)).toBeNull()
  })
})

describe('nextBackoff', () => {
  it('doubles from 1 s to a 60 s cap and resets after 5 min alive', () => {
    let ms = 0
    const seen: number[] = []

    for (let i = 0; i < 9; i += 1) {
      ms = nextBackoff(ms, 1000)
      seen.push(ms)
    }

    expect(seen).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, BACKOFF_MAX_MS, BACKOFF_MAX_MS, BACKOFF_MAX_MS])
    expect(nextBackoff(BACKOFF_MAX_MS, STABLE_MS)).toBe(1000)
  })
})

describe('createAcpWatch', () => {
  it('starts ONE `events listen --json` child per slug and holds the shared streaming registry', async () => {
    const h = harness()

    h.watcher.watch('inft-6')
    h.watcher.watch('inft-6')
    await flush()

    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.start).toHaveBeenCalledWith('inft-6', WATCH_ARGV)
    expect(WATCH_ARGV).toEqual(['events', 'listen', '--json'])
    expect(h.streaming.has('inft-6')).toBe(true)
    expect(h.watcher.current()).toBe('inft-6')
  })

  it('announces a (re)connect once and forwards each job line as a bare event', async () => {
    const h = harness()

    h.watcher.watch('inft-6')
    await flush()
    h.children[0].err.write('Listening for events... connected.\nAgent: 0x4d68...cafb\n')
    h.children[0].out.write(`${JOB_LINE}\n${CHAT_LINE.slice(0, 20)}`)
    h.children[0].out.write(`${CHAT_LINE.slice(20)}\n`)
    await flush()

    expect(h.events.map(e => e.type)).toEqual(['stream.live', 'job.funded', 'job.message'])
    expect(h.events[1]).toMatchObject({ slug: 'inft-6', source: 'jobs', jobId: '42' })
    expect(JSON.stringify(h.events)).not.toMatch(/secret|availableTools|roles/)
  })

  it('watch(sameSlug) on a connected child re-announces stream.up — no respawn; before the connect, nothing', async () => {
    const h = harness()

    h.watcher.watch('inft-6')
    await flush()
    h.watcher.watch('inft-6')
    expect(h.events).toEqual([])

    h.children[0].err.write('Listening for events... connected.\n')
    await flush()
    h.watcher.watch('inft-6')
    await flush()

    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.events.map(e => e.type)).toEqual(['stream.live', 'stream.up'])

    h.children[0].exit(1)
    await flush()
    h.watcher.watch('inft-6')
    expect(h.events.map(e => e.type)).toEqual(['stream.live', 'stream.up', 'stream.down'])
  })

  it('respawns on exit with backoff 1 s → 2 s and says the stream is down', async () => {
    const h = harness()

    h.watcher.watch('inft-6')
    await flush()
    h.children[0].exit(1)
    await flush()

    expect(h.events.at(-1)?.type).toBe('stream.down')
    expect(h.streaming.has('inft-6')).toBe(false)
    await vi.advanceTimersByTimeAsync(999)
    expect(h.start).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(h.start).toHaveBeenCalledTimes(2)

    h.children[1].exit(1)
    await flush()
    await vi.advanceTimersByTimeAsync(1999)
    expect(h.start).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(h.start).toHaveBeenCalledTimes(3)
  })

  it('a stage change to another iNFT, watch(null) and stopAll kill the child and never respawn', async () => {
    const h = harness()

    h.watcher.watch('inft-6')
    await flush()
    h.watcher.stage('inft-6')
    expect(h.children[0].killed).toBe(false)
    h.watcher.stage('inft-7')
    await flush()
    expect(h.children[0].killed).toBe(true)
    expect(h.streaming.size).toBe(0)

    h.watcher.watch('inft-7')
    await flush()
    h.watcher.watch(null)
    await flush()
    expect(h.children[1].killed).toBe(true)

    h.watcher.watch('inft-8')
    await flush()
    h.watcher.stopAll()
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS * 2)
    expect(h.start).toHaveBeenCalledTimes(3)
    expect(h.children[2].killed).toBe(true)
    expect(h.watcher.current()).toBeNull()
  })

  it('waits while the agent door streams the same slug — never a second listener', async () => {
    const h = harness()

    h.streaming.add('inft-6')
    h.watcher.watch('inft-6')
    await flush()
    expect(h.start).not.toHaveBeenCalled()

    h.streaming.delete('inft-6')
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(h.start).toHaveBeenCalledTimes(1)
  })

  it('stops for good on a sign-in / not-provisioned error instead of a respawn loop', async () => {
    const h = harness()

    h.watcher.watch('inft-6')
    await flush()
    h.children[0].err.write('{"error":"Not provisioned: run acp setup"}\n')
    await flush()

    expect(h.children[0].killed).toBe(true)
    expect(h.events.at(-1)?.type).toBe('stream.stopped')
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS * 3)
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.watcher.current()).toBeNull()
  })

  it('recycles a child that stayed silent for RECYCLE_MS (an SSE that died without an exit)', async () => {
    const h = harness()

    h.watcher.watch('inft-6')
    await flush()
    await vi.advanceTimersByTimeAsync(RECYCLE_MS - 60_000)
    expect(h.children[0].killed).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(h.children[0].killed).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(h.start).toHaveBeenCalledTimes(2)
  })

  it('checks the keychain dialog at most once a minute and waits a minute while it shows', async () => {
    const h = harness()

    h.keychain.mockReturnValue(true)
    h.watcher.watch('inft-6')

    for (let i = 0; i < 3; i += 1) {
      await flush()
      h.children.at(-1)?.exit(1)
      await flush()
      await vi.advanceTimersByTimeAsync(KEYCHAIN_CHECK_MS)
    }

    expect(h.start).toHaveBeenCalledTimes(4)
    expect(h.keychain.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('refuses a slug that is not one', () => {
    expect(harness().watcher.watch('../etc')).toEqual({ ok: false, error: 'not an iNFT slug' })
  })
})

describe('isFatalStderrLine (the CLI catch writes {error, code, recovery} to stderr)', () => {
  it('stops on the exact CLI lines for sign-in, no active agent, no signer and a missing agent', () => {
    for (const line of [
      '{"error":"Not authenticated.","code":"NOT_AUTHENTICATED","recovery":"Run `acp configure` to authenticate."}',
      '{"error":"Session expired.","code":"NOT_AUTHENTICATED","recovery":"Run `acp configure` to re-authenticate."}',
      '{"error":"No active agent set.","code":"NO_ACTIVE_AGENT","recovery":"Run `acp agent create` or `acp agent use` to set an active agent."}',
      '{"error":"No signer configured for this agent.","code":"NO_SIGNER"}',
      '{"error":"Agent 0x1 not found","code":"AGENT_NOT_FOUND"}',
      '{"error":"Not provisioned: run acp setup"}',
      'Error: Not authenticated.',
      'Error: No active agent set.'
    ]) {
      expect(isFatalStderrLine(line), line).toBe(true)
    }
  })

  it('keeps going on a warning, a transient API error, the banner and junk', () => {
    for (const line of [
      '{"warning":"Legacy listener failed: socket hang up"}',
      '{"error":"Request timed out","code":"TIMEOUT","recovery":"Retry, or re-authenticate if it persists."}',
      '{"error":"Bad gateway","code":"API_ERROR"}',
      'Listening for events... connected.',
      'Agent: 0x4d68...cafb',
      '{"error":',
      '[1,2]'
    ]) {
      expect(isFatalStderrLine(line), line).toBe(false)
    }
  })
})

describe('createAcpWatch — stops, kills and hostile lines (critic r1)', () => {
  const FATAL_LINES = {
    NOT_AUTHENTICATED:
      '{"error":"Not authenticated.","code":"NOT_AUTHENTICATED","recovery":"Run `acp configure` to authenticate."}',
    NO_ACTIVE_AGENT:
      '{"error":"No active agent set.","code":"NO_ACTIVE_AGENT","recovery":"Run `acp agent create` or `acp agent use` to set an active agent."}'
  }

  for (const [code, line] of Object.entries(FATAL_LINES)) {
    it(`${code} on stderr then exit 1: one spawn per hour and stream.stopped`, async () => {
      const h = harness()

      h.watcher.watch('inft-6')
      await flush()
      h.children[0].err.write(`${line}\n`)
      h.children[0].exit(1)
      await vi.advanceTimersByTimeAsync(3_600_000)

      expect(h.start).toHaveBeenCalledTimes(1)
      expect(h.events.map(e => e.type)).toEqual(['stream.stopped'])
      expect(h.watcher.current()).toBeNull()
      expect(h.streaming.size).toBe(0)
    })
  }

  it('every stop — stage, watch(null), quit — says stream.down for the slug', async () => {
    const h = harness()

    h.watcher.watch('inft-6')
    await flush()
    h.watcher.stage('inft-7')
    h.watcher.watch('inft-7')
    await flush()
    h.watcher.watch(null)
    h.watcher.watch('inft-8')
    await flush()
    h.watcher.stopAll()
    await flush()

    expect(h.events.filter(e => e.type === 'stream.down').map(e => e.slug)).toEqual(['inft-6', 'inft-7', 'inft-8'])
  })

  it('a child that ignores SIGTERM gets SIGKILL after 5 s; a deaf one frees the slug 5 s later', async () => {
    const stubborn = harness('SIGTERM')

    stubborn.watcher.watch('inft-6')
    await flush()
    stubborn.watcher.watch(null)
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1)
    expect(stubborn.children[0].signals).toEqual(['SIGTERM'])
    expect(stubborn.streaming.has('inft-6')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(stubborn.children[0].signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(stubborn.streaming.has('inft-6')).toBe(false)

    const deaf = harness('all')

    deaf.watcher.watch('inft-6')
    await flush()
    deaf.watcher.watch(null)
    await vi.advanceTimersByTimeAsync(2 * KILL_GRACE_MS - 1)
    expect(deaf.streaming.has('inft-6')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(deaf.streaming.has('inft-6')).toBe(false)
  })

  it('close then reopen while the old child is dying: exactly ONE new spawn, as soon as it is gone, and stream.live', async () => {
    const h = harness('SIGTERM')

    h.watcher.watch('inft-6')
    await flush()
    h.watcher.watch(null)
    h.watcher.watch('inft-6')
    await flush()
    expect(h.start).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS)
    await flush()
    expect(h.start).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS * 2)
    expect(h.start).toHaveBeenCalledTimes(2)

    h.children[1].err.write('Listening for events... connected.\n')
    await flush()
    expect(h.events.at(-1)).toMatchObject({ slug: 'inft-6', type: 'stream.live' })
    expect(h.streaming.has('inft-6')).toBe(true)
  })

  it('quit sends SIGKILL at once — no grace while the app goes away', async () => {
    const h = harness('SIGTERM')

    h.watcher.watch('inft-6')
    await flush()
    h.watcher.stopAll()
    await flush()

    expect(h.children[0].signals).toEqual(['SIGKILL'])
    expect(h.streaming.size).toBe(0)
  })

  it('a hostile line never throws and the job line after it still arrives', async () => {
    const h = harness()

    h.watcher.watch('inft-6')
    await flush()

    const funded = JSON.stringify({ jobId: '5', entry: { event: { type: 'job.funded' } } })

    expect(() => {
      h.children[0].out.write('{"jobId":{"toString":1},"entry":{}}\n')
      h.children[0].out.write(`{"jobId":{"valueOf":null},"entry":{}}\n${funded}\n`)
      h.children[0].out.write(`${JSON.stringify({ jobId: Number.NaN })}\n{"jobId":1e400}\n`)
    }).not.toThrow()
    await flush()

    expect(h.events.map(e => [e.type, e.jobId])).toEqual([['job.funded', '5']])
  })
})

describe('eventFromLine — jobId', () => {
  it('accepts only a string or a finite number', () => {
    expect(eventFromLine('a', '{"jobId":7}', 1)?.jobId).toBe('7')
    expect(eventFromLine('a', '{"jobId":"j-7"}', 1)?.jobId).toBe('j-7')
    expect(eventFromLine('a', '{"jobId":{"toString":1}}', 1)).toBeNull()
    expect(eventFromLine('a', '{"jobId":true}', 1)).toBeNull()
    expect(eventFromLine('a', '{"jobId":1e400}', 1)).toBeNull()
  })
})

describe('lineRedactor (shared with the agent door)', () => {
  it('cuts its buffer before write: a throwing writer loses nothing and re-sends nothing', () => {
    const seen: string[] = []
    let first = true

    const lines = lineRedactor(text => {
      seen.push(text)

      if (first) {
        first = false
        throw new Error('bad line')
      }
    })

    expect(() => lines.push('one\n')).toThrow('bad line')
    lines.push('two\n')
    lines.end()

    expect(seen).toEqual(['one\n', 'two\n'])
  })
})

describe('initAcpWatch', () => {
  it('L9 — with no sender guard, or a guard that refuses, no window is answered and nothing starts', async () => {
    const start = vi.fn(async () => fakeChild())

    for (const isTrustedSender of [undefined, () => false]) {
      initAcpWatch({
        start,
        streaming: new Set(),
        keychainPromptShowing: () => false,
        log: () => undefined,
        isTrustedSender
      })

      const answer = await electron.handlers.get('iclone:acp-watch')?.(
        { sender: { isDestroyed: () => false } },
        'inft-6'
      )

      // The P7 seam shape: every refused iclone:acp-* door answers null (iclone-acp.sender.test.ts covers all 14).
      expect(answer).toBeNull()
    }

    expect(start).not.toHaveBeenCalled()
  })

  it('registers iclone:acp-watch, fans events out only to windows that asked and kills the child on quit', async () => {
    const child = fakeChild()
    const asked: unknown[] = []
    const other: unknown[] = []

    const contents = (into: unknown[]) => ({
      isDestroyed: () => false,
      once: () => undefined,
      send: (channel: string, payload: unknown) => into.push({ channel, payload })
    })

    initAcpWatch({
      start: async () => child,
      streaming: new Set(),
      keychainPromptShowing: () => false,
      log: () => undefined,
      isTrustedSender: () => true
    })

    const market = contents(asked)

    contents(other)
    await electron.handlers.get('iclone:acp-watch')?.({ sender: market }, 'inft-6')
    await flush()
    child.out.write(`${JOB_LINE}\n`)
    await flush()

    expect(asked).toEqual([expect.objectContaining({ channel: 'iclone:acp-event' })])
    expect((asked[0] as { payload: AcpWatchEvent }).payload.type).toBe('job.funded')
    expect(other).toEqual([])
    expect(electron.sent).toEqual([])

    beforeQuit()

    expect(child.killed).toBe(true)
    expect(child.signals).toEqual(['SIGKILL'])
  })

  /** A fake app window: records what it hears and fires the WebContents lifecycle events on demand. */
  function sender() {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    let destroyed = false

    const add = (name: string, fn: (...args: unknown[]) => void) =>
      listeners.set(name, [...(listeners.get(name) ?? []), fn])

    return {
      heard: [] as unknown[],
      isDestroyed: () => destroyed,
      once: add,
      on: add,
      send(channel: string, payload: unknown) {
        this.heard.push({ channel, payload })
      },
      fire(name: string, ...args: unknown[]) {
        if (name === 'destroyed') {
          destroyed = true
        }

        for (const fn of listeners.get(name) ?? []) {
          fn(...args)
        }
      }
    }
  }

  function lifecycle() {
    const children: FakeChild[] = []

    const start = vi.fn(async () => {
      const child = fakeChild()

      children.push(child)

      return child
    })

    const watcher = initAcpWatch({
      start,
      streaming: new Set(),
      keychainPromptShowing: () => false,
      log: () => undefined,
      isTrustedSender: () => true
    })

    const ask = (from: unknown, slug: string | null) =>
      electron.handlers.get('iclone:acp-watch')?.({ sender: from }, slug)

    return { children, start, watcher, ask }
  }

  const RELOAD = { isMainFrame: true, isSameDocument: false }

  it('sender_destroyed_stops_listener: the asking window is destroyed -> child killed, current() null', async () => {
    const { children, watcher, ask } = lifecycle()
    const market = sender()

    await ask(market, 'inft-6')
    await flush()
    expect(watcher.current()).toBe('inft-6')

    market.fire('destroyed')
    await flush()

    expect(children[0].killed).toBe(true)
    expect(children[0].signals).toEqual(['SIGTERM'])
    expect(watcher.current()).toBeNull()
  })

  it('a crashed renderer (render-process-gone) stops the listener', async () => {
    const { children, watcher, ask } = lifecycle()
    const market = sender()

    await ask(market, 'inft-6')
    await flush()
    market.fire('render-process-gone', {}, { reason: 'crashed' })
    await flush()

    expect(children[0].killed).toBe(true)
    expect(watcher.current()).toBeNull()
  })

  it('a reload stops the listener once it commits; reopening the Market pays exactly one new spawn', async () => {
    const { children, start, watcher, ask } = lifecycle()
    const market = sender()

    await ask(market, 'inft-6')
    await flush()
    market.fire('did-start-navigation', RELOAD)
    await flush()
    expect(children[0].killed).toBe(false)

    market.fire('did-navigate', {}, 'http://127.0.0.1:5174/', 200, 'OK')
    await flush()

    expect(children[0].killed).toBe(true)
    expect(watcher.current()).toBeNull()

    await ask(market, 'inft-6')
    await flush()

    expect(start).toHaveBeenCalledTimes(2)
    expect(children[1].killed).toBe(false)
    expect(watcher.current()).toBe('inft-6')
  })

  it('in-page routing, a subframe navigation and a stale reload do not stop the listener', async () => {
    const { children, watcher, ask } = lifecycle()
    const market = sender()
    const other = sender()

    await ask(market, 'inft-6')
    await flush()
    market.fire('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    market.fire('did-navigate-in-page', {}, 'http://127.0.0.1:5174/#/market', true)
    market.fire('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    market.fire('did-frame-navigate', {}, 'about:blank', 200, 'OK', false)
    // A window that never asked reloads.
    other.fire('did-start-navigation', RELOAD)
    other.fire('did-navigate', {}, 'http://127.0.0.1:5174/', 200, 'OK')
    await flush()

    expect(children[0].killed).toBe(false)
    expect(watcher.current()).toBe('inft-6')
  })

  it('lab_cancelled_nav_keeps_listener: a main-frame navigation that never commits keeps the child; a commit stops it', async () => {
    const { children, start, watcher, ask } = lifecycle()
    const market = sender()

    await ask(market, 'inft-6')
    await flush()
    // A blocked link: did-start-navigation fires before will-navigate prevents it, then the provisional load fails.
    market.fire('did-start-navigation', RELOAD)
    market.fire('did-start-navigation', {}, 'blob:http://127.0.0.1:5174/x', false, true)
    market.fire('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', 'blob:http://127.0.0.1:5174/x', true)
    await flush()

    expect(children[0].killed).toBe(false)
    expect(watcher.current()).toBe('inft-6')

    // The same window still hears the stream.
    children[0].out.write(`${JOB_LINE}\n`)
    await flush()
    expect(market.heard).toHaveLength(1)

    market.fire('did-navigate', {}, 'http://127.0.0.1:5174/', 200, 'OK')
    await flush()

    expect(children[0].killed).toBe(true)
    expect(children[0].signals).toEqual(['SIGTERM'])
    expect(watcher.current()).toBeNull()
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('a quit main cancelled (Keep Running) keeps the open Market listener; the quit that goes through kills it', async () => {
    const before = electron.quit.length
    const { children, watcher, ask } = lifecycle()
    const market = sender()

    expect(electron.quit.slice(before)).toEqual([
      expect.objectContaining({ name: 'before-quit', once: false }),
      expect.objectContaining({ name: 'will-quit', once: false })
    ])

    await ask(market, 'inft-6')
    await flush()
    // Main's quit confirmation ran first and prevented this pass: the Market is still open.
    beforeQuit(true)
    await flush()
    expect(children[0].killed).toBe(false)
    expect(watcher.current()).toBe('inft-6')

    // A deferred teardown pass is prevented too; the re-entered quit is not.
    beforeQuit(true)
    await flush()
    expect(children[0].killed).toBe(false)
    beforeQuit(false)
    await flush()
    expect(children[0].killed).toBe(true)
    expect(children[0].signals).toEqual(['SIGKILL'])
    expect(watcher.current()).toBeNull()

    // Still armed: a Market reopened after a cancelled quit is killed on the real one.
    await ask(market, 'inft-6')
    await flush()
    expect(children[1].killed).toBe(false)
    beforeQuit(false)
    await flush()
    expect(children[1].killed).toBe(true)
    expect(watcher.current()).toBeNull()

    // A further emission with nothing running is a no-op.
    expect(() => beforeQuit(false)).not.toThrow()
    expect(() => willQuit()).not.toThrow()
  })

  it('will-quit is the backstop: a quit that passed before-quit prevented still kills the listener when it goes through', async () => {
    const { children, watcher, ask } = lifecycle()
    const market = sender()

    await ask(market, 'inft-6')
    await flush()
    beforeQuit(true)
    await flush()
    expect(children[0].killed).toBe(false)

    willQuit()
    await flush()
    expect(children[0].killed).toBe(true)
    expect(children[0].signals).toEqual(['SIGKILL'])
    expect(watcher.current()).toBeNull()
  })

  it('a main-frame load that fails into an error page forgets the asker; ERR_ABORTED and subframes keep it', async () => {
    const { children, watcher, ask } = lifecycle()
    const market = sender()

    await ask(market, 'inft-6')
    await flush()
    // A blocked or cancelled navigation (ERR_ABORTED): the Market is still on screen.
    market.fire('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://127.0.0.1:5174/', true)
    await flush()
    expect(children[0].killed).toBe(false)
    // A subframe (an embed) failing is not the window going away.
    market.fire('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:5174/embed', false)
    await flush()
    expect(children[0].killed).toBe(false)
    expect(watcher.current()).toBe('inft-6')

    // The main frame failed: chrome-error://chromewebdata is on screen, no 'did-navigate' will come.
    market.fire('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:5174/', true)
    await flush()
    expect(children[0].killed).toBe(true)
    expect(watcher.current()).toBeNull()
  })

  it('a second asker still alive keeps the child; the last one gone kills it', async () => {
    const { children, start, watcher, ask } = lifecycle()
    const first = sender()
    const second = sender()

    await ask(first, 'inft-6')
    await ask(second, 'inft-6')
    await flush()
    first.fire('destroyed')
    await flush()

    expect(start).toHaveBeenCalledTimes(1)
    expect(children[0].killed).toBe(false)
    expect(watcher.current()).toBe('inft-6')

    // The survivor still hears the stream; the destroyed window does not.
    children[0].out.write(`${JOB_LINE}\n`)
    await flush()
    expect(second.heard).toHaveLength(1)
    expect(first.heard).toHaveLength(0)

    second.fire('did-navigate', {}, 'http://127.0.0.1:5174/', 200, 'OK')
    await flush()

    expect(children[0].killed).toBe(true)
    expect(watcher.current()).toBeNull()
  })

  it("watch(null) from one window keeps another window's listener; from the last one it stops", async () => {
    const { children, watcher, ask } = lifecycle()
    const first = sender()
    const second = sender()

    await ask(first, 'inft-6')
    await ask(second, 'inft-6')
    await flush()

    expect(await ask(first, null)).toEqual({ ok: true, slug: null })
    await flush()
    expect(children[0].killed).toBe(false)

    await ask(second, null)
    await flush()
    expect(children[0].killed).toBe(true)
    expect(watcher.current()).toBeNull()
  })

  it('a switch to another slug makes its asker the only one; the old asker dying is a no-op', async () => {
    const { children, watcher, ask } = lifecycle()
    const first = sender()
    const second = sender()

    await ask(first, 'inft-6')
    await flush()
    await ask(second, 'inft-7')
    await flush()
    first.fire('destroyed')
    await flush()

    expect(children[1].killed).toBe(false)
    expect(watcher.current()).toBe('inft-7')

    second.fire('destroyed')
    await flush()
    expect(children[1].killed).toBe(true)
    expect(watcher.current()).toBeNull()
  })
})
