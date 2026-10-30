// Row install.first_launch: the runtime install the app runs on first launch, per package and per stage, over a
// simulated network (loopback Range server, fixed bandwidth and latency) with the venv stage served from the uv cache
// the app ships. The Python side is install.first_launch.py.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HarnessError, median, percentile } from '../lib/stats.mjs'

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), 'install.first_launch.py')
// 100 Mbit/s and 20 ms per request: a common home broadband line; fixed so before/after runs compare.
const BANDWIDTH = Number(process.env.BENCH_INSTALL_BANDWIDTH ?? 12_500_000)
const LATENCY_MS = Number(process.env.BENCH_INSTALL_LATENCY_MS ?? 20)
const CONTROL_DELAY_S = 2
const CONTROL_N = 3
// Per-sample cool-down (this row only): before each sample, wait for the 1-minute load to drop under 4.0, at most this.
const SAMPLE_COOLDOWN_MAX_S = 180
const STAGES = ['download', 'unpack', 'stage', 'verify', 'publish', 'digest', 'other', 'total']
// Children of a network-free sample get an unreachable proxy (port 9, discard: nothing listens on loopback);
// the loopback Range server stays reachable through NO_PROXY.
const UNREACHABLE_PROXY = 'http://127.0.0.1:9'
const OFFLINE_ENV = {
  HTTP_PROXY: UNREACHABLE_PROXY,
  HTTPS_PROXY: UNREACHABLE_PROXY,
  ALL_PROXY: UNREACHABLE_PROXY,
  http_proxy: UNREACHABLE_PROXY,
  https_proxy: UNREACHABLE_PROXY,
  all_proxy: UNREACHABLE_PROXY,
  NO_PROXY: '127.0.0.1,localhost,::1',
  no_proxy: '127.0.0.1,localhost,::1'
}
// Per-package unpack budgets: binding secondaries, a miss makes the row MISSES.
const SUB_BUDGETS = [
  { name: 'node.unpack cold p95', pkg: 'node', budget: 4000 },
  { name: 'npm.unpack cold p95', pkg: 'npm', budget: 3000 }
]

/** Persistent artifact cache outside the repository; filled once from the real network by `prime`. */
function cacheDir() {
  return join(process.env.BENCH_CACHE_DIR ?? join(os.tmpdir(), 'iclone-bench-cache'), 'install.first_launch')
}

function scratchEnv(work, offline) {
  const home = join(work, 'home')
  return {
    HOME: home,
    HERMES_HOME: join(home, '.hermes'),
    HERMES_RUNTIME_DIR: join(work, 'store'),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    TMPDIR: join(work, 'tmp'),
    ...(offline ? OFFLINE_ENV : {})
  }
}

async function harness(ctx, name, args, { root = null, offline = true } = {}) {
  const work = join(ctx.scratch, name)
  await rm(work, { recursive: true, force: true })
  const env = scratchEnv(work, offline)
  await mkdir(env.HERMES_HOME, { recursive: true })
  await mkdir(env.TMPDIR, { recursive: true })
  const out = join(ctx.scratch, `${name}.json`)
  const script = root ? join(root, 'bench', 'rows', 'install.first_launch.py') : HARNESS
  const res = await ctx.python(
    ['-X', 'utf8', script, ...args, '--out', out, ...(args[0] === 'sample' ? ['--work', work] : [])],
    { cwd: root ?? ctx.app, env, timeoutMs: 20 * 60 * 1000 }
  )
  const result = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
  if (!ctx.keep) {
    await rm(work, { recursive: true, force: true })
  }
  if (res.code !== 0) {
    const why = result?.failed?.join(' | ') || res.stderr.trim().split('\n').slice(-3).join(' | ')
    throw new HarnessError(`install harness ${name} exited ${res.code}: ${why}`)
  }
  return result
}

