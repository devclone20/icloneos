// The app's wiring of the quit path, with Electron and the app's modules replaced: what reaches app.quit() and when.
// A re-quit that runs inside the before-quit pass that prevented the quit loses the quit (shutdown-quit-path.test.ts
// shows how); these tests pin that the wiring itself, installed or not, always quits on a later turn.
import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SHUTDOWN_SIGNALS } from './shutdown-signals'

const fake = vi.hoisted(() => ({
  app: null as unknown as Record<string, unknown>,
  lines: [] as string[],
  storage: [] as string[],
  finishCookies: () => undefined as void,
  fromPartitionCalls: [] as string[],
  oauthJars: [] as unknown[],
  order: [] as string[]
}))

vi.mock('electron', () => ({
  app: new Proxy({}, { get: (_target, key) => fake.app[key as string] }),
  BrowserWindow: { getAllWindows: () => [] },
  session: {
    get defaultSession() {
      return {
        flushStorageData: () => fake.storage.push('dom storage'),
        cookies: {
          flushStore: () =>
            new Promise<void>(resolve => {
              fake.storage.push('cookies started')

              fake.finishCookies = () => {
                fake.storage.push('cookies done')
                resolve()
              }
            })
        }
      }
    },
    fromPartition: (partition: string) => {
      // The flush must never open a partition: any call here is a session created during the quit.
      fake.fromPartitionCalls.push(partition)

      return partitionSession(partition)
    }
  }
}))
vi.mock('./main/oauth', () => ({ createdOauthSessions: () => fake.oauthJars }))

/** A persistent partition's session as the fake Electron hands it out: DOM storage and a cookie store that settles. */
function partitionSession(partition: string) {
  return {
    flushStorageData: () => fake.storage.push(`dom storage ${partition}`),
    cookies: {
      flushStore: async () => {
        fake.storage.push(`cookies ${partition}`)
      }
    }
  }
}

// The flush set, in order: DOM storage of the default session, of each session the run created (seen through app
// 'session-created') and of each OAuth jar oauth.ts opened (a per-connection :conn: jar among them) is asked to commit
// first, then every cookie store is flushed (the default one is held open by the test until finishCookies).
const CREATED = [
  'persist:iclone-privy',
  'persist:hermes-remote-oauth',
  'persist:hermes-preview',
  'persist:hermes-embed'
]

const CONN_JAR = 'persist:hermes-remote-oauth:conn:gw-2'
const PARTITIONS = [...CREATED, CONN_JAR]

/** The run as these tests stage it: the four app partitions were opened (session-created), and one :conn: jar. */
function stageCreatedSessions(app: { emit(event: string, ...args: unknown[]): unknown }) {
  for (const partition of CREATED) {
    app.emit('session-created', partitionSession(partition))
  }

  fake.oauthJars = [partitionSession(CONN_JAR)]
}

const FLUSH_STARTED = [
  'dom storage',
  ...PARTITIONS.map(partition => `dom storage ${partition}`),
  'cookies started',
  ...PARTITIONS.map(partition => `cookies ${partition}`)
]

vi.mock('./main/backend-ownership', () => ({ forceKillProcessTree: () => undefined }))
vi.mock('./main/backend-pool', () => ({ backendShutdown: { run: () => new Promise(() => undefined) } }))
vi.mock('./main/backend-state', () => ({
  backendConnectionState: { getProcess: () => null },
  backendPool: new Map()
}))
vi.mock('./main/connection-config', () => ({
  managedConnectionRecoveries: new Map(),
  managedConnectionUpdates: new Map(),
  sshConnections: new Map()
}))
vi.mock('./main/desktop-settings', () => ({ schedulePersistWindowState: { flush: () => undefined } }))
vi.mock('./main/env', () => ({ IS_WINDOWS: false }))
vi.mock('./main/log', () => ({
  flushDesktopLogBufferSync: () => undefined,
  rememberLog: (line: string) => fake.lines.push(line)
}))
vi.mock('./main/managed-ssh', () => ({
  sshBootstrapCoordinator: {
    active: new Set(),
    forceCleanupAll: async () => undefined,
    promises: () => [],
    shutdown: () => fake.order.push('coordinator sealed')
  }
}))
vi.mock('./main/state', () => ({
  bootState: { bootstrapAbortController: null },
  logBufferState: { desktopLogFlushTimer: null },
  beginQuitTeardown: () => fake.order.push('quitting marked'),
  quitState: { isQuittingForHandoff: false },
  windowsState: { translucencyWriteTimer: null }
}))
vi.mock('./main/theme', () => ({
  themeState: { translucencyState: null },
  writePersistedTranslucency: () => undefined
}))

