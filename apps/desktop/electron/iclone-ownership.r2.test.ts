import * as fs from 'node:fs'
import os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  type Archiver,
  type CommandRunner,
  createArchiver,
  createDeactivationDoor,
  createOwnershipService,
  DAY_MS,
  type DeactivationDoor,
  DELETE_WAIT_ATTEMPTS,
  economyRefusal,
  GH_NOT_INSTALLED,
  isInftDeactivated,
  NOT_FOUND,
  resolveGh
} from './iclone-ownership'
import { type FetchLike, type ProofResult, TRANSFER_TOPIC, verifyOwnership } from './iclone-ownership-proof'
import { BUNDLED_REGISTRY } from './iclone-ownership-registry'
import type { DeactivationStep } from './iclone-ownership-store'
import { listRecordSlugs, mirrorFile, readRecord } from './iclone-ownership-store'

const OWNER = '0x' + 'a1'.repeat(20)
const BUYER = '0x' + 'b7'.repeat(20)
const THIRD = '0x' + 'c3'.repeat(20)
const ENTRY = BUNDLED_REGISTRY.entries[0]
const C = ENTRY.contract

const ITEM = {
  id: `robinhood:${C}:7`,
  chain: 'Robinhood',
  contract: C,
  tokenId: '7',
  name: 'i01 #7',
  image: null,
  configured: true
}

const SLUG = `robinhood-${C}-7`
const T0 = 1_800_000_000_000
const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0')

let root: string
let now: number

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'r9r2-'))
  now = T0
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

/** A chain whose holder, logs and head time the test moves through days. */
interface Chain {
  holder: string
  logs: { from: string; to: string; block: number; tx: string }[]
  headTime: number
  head: number
}

function chainFetch(c: Chain): FetchLike {
  return async (url, init) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

    if (url.includes('/api/v2/')) {
      return json(url.endsWith('/transfers') ? { items: [] } : { owner: { hash: c.holder } })
    }

    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] }

    switch (method) {
      case 'eth_chainId':
        return json({ result: '0x' + ENTRY.chainId.toString(16) })

      case 'eth_getBlockByNumber':
        return json({ result: { number: '0x' + c.head.toString(16), timestamp: '0x' + c.headTime.toString(16) } })

      case 'eth_call':
        return json({ result: pad(c.holder) })
      case 'eth_getLogs': {
        const r = params[0] as { fromBlock: string; toBlock: string }
        const [lo, hi] = [Number.parseInt(r.fromBlock, 16), Number.parseInt(r.toBlock, 16)]

        return json({
          result: c.logs
            .filter(l => l.block >= lo && l.block <= hi)
            .map((l, i) => ({
              topics: [TRANSFER_TOPIC, pad(l.from), pad(l.to), pad('0x7')],
              data: '0x',
              blockNumber: '0x' + l.block.toString(16),
              logIndex: '0x' + i.toString(16),
              transactionHash: l.tx
            }))
        })
      }

      default:
        return json({ error: { message: 'unsupported' } })
    }
  }
}

function recordingDoor(results: (todo: DeactivationStep['step'][]) => DeactivationStep[]) {
  const calls: { todo: DeactivationStep['step'][]; acpPresent: boolean }[] = []

  const door: DeactivationDoor = {
    applyDeactivation: async (slug, _r, _e, todo) => {
      calls.push({ todo, acpPresent: fs.existsSync(path.join(root, 'inft', slug, 'acp')) })

      return results(todo)
    }
  }

  return { door, calls }
}

const okArchiver: Archiver = {
  archive: async () => ({ ok: true, dir: '/tmp/a', remote: null }),
  ghStatus: async () => ({ ok: true, detail: '' })
}

function lostProof(chainTime: number): ProofResult {
  return {
    verdict: 'lost',
    verifications: [],
    transfer: {
      txHash: '0x' + 'cd'.repeat(32),
      block: 90,
      from: OWNER,
      to: BUYER,
      timestamp: chainTime - 60,
      explorerUrl: 'x'
    },
    head: { number: 120, timestamp: chainTime },
    agentStatus: null,
    reason: 'agree'
  }
}

