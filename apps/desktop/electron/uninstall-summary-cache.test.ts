import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createUninstallSummaryCache, isUninstallSummaryValue, readGitHeadSha } from './uninstall-summary-cache'

type Summary = Record<string, unknown>

const isSummary = (value: unknown): value is Summary => Boolean(value) && typeof value === 'object'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-summary-'))
})

afterEach(() => {
  fs.rmSync(dir, { force: true, recursive: true })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => (resolve = r))

  return { promise, resolve }
}

// Every About open re-confirms in these tests (refreshAfterMs 0), unless a test sets its own throttle (K87).
function cacheWith(
  probe: () => Promise<Summary>,
  key = () => `0.0.3|${SHA_A}|/root`,
  throttle: { refreshAfterMs?: number; now?: () => number } = { refreshAfterMs: 0 }
) {
  return createUninstallSummaryCache<Summary>({
    file: () => path.join(dir, 'uninstall-summary.json'),
    isFallback: summary => summary.probe === 'fallback',
    isValue: isSummary,
    key,
    probe,
    ...throttle
  })
}

describe('uninstall summary cache (V3-0b item 2)', () => {
  it('the second open answers from the cache at once while a fresh probe runs behind it', async () => {
    const probe = vi.fn(async (): Promise<Summary> => ({ agent_installed: true, n: probe.mock.calls.length }))
    const cache = cacheWith(probe)

    expect(await cache.get()).toEqual({ agent_installed: true, n: 1 })

    const slow = deferred<Summary>()

    probe.mockImplementationOnce(() => slow.promise)

    // The cold probe is still pending, yet the second open already has the first answer.
    expect(await cache.get()).toEqual({ agent_installed: true, n: 1 })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(cache.pending()).not.toBeNull()

    slow.resolve({ agent_installed: false, n: 2 })
    await cache.pending()

    expect(await cache.get()).toEqual({ agent_installed: false, n: 2 })
  })

  it('survives a relaunch: a new cache under the same key reads the stored answer without waiting', async () => {
    await cacheWith(async () => ({ agent_installed: true }))
      .get()
      .then(() => undefined)

    const never = new Promise<Summary>(() => undefined)
    const relaunched = cacheWith(() => never)

    expect(await relaunched.get()).toEqual({ agent_installed: true })
  })

  it('a new app version or runtime sha never reuses the old answer', async () => {
    let key = `0.0.3|${SHA_A}|/root`
    const probe = vi.fn(async (): Promise<Summary> => ({ key }))
    const cache = cacheWith(probe, () => key)

    await cache.get()
    key = `0.0.3|${SHA_B}|/root`
    expect(await cache.get()).toEqual({ key: `0.0.3|${SHA_B}|/root` })
    key = `0.0.4|${SHA_B}|/root`
    expect(await cache.get()).toEqual({ key: `0.0.4|${SHA_B}|/root` })
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('a fallback answer is served but never cached', async () => {
    const probe = vi.fn(async (): Promise<Summary> => ({ probe: 'fallback' }))
    const cache = cacheWith(probe)

    expect(await cache.get()).toEqual({ probe: 'fallback' })
    expect(fs.existsSync(path.join(dir, 'uninstall-summary.json'))).toBe(false)

    probe.mockResolvedValueOnce({ agent_installed: true })
    expect(await cache.get()).toEqual({ agent_installed: true })
  })

  it('K37 m1: a fallback behind a cached answer drops that answer, in memory and on disk', async () => {
    const file = path.join(dir, 'uninstall-summary.json')
    const probe = vi.fn(async (): Promise<Summary> => ({ agent_installed: true }))
    const cache = cacheWith(probe)

    await cache.get()
    expect(fs.existsSync(file)).toBe(true)

    // The agent's venv is gone: the background probe that confirms the cached answer falls back.
    probe.mockImplementation(async () => ({ agent_installed: false, probe: 'fallback' }))
    expect(await cache.get()).toEqual({ agent_installed: true })
    await cache.pending()

    expect(fs.existsSync(file)).toBe(false)
    // The next open does not serve the stale answer: it waits for (and gets) the fresh one.
    expect(await cache.get()).toEqual({ agent_installed: false, probe: 'fallback' })
    // A relaunch finds nothing on disk either.
    expect(await cacheWith(async () => ({ fresh: true })).get()).toEqual({ fresh: true })
  })

  it('K37 m3: only a summary with both install flags and a home path is an answer', () => {
    const real = { agent_installed: true, gui_installed: true, hermes_home: '/Users/owner/.hermes', platform: 'darwin' }

    expect(isUninstallSummaryValue(real)).toBe(true)
    expect(isUninstallSummaryValue({ ...real, probe: 'fallback' })).toBe(true)

    for (const bad of [
      {},
      [],
      null,
      'summary',
      { agent_installed: true, gui_installed: true },
      { agent_installed: 'yes', gui_installed: true, hermes_home: '/h' },
      { agent_installed: true, gui_installed: true, hermes_home: '' }
    ]) {
      expect(isUninstallSummaryValue(bad)).toBe(false)
    }
  })

  it('K37 m3: an empty object on disk is not served as a cached answer', async () => {
    fs.writeFileSync(
      path.join(dir, 'uninstall-summary.json'),
      JSON.stringify({ key: `0.0.3|${SHA_A}|/root`, value: {} })
    )

    const fresh = { agent_installed: true, gui_installed: true, hermes_home: '/h' }

    const cache = createUninstallSummaryCache<Summary>({
      file: () => path.join(dir, 'uninstall-summary.json'),
      isFallback: summary => summary.probe === 'fallback',
      isValue: isUninstallSummaryValue,
      key: () => `0.0.3|${SHA_A}|/root`,
      probe: async () => fresh
    })

    expect(await cache.get()).toEqual(fresh)
  })

  it('K87: a cached answer is re-confirmed at most once per 10 minutes per key, not on every open', async () => {
    let clock = 1_000_000
    const probe = vi.fn(async (): Promise<Summary> => ({ agent_installed: true }))
    const cache = cacheWith(probe, undefined, { now: () => clock })

    await cache.get()
    expect(probe).toHaveBeenCalledTimes(1)

    for (let open = 0; open < 5; open += 1) {
      clock += 60_000
      await cache.get()
    }

    // 5 opens within 10 minutes of the first probe: answered from the cache, no new Python probe.
    expect(probe).toHaveBeenCalledTimes(1)

    clock += 5 * 60_000
    await cache.get()
    expect(probe).toHaveBeenCalledTimes(2)
    await cache.pending()
  })

  it("K87 per key (critic r1 m4): a probe under one key never makes another key's cached answer fresh", async () => {
    let clock = 1_000_000
    let key = `0.0.3|${SHA_B}|/root`

    // An earlier launch stored the answer for key B.
    await cacheWith(
      async () => ({ agent_installed: true, under: 'B' }),
      () => key
    ).get()

    // This launch starts under key A, whose probe falls back (nothing stored): the last probe is A's.
    key = `0.0.3|${SHA_A}|/root`

    const probe = vi.fn(async (): Promise<Summary> => (key.includes(SHA_A) ? { probe: 'fallback' } : { under: 'B2' }))
    const cache = cacheWith(probe, () => key, { now: () => clock })

    await cache.get()
    expect(probe).toHaveBeenCalledTimes(1)

    // Two minutes later the key is B again: B's cached answer is served at once AND re-confirmed, since no probe
    // under B ran in the last 10 minutes.
    clock += 2 * 60_000
    key = `0.0.3|${SHA_B}|/root`
    expect(await cache.get()).toEqual({ agent_installed: true, under: 'B' })
    expect(probe).toHaveBeenCalledTimes(2)
    await cache.pending()
  })

  it('concurrent opens share one probe', async () => {
    const slow = deferred<Summary>()
    const probe = vi.fn(() => slow.promise)
    const cache = cacheWith(probe)
    const both = Promise.all([cache.get(), cache.get()])

    slow.resolve({ agent_installed: true })
    expect(await both).toEqual([{ agent_installed: true }, { agent_installed: true }])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('an unreadable stored file is no answer', async () => {
    fs.writeFileSync(path.join(dir, 'uninstall-summary.json'), '{not json')
    expect(await cacheWith(async () => ({ fresh: true })).get()).toEqual({ fresh: true })
  })
})

describe('readGitHeadSha', () => {
  const git = (files: Record<string, string>) => {
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, '.git', name)), { recursive: true })
      fs.writeFileSync(path.join(dir, '.git', name), body)
    }
  }

  it('reads a detached HEAD, a loose ref and a packed ref', () => {
    git({ HEAD: `${SHA_A}\n` })
    expect(readGitHeadSha(dir)).toBe(SHA_A)

    git({ HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': `${SHA_B}\n` })
    expect(readGitHeadSha(dir)).toBe(SHA_B)

    fs.rmSync(path.join(dir, '.git', 'refs'), { recursive: true })
    git({ 'packed-refs': `# pack-refs\n${SHA_A} refs/heads/main\n` })
    expect(readGitHeadSha(dir)).toBe(SHA_A)
  })

  it('is null outside a checkout and for a ref that climbs out of .git', () => {
    expect(readGitHeadSha(dir)).toBeNull()
    git({ HEAD: 'ref: refs/../../etc\n' })
    expect(readGitHeadSha(dir)).toBeNull()
  })
})
