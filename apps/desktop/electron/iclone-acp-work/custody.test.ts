import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { on: () => undefined }, ipcMain: { handle: () => undefined } }))

import { createAcpWatch, type WatchChild } from '../iclone-acp-watch'

import { createWorkAuditSink } from './audit-sink'
import { fakeAccount, fakeAcp, type FakeJob, offerJob, OWNER } from './fake-cli'
import { createAcpWork, OWNERSHIP_RECHECK_MS } from './ipc'
import { readLedger } from './ledger'

const SLUG = 'robinhood-1'
const SLUG2 = 'robinhood-2'
const OTHER_WALLET = '0x00000000000000000000000000000000000000dd'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3i-custody-'))
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

const flush = async () => {
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve()
  }
}

interface Listener extends WatchChild {
  slug: string
  by: 'window' | 'work'
  err: PassThrough
  /** Killed by us or exited on its own. */
  dead: boolean
  exit(code: number): void
}

/** The fake CLI's `events listen` children: what is alive is what a buyer could see as "online". */
function listeners() {
  const all: Listener[] = []

  const start = (by: Listener['by']) => (slug: string) => {
    const out = new PassThrough()
    const err = new PassThrough()
    let settle: (value: { code: number | null }) => void = () => undefined

    const child: Listener = {
      slug,
      by,
      err,
      dead: false,
      stdout: out,
      stderr: err,
      pid: all.length + 1,
      done: new Promise(resolve => (settle = resolve)),
      kill: () => {
        child.dead = true
        settle({ code: null })
      },
      exit: code => {
        child.dead = true
        settle({ code })
      }
    }

    all.push(child)

    return Promise.resolve(child)
  }

  return { all, start, alive: () => all.filter(child => !child.dead) }
}

/**
 * Main as wired in main.ts, with two real listener engines on one registry: the market window's (admitted by WORK)
 * and the supervisor's. The account and the marketplace are fakes; no real acp, no network.
 */
function world(
  opts: {
    jobs?: FakeJob[]
    userDataDir?: string
    owner?: ReturnType<typeof fakeAccount>
    toolsProblem?: () => string | null
  } = {}
) {
  const acp = fakeAcp(opts.jobs ?? [])
  const owner = opts.owner ?? fakeAccount()
  const children = listeners()
  const streaming = new Set<string>()
  let admits: (slug: string) => boolean = () => true

  const window = createAcpWatch({
    start: children.start('window'),
    emit: () => undefined,
    streaming,
    keychainPromptShowing: () => false,
    log: () => undefined,
    admit: slug => admits(slug)
  })

  const work = createAcpWork({
    ipcMain: { handle: () => undefined },
    userDataDir: opts.userDataDir ?? dir,
    cli: {
      listen: children.start('work'),
      read: acp.read,
      yieldWindowWatch: slug => {
        if (window.watching() === slug) {
          window.stop('the WORK supervisor holds this iNFT')
        }
      },
      stopWindowWatch: why => window.stop(why),
      setWindowAdmission: fn => {
        admits = fn
      },
      keychainPromptShowing: () => false,
      toolsProblem: opts.toolsProblem
    },
    streaming,
    account: owner.account,
    gestureOk: () => true,
    spendTradeOn: () => false,
    audit: createWorkAuditSink({ dir: path.join(dir, 'audit'), shared: null }),
    send: () => undefined,
    log: () => undefined
  })

  const connect = async () => {
    await flush()

    for (const child of children.alive()) {
      child.err.write('Listening for events... connected.\n')
    }

    await flush()
  }

  const ledgerOf = (slug: string) => readLedger(path.join(dir, 'acp-work', slug, 'ledger.jsonl'))

  return { acp, owner, children, streaming, window, work, connect, ledgerOf }
}

describe('REL-6: going online without the ACP tools', () => {
  it('is refused with `tools` before any proof or listener; once they are there, it goes online', async () => {
    let problem: string | null = 'ACP tools are not installed: install them from ACP Market (downloads from npm)'
    const w = world({ toolsProblem: () => problem })

    expect(await w.work.online(SLUG, true)).toEqual({ ok: false, error: 'tools' })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(w.children.all).toHaveLength(0)
    expect(w.owner.live.proofs).toBe(0)

    problem = null
    expect(await w.work.online(SLUG, true)).toEqual({ ok: true })
  })
})

