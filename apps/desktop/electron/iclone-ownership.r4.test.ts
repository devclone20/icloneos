import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startAcpSocketServer } from './iclone-acp-ipc'
import {
  type CommandRunner,
  createDeactivationDoor,
  createOwnershipService,
  deactivatedAgentDescription,
  deactivatedAgentName,
  doorRenameArgv,
  economyRefusal
} from './iclone-ownership'
import { setOwnershipGateRoot } from './iclone-ownership-gate'
import type { ProofResult } from './iclone-ownership-proof'
import { BUNDLED_REGISTRY } from './iclone-ownership-registry'
import { readRecord } from './iclone-ownership-store'

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
const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = 1_800_000_000_000

const noArchiver = {
  archive: async () => ({ ok: true, dir: '/tmp/x', remote: null }),
  ghStatus: async () => ({ ok: true, detail: '' })
}

const lostProof = (now: number, tx = 'cd', block = 90): ProofResult => ({
  verdict: 'lost',
  verifications: [],
  reason: 'agree',
  agentStatus: null,
  transfer: {
    txHash: '0x' + tx.repeat(32),
    block,
    from: OWNER,
    to: BUYER,
    timestamp: now / 1000 - 60,
    explorerUrl: 'https://x/tx'
  },
  head: { number: block + 30, timestamp: now / 1000 }
})

const heldProof = (now: number, block = 100): ProofResult => ({
  verdict: 'held',
  verifications: [],
  transfer: null,
  head: { number: block, timestamp: now / 1000 },
  agentStatus: null,
  reason: 'held'
})

let root = ''

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'r9r4-'))
})

afterEach(() => {
  setOwnershipGateRoot(null)
  rmSync(root, { recursive: true, force: true })
})

/** The production door over a fake CLI: `agent whoami` answers `whoami`, every other call `{}`. */
function harness(whoami = '{"data":{"name":"iCLONE Original"}}') {
  const clock = { now: T0 }
  let next = heldProof(T0)
  const calls: string[][] = []

  const run: CommandRunner = async (_bin, args) => {
    calls.push(args)

    return { code: 0, stdout: args.includes('whoami') ? whoami : '{}', stderr: '' }
  }

  const door = createDeactivationDoor({ root, acpBin: '/nonexistent/acp', run })

  const s = createOwnershipService({
    root,
    now: () => clock.now,
    registry: async () => BUNDLED_REGISTRY,
    door,
    archiver: noArchiver as never,
    verify: async () => next
  })

  const renames = () => calls.filter(a => a.includes('update'))

  return { clock, calls, renames, s, set: (p: ProofResult) => (next = p) }
}

async function lostNow(h: ReturnType<typeof harness>, tx = 'cd', block = 90) {
  h.clock.now += HOUR
  h.set(lostProof(h.clock.now, tx, block))
  await h.s.check(SLUG)
}