/** APFS clone (`cp -c`): a copy-on-write tree in a few seconds, untimed. */
async function clone(ctx, from, to) {
  const res = await ctx.sh('cp', ['-c', '-R', from, to])
  if (res.code !== 0) {
    throw new HarnessError(`cp -c -R failed (${res.code}): ${res.stderr.trim().split('\n').at(-1)}`)
  }
}

/**
 * The venv stage of one first launch in a throwaway APFS clone of the checkout (the stage writes the venv into the
 * project root), with a fresh store and HOME; python + uv come from the loopback server.
 * - `warmup` (once per run, real network, not a sample): empty uv cache, `uv sync` reaches the package index; after
 *   it the machine uv cache is staged in the form the desktop bundle ships (scripts/bundles/native.py
 *   stage_uv_cache) into `<scratch>/uv-cache-shipped`, deliberately NOT pruned to uv.lock (extra.network_declared.uv_cache).
 * - `cold`: that shipped cache is cloned to the payload root (`uv-cache/` beside the store), where
 *   pm.packages.uv_cache_dir() copies it out on the first call, inside the timed stage, as on a sealed install.
 * - `warm`: same, but uv_cache_dir() has already copied it out (untimed) before the stage starts.
 * cold and warm children are network-free (unreachable proxy); an incomplete cache fails the sample.
 */
async function venvSample(ctx, name, mode) {
  const root = join(ctx.scratch, `${name}-clone`)
  const shipped = join(ctx.scratch, 'uv-cache-shipped')
  await rm(root, { recursive: true, force: true })
  await clone(ctx, ctx.app, root)
  await rm(join(root, '.git'), { recursive: true, force: true })
  writeFileSync(join(root, '.bench-clone'), 'throwaway clone made by bench install.first_launch\n')
  if (mode === 'warmup') {
    await rm(shipped, { recursive: true, force: true })
  }
  const uvArgs = mode === 'warmup' ? ['--uv-cache-ship', shipped] : ['--uv-cache-payload', shipped]
  try {
    const s = await harness(
      ctx,
      name,
      [
        'sample',
        '--cache',
        cacheDir(),
        '--phase',
        mode === 'warm' ? 'warm' : 'cold',
        '--venv',
        '--bandwidth',
        String(BANDWIDTH),
        '--latency-ms',
        String(LATENCY_MS),
        ...uvArgs
      ],
      { root, offline: mode !== 'warmup' }
    )
    const venv = s.packages.venv?.total
    const uv = s.packages.uv?.total
    if (!(venv > 0) || !(uv > 0)) {
      throw new HarnessError(`venv sample ${name} timed no venv/uv stage: ${JSON.stringify(Object.keys(s.packages))}`)
    }
    return {
      ms: venv + uv,
      venv_ms: venv,
      uv_ms: uv,
      python_ms: s.packages.python?.total ?? null,
      uv_cache: s.uv_cache ?? null
    }
  } finally {
    if (!ctx.keep) {
      await rm(root, { recursive: true, force: true })
    }
  }
}

function sample(ctx, name, phase, extra = []) {
  return harness(ctx, name, [
    'sample',
    '--cache',
    cacheDir(),
    '--phase',
    phase,
    '--bandwidth',
    String(BANDWIDTH),
    '--latency-ms',
    String(LATENCY_MS),
    ...extra
  ])
}

// The stages that partition a package's `_install` span when the install is serial; `other` is the remainder.
const PARTITION = ['download', 'unpack', 'stage', 'verify', 'publish']
// Hook spans: the package's own wall time whatever runs beside it (a prefetch only adds a concurrent download).
const HOOK_STAGES = ['unpack', 'stage', 'verify', 'publish', 'digest', 'total']
export const NOT_ATTRIBUTABLE = 'not attributable (downloads overlap)'

const overlapMs = (a, b) => Math.min(a.t1, b.t1) - Math.max(a.t0, b.t0)
const inside = (inner, outer) => inner.t0 >= outer.t0 && inner.t1 <= outer.t1

