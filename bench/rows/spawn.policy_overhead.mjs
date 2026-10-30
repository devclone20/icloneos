import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { newResultFile, readResult } from '../lib/child_result.mjs'
import { median, percentile } from '../lib/stats.mjs'

const CHILD = fileURLToPath(new URL('./_spawn.policy_overhead.child.mjs', import.meta.url))
const SABOTAGE_SLEEP_MS = 50

async function runChild(ctx, args) {
  const root = fs.mkdtempSync(path.join(ctx.scratch, 'run-'))
  const result = newResultFile(ctx.scratch)
  const r = await ctx.sh(process.execPath, [CHILD, JSON.stringify({ scratch: root, result, ...args })], {
    cwd: ctx.app,
    // A minimal env with a throwaway HOME (the profiles are generated for it, the planted files live in it) and the
    // row's scratch TMPDIR; nothing else from the runner's env reaches the timed process.
    env: { PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), TMPDIR: ctx.scratchEnv().TMPDIR }
  })
  return readResult(result, r, 'spawn-policy child')
}
const q = percentile
const overheads = pairs => pairs.map(pair => pair.policy - pair.plain)
const rate = r => (r.attempts ? r.refused / r.attempts : 0)

export default {
  id: 'spawn.policy_overhead',
  part: 'Command spawn policy, macOS backend: extra cost per spawn',
  what:
    "Extra cost of spawning a command through the app's macOS spawn policy vs a plain spawn: spawn-to-exit of " +
    '`/usr/bin/true` through backend.spawn (generated profile + the system profile runner + bash) minus the same ' +
    'command spawned plainly through bash, paired per iteration; cold = first pair of a fresh process. extra: ' +
    'forbidden reads refused N/N in this run (5 profile classes x 3 planted files in a throwaway HOME), the in-scratch ' +
    'read that must succeed, and hardlink_scan_ms = the hard-link walker over a 10 000-file tree with 10 links',
  hot_path:
    'apps/desktop/electron spawn-policy backend: createSeatbeltBackend().spawn (generated profile applied by the ' +
    'system profile runner), sbpl.ts renderSbpl, members.ts newRunToken',
  unit: 'ms',
  lang: 'TypeScript',
  miss_class: 'cpu',
  allow_nonpositive: {
    reason: 'paired difference (policy spawn minus plain spawn of the same iteration); noise can make one pair negative'
  },
  budget: {
    value: 50,
    op: '<=',
    stat: 'warm.p95',
    reason: 'a tool command spawned through the policy must not feel slower than a plain spawn by more than ~3 frames'
  },
  risk: 'every agent command pays this per spawn; a profile that silently widens lets the agent read planted secrets',
  failure_mode:
    'fails closed: no profile / empty argv / hard-link block => spawn refused (the backend spawn guard); the hard-link ' +
    'scan of the run roots is replaced here by its walker timed alone on a generated 10 000-file tree ' +
    '(extra.hardlink_scan_ms). The backend and the plain arm spawn detached (their own process groups, outside the ' +
    "runner's kill set); both commands exit in milliseconds, only a hung profile runner would linger",
  async measure(ctx) {
    const full = ctx.mode === 'full'
    const cold = []
    const warm = []
    const policy = []
    const plain = []
    const scan = []
    const refusal = { attempts: 0, refused: 0, leaked: [], allowedOk: 0, allowedTries: 0 }
    let plainLeak = true
    for (let i = 0; i < (full ? 5 : 2); i += 1) {
      const res = await runChild(ctx, { n: full ? 40 : 8, reps: full ? 2 : 1 })
      const o = overheads(res.pairs)
      cold.push(o[0])
      warm.push(...o.slice(1))
      policy.push(...res.pairs.slice(1).map(p => p.policy))
      plain.push(...res.pairs.slice(1).map(p => p.plain))
      scan.push(...res.scan)
      for (const key of ['attempts', 'refused', 'allowedOk', 'allowedTries']) refusal[key] += res.refusal[key]
      refusal.leaked.push(...res.refusal.leaked)
      plainLeak &&= res.plainLeak
    }
    const stat = xs => ({ p50: +q(xs, 50).toFixed(2), p95: +q(xs, 95).toFixed(2), n: xs.length })
    const refusedPct = +(100 * rate(refusal)).toFixed(1)
    return {
      cold,
      warm,
      extra: {
        policy_spawn_ms: stat(policy),
        plain_spawn_ms: stat(plain),
        hardlink_scan_ms: stat(scan),
        refusal,
        plain_spawn_reads_planted_file: plainLeak,
        secondary: [
          {
            name: `forbidden reads refused ${refusal.refused}/${refusal.attempts} in this run`,
            value: refusedPct,
            unit: '%',
            budget: 100,
            op: '>=',
            ok: refusedPct >= 100
          },
          {
            name: `allowed in-scratch reads succeed (of ${refusal.allowedTries})`,
            value: refusal.allowedOk,
            unit: 'reads',
            budget: refusal.allowedTries,
            op: '>=',
            ok: refusal.allowedOk >= refusal.allowedTries
          },
          {
            name: 'same read without the profile succeeds (the planted file is readable)',
            value: plainLeak ? 1 : 0,
            unit: 'yes=1',
            budget: 1,
            op: '>=',
            ok: Boolean(plainLeak)
          }
        ]
      }
    }
  },
  async control(ctx) {
    // Sabotage: a fake profile runner that sleeps, drops the profile and runs the command plainly.
    const fake = path.join(ctx.scratch, 'fake-profile-runner')
    fs.writeFileSync(
      fake,
      `#!/bin/bash\nsleep ${SABOTAGE_SLEEP_MS / 1000}\nwhile [ "$1" = "-p" ] || [ "$1" = "-D" ]; do shift 2; done\nexec "$@"\n`,
      { mode: 0o700 }
    )
    const base = await runChild(ctx, { n: 8, reps: 1 })
    const bad = await runChild(ctx, { n: 8, reps: 1, profileRunner: fake })
    const b = overheads(base.pairs)
    const v = overheads(bad.pairs)
    const delta = median(v) - median(b)
    const fall = rate(base.refusal) - rate(bad.refusal)
    const pct = r => (100 * rate(r)).toFixed(0)
    return [
      {
        name: `sabotaged profile runner (+${SABOTAGE_SLEEP_MS} ms, profile dropped): overhead`,
        expected: `median overhead grows by >= ${0.8 * SABOTAGE_SLEEP_MS} ms`,
        observed: `+${delta.toFixed(1)} ms (n=${b.length} vs ${v.length})`,
        value: delta,
        threshold: 0.8 * SABOTAGE_SLEEP_MS,
        op: '>=',
        ok: delta >= 0.8 * SABOTAGE_SLEEP_MS,
        base: b,
        variant: v
      },
      {
        name: 'sabotaged profile runner (profile dropped): refusals',
        expected: 'refused share of forbidden reads falls from 100 % to 0 % (a fall of 1.0)',
        observed: `refused ${pct(base.refusal)} % -> ${pct(bad.refusal)} %`,
        value: fall,
        threshold: 1,
        op: '>=',
        ok: fall >= 1
      }
    ]
  }
}