describe('R9 r2 — resale after the loss', () => {
  it('A->B on day 0, B->C on day 3: the day-8 tick still proves lost and calls the door once', async () => {
    const OUT = '0x' + 'e1'.repeat(32)

    const chain: Chain = {
      holder: OWNER,
      logs: [{ from: '0x' + '0'.repeat(40), to: OWNER, block: 10, tx: '0x' + 'aa'.repeat(32) }],
      headTime: T0 / 1000,
      head: 5000
    }

    const { door, calls } = recordingDoor(todo => todo.map(step => ({ step, ok: true, detail: 'fake' })))

    const s = createOwnershipService({
      root,
      now: () => now,
      registry: () => Promise.resolve(BUNDLED_REGISTRY),
      verify: (entry, tokenId, wallet, since) =>
        verifyOwnership({ entry, tokenId, wallet, sinceBlock: since, fetch: chainFetch(chain) }),
      door,
      archiver: okArchiver
    })

    await s.observe(OWNER, [ITEM])
    expect(readRecord(root, SLUG)?.state).toBe('held')
    chain.holder = BUYER
    chain.logs.push({ from: OWNER, to: BUYER, block: 9000, tx: OUT })
    chain.head = 9500
    expect((await s.check(SLUG))?.state).toBe('lost')
    now += 3 * DAY_MS
    chain.holder = THIRD
    chain.logs.push({ from: BUYER, to: THIRD, block: 9800, tx: '0x' + 'e2'.repeat(32) })
    chain.head = 10000
    expect((await s.check(SLUG))?.state).toBe('lost')
    now = T0 + 8 * DAY_MS
    chain.headTime = T0 / 1000 + 8 * 86400
    expect(await s.tick()).toEqual([SLUG])
    expect(calls).toHaveLength(1)
    expect(readRecord(root, SLUG)?.transfer?.txHash).toBe(OUT)
  })
})

describe('R9 r2 — the deactivation door', () => {
  function lostService(door: DeactivationDoor) {
    let next: ProofResult = { ...lostProof(T0 / 1000), verdict: 'held', transfer: null, reason: 'held' }

    const s = createOwnershipService({
      root,
      now: () => now,
      registry: () => Promise.resolve(BUNDLED_REGISTRY),
      verify: () => Promise.resolve(next),
      door,
      archiver: okArchiver
    })

    return {
      s,
      setNext: (p: ProofResult) => {
        next = p
      },
      async prove() {
        await s.observe(OWNER, [ITEM])
        fs.mkdirSync(path.join(root, 'inft', SLUG, 'acp'), { recursive: true })
        next = lostProof(T0 / 1000)
        await s.check(SLUG)
      }
    }
  }

  it('runs BEFORE any deletion, retries only the failed step hourly, deletes once complete', async () => {
    let virtualsOk = false

    const { door, calls } = recordingDoor(todo =>
      todo.map(step => ({ step, ok: step !== 'virtuals' || virtualsOk, detail: 'fake' }))
    )

    const w = lostService(door)
    await w.prove()

    const res = await w.s.choose(SLUG, 'delete', '#7')
    expect(res.ok).toBe(true)
    expect(calls[0]).toEqual({ todo: ['onchain', 'virtuals', 'prompt'], acpPresent: true })
    // The rename failed: the CLI config is kept for the retry, and the UI is told.
    expect(fs.existsSync(path.join(root, 'inft', SLUG, 'acp'))).toBe(true)
    expect(res.view).toMatchObject({ deactivationComplete: false, pendingSteps: ['virtuals'] })

    now += 60 * 60_000
    w.setNext(lostProof(T0 / 1000 + 3600))
    expect(await w.s.tick()).toEqual([])
    expect(calls).toHaveLength(2)
    expect(calls[1].todo).toEqual(['virtuals'])

    virtualsOk = true
    now += 60 * 60_000
    expect(await w.s.tick()).toEqual([SLUG])
    expect(calls[2]).toEqual({ todo: ['virtuals'], acpPresent: true })
    expect(fs.readdirSync(path.join(root, 'inft', SLUG))).toEqual(['ownership.json'])
    const done = readRecord(root, SLUG)
    expect(done?.deactivation).toMatchObject({ complete: true, attempts: 3 })
    expect(done?.choice?.deletePending).toBe(false)
    // complete: the tick never calls the door again
    now += 60 * 60_000
    await w.s.tick()
    expect(calls).toHaveLength(3)
  })

  it("an owner's deletion stops waiting after a day of failed retries", async () => {
    const { door, calls } = recordingDoor(todo => todo.map(step => ({ step, ok: step !== 'virtuals', detail: 'x' })))
    const w = lostService(door)
    await w.prove()
    await w.s.choose(SLUG, 'delete', '#7')

    for (let i = 1; i < DELETE_WAIT_ATTEMPTS; i++) {
      now += 60 * 60_000
      w.setNext(lostProof(T0 / 1000 + i * 3600))
      await w.s.tick()
    }

    expect(calls).toHaveLength(DELETE_WAIT_ATTEMPTS)
    expect(fs.existsSync(path.join(root, 'inft', SLUG, 'acp'))).toBe(false)
    expect(readRecord(root, SLUG)?.deactivation?.complete).toBe(false)
  })

  it('a retry never runs on an unknown proof, and a thrown door is recorded as failed steps', async () => {
    let throws = true

    const door: DeactivationDoor = {
      applyDeactivation: async (_s, _r, _e, todo) => {
        if (throws) {
          throw new Error('acp crashed')
        }

        return todo.map(step => ({ step, ok: true, detail: 'ok' }))
      }
    }

    const w = lostService(door)
    await w.prove()
    await w.s.choose(SLUG, 'keep', '')
    expect(readRecord(root, SLUG)?.deactivation?.steps.every(st => !st.ok)).toBe(true)
    throws = false
    w.setNext({ ...lostProof(0), verdict: 'unknown', transfer: null, head: null, reason: 'rpc down' })
    now += 60 * 60_000
    expect(await w.s.tick()).toEqual([])
    expect(readRecord(root, SLUG)?.deactivation?.complete).toBe(false)
  })

  it('the production door: prompt ok only after the header landed; steps already ok are not re-run', async () => {
    const runs: string[][] = []

    const run: CommandRunner = async (_cmd, args) => {
      runs.push(args)

      return { code: 0, stdout: '{}', stderr: '' }
    }

    const real = createDeactivationDoor({ root, acpBin: '/fake/acp', run })
    const w = lostService(real)
    await w.prove()
    await w.s.choose(SLUG, 'keep', '')
    let r = readRecord(root, SLUG)
    expect(r?.deactivation?.steps.find(st => st.step === 'prompt')?.ok).toBe(false)
    // r4: a read-only `agent whoami` first (the name a return offers back), then the rename.
    const renames = () => runs.filter(a => a.includes('update'))
    expect(runs[0]).toEqual(['--inft', SLUG, 'agent', 'whoami', '--json'])
    expect(renames()).toHaveLength(1)
    expect(renames()[0]).toContain('[iNFT Deactivated] #7')

    expect(await w.s.promptHeaderWritten(`${C}-7`.toLowerCase())).toBeGreaterThanOrEqual(0)
    const profile = (await w.s.list())[0].profileSlug
    expect(await w.s.promptHeaderWritten(profile)).toBe(1)
    // r3: the report settles the prompt step at once — no hourly wait.
    r = readRecord(root, SLUG)
    expect(r?.deactivation?.complete).toBe(true)
    now += 60 * 60_000
    w.setNext(lostProof(T0 / 1000 + 3600))
    expect(await w.s.tick()).toEqual([])
    // the Virtuals rename was not run a second time
    expect(renames()).toHaveLength(1)
  })
})

