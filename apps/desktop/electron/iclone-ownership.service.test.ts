import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type Archiver,
  createOwnershipService,
  DAY_MS,
  type DeactivationDoor,
  deleteLocalInftData,
  redactOwnershipLog
} from './iclone-ownership'
import type { ProofResult } from './iclone-ownership-proof'
import { BUNDLED_REGISTRY, createRegistrySource, validateRegistry } from './iclone-ownership-registry'
import { mirrorFile, ownershipFile, readRecord } from './iclone-ownership-store'

const OWNER = '0x' + 'a1'.repeat(20)
const BUYER = '0x' + 'b7'.repeat(20)
const C = BUNDLED_REGISTRY.entries[0].contract

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

const held = (): ProofResult => ({
  verdict: 'held',
  verifications: [],
  transfer: null,
  head: { number: 100, timestamp: T0 / 1000 },
  agentStatus: null,
  reason: 'held'
})

const lost = (chainTime = T0 / 1000): ProofResult => ({
  verdict: 'lost',
  verifications: [],
  transfer: {
    txHash: '0x' + 'cd'.repeat(32),
    block: 90,
    from: OWNER,
    to: BUYER,
    timestamp: chainTime - 60,
    explorerUrl: 'https://x/tx'
  },
  head: { number: 120, timestamp: chainTime },
  agentStatus: null,
  reason: 'agree'
})

const unknown = (): ProofResult => ({
  verdict: 'unknown',
  verifications: [],
  transfer: null,
  head: null,
  agentStatus: null,
  reason: 'rpc timeout'
})

let root: string
let now: number
let next: ProofResult
let door: DeactivationDoor & { calls: number }
let archiver: Archiver

function service() {
  return createOwnershipService({
    root,
    now: () => now,
    registry: () => Promise.resolve(BUNDLED_REGISTRY),
    verify: () => Promise.resolve(next),
    door,
    archiver
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'r9-'))
  now = T0
  next = held()
  door = {
    calls: 0,
    applyDeactivation: vi.fn(async (_slug, _record, _entry, todo) => {
      door.calls += 1

      return todo.map((step: unknown) => ({ step, ok: true, detail: 'fake' }))
    })
  }
  archiver = {
    archive: vi.fn(async () => ({ ok: true, dir: '/tmp/archive', remote: null })),
    ghStatus: async () => ({ ok: true, detail: '' })
  }
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('ownership guard', () => {
  it('tracks a configured iNFT and proves it held', async () => {
    const views = await service().observe(OWNER, [ITEM])
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ state: 'held', pending: false, deactivated: false })
  })

  it('an empty scan with an unknown proof never marks lost', async () => {
    const s = service()
    await s.observe(OWNER, [ITEM])
    next = unknown()
    const views = await s.observe(OWNER, [])
    expect(views[0]).toMatchObject({ state: 'held', pending: true })
  })

  it('a proven loss starts the 7-day clock; unknown later keeps the loss', async () => {
    const s = service()
    await s.observe(OWNER, [ITEM])
    next = lost()
    const [v] = await s.observe(OWNER, [])
    expect(v).toMatchObject({ state: 'lost', deactivated: true, daysLeft: 7 })
    expect(v.deadlineAt).toBe(T0 + 7 * DAY_MS)
    now += 20 * 60_000
    next = unknown()
    expect((await s.check(SLUG))?.state).toBe('lost')
  })

  it('the clock set forward cannot fire: chain time must also be 7 days past', async () => {
    const s = service()
    await s.observe(OWNER, [ITEM])
    next = lost()
    await s.observe(OWNER, [])
    now = T0 + 30 * DAY_MS
    next = lost(T0 / 1000 + 3600)
    expect(await s.tick()).toEqual([])
    expect(door.calls).toBe(0)
  })

  it('fires once, by the timer, when wall clock + chain time + a fresh proof agree', async () => {
    const s = service()
    await s.observe(OWNER, [ITEM])
    next = lost()
    await s.observe(OWNER, [])
    now = T0 + 7 * DAY_MS + 1
    next = lost(T0 / 1000 + 7 * 86400 + 5)
    expect(await s.tick()).toEqual([SLUG])
    expect(await s.tick()).toEqual([])
    expect(door.calls).toBe(1)
    expect(readRecord(root, SLUG)?.deactivation?.by).toBe('timer')
  })

  it('a token back in the wallet before the deadline cancels the clock', async () => {
    const s = service()
    await s.observe(OWNER, [ITEM])
    next = lost()
    await s.observe(OWNER, [])
    now = T0 + 8 * DAY_MS
    next = held()
    await s.tick()
    expect(door.calls).toBe(0)
    expect(readRecord(root, SLUG)?.state).toBe('held')
  })

  it('a corrupted ownership.json is quarantined and can never deactivate', async () => {
    const s = service()
    await s.observe(OWNER, [ITEM])
    fs.writeFileSync(ownershipFile(root, SLUG), '{"schema":1,"slug":"' + SLUG + '","state":"lost"}')
    now = T0 + 30 * DAY_MS
    expect(await s.tick()).toEqual([])
    expect(door.calls).toBe(0)
    expect(fs.readdirSync(path.dirname(ownershipFile(root, SLUG))).some(f => f.includes('corrupt'))).toBe(true)
  })

  it('a lost record without its proof fails validation', async () => {
    const s = service()
    await s.observe(OWNER, [ITEM])
    const raw = JSON.parse(fs.readFileSync(ownershipFile(root, SLUG), 'utf8'))
    fs.writeFileSync(ownershipFile(root, SLUG), JSON.stringify({ ...raw, state: 'lost', deadlineAt: T0 }))
    // the invalid primary is quarantined; the last valid copy (the mirror) wins
    expect(readRecord(root, SLUG)?.state).toBe('held')
    fs.rmSync(mirrorFile(root, SLUG))
    fs.writeFileSync(ownershipFile(root, SLUG), JSON.stringify({ ...raw, state: 'lost', deadlineAt: T0 }))
    expect(readRecord(root, SLUG)).toBeNull()
  })

  it('delete needs the typed #n, keeps ownership.json, and the owner choice applies the door', async () => {
    const s = service()
    await s.observe(OWNER, [ITEM])
    fs.mkdirSync(path.join(root, 'inft', SLUG, 'acp'), { recursive: true })
    next = lost()
    await s.observe(OWNER, [])
    expect((await s.choose(SLUG, 'delete', '#6')).ok).toBe(false)
    expect(fs.existsSync(path.join(root, 'inft', SLUG, 'acp'))).toBe(true)
    const res = await s.choose(SLUG, 'delete', '#7')
    expect(res).toMatchObject({ ok: true, deleteHermesProfile: true })
    expect(fs.readdirSync(path.join(root, 'inft', SLUG))).toEqual(['ownership.json'])
    expect(door.calls).toBe(1)
  })

  it('keep deletes nothing; later neither deletes nor deactivates', async () => {
    const s = service()
    await s.observe(OWNER, [ITEM])
    next = lost()
    await s.observe(OWNER, [])
    expect((await s.choose(SLUG, 'later', '')).deleteHermesProfile).toBe(false)
    expect(door.calls).toBe(0)
    await s.choose(SLUG, 'keep', '')
    expect(door.calls).toBe(1)
  })

  it('a failed archive deletes nothing', async () => {
    archiver.archive = vi.fn(async () => ({ ok: false, dir: null, remote: null, error: 'gh not signed in' }))
    const s = service()
    await s.observe(OWNER, [ITEM])
    fs.mkdirSync(path.join(root, 'inft', SLUG, 'notes'), { recursive: true })
    next = lost()
    await s.observe(OWNER, [])
    expect((await s.choose(SLUG, 'archive-github', '#7')).ok).toBe(false)
    expect(fs.existsSync(path.join(root, 'inft', SLUG, 'notes'))).toBe(true)
  })

  it('prepare to sell makes the copy and marks pre-sale', async () => {
    const s = service()
    await s.observe(OWNER, [ITEM])
    const res = await s.prepareSell(SLUG, false)
    expect(res.view?.presale?.archive).toBe('/tmp/archive')
  })

  it('deleteLocalInftData refuses unsafe slugs', () => {
    expect(deleteLocalInftData(root, '../etc')).toEqual([])
  })
})

