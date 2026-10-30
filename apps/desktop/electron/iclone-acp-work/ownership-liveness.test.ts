import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

type G = {
  root: string
  verdict: 'held' | 'unknown' | 'lost'
  verifies: number
  gate: Promise<void> | null
  handlers: Map<string, (...a: unknown[]) => unknown>
  signed: 'in' | 'out'
}

const g = ((globalThis as unknown as { __v3iLiveness: G }).__v3iLiveness ??= {
  root: '',
  verdict: 'held',
  verifies: 0,
  gate: null,
  handlers: new Map(),
  signed: 'in'
})

vi.mock('electron', () => ({
  app: { on: () => undefined, getPath: () => (globalThis as any).__v3iLiveness.root },
  ipcMain: { handle: (ch: string, fn: never) => (globalThis as any).__v3iLiveness.handlers.set(ch, fn) }
}))
vi.mock('../iclone-ownership-proof', async orig => {
  const real = (await orig()) as Record<string, unknown>

  return {
    ...real,
    verifyOwnership: async () => {
      const s = (globalThis as any).__v3iLiveness as G
      s.verifies += 1

      if (s.gate) {
        await s.gate
      }

      const v = s.verdict

      return {
        verdict: v,
        verifications: [],
        agentStatus: null,
        reason: v,
        head: v === 'unknown' ? null : { number: 100, timestamp: 1 },
        transfer: v === 'lost' ? { txHash: '0xabc', block: 99, from: 'a', to: 'b' } : null
      }
    }
  }
})
globalThis.fetch = (() => Promise.reject(new Error('offline'))) as never

const OWNER = '0x00000000000000000000000000000000000000aa'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function listeners() {
  const all: { slug: string; dead: boolean }[] = []

  const start = (slug: string) => {
    const out = new PassThrough(),
      err = new PassThrough()

    let settle: (v: { code: number | null }) => void = () => undefined

    const c = {
      slug,
      dead: false,
      stdout: out,
      stderr: err,
      pid: all.length + 1,
      done: new Promise<{ code: number | null }>(r => (settle = r)),
      kill: () => {
        c.dead = true
        settle({ code: null })
      }
    }

    all.push(c)

    return Promise.resolve(c as never)
  }

  return { all, start, alive: () => all.filter(c => !c.dead) }
}

/** One app launch: fresh modules, real initIcloneOwnership, main.ts's account adapter verbatim, real createAcpWork. */
async function launch(userData: string) {
  vi.resetModules()
  g.root = userData
  g.handlers = new Map()
  const own = await import('../iclone-ownership')
  const { createAcpWork } = await import('./ipc')
  const { createWorkAuditSink } = await import('./audit-sink')
  const ownershipWatch = own.initIcloneOwnership({ getMainWindow: () => null })
  expect(ownershipWatch).not.toBeNull()
  const kids = listeners()

  const work = createAcpWork({
    ipcMain: { handle: () => undefined },
    userDataDir: userData,
    cli: {
      listen: kids.start,
      read: async () => ({ ok: true, json: [] }) as never,
      yieldWindowWatch: () => undefined,
      stopWindowWatch: () => undefined,
      setWindowAdmission: () => undefined,
      keychainPromptShowing: () => false
    },
    streaming: new Set<string>(),
    account: {
      signedIn: () => g.signed,
      prove: (slug: string) => ownershipWatch?.check(slug) ?? Promise.resolve('unknown'),
      walletOf: (slug: string) => ownershipWatch?.walletOf(slug) ?? null
    },
    gestureOk: () => true,
    spendTradeOn: () => false,
    audit: createWorkAuditSink({ dir: path.join(userData, 'acp-work', 'audit'), shared: null }),
    send: () => undefined,
    log: () => undefined
  } as never)

  ownershipWatch?.onChange((slug, state) => work.ownership(slug, state))
  const observe = g.handlers.get('iclone:ownership-observe')!
  const recheck = g.handlers.get('iclone:ownership-recheck')!

  return { own, work, kids, ownershipWatch: ownershipWatch!, observe, recheck }
}

