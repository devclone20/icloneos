/**
 * v0.0.9 lead decision — the agent's own `acp` door: register-erc8004 and the offering / resource writes are decided by
 * the owner's level for the `acp` function (default = ask for this call), never by the global mode. Red on the old
 * door: it ran these writes under any mode without asking (agentPolicy admitted them and nothing else looked).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { FunctionLevel, PermissionMode } from '../src/iclone-shared/permissions'

import { ownerLockOf } from './iclone-acp-argv'
import {
  ACP_DOOR_WRITE_REFUSED,
  type AcpDoorWriteAuditEntry,
  type AcpDoorWriteDeps,
  acpDoorWriteOf,
  admitAcpDoorWrite
} from './iclone-acp-door-writes'
import { acpSocketFile, startAcpSocketServer } from './iclone-acp-ipc'
import type { DoorPermission, PermissionDoorAnswer, PermissionDoorOutcome } from './iclone-consent-door'

const WRITES: string[][] = [
  ['agent', 'register-erc8004', '--agent-id', 'a1', '--chain-id', '8453', '--json'],
  ['offering', 'create', '--name', 'x', '--json'],
  ['offering', 'update', '--offering-id', 'abc', '--price-value', '1.25', '--json'],
  ['offering', 'delete', '--offering-id', 'abc', '--force', '--json'],
  ['resource', 'create', '--name', 'r', '--json'],
  ['resource', 'update', '--resource-id', 'r1', '--json'],
  ['resource', 'delete', '--resource-id', 'r1', '--json']
]

/** A fake permission world: the owner's `acp` level, the global mode, and what the sheet answers (null = never). */
function world(options: { level: FunctionLevel | null; mode?: PermissionMode; answer?: PermissionDoorOutcome | null }) {
  const asked: { slug: string; permission: DoorPermission; key: string }[] = []
  const audit: AcpDoorWriteAuditEntry[] = []

  const deps: AcpDoorWriteDeps = {
    level: () => options.level,
    mode: () => options.mode ?? 'ignore',
    ask: (slug, permission, key, _reason, signal) => {
      asked.push({ slug, permission, key })

      if (options.answer === null || options.answer === undefined) {
        // No click ever comes: the sheet waits until the caller gives up (the real door times out at two minutes).
        return new Promise<PermissionDoorAnswer>(resolve => {
          signal?.addEventListener('abort', () => resolve({ outcome: 'withdrawn', shown: true }), { once: true })
        })
      }

      return Promise.resolve({ outcome: options.answer, shown: true })
    },
    audit: entry => {
      audit.push(entry)

      return { id: `r${audit.length}` }
    }
  }

  return { deps, asked, audit }
}

const request = (argv: string[]) => ({ slug: 'inft-6', session: 's1', argv })

describe('acpDoorWriteOf — which agent argv are owner-locked writes', () => {
  it('names register-erc8004 and every offering / resource write; reads and help are not writes', () => {
    expect(acpDoorWriteOf(WRITES[0]!)).toBe('acp-register')

    for (const argv of WRITES.slice(1)) {
      expect(acpDoorWriteOf(argv), argv.join(' ')).toBe('acp-market')
    }

    for (const argv of [
      ['offering', 'list', '--json'],
      ['resource', 'list'],
      ['agent', 'whoami', '--json'],
      ['offering', '--help'],
      ['--version']
    ]) {
      expect(acpDoorWriteOf(argv), argv.join(' ')).toBeNull()
    }
  })
})