describe('offline sticks (M-B): main alone decides who listens for an iNFT WORK holds', () => {
  it('Market window open, owner goes offline, +2 min: 0 listeners, and the window cannot take the slug back', async () => {
    const w = world()

    // The window was listening first, and its child crashed: it waits out its backoff on the slug.
    expect(w.window.watch(SLUG)).toEqual({ ok: true, slug: SLUG })
    await flush()
    w.children.alive()[0].exit(1)
    await flush()
    expect(w.window.watching()).toBe(SLUG)
    expect(w.window.current()).toBeNull()

    expect(await w.work.online(SLUG, true)).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(3_000)
    await w.connect()
    expect(w.work.view(SLUG).state).toBe('online')
    expect(w.children.alive().map(child => child.by)).toEqual(['work'])
    expect(w.window.watching()).toBeNull()

    // The window asks again (a reload, a tab switch): main refuses; the supervisor's events are what it sees.
    expect(w.window.watch(SLUG)).toMatchObject({ ok: false })

    await w.work.offline(SLUG)
    expect(w.work.view(SLUG).state).toBe('offline-safe')

    await vi.advanceTimersByTimeAsync(120_000)
    expect(w.window.watch(SLUG)).toMatchObject({ ok: false })
    await vi.advanceTimersByTimeAsync(120_000)

    expect(w.children.alive()).toHaveLength(0)
    expect(w.window.watching()).toBeNull()
    expect(w.streaming.size).toBe(0)
  })

  it('a window retry already scheduled when WORK takes the slug never spawns', async () => {
    const w = world()

    w.window.watch(SLUG)
    await flush()
    w.children.alive()[0].exit(1)
    await flush()
    // WORK writes its intent while the window is in backoff (a proof still in flight at that moment).
    w.owner.hold()

    const pending = w.work.online(SLUG, true)

    await flush()
    await w.work.offline(SLUG)
    w.owner.release()
    expect(await pending).toEqual({ ok: false, error: 'state' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(w.children.alive()).toHaveLength(0)
    expect(w.children.all.filter(child => child.by === 'window')).toHaveLength(1)
  })

  it('the engine asks main again before every retry: a slug held meanwhile is dropped, not respawned', async () => {
    const children = listeners()
    let admitted = true

    const engine = createAcpWatch({
      start: children.start('window'),
      emit: () => undefined,
      streaming: new Set(),
      keychainPromptShowing: () => false,
      log: () => undefined,
      admit: () => admitted
    })

    engine.watch(SLUG)
    await flush()
    children.alive()[0].exit(1)
    await flush()
    // Nobody tells this engine to stop: only its own ask before the retry can keep it off the slug.
    admitted = false
    await vi.advanceTimersByTimeAsync(120_000)
    expect(children.all).toHaveLength(1)
    expect(engine.watching()).toBeNull()
  })

  it('an iNFT WORK never touched keeps the window listener as before', async () => {
    const w = world()

    expect(w.window.watch('fresh-1')).toEqual({ ok: true, slug: 'fresh-1' })
    await flush()
    expect(w.children.alive().map(child => child.by)).toEqual(['window'])
  })
})

describe('custody (M-C): sign-out, wallet switch, sale, restart', () => {
  it('sign-out stops every listener at once, the window one included, and records why', async () => {
    const w = world()

    await w.work.online(SLUG, true)
    await w.work.online(SLUG2, true)
    w.window.watch('fresh-1')
    await w.connect()
    expect(w.children.alive()).toHaveLength(3)

    w.owner.live.signedIn = 'out'
    w.work.session('out', null)

    // Synchronously: no tick passes between the sign-out and the kills.
    expect(w.children.alive()).toHaveLength(0)
    expect(w.work.view(SLUG)).toMatchObject({ state: 'offline', hold: 'signed-out' })
    expect(w.work.view(SLUG2)).toMatchObject({ state: 'offline', hold: 'signed-out' })
    expect(w.ledgerOf(SLUG).records.at(-1)).toMatchObject({ kind: 'offline', note: 'signed-out' })
    expect(w.window.watch('fresh-1')).toMatchObject({ ok: false })
    expect(await w.work.online(SLUG, true)).toEqual({ ok: false, error: 'sign-in' })

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(w.children.alive()).toHaveLength(0)
  })

  it('a wallet switch stops every listener at once', async () => {
    const w = world()

    w.work.session('in', OWNER)
    await w.work.online(SLUG, true)
    await w.work.online(SLUG2, true)
    await w.connect()
    expect(w.children.alive()).toHaveLength(2)

    w.work.session('in', OTHER_WALLET)
    expect(w.children.alive()).toHaveLength(0)
    expect(w.work.view(SLUG).hold).toBe('wallet-switch')
    expect(w.ledgerOf(SLUG2).records.at(-1)).toMatchObject({ kind: 'offline', note: 'wallet-switch' })
    // The guard still tracks the old wallet: going online again is refused for this account.
    expect(await w.work.online(SLUG, true)).toEqual({ ok: false, error: 'ownership' })
    expect(w.children.alive()).toHaveLength(0)
  })

  it('a sale is stopped within one ownership check and marked as such', async () => {
    const w = world()

    await w.work.online(SLUG, true)
    await w.connect()
    expect(w.children.alive()).toHaveLength(1)

    w.owner.live.state = 'lost'
    await vi.advanceTimersByTimeAsync(OWNERSHIP_RECHECK_MS)

    expect(w.children.alive()).toHaveLength(0)
    expect(w.work.view(SLUG)).toMatchObject({ state: 'offline', hold: 'ownership-lost' })
    expect(w.ledgerOf(SLUG).records.at(-1)).toMatchObject({ kind: 'offline', note: 'ownership-lost' })
  })

  it("the guard's own check (a wallet scan) stops it at once, without waiting for WORK's", async () => {
    const w = world()

    await w.work.online(SLUG, true)
    await w.connect()
    w.work.ownership(SLUG, 'lost')
    expect(w.children.alive()).toHaveLength(0)
    expect(w.work.view(SLUG).hold).toBe('ownership-lost')
    // `unknown` is never a loss: an online iNFT stays online through a failed check.
    await w.work.online(SLUG2, true)
    await w.connect()
    w.owner.live.state = 'unknown'
    await vi.advanceTimersByTimeAsync(OWNERSHIP_RECHECK_MS)
    expect(w.work.view(SLUG2).hold).toBeNull()
    expect(w.children.alive().map(child => child.slug)).toEqual([SLUG2])
  })

  it('restart with ownership kept: nothing listens until the fresh proof says held', async () => {
    const before = world()

    await before.work.online(SLUG, true)
    await before.connect()
    before.work.stopAll()

    const owner = fakeAccount()

    owner.hold()

    const after = world({ owner })
    const resumed = after.work.resume()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(after.children.alive()).toHaveLength(0)
    expect(after.work.view(SLUG).hold).toBe('ownership-unverified')
    expect(after.window.watch(SLUG)).toMatchObject({ ok: false })

    owner.release()
    expect(await resumed).toEqual([SLUG])
    await after.connect()
    expect(owner.live.proofs).toBe(1)
    expect(after.children.alive().map(child => child.by)).toEqual(['work'])
    expect(after.work.view(SLUG)).toMatchObject({ state: 'online', hold: null })
  })

  it('restart with ownership lost: it stays offline and is marked as such', async () => {
    const before = world()

    await before.work.online(SLUG, true)
    await before.connect()
    before.work.stopAll()

    const after = world({ owner: fakeAccount({ state: 'lost' }) })

    expect(await after.work.resume()).toEqual([])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(after.children.alive()).toHaveLength(0)
    expect(after.work.view(SLUG)).toMatchObject({ state: 'offline', hold: 'ownership-lost' })
    expect(after.ledgerOf(SLUG).records.at(-1)).toMatchObject({ kind: 'offline', note: 'ownership-lost' })

    // A third start: the recorded reason outlives the restart, and nothing comes back.
    const third = world({ owner: fakeAccount({ state: 'held' }) })

    expect(await third.work.resume()).toEqual([])
    expect(third.work.view(SLUG).hold).toBe('ownership-lost')
  })

  it('restart signed out: it waits, without a proof, and resumes only after a sign-in and a held proof', async () => {
    const before = world()

    await before.work.online(SLUG, true)
    before.work.stopAll()

    const owner = fakeAccount({ signedIn: null })
    const after = world({ owner })

    expect(await after.work.resume()).toEqual([])
    expect(owner.live.proofs).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(after.children.alive()).toHaveLength(0)

    owner.live.signedIn = 'in'
    after.work.session('in', OWNER)
    await after.connect()
    expect(after.children.alive().map(child => child.by)).toEqual(['work'])
  })

  it('going online needs a signed-in owner and a held proof', async () => {
    const owner = fakeAccount({ state: 'unknown' })
    const w = world({ owner })

    expect(await w.work.online(SLUG, true)).toEqual({ ok: false, error: 'ownership' })
    owner.live.signedIn = 'out'
    expect(await w.work.online(SLUG, true)).toEqual({ ok: false, error: 'sign-in' })
    await flush()
    expect(w.children.all).toHaveLength(0)
  })
})

describe('jobs in flight at a sign-out', () => {
  it('the listener stops anyway (the account that could finish them is gone); the jobs stay in the report', async () => {
    const w = world({ jobs: [offerJob('2', { status: 'funded' })] })

    await w.work.online(SLUG, true)
    await w.connect()
    w.work.session('out', null)
    expect(w.children.alive()).toHaveLength(0)
    expect(w.work.watchdog.stopReport(SLUG).open).toEqual([{ jobId: '2', status: 'funded' }])
  })
})
