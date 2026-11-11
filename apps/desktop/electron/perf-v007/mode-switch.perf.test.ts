/**
 * 2026-11-10 (fix2, gate recalibrated after V-2): opening the log no longer verifies the chain before the first read.
 * A large log is re-verified by a background pass that yields the loop, and until it ends state().chain reads
 * { ok: false, verifying: true, records: 0 }. The old gate read state() at once and failed `answers` on that honest
 * "not verified yet". It now polls state() every 20 ms until `verifying` is false, bounded at 15 s
 * (PERF.mode.switch.verify_done fails with the measured time past that), gates the longest main-thread block during
 * the pass (PERF.mode.switch.verify_block < 50 ms), then requires chain.ok and exactly 200 000 records before the
 * switches. No bar was loosened: the switch phase and its three budgets are unchanged, and two items were added.
 *
 * v0.0.7 PERF gate on the permissions authority with a long-lived install's audit log: 200 000 records over ~139 day
 * files, written by the app's own createAuditLog with a test-sealed master (scripts/perf-v007/make-fixture.mjs
 * --audit). The authority is wired as ipc.ts wires it (sealed keys, the store, the policy signer, the log).
 *
 *   PERF.mode.switch   startup verification: done within 15 s, main never blocked > 50 ms while it runs, then the
 *                      chain verifies with every record;
 *                      10 standing-mode switches, each followed by two state() reads, as the bar and the pane do:
 *                      setMode max < 150 ms, state() max < 10 ms, main never blocked > 50 ms over the whole phase
 *
 * Opening the log is not gated here (INFO_JSON reports it). setMode and state may stay as they are or return a
 * Promise: every call is awaited. The chain must still verify: state().chain.ok and its record count are checked, so
 * a fix that stops verifying is not a pass. */
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createAuditLog } from '../iclone-permissions/audit'
import { createPermissionAuthority } from '../iclone-permissions/authority'
import { loadPermissionKeys } from '../iclone-permissions/keys'
import { createPolicySigner } from '../iclone-permissions/policy-file'
import { createPermissionStore } from '../iclone-permissions/store'

import {
  below,
  type Fixture,
  type GateItem,
  makeFixture,
  PERF_SEALER,
  PERF_V007_ENABLED,
  report,
  startBlockMeter,
  timed,
  yieldToLoop
} from './gate-helpers'

const RECORDS = 200_000
const SWITCHES = 10
const VERIFY_POLL_MS = 20
const VERIFY_LIMIT_MS = 15_000

describe.skipIf(!PERF_V007_ENABLED)('v0.0.7 PERF: permission mode switch', () => {
  let fixture: Fixture
  let audit: ReturnType<typeof createAuditLog> | undefined

  beforeAll(() => {
    fixture = makeFixture(['--audit', String(RECORDS)])
  }, 600_000)

  afterAll(() => {
    audit?.close()
    fixture?.remove()
  })

  it('PERF.mode.switch: verified < 15 s without a block > 50 ms; then setMode < 150 ms, state() < 10 ms, block < 50 ms', async () => {
    const permissions = path.join(fixture.root, 'permissions')
    const keys = loadPermissionKeys(permissions, PERF_SEALER)

    expect(keys.status).toBe('sealed')

    const opened = performance.now()

    audit = createAuditLog({ dir: path.join(permissions, 'audit'), key: keys.auditKey, kid: keys.kid, durable: false })

    const openMs = performance.now() - opened

    const authority = createPermissionAuthority({
      store: createPermissionStore(permissions, keys),
      audit,
      signer: createPolicySigner(permissions, keys),
      door: null,
      consent: () => null,
      paths: {
        userDataDir: fixture.root,
        hermesHome: path.join(fixture.root, 'hermes'),
        home: fixture.root,
        hermesRoot: null
      },
      keysSealed: keys.sealed
    })

    const problems: string[] = []
    const verifyMeter = startBlockMeter()
    const verifyStarted = performance.now()
    let verifyPolls = 0
    let chain = (await timed(verifyMeter, () => authority.state())).value.chain

    while (chain.verifying && performance.now() - verifyStarted < VERIFY_LIMIT_MS) {
      await yieldToLoop(VERIFY_POLL_MS)
      chain = (await timed(verifyMeter, () => authority.state())).value.chain
      verifyPolls += 1
    }

    const verifyMs = performance.now() - verifyStarted
    const verifyBlock = await verifyMeter.stop()

    if (chain.verifying) {
      problems.push(`chain still verifying after ${Math.round(verifyMs)} ms: ${JSON.stringify(chain)}`)
    } else if (chain.ok !== true || chain.records !== RECORDS) {
      problems.push(`chain after verification: ${JSON.stringify(chain)}`)
    }

    await yieldToLoop(20)

    const setModeMs: number[] = []
    const stateMs: number[] = []
    const meter = startBlockMeter()

    for (let i = 0; i < SWITCHES; i += 1) {
      const mode = i % 2 === 0 ? 'automatic' : 'manual'
      const set = await timed(meter, () => authority.setMode({ mode, scope: 'standing' }, true))

      setModeMs.push(set.ms)

      if (!set.value.ok) {
        problems.push(`setMode ${mode}: ${JSON.stringify(set.value)}`)
      }

      for (let read = 0; read < 2; read += 1) {
        await yieldToLoop(2)

        const state = await timed(meter, () => authority.state())

        stateMs.push(state.ms)

        if (!state.value.chain.ok || state.value.chain.verifying || state.value.chain.records < RECORDS) {
          problems.push(`state chain: ${JSON.stringify(state.value.chain)}`)
        }
      }

      await yieldToLoop(2)
    }

    const block = await meter.stop()

    const items: GateItem[] = [
      below('PERF.mode.switch.verify_done', verifyMs, VERIFY_LIMIT_MS),
      below('PERF.mode.switch.verify_block', verifyBlock.maxMs, 50),
      below('PERF.mode.switch.setMode_max', Math.max(...setModeMs), 150),
      below('PERF.mode.switch.state_max', Math.max(...stateMs), 10),
      below('PERF.mode.switch.block_max', block.maxMs, 50),
      {
        id: 'PERF.mode.switch.answers',
        value: problems.length === 0 ? 'ok' : problems[0],
        target: 'ok',
        pass: problems.length === 0
      }
    ]

    expect(
      report('PERF.mode.switch', items, {
        fixture: fixture.info,
        openMs,
        verifyMs,
        verifyPolls,
        verifyBlock,
        chainAfterVerify: chain,
        setModeMs: setModeMs.map(Math.round),
        stateMs: stateMs.map(Math.round),
        block
      })
    ).toBe(true)
  }, 600_000)
})
