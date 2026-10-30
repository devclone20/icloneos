import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { newResultFile, readResult } from '../lib/child_result.mjs'
import { median, percentile } from '../lib/stats.mjs'

const CHILD = fileURLToPath(new URL('./_crypto.ops.child.mjs', import.meta.url))
const INJECT_MS = 2
// The headline is the slowest operation a payment / decision actually waits on.
const HEADLINE_OPS = [
  'key.load_p256',
  'mandate.es256_sign',
  'pocket.eip712_sign',
  'perm.spawn_key',
  'audit.append_fsync'
]

async function runChild(ctx, args) {
  const root = fs.mkdtempSync(path.join(ctx.scratch, 'run-'))
  const result = newResultFile(ctx.scratch)
  const r = await ctx.sh(process.execPath, [CHILD, JSON.stringify({ scratch: root, result, ...args })], {
    cwd: ctx.app
  })
  return readResult(result, r, 'crypto child').ops
}
const q = percentile

const MEMORY_SAFETY = [
  'x402 sealed secrets are JS strings: SealedSecret.secret is `string | null` (iclone-x402/keys.ts:32), produced by sealer.unseal (keys.ts:45) or mint (keys.ts:53). JS strings are immutable and cannot be zeroed; they live until GC.',
  'P-256 keys (owner mandate, agent cnf) become KeyObjects (keys.ts:84, native memory outside the JS heap); the PEM string they were parsed from is dropped, not wiped.',
  'The pocket EVM key stays a hex string inside the signer closure for the process lifetime: loadPocketSecret (signer.ts:87) -> privateKeyToAccount(sealed.secret) (signer.ts:96); viem holds its own copy.',
  'The permission master is a Buffer (iclone-permissions/keys.ts:65 / :77) captured by the spawnKey closure (keys.ts:55); derived auditKey/stateKey are Buffers kept in PermissionKeys (keys.ts:52). No Buffer is zeroed: no `.fill(0)` anywhere in iclone-x402, iclone-permissions or iclone-acp-tools (grep, 2026-10-30).',
  'At rest: sealed by Electron safeStorage (Keychain) as base64 (iclone-permissions/ignore-dialog.ts:31); the unsealed hex crosses safeStorage.decryptString as a JS string.',
  'IPC: grep of iclone-x402/ipc.ts and preload-api.ts for secret|privateKey finds only doc comments (ipc.ts:10,13,24,381); the spawn pay token reaches Hermes as a file PATH in env, never the secret (ipc.ts:10).'
]

export default {
  id: 'crypto.ops',
  part: 'Signing and keys (payments + permission authority)',
  what:
    'per-operation wall time in-process: sealed P-256 load, ES256 JWS sign, x402 EIP-712 sign (viem), spawn-key HMAC, ' +
    'audit-chain append (fsync); headline = the op with the worst warm p95; cold = first op of a fresh process',
  hot_path:
    'apps/desktop/electron/iclone-x402/keys.ts loadOwnerMandateKey, mandates.ts signJws (body), signer.ts createPocketSigner, ' +
    'iclone-permissions/keys.ts loadPermissionKeys, audit.ts createAuditLog().append',
  unit: 'ms/op',
  lang: 'TypeScript',
  // The worst op is the fsync'd audit append: a durability (disk) cost, not a language question.
  miss_class: 'io',
  budget: {
    value: 5,
    op: '<=',
    stat: 'warm.p95',
    reason: 'a signature or audit line sits inside a user-visible approve / pay click'
  },
  risk: 'key material held as immutable JS strings for the process lifetime (see extra.memory_safety); every decision fsyncs one audit line',
  failure_mode:
    'no OS seal => keys `unavailable` and payments refused (keys.ts:41-43, NO_SEALING); here the Keychain seal is an in-memory double (its cost is not counted)',
  async measure(ctx) {
    const full = ctx.mode === 'full'
    const all = {}
    const coldBy = {}
    for (let i = 0; i < (full ? 5 : 2); i += 1) {
      const ops = await runChild(ctx, { n: full ? 300 : 40 })
      for (const [name, xs] of Object.entries(ops)) {
        ;(coldBy[name] ??= []).push(xs[0])
        ;(all[name] ??= []).push(...xs.slice(1))
      }
    }
    const per = Object.fromEntries(
      Object.entries(all).map(([name, xs]) => [
        name,
        {
          cold_p50: +q(coldBy[name], 50).toFixed(3),
          p50: +q(xs, 50).toFixed(3),
          p95: +q(xs, 95).toFixed(3),
          n: xs.length
        }
      ])
    )
    const headline = HEADLINE_OPS.reduce((worst, name) => (per[name].p95 > per[worst].p95 ? name : worst))
    const cryptoOnly = HEADLINE_OPS.filter(name => name !== 'audit.append_fsync').reduce((worst, name) =>
      per[name].p95 > per[worst].p95 ? name : worst
    )
    return {
      cold: coldBy[headline],
      warm: all[headline],
      extra: {
        headline_op: headline,
        ops: per,
        secondary: [
          {
            name: `worst pure-crypto op (${cryptoOnly}) warm p95`,
            value: per[cryptoOnly].p95,
            unit: 'ms/op',
            budget: 5,
            op: '<=',
            ok: per[cryptoOnly].p95 <= 5,
            reason:
              'a payment or permission decision waits on every signing / key op: 5 ms/op keeps them below what ' +
              'a user can notice; applied to those ops alone (no disk on their path)'
          },
          {
            name: 'audit append without fsync (test seam) warm p95',
            value: per['audit.append_nofsync'].p95,
            unit: 'ms/op',
            budget: 5,
            op: '<=',
            ok: per['audit.append_nofsync'].p95 <= 5,
            reason: 'separates the HMAC + serialisation cost of an audit line from its fsync'
          }
        ],
        sealer: 'in-memory double (Keychain not timed)',
        memory_safety: MEMORY_SAFETY
      }
    }
  },
  async control(ctx) {
    const base = await runChild(ctx, { n: 40 })
    const slow = await runChild(ctx, { n: 40, delayMs: INJECT_MS })
    const b = base['key.load_p256'].slice(1)
    const v = slow['key.load_p256'].slice(1)
    const delta = median(v) - median(b)
    // The headline op: dropping the fsync (audit.ts `durable: false` seam) must remove most of the audit append cost,
    // or the row is not timing the disk flush it says it is.
    const fsync = median(base['audit.append_fsync'].slice(1))
    const nofsync = median(base['audit.append_nofsync'].slice(1))
    const drop = 1 - nofsync / fsync
    return [
      {
        name: `busy-wait ${INJECT_MS} ms inside unseal`,
        expected: `key.load_p256 median grows by >= ${0.8 * INJECT_MS} ms`,
        observed: `+${delta.toFixed(3)} ms (n=${b.length} vs ${v.length})`,
        value: delta,
        threshold: 0.8 * INJECT_MS,
        op: '>=',
        ok: delta >= 0.8 * INJECT_MS,
        base: b,
        variant: v
      },
      {
        name: 'audit append with durable:false (no fsync)',
        expected: 'median audit append drops by >= 50 % without the fsync',
        observed: `${fsync.toFixed(3)} -> ${nofsync.toFixed(3)} ms/op (-${(100 * drop).toFixed(1)} %)`,
        value: drop,
        threshold: 0.5,
        op: '>=',
        ok: drop >= 0.5
      }
    ]
  }
}
