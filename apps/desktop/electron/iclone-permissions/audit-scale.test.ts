/**
 * V-2 / V-3 (v0.0.7): a mode change and a state read stay fast however long the audit log has grown.
 *
 * The log is built straight on disk (200 000 records over 200 day files, sealed with the real key, anchored), then a
 * real authority opens it. Two checks:
 *  - structural, timing-free: `state()` opens no audit day file (it reads the maintained verification result);
 *  - budgets: setMode < 150 ms, state() < 10 ms, and no event-loop stall over 50 ms, through the startup verification
 *    pass and the calls. Asserted in a perf run (`ICLONE_PERF=1 npx vitest run --project electron <this file>`); a
 *    loaded or contended machine skips them there (K105, perf-gate.test-helpers.ts), never passes them. The default
 *    run makes the same calls for correctness and reports the numbers (ICLONE_SCALE_REPORT=<file>).
 *
 * Mutant check: putting `deps.audit.verify()` back into `state()` (authority.ts) makes the structural test red in every
 * run (401 day-file reads), and the budget test red in a perf run (state() ~850 ms on this log).
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { PERF, PERF_TAG, skipUnderLoad } from '../perf-gate.test-helpers'

import { createAuditLog } from './audit'
import { createPermissionAuthority, type PermissionAuthority } from './authority'
import { type KeySealer, loadPermissionKeys, type PermissionKeys } from './keys'
import { createPolicySigner } from './policy-file'
import { createPermissionStore } from './store'

const RECORDS = 200_000
const DAYS = 200
const SETMODE_BUDGET_MS = 150
const STATE_BUDGET_MS = 10
const STALL_BUDGET_MS = 50

const memorySealer = (): KeySealer => {
  const sealed = new Map<string, string>()

  return {
    seal: plain => {
      const token = `sealed-${sealed.size}`

      sealed.set(token, plain)

      return token
    },
    unseal: token => {
      const plain = sealed.get(token)

      if (plain === undefined) {
        throw new Error('not sealed here')
      }

      return plain
    }
  }
}

let root: string
let permissions: string
let sealer: KeySealer
let keys: PermissionKeys

/** The records audit.ts would have written, in its field order, sealed and linked; the anchor last. */
function buildLog(): void {
  const auditDir = path.join(permissions, 'audit')
  let prev = '0'.repeat(64)
  let seq = 0
  const start = Date.parse('2026-01-01T00:00:00.000Z')

  mkdirSync(auditDir, { recursive: true, mode: 0o700 })

  for (let day = 0; day < DAYS; day += 1) {
    const at = new Date(start + day * 86_400_000)
    const lines: string[] = []

    for (let i = 0; i < RECORDS / DAYS; i += 1) {
      seq += 1

      const body = {
        v: 1,
        id: randomUUID(),
        ts: at.toISOString(),
        seq_main: seq,
        src: 'plugin',
        src_seq: seq,
        src_key: 'k-scale',
        hermes_pid: 4100,
        kind: 'use',
        mode: 'automatic',
        scope: null,
        class: 'R',
        action: { tool: 'read_file', target: `/lab/proj/file-${seq}.ts`, project_root: '/lab/proj' },
        agent: { inft: 'i01', profile: null, session_id: 's-scale', subagent_id: null, task_id: null },
        grant_id: null,
        answer: null,
        gesture: null,
        reason: `call ${seq}`,
        kid: keys.kid,
        prev_sha256: prev
      }

      const sha = createHash('sha256').update(JSON.stringify(body)).digest('hex')

      lines.push(JSON.stringify({ ...body, sha256: sha, mac: createHmac('sha256', keys.auditKey).update(sha).digest('hex') }))
      prev = sha
    }

    writeFileSync(path.join(auditDir, `${at.toISOString().slice(0, 10)}.jsonl`), `${lines.join('\n')}\n`, { mode: 0o600 })
  }

  const mac = createHmac('sha256', keys.auditKey).update(`head\n${seq}\n${prev}`).digest('hex')

  writeFileSync(path.join(permissions, 'audit-head.json'), `${JSON.stringify({ seq, sha: prev, kid: keys.kid, mac })}\n`)
}

let audit: ReturnType<typeof createAuditLog>
let authority: PermissionAuthority
let openMs = 0
let verifyStallMs = 0

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'iclone-scale-'))
  permissions = path.join(root, 'permissions')
  sealer = memorySealer()
  keys = loadPermissionKeys(permissions, sealer)
  buildLog()

  const stalls = monitorEventLoopDelay({ resolution: 5 })
  const opened = performance.now()

  audit = createAuditLog({ dir: path.join(permissions, 'audit'), key: keys.auditKey, kid: keys.kid })
  openMs = performance.now() - opened
  // The startup verification runs after the open returns; the loop must keep turning while it does.
  stalls.enable()
  await audit.whenVerified()
  stalls.disable()
  verifyStallMs = stalls.max / 1e6

  authority = createPermissionAuthority({
    store: createPermissionStore(permissions, keys),
    audit,
    signer: createPolicySigner(permissions, keys),
    door: null,
    consent: () => null,
    paths: { userDataDir: root, hermesHome: path.join(root, 'hermes'), home: root, hermesRoot: null },
    keysSealed: keys.sealed
  })

  // Main's own launch: a few spawns with their signed policy files, as in a working session.
  for (let i = 0; i < 4; i += 1) {
    authority.mintSpawnKey()
  }
}, 300_000)