describe('v0.0.9 Q (security m3, lead decision 3): the other signing writes and the subscription catalogue', () => {
  // Red on the old door: each of these returned null and ran with no ask, even at Follow mode.
  const SIGNING = [
    ['agent', 'tokenize', '--chain-id', '8453', '--symbol', 'ICL', '--json'],
    ['wallet', 'sign-typed-data', '--data', '{}', '--chain-id', '8453'],
    ['wallet', 'sign-message', '--message', 'hi', '--chain-id', '8453']
  ]

  const SUBSCRIPTIONS = [
    ['subscription', 'create', '--name', 'x', '--price', '0.01', '--duration-days', '7'],
    ['subscription', 'update', '--id', 'a1', '--price', '0.02'],
    ['subscription', 'delete', '--id', 'a1', '--force']
  ]

  it('classifies them; agent migrate (no local signature or payment) and subscription list stay out', () => {
    for (const argv of SIGNING) {
      expect(acpDoorWriteOf(argv), argv.join(' ')).toBe('acp-register')
    }

    for (const argv of SUBSCRIPTIONS) {
      expect(acpDoorWriteOf(argv), argv.join(' ')).toBe('acp-market')
    }

    expect(acpDoorWriteOf(['agent', 'migrate', '--agent-id', '1'])).toBeNull()
    expect(acpDoorWriteOf(['subscription', 'list'])).toBeNull()
  })

  it('at the default level each one asks the owner (with words naming what is signed); no click = refused', async () => {
    for (const argv of [...SIGNING, ...SUBSCRIPTIONS]) {
      const w = world({ level: 'mode', mode: 'ignore', answer: 'deny' })

      expect(await admitAcpDoorWrite(w.deps, request(argv)), argv.join(' ')).toEqual({
        admitted: false,
        error: ACP_DOOR_WRITE_REFUSED.denied
      })
      expect(w.asked, argv.join(' ')).toHaveLength(1)
    }

    const w = world({ level: 'mode', mode: 'automatic', answer: 'deny' })

    await admitAcpDoorWrite(w.deps, request(SIGNING[0]!))
    expect(JSON.stringify(w.asked[0])).toMatch(/tokenize/)
  })

  it('the window: subscription writes now need the owner-click lock like offerings', () => {
    for (const argv of SUBSCRIPTIONS) {
      expect(ownerLockOf(argv), argv.join(' ')).toBe('acp-market')
    }

    expect(ownerLockOf(['subscription', 'list'])).toBeNull()
  })
})

describe('admitAcpDoorWrite — the owner per function, not the global mode', () => {
  it('default (acp at Follow mode) under the MOST permissive mode (Ignore): asks for every write, once only', async () => {
    for (const argv of WRITES) {
      const w = world({ level: 'mode', mode: 'ignore', answer: 'once' })

      expect(await admitAcpDoorWrite(w.deps, request(argv)), argv.join(' ')).toEqual({ admitted: true })
      expect(w.asked).toHaveLength(1)
      // The sheet never hears Ignore (the door would answer an Ignore ask by itself) and offers this call only.
      expect(w.asked[0]!.permission.mode).not.toBe('ignore')
      expect(w.asked[0]!.permission.scopes).toEqual(['once'])
      expect(w.audit).toEqual([expect.objectContaining({ kind: 'use', gesture: true })])
    }
  })

  it('NEGATIVE: under Ignore with the default level, no click = refused, nothing admitted', async () => {
    for (const argv of WRITES) {
      const w = world({ level: 'mode', mode: 'ignore', answer: null })
      const abort = new AbortController()
      const verdict = admitAcpDoorWrite(w.deps, request(argv), abort.signal)

      abort.abort()

      expect(await verdict, argv.join(' ')).toEqual({ admitted: false, error: ACP_DOOR_WRITE_REFUSED.denied })
      expect(w.asked).toHaveLength(1)
      expect(w.audit).toEqual([expect.objectContaining({ kind: 'refuse', gesture: false })])
    }
  })

  it('a Deny, a timeout or a busy sheet refuses', async () => {
    for (const answer of ['deny', 'timeout', 'busy', 'withdrawn'] as const) {
      const w = world({ level: 'mode', mode: 'automatic', answer })

      expect(await admitAcpDoorWrite(w.deps, request(WRITES[0]!)), answer).toEqual({
        admitted: false,
        error: ACP_DOOR_WRITE_REFUSED.denied
      })
    }
  })

  it('every global mode alone still asks (Automatic, Accept edits, Ignore, Manual, Plan)', async () => {
    for (const mode of ['automatic', 'acceptEdits', 'ignore', 'manual', 'plan'] as const) {
      const w = world({ level: 'mode', mode, answer: 'deny' })

      expect((await admitAcpDoorWrite(w.deps, request(WRITES[1]!)))?.admitted, mode).toBe(false)
      expect(w.asked, mode).toHaveLength(1)
    }
  })

  it('Ask once and Ask always ask for the call too', async () => {
    for (const level of ['askOnce', 'askAlways'] as const) {
      const w = world({ level, mode: 'automatic', answer: 'once' })

      expect(await admitAcpDoorWrite(w.deps, request(WRITES[4]!))).toEqual({ admitted: true })
      expect(w.asked).toHaveLength(1)
    }
  })

  it("the owner's per-function allow (acp at Automatic or Ignore) is honoured without a sheet, and audited as such", async () => {
    for (const level of ['automatic', 'ignore'] as const) {
      const w = world({ level, mode: 'plan', answer: null })

      expect(await admitAcpDoorWrite(w.deps, request(WRITES[0]!)), level).toEqual({ admitted: true })
      expect(w.asked).toHaveLength(0)
      expect(w.audit).toEqual([
        expect.objectContaining({ kind: 'use', gesture: false, reason: expect.stringContaining(level) })
      ])
    }
  })

  it('acp at Manual refuses without a sheet', async () => {
    const w = world({ level: 'manual', mode: 'ignore', answer: 'once' })

    expect(await admitAcpDoorWrite(w.deps, request(WRITES[2]!))).toEqual({
      admitted: false,
      error: ACP_DOOR_WRITE_REFUSED.manual
    })
    expect(w.asked).toHaveLength(0)
  })

  it('fails closed: no authority, or an audit that cannot record, refuses even an allowed write', async () => {
    const down = world({ level: null, answer: 'once' })

    expect(await admitAcpDoorWrite(down.deps, request(WRITES[0]!))).toEqual({
      admitted: false,
      error: ACP_DOOR_WRITE_REFUSED.starting
    })
    expect(down.asked).toHaveLength(0)

    const noAudit = world({ level: 'automatic' })

    noAudit.deps.audit = () => null
    expect(await admitAcpDoorWrite(noAudit.deps, request(WRITES[0]!))).toEqual({
      admitted: false,
      error: ACP_DOOR_WRITE_REFUSED.audit
    })
  })

  it('reads are not decided here (null): the door runs them as before, no sheet', async () => {
    const w = world({ level: 'manual' })

    expect(await admitAcpDoorWrite(w.deps, request(['offering', 'list', '--json']))).toBeNull()
    expect(w.asked).toHaveLength(0)
    expect(w.audit).toHaveLength(0)
  })
})

