// Row gates.suite: wall clock of one complete gate test suite: the desktop vitest projects (electron, ui) and the
// Python core suites the gates run (tests/pm + tests/hermes_cli through scripts/run_tests.sh, on the pinned CPython).
// Everything runs in one throwaway APFS clone of the checkout, under a scratch HOME/HERMES_HOME/TMPDIR.
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HarnessError, median } from '../lib/stats.mjs'

// One part (electron, ui or python) of one sample runs inside one exclusive window; gpu_lock clamps a window at 900 s.
const PART_MS = 14 * 60 * 1000
const CONTROL_DELAY_MS = 3000
const CONTROL_N = 3
// A small file of the electron project with no fixtures: the control times the same command on a subset.
const CONTROL_FILE = 'scripts/runtime-artifact.test.mjs'
const PLUGIN = fileURLToPath(new URL('../lib/pytest_exact_deselect.py', import.meta.url))
// The one file the gates leave out of the core suites: it does not collect at the base they run on.
const NOT_COLLECTED = 'tests/hermes_cli/test_completion_backlog.py'
// The exact listing scripts/run_tests.sh feeds to its byte-compile step (`git ls-files '*.py' ':(exclude)iclone/**'`).
const COMPILE_PATHSPEC = ['*.py', ':(exclude)iclone/**']
// Electron failures also seen on main: used to label failures in the report and to set apart files that error on main.
const KNOWN_ELECTRON = fileURLToPath(new URL('../known_failures/gates.suite.electron.txt', import.meta.url))
const ID_SEP = ' :: '
// The pinned run's counts per part (see the file's header): a valid run collects and passes FLOOR_SHARE of each.
const FLOORS = fileURLToPath(new URL('../baselines/gates.suite.collected.tsv', import.meta.url))
const FLOOR_SHARE = 0.98
const SUITE_PARTS = ['electron', 'ui', 'python']
// How many failing ids a part carries into results.json; the full list is written to the row scratch (keep it: --keep).
const SHOWN_IDS = 50
// vitest assertion statuses of a test the run reached (passed, failed, or skipped / todo by the run itself).
const REACHED = new Set(['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled'])

const clones = new Map()
const sq = s => `'${s.replaceAll("'", "'\\''")}'`
const tail = (s, n = 3) => s.trim().split('\n').slice(-n).join(' | ')

async function git(ctx, args) {
  const res = await ctx.sh('git', args, { cwd: ctx.app, env: ctx.scratchEnv({ GIT_OPTIONAL_LOCKS: '0' }) })
  if (res.code !== 0) {
    throw new HarnessError(`git ${args[0]} in the checkout failed (exit ${res.code}): ${tail(res.stderr, 1)}`)
  }
  return res.stdout.split('\n').filter(Boolean)
}

/**
 * The throwaway clone every part runs in. `cp -c -R` keeps symlinks as symlinks, so a worktree whose
 * `apps/desktop/node_modules` points at a shared tree would write vitest's cache (`<nearest package>/node_modules/.vite`)
 * there: that link becomes a real directory of per-entry links, `.vite` left out, so the cache lands in the clone.
 * The clone's `.git` (a pointer into the real worktree's gitdir) is removed; a `git` shim first on PATH answers
 * run_tests.sh's byte-compile listing from a list exported once from the checkout, and sends every other call to the
 * real git with GIT_CEILING_DIRECTORIES at the row scratch, so no git command inside the clone reaches a repository.
 */
