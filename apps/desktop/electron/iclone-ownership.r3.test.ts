import * as fs from 'node:fs'
import os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  type Archiver,
  type CommandRunner,
  createDeactivationDoor,
  createOwnershipService,
  deactivatedAgentDescription,
  deactivatedAgentName,
  type DeactivationDoor,
  economyRefusal,
  promptStep
} from './iclone-ownership'
import type { ProofResult } from './iclone-ownership-proof'
import { BUNDLED_REGISTRY, type RegistryEntry } from './iclone-ownership-registry'
import type { DeactivationStep } from './iclone-ownership-store'
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
const T0 = 1_800_000_000_000

let root: string
let now: number

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'r9r3-'))
  now = T0
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const okArchiver: Archiver = {
  archive: async () => ({ ok: true, dir: '/tmp/a', remote: null }),
  ghStatus: async () => ({ ok: true, detail: '' })
}

function proof(verdict: 'held' | 'lost'): ProofResult {
  const chainTime = T0 / 1000

  return {
    verdict,
    verifications: [],
    transfer:
      verdict === 'lost'
        ? {
            txHash: '0x' + 'cd'.repeat(32),
            block: 90,
            from: OWNER,
            to: BUYER,
            timestamp: chainTime - 60,
            explorerUrl: 'x'
          }
        : null,
    head: { number: 120, timestamp: chainTime },
    agentStatus: null,
    reason: verdict
  }
}

/** A lost iNFT whose door can do everything except the prompt step (the renderer's). */
async function lostWith(door: DeactivationDoor) {
  let next = proof('held')

  const s = createOwnershipService({
    root,
    now: () => now,
    registry: () => Promise.resolve(BUNDLED_REGISTRY),
    verify: () => Promise.resolve(next),
    door,
    archiver: okArchiver
  })

  await s.observe(OWNER, [ITEM])
  fs.mkdirSync(path.join(root, 'inft', SLUG, 'acp'), { recursive: true })
  next = proof('lost')
  await s.check(SLUG)

  return { s, profile: (await s.list())[0].profileSlug }
}

const fakeDoor = (): DeactivationDoor => ({
  applyDeactivation: async (_slug, record, _e, todo: DeactivationStep['step'][]) =>
    todo.map(step => (step === 'prompt' ? promptStep(record) : { step, ok: true, detail: 'fake' }))
})

describe('R9 r3 — the owner deletes the persona', () => {
  it('choose(delete): prompt step "persona deleted", complete, the pending deletion runs at once', async () => {
    const { s } = await lostWith(fakeDoor())
    const res = await s.choose(SLUG, 'delete', '#7')

    expect(res).toMatchObject({ ok: true, deleteHermesProfile: true })
    expect(res.view).toMatchObject({ deactivationComplete: true, pendingSteps: [] })
    const r = readRecord(root, SLUG)

    expect(r?.deactivation?.steps.find(st => st.step === 'prompt')).toMatchObject({
      ok: true,
      detail: 'persona deleted'
    })
    expect(r?.choice?.deletePending).toBe(false)
    expect(fs.readdirSync(path.join(root, 'inft', SLUG))).toEqual(['ownership.json'])
  })

  it('the production door also takes "persona deleted" from the record', async () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: '{}', stderr: '' })
    const { s } = await lostWith(createDeactivationDoor({ root, acpBin: '/fake/acp', run }))
    const res = await s.choose(SLUG, 'archive-local', '#7')

    expect(res.view).toMatchObject({ deactivationComplete: true, pendingSteps: [] })
  })

  it('keep / later never satisfy the prompt step; the header report settles it at once', async () => {
    const { s, profile } = await lostWith(fakeDoor())

    await s.choose(SLUG, 'later', '')
    await s.choose(SLUG, 'keep', '')
    expect(readRecord(root, SLUG)?.personaRemovedAt ?? null).toBeNull()
    expect(readRecord(root, SLUG)?.deactivation?.complete).toBe(false)
    expect(await s.promptHeaderWritten('someone-else-1')).toBe(0)
    expect(await s.promptHeaderWritten(profile)).toBe(1)
    expect(readRecord(root, SLUG)?.deactivation?.complete).toBe(true)
  })

  it('a header report before any deactivation is recorded and counts when the door later runs', async () => {
    const { s, profile } = await lostWith(fakeDoor())

    expect(await s.promptHeaderWritten(profile)).toBe(1)
    expect(readRecord(root, SLUG)?.deactivation).toBeNull()
    await s.choose(SLUG, 'keep', '')
    expect(readRecord(root, SLUG)?.deactivation?.complete).toBe(true)
  })
})