describe('R9 r2 — archive redaction and gh', () => {
  const MNEMONIC = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
  const CARD = '4242 4242 4242 4242'

  function setup(gh: () => string | null, codes: Record<string, number> = {}) {
    const home = path.join(root, 'home')
    const hermes = path.join(root, 'hermes')

    const record = {
      slug: SLUG,
      inft: {
        id: ITEM.id,
        chain: 'Robinhood',
        chainId: ENTRY.chainId,
        contract: C,
        tokenId: '7',
        name: 'i01 #7',
        image: null
      },
      wallet: OWNER,
      state: 'held',
      transfer: null
    } as unknown as Parameters<Archiver['archive']>[0]

    const calls: string[] = []

    const run: CommandRunner = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`)

      return { code: codes[path.basename(cmd)] ?? 0, stdout: 'https://github.com/o/r', stderr: '' }
    }

    const archiver = createArchiver({ root, home, hermesHome: hermes, run, now: () => now, gh })

    return { home, hermes, record, archiver, calls }
  }

  it('MEMORY.md loses the seed and the card; a database with a key is never copied', async () => {
    const t = setup(() => null)
    const { profileSlugFor } = await import('../src/iclone-shared/inft-slug')
    const prof = path.join(t.hermes, 'profiles', profileSlugFor(C, '7'))
    fs.mkdirSync(prof, { recursive: true })
    fs.writeFileSync(path.join(prof, 'MEMORY.md'), `my words: ${MNEMONIC}\ncard ${CARD}\n`)
    fs.writeFileSync(path.join(prof, 'state.db'), `SQLite format 3\u0000 private_key=0x${'ab'.repeat(32)}`)
    fs.writeFileSync(path.join(prof, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
    const res = await t.archiver.archive(t.record, false)
    expect(res.ok).toBe(true)
    const out = path.join(t.home, 'iclone-os-archive', SLUG, 'hermes-profile')
    const memory = fs.readFileSync(path.join(out, 'MEMORY.md'), 'utf8')
    expect(memory).not.toContain('abandon ability')
    expect(memory).not.toContain(CARD)
    expect(fs.existsSync(path.join(out, 'state.db'))).toBe(false)
    expect(fs.existsSync(path.join(out, 'blob.bin'))).toBe(false)
    const manifest = JSON.parse(fs.readFileSync(path.join(t.home, 'iclone-os-archive', SLUG, 'MANIFEST.json'), 'utf8'))
    expect(manifest.leftOut).toEqual(expect.arrayContaining(['state.db', 'blob.bin']))
  })

  it('gh is resolved from the install dirs; missing gh says "GitHub CLI not installed"', async () => {
    expect(resolveGh('/usr/bin', f => f === '/opt/homebrew/bin/gh')).toBe('/opt/homebrew/bin/gh')
    expect(resolveGh('/x/bin', f => f === '/x/bin/gh')).toBe('/x/bin/gh')
    expect(resolveGh('relative/bin', () => false)).toBeNull()

    const missing = setup(() => null)
    expect((await missing.archiver.ghStatus()).detail).toBe(GH_NOT_INSTALLED)
    const res = await missing.archiver.archive(missing.record, true)
    expect(res).toMatchObject({ ok: false, error: GH_NOT_INSTALLED })

    const enoent = setup(() => '/opt/homebrew/bin/gh', { gh: NOT_FOUND })
    expect((await enoent.archiver.archive(enoent.record, true)).error).toBe(GH_NOT_INSTALLED)

    const found = setup(() => '/opt/homebrew/bin/gh')
    expect((await found.archiver.archive(found.record, true)).ok).toBe(true)
    expect(found.calls.filter(c => c.startsWith('gh ')).length).toBe(0)
    expect(found.calls.some(c => c.startsWith('/opt/homebrew/bin/gh repo create'))).toBe(true)
  })
})

describe('R9 r2 — economy gate, mirror, Prepare to sell', () => {
  async function lost() {
    let next: ProofResult = { ...lostProof(T0 / 1000), verdict: 'held', transfer: null, reason: 'held' }

    const s = createOwnershipService({
      root,
      now: () => now,
      registry: () => Promise.resolve(BUNDLED_REGISTRY),
      verify: () => Promise.resolve(next),
      door: recordingDoor(todo => todo.map(step => ({ step, ok: true, detail: '' }))).door,
      archiver: okArchiver
    })

    await s.observe(OWNER, [ITEM])

    return {
      s,
      prove: async () => {
        next = lostProof(T0 / 1000)
        await s.check(SLUG)
      }
    }
  }

  it('refuses value-moving acp commands only for a proven-lost iNFT', async () => {
    const w = await lost()
    expect(isInftDeactivated(SLUG, root)).toBe(false)
    expect(economyRefusal(SLUG, ['card', 'limit', 'set', '--amount', '5'], root)).toBeNull()
    await w.prove()
    expect(isInftDeactivated(SLUG, root)).toBe(true)
    expect(economyRefusal(SLUG, ['card', 'limit', 'set', '--amount', '5'], root)).toMatch(/^iNFT Deactivated/)
    expect(economyRefusal(SLUG, ['email', 'compose', '--to', 'a@b.c'], root)).toMatch(/refused/)
    expect(economyRefusal(SLUG, ['wallet', 'balance', '--json'], root)).toBeNull()
    expect(economyRefusal(SLUG, ['wallet', 'sol', 'balance'], root)).toBeNull()
    expect(isInftDeactivated('../x', root)).toBe(false)
  })

  it("R6's Detach (whole inft/<slug> removed) cannot erase the signal: the mirror restores it", async () => {
    const w = await lost()
    await w.prove()
    fs.rmSync(path.join(root, 'inft', SLUG), { recursive: true, force: true })
    expect(listRecordSlugs(root)).toEqual([SLUG])
    expect(readRecord(root, SLUG)?.state).toBe('lost')
    expect(fs.existsSync(path.join(root, 'inft', SLUG, 'ownership.json'))).toBe(true)
    // a corrupted primary is quarantined and the mirror restores it (fail closed, r5)
    fs.writeFileSync(path.join(root, 'inft', SLUG, 'ownership.json'), '{"schema":1,"state":"lost"')
    expect(readRecord(root, SLUG)?.state).toBe('lost')
    expect(fs.readdirSync(path.join(root, 'inft', SLUG)).some(f => f.includes('.corrupt-'))).toBe(true)
    expect(fs.existsSync(mirrorFile(root, SLUG))).toBe(true)
  })

  it('Prepare to sell records the detach after the copy', async () => {
    const w = await lost()
    expect(await w.s.presaleDetached(SLUG, 3)).toBeNull()
    expect((await w.s.prepareSell(SLUG, false)).ok).toBe(true)
    fs.rmSync(path.join(root, 'inft', SLUG), { recursive: true, force: true })
    const v = await w.s.presaleDetached(SLUG, 3)
    expect(v?.presale?.detachedAt).toBe(now)
    expect(v?.history.at(-1)?.note).toMatch(/agent detached \(3 local items removed\)/)
  })
})