/**
 * Where one sample's timeline is not serial. A sample is serial (its stages attributable) only when EVERY download
 * (one fetch_many call) fetches the artifacts of one package, lies wholly inside that package's own `install` span,
 * and overlaps no other package's unpack, verify or download. Anything else is recorded here: a call for several
 * packages, a download outside its owner's install span (a prefetch, even one that only runs beside another
 * package's download), and every overlap with another package's work. Empty = serial.
 */
export function downloadOverlaps(events) {
  if (!Array.isArray(events)) {
    throw new HarnessError('install sample carries no timeline (events)')
  }
  const installs = events.filter(e => e.kind === 'install')
  const downloads = events.filter(e => e.kind === 'download')
  const work = events.filter(e => e.kind === 'unpack' || e.kind === 'verify')
  const out = []
  for (const d of downloads) {
    const who = d.packages.join('+')
    const ms = +(d.t1 - d.t0).toFixed(1)
    if (d.packages.length !== 1) {
      out.push({ download: who, during: 'one call for several packages', ms })
    } else if (!installs.some(i => i.package === who && inside(d, i))) {
      out.push({ download: who, during: `outside the install span of ${who}`, ms })
    }
    for (const w of work) {
      const both = overlapMs(d, w)
      if (both > 0 && !d.packages.includes(w.package)) {
        out.push({ download: who, during: `${w.kind} of ${w.package}`, ms: +both.toFixed(1) })
      }
    }
    for (const o of downloads) {
      const both = overlapMs(d, o)
      if (o !== d && both > 0 && !o.packages.some(p => d.packages.includes(p))) {
        out.push({ download: who, during: `download of ${o.packages.join('+')}`, ms: +both.toFixed(1) })
      }
    }
  }
  return out
}

/**
 * Per package and stage, p50 and p95 across the samples of one phase, from wall-clock spans. Every stage only when
 * every sample's timeline is serial (`other` = the span's remainder, never negative: a negative remainder means
 * nested hooks and is reported as `overcount`); otherwise only the hook spans, and `stages` says why.
 */
export function stageReport(samples) {
  const overlaps = samples.flatMap((s, i) => downloadOverlaps(s.events).map(o => ({ sample: i, ...o })))
  const attributable = overlaps.length === 0
  const rows = samples.map(s =>
    Object.fromEntries(
      Object.entries(s.packages).map(([name, p]) => {
        if (!attributable) {
          return [name, p]
        }
        const rest = p.total - PARTITION.reduce((a, k) => a + (p[k] ?? 0), 0)
        return [name, { ...p, other: Math.max(0, +rest.toFixed(1)), overcount: rest < 0 ? +(-rest).toFixed(1) : 0 }]
      })
    )
  )
  const stages = attributable ? [...STAGES, 'overcount'] : HOOK_STAGES
  const out = {}
  for (const name of samples[0].order) {
    out[name] = { bytes: samples[0].packages[name].bytes }
    for (const stage of [...stages, 'subprocess_in_hooks']) {
      const values = rows.map(r => r[name]?.[stage]).filter(v => typeof v === 'number')
      if (values.length && !(stage === 'overcount' && values.every(v => v === 0))) {
        out[name][stage] = { p50: median(values), p95: percentile(values, 95) }
      }
    }
  }
  return {
    attributable,
    stages: attributable ? 'serial: every stage from wall-clock spans' : NOT_ATTRIBUTABLE,
    overlap_count: overlaps.length,
    overlaps: overlaps.slice(0, 20),
    packages: out
  }
}

// The resource each stage of the cold first launch waits on: a miss is classed by the stage that dominates it.
// These partition a package's total (`other` is the remainder); `digest` is timed inside another stage, so it is
// not summed again.
const STAGE_CLASS = Object.freeze({
  download: 'network',
  unpack: 'cpu',
  verify: 'cpu',
  other: 'cpu',
  stage: 'io',
  publish: 'io',
  venv: 'io'
})