/** Lets a resolved storage flush reach the exit that waits on it (microtasks only; no timer runs). */
async function drain() {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve()
  }
}

function fakeApp() {
  const events = new EventEmitter()

  const app = {
    quits: 0,
    exits: [] as number[],
    emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
    on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
    prependListener: (event: string, listener: () => void) => events.prependListener(event, listener),
    whenReady: () => new Promise(() => undefined),
    quit: () => {
      app.quits += 1
    },
    exit: (code: number) => {
      app.exits.push(code)
    }
  }

  return app
}

describe('the wiring re-quits on a later turn, never inside the pass that called it', () => {
  let before: Map<string, unknown[]>

  beforeEach(() => {
    // The installed handlers go on the worker's own process: remember what was there, put exactly that back.
    before = new Map(SHUTDOWN_SIGNALS.map(signal => [signal, process.rawListeners(signal)]))
    fake.app = fakeApp()
    fake.lines.length = 0
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['setImmediate'] })
  })

  afterEach(() => {
    vi.useRealTimers()

    for (const signal of SHUTDOWN_SIGNALS) {
      for (const listener of process.rawListeners(signal)) {
        if (!before.get(signal)!.includes(listener)) {
          process.removeListener(signal, listener as () => void)
        }
      }
    }
  })

  it('installed: requitAfter() logs, then quits on the next turn (setImmediate), not synchronously or as a microtask', async () => {
    const wiring = await import('./main/shutdown-signals-wiring')
    const app = fake.app as unknown as ReturnType<typeof fakeApp>

    wiring.installAppShutdownSignals()
    wiring.requitAfter('backends')
    await Promise.resolve()
    await Promise.resolve()

    expect(app.quits).toBe(0)
    expect(fake.lines.at(-1)).toBe('[shutdown] backends settled: quitting again on the next turn')
    expect(vi.getTimerCount()).toBe(1)

    vi.runOnlyPendingTimers()
    expect(app.quits).toBe(1)
    expect(fake.lines.at(-1)).toBe('[shutdown] re-quit after backends')
  })

  it('not installed yet: the fallback also quits on the next turn', async () => {
    const wiring = await import('./main/shutdown-signals-wiring')
    const app = fake.app as unknown as ReturnType<typeof fakeApp>

    wiring.requitAfter('ssh')
    await Promise.resolve()
    await Promise.resolve()

    expect(app.quits).toBe(0)
    expect(vi.getTimerCount()).toBe(1)
    vi.runOnlyPendingTimers()
    expect(app.quits).toBe(1)
  })

  it('installed: a signal quit flushes the default session (the install passes flushSessionStorage)', async () => {
    const wiring = await import('./main/shutdown-signals-wiring')
    const app = fake.app as unknown as ReturnType<typeof fakeApp>

    fake.storage.length = 0
    wiring.installAppShutdownSignals()
    stageCreatedSessions(app)
    // As Node calls a signal listener: with the signal's name.
    process.emit('SIGTERM', 'SIGTERM')
    app.emit('before-quit')
    await Promise.resolve()
    await Promise.resolve()

    expect(fake.storage).toEqual(FLUSH_STARTED)
  })

  it('the remote-update cap and its join reach the installed handlers (no-ops before install)', async () => {
    const wiring = await import('./main/shutdown-signals-wiring')

    // Before install: nothing to tell, nothing thrown.
    wiring.capQuitForRemoteUpdates()
    wiring.quitRemoteUpdatesJoined()

    const handle = wiring.installAppShutdownSignals()
    const spy = vi.spyOn(handle, 'capForRemoteUpdates')
    const joined = vi.spyOn(handle, 'remoteUpdatesJoined')

    wiring.capQuitForRemoteUpdates()
    wiring.quitRemoteUpdatesJoined()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(joined).toHaveBeenCalledTimes(1)
  })
})

