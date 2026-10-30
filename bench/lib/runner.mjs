// The bench runner: discovers rows, gives each a context, validates samples, judges budgets, runs the negative
// control, and writes `results.json` (schema bench/2) + `table.md` outside the repository.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { captureEnv, identityStrings, load, LOAD_CLEAN_MAX, loadIsClean, redact } from './env.mjs'
import { MEASURED_MISS_CLASSES, SCHEMA, validateResult, validateRow } from './schema.mjs'
import { HarnessError, judge, median, summarize } from './stats.mjs'
import { clipTail, renderTable } from './table.mjs'

export const EXIT = Object.freeze({ OK: 0, HARNESS: 2, INVALID: 3 })

/** Resolve the interpreter `tests/pm` uses: BENCH_PYTHON, else the repo venv, else python3 on PATH. */
export function resolvePython(app) {
  if (process.env.BENCH_PYTHON) {
    return process.env.BENCH_PYTHON
  }
  const venv = join(app, 'venv', 'bin', 'python')
  return existsSync(venv) ? venv : 'python3'
}

/** sha256 of the real file behind the interpreter (compare with the pin's executable_sha256); null if unreadable. */
export function interpreterDigest(python) {
  try {
    return createHash('sha256')
      .update(readFileSync(realpathSync(python)))
      .digest('hex')
  } catch {
    return null
  }
}

/**
 * Live process groups and scratch directories, so an abort (SIGINT/SIGTERM of the runner) or a timeout can take down
 * the whole tree a row started and leave nothing behind. Children are spawned `detached` (their own process group,
 * pgid = pid); the group is signalled, never a name or a pattern.
 */
const live = {
  groups: new Set(),
  scratches: new Set(),
  // Process groups that outlived SIGKILL: a row whose group is here keeps its scratch (nothing is removed under them).
  survivors: new Set(),
  window: null,
  acquiring: null,
  aborting: false,
  keep: false
}
const KILL_GRACE_MS = 5000
const ABORT_GRACE_MS = 3000
const SIGKILL_WAIT_MS = 2000
const POLL_MS = 25

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal)
    return true
  } catch {
    return false
  }
}

/** Signal 0 to the group: true while any member is alive. EPERM = the id now belongs to someone else: not ours. */
export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitGone(pgid, ms) {
  const end = Date.now() + ms
  while (groupAlive(pgid)) {
    if (Date.now() >= end) {
      return false
    }
    await sleep(POLL_MS)
  }
  return true
}

const reaping = new Map()

/**
 * Take a process group down and resolve only when it is gone: SIGTERM, poll signal 0 for up to `graceMs`, SIGKILL
 * what is left, poll again (≤ 2 s). Resolves false only if a member survived SIGKILL. A signal is sent only while the
 * group still answers signal 0, so an id the system already reused is not signalled. The poll timers are not
 * unref'd: a caller that awaits this (the abort path) cannot exit before the group is dead.
 */
export function reapGroup(pgid, graceMs = KILL_GRACE_MS) {
  if (!reaping.has(pgid)) {
    const job = (async () => {
      if (!groupAlive(pgid)) {
        return true
      }
      signalGroup(pgid, 'SIGTERM')
      if (await waitGone(pgid, graceMs)) {
        return true
      }
      signalGroup(pgid, 'SIGKILL')
      return waitGone(pgid, SIGKILL_WAIT_MS)
    })()
    reaping.set(
      pgid,
      job.finally(() => reaping.delete(pgid))
    )
  }
  return reaping.get(pgid)
}

/**
 * Spawn without a shell in a new process group; resolves `{ code, stdout, stderr, ms, timedOut }` (never rejects on a
 * non-zero exit). On `timeoutMs` the whole group is reaped; on exit, any grandchild left in the group is reaped too,
 * and the promise settles only after the group is gone, so a caller never removes a scratch under a live tree.
 * `track: false` keeps the child out of the abort's kill set (the lock tool, which the abort handles itself).
 */