afterAll(() => {
  audit?.close()
  rmSync(root, { recursive: true, force: true })
})

describe(`a ${RECORDS}-record audit log`, () => {
  it('the startup verification proves the whole chain GREEN; state() reports it without opening a day file', async () => {
    const reads = vi.spyOn(fs, 'readFileSync')

    try {
      expect(authority.state().chain).toEqual({ ok: true, records: RECORDS, gaps: 0 })

      expect(await authority.setMode({ mode: 'automatic', scope: 'standing', key: null }, true)).toMatchObject({ ok: true })

      const chain = authority.state().chain

      expect(chain.ok).toBe(true)
      expect(chain.records).toBeGreaterThan(RECORDS)

      const dayFileReads = reads.mock.calls.filter(([file]) => typeof file === 'string' && file.endsWith('.jsonl'))

      expect(dayFileReads).toEqual([])
    } finally {
      reads.mockRestore()
    }

    // The full verifier agrees with the maintained result (forensic cross-check, off the hot path).
    expect(audit.verify()).toMatchObject({ ok: true, records: authority.state().chain.records })
  }, 120_000)

  it(`setMode < ${SETMODE_BUDGET_MS} ms, state() < ${STATE_BUDGET_MS} ms, no stall over ${STALL_BUDGET_MS} ms${PERF_TAG}`, async ctx => {
    // K105: the budgets are asserted in a perf run (ICLONE_PERF=1), never in the parallel default run, where another
    // file's burst deschedules this worker; there the same clicks run for correctness and the numbers are reported.
    if (PERF) {
      skipUnderLoad(ctx)
    }

    // The load average lags a burst (a full parallel run starts 40+ files at once). A worker that cannot sit idle for
    // 300 ms without a 25 ms stall is being descheduled: it cannot measure a 50 ms budget, so the budgets are not run
    // (SKIP, never a pass). The structural test above still catches the regression on any machine.
    const idle = monitorEventLoopDelay({ resolution: 5 })

    idle.enable()
    await new Promise(resolve => setTimeout(resolve, 300))
    idle.disable()

    if (PERF && idle.max / 1e6 > 25) {
      const note = `SKIP(contended: ${(idle.max / 1e6).toFixed(0)} ms stall while idle)`

      console.info(note)
      ctx.skip(note)
    }

    const modes = ['manual', 'plan', 'acceptEdits', 'automatic'] as const

    /** Eight clicks with a state read after each, the loop turning between them as a window lets it. */
    const measure = async () => {
      const stalls = monitorEventLoopDelay({ resolution: 5 })
      const setModeMs: number[] = []
      const stateMs: number[] = []

      stalls.enable()

      for (let round = 0; round < 8; round += 1) {
        const began = performance.now()

        expect(
          await authority.setMode({ mode: modes[round % modes.length], scope: 'standing', key: null }, true)
        ).toMatchObject({ ok: true })
        setModeMs.push(performance.now() - began)

        const read = performance.now()

        expect(authority.state().chain.ok).toBe(true)
        stateMs.push(performance.now() - read)

        await new Promise(resolve => setTimeout(resolve, 10))
      }

      stalls.disable()

      return { setModeMs, stateMs, stallMs: stalls.max / 1e6 }
    }

    const within = (run: Awaited<ReturnType<typeof measure>>) =>
      Math.max(...run.setModeMs) < SETMODE_BUDGET_MS &&
      Math.max(...run.stateMs) < STATE_BUDGET_MS &&
      run.stallMs < STALL_BUDGET_MS

    // Up to three whole attempts, the first within budget kept: another test file's burst can deschedule this worker
    // for one attempt, never for three. A real regression (state() walking the log: ~850 ms here) fails all of them.
    let run = await measure()

    for (let attempt = 1; PERF && attempt < 3 && !within(run); attempt += 1) {
      run = await measure()
    }

    const { setModeMs, stateMs, stallMs } = run
    const measured = `[audit-scale] open ${openMs.toFixed(0)} ms · startup verify max stall ${verifyStallMs.toFixed(1)} ms · setMode max ${Math.max(...setModeMs).toFixed(1)} ms · state() max ${Math.max(...stateMs).toFixed(2)} ms · calls max stall ${stallMs.toFixed(1)} ms`

    console.info(measured)

    // The numbers for a handoff: ICLONE_SCALE_REPORT=<file> appends this line there.
    if (process.env.ICLONE_SCALE_REPORT) {
      fs.appendFileSync(process.env.ICLONE_SCALE_REPORT, `${measured}\n`)
    }

    if (!PERF) {
      return
    }

    expect(Math.max(...setModeMs)).toBeLessThan(SETMODE_BUDGET_MS)
    expect(Math.max(...stateMs)).toBeLessThan(STATE_BUDGET_MS)
    expect(stallMs).toBeLessThan(STALL_BUDGET_MS)
    expect(verifyStallMs).toBeLessThan(STALL_BUDGET_MS)
  }, 120_000)
})