describe('R9 r4 — the door-rename exception is exact', () => {
  it('only the door argv built from the record passes; hostile updates are refused', async () => {
    const h = harness()
    await h.s.observe(OWNER, [ITEM])
    await lostNow(h)
    await h.s.choose(SLUG, 'keep', '#7')
    const door = h.renames()[0].slice(2)
    const record = readRecord(root, SLUG)

    expect(record && door).toEqual(record && doorRenameArgv(record))
    expect(economyRefusal(SLUG, door, root)).toBeNull()
    expect(economyRefusal(SLUG, ['--inft', SLUG, ...door], root)).toBeNull()
    expect(economyRefusal(SLUG, door.slice(0, -1), root)).toBeNull()

    const name = door[3]
    const desc = door[5]

    const hostile: string[][] = [
      [
        'agent',
        'update',
        '--name',
        name,
        '--description',
        'This agent no longer holds iNFT #7 (sold) - still ACTIVE.',
        '--json'
      ],
      ['agent', 'update', '--name', name, '--description', `${desc} Contact me on t.me/evil.`],
      ['agent', 'update', '--name', name, '--json', 'iCLONE Original'],
      ['agent', 'update', 'iCLONE Original', '--name', name, '--description', desc],
      ['agent', 'update', '--name', name, '--description', desc, '--json', '--json'],
      ['agent', 'update', '--name', name, '--description', desc, '--json=1'],
      ['agent', 'update', '--name', name, '--description', desc, '--name', name],
      ['agent', 'update', '--name', name, '--description', desc, 'extra'],
      ['agent', 'update', '--name', name, '--description'],
      ['agent', 'update', '--name', name],
      [
        'agent',
        'update',
        '--name',
        name,
        '--description',
        deactivatedAgentDescription('7', '2020-01-01', '0x' + 'cd'.repeat(32))
      ],
      ['agent', 'update', '--name', 'iCLONE Original', '--description', desc],
      ['agent', '--json', 'update', '--name', name, '--description', desc]
    ]

    for (const argv of hostile) {
      expect(economyRefusal(SLUG, argv, root), argv.join(' ')).toMatch(/^iNFT Deactivated/)
    }
  })

  it('a flag value cannot hide a value-moving command behind a read-only word', async () => {
    const h = harness()
    await h.s.observe(OWNER, [ITEM])
    await lostNow(h)

    expect(economyRefusal(SLUG, ['wallet', 'balance', '--json'], root)).toBeNull()
    expect(economyRefusal(SLUG, ['wallet', '--chain', 'balance', 'send', '--to', BUYER], root)).toMatch(/refused/)
    expect(economyRefusal(SLUG, ['job', '--x', 'list', 'create'], root)).toMatch(/refused/)
  })
})

describe('R9 r4 — a return closes the cycle; a re-loss starts fresh', () => {
  it('return → cycle archived and cleared; second sale → 7 days shown, owner asked again, door re-runs with the new tx', async () => {
    const h = harness()
    await h.s.observe(OWNER, [ITEM])
    await lostNow(h)
    await h.s.choose(SLUG, 'keep', '#7')
    expect(h.renames()).toHaveLength(1)
    expect(readRecord(root, SLUG)?.originalAgentName).toBe('iCLONE Original')

    h.clock.now += HOUR
    h.set(heldProof(h.clock.now, 400))
    await h.s.check(SLUG)
    const back = (await h.s.list())[0]
    const stored = readRecord(root, SLUG)

    expect(back.state).toBe('held')
    expect(back.deactivation).toBeNull()
    expect(back.choice).toBeNull()
    expect(back.pastCycles).toBe(1)
    expect(back.originalAgentName).toBe('iCLONE Original')
    expect(stored?.promptHeaderAt).toBeNull()
    expect(stored?.personaRemovedAt).toBeNull()
    expect(stored?.cycles?.[0].choice?.kind).toBe('keep')
    expect(stored?.cycles?.[0].transfer?.txHash).toBe('0x' + 'cd'.repeat(32))
    expect(back.history.some(e => /cycle closed.*"iCLONE Original"/.test(e.note))).toBe(true)

    h.clock.now += DAY
    await lostNow(h, 'ef', 500)
    const again = (await h.s.list())[0]

    expect(again.state).toBe('lost')
    expect(again.daysLeft).toBe(7)
    expect(again.deactivationComplete).toBe(false)
    expect(again.choice).toBeNull()
    expect(economyRefusal(SLUG, h.renames()[0].slice(2), root)).toMatch(/^iNFT Deactivated/)

    for (let i = 0; i < 8 * 24; i++) {
      h.clock.now += HOUR
      h.set(lostProof(h.clock.now, 'ef', 500))
      await h.s.tick()
    }

    expect(h.renames()).toHaveLength(2)
    expect(h.renames()[1].join(' ')).toContain('0x' + 'ef'.repeat(32))
    expect(economyRefusal(SLUG, h.renames()[1].slice(2), root)).toBeNull()
    // the first rename's name stays the one to offer back — not "[iNFT Deactivated] #7"
    expect(readRecord(root, SLUG)?.originalAgentName).toBe('iCLONE Original')
  })

  it('a whoami that already reads the deactivated name, or fails, records no original name', async () => {
    const h = harness(JSON.stringify({ name: deactivatedAgentName('7') }))
    await h.s.observe(OWNER, [ITEM])
    await lostNow(h)
    await h.s.choose(SLUG, 'keep', '#7')

    expect(h.renames()).toHaveLength(1)
    expect(readRecord(root, SLUG)?.originalAgentName ?? null).toBeNull()

    rmSync(root, { recursive: true, force: true })
    root = mkdtempSync(path.join(os.tmpdir(), 'r9r4-'))
    const bad = harness('not json')
    await bad.s.observe(OWNER, [ITEM])
    await lostNow(bad)
    await bad.s.choose(SLUG, 'keep', '#7')
    expect(bad.renames()).toHaveLength(1)
    expect(readRecord(root, SLUG)?.deactivation?.steps.find(s => s.step === 'virtuals')?.ok).toBe(true)
    expect(readRecord(root, SLUG)?.originalAgentName ?? null).toBeNull()
  })
})

