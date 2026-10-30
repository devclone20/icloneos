/**
 * V3-J completion — the `x402-pay` skill's client (`iclone/skills/x402-pay/scripts/x402_pay.py`) against the wired
 * module: the real pay socket, a real spawn token in its 0600 file, the loopback stub facilitator and resource server.
 * The client is run as the agent runs it (python3, isolated mode, only the env the app gives a spawn).
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { makeWired, type Wired } from './wired.test-helpers'

const SCRIPT = path.resolve(__dirname, '../../../../iclone/skills/x402-pay/scripts/x402_pay.py')
const PAYEE = '0x1111111111111111111111111111111111111111'
const worlds: Wired[] = []

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.close()
  }
})

interface Run {
  code: number | null
  stdout: string
  stderr: string
  json: Record<string, unknown> | null
}

/** The agent's own call: python3 -I with only PATH and the spawn's pay env. */
function agent(env: Record<string, string>, ...argv: string[]): Promise<Run> {
  return new Promise(resolve => {
    execFile(
      'python3',
      ['-I', SCRIPT, ...argv],
      { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0
        let json: Record<string, unknown> | null = null

        try {
          json = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>
        } catch {
          json = null
        }

        resolve({ code, stdout, stderr, json })
      }
    )
  })
}

async function wired(): Promise<Wired> {
  const world = await makeWired()

  worlds.push(world)

  return world
}