export function run(cmd, args, opts = {}) {
  if (live.aborting && opts.track !== false) {
    return Promise.reject(new HarnessError('the run is aborting: no new child processes'))
  }
  return new Promise((done, fail) => {
    const t0 = process.hrtime.bigint()
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    if (child.pid && opts.track !== false) {
      live.groups.add(child.pid)
    }
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => {
      stderr += d
      if (opts.tee) {
        process.stderr.write(d)
      }
    })
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          reapGroup(child.pid)
        }, opts.timeoutMs)
      : null
    child.on('error', err => {
      live.groups.delete(child.pid)
      fail(err)
    })
    child.on('close', async code => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6
      if (timer) {
        clearTimeout(timer)
      }
      const gone = await reapGroup(child.pid, timedOut ? KILL_GRACE_MS : 1000)
      live.groups.delete(child.pid)
      if (!gone) {
        live.survivors.add(child.pid)
        fail(new HarnessError(`process group ${child.pid} (${cmd}) survived SIGKILL`))
        return
      }
      done({ code: code ?? -1, stdout, stderr, ms, timedOut })
    })
  })
}

/**
 * Environment for a child that may load app code: HOME, HERMES_HOME and TMPDIR under the row's scratch, and
 * GIT_CEILING_DIRECTORIES at the scratch so a git call from inside it never walks up into a repository above.
 */
export function scratchEnvFor(scratch) {
  const home = join(scratch, '.scratch-home')
  for (const dir of [home, join(home, '.hermes'), join(home, 'tmp')]) {
    mkdirSync(dir, { recursive: true })
  }
  return (extra = {}) => ({
    ...process.env,
    HOME: home,
    HERMES_HOME: join(home, '.hermes'),
    TMPDIR: join(home, 'tmp'),
    GIT_CEILING_DIRECTORIES: scratch,
    ...extra
  })
}

/**
 * Rows are `bench/rows/<id>.mjs`. Files starting with `_` are helpers and are never imported; with `--only`, only the
 * named files are imported (a row module may not run anything at import, but this keeps one broken row from blocking
 * another). A row whose id differs from its file name is refused.
 */
export async function discoverRows(rowsDir, only) {
  const stems = (await readdir(rowsDir))
    .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
    .map(f => f.slice(0, -'.mjs'.length))
    .sort()
  if (only?.length) {
    const unknown = only.filter(id => !stems.includes(id))
    if (unknown.length) {
      throw new HarnessError(`--only names unknown row(s): ${unknown.join(', ')} (known: ${stems.join(', ')})`)
    }
  }
  const rows = []
  for (const stem of only?.length ? stems.filter(s => only.includes(s)) : stems) {
    const mod = await import(pathToFileURL(join(rowsDir, `${stem}.mjs`)).href)
    const row = validateRow(mod.default, `${stem}.mjs`)
    if (row.id !== stem) {
      throw new HarnessError(`row file ${stem}.mjs exports id ${row.id}; the file must be named <id>.mjs`)
    }
    rows.push(row)
  }
  return rows
}

// The lock tool is never in the abort's kill set: the abort reaps an in-flight acquire itself and then releases by
// name (gpu_lock's own SIGTERM handler drops a lock it took; the release covers a SIGKILL mid-write).
function gpuLock(args) {
  return run('python3', [process.env.BENCH_GPU_LOCK, ...args], { env: process.env, track: false })
}

/**
 * Acquire the exclusive window under `who` (gpu_lock clamps --max to 900 s). Exit 3 (another holder kept it) and
 * 4 (Blenders still running; the tool dropped the lock) both mean the measure runs outside a window: unclean.
 */