async function cloneSetup(ctx) {
  if (clones.has(ctx.scratch)) {
    return clones.get(ctx.scratch)
  }
  const wt = join(ctx.scratch, 'wt')
  rmSync(wt, { recursive: true, force: true })
  const cp = await ctx.sh('cp', ['-c', '-R', ctx.app, wt])
  if (cp.code !== 0) {
    throw new HarnessError(`cp -c -R of the checkout failed: ${tail(cp.stderr, 1)}`)
  }
  rmSync(join(wt, '.git'), { recursive: true, force: true })
  const nm = join(wt, 'apps', 'desktop', 'node_modules')
  if (lstatSync(nm).isSymbolicLink()) {
    const shared = realpathSync(join(ctx.app, 'apps', 'desktop', 'node_modules'))
    unlinkSync(nm)
    mkdirSync(nm)
    for (const name of readdirSync(shared).filter(n => n !== '.vite')) {
      symlinkSync(join(shared, name), join(nm, name))
    }
  }
  const realWt = realpathSync(wt)
  const compileList = join(ctx.scratch, 'compile_files.txt')
  writeFileSync(compileList, (await git(ctx, ['ls-files', ...COMPILE_PATHSPEC])).join('\n') + '\n')
  const which = await ctx.sh('/bin/sh', ['-c', 'command -v git'])
  const bin = join(ctx.scratch, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'git'),
    [
      '#!/bin/bash',
      `if [[ "$(pwd -P)" == ${sq(realWt)} && "$*" == ${sq(['ls-files', ...COMPILE_PATHSPEC].join(' '))} ]]; then`,
      `  exec /bin/cat ${sq(compileList)}`,
      'fi',
      `export GIT_CEILING_DIRECTORIES=${sq(realpathSync(ctx.scratch))}`,
      `exec ${sq(which.stdout.trim())} "$@"`,
      ''
    ].join('\n')
  )
  chmodSync(join(bin, 'git'), 0o755)
  const clone = { wt, nm, bin, vitest: join(wt, 'node_modules', '.bin', 'vitest') }
  if (existsSync(join(nm, '.bin', 'vitest'))) {
    clone.vitest = join(nm, '.bin', 'vitest')
  }
  clones.set(ctx.scratch, clone)
  return clone
}

/**
 * The pre-existing failure list: `<file> :: <fullName>` entries are single tests, a bare `<file>` is a file that fails
 * before any test runs. Paths relative to apps/desktop; `#` lines are comments.
 */
export function parseKnownFailures(text) {
  const tests = new Set()
  const files = new Set()
  for (const line of text.split('\n')) {
    const entry = line.trim()
    if (!entry || entry.startsWith('#')) {
      continue
    }
    ;(entry.includes(ID_SEP) ? tests : files).add(entry)
  }
  return { tests, files }
}

export function loadKnownElectron() {
  return {
    source: 'bench/known_failures/gates.suite.electron.txt',
    ...parseKnownFailures(readFileSync(KNOWN_ELECTRON, 'utf8'))
  }
}

/**
 * The pinned counts: a `#` header, a `part\tcollected\tpassed\t…` title line, one `<part>\t<collected>\t<passed>\t…`
 * line per part, and `errored_known\t<file>` lines (electron files that errored in the pinned run and on main too: the
 * only files the errored-files guard sets apart). Each floor is FLOOR_SHARE of its pinned count, rounded down; a part
 * without a collected or passed count is a harness error.
 */
export function parseSuiteFloors(text) {
  const counts = {}
  const erroredKnown = new Set()
  for (const line of text.split('\n')) {
    const [key, a, b] = line.trim().split('\t')
    if (!key || key.startsWith('#') || key === 'part') {
      continue
    }
    if (key === 'errored_known') {
      erroredKnown.add(a)
    } else {
      counts[key] = { collected: Number(a), passed: Number(b) }
    }
  }
  const floor = (part, what) => {
    const pinned = counts[part]?.[what]
    if (!Number.isInteger(pinned) || pinned < 1) {
      throw new HarnessError(`gates.suite floors: no ${what} count for the ${part} part`)
    }
    return { pinned, floor: Math.floor(pinned * FLOOR_SHARE) }
  }
  return {
    parts: Object.fromEntries(
      SUITE_PARTS.map(part => [part, { collected: floor(part, 'collected'), passed: floor(part, 'passed') }])
    ),
    erroredKnown
  }
}

export function loadSuiteFloors() {
  return { source: 'bench/baselines/gates.suite.collected.tsv', ...parseSuiteFloors(readFileSync(FLOORS, 'utf8')) }
}