describe('the teardown seal, the forced-exit stops and the forced-exit relaunch', () => {
  let before: Map<string, unknown[]>

  beforeEach(() => {
    before = new Map(SHUTDOWN_SIGNALS.map(signal => [signal, process.rawListeners(signal)]))
    fake.app = fakeApp()
    fake.lines.length = 0
    fake.order.length = 0
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()

    for (const signal of SHUTDOWN_SIGNALS) {
      for (const listener of process.rawListeners(signal)) {
        if (!before.get(signal)!.includes(listener)) {
          process.removeListener(signal, listener as () => void)
        }
      }
    }
  })

  it('sealQuitTeardown marks the app as quitting, then seals the SSH bootstrap coordinator', async () => {
    const wiring = await import('./main/shutdown-signals-wiring')

    wiring.sealQuitTeardown()
    expect(fake.order).toEqual(['quitting marked', 'coordinator sealed'])
  })

  it('the seal latches the teardown: no later before-quit pass may hold the quit for the active-work dialog', async () => {
    const wiring = await import('./main/shutdown-signals-wiring')

    expect(wiring.quitTeardownSealed()).toBe(false)
    wiring.sealQuitTeardown()
    expect(wiring.quitTeardownSealed()).toBe(true)
  })

  it('a forced exit (second signal) runs every registered stop before app.exit and names it in the line', async () => {
    const wiring = await import('./main/shutdown-signals-wiring')
    const { registerTeardown } = await import('./teardown-registry')

    wiring.installAppShutdownSignals()
    const exitsAtStop: number[][] = []
    const app = fake.app as unknown as { exits: number[] }

    registerTeardown('acp work', () => exitsAtStop.push([...app.exits]))
    registerTeardown('confinement', () => {
      throw new Error('already stopped')
    })
    registerTeardown('payments', () => exitsAtStop.push([...app.exits]))
    registerTeardown('acp market watch', () => exitsAtStop.push([...app.exits]))
    process.emit('SIGTERM', 'SIGTERM')
    process.emit('SIGTERM', 'SIGTERM')
    // The exit waits for the (bounded) storage flush the teardown started: the default cookie store settles here.
    expect(app.exits).toEqual([])
    fake.finishCookies()
    await drain()
    expect(app.exits).toEqual([143])
    expect(exitsAtStop).toEqual([[], [], []])

    const line = fake.lines.find(text => text.includes('forcing exit'))!

    expect(line).toMatch(/stopped: .*acp work.*confinement \(failed\).*payments.*acp market watch/)
    expect(fake.lines).toContain('[shutdown] stopping confinement failed: Error')
  })

  it('will-quit and a forced exit run the SAME registry: each stop once, whichever comes first', async () => {
    const wiring = await import('./main/shutdown-signals-wiring')
    const { registerTeardown } = await import('./teardown-registry')
    const app = fake.app as unknown as { exits: number[]; emit(event: string): void }
    const ran: string[] = []

    wiring.installAppShutdownSignals()
    registerTeardown('acp market watch', () => ran.push('acp market watch'))
    registerTeardown('it server', () => ran.push('it server'))
    app.emit('will-quit')
    expect(ran).toEqual(['acp market watch', 'it server'])
    process.emit('SIGTERM', 'SIGTERM')
    process.emit('SIGTERM', 'SIGTERM')
    fake.finishCookies()
    await drain()
    expect(app.exits).toEqual([143])
    expect(ran).toEqual(['acp market watch', 'it server'])
  })

  it("the 12 s quit cap's forced exit runs the registered relaunch before app.exit; a signal's never does", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'performance'] })
    const wiring = await import('./main/shutdown-signals-wiring')
    const app = fake.app as unknown as { exits: number[]; emit(event: string): void }
    const exitsAtRelaunch: number[][] = []

    wiring.installAppShutdownSignals()
    wiring.relaunchOnForcedQuit(() => exitsAtRelaunch.push([...app.exits]))
    app.emit('before-quit')
    vi.advanceTimersByTime(12_500)
    // N2: the cap's forced exit flushes storage first (Cmd-Q started no flush); app.exit waits for it.
    expect(fake.storage).toContain('cookies started')
    expect(app.exits).toEqual([])
    fake.finishCookies()
    await drain()
    expect(app.exits).toEqual([1])
    expect(exitsAtRelaunch).toEqual([[]])
  })
})