export async function acquireWindow(who) {
  if (!process.env.BENCH_GPU_LOCK) {
    return { held: false, who, reason: 'no exclusive window (BENCH_GPU_LOCK unset)' }
  }
  if (live.aborting) {
    throw new HarnessError('the run is aborting: no new window')
  }
  const res = await new Promise((resolveAcquire, rejectAcquire) => {
    const child = spawn('python3', [process.env.BENCH_GPU_LOCK, 'acquire', '--who', who, '--max', '900'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    live.acquiring = { pgid: child.pid, who }
    let stdout = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', () => {})
    child.on('error', err => {
      live.acquiring = null
      rejectAcquire(err)
    })
    child.on('close', code => {
      live.acquiring = null
      resolveAcquire({ code: code ?? -1, stdout })
    })
  })
  if (live.aborting) {
    throw new HarnessError('the run aborted while the window was being acquired')
  }
  if (res.code === 0) {
    return { held: true, who, reason: null }
  }
  return { held: false, who, reason: `no exclusive window (gpu_lock acquire exit ${res.code})` }
}

/**
 * Release a window this run holds, with the same `--who` it was acquired under. gpu_lock refuses a release without the
 * holder's name (exit 5) and keeps the lock: any refusal is a harness error, never ignored.
 */
export function releaseWindow(window) {
  if (!window?.held) {
    return Promise.resolve({ released: false, overheld: false })
  }
  // The abort and the row's own `finally` may both release the same window: one release, shared.
  window.releasing ??= releaseOnce(window).finally(() => (window.releasing = null))
  return window.releasing
}

async function releaseOnce(window) {
  const res = await gpuLock(['release', '--who', window.who])
  let out = null
  try {
    out = JSON.parse(res.stdout.trim().split('\n').pop())
  } catch {
    out = null
  }
  if (res.code !== 0 || out?.released !== true) {
    throw new HarnessError(
      `gpu_lock release --who ${window.who} failed (exit ${res.code}): ${clipTail((res.stdout + res.stderr).trim(), 200)}`
    )
  }
  window.held = false
  return { released: true, overheld: Boolean(out.overheld), held_s: out.held_s }
}

/**
 * A row's other budgets (`extra.secondary[]`: memory per pane, loss, refusal rate, …). Each is
 * `{name, value, unit, budget, op, ok}`; the harness recomputes `ok` from value/op/budget and refuses a row whose own
 * `ok` disagrees, so a secondary can never be waved through. Any `ok:false` makes the row MISSES.
 */
export function checkSecondary(list, key = 'secondary') {
  if (list === undefined || list === null) {
    return []
  }
  if (!Array.isArray(list)) {
    throw new HarnessError(`extra.${key} must be an array`)
  }
  return list.map((s, i) => {
    const at = `extra.${key}[${i}]`
    if (!s || typeof s.name !== 'string' || !s.name || typeof s.unit !== 'string') {
      throw new HarnessError(`${at} needs {name, value, unit, budget, op, ok}`)
    }
    if (!Number.isFinite(s.value) || !Number.isFinite(s.budget) || !['<=', '>='].includes(s.op)) {
      throw new HarnessError(`${at} (${s.name}): value and budget must be finite numbers and op '<=' or '>='`)
    }
    const ok = s.op === '<=' ? s.value <= s.budget : s.value >= s.budget
    if (typeof s.ok !== 'boolean' || s.ok !== ok) {
      throw new HarnessError(`${at} (${s.name}): ok=${s.ok} contradicts ${s.value} ${s.op} ${s.budget}`)
    }
    const deficit = s.op === '<=' ? s.value - s.budget : s.budget - s.value
    const reason = typeof s.reason === 'string' ? { reason: s.reason } : {}
    return { name: s.name, value: s.value, unit: s.unit, budget: s.budget, op: s.op, ok, deficit, ...reason }
  })
}

const finiteSamples = xs => Array.isArray(xs) && xs.length >= 3 && xs.every(Number.isFinite)

/**
 * A row's negative control(s): one object or an array. Each carries a numeric `value`, `threshold` and `op`; the
 * harness recomputes `ok`, and for a sensitivity control with `base`/`variant` samples (n >= 3 each side) it also
 * recomputes `value` as median(variant) - median(base). A control may add `checks[]` ({name, value, threshold, op,
 * ok}), further assertions it must ALSO pass: each is recomputed, and the control's `ok` must be its own comparison
 * AND every check. A control that cannot be recomputed is refused.
 */
export function checkControls(raw) {
  const list = Array.isArray(raw) ? raw : [raw]
  if (!list.length) {
    throw new HarnessError('control() returned no control')
  }
  return list.map((c, i) => {
    const at = `control[${i}]`
    if (!c || typeof c.name !== 'string' || typeof c.expected !== 'string' || typeof c.observed !== 'string') {
      throw new HarnessError(`${at} needs {name, expected, observed, value, threshold, op, ok}`)
    }
    if (!Number.isFinite(c.value) || !Number.isFinite(c.threshold) || !['<=', '>='].includes(c.op)) {
      throw new HarnessError(`${at} (${c.name}): value and threshold must be finite numbers and op '<=' or '>='`)
    }
    const samples = {}
    if (c.base !== undefined || c.variant !== undefined) {
      if (!finiteSamples(c.base) || !finiteSamples(c.variant) || c.base === c.variant) {
        throw new HarnessError(`${at} (${c.name}): base and variant must be distinct arrays of n >= 3 finite samples`)
      }
      const delta = median(c.variant) - median(c.base)
      if (Math.abs(delta - c.value) > 1e-9 * Math.max(1, Math.abs(delta))) {
        throw new HarnessError(`${at} (${c.name}): value ${c.value} != median(variant) - median(base) = ${delta}`)
      }
      Object.assign(samples, { base: c.base, variant: c.variant })
    }
    const holds = x => (x.op === '<=' ? x.value <= x.threshold : x.value >= x.threshold)
    if (c.checks !== undefined && !Array.isArray(c.checks)) {
      throw new HarnessError(`${at} (${c.name}): checks must be an array`)
    }
    const checks = (c.checks ?? []).map((k, j) => {
      if (
        !k ||
        typeof k.name !== 'string' ||
        !Number.isFinite(k.value) ||
        !Number.isFinite(k.threshold) ||
        !['<=', '>='].includes(k.op)
      ) {
        throw new HarnessError(`${at}.checks[${j}] needs {name, value, threshold, op '<=' or '>=', ok}`)
      }
      if (typeof k.ok !== 'boolean' || k.ok !== holds(k)) {
        throw new HarnessError(
          `${at}.checks[${j}] (${k.name}): ok=${k.ok} contradicts ${k.value} ${k.op} ${k.threshold}`
        )
      }
      return { name: k.name, value: k.value, threshold: k.threshold, op: k.op, ok: k.ok }
    })
    const ok = holds(c) && checks.every(k => k.ok)
    if (typeof c.ok !== 'boolean' || c.ok !== ok) {
      throw new HarnessError(
        `${at} (${c.name}): ok=${c.ok} contradicts ${c.value} ${c.op} ${c.threshold}` +
          `${checks.length ? ` and ${checks.filter(k => k.ok).length}/${checks.length} check(s) holding` : ''}`
      )
    }
    const { name, expected, observed, value, threshold, op } = c
    // `detail`: anything the control measured besides its samples (parts, waits), carried as-is.
    return {
      name,
      expected,
      observed,
      value,
      threshold,
      op,
      ok,
      ...samples,
      ...(checks.length ? { checks } : {}),
      ...(c.detail === undefined ? {} : { detail: c.detail })
    }
  })
}

const fmtNum = v => +v.toPrecision(4)

/**
 * The table's decision. Unclean numbers decide nothing; a miss is a candidate for a native port only when CPU-bound.
 * The class is the one the row measured (`extra.miss`), else the one it declared; a measured cause is named.
 */
export function decide(row, base) {
  if (base.verdict === 'UNMEASURABLE') {
    return '—'
  }
  if (base.verdict === 'INVALID') {
    return `not counted (invalid: ${base.invalid_reason})`
  }
  if (base.unclean) {
    return `repeat (unclean: ${base.unclean_reason})`
  }
  if (base.verdict === 'MEETS') {
    return `stays in ${row.lang} (${row.budget.stat} ${fmtNum(base.measured)} ${row.unit})`
  }
  if (base.verdict !== 'MISSES') {
    return 'not judged'
  }
  const misses = [
    ...(base.deficit > 0 ? [`${row.budget.stat} +${fmtNum(base.deficit)} ${row.unit}`] : []),
    ...base.secondary
      .filter(s => !s.ok)
      .map(s => `${s.name} ${fmtNum(s.value)} ${s.unit} vs ${s.op} ${s.budget} (+${fmtNum(s.deficit)})`)
  ].join('; ')
  const cls = base.miss_class ?? row.miss_class
  const cause = base.miss_cause ? `; cause: ${base.miss_cause}` : ''
  if (cls === 'unattributed') {
    // No stage is attributable: neither a port nor an in-place fix is named until the time can be attributed.
    return `not classed (unattributed): ${misses}${cause}`
  }
  return cls === 'cpu'
    ? `candidate for a native port (cpu deficit: ${misses}${cause})`
    : `fix in place (${cls}): ${misses}${cause}`
}

const COOLDOWN_POLL_S = 10

/**
 * Before a row measures: poll the 1-minute load every `pollS` until it is under LOAD_CLEAN_MAX, for at most `maxS`
 * (then the row runs anyway and is marked unclean). `loadFn`, `sleep` and `now` are seams for the tests.
 * Returns `{ waited_s, capped, max_s, load_at_start }`; an abort ends the wait.
 */
export async function coolDown({
  maxS = 600,
  pollS = COOLDOWN_POLL_S,
  loadFn = load,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now
} = {}) {
  const t0 = now()
  let sample = loadFn()
  while (sample.one >= LOAD_CLEAN_MAX && !live.aborting && now() - t0 < maxS * 1000) {
    await sleep(Math.min(pollS * 1000, maxS * 1000 - (now() - t0)))
    sample = loadFn()
  }
  return {
    waited_s: Math.round((now() - t0) / 1000),
    capped: sample.one >= LOAD_CLEAN_MAX,
    max_s: maxS,
    load_at_start: sample
  }
}

async function runRow(row, opts, python) {
  // `opts.loadFn` is a seam for the tests (a fake load source); a real run samples the 1-minute load average.
  const loadFn = opts.loadFn ?? load
  const minN = row.min_n ?? (opts.mode === 'full' ? 5 : 2)
  const scratch = await mkdtemp(join(os.tmpdir(), `bench-${row.id}-`))
  live.scratches.add(scratch)
  const log = (...args) => process.stderr.write(`[${row.id}] ${args.join(' ')}\n`)
  const scratchEnv = scratchEnvFor(scratch)
  // A Set: renew() repeats the same reason (e.g. no lock tool) once per part; the table carries it once.
  const reasons = new Set()
  const windows = []
  let window = { held: false, who: `bench:${row.id}`, reason: null }
  // The load is sampled again the moment a window is held, immediately before the row (or a part) measures: the
  // acquire can wait minutes after the cool-down, and anything that started in that gap makes the measure unclean.
  const takeWindow = async (label, where) => {
    window = await acquireWindow(label)
    live.window = window
    const loadAtAcquire = loadFn()
    const clean = loadIsClean(loadAtAcquire)
    windows.push({ who: window.who, held: window.held, load_at_acquire: loadAtAcquire, clean })
    if (window.reason) {
      reasons.add(window.reason)
    }
    if (!clean) {
      reasons.add(`load ${loadAtAcquire.one} >= ${LOAD_CLEAN_MAX} at ${where} (sampled after the window was acquired)`)
    }
    return { held: window.held, reason: window.reason, load_at_acquire: loadAtAcquire, clean }
  }
  const endWindow = async () => {
    const rel = await releaseWindow(window)
    if (rel.overheld) {
      reasons.add(`window ${window.who} overheld (${rel.held_s} s > its --max)`)
    }
  }
  const ctx = {
    mode: opts.mode,
    app: opts.app,
    scratch,
    keep: opts.keep,
    log,
    scratchEnv,
    sh: (cmd, args, o = {}) => run(cmd, args, { cwd: opts.app, env: scratchEnv(), ...o }),
    python: Object.assign((args, o = {}) => run(python, args, { cwd: opts.app, env: scratchEnv(), ...o }), {
      path: python
    }),
    window: {
      get held() {
        return window.held
      },
      /**
       * Release the current window and take a fresh one (each hold <= 900 s), immediately before the next part
       * measures; returns `{ held, reason, load_at_acquire, clean }`. A part that starts loaded makes the row unclean.
       */
      async renew(label = `bench:${row.id}`) {
        await endWindow()
        return takeWindow(label, `the start of ${label}`)
      }
    },
    /**
     * A per-sample cool-down for rows that ask for one: release the window (waiting never holds it), poll the 1-minute
     * load until it is under LOAD_CLEAN_MAX for at most `maxS` (capped by --cooldown-max), then take a fresh window
     * if one was held. A wait that hits the cap marks the row unclean. Returns `{ before, waited_s, capped, max_s,
     * load_at_start }` for the row to record.
     */
    async coolDown(label, { maxS = 180 } = {}) {
      const held = window.held
      if (held) {
        await endWindow()
      }
      const cool = await coolDown({ maxS: Math.min(maxS, opts.cooldownMax ?? maxS), loadFn })
      if (cool.capped) {
        reasons.add(
          `load ${cool.load_at_start.one} still >= ${LOAD_CLEAN_MAX} after the ${cool.max_s} s cool-down before ${label}`
        )
      }
      if (held) {
        await takeWindow(`bench:${row.id} ${label}`, `the start of ${label}`)
      }
      return { before: label, ...cool }
    }
  }
  const base = {
    id: row.id,
    part: row.part,
    what: row.what,
    hot_path: row.hot_path,
    unit: row.unit,
    lang: row.lang,
    miss_class: row.miss_class,
    budget: row.budget,
    risk: row.risk,
    failure_mode: row.failure_mode,
    min_n: minN,
    cold: null,
    warm: null,
    measured: null,
    deficit: null,
    verdict: 'ERROR',
    decision: '—',
    control: null,
    extra: null,
    secondary: [],
    unclean: false,
    unclean_reason: null,
    error: null
  }
  const t0 = Date.now()
  const survivorsAtStart = live.survivors.size
  // A statically unmeasurable row measures nothing: no cool-down.
  const cool = row.unmeasurable ? null : await coolDown({ maxS: opts.cooldownMax ?? 600, loadFn })
  if (cool) {
    base.cooldown = { waited_s: cool.waited_s, capped: cool.capped, max_s: cool.max_s }
    if (cool.capped) {
      reasons.add(`load ${cool.load_at_start.one} still >= ${LOAD_CLEAN_MAX} after the ${cool.max_s} s cool-down`)
    }
  }
  const before = cool?.load_at_start ?? loadFn()
  // before: at the end of the cool-down (before the acquire); at_measure: once the window is held, as measuring starts.
  base.load = { before, at_measure: null, after: null }
  if (!loadIsClean(before)) {
    reasons.add(`load ${before.one} >= ${LOAD_CLEAN_MAX} at start`)
  }
  const summaryOpts = label => ({
    minN,
    label: `${row.id} ${label}`,
    allowNonpositive: row.allow_nonpositive !== undefined
  })
  try {
    if (row.unmeasurable) {
      // Statically unmeasurable: no window, no measure, no control, in every mode (--control-only included).
      Object.assign(base, { verdict: 'UNMEASURABLE', unmeasurable: row.unmeasurable })
      base.control = [{ skipped: 'row unmeasurable', name: '-', expected: '-', observed: '-', ok: true }]
    } else {
      // Inside the try: a lock tool that cannot spawn still reaches `finally`, which removes the scratch.
      base.load.at_measure = (await takeWindow(`bench:${row.id}`, 'measure start')).load_at_acquire
      if (!opts.controlOnly) {
        const out = await row.measure(ctx)
        if (out?.unmeasurable) {
          Object.assign(base, { verdict: 'UNMEASURABLE', unmeasurable: String(out.unmeasurable) })
          base.extra = out?.extra ?? null
        } else {
          base.extra = out?.extra ?? null
          base.cold = summarize(out?.cold, summaryOpts('cold'))
          base.warm = out?.warm === undefined || out?.warm === null ? null : summarize(out.warm, summaryOpts('warm'))
          const verdict = judge(row.budget, { cold: base.cold, warm: base.warm })
          base.secondary = checkSecondary(out?.extra?.secondary)
          // A row's validity guard (`extra.validity[]`, same shape): one broken check and the run does not count.
          base.validity = checkSecondary(out?.extra?.validity, 'validity')
          // A row may classify its own miss from what it measured (`extra.miss: { class, cause }`); the declared
          // miss_class is then only the expectation.
          const miss = out?.extra?.miss
          if (miss !== undefined) {
            if (
              !miss ||
              !MEASURED_MISS_CLASSES.includes(miss.class) ||
              typeof miss.cause !== 'string' ||
              !miss.cause.trim()
            ) {
              throw new HarnessError(
                `extra.miss must be { class: ${MEASURED_MISS_CLASSES.join(' | ')}, cause: '<words>' }`
              )
            }
            base.miss_class = miss.class
            base.miss_cause = miss.cause
          }
          base.measured = verdict.measured
          base.deficit = verdict.deficit
          const broken = base.validity.filter(v => !v.ok)
          if (broken.length) {
            base.verdict = 'INVALID'
            base.invalid_reason = broken.map(v => `${v.name} ${v.value} vs ${v.op} ${v.budget}`).join('; ')
          } else {
            base.verdict = verdict.meets && base.secondary.every(s => s.ok) ? 'MEETS' : 'MISSES'
          }
        }
      }
      if (base.verdict !== 'UNMEASURABLE') {
        base.control = checkControls(await row.control(ctx))
        if (opts.controlOnly) {
          base.verdict = 'UNMEASURABLE'
          base.unmeasurable = 'control-only run'
        }
      } else {
        base.control = [
          { skipped: 'row unmeasurable on this machine', name: '-', expected: '-', observed: '-', ok: true }
        ]
      }
    }
  } catch (err) {
    base.verdict = 'ERROR'
    base.error = err instanceof HarnessError ? err.message : `${err?.name ?? 'Error'}: ${err?.message ?? err}`
    base.harness_error = true
  } finally {
    try {
      await endWindow()
    } catch (err) {
      base.verdict = 'ERROR'
      base.error = [base.error, err.message].filter(Boolean).join('; ')
      base.harness_error = true
      base.fatal = true
    }
    live.window = null
    if (live.survivors.size > survivorsAtStart) {
      // A process group of this row outlived SIGKILL: never remove a scratch under a live tree.
      base.scratch_kept = scratch
      log(`a process group survived SIGKILL; scratch kept: ${scratch}`)
    } else if (opts.keep) {
      base.scratch_kept = scratch
      log(`scratch kept: ${scratch}`)
    } else {
      await rm(scratch, { recursive: true, force: true })
    }
    live.scratches.delete(scratch)
  }
  base.load.after = loadFn()
  base.windows = windows
  base.unclean = reasons.size > 0
  base.unclean_reason = [...reasons].join('; ') || null
  base.decision = base.verdict === 'ERROR' ? '—' : decide(row, base)
  base.duration_ms = Date.now() - t0
  return base
}

/**
 * Abort (SIGINT/SIGTERM of the runner), strictly in this order: refuse new children; SIGTERM every live group and
 * an in-flight lock acquire, wait (signal 0) up to 3 s, SIGKILL what is left and wait again; only then release the
 * window (and, after an acquire was cut, release by its name in case it wrote the lock); only then remove the
 * scratch directories (unless --keep), and never one whose tree survived. Resolves when all of it is done.
 */
export async function abortRun() {
  live.aborting = true
  const acquiring = live.acquiring
  const groups = [...live.groups, ...(acquiring?.pgid ? [acquiring.pgid] : [])]
  const results = await Promise.all(groups.map(pgid => reapGroup(pgid, ABORT_GRACE_MS)))
  const survivors = groups.filter((_, i) => !results[i])
  if (live.window?.held) {
    try {
      await releaseWindow(live.window)
    } catch (err) {
      process.stderr.write(`[bench] abort: ${err.message}\n`)
    }
  }
  if (acquiring && process.env.BENCH_GPU_LOCK) {
    // "no lock" (exit 0) and "held by another" (exit 5) both leave someone else's window alone.
    const res = await gpuLock(['release', '--who', acquiring.who])
    process.stderr.write(`[bench] abort: release --who ${acquiring.who} after a cut acquire: exit ${res.code}\n`)
  }
  if (survivors.length) {
    process.stderr.write(`[bench] abort: group(s) ${survivors.join(', ')} survived SIGKILL; scratch kept\n`)
    return { survivors }
  }
  if (!live.keep) {
    for (const dir of live.scratches) {
      // The row's own `finally` may be removing it at the same time.
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    }
  }
  return { survivors }
}

/** How the interpreter was chosen, without the checkout's location (the JSON must not map the owner's folders). */
function interpreterSource(app, python) {
  if (process.env.BENCH_PYTHON) {
    return 'BENCH_PYTHON'
  }
  return python === join(app, 'venv', 'bin', 'python') ? 'checkout venv (venv/bin/python)' : 'python3 on PATH'
}

function stamp(date) {
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`
}

/** `path` with symlinks resolved as far as it exists (the rest appended), so a link cannot hide where it points. */
function realPath(path) {
  let head = resolve(path)
  const rest = []
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(basename(head))
    head = dirname(head)
  }
  return join(realpathSync(head), ...rest)
}

/**
 * Results never go inside the repository checkout: they would be committed, and the checkout is what is measured.
 * `source` names where the directory came from (--out or BENCH_OUT_ROOT) for the error.
 */
export function refuseOutInsideCheckout(outDir, checkout, source) {
  const rel = relative(realPath(checkout), realPath(outDir))
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new HarnessError(
      `${source} resolves inside the repository checkout (${rel || '.'} under it); results must be written outside ` +
        'the checkout: pass --out <dir> or set BENCH_OUT_ROOT to a directory outside it'
    )
  }
}

/**
 * Run the selected rows; returns `{ doc, exitCode, outDir }`. With `opts.checkout` (the CLI always passes it), an
 * --out or BENCH_OUT_ROOT inside that checkout is refused before anything runs.
 */
export async function runBench(opts) {
  if (opts.checkout) {
    if (opts.out) {
      refuseOutInsideCheckout(opts.out, opts.checkout, '--out')
    } else if (process.env.BENCH_OUT_ROOT) {
      refuseOutInsideCheckout(process.env.BENCH_OUT_ROOT, opts.checkout, 'BENCH_OUT_ROOT')
    }
  }
  const app = resolve(opts.app)
  const python = resolvePython(app)
  const env = captureEnv(app, python)
  env.python_interpreter = interpreterSource(app, python)
  env.python_interpreter_sha256 = interpreterDigest(python)
  const started = new Date()
  const rows = await discoverRows(opts.rowsDir, opts.only)
  live.keep = Boolean(opts.keep)
  const results = []
  for (const row of rows) {
    if (live.aborting) {
      break
    }
    process.stderr.write(`[bench] ${row.id} (${opts.mode}${opts.controlOnly ? ', control only' : ''})\n`)
    const result = await runRow(row, { ...opts, app }, python)
    results.push(result)
    if (result.fatal) {
      process.stderr.write('[bench] stopping: the exclusive window could not be released\n')
      break
    }
  }
  env.load.after = load()
  const controlFailed = results.some(r => r.control?.some(c => c.ok === false))
  const harnessFailed = results.some(r => r.harness_error)
  const exitCode = controlFailed ? EXIT.INVALID : harnessFailed ? EXIT.HARNESS : EXIT.OK
  const doc = redact({
    schema: SCHEMA,
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    mode: opts.mode,
    control_only: Boolean(opts.controlOnly),
    status: controlFailed ? 'invalid' : harnessFailed ? 'harness-error' : 'valid',
    exit_code: exitCode,
    clean_rows: results.filter(r => !r.unclean).length,
    invalid_rows: results.filter(r => r.verdict === 'INVALID').length,
    rows_total: results.length,
    env,
    rows: results.map(r =>
      Object.fromEntries(Object.entries(r).filter(([key]) => !['harness_error', 'fatal'].includes(key)))
    )
  })
  validateResult(doc)
  const text = JSON.stringify(doc, null, 2)
  const leaked = identityStrings().filter(s => text.includes(s))
  if (leaked.length) {
    throw new HarnessError(`refusing to write results: ${leaked.length} identity string(s) survived redaction`)
  }
  const outDir =
    opts.out ??
    join(
      process.env.BENCH_OUT_ROOT ?? join(os.tmpdir(), 'iclone-bench'),
      `${stamp(started)}-${env.git_sha.slice(0, 10)}`
    )
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'results.json'), text + '\n')
  await writeFile(join(outDir, 'table.md'), renderTable(doc))
  return { doc, exitCode, outDir }
}