async function vitest(ctx, clone, label, project, files = [], env = {}, known = null) {
  const report = join(ctx.scratch, `${label}.json`)
  rmSync(report, { force: true })
  const res = await ctx.sh(
    clone.vitest,
    ['run', '--project', project, '--reporter=json', `--outputFile=${report}`, ...files],
    {
      cwd: join(clone.wt, 'apps', 'desktop'),
      env: ctx.scratchEnv({ CI: '1', ICLONE_PERF: '0', NODE_OPTIONS: '', ...env }),
      timeoutMs: PART_MS
    }
  )
  if (res.ms >= PART_MS) {
    throw new HarnessError(`vitest ${label} hit the ${PART_MS / 60000}-minute part timeout (one exclusive window)`)
  }
  if (!existsSync(report)) {
    throw new HarnessError(`vitest wrote no report (exit ${res.code}): ${tail(res.stderr)}`)
  }
  return { ms: res.ms, exit: res.code, ...vitestCounts(JSON.parse(readFileSync(report, 'utf8')), res.code, known) }
}

/**
 * Counts from a vitest JSON report (the runner's own structured report). `collected` = numTotalTests; `executed` =
 * tests whose assertion status says the run reached them (REACHED); `passed` = numPassedTests. `failed` counts every
 * failed test: failures are reported, not judged by name. `errors` = files that failed without a failed test (import /
 * transform / setup errors) and are not set apart by `known.files`, plus 1 for a non-zero exit that nothing else
 * explains; `errors_known` = errored files that `known.files` sets apart. `failing` = every failing id
 * (`<file> :: <fullName>`, or the bare file for an errored file); `on_known_list` = how many of them `known` lists.
 */
export function vitestCounts(report, exit, known = null) {
  const failing = []
  let failedTests = 0
  let loadErrors = 0
  let knownFiles = 0
  let onList = 0
  let executed = 0
  for (const f of report.testResults ?? []) {
    executed += (f.assertionResults ?? []).filter(a => REACHED.has(a.status)).length
    const rel = String(f.name ?? '').replace(/^.*?\/apps\/desktop\//, '')
    const bad = (f.assertionResults ?? []).filter(a => a.status === 'failed')
    if (f.status === 'failed' && !bad.length) {
      loadErrors++
      failing.push(rel)
      if (known?.files.has(rel)) {
        knownFiles++
        onList++
      }
    }
    for (const a of bad) {
      failedTests++
      const id = `${rel}${ID_SEP}${a.fullName}`
      failing.push(id)
      if (known?.tests.has(id)) {
        onList++
      }
    }
  }
  const failed = Math.max(report.numFailedTests ?? 0, failedTests)
  return {
    files: report.numTotalTestSuites ?? 0,
    collected: report.numTotalTests ?? 0,
    executed,
    passed: report.numPassedTests ?? 0,
    failed,
    errors: loadErrors - knownFiles + (exit !== 0 && !failed && !loadErrors ? 1 : 0),
    errors_known: knownFiles,
    on_known_list: onList,
    failing,
    skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0)
  }
}

/**
 * What only scripts/run_tests_parallel.py's printed output carries: its error sections (files where no tests ran,
 * where the interpreter crashed, where all passed but pytest exited non-zero) as `errors`, plus 1 for a non-zero exit
 * that nothing else explains; `failing` = the node ids of pytest's `FAILED` / `ERROR` summary lines; `summary` = the
 * `=== Summary:` counts, kept for reading only (the counts the guard uses come from pytestStats). null when there is
 * no summary line.
 */
export function pythonCounts(out, exit) {
  const lines = out.split('\n')
  const summary = lines.find(l => l.startsWith('=== Summary:'))
  if (!summary) {
    return null
  }
  const count = re => Number((summary.match(re) ?? [])[1] ?? 0)
  const failed = count(/(\d+) failed/)
  const section =
    /^=== (\d+) files? where (?:no tests ran|the interpreter CRASHED|all tests passed but pytest exited non-zero)/
  const errored = lines.reduce((n, l) => n + Number((l.match(section) ?? [])[1] ?? 0), 0)
  const failing = [...new Set(lines.map(l => l.match(/^(?:FAILED|ERROR) (.+?)(?: - .*)?$/)?.[1]).filter(Boolean))]
  return {
    errors: errored + (exit !== 0 && !failed && !errored ? 1 : 0),
    failing,
    summary: { passed: count(/(\d+) tests passed/), failed, skipped: count(/(\d+) skipped/) }
  }
}

/**
 * Counts from the pytest plugin's records (one JSON line per pytest process: `collected` after collection and
 * deselection, `finished` with per-test outcomes at session end). A process that collected and never finished (killed,
 * crashed, timed out) adds collected tests and no executed ones. A test whose setup failed is failed, one skipped at
 * setup is skipped, one whose teardown failed is failed.
 */