/**
 * The dominant stage of the cold first launch, from this run's own breakdown: each install stage's p50 summed across
 * packages, plus the venv stage (median of the cold venv samples) as one more stage. Returns `{ class, cause,
 * stage_ms }` for `extra.miss`, so a MISS names the stage that cost the time, with its seconds, not a declared guess.
 * With `firstLaunchMs` (the stages are not attributable: downloads overlap), only the stages present are summed and
 * the rest of the first launch is one `unattributed` bucket; when it is the largest, the class is `unattributed`
 * (no class is assumed for time no stage owns).
 */
export function dominantStage(
  coldStages,
  venvColdMs,
  line = { bandwidth: BANDWIDTH, latencyMs: LATENCY_MS },
  { firstLaunchMs = null } = {}
) {
  const sums = {}
  for (const pkg of Object.values(coldStages)) {
    for (const stage of Object.keys(STAGE_CLASS)) {
      if (typeof pkg[stage]?.p50 === 'number') {
        sums[stage] = (sums[stage] ?? 0) + pkg[stage].p50
      }
    }
  }
  if (!venvColdMs.length) {
    throw new HarnessError('dominantStage: no cold venv sample')
  }
  sums.venv = median(venvColdMs)
  const s = v => (v / 1000).toFixed(1)
  if (firstLaunchMs !== null) {
    const known = Object.values(sums).reduce((a, b) => a + b, 0)
    const unattributed = Math.max(0, firstLaunchMs - known)
    const [stage, ms] = Object.entries(sums).sort((a, b) => b[1] - a[1])[0]
    const stageMs = Object.fromEntries(
      [...Object.entries(sums), ['unattributed', unattributed]].map(([k, v]) => [k, +v.toFixed(1)])
    )
    const why = `downloads overlap: a download ran outside its own package's install span`
    return unattributed > ms
      ? {
          class: 'unattributed',
          cause: `${s(unattributed)} s of ${s(firstLaunchMs)} s of the cold first launch is not attributable to a stage (${why}); largest attributable stage: ${stage} ${s(ms)} s`,
          stage_ms: stageMs
        }
      : {
          class: STAGE_CLASS[stage],
          cause: `${stage} ${s(ms)} s of ${s(firstLaunchMs)} s of the cold first launch (dominant attributable stage, p50 summed across packages; ${s(unattributed)} s not attributable: ${why})`,
          stage_ms: stageMs
        }
  }
  const total = Object.values(sums).reduce((a, b) => a + b, 0)
  const [stage, ms] = Object.entries(sums).sort((a, b) => b[1] - a[1])[0]
  const over =
    stage === 'download' ? `, over a ${line.bandwidth / 1e6} MB/s line with ${line.latencyMs} ms per request` : ''
  const stageMs = Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, +v.toFixed(1)]))
  return {
    class: STAGE_CLASS[stage],
    cause: `${stage} ${s(ms)} s of ${s(total)} s of the cold first launch (dominant stage, p50 summed across packages${over})`,
    stage_ms: stageMs
  }
}