describe("the signal quit's storage flush", () => {
  let before: Map<string, unknown[]>

  beforeEach(() => {
    before = new Map(SHUTDOWN_SIGNALS.map(signal => [signal, process.rawListeners(signal)]))
    fake.app = fakeApp()
    fake.fromPartitionCalls.length = 0
    fake.oauthJars = []
    fake.storage.length = 0
    vi.resetModules()
  })

  afterEach(() => {
    for (const signal of SHUTDOWN_SIGNALS) {
      for (const listener of process.rawListeners(signal)) {
        if (!before.get(signal)!.includes(listener)) {
          process.removeListener(signal, listener as () => void)
        }
      }
    }
  })

  /** The wiring installed (its session-created registry listening) and the run's sessions created. */
  async function installedWiring() {
    const wiring = await import('./main/shutdown-signals-wiring')

    wiring.installAppShutdownSignals()
    stageCreatedSessions(fake.app as unknown as ReturnType<typeof fakeApp>)
    fake.storage.length = 0

    return wiring
  }

  it('flushes DOM storage and awaits the cookie store of the default session', async () => {
    const wiring = await installedWiring()
    let finished = false

    const flushing = wiring.flushSessionStorage().then(() => {
      finished = true
      fake.storage.push('flush resolved')
    })

    // The default cookie store is a deferred that resolves late: drain the microtask queue many times over, so a flush
    // that drops the cookie promise (allSettled of undefined settles within a few ticks) has resolved by now.
    for (let tick = 0; tick < 50; tick += 1) {
      await Promise.resolve()
    }

    expect(fake.storage).toEqual(FLUSH_STARTED)
    expect(finished).toBe(false)
    fake.finishCookies()
    await flushing
    expect(finished).toBe(true)
    // the flush resolves only after the cookie store it awaited
    expect(fake.storage.slice(-2)).toEqual(['cookies done', 'flush resolved'])
  })

  it('flushes every session the run created and every OAuth jar, a per-connection :conn: jar included', async () => {
    const wiring = await installedWiring()
    const flushing = wiring.flushSessionStorage()

    fake.finishCookies()
    await flushing

    for (const partition of PARTITIONS) {
      expect(fake.storage).toContain(`dom storage ${partition}`)
      expect(fake.storage).toContain(`cookies ${partition}`)
    }
  })

  // A store's error message can carry the profile path; the quit's log names the failure by its class only.
  const STORE_PATH = '/private/var/owner-profile/Partitions/hermes-remote-oauth-conn-gw-2/Cookies'

  /** The staged run with the :conn: jar replaced by one whose DOM storage throws or whose cookie store rejects. */
  function failingConnJar(how: 'dom-throws' | 'cookies-reject') {
    const jar = partitionSession(CONN_JAR)

    if (how === 'dom-throws') {
      jar.flushStorageData = () => {
        throw new TypeError(`cannot commit ${STORE_PATH}`)
      }
    } else {
      jar.cookies.flushStore = async () => {
        fake.storage.push(`cookies ${CONN_JAR}`)
        throw new RangeError(`IO error: ${STORE_PATH}`)
      }
    }

    fake.oauthJars = [jar]
  }

  async function signalQuitWithFailingJar(how: 'dom-throws' | 'cookies-reject') {
    const wiring = await installedWiring()
    const app = fake.app as unknown as ReturnType<typeof fakeApp>

    failingConnJar(how)
    fake.lines.length = 0
    process.emit('SIGTERM', 'SIGTERM')
    app.emit('before-quit')
    fake.finishCookies()

    for (let tick = 0; tick < 50; tick += 1) {
      await Promise.resolve()
    }

    return wiring
  }

  it.each([
    ['cookies-reject', 'RangeError'],
    ['dom-throws', 'TypeError']
  ] as const)(
    'one :conn: jar failing (%s): every other store is still flushed, the flush settles, the log names it by class only',
    async (how, name) => {
      await signalQuitWithFailingJar(how)

      // every other session's DOM storage and cookie store, the default one included
      for (const partition of CREATED) {
        expect(fake.storage).toContain(`dom storage ${partition}`)
        expect(fake.storage).toContain(`cookies ${partition}`)
      }

      expect(fake.storage).toContain('cookies done')
      expect(fake.storage).toContain(`cookies ${CONN_JAR}`)
      // the flush settled (the post-quit exit waits only on it) and reported the failure: the class, never the path
      const flushLines = fake.lines.filter(line => line.startsWith('[shutdown] storage flush: '))

      expect(flushLines).toHaveLength(1)
      expect(flushLines[0]).toMatch(new RegExp(`^\\[shutdown\\] storage flush: failed after \\d+ ms \\(${name}\\)$`))
      expect(fake.lines.some(line => line.includes(STORE_PATH) || line.includes('owner-profile'))).toBe(false)
    }
  )

  it('a per-connection OAuth jar is flushed although no session-created was seen for it (the oauth.ts registry)', async () => {
    const wiring = await import('./main/shutdown-signals-wiring')

    wiring.installAppShutdownSignals()
    fake.oauthJars = [partitionSession(CONN_JAR)]
    const flushing = wiring.flushSessionStorage()

    fake.finishCookies()
    await flushing
    expect(fake.storage).toEqual([
      'dom storage',
      `dom storage ${CONN_JAR}`,
      'cookies started',
      `cookies ${CONN_JAR}`,
      'cookies done'
    ])
  })

  it('never creates a partition during the quit: no fromPartition call, and a partition never opened is not flushed', async () => {
    const wiring = await import('./main/shutdown-signals-wiring')

    wiring.installAppShutdownSignals()
    const flushing = wiring.flushSessionStorage()

    fake.finishCookies()
    await flushing
    expect(fake.fromPartitionCalls).toEqual([])
    // A local-only run that opened nothing: only the default session is flushed.
    expect(fake.storage).toEqual(['dom storage', 'cookies started', 'cookies done'])
  })

  it('a session seen twice (created, and also an OAuth jar) is flushed once', async () => {
    const wiring = await import('./main/shutdown-signals-wiring')
    const jar = partitionSession(CONN_JAR)

    wiring.installAppShutdownSignals()
    ;(fake.app as unknown as ReturnType<typeof fakeApp>).emit('session-created', jar)
    fake.oauthJars = [jar]
    const flushing = wiring.flushSessionStorage()

    fake.finishCookies()
    await flushing
    expect(fake.storage.filter(line => line === `cookies ${CONN_JAR}`)).toHaveLength(1)
  })
})