export function pytestStats(text) {
  const out = { collected: 0, executed: 0, passed: 0, failed: 0, skipped: 0, processes: 0, finished: 0 }
  for (const line of text.split('\n').filter(l => l.trim())) {
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      throw new HarnessError(`unreadable pytest plugin record: ${line.slice(0, 80)}`)
    }
    if (rec.kind === 'collected') {
      out.processes++
      out.collected += rec.n
    } else if (rec.kind === 'finished') {
      out.finished++
      out.passed += rec.passed
      out.failed += rec.failed
      out.skipped += rec.skipped
      out.executed += rec.passed + rec.failed + rec.skipped
    }
  }
  return out
}

/**
 * The guard that decides whether a gates.suite run counts at all: any `ok:false` makes the row INVALID, never MISSES.
 * The row times the suites, so what can fake a fast run is a run that ran less: a file that errors at import (none of
 * its tests run), a run cut short (fewer executed than collected), a suite that collects fewer tests, and tests that
 * fail or skip before their body runs (collected and executed, but not passed). So, per part, on the worse of cold
 * and warm: 0 errored files (only electron files that errored in the pinned run and on main too are set apart),
 * executed == collected, collected and passed each at least FLOOR_SHARE of the pinned run's count; and cold and warm
 * collect the same counts. The counts come from each runner's own structured report, never from its printed text.
 */
export function suiteValidity(runs, floors) {
  const errors = runs.reduce((n, r) => n + SUITE_PARTS.reduce((m, k) => m + r[k].errors, 0), 0)
  const drift = SUITE_PARTS.reduce((n, k) => n + Math.abs(runs[0][k].collected - runs[1][k].collected), 0)
  const pct = FLOOR_SHARE * 100
  const atLeast = (name, value, { pinned, floor }, reason) => ({
    name,
    value,
    unit: 'tests',
    budget: floor,
    op: '>=',
    ok: value >= floor,
    reason: `${pct} % of the ${pinned} in the pinned run (${floors.source}): ${reason}`
  })
  return [
    {
      name: 'test files errored (load / collection errors, crashes, unexplained non-zero exit)',
      value: errors,
      unit: 'files',
      budget: 0,
      op: '<=',
      ok: errors <= 0,
      reason:
        'a file that errors at import runs none of its tests; only electron files that errored in the pinned run ' +
        'and on main too are set apart'
    },
    ...SUITE_PARTS.flatMap(k => {
      const short = Math.max(...runs.map(r => r[k].collected - r[k].executed))
      return [
        {
          name: `${k}: tests collected but not executed (more of cold and warm)`,
          value: short,
          unit: 'tests',
          budget: 0,
          op: '<=',
          ok: short <= 0,
          reason: 'a run cut short (killed, crashed, timed out) executes fewer tests than it collected'
        },
        atLeast(
          `${k}: tests collected (fewer of cold and warm)`,
          Math.min(...runs.map(r => r[k].collected)),
          floors.parts[k].collected,
          'fewer tests take less time'
        ),
        atLeast(
          `${k}: tests passed (fewer of cold and warm)`,
          Math.min(...runs.map(r => r[k].passed)),
          floors.parts[k].passed,
          'a test that fails or skips before its body runs shortens the suite'
        )
      ]
    }),
    {
      name: 'tests collected, cold minus warm (absolute, summed over the parts)',
      value: drift,
      unit: 'tests',
      budget: 0,
      op: '<=',
      ok: drift <= 0,
      reason: 'cold and warm run the same files in the same clone; a different count means they ran different suites'
    }
  ]
}

/** One part's failures for results.json: the count, the first SHOWN_IDS ids; the full list goes to the row scratch. */
export function failureReport(scratch, label, part, counts) {
  const file = `${label}-${part}.failures.txt`
  writeFileSync(join(scratch, file), counts.failing.map(id => `${id}\n`).join(''))
  return {
    failed: counts.failed,
    on_known_list: counts.on_known_list ?? null,
    first_ids: counts.failing.slice(0, SHOWN_IDS),
    full_list: `${file} in the row scratch (kept with --keep)`
  }
}