/** Which interpreter ran the harness, without the checkout's location (BENCH_PYTHON, checkout venv, or PATH). */
function interpreterSource(ctx) {
  if (process.env.BENCH_PYTHON) {
    return 'BENCH_PYTHON'
  }
  const rel = relative(ctx.app, ctx.python.path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? 'checkout venv' : 'python3 on PATH'
}

/** The per-sample cool-down, then the sample; every wait is recorded in `waits`. */
async function cooled(ctx, waits, label, fn) {
  const c = await ctx.coolDown(label, { maxS: SAMPLE_COOLDOWN_MAX_S })
  waits.push({ before: label, waited_s: c.waited_s, capped: c.capped, load_one: c.load_at_start.one })
  return fn()
}

/** One cold first launch, as the row samples it: install_total + venv_stage; `injectPackage` delays its artifact. */
async function firstLaunchSample(ctx, waits, name, injectPackage) {
  const inject = injectPackage ? ['--inject-delay-s', String(CONTROL_DELAY_S), '--inject-package', injectPackage] : []
  const s = await cooled(ctx, waits, name, () => sample(ctx, name, 'cold', inject))
  const v = await cooled(ctx, waits, `${name}-venv`, () => venvSample(ctx, `${name}-venv`, 'cold'))
  return {
    total_ms: s.total_ms + v.ms,
    order: s.order,
    events: s.events,
    parts: { install_ms: s.total_ms, venv_stage_ms: v.ms }
  }
}

/** Wall time from the first to the last end of the downloads that fetched `pkg`'s artifacts, from a sample's events. */
export function downloadSpan(events, pkg) {
  const own = (Array.isArray(events) ? events : []).filter(e => e.kind === 'download' && e.packages.includes(pkg))
  if (!own.length) {
    throw new HarnessError(`control: no download of ${pkg} in the sample's timeline`)
  }
  return Math.max(...own.map(e => e.t1)) - Math.min(...own.map(e => e.t0))
}

/**
 * The control: a server delay on the artifact of the FIRST package in install order (read from the base sample's
 * `order`, the source of the row's breakdown). Nothing precedes that download, so no prefetch can hide it, serial or
 * overlapped. It fires only when BOTH hold: median(delayed first_launch_total) − median(base) >= 0.8·D, and in EVERY
 * delayed sample the first package's own download span (from that sample's events) grew by >= 0.8·D against the
 * base median. A delay that reached the download but not the total (shared bandwidth absorbed it), or a total that
 * grew for another reason, does not fire: the row is then INVALID, never a good number.
 * `takeSample(name, injectPackage)` → `{ total_ms, order, events, parts }`.
 */
export async function delayControl(takeSample, { n = CONTROL_N, delayS = CONTROL_DELAY_S } = {}) {
  const base = []
  const variant = []
  const baseSpan = []
  const variantSpan = []
  const parts = []
  let first = null
  for (let i = 0; i < n; i++) {
    const b = await takeSample(`control-base-${i}`, null)
    first ??= b.order[0] ?? null
    if (!first || b.order[0] !== first) {
      throw new HarnessError(`control: first package in install order is ${b.order[0]} in base ${i}, expected ${first}`)
    }
    const v = await takeSample(`control-delay-${i}`, first)
    if (v.order[0] !== first) {
      throw new HarnessError(`control: the delayed sample ${i} installed ${v.order[0]} first, not ${first}`)
    }
    base.push(b.total_ms)
    variant.push(v.total_ms)
    baseSpan.push(downloadSpan(b.events, first))
    variantSpan.push(downloadSpan(v.events, first))
    parts.push({ base: b.parts, delayed: v.parts })
  }
  const value = median(variant) - median(base)
  const threshold = 0.8 * delayS * 1000
  const spanBase = median(baseSpan)
  const spanGrowth = variantSpan.map(x => x - spanBase)
  const spanMin = Math.min(...spanGrowth)
  const spanOk = spanMin >= threshold
  const r = xs => xs.map(Math.round).join('/')
  return {
    name: `${delayS} s server delay on the artifact of the first package in install order (${first}) → first_launch_total grows`,
    expected:
      `median(delayed) − median(base) >= ${threshold} ms (n=${n} each), and in every delayed sample ${first}'s ` +
      `download span grows by >= ${threshold} ms against the base median`,
    observed:
      `total ${Math.round(value)} ms (base ${r(base)} → delayed ${r(variant)}); ${first} download span grew by ` +
      `${r(spanGrowth)} ms, min ${Math.round(spanMin)} (base median ${Math.round(spanBase)} → delayed ${r(variantSpan)})`,
    value,
    threshold,
    op: '>=',
    ok: value >= threshold && spanOk,
    checks: [
      {
        name: `${first} download span growth, min over the delayed samples (from each sample's events)`,
        value: spanMin,
        threshold,
        op: '>=',
        ok: spanOk
      }
    ],
    base,
    variant,
    detail: {
      first_package: first,
      download_span_ms: { base: baseSpan.map(x => +x.toFixed(1)), delayed: variantSpan.map(x => +x.toFixed(1)) },
      parts
    }
  }
}

export default {
  id: 'install.first_launch',
  part: 'Runtime install, first launch',
  what:
    'Wall time of the first launch: `pm install` tool closure (ffmpeg, node, npm, python, ripgrep) + optional ' +
    'defaults (agent-browser with chromium, cua-driver), from the first `_install_names` call to the last package ' +
    'published, per package and stage (download, unpack, stage, verify, publish incl. tree digest), PLUS the venv ' +
    'stage (uv + `uv sync` of uv.lock, pm.packages.Venv) in a throwaway APFS clone of the checkout. Samples are ' +
    'first_launch_total = install_total + venv_stage of the same index (extra.totals has both parts). ' +
    'Network-free samples: pinned artifacts come from a loopback Range server (100 Mbit/s shared, 20 ms per ' +
    'request); the venv stage resolves from the uv cache the desktop bundle ships (payload `uv-cache/`, copied out ' +
    'by pm.packages.uv_cache_dir; staged as the bundle does, not pruned), built once per run by a warm-up `uv sync` that reaches the real package index ' +
    '(reported as extra.real_network, not a sample); `prime` may fetch missing pinned artifacts once from their ' +
    'lockfile URLs (real network, untimed). What is blocked during a sample: the harness Python process refuses ' +
    'non-loopback sockets and name resolution (audit hook; its own sockets only); child processes (uv, node, npm, ' +
    'tar) get HTTP(S)_PROXY/ALL_PROXY = an unreachable loopback port with NO_PROXY for loopback, and npm runs ' +
    '`--offline` by product code; pm strips UV_OFFLINE from the environment of uv, so uv offline is enforced by the proxy ' +
    'alone and a cache miss fails the sample. cold = empty store, empty download cache, fresh HOME whose machine uv ' +
    'cache is empty (the shipped cache is copied out inside the timed stage), fresh venv dir, fresh process; warm = ' +
    'fresh store whose verified download cache (fetch-<sha256>) holds every archive, machine uv cache already ' +
    'copied out, fresh venv dir. Shell activation is not run. Before EACH sample (this row only) the 1-minute load ' +
    `must drop under 4.0, waiting at most ${SAMPLE_COOLDOWN_MAX_S} s (the window is released while waiting); every ` +
    'wait is in extra.sample_cooldowns and a wait that hits the cap makes the row unclean. Per-stage times come from ' +
    'wall-clock spans only when every cold sample ran serially: every download fetches one package and lies inside ' +
    "that package's own install span. A download outside it (an installer that prefetches, even one that only runs " +
    'beside another download) makes extra.stages "not attributable (downloads overlap)": only the hook spans are ' +
    'reported, and the miss is classed from those (unattributed when the unowned time dominates). The control runs ' +
    'its own untimed real-network venv warm-up first (so it also works with --control-only), because the shipped uv ' +
    "cache's index entries stay fresh for about 10 minutes; its 6 first launches (~40 s install + ~6 s venv each, " +
    'about 5 min on a quiet machine) fit that window unless cool-down waits stretch it, and then the samples fail ' +
    '(ERROR), never a number.',
  hot_path:
    'pm/cli.py _install_names/_install_defaults → pm/install.py ensure/_install/_prepare_artifacts/_publish_entry → ' +
    'pm/store.py fetch_many/extract/extract_tar/_tar_filter/tree_digest → pm/packages.py Npm.unpack (npm self-install) ' +
    '→ pm/packages.py uv_cache_dir + Venv.apply (uv sync)',
  unit: 'ms',
  lang: 'Python',
  // Declared expectation only: measure() classes the miss from the run's own dominant stage (extra.miss).
  miss_class: 'network',
  budget: {
    value: 45000,
    op: '<=',
    stat: 'cold.p95',
    reason:
      'the first-launch overlay blocks the user; 45 s is the ceiling for the whole ' +
      'first launch (install_total + venv_stage, network-free sample). The verdict depends on the simulated line: ' +
      `${BANDWIDTH / 1e6} MB/s (${(BANDWIDTH * 8) / 1e6} Mbit/s) shared and ${LATENCY_MS} ms per request`
  },
  risk: 'every new user waits on it once; a slow or stalled package is the first impression and a support ticket',
  failure_mode:
    'observed 2026-10-24: 86 s cold on a loaded machine (67 s unloaded); node 21.6 s and npm 19.4 s mostly ' +
    'unpacking; packages installed one after another',

  async measure(ctx) {
    const prime = await harness(ctx, 'prime', ['prime', '--cache', cacheDir()], { offline: false })
    ctx.log('venv warm-up (real package index, builds the shipped uv cache; not a sample)')
    const realNetwork = await venvSample(ctx, 'venv-warmup', 'warmup')
    const waits = []
    const n = ctx.mode === 'full' ? 5 : 2
    const cold = []
    const warm = []
    const venvCold = []
    const venvWarm = []
    for (let i = 0; i < n; i++) {
      ctx.log(`cold ${i + 1}/${n}`)
      cold.push(await cooled(ctx, waits, `cold-${i}`, () => sample(ctx, `cold-${i}`, 'cold')))
      ctx.log(`warm ${i + 1}/${n}`)
      warm.push(await cooled(ctx, waits, `warm-${i}`, () => sample(ctx, `warm-${i}`, 'warm')))
      ctx.log(`venv cold (shipped uv cache, network-free) ${i + 1}/${n}`)
      venvCold.push(await cooled(ctx, waits, `venv-cold-${i}`, () => venvSample(ctx, `venv-cold-${i}`, 'cold')))
      ctx.log(`venv warm (uv cache already copied out) ${i + 1}/${n}`)
      venvWarm.push(await cooled(ctx, waits, `venv-warm-${i}`, () => venvSample(ctx, `venv-warm-${i}`, 'warm')))
    }
    ctx.log('profile node+npm')
    const profile = await cooled(ctx, waits, 'profile', () =>
      sample(ctx, 'profile', 'cold', ['--packages', 'node,npm', '--profile', 'node,npm'])
    )
    const coldReport = stageReport(cold)
    const coldStages = coldReport.packages
    const firstLaunchCold = cold.map((s, i) => s.total_ms + venvCold[i].ms)
    const secondary = SUB_BUDGETS.map(({ name, pkg, budget }) => {
      const value = coldStages[pkg]?.unpack?.p95
      if (typeof value !== 'number') {
        throw new HarnessError(`${name}: no ${pkg}.unpack stage in the cold samples`)
      }
      return {
        name,
        value,
        unit: 'ms',
        budget,
        op: '<=',
        ok: value <= budget,
        reason: `${pkg} is unpacked on every first launch while the overlay blocks the user: ≤ ${budget / 1000} s cold p95 keeps it inside the 45 s first launch`
      }
    })
    const ms = xs => xs.map(x => +x.toFixed(1))
    return {
      cold: firstLaunchCold,
      warm: warm.map((s, i) => s.total_ms + venvWarm[i].ms),
      extra: {
        secondary,
        miss: dominantStage(
          coldStages,
          venvCold.map(v => v.ms),
          undefined,
          coldReport.attributable ? {} : { firstLaunchMs: median(firstLaunchCold) }
        ),
        stages: coldReport.stages,
        stage_overlaps: { count: coldReport.overlap_count, first: coldReport.overlaps },
        sample_cooldowns: { max_s: SAMPLE_COOLDOWN_MAX_S, below_one_minute_load: 4.0, waits },
        totals: {
          definition:
            'first_launch_total (the row samples) = install_total + venv_stage of the same index i; the budget is on it',
          install_total_ms: { cold: ms(cold.map(s => s.total_ms)), warm: ms(warm.map(s => s.total_ms)) },
          venv_stage_ms: { cold: ms(venvCold.map(v => v.ms)), warm: ms(venvWarm.map(v => v.ms)) },
          venv_stage_parts_ms: { cold: venvCold, warm: venvWarm }
        },
        interpreter: {
          source: interpreterSource(ctx),
          version: prime.python_version ?? null,
          executable_sha256: prime.python_sha256 ?? null
        },
        network: cold[0].network,
        requests_per_cold_sample: cold.map(s => s.requests),
        tools_only_ms: { cold: cold.map(s => s.tools_ms), warm: warm.map(s => s.tools_ms) },
        cold_stages: coldStages,
        warm_stages: stageReport(warm).packages,
        attribution_profile: {
          packages: profile.packages,
          cprofile_unpack_top_by_tottime: profile.profiles,
          first_exec_of_new_node_binary: profile.first_exec
        },
        real_network: {
          what:
            'one venv stage over the real network (empty uv cache, `uv sync` against the package index), the warm-up of ' +
            'this run; reported, not budgeted, not in the samples',
          venv_stage_ms: +realNetwork.ms.toFixed(1),
          parts: realNetwork
        },
        real_network_prime: prime,
        network_declared: {
          loopback: 'every pinned artifact (tools, defaults, python, uv) from the local Range server',
          uv_cache:
            'the app ships a uv cache: the desktop bundle stages `uv-cache/` at the payload root ' +
            '(scripts/bundles/native.py stage_uv_cache, then prune_uv_cache_to_lock) and ' +
            'pm.packages.uv_cache_dir() copies it to the machine cache on first call; the samples use that path with the staged cache NOT ' +
            'pruned: the prune drops entries an offline uv sync needs (count in parts.uv_cache.prune_to_lock)',
          real: 'the venv warm-up (extra.real_network) and prime (missing pinned artifacts only); never a sample',
          blocked:
            'sample process: audit hook refuses non-loopback sockets/DNS (Python only); children: unreachable ' +
            'proxy + NO_PROXY loopback; npm --offline (product); UV_OFFLINE is stripped by pm, not relied on'
        },
        not_timed: {
          activation: 'pm.install.activate writes shell activation into the runtime tree; not run',
          python_launchers: 'hermes_cli.venv_sync.publish_launchers after python writes into the runtime tree; stubbed'
        }
      }
    }
  },

  async control(ctx) {
    // The control's venv samples resolve setuptools/wheel from the pypi index entries of uv-cache-shipped, which stay
    // fresh for about 10 minutes; measure()'s warm-up is too old by now (n=5 puts it ~10 min back) or absent
    // (--control-only). So the control primes the artifact cache and runs its OWN untimed real-network warm-up, and
    // all its venv samples start inside that window: 2·CONTROL_N first launches of ~40 s install + ~6 s venv each,
    // about 5 min on a quiet machine. Per-sample cool-down waits (up to SAMPLE_COOLDOWN_MAX_S each) can stretch that
    // past the window; then uv reaches for the blocked network and the row ends ERROR, never with a number.
    await harness(ctx, 'control-prime', ['prime', '--cache', cacheDir()], { offline: false })
    ctx.log('control venv warm-up (real package index, rebuilds the shipped uv cache; not a sample)')
    const warmup = await venvSample(ctx, 'control-venv-warmup', 'warmup')
    const warmedAt = Date.now()
    const waits = []
    const c = await delayControl((name, injectPackage) => firstLaunchSample(ctx, waits, name, injectPackage))
    return {
      ...c,
      detail: {
        ...c.detail,
        venv_warmup: {
          sample: false,
          what: 'real-network venv stage that rebuilt the shipped uv cache before the control samples; untimed for the control',
          venv_stage_ms: +warmup.ms.toFixed(1),
          samples_done_s_after: +((Date.now() - warmedAt) / 1000).toFixed(1)
        },
        sample_cooldowns: waits
      }
    }
  }
}