describe('contract registry', () => {
  it('the bundled constant mirrors iclone/contracts/registry.json', () => {
    const file = path.resolve(__dirname, '../../../iclone/contracts/registry.json')
    expect(validateRegistry(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual(validateRegistry(BUNDLED_REGISTRY))
  })

  it('accepts a signed newer copy, rejects a bad signature or older version', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
    const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const bundled = { ...BUNDLED_REGISTRY, remote: { url: 'https://example.invalid/contracts.json', publicKey: pub } }

    const sign = (v: number) => {
      const payload = JSON.stringify({ ...BUNDLED_REGISTRY, version: v })

      return { payload, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64') }
    }

    const make = (body: unknown) => {
      let t = 0

      return createRegistrySource({
        bundled,
        now: () => (t += 2 * 3600_000),
        cacheFile: path.join(root, `cache-${Math.random()}.json`),
        fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch
      })
    }

    expect((await make(sign(2)).get()).version).toBe(2)
    expect((await make({ ...sign(3), signature: sign(4).signature }).get()).version).toBe(1)
    expect((await make(sign(0)).get()).version).toBe(1)
    expect((await make({ payload: 'x' }).get()).version).toBe(1)
  })

  it('reads the remote at most once per hour', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }))

    const src = createRegistrySource({
      bundled: { ...BUNDLED_REGISTRY, remote: { url: 'https://example.invalid/c.json', publicKey: 'AAAA' } },
      now: () => T0,
      cacheFile: path.join(root, 'c.json'),
      fetch: fetchSpy as unknown as typeof fetch
    })

    await src.get()
    await src.get()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('archive redaction', () => {
  it('removes key shapes', () => {
    const out = redactOwnershipLog('sk-abcdefghijklmnopqrstuv api_key: hunter2hunter2 0x' + 'ab'.repeat(32))
    expect(out).not.toMatch(/abcdefghijkl|hunter2|abab/)
  })
})