async function pythonSetup(ctx, clone) {
  const probe = await ctx.python(['-c', 'import pytest, sys; print(sys.version.split()[0])'])
  if (probe.code !== 0) {
    return {
      unmeasurable: 'the bench interpreter (BENCH_PYTHON) cannot import pytest; set it to the pinned CPython test venv'
    }
  }
  copyFileSync(PLUGIN, join(clone.wt, 'bench_exact_deselect.py'))
  const files = (await git(ctx, ['ls-files', 'tests/pm', 'tests/hermes_cli'])).filter(
    f => /\/test_[^/]*\.py$/.test(f) && f !== NOT_COLLECTED
  )
  if (!files.length) {
    throw new HarnessError('no tests/pm or tests/hermes_cli test files tracked')
  }
  const list = join(ctx.scratch, 'core_files.txt')
  writeFileSync(list, files.join('\n') + '\n')
  const deselect = process.env.BENCH_PYTEST_DESELECT ?? ''
  const deselectText = deselect ? readFileSync(deselect, 'utf8') : ''
  // The list's digest, so two runs can be shown to have waived exactly the same node ids.
  const deselectSha256 = deselect ? createHash('sha256').update(deselectText).digest('hex') : null
  const waived = deselect ? deselectText.split('\n').filter(l => l.trim() && !l.startsWith('#')) : []
  const roots = join(ctx.scratch, 'module_roots.tsv')
  const stats = label => join(ctx.scratch, `${label}.pytest-stats.jsonl`)
  return {
    list,
    roots,
    stats,
    files: files.length,
    deselect,
    deselectSha256,
    waived: waived.length,
    python: probe.stdout.trim()
  }
}

async function pythonSuite(ctx, clone, py, label) {
  const rt = join(ctx.scratch, `${label}-rt`)
  rmSync(rt, { recursive: true, force: true })
  mkdirSync(rt, { recursive: true })
  const args = ['scripts/run_tests.sh', '--file-retries', '0', '--files-from', py.list, '--', '-pbench_exact_deselect']
  rmSync(py.stats(label), { force: true })
  args.push(`--bench-module-roots=${py.roots}`, `--bench-stats=${py.stats(label)}`)
  if (py.deselect) {
    args.push(`--bench-exact-deselect=${py.deselect}`)
  }
  const res = await ctx.sh('bash', args, {
    cwd: clone.wt,
    env: ctx.scratchEnv({
      HERMES_RUNTIME_DIR: rt,
      HERMES_PYTHON: ctx.python.path,
      PATH: `${clone.bin}:${process.env.PATH}`,
      LANG: 'en_US.UTF-8',
      GIT_OPTIONAL_LOCKS: '0'
    }),
    timeoutMs: PART_MS
  })
  if (res.ms >= PART_MS) {
    throw new HarnessError(`python ${label} hit the ${PART_MS / 60000}-minute part timeout (one exclusive window)`)
  }
  const out = res.stdout + res.stderr
  // The per-test failures live only in this output: keep it next to the vitest reports (read it with --keep).
  writeFileSync(join(ctx.scratch, `${label}.log`), out)
  const counts = pythonCounts(out, res.code)
  const last = (out.split('\n').find(l => l.startsWith('=== Summary:')) ?? tail(res.stdout, 4)).slice(-300)
  if (!counts) {
    throw new HarnessError(`python core suites printed no summary (exit ${res.code}): ${last}`)
  }
  const stats = pytestStats(existsSync(py.stats(label)) ? readFileSync(py.stats(label), 'utf8') : '')
  return {
    ms: res.ms,
    exit: res.code,
    ...counts,
    ...stats,
    compiled: out.includes('pre-compiling bytecode'),
    tail: last
  }
}

/**
 * HERMES_PYTHON is the interpreter of the real checkout (or BENCH_PYTHON); if its venv carries an editable install,
 * the tests could import `pm` / `hermes_cli` from that checkout. The pytest plugin records where they came from; any
 * origin outside the clone is a harness error.
 */