async function sold(userData: string, clockAhead = 0) {
  const { BUNDLED_REGISTRY } = await import('../iclone-ownership-registry')
  const C = BUNDLED_REGISTRY.entries[0]!.contract

  const item = {
    id: `robinhood:${C}:7`,
    chain: 'Robinhood',
    contract: C,
    tokenId: '7',
    name: 'x',
    image: null,
    configured: true
  }

  g.verdict = 'held'
  const spy = clockAhead ? vi.spyOn(Date, 'now').mockImplementation(() => 1_900_000_000_000 + clockAhead) : null
  const s1 = await launch(userData)
  const views = (await s1.observe({}, OWNER, [item])) as { slug: string }[]
  const slug = views[0]!.slug
  const on = await s1.work.online(slug, true)
  await sleep(50)
  const alive1 = s1.kids.alive().length
  s1.work.stopAll()

  for (const k of s1.kids.alive()) {
    ;(k as any).kill()
  }

  spy?.mockRestore()

  return { slug, on, alive1 }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v3i-liveness-'))

/** A presale save on the launch-1 record: a write to the ownership registry that carries no new proof. */
function seedPresale(userData: string, slug: string) {
  const file = (fs.readdirSync(userData, { recursive: true }) as string[])
    .map(p => path.join(userData, p))
    .find(p => p.endsWith('ownership.json') && p.includes(slug))!

  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  record.presale = { at: Date.now(), archive: path.join(userData, 'archive') }
  fs.writeFileSync(file, JSON.stringify(record))
}

describe('V3-I r3 M-F: a resume held on a failed restart proof comes back once the guard proves held', () => {
  it("boot before Wi-Fi: resume unknown, then the guard's own recheck proves held -> 1 listener", async () => {
    const d = tmp()
    const { slug } = await sold(d)
    g.verdict = 'unknown'
    const s2 = await launch(d)
    await s2.work.resume()
    const res: unknown[] = []
    g.verdict = 'held'

    for (let i = 0; i < 8; i += 1) {
      await s2.recheck({}, slug)
      await sleep(30)
      res.push({ alive: s2.kids.alive().length, hold: s2.work.view(slug).hold ?? null })
    }

    expect(res[0]).toEqual({ alive: 1, hold: null })
    expect(res.at(-1)).toEqual({ alive: 1, hold: null })
    s2.work.stopAll()
  })
  it('same with now() frozen (the proof and its join in one millisecond) -> 1 listener', async () => {
    const d = tmp()
    const { slug } = await sold(d)
    g.verdict = 'unknown'
    const s2 = await launch(d)
    await s2.work.resume()
    g.verdict = 'held'
    const t = Date.now() + 5000
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => t)
    await s2.recheck({}, slug)
    await sleep(30)
    spy.mockRestore()
    expect({ alive: s2.kids.alive().length, hold: s2.work.view(slug).hold ?? null }).toEqual({ alive: 1, hold: null })
    s2.work.stopAll()
  })
})

describe('V3-I r5 m-I: a registry save without a new proof never says held (critic probe S1b)', () => {
  it('boot signed-out on a sold iNFT, presale save + sign-in in the same tick -> 0 listeners, unverified', async () => {
    const d = tmp()
    const { slug, alive1 } = await sold(d)
    expect(alive1).toBe(1)
    seedPresale(d, slug)
    g.verdict = 'unknown'
    g.signed = 'out'
    const s2 = await launch(d)
    const events: string[] = []
    s2.ownershipWatch.onChange((_slug, state) => events.push(state))
    await s2.work.resume()
    g.signed = 'in'
    const save = g.handlers.get('iclone:ownership-presale-detached')!({}, slug, 0)
    s2.work.session('in', OWNER)
    await save
    await sleep(60)
    expect(events).not.toContain('held')
    expect({ alive: s2.kids.alive().length, hold: s2.work.view(slug).hold ?? null }).toEqual({
      alive: 0,
      hold: 'ownership-unverified'
    })

    for (let i = 0; i < 3; i += 1) {
      await s2.recheck({}, slug)
      await sleep(10)
    }

    expect(s2.kids.alive().length).toBe(0)
    g.verdict = 'held'
    await s2.recheck({}, slug)
    await sleep(30)
    expect({ alive: s2.kids.alive().length, hold: s2.work.view(slug).hold ?? null }).toEqual({ alive: 1, hold: null })
    g.signed = 'in'
    s2.work.stopAll()
  })
})