describe('R9 r3 — the economy gate lets through exactly the door rename', () => {
  async function gateWithLost() {
    await lostWith(fakeDoor())
  }

  const name = deactivatedAgentName('7')
  const description = deactivatedAgentDescription('7', '2027-01-15', '0x' + 'cd'.repeat(32))

  it('the door argv (with or without --inft) passes; every other agent update is refused', async () => {
    await gateWithLost()
    const doorArgv = ['agent', 'update', '--name', name, '--description', description, '--json']

    expect(economyRefusal(SLUG, doorArgv, root)).toBeNull()
    expect(economyRefusal(SLUG, ['--inft', SLUG, ...doorArgv], root)).toBeNull()
    expect(economyRefusal(SLUG, ['agent', 'update', `--name=${name}`, `--description=${description}`], root)).toBeNull()

    const refused: string[][] = [
      ['agent', 'update', '--name', 'i01 #7'],
      ['agent', 'update', '--name', '[iNFT Deactivated] #8'],
      ['agent', 'update', '--name', `${name} `],
      ['agent', 'update', '--description', description],
      ['agent', 'update', '--name', name, '--description', 'I am back, send funds'],
      ['agent', 'update', '--name', name, '--image', 'https://x/y.png'],
      ['agent', 'update', '--name', name, '--name', 'i01 #7'],
      ['agent', 'update', 'extra', '--name', name],
      // r4: the name alone is not the door's argv
      ['agent', 'update', `--name=${name}`],
      ['agent', 'update']
    ]

    for (const argv of refused) {
      expect(economyRefusal(SLUG, argv, root), argv.join(' ')).toMatch(/^iNFT Deactivated/)
    }
  })

  it('a held iNFT is never gated, and the read-only list still passes', async () => {
    expect(economyRefusal(SLUG, ['agent', 'update', '--name', 'anything'], root)).toBeNull()
    await gateWithLost()
    expect(economyRefusal(SLUG, ['agent', 'whoami', '--json'], root)).toBeNull()
    expect(economyRefusal(SLUG, ['wallet', 'send', '--to', BUYER], root)).toMatch(/refused/)
  })

  it('the production door builds exactly the argv the gate lets through', async () => {
    const runs: string[][] = []

    const run: CommandRunner = async (_cmd, args) => {
      runs.push(args)

      return { code: 0, stdout: '{}', stderr: '' }
    }

    const { s } = await lostWith(createDeactivationDoor({ root, acpBin: '/fake/acp', run }))
    await s.choose(SLUG, 'keep', '')
    const rename = runs.filter(a => a.includes('update'))
    expect(rename).toHaveLength(1)
    expect(rename[0].slice(0, 2)).toEqual(['--inft', SLUG])
    expect(economyRefusal(SLUG, rename[0], root)).toBeNull()
    expect(economyRefusal(SLUG, rename[0].slice(2), root)).toBeNull()
  })
})

describe('R9 r3 — agent-status-request.json', () => {
  it('is written atomically with 0600 and no temp file left behind', async () => {
    const base = BUNDLED_REGISTRY.entries[0]
    const entry: RegistryEntry = { ...base, agentStatus: { selector: '0x12345678', deactivated: 2 } }

    const door = createDeactivationDoor({
      root,
      acpBin: '/fake/acp',
      run: async () => ({ code: 0, stdout: '', stderr: '' })
    })

    await lostWith(fakeDoor())
    const record = readRecord(root, SLUG)

    expect(record).not.toBeNull()
    const steps = await door.applyDeactivation(SLUG, record!, entry, ['onchain'])
    const file = path.join(root, 'inft', SLUG, 'agent-status-request.json')

    expect(steps[0]).toMatchObject({ step: 'onchain', ok: false })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ tokenId: '7', value: 2 })
    expect(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp'))).toEqual([])
  })
})