describe('x402-pay skill client: the agent pays only through the pay socket, with its spawn token', () => {
  it('x402-pay: fetch pays a 402 once under the one usable mandate and returns the resource; status shows what is left', async () => {
    const world = await wired()
    const jti = world.issue('agent-a', '1.00')
    const { env, token } = await world.token('agent-a')

    const free = await agent(env, 'fetch', world.url('/free'))

    expect(free.code).toBe(0)
    expect(free.json).toMatchObject({ kind: 'passthrough' })

    const paid = await agent(env, 'fetch', world.url('/paid/report'))

    expect(paid.code).toBe(0)
    expect(paid.json).toMatchObject({ kind: 'paid', micros: 100_000, body: 'paid content of /paid/report' })
    expect(world.doorCalls).toHaveLength(1)
    expect(world.stub.counts.settle).toBe(1)

    const status = await agent(env, 'status')

    expect(status.code).toBe(0)
    expect(status.json).toMatchObject({ kind: 'status', mandates: [{ jti, left: '0.90', usable: true }] })

    for (const run of [free, paid, status]) {
      expect(run.stdout + run.stderr).not.toContain(token)
    }
  })

  it('x402-pay: send transfers to an allowlisted payee; a payee off the list is refused and nothing settles', async () => {
    const world = await wired()
    const jti = world.issue('agent-a', '1.00')
    const { env } = await world.token('agent-a')

    const sent = await agent(env, 'send', PAYEE, '0.20', '--mandate', jti)

    expect(sent.code).toBe(0)
    expect(sent.json).toMatchObject({ kind: 'paid', micros: 200_000 })

    const off = await agent(env, 'send', '0x4444444444444444444444444444444444444444', '0.20', '--mandate', jti)

    expect(off.code).toBe(1)
    expect(off.json).toMatchObject({ kind: 'refused', reason: 'payee' })
    expect(world.stub.counts.settle).toBe(1)
  })

  it('x402-pay: stop pulls the hard stop for every agent; then fetch and send are refused and audited', async () => {
    const world = await wired()
    const jti = world.issue('agent-a', '1.00')
    const { env } = await world.token('agent-a')

    expect((await agent(env, 'stop')).json).toEqual({ kind: 'stopped' })

    const fetchAfter = await agent(env, 'fetch', world.url(), '--mandate', jti)
    const sendAfter = await agent(env, 'send', PAYEE, '0.10', '--mandate', jti)

    expect([fetchAfter.code, sendAfter.code]).toEqual([1, 1])
    expect([fetchAfter.json?.reason, sendAfter.json?.reason]).toEqual(['stop', 'stop'])
    expect(world.audit.filter(entry => entry.reason === 'stop')).toHaveLength(2)
    expect(world.stub.counts.settle).toBe(0)
    expect(world.registered.payments.status(true).stopped).toBe(true)
  })

  it('x402-pay: with two usable mandates it names none (refused no_mandate); --max below the price is refused', async () => {
    const world = await wired()

    world.issue('agent-a', '1.00')
    world.issue('agent-a', '1.00')

    const { env } = await world.token('agent-a')

    expect((await agent(env, 'fetch', world.url())).json).toMatchObject({ reason: 'no_mandate' })

    const one = world.issue('agent-b', '1.00')
    const b = await world.token('agent-b')

    expect((await agent(b.env, 'fetch', world.url(), '--mandate', one, '--max', '0.05')).json).toMatchObject({
      reason: 'per_tx'
    })
    expect(world.doorCalls).toHaveLength(0)
  })

  it('x402-pay: outside iclone os, with a dead or forged token, or another agent’s mandate, nothing is paid', async () => {
    const world = await wired()
    const jti = world.issue('agent-a', '1.00')
    const { env } = await world.token('agent-a')

    const outside = await agent({}, 'status')

    expect(outside.code).toBe(3)
    expect(outside.json).toMatchObject({ reason: 'not_ready' })

    const forgedFile = path.join(path.dirname(env.ICLONE_PAY_TOKEN_FILE), 'forged.token')

    fs.writeFileSync(forgedFile, 'f'.repeat(64), { mode: 0o600 })

    const forged = await agent({ ...env, ICLONE_PAY_TOKEN_FILE: forgedFile }, 'fetch', world.url(), '--mandate', jti)

    expect(forged.code).not.toBe(0)
    expect(world.audit.some(entry => entry.reason === 'socket token')).toBe(true)

    const missing = await agent({ ...env, ICLONE_PAY_TOKEN_FILE: `${forgedFile}.gone` }, 'status')

    expect(missing.code).toBe(3)

    const other = await world.token('agent-b')
    const stolen = await agent(other.env, 'fetch', world.url(), '--mandate', jti)

    expect(stolen.json).toMatchObject({ kind: 'refused', reason: 'mandate_invalid' })
    expect(world.stub.counts.settle).toBe(0)
  })

  it('x402-pay: malformed calls are usage (64) and never reach the socket', async () => {
    const world = await wired()
    const { env } = await world.token('agent-a')

    for (const argv of [
      [],
      ['pay', world.url()],
      ['fetch'],
      ['fetch', world.url(), '--agent', 'agent-b'],
      ['send', PAYEE],
      ['send', PAYEE, '0.1', '--max', '1'],
      ['status', 'everyone'],
      ['stop', 'now']
    ]) {
      expect((await agent(env, ...argv)).code, argv.join(' ')).toBe(64)
    }

    expect(world.audit).toEqual([])
  })

  it('m-r4-1: a token inherited by a process of another profile (its HERMES_HOME) pays nothing and is audited', async () => {
    const world = await wired()
    const jti = world.issue('agent-a', '1.00')
    const a = await world.token('agent-a')
    const b = await world.token('agent-b')

    // Profile B's process holding A's pay env, exactly as Hermes copies its environment into a child of another profile.
    const inherited = await agent({ ...a.env, HERMES_HOME: b.env.HERMES_HOME }, 'fetch', world.url(), '--mandate', jti)

    expect(inherited.code).toBe(77)
    expect(world.audit).toContainEqual({ kind: 'refuse', reason: 'socket profile_mismatch', agent: 'agent-a' })
    expect(world.doorCalls).toHaveLength(0)
    expect(world.stub.counts.settle).toBe(0)

    // The same env in A's own folder (also through a link to it) still pays: the identity is the folder's, not a spelling.
    const alias = path.join(path.dirname(path.dirname(a.env.HERMES_HOME)), 'alias-of-a')

    fs.symlinkSync(a.env.HERMES_HOME, alias)
    expect((await agent({ ...a.env, HERMES_HOME: alias }, 'status')).code).toBe(0)
    expect((await agent(a.env, 'fetch', world.url(), '--mandate', jti)).json).toMatchObject({ kind: 'paid' })
  })
})