describe('R9 r4 — the agent socket door runs the economy gate', () => {
  const ask = (socketPath: string, request: unknown) =>
    new Promise<{ t: string; d?: string; c?: number }[]>((resolve, reject) => {
      const socket = net.createConnection(socketPath)
      let data = ''

      socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
      socket.on('data', chunk => (data += String(chunk)))
      socket.on('error', reject)
      socket.on('close', () =>
        resolve(
          data
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as { t: string })
        )
      )
    })

  it('a lost iNFT cannot move value or rename itself; the door rename and a held iNFT pass', async () => {
    const h = harness()
    await h.s.observe(OWNER, [ITEM])
    await lostNow(h)
    await h.s.choose(SLUG, 'later', '')
    setOwnershipGateRoot(root)

    const record = readRecord(root, SLUG)
    const runs: { slug: string; argv: string[] }[] = []
    const held = 'robinhood-held-6'

    const server = await startAcpSocketServer({
      admitStreaming: () => true,
      dir: path.join(root, 'run'),
      resolveInft: key => ({ ok: true, slug: key === '6' ? held : SLUG }),
      run: (slug, argv) => {
        runs.push({ slug, argv })

        return Promise.resolve({ code: 0 })
      },
      log: () => undefined
    })

    try {
      const token = readFileSync(path.join(root, 'run', 'acp.token'), 'utf8').trim()
      const send = (inft: string, argv: string[]) => ask(server.socketPath, { v: 1, token, inft, argv })

      const refused = [
        ['email', 'compose', '--to', 'a@b.c', '--subject', 'hi', '--body', 'x'],
        ['wallet', 'send-transaction', '--to', BUYER, '--value', '1'],
        ['offering', 'create', '--name', 'x'],
        ['agent', 'update', '--name', 'iCLONE Original']
      ]

      for (const argv of refused) {
        const frames = await send('7', argv)

        expect(frames.at(-1), argv.join(' ')).toEqual({ t: 'x', c: 3 })
        expect(frames.find(f => f.t === 'e')?.d).toMatch(/iNFT Deactivated/)
      }

      // `job create` is not an agent command at all: refused by agentPolicy before the gate.
      expect((await send('7', ['job', 'create', '--provider', BUYER])).at(-1)).toEqual({ t: 'x', c: 3 })
      expect(runs).toHaveLength(0)

      expect((await send('7', ['wallet', 'balance', '--json'])).at(-1)).toEqual({ t: 'x', c: 0 })
      expect(record && (await send('7', doorRenameArgv(record))).at(-1)).toEqual({ t: 'x', c: 0 })
      expect((await send('6', ['email', 'compose', '--to', 'a@b.c'])).at(-1)).toEqual({ t: 'x', c: 0 })
      expect(runs.map(r => `${r.slug} ${r.argv.slice(0, 2).join(' ')}`)).toEqual([
        `${SLUG} wallet balance`,
        `${SLUG} agent update`,
        `${held} email compose`
      ])
    } finally {
      server.close()
    }
  })
})
