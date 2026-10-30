// The renderer's acp door (runAcp behind `iclone:acp-run`) runs the economy gate
// before it starts anything. Electron, the home dir and the CLI are fakes.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const lab = vi.hoisted(() => {
  // Short and fresh: the agent door's socket path must fit sun_path.
  const home = `/tmp/r9d-${process.pid}-${Date.now() % 1_000_000}`

  return { home, userData: `${home}/userData`, handlers: new Map<string, (...a: unknown[]) => unknown>() }
})

vi.mock('node:os', async importOriginal => {
  const real = await importOriginal<typeof NodeOs>()
  const os = { ...real, homedir: () => lab.home }

  return { ...os, default: os }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => lab.userData,
    getAppPath: () => lab.home,
    once: () => undefined,
    on: () => undefined
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => lab.handlers.set(channel, fn),
    on: () => undefined
  },
  utilityProcess: { fork: () => null }
}))

import { initIcloneAcp, validateArgv } from './iclone-acp'
import { createOwnershipService } from './iclone-ownership'
import { setOwnershipGateRoot } from './iclone-ownership-gate'
import type { ProofResult } from './iclone-ownership-proof'
import { BUNDLED_REGISTRY } from './iclone-ownership-registry'

const OWNER = '0x' + 'a1'.repeat(20)
const BUYER = '0x' + 'b7'.repeat(20)
const C = BUNDLED_REGISTRY.entries[0].contract
const LOST_ID = `robinhood:${C}:7`
const HELD_ID = `robinhood:${C}:6`
const log = path.join(lab.home, 'acp-calls.log')
const savedBin = process.env.ICLONE_ACP_BIN

beforeAll(async () => {
  mkdirSync(lab.userData, { recursive: true })
  const bin = path.join(lab.home, 'fake-acp')
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\necho '{"ok":true}'\n`)
  chmodSync(bin, 0o755)
  process.env.ICLONE_ACP_BIN = bin

  const now = 1_800_000_000_000

  const lost: ProofResult = {
    verdict: 'lost',
    verifications: [],
    reason: 'agree',
    agentStatus: null,
    transfer: {
      txHash: '0x' + 'cd'.repeat(32),
      block: 90,
      from: OWNER,
      to: BUYER,
      timestamp: now / 1000,
      explorerUrl: 'x'
    },
    head: { number: 120, timestamp: now / 1000 }
  }

  const s = createOwnershipService({
    root: lab.userData,
    now: () => now,
    registry: async () => BUNDLED_REGISTRY,
    door: { applyDeactivation: async () => [] },
    archiver: {
      archive: async () => ({ ok: true, dir: null, remote: null }),
      ghStatus: async () => ({ ok: true, detail: '' })
    },
    verify: async () => lost
  })

  const item = { id: LOST_ID, chain: 'Robinhood', contract: C, tokenId: '7', name: '#7', image: null, configured: true }
  await s.observe(OWNER, [item])
  setOwnershipGateRoot(lab.userData)
  initIcloneAcp({ isTrustedSender: () => true }) // sender guard covered in iclone-acp.sender.test.ts
})

afterAll(() => {
  setOwnershipGateRoot(null)
  process.env.ICLONE_ACP_BIN = savedBin
  rmSync(lab.home, { recursive: true, force: true })
})

const run = (inftId: string, argv: string[]) =>
  lab.handlers.get('iclone:acp-run')?.({}, inftId, argv) as Promise<{
    ok: boolean
    code: number | null
    stdout: string
    error?: string
  }>

const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')

describe('R9 r4 — runAcp refuses a lost iNFT before any child starts', () => {
  it('email compose, job create and agent update are refused with the renderer refusal shape', async () => {
    for (const argv of [
      ['email', 'compose', '--to', 'owner@example.com', '--subject', 's', '--body', 'b', '--json'],
      ['job', 'create', '--provider', BUYER, '--offering', 'o', '--json'],
      ['agent', 'update', '--name', 'iCLONE Original', '--json']
    ]) {
      const r = await run(LOST_ID, argv)

      expect(r, argv.join(' ')).toMatchObject({ ok: false, code: null, stdout: '' })
      // The argv allow-list may refuse first; either way nothing runs.
      expect(r.error).toMatch(validateArgv(argv) ? /^iNFT Deactivated/ : /command not allowed/)
    }

    expect(
      validateArgv(['email', 'compose', '--to', 'owner@example.com', '--subject', 's', '--body', 'b', '--json'])
    ).not.toBeNull()
    expect(calls()).toBe('')
  })

  it('a held iNFT is not gated: the same command goes on to the runtime', async () => {
    const argv = ['email', 'compose', '--to', 'owner@example.com', '--subject', 's', '--body', 'b', '--json']
    const r = await run(HELD_ID, argv)

    expect(r.error ?? '').not.toMatch(/iNFT Deactivated/)
    // Past the gate: the runtime health probe (or the command itself) reached the fake CLI.
    expect(calls()).toMatch(/chain list|email compose/)
  })
})