function moduleRootsUnder(file, wt) {
  const root = realpathSync(wt) + '/'
  const origins = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  if (!origins.length) {
    throw new HarnessError('the pytest plugin recorded no pm / hermes_cli origin')
  }
  const outside = origins.filter(l => !l.split('\t')[1]?.startsWith(root))
  if (outside.length) {
    throw new HarnessError(`python tests imported app code from outside the clone: ${outside[0].split('\t')[0]}`)
  }
  return 'clone (every pm / hermes_cli origin recorded by the pytest plugin is under the clone)'
}

async function completeSuite(ctx, clone, py, label, windows, known) {
  const part = async (name, run) => {
    windows.push({ phase: `${label}-${name}`, ...(await ctx.window.renew(`bench:gates.suite:${label}-${name}`)) })
    return run()
  }
  const electron = await part('electron', () => vitest(ctx, clone, `${label}-electron`, 'electron', [], {}, known))
  const ui = await part('ui', () => vitest(ctx, clone, `${label}-ui`, 'ui'))
  const python = await part('python', () => pythonSuite(ctx, clone, py, `${label}-python`))
  return { ms: electron.ms + ui.ms + python.ms, electron, ui, python }
}

export default {
  id: 'gates.suite',
  part: 'Gates/probes test harness',
  what:
    'Wall clock of one complete gate suite, all of it in one throwaway APFS clone (`cp -c -R`) of the checkout with ' +
    'HOME/HERMES_HOME/TMPDIR under the row scratch: `vitest run --project electron`, then `vitest run --project ui` ' +
    '(cwd <clone>/apps/desktop; a shared apps/desktop/node_modules link becomes a clone directory of per-package ' +
    'links without .vite, so the vitest cache is written in the clone and starts empty), then the Python core suites ' +
    'tests/pm + tests/hermes_cli through `scripts/run_tests.sh --file-retries 0` (cwd <clone>) on BENCH_PYTHON (the ' +
    "pinned CPython 3.14 test venv), the gates' known-failing node ids deselected exactly (BENCH_PYTEST_DESELECT). " +
    "The clone has no .git: its byte-compile step gets the checkout's `git ls-files '*.py' ':(exclude)iclone/**'` " +
    'list (exported once, read-only) from a `git` shim, so it compiles the same files as in a worktree; every other ' +
    'git call inside the run is fenced by GIT_CEILING_DIRECTORIES at the scratch and reaches no repository. Each ' +
    'part from spawn to exit, the sample is their sum; each part runs in its own exclusive window (renewed before ' +
    'it, part timeout 14 min under the 900 s window clamp). Samples: cold = the first suite (empty vitest cache, ' +
    'fresh clone), warm = the second, right after it. --quick and --full run the same complete suites. Failures are ' +
    'reported, not judged by name (per part and sample: the count, the first 50 ids, how many bench/known_failures ' +
    'lists, the full list in the row scratch). A validity guard decides whether the run counts at all; a run that ' +
    "breaks it is INVALID, not a miss. Per part, on the worse of cold and warm, from each runner's own structured " +
    "report (vitest JSON; the pytest plugin's per-process records): 0 errored files (only electron files that " +
    'errored in the pinned run and on main too are set apart); executed tests == collected tests (a run cut short ' +
    'executes fewer); collected and passed each at least 98 % of the pinned run (bench/baselines/' +
    'gates.suite.collected.tsv): a test that fails or skips before its body runs does shorten the suite, and the ' +
    "passed floor catches it; cold and warm collect the same counts. The Python tests must have imported the clone's " +
    'pm / hermes_cli.',
  hot_path:
    'apps/desktop/vitest.config.ts (projects electron, ui) → electron/**/*.test.ts, src/**/*.test.tsx; ' +
    'scripts/run_tests.sh → scripts/run_tests_parallel.py → tests/pm/**, tests/hermes_cli/**',
  unit: 'ms',
  lang: 'TypeScript',
  miss_class: 'cpu',
  min_n: 1,
  min_n_reason:
    'each sample is a complete suite (vitest electron + ui + Python core, about 5-10 min); one cold and one warm ' +
    'suite cost six exclusive windows already, so cold and warm are one sample each and p95 is that sample',
  budget: {
    value: 1_800_000,
    op: '<=',
    stat: 'cold.p95',
    reason:
      'the gates run this suite before every merge inside one exclusive 30-minute machine window; a suite that ' +
      'does not fit it cannot run in one sitting'
  },
  risk: 'a suite that outgrows the window pushes gates into unclean runs and makes contributors skip them',
  failure_mode:
    'observed 2026-10-29: two gate runs started side by side slowed each other past their window and one was ' +
    'repeated; a part over 14 min errors the row (it cannot fit one window) instead of reporting a miss',

  async measure(ctx) {
    const clone = await cloneSetup(ctx)
    const py = await pythonSetup(ctx, clone)
    if (py.unmeasurable) {
      return py
    }
    // The control may have run first in this clone: the cold sample starts with no vitest cache.
    rmSync(join(clone.nm, '.vite'), { recursive: true, force: true })
    const floors = loadSuiteFloors()
    const listed = loadKnownElectron()
    // A bare file on the list is set apart from the errored-files guard only if it also errored in the pinned run.
    const known = { ...listed, files: new Set([...listed.files].filter(f => floors.erroredKnown.has(f))) }
    const windows = []
    const runs = []
    for (const label of ['cold', 'warm']) {
      ctx.log(`complete suite (${label})`)
      runs.push(await completeSuite(ctx, clone, py, label, windows, known))
    }
    const moduleRoots = moduleRootsUnder(py.roots, clone.wt)
    const parts = runs.map((r, i) => {
      const sample = i ? 'warm' : 'cold'
      return {
        sample,
        counts: Object.fromEntries(
          SUITE_PARTS.map(k => [
            k,
            {
              ms: Math.round(r[k].ms),
              collected: r[k].collected,
              executed: r[k].executed,
              passed: r[k].passed,
              failed: r[k].failed,
              skipped: r[k].skipped,
              errored_files: r[k].errors
            }
          ])
        ),
        electron_errored_files_also_on_main: r.electron.errors_known,
        failures: Object.fromEntries(SUITE_PARTS.map(k => [k, failureReport(ctx.scratch, sample, k, r[k])])),
        python_byte_compile_ran: r.python.compiled
      }
    })
    return {
      cold: [runs[0].ms],
      warm: [runs[1].ms],
      extra: {
        parts,
        windows,
        electron_known_failures: { list: listed.source, listed: listed.tests.size + listed.files.size },
        suite_floors: { source: floors.source, parts: floors.parts, errored_known: [...floors.erroredKnown] },
        python: {
          interpreter: py.python,
          files: py.files,
          deselected_node_ids: py.waived,
          deselect_list_sha256: py.deselectSha256,
          app_modules_loaded_from: moduleRoots,
          last_lines: runs[1].python.tail,
          printed_summary: { cold: runs[0].python.summary, warm: runs[1].python.summary }
        },
        validity: suiteValidity(runs, floors)
      }
    }
  },

  async control(ctx) {
    const clone = await cloneSetup(ctx)
    await ctx.window.renew('bench:gates.suite:control')
    const sleeper = join(ctx.scratch, 'sleep.cjs')
    writeFileSync(sleeper, `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${CONTROL_DELAY_MS})\n`)
    const delay = { NODE_OPTIONS: `--require ${JSON.stringify(sleeper)}` }
    const base = []
    const variant = []
    // Interleaved, so a load drift during the control hits both sides alike.
    for (let i = 0; i < CONTROL_N; i++) {
      base.push((await vitest(ctx, clone, `control-base-${i}`, 'electron', [CONTROL_FILE])).ms)
      variant.push((await vitest(ctx, clone, `control-delay-${i}`, 'electron', [CONTROL_FILE], delay)).ms)
    }
    const value = median(variant) - median(base)
    // Every node process that loads NODE_OPTIONS sleeps (the vitest main process and its forks worker: ~2x the
    // delay); the threshold is 80 % of ONE delay, so it holds even if the pool ran the file in-process.
    const threshold = 0.8 * CONTROL_DELAY_MS
    return {
      name: `${CONTROL_DELAY_MS} ms synchronous sleep preloaded into the vitest processes (NODE_OPTIONS --require)`,
      expected: `median(delayed) - median(base) >= ${threshold} ms (n=${CONTROL_N} each, interleaved)`,
      observed: `${Math.round(value)} ms (base median ${Math.round(median(base))} → ${Math.round(median(variant))})`,
      value,
      threshold,
      op: '>=',
      ok: value >= threshold,
      base,
      variant
    }
  }
}