describe('the agent door socket — writes reach the CLI only after the owner', () => {
  const dirs: string[] = []

  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const send = (socketPath: string, body: unknown) =>
    new Promise<{ t: string; d?: string; c?: number }[]>((resolve, reject) => {
      const socket = net.createConnection(socketPath)
      let data = ''

      socket.on('connect', () => socket.write(`${JSON.stringify(body)}\n`))
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

  it('NEGATIVE under Ignore + default level: the write is refused (77) and never spawned; a read runs', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'iclone-door-writes-'))

    dirs.push(home)

    const runs: string[][] = []
    const w = world({ level: 'mode', mode: 'ignore', answer: 'deny' })
    const dir = path.join(home, 'run')

    const server = await startAcpSocketServer({
      admitStreaming: () => true,
      dir,
      socket: acpSocketFile(home),
      resolveInft: () => ({ ok: true, slug: 'inft-6' }),
      run: (_slug, argv) => {
        runs.push(argv)

        return Promise.resolve({ code: 0 })
      },
      log: () => undefined,
      doorWrites: w.deps
    })

    try {
      const token = readFileSync(path.join(dir, 'acp.token'), 'utf8').trim()

      const refused = await send(server.socketPath, { v: 1, token, inft: '6', argv: WRITES[0], session: 's1' })

      expect(refused.at(-1)).toEqual({ t: 'x', c: 77 })
      expect(refused.find(frame => frame.t === 'e')?.d).toContain('[acp-door-write:denied]')
      expect(runs).toEqual([])
      expect(w.asked).toHaveLength(1)

      const read = await send(server.socketPath, { v: 1, token, inft: '6', argv: ['offering', 'list', '--json'] })

      expect(read.at(-1)).toEqual({ t: 'x', c: 0 })
      expect(runs).toEqual([['offering', 'list', '--json']])
      expect(w.asked).toHaveLength(1)
    } finally {
      server.close()
    }
  })

  it("the owner's click (Allow once) lets exactly that write through", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'iclone-door-writes-ok-'))

    dirs.push(home)

    const runs: string[][] = []
    const w = world({ level: 'mode', mode: 'ignore', answer: 'once' })
    const dir = path.join(home, 'run')

    const server = await startAcpSocketServer({
      admitStreaming: () => true,
      dir,
      socket: acpSocketFile(home),
      resolveInft: () => ({ ok: true, slug: 'inft-6' }),
      run: (_slug, argv) => {
        runs.push(argv)

        return Promise.resolve({ code: 0 })
      },
      log: () => undefined,
      doorWrites: w.deps
    })

    try {
      const token = readFileSync(path.join(dir, 'acp.token'), 'utf8').trim()
      const frames = await send(server.socketPath, { v: 1, token, inft: '6', argv: WRITES[1] })

      expect(frames.at(-1)).toEqual({ t: 'x', c: 0 })
      expect(runs).toEqual([WRITES[1]])
    } finally {
      server.close()
    }
  })
})
