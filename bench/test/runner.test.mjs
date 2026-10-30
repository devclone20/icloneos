// Harness self-tests: statistics, exit codes, the refusal of broken samples, schema, and redaction.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import nodeTest from 'node:test'
import { fileURLToPath } from 'node:url'

import { newResultFile, readResult } from '../lib/child_result.mjs'
import { coolDown, decide, run, runBench } from '../lib/runner.mjs'
import { validateResult, validateRow } from '../lib/schema.mjs'
import { HarnessError, judge, nearestRank, summarize } from '../lib/stats.mjs'

const RUN = join(dirname(fileURLToPath(import.meta.url)), '..', 'run.mjs')

function fixtureRow(id, body) {
  return `export default {
  id: '${id}', part: 'fixture', what: 'fixture', hot_path: 'x.py', unit: 'ms', risk: 'r', failure_mode: 'f',
  lang: 'Python', miss_class: 'cpu',
  budget: { value: 100, op: '<=', stat: 'cold.p95', reason: 'fixture' },
  ${body}
}
`
}

// Every test has a hard deadline, and whatever it started is gone when it ends, pass, fail or timeout: each process
// whose command line names one of the test's temp dirs (the runner, a row's children, their grandchildren) is
// SIGKILLed with its process group, and the test fails if any of them is still alive 5 s later. A hung test can
// therefore neither hang the suite nor leave a tree running.
const TEST_DEADLINE_MS = 120_000
const OWN_PGID = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim())
function processesNaming(dirs) {
  const out = spawnSync('ps', ['-Ao', 'pid=,pgid=,command='], { encoding: 'utf8' }).stdout ?? ''
  return out
    .split('\n')
    .map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(m => m && Number(m[1]) !== process.pid && dirs.some(dir => m[3].includes(dir)))
    .map(m => ({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3] }))
}
async function reapLeftovers(dirs) {
  if (!dirs.length) {
    return
  }
  for (const p of processesNaming(dirs)) {
    try {
      // A child in this process's own group (spawned without `detached`) is killed alone, never the group.
      process.kill(p.pgid === OWN_PGID ? p.pid : -p.pgid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  const end = Date.now() + 5000
  let left = processesNaming(dirs)
  while (left.length && Date.now() < end) {
    await new Promise(r => setTimeout(r, 100))
    left = processesNaming(dirs)
  }
  if (left.length) {
    throw new Error(`test left processes behind: ${left.map(p => `${p.pid} ${p.command.slice(0, 80)}`).join('; ')}`)
  }
}
function test(name, opts, fn) {
  if (typeof opts === 'function') {
    ;[opts, fn] = [{}, opts]
  }
  return nodeTest(name, opts, async t => {
    const first = tempDirs.length
    let timer
    try {
      await Promise.race([
        fn(t),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`deadline: test exceeded ${TEST_DEADLINE_MS} ms`)),
            TEST_DEADLINE_MS
          )
        })
      ])
    } finally {
      clearTimeout(timer)
      await reapLeftovers(tempDirs.slice(first))
    }
  })
}
test.after = nodeTest.after

/** The child's exit code, also when it already exited; SIGKILL and fail if it has not exited within `ms`. */
async function exitOf(child, ms = 30_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode
  }
  let timer
  try {
    return await new Promise((resolve, reject) => {
      child.once('exit', code => resolve(code))
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`runner ${child.pid} did not exit within ${ms} ms`))
      }, ms)
    })
  } finally {
    clearTimeout(timer)
  }
}

const tempDirs = []
test.after(() => tempDirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))
function tempDir() {
  const dir = mkdtempSync(join(os.tmpdir(), 'bench-test-'))
  tempDirs.push(dir)
  return dir
}

function runFixture(rows, extraArgs = [], env = {}) {
  const dir = tempDir()
  const rowsDir = join(dir, 'rows')
  spawnSync('mkdir', [rowsDir])
  for (const [file, src] of Object.entries(rows)) {
    writeFileSync(join(rowsDir, file), src)
  }
  const out = join(dir, 'out')
  // No cool-down in the harness tests: a busy test machine must not make them wait (coolDown has its own test).
  const res = spawnSync(process.execPath, [RUN, '--rows', rowsDir, '--out', out, '--cooldown-max', '0', ...extraArgs], {
    encoding: 'utf8',
    timeout: TEST_DEADLINE_MS - 10_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, BENCH_GPU_LOCK: '', ...env }
  })
  let doc = null
  try {
    doc = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'))
  } catch {
    // no results written (a harness error before writing)
  }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, doc, out }
}

const GOOD_CONTROL = `async control() {
  return { name: 'delay', expected: '>= 80', observed: '95', value: 95, threshold: 80, op: '>=', ok: true }
}`

test('nearest-rank percentiles match hand-computed values', () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  assert.equal(nearestRank(ten, 50), 5)
  assert.equal(nearestRank(ten, 95), 10)
  assert.equal(nearestRank(ten, 90), 9)
  assert.equal(nearestRank([7], 95), 7)
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1)
  assert.equal(nearestRank(twenty, 95), 19)
  assert.equal(nearestRank(twenty, 50), 10)
  const s = summarize([30, 10, 20, 50, 40], { minN: 5, label: 't' })
  assert.deepEqual([s.n, s.p50, s.p95, s.min, s.max], [5, 30, 50, 10, 50])
  assert.deepEqual(s.samples, [30, 10, 20, 50, 40], 'samples keep their measured order')
})

test('summarize refuses 0, NaN, negative, non-numeric and too-few samples', () => {
  for (const bad of [
    [0, 1, 2],
    [NaN, 1, 2],
    [-1, 1, 2],
    ['1', 2, 3],
    [Infinity, 1, 2]
  ]) {
    assert.throws(() => summarize(bad, { minN: 2, label: 'x' }), HarnessError)
  }
  assert.throws(() => summarize([1], { minN: 2, label: 'x' }), /n=1 < required 2/)
  assert.throws(() => summarize(undefined, { minN: 2, label: 'x' }), HarnessError)
})

test('judge compares the named statistic and signs the deficit', () => {
  const s = { cold: summarize([10, 20, 30], { minN: 1, label: 'c' }), warm: null }
  assert.deepEqual(judge({ value: 25, op: '<=', stat: 'cold.p95' }, s), { measured: 30, meets: false, deficit: 5 })
  assert.equal(judge({ value: 25, op: '<=', stat: 'cold.p50' }, s).meets, true)
  assert.throws(() => judge({ value: 1, op: '<=', stat: 'warm.p50' }, s), /not measured/)
})

test('a valid run exits 0 and writes a schema-valid document and table', () => {
  const r = runFixture({
    'a.b.mjs': fixtureRow('a.b', `async measure() { return { cold: [10, 20], warm: [5, 6] } }, ${GOOD_CONTROL}`)
  })
  assert.equal(r.code, 0, r.stderr)
  validateResult(r.doc)
  assert.equal(r.doc.rows[0].verdict, 'MEETS')
  // No exclusive window in tests (BENCH_GPU_LOCK empty): the row is unclean and decides nothing.
  assert.match(r.doc.rows[0].decision, /^repeat \(unclean: .*no exclusive window/)
  assert.equal(r.doc.clean_rows, 0)
  assert.equal(r.doc.rows[0].cold.p95_is_max, true)
  assert.match(readFileSync(join(r.out, 'table.md'), 'utf8'), /\| a\.b \| fixture \| 10 \/ 20 \(p95=max, n=2\)/)
})

test('a row whose control does not fire makes the whole run invalid (exit 3)', () => {
  const r = runFixture({
    'a.ok.mjs': fixtureRow('a.ok', `async measure() { return { cold: [10, 20] } }, ${GOOD_CONTROL}`),
    'b.bad.mjs': fixtureRow(
      'b.bad',
      `async measure() { return { cold: [10, 20] } },
       async control() {
         return { name: 'delay', expected: '>= 80', observed: '3', value: 3, threshold: 80, op: '>=', ok: false }
       }`
    )
  })
  assert.equal(r.code, 3, r.stderr)
  assert.equal(r.doc.status, 'invalid')
  assert.equal(r.doc.rows.find(x => x.id === 'b.bad').control[0].ok, false)
})

for (const [label, samples] of [
  ['zero', '[0, 0]'],
  ['NaN', '[NaN, 5]'],
  ['too few', '[5]']
]) {
  test(`a row returning ${label} samples is a harness error (exit 2), never a number`, () => {
    const r = runFixture({
      'z.row.mjs': fixtureRow('z.row', `async measure() { return { cold: ${samples} } }, ${GOOD_CONTROL}`)
    })
    assert.equal(r.code, 2, r.stderr)
    const row = r.doc.rows[0]
    assert.equal(row.verdict, 'ERROR')
    assert.equal(row.measured, null)
    assert.equal(row.cold, null)
    assert.equal(r.doc.status, 'harness-error')
  })
}

test('a row that throws, or whose control throws, is a harness error', () => {
  const r = runFixture({
    't.measure.mjs': fixtureRow('t.measure', `async measure() { throw new Error('boom') }, ${GOOD_CONTROL}`),
    't.control.mjs': fixtureRow(
      't.control',
      `async measure() { return { cold: [1, 2] } }, async control() { return {} }`
    )
  })
  assert.equal(r.code, 2)
  assert.ok(r.doc.rows.every(x => x.verdict === 'ERROR'))
})

test('an unmeasurable row is reported as such, not judged', () => {
  const r = runFixture({
    'u.row.mjs': fixtureRow('u.row', `async measure() { return { unmeasurable: 'no GPU' } }, ${GOOD_CONTROL}`)
  })
  assert.equal(r.code, 0)
  assert.equal(r.doc.rows[0].verdict, 'UNMEASURABLE')
  assert.equal(r.doc.rows[0].measured, null)
})

test('--full demands n >= 5 unless the row declares min_n with a reason', () => {
  const r = runFixture(
    { 'f.row.mjs': fixtureRow('f.row', `async measure() { return { cold: [1, 2, 3] } }, ${GOOD_CONTROL}`) },
    ['--full']
  )
  assert.equal(r.code, 2)
  const ok = runFixture(
    {
      'f.row.mjs': fixtureRow(
        'f.row',
        `min_n: 3, min_n_reason: 'r', async measure() { return { cold: [1, 2, 3] } }, ${GOOD_CONTROL}`
      )
    },
    ['--full']
  )
  assert.equal(ok.code, 0, ok.stderr)
})

test('the output never carries the home directory, even when a row prints it', () => {
  const home = os.homedir()
  const r = runFixture({
    'h.row.mjs': fixtureRow(
      'h.row',
      `async measure(ctx) { return { cold: [1, 2], extra: { path: ${JSON.stringify(home)} + '/x/y', scratch: ctx.scratch } } }, ${GOOD_CONTROL}`
    )
  })
  assert.equal(r.code, 0, r.stderr)
  const text = readFileSync(join(r.out, 'results.json'), 'utf8') + readFileSync(join(r.out, 'table.md'), 'utf8')
  assert.ok(!text.includes(home), 'home path leaked')
  assert.ok(!text.includes(os.hostname()), 'hostname leaked')
  assert.equal(r.doc.rows[0].extra.path, '~/x/y')
})

test('schema validation rejects malformed rows and documents', () => {
  assert.throws(() => validateRow({ id: 'nodot' }), HarnessError)
  assert.throws(() => validateResult({ schema: 'bench/0' }), /schema/)
  const r = runFixture({ 'a.b.mjs': fixtureRow('a.b', `async measure() { return { cold: [1, 2] } }, ${GOOD_CONTROL}`) })
  const doc = structuredClone(r.doc)
  doc.rows[0].cold.p95 = 'fast'
  assert.throws(() => validateResult(doc), /cold\.p95/)
  const noVerdict = structuredClone(r.doc)
  noVerdict.rows[0].verdict = 'GREAT'
  assert.throws(() => validateResult(noVerdict), /verdict/)
})

test('unknown --only ids and duplicate ids are refused (exit 2)', () => {
  const row = fixtureRow('a.b', `async measure() { return { cold: [1, 2] } }, ${GOOD_CONTROL}`)
  assert.equal(runFixture({ 'a.b.mjs': row }, ['--only', 'nope.row']).code, 2)
  assert.equal(runFixture({ 'a.b.mjs': row, 'c.d.mjs': row }).code, 2, 'c.d.mjs exports id a.b')
  const helper = `throw new Error('helpers are never imported')\n`
  assert.equal(runFixture({ 'a.b.mjs': row, '_helper.mjs': helper }).code, 0, 'underscore files are helpers')
})

test('a missed secondary budget turns a row MISSES; a contradictory one is a harness error', () => {
  const sample = `async measure() { return { cold: [10, 11], warm: [5, 6], extra: { secondary: SEC } } },\n  ${GOOD_CONTROL}`
  const missed = runFixture({
    'fx.sec.mjs': fixtureRow(
      'fx.sec',
      sample.replace(
        'SEC',
        `[{ name: 'heap per pane', value: 70, unit: 'KiB', budget: 64, op: '<=', ok: false },
          { name: 'loss', value: 0, unit: 'messages', budget: 0, op: '<=', ok: true }]`
      )
    )
  })
  assert.equal(missed.code, 0, missed.stderr)
  const row = missed.doc.rows[0]
  assert.equal(row.verdict, 'MISSES')
  assert.ok(row.measured <= 100, 'the primary budget itself is met')
  assert.match(
    decide(row, { ...row, unclean: false }),
    /candidate for a native port \(cpu deficit: heap per pane 70 KiB vs <= 64 \(\+6\)\)/
  )
  assert.deepEqual(
    row.secondary.map(s => [s.name, s.ok]),
    [
      ['heap per pane', false],
      ['loss', true]
    ]
  )
  const table = readFileSync(join(missed.out, 'table.md'), 'utf8')
  assert.match(table, /\*\*MISS\*\* heap per pane: 70 KiB \(<= 64\)/)
  assert.match(table, /ok loss: 0 messages \(<= 0\)/)

  const met = runFixture({
    'fx.sec.mjs': fixtureRow(
      'fx.sec',
      sample.replace('SEC', `[{ name: 'loss', value: 0, unit: 'n', budget: 0, op: '<=', ok: true }]`)
    )
  })
  assert.equal(met.doc.rows[0].verdict, 'MEETS')

  for (const bad of [
    `[{ name: 'lies', value: 70, unit: 'KiB', budget: 64, op: '<=', ok: true }]`,
    `[{ name: 'null value', value: null, unit: 'KiB', budget: 64, op: '<=', ok: false }]`,
    `[{ name: 'no budget', value: 1, unit: 'KiB', budget: null, op: '<=', ok: true }]`,
    `{ name: 'not an array' }`
  ]) {
    const res = runFixture({ 'fx.sec.mjs': fixtureRow('fx.sec', sample.replace('SEC', bad)) })
    assert.equal(res.code, 2, bad)
    assert.equal(res.doc.rows[0].verdict, 'ERROR', bad)
  }
  assert.throws(
    () =>
      validateResult({
        ...met.doc,
        rows: [{ ...met.doc.rows[0], secondary: [{ name: 'x', value: 2, unit: 'n', budget: 1, op: '<=', ok: false }] }]
      }),
    HarnessError
  )
})

test('row helpers prefixed with _ are never imported as rows, with or without --only', () => {
  const rows = {
    'fx.one.mjs': fixtureRow('fx.one', `async measure() { return { cold: [1, 2] } },\n  ${GOOD_CONTROL}`),
    '_fx.one.child.mjs': `throw new Error('a helper was imported as a row')\n`
  }
  for (const args of [[], ['--only', 'fx.one']]) {
    const res = runFixture(rows, args)
    assert.equal(res.code, 0, res.stderr)
    assert.deepEqual(
      res.doc.rows.map(r => r.id),
      ['fx.one']
    )
  }
})

// The real gpu_lock.py, pointed at a lock file in a temp dir (its own test env), with no Blender to wait for.
const GPU_LOCK = process.env.BENCH_TEST_GPU_LOCK
function lockEnv(dir) {
  return {
    BENCH_GPU_LOCK: GPU_LOCK,
    UNIVERSO_MEASURE_LOCK: join(dir, 'measure.lock'),
    GPU_LOCK_PROC: '__none__',
    GPU_LOCK_WAIT: '5',
    GPU_LOCK_GAP: '0'
  }
}

test('the exclusive window is released with the holder name, including after renew()', { skip: !GPU_LOCK }, () => {
  const dir = tempDir()
  const r = runFixture(
    {
      'w.row.mjs': fixtureRow(
        'w.row',
        `async measure(ctx) {
           if (!ctx.window.held) throw new Error('window not held')
           const again = await ctx.window.renew('bench:w.row:second')
           if (!again.held) throw new Error('renewed window not held')
           return { cold: [10, 20] }
         }, ${GOOD_CONTROL}`
      ),
      'x.row.mjs': fixtureRow('x.row', `async measure() { return { cold: [10, 20] } }, ${GOOD_CONTROL}`)
    },
    [],
    lockEnv(dir)
  )
  assert.equal(r.code, 0, r.stderr)
  assert.equal(existsSync(join(dir, 'measure.lock')), false, 'lock left held')
  const w = r.doc.rows.find(x => x.id === 'w.row')
  assert.deepEqual(
    w.windows.map(x => [x.who, x.held]),
    [
      ['bench:w.row', true],
      ['bench:w.row:second', true]
    ]
  )
  // The second row got its own window at once: the first one's lock was really released.
  const x = r.doc.rows.find(row => row.id === 'x.row')
  assert.deepEqual(
    x.windows.map(win => [win.who, win.held]),
    [['bench:x.row', true]]
  )
  assert.doesNotMatch(String(x.unclean_reason), /window/)
})

test('a refused release is a harness error that stops the run (exit 2)', () => {
  const dir = tempDir()
  const fake = join(dir, 'gpu_lock.py')
  writeFileSync(
    fake,
    [
      'import json, sys',
      'if sys.argv[1] == "acquire": print(json.dumps({"ok": True})); sys.exit(0)',
      'if sys.argv[1] == "release" and "--who" not in sys.argv:',
      '    print(json.dumps({"released": False, "reason": "release needs --who <holder>"})); sys.exit(5)',
      'print(json.dumps({"released": False, "reason": "held by another"})); sys.exit(5)'
    ].join('\n')
  )
  const r = runFixture(
    {
      'a.row.mjs': fixtureRow('a.row', `async measure() { return { cold: [10, 20] } }, ${GOOD_CONTROL}`),
      'b.row.mjs': fixtureRow('b.row', `async measure() { return { cold: [10, 20] } }, ${GOOD_CONTROL}`)
    },
    [],
    { BENCH_GPU_LOCK: fake }
  )
  assert.equal(r.code, 2, r.stderr)
  assert.equal(r.doc.rows.length, 1, 'the run must stop after a refused release')
  assert.match(r.doc.rows[0].error, /gpu_lock release --who bench:a\.row failed \(exit 5\)/)
})

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitFor = async (cond, ms) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 50))
  return cond()
}

test('a timeout kills the whole process group, grandchildren included', async () => {
  const dir = tempDir()
  const pidFile = join(dir, 'grandchild.pid')
  const res = await run('/bin/bash', ['-c', `sleep 60 & echo $! > '${pidFile}'; wait`], { timeoutMs: 300 })
  assert.equal(res.timedOut, true)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.ok(await waitFor(() => !alive(pid), 7000), `grandchild ${pid} survived the timeout`)
})

test(
  'SIGINT to the runner kills child groups, releases the window and removes scratch',
  { skip: !GPU_LOCK },
  async () => {
    const dir = tempDir()
    const pidFile = join(dir, 'grandchild.pid')
    const scratchFile = join(dir, 'scratch.path')
    const rowsDir = join(dir, 'rows')
    spawnSync('mkdir', [rowsDir])
    writeFileSync(
      join(rowsDir, 's.row.mjs'),
      fixtureRow(
        's.row',
        `async measure(ctx) {
         ;(await import('node:fs')).writeFileSync('${scratchFile}', ctx.scratch)
         await ctx.sh('/bin/bash', ['-c', "sleep 60 & echo $! > '${pidFile}'; wait"])
         return { cold: [1, 2] }
       }, ${GOOD_CONTROL}`
      )
    )
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [RUN, '--rows', rowsDir, '--out', join(dir, 'out'), '--cooldown-max', '0'], {
      env: { ...process.env, ...lockEnv(dir) },
      stdio: 'ignore'
    })
    assert.ok(
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim(), 30_000),
      'row never started'
    )
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const scratch = readFileSync(scratchFile, 'utf8')
    assert.ok(existsSync(join(dir, 'measure.lock')), 'window not held during the row')
    child.kill('SIGINT')
    const code = await exitOf(child)
    assert.equal(code, 130)
    assert.ok(await waitFor(() => !alive(pid), 7000), `grandchild ${pid} survived SIGINT`)
    assert.equal(existsSync(join(dir, 'measure.lock')), false, 'window left held')
    assert.equal(existsSync(scratch), false, 'scratch left behind')
  }
)

test('controls are recomputed: wrong value, n < 3 or a contradictory ok is a harness error', () => {
  const ctl = c => `async control() { return ${c} }`
  const cases = {
    'c.value.mjs': `{ name: 'd', expected: 'e', observed: 'o', value: 50, threshold: 10, op: '>=', ok: true,
                      base: [1, 2, 3], variant: [11, 12, 13] }`,
    'c.small.mjs': `{ name: 'd', expected: 'e', observed: 'o', value: 10, threshold: 5, op: '>=', ok: true,
                      base: [1, 2], variant: [11, 12] }`,
    'c.okay.mjs': `{ name: 'd', expected: 'e', observed: 'o', value: 1, threshold: 5, op: '>=', ok: true }`,
    'c.text.mjs': `{ name: 'd', expected: 'e', observed: 'o', ok: true }`
  }
  const r = runFixture(
    Object.fromEntries(
      Object.entries(cases).map(([file, c]) => [
        file,
        fixtureRow(file.slice(0, -4), `async measure() { return { cold: [1, 2] } }, ${ctl(c)}`)
      ])
    )
  )
  assert.equal(r.code, 2, r.stderr)
  assert.ok(
    r.doc.rows.every(x => x.verdict === 'ERROR'),
    JSON.stringify(r.doc.rows.map(x => x.error))
  )
  const good = runFixture({
    'c.good.mjs': fixtureRow(
      'c.good',
      `async measure() { return { cold: [1, 2] } }, ${ctl(`[{ name: 'd', expected: 'e', observed: 'o', value: 10,
         threshold: 8, op: '>=', ok: true, base: [1, 2, 3], variant: [11, 12, 13] },
       { name: 'r', expected: 'e', observed: 'o', value: 1, threshold: 1, op: '>=', ok: true }]`)}`
    )
  })
  assert.equal(good.code, 0, good.stderr)
  assert.equal(good.doc.rows[0].control.length, 2)
})

test('decision: unclean repeats; a clean miss is a native-port candidate only when cpu-bound', () => {
  const row = { lang: 'TypeScript', unit: 'ms', miss_class: 'io', budget: { stat: 'warm.p95' } }
  const res = { verdict: 'MISSES', measured: 12, deficit: 7, secondary: [], unclean: false }
  assert.equal(decide(row, res), 'fix in place (io): warm.p95 +7 ms')
  assert.equal(decide({ ...row, miss_class: 'cpu' }, res), 'candidate for a native port (cpu deficit: warm.p95 +7 ms)')
  assert.equal(decide(row, { ...res, verdict: 'MEETS', deficit: -1 }), 'stays in TypeScript (warm.p95 12 ms)')
  assert.equal(
    decide(row, { ...res, unclean: true, unclean_reason: 'load 9 > 4.0 at start' }),
    'repeat (unclean: load 9 > 4.0 at start)'
  )
})

test('allow_nonpositive admits 0 and negative samples only where declared; rows must declare lang and miss_class', () => {
  const declared = fixtureRow(
    'z.dev',
    `allow_nonpositive: { reason: 'paired difference' }, async measure() { return { cold: [3, -6.2], warm: [0, 1] } }, ${GOOD_CONTROL}`
  )
  const ok = runFixture({ 'z.dev.mjs': declared })
  assert.equal(ok.code, 0, ok.stderr)
  assert.equal(ok.doc.rows[0].cold.min, -6.2)
  // The same negative sample from a row that does not declare it is a broken instrument.
  const undeclared = declared.replace("allow_nonpositive: { reason: 'paired difference' }, ", '')
  const err = runFixture({ 'z.dev.mjs': undeclared })
  assert.equal(err.code, 2)
  assert.match(err.doc.rows[0].error, /invalid sample/)
  assert.equal(runFixture({ 'z.dev.mjs': declared.replace('[3, -6.2]', '[0, NaN]') }).code, 2)
  assert.equal(runFixture({ 'z.dev.mjs': declared.replace("reason: 'paired difference'", "reason: ' '") }).code, 2)
  assert.equal(runFixture({ 'z.dev.mjs': declared.replace("{ reason: 'paired difference' }", 'true') }).code, 2)
  const legacy = declared.replace(
    "allow_nonpositive: { reason: 'paired difference' }",
    "allow_zero: true, allow_zero_reason: 'x'"
  )
  assert.equal(runFixture({ 'z.dev.mjs': legacy }).code, 2)
  assert.equal(runFixture({ 'z.dev.mjs': declared.replace("miss_class: 'cpu',", '') }).code, 2)
})

// A grandchild that IGNORES SIGTERM keeps writing into the scratch until it dies. If the scratch were
// removed before the group was dead, the writer would recreate it; the run must also take at least the grace period.
const STUBBORN = (dir, pidFile) =>
  `trap '' TERM; while :; do mkdir -p '${dir}/live' && : > '${dir}/live/beat'; sleep 0.05; done & ` +
  `echo $! > '${pidFile}'; wait`

test('a timeout reaps a SIGTERM-ignoring grandchild before run() settles', async () => {
  const dir = tempDir()
  const pidFile = join(dir, 'grandchild.pid')
  const t0 = Date.now()
  const res = await run('/bin/bash', ['-c', STUBBORN(dir, pidFile)], { timeoutMs: 300 })
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.equal(res.timedOut, true)
  assert.equal(alive(pid), false, `grandchild ${pid} still alive when run() settled`)
  assert.ok(Date.now() - t0 >= 5000, 'run() settled before the SIGTERM grace expired')
  rmSync(join(dir, 'live'), { recursive: true, force: true })
  await new Promise(r => setTimeout(r, 300))
  assert.equal(existsSync(join(dir, 'live')), false, 'something still writes after run() settled')
})

test('SIGINT: a SIGTERM-ignoring grandchild is dead before the scratch is removed', async () => {
  const dir = tempDir()
  const pidFile = join(dir, 'grandchild.pid')
  const scratchFile = join(dir, 'scratch.path')
  const rowsDir = join(dir, 'rows')
  spawnSync('mkdir', [rowsDir])
  writeFileSync(
    join(rowsDir, 's.row.mjs'),
    fixtureRow(
      's.row',
      `async measure(ctx) {
         ;(await import('node:fs')).writeFileSync('${scratchFile}', ctx.scratch)
         await ctx.sh('/bin/bash', ['-c', ${JSON.stringify(STUBBORN('SCRATCH', pidFile))}.replaceAll('SCRATCH', ctx.scratch)])
         return { cold: [1, 2] }
       }, ${GOOD_CONTROL}`
    )
  )
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [RUN, '--rows', rowsDir, '--out', join(dir, 'out'), '--cooldown-max', '0'], {
    env: { ...process.env, BENCH_GPU_LOCK: '' },
    stdio: 'ignore'
  })
  assert.ok(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim(), 30_000), 'no row')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  const scratch = readFileSync(scratchFile, 'utf8')
  assert.ok(await waitFor(() => existsSync(join(scratch, 'live', 'beat')), 15_000), 'grandchild never wrote')
  const t0 = Date.now()
  child.kill('SIGINT')
  const code = await exitOf(child)
  assert.equal(code, 130)
  assert.equal(alive(pid), false, `grandchild ${pid} alive after the runner exited`)
  assert.ok(Date.now() - t0 >= 2500, 'the runner exited before the SIGTERM grace expired')
  await new Promise(r => setTimeout(r, 300))
  assert.equal(existsSync(scratch), false, 'scratch left behind or recreated by a live writer')
})

// An acquire cut by the abort after it wrote the lock (and that ignores SIGTERM, so it cannot drop the lock
// itself) must not leave the shared lock held: the abort releases by the acquire's name.
const FAKE_LOCK = `import json, os, signal, sys, time
lock = os.environ['FAKE_LOCK']
cmd, who = sys.argv[1], sys.argv[sys.argv.index('--who') + 1]
if cmd == 'acquire':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    open(os.environ['FAKE_LOCK_PID'], 'w').write(str(os.getpid()))
    open(lock, 'w').write(json.dumps({'who': who}))
    time.sleep(60)
elif not os.path.exists(lock):
    print(json.dumps({'released': False, 'reason': 'no lock'}))
elif json.load(open(lock))['who'] == who:
    os.remove(lock)
    print(json.dumps({'released': True, 'held_s': 0, 'overheld': False}))
else:
    sys.exit(5)
`
test('SIGINT during an acquire that wrote the lock: the acquire dies and the lock is released', async () => {
  const dir = tempDir()
  const tool = join(dir, 'fake_lock.py')
  writeFileSync(tool, FAKE_LOCK)
  const env = { FAKE_LOCK: join(dir, 'measure.lock'), FAKE_LOCK_PID: join(dir, 'acquire.pid') }
  const rowsDir = join(dir, 'rows')
  spawnSync('mkdir', [rowsDir])
  writeFileSync(
    join(rowsDir, 'a.row.mjs'),
    fixtureRow('a.row', `async measure() { return { cold: [1, 2] } }, ${GOOD_CONTROL}`)
  )
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [RUN, '--rows', rowsDir, '--out', join(dir, 'out'), '--cooldown-max', '0'], {
    env: { ...process.env, BENCH_GPU_LOCK: tool, ...env },
    stdio: 'ignore'
  })
  assert.ok(await waitFor(() => existsSync(env.FAKE_LOCK), 30_000), 'acquire never wrote the lock')
  const pid = Number(readFileSync(env.FAKE_LOCK_PID, 'utf8'))
  child.kill('SIGINT')
  const code = await exitOf(child)
  assert.equal(code, 130)
  assert.equal(alive(pid), false, `acquire ${pid} survived the abort`)
  assert.equal(existsSync(env.FAKE_LOCK), false, 'the shared lock was left held')
})

test('--control-only skips a statically unmeasurable row (no window, no control) and decides nothing for it', () => {
  const row = fixtureRow(
    'u.row',
    `unmeasurable: 'nothing to time', async measure() { throw new Error('measured') },
     async control() { throw new Error('control called') }`
  )
  for (const args of [['--control-only'], []]) {
    const res = runFixture({ 'u.row.mjs': row }, args)
    assert.equal(res.code, 0, res.stderr)
    const r = res.doc.rows[0]
    assert.equal(r.verdict, 'UNMEASURABLE')
    assert.equal(r.decision, '—')
    assert.deepEqual(r.windows, [])
  }
  assert.equal(decide({ lang: 'Python' }, { verdict: 'UNMEASURABLE', unclean: true, unclean_reason: 'x' }), '—')
})

test('gates.suite: the validity guard makes a run that ran less INVALID; failures alone still count', async () => {
  const gates = new URL('../rows/gates.suite.mjs', import.meta.url).href
  const { loadSuiteFloors, parseSuiteFloors, pythonCounts, pytestStats, suiteValidity, vitestCounts } = await import(
    gates
  )
  // Python: the printed summary gives only error sections and failing ids; the counts come from the plugin records.
  const clean =
    'x\n=== Summary: 40 files, 900 tests passed, 0 failed, 3 skipped (100% complete) in 9.0s (8 workers) ===\n'
  const oneFail = `${clean.replace('0 failed', '1 failed')}FAILED tests/pm/test_a.py::test_x[- y] - AssertionError: boom\n`
  assert.deepEqual(pythonCounts(clean, 0), {
    errors: 0,
    failing: [],
    summary: { passed: 900, failed: 0, skipped: 3 }
  })
  assert.deepEqual(pythonCounts(oneFail, 1).failing, ['tests/pm/test_a.py::test_x[- y]'])
  const crashed = `${clean}=== 2 files where no tests ran (collection/import error, timeout before collection, etc.) ===\n`
  assert.equal(pythonCounts(crashed, 1).errors, 2)
  assert.equal(pythonCounts('no summary', 1), null)
  const rec = (...xs) => xs.map(x => JSON.stringify(x)).join('\n') + '\n'
  const coll = n => ({ kind: 'collected', pid: 1, n })
  const fin = (passed, failed = 0, skipped = 0) => ({ kind: 'finished', pid: 1, passed, failed, skipped })
  const py = (stats, out = clean) => ({ ...pythonCounts(out, 0), ...pytestStats(stats) })
  const pyClean = py(rec(coll(500), fin(497, 0, 3), coll(403), fin(403)))
  assert.deepEqual([pyClean.collected, pyClean.executed, pyClean.passed, pyClean.skipped], [903, 903, 900, 3])
  assert.throws(() => pytestStats('{"kind":"collected","n":3}\n{"kind":"fini'), /unreadable pytest plugin record/)
  // vitest: collected = numTotalTests, executed = tests the run reached, passed = numPassedTests.
  const a = (status, n) => Array.from({ length: n }, (_, k) => ({ status, fullName: `${status} ${k}` }))
  const report = (results, extra = {}) => ({
    numTotalTests: results.length,
    numPassedTests: results.filter(r => r.status === 'passed').length,
    numFailedTests: results.filter(r => r.status === 'failed').length,
    numTotalTestSuites: 1,
    testResults: [{ name: '/x/apps/desktop/a.test.ts', status: 'passed', assertionResults: results }],
    ...extra
  })
  const vt = vitestCounts(report([...a('passed', 4), ...a('pending', 1)]), 0)
  assert.deepEqual([vt.collected, vt.executed, vt.passed, vt.skipped, vt.errors], [5, 5, 4, 0, 0])
  const floors = parseSuiteFloors(
    '# h\npart\tcollected\tpassed\nelectron\t5\t4\nui\t5\t4\npython\t903\t900\nerrored_known\tscripts/x.test.mjs\n'
  )
  floors.source = 'f'
  assert.deepEqual(floors.parts.python, { collected: { pinned: 903, floor: 884 }, passed: { pinned: 900, floor: 882 } })
  assert.deepEqual([...floors.erroredKnown], ['scripts/x.test.mjs'])
  assert.throws(() => parseSuiteFloors('electron\t5\t5\nui\t5\t5\n'), /no collected count for the python part/)
  assert.throws(() => parseSuiteFloors('electron\t5\nui\t5\t5\npython\t5\t5\n'), /no passed count for the electron/)
  const runs = (cold, warm = cold) => [cold, warm].map(python => ({ electron: vt, ui: vt, python }))
  const broken = list => list.filter(v => !v.ok).map(v => v.name)
  // Failing tests alone, above the passed floor, keep the run valid.
  const pyFails = { ...py(rec(coll(903), fin(890, 10, 3)), oneFail), errors: 0 }
  assert.deepEqual(broken(suiteValidity(runs(pyClean), floors)), [])
  assert.deepEqual(broken(suiteValidity(runs(pyFails), floors)), [])
  // Mutant: a run killed early — one pytest process collected and never finished.
  const killed = py(rec(coll(500), fin(497, 0, 3), coll(403)))
  assert.deepEqual(broken(suiteValidity(runs(killed), floors)), [
    'python: tests collected but not executed (more of cold and warm)',
    'python: tests passed (fewer of cold and warm)'
  ])
  // Mutant: a vitest run whose report lists tests it never reached.
  const cut = vitestCounts(report([...a('passed', 4), { status: '', fullName: 'never reached' }]), 1)
  assert.ok(
    broken(suiteValidity([{ electron: cut, ui: vt, python: pyClean }, runs(pyClean)[1]], floors)).includes(
      'electron: tests collected but not executed (more of cold and warm)'
    )
  )
  // Mutant: tests failing at setup — collected and executed in full, but the passed count drops under its floor.
  const setup = py(rec(coll(903), fin(600, 300, 3)))
  assert.deepEqual(broken(suiteValidity(runs(setup), floors)), ['python: tests passed (fewer of cold and warm)'])
  // Mutant: an errored file.
  assert.deepEqual(broken(suiteValidity(runs({ ...pyClean, errors: 1 }), floors)), [
    'test files errored (load / collection errors, crashes, unexplained non-zero exit)'
  ])
  // Fewer collected, and cold != warm.
  const fewer = py(rec(coll(880), fin(877, 0, 3)))
  assert.ok(broken(suiteValidity(runs(fewer), floors)).includes('python: tests collected (fewer of cold and warm)'))
  const warm = py(rec(coll(902), fin(899, 0, 3)))
  assert.deepEqual(broken(suiteValidity(runs(pyClean, warm), floors)), [
    'tests collected, cold minus warm (absolute, summed over the parts)'
  ])
  // The pinned file parses, names its source run, and floors both columns.
  const pinned = loadSuiteFloors()
  assert.deepEqual(Object.keys(pinned.parts), ['electron', 'ui', 'python'])
  assert.deepEqual([...pinned.erroredKnown], ['scripts/after-pack.test.mjs'])
  const text = readFileSync(new URL('../baselines/gates.suite.collected.tsv', import.meta.url), 'utf8')
  assert.match(
    text,
    /^# gates\.suite: tests collected and tests passed .* full bench run on \d{4}-\d\d-\d\d\n# at commit [0-9a-f]{10} /
  )
  assert.match(text, /\npart\tcollected\tpassed\t/)
  // End to end through run.mjs: a broken guard is INVALID (never MISSES), failures alone MEET.
  const row = p =>
    fixtureRow(
      'g.fix',
      `async measure() {
         const { suiteValidity } = await import('${gates}')
         const v = ${JSON.stringify(vt)}, p = ${JSON.stringify(p)}
         const floors = ${JSON.stringify({ ...floors, erroredKnown: undefined })}
         return { cold: [1, 2], extra: { validity: suiteValidity([p, p].map(python => ({ electron: v, ui: v, python })), floors) } }
       }, ${GOOD_CONTROL}`
    )
  const met = runFixture({ 'g.fix.mjs': row(pyFails) })
  assert.equal(met.code, 0, met.stderr)
  assert.equal(met.doc.rows[0].verdict, 'MEETS')
  for (const bad of [killed, setup, { ...pyClean, errors: 1 }]) {
    const res = runFixture({ 'g.fix.mjs': row(bad) })
    assert.equal(res.code, 0, res.stderr)
    const r = res.doc.rows[0]
    assert.equal(r.verdict, 'INVALID')
    assert.match(r.decision, /^not counted \(invalid: /)
    assert.equal(res.doc.invalid_rows, 1)
    assert.match(readFileSync(join(res.out, 'table.md'), 'utf8'), /\| INVALID: /)
  }
  assert.throws(
    () => validateResult({ ...met.doc, rows: [{ ...met.doc.rows[0], validity: [{ ok: false }] }] }),
    /with a failed validity guard/
  )
})

test('cool-down: waits for load under 4.0, polls every 10 s, stops at its cap', async () => {
  const fake = loads => {
    let t = 0
    const slept = []
    let i = 0
    return {
      slept,
      opts: {
        loadFn: () => ({ one: loads[Math.min(i++, loads.length - 1)], five: 0, fifteen: 0 }),
        sleep: async ms => {
          slept.push(ms)
          t += ms
        },
        now: () => t
      }
    }
  }
  const settle = fake([6, 5, 3.5])
  const a = await coolDown({ maxS: 600, ...settle.opts })
  assert.deepEqual([a.waited_s, a.capped, a.load_at_start.one], [20, false, 3.5])
  assert.deepEqual(settle.slept, [10000, 10000])
  const busy = fake([9])
  const b = await coolDown({ maxS: 25, ...busy.opts })
  assert.deepEqual([b.waited_s, b.capped, b.max_s], [25, true, 25])
  assert.deepEqual(busy.slept, [10000, 10000, 5000])
  const none = fake([9])
  assert.deepEqual([(await coolDown({ maxS: 0, ...none.opts })).capped, none.slept], [true, []])
  const quiet = fake([1])
  assert.equal((await coolDown({ maxS: 600, ...quiet.opts })).waited_s, 0)
  for (const bad of ['-1', '1.5', 'x']) {
    const res = spawnSync(process.execPath, [RUN, '--cooldown-max', bad], { encoding: 'utf8' })
    assert.equal(res.status, 2)
    assert.match(res.stderr, /--cooldown-max needs a whole number of seconds/)
  }
})

test('gates.suite: the pre-existing list labels failures and sets apart files that error on main, by exact path', async () => {
  const gates = new URL('../rows/gates.suite.mjs', import.meta.url).href
  const { failureReport, loadKnownElectron, parseKnownFailures, vitestCounts } = await import(gates)
  const real = loadKnownElectron()
  assert.equal(real.tests.size, 4)
  assert.deepEqual([...real.files], ['scripts/after-pack.test.mjs'])
  // Every bare file on the list is one the pinned run also saw error (R3-02: nothing that passed there is waived).
  const pinnedErrored = (await import(gates)).loadSuiteFloors().erroredKnown
  assert.ok([...real.files].every(f => pinnedErrored.has(f)))
  const header = readFileSync(new URL('../known_failures/gates.suite.electron.txt', import.meta.url), 'utf8')
  assert.match(header.split('\n')[0], /pre-existing on main 047ca895c5/)
  const known = parseKnownFailures('# c\nelectron/a.test.ts :: suite one\nscripts/b.test.mjs\n')
  const D = '/tmp/x/wt/apps/desktop/'
  const file = (name, failed, status = 'failed') => ({
    name: D + name,
    status,
    assertionResults: failed.map(fullName => ({ status: 'failed', fullName }))
  })
  const report = results => ({
    numTotalTests: 50,
    numTotalTestSuites: 4,
    numFailedTests: results.reduce((n, f) => n + f.assertionResults.length, 0),
    testResults: results
  })
  // The listed test still counts as failed (reported); the listed errored file is kept out of `errors`.
  const onlyKnown = vitestCounts(
    report([file('electron/a.test.ts', ['suite one']), file('scripts/b.test.mjs', [])]),
    1,
    known
  )
  assert.deepEqual([onlyKnown.failed, onlyKnown.errors, onlyKnown.errors_known, onlyKnown.on_known_list], [1, 0, 1, 2])
  // A same-named test in another file, a near-miss name and an unlisted errored file are not on the list.
  const other = vitestCounts(
    report([
      file('electron/a.test.ts', ['suite one', 'suite one ']),
      file('electron/c.test.ts', ['suite one']),
      file('scripts/d.test.mjs', [])
    ]),
    1,
    known
  )
  assert.deepEqual([other.failed, other.errors, other.errors_known, other.on_known_list], [3, 1, 0, 1])
  assert.deepEqual(other.failing, [
    'electron/a.test.ts :: suite one',
    'electron/a.test.ts :: suite one ',
    'electron/c.test.ts :: suite one',
    'scripts/d.test.mjs'
  ])
  // Without the list (the ui part) every errored file counts.
  assert.equal(vitestCounts(report([file('scripts/b.test.mjs', [])]), 1).errors, 1)
  // results.json carries the count and the first 50 ids; the full list goes to the scratch, never a path in results.
  const dir = tempDir()
  const many = { failed: 60, failing: Array.from({ length: 60 }, (_, i) => `tests/pm/test_${i}.py::t`) }
  const rep = failureReport(dir, 'cold', 'python', many)
  assert.deepEqual([rep.failed, rep.on_known_list, rep.first_ids.length], [60, null, 50])
  assert.equal(readFileSync(join(dir, 'cold-python.failures.txt'), 'utf8').trim().split('\n').length, 60)
  assert.ok(!rep.full_list.includes(dir))
})

test('a child result larger than the pipe buffer arrives whole', async () => {
  const dir = tempDir()
  const lib = new URL('../lib/child_result.mjs', import.meta.url).href
  const make = 'Array.from({ length: 40000 }, (_, i) => ({ i, pad: "x".repeat(24) }))'
  // Through the result file: the child exits the moment it has written (the case that cut stdout at 64 KiB).
  const viaFile = join(dir, 'file-child.mjs')
  writeFileSync(
    viaFile,
    `import { writeResult } from '${lib}'\nwriteResult(process.argv[2], ${make})\nprocess.exit(0)\n`
  )
  const result = newResultFile(dir)
  const got = readResult(result, await run(process.execPath, [viaFile, result]), 'file child')
  assert.ok(readFileSync(result, 'utf8').length > 2 ** 20, 'the fixture must exceed 1 MiB')
  assert.equal(got.length, 40000)
  assert.deepEqual(got.at(-1), { i: 39999, pad: 'x'.repeat(24) })
  // A missing result file is a harness error, never an empty result.
  const silent = join(dir, 'silent-child.mjs')
  writeFileSync(silent, 'process.exit(0)\n')
  const none = newResultFile(dir)
  assert.throws(() => readResult(none, { code: 0, stderr: '' }, 'silent child'), HarnessError)
  assert.throws(() => readResult(none, { code: 3, stderr: 'boom' }, 'silent child'), /exited 3: boom/)
  // run() itself buffers stdout until 'close': a child that drains before exiting is read whole.
  const viaStdout = join(dir, 'stdout-child.mjs')
  writeFileSync(viaStdout, `process.stdout.write(JSON.stringify(${make}) + '\\n')\n`)
  const out = await run(process.execPath, [viaStdout])
  assert.ok(out.stdout.length > 2 ** 20)
  assert.equal(JSON.parse(out.stdout).length, 40000)
})

test('--keep keeps the row scratch (with what the row wrote into it) and names it in results.json', () => {
  const row = fixtureRow(
    'k.row',
    `async measure(ctx) {
       ;(await import('node:fs')).writeFileSync(ctx.scratch + '/cold-electron.json', '{}')
       return { cold: [1, 2] }
     }, ${GOOD_CONTROL}`
  )
  const kept = runFixture({ 'k.row.mjs': row }, ['--keep'])
  assert.equal(kept.code, 0, kept.stderr)
  const dir = kept.doc.rows[0].scratch_kept
  assert.ok(dir && existsSync(join(dir, 'cold-electron.json')), 'the scratch was not kept')
  tempDirs.push(dir)
  const gone = runFixture({ 'k.row.mjs': row })
  assert.equal(gone.doc.rows[0].scratch_kept, undefined)
})

// A lock tool whose acquire waits, then marks the window held; release removes the mark. The fake load source below
// reads the marks: the load "rises during the acquire wait" for the windows named in \`loud\`.
const SLOW_LOCK = `import json, os, sys, time, urllib.parse
marks = os.environ['FAKE_LOCK_MARKS']
cmd, who = sys.argv[1], sys.argv[sys.argv.index('--who') + 1]
mark = os.path.join(marks, urllib.parse.quote(who, safe=''))
if cmd == 'acquire':
    time.sleep(0.2)
    open(mark, 'w').close()
    print(json.dumps({'ok': True}))
else:
    os.remove(mark)
    print(json.dumps({'released': True, 'held_s': 0, 'overheld': False}))
`
test('load is re-checked once each window is held: a rise during the acquire wait makes the row or part unclean', async () => {
  const dir = tempDir()
  const tool = join(dir, 'slow_lock.py')
  const marks = join(dir, 'held')
  const rowsDir = join(dir, 'rows')
  mkdirSync(marks)
  mkdirSync(rowsDir)
  writeFileSync(tool, SLOW_LOCK)
  const plain = `async measure() { return { cold: [10, 20] } }, ${GOOD_CONTROL}`
  writeFileSync(join(rowsDir, 'a.row.mjs'), fixtureRow('a.row', plain))
  writeFileSync(
    join(rowsDir, 'b.row.mjs'),
    fixtureRow(
      'b.row',
      `async measure(ctx) { await ctx.window.renew('bench:b.row:part2'); return { cold: [10, 20] } }, ${GOOD_CONTROL}`
    )
  )
  writeFileSync(join(rowsDir, 'c.row.mjs'), fixtureRow('c.row', plain))
  const loud = new Set(['bench:a.row', 'bench:b.row:part2'])
  const loadFn = () => ({
    one: readdirSync(marks).some(m => loud.has(decodeURIComponent(m))) ? 9 : 1,
    five: 0,
    fifteen: 0
  })
  const saved = { BENCH_GPU_LOCK: process.env.BENCH_GPU_LOCK, FAKE_LOCK_MARKS: process.env.FAKE_LOCK_MARKS }
  Object.assign(process.env, { BENCH_GPU_LOCK: tool, FAKE_LOCK_MARKS: marks })
  let doc
  try {
    ;({ doc } = await runBench({ app: dir, rowsDir, out: join(dir, 'out'), mode: 'quick', cooldownMax: 0, loadFn }))
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
  }
  const [a, b, c] = ['a.row', 'b.row', 'c.row'].map(id => doc.rows.find(r => r.id === id))
  // a: quiet at the end of the cool-down, loaded once its window was held: unclean, both samples recorded.
  assert.deepEqual([a.load.before.one, a.load.at_measure.one, a.unclean], [1, 9, true])
  assert.match(a.unclean_reason, /load 9 >= 4 at measure start \(sampled after the window was acquired\)/)
  assert.deepEqual(
    a.windows.map(w => [w.who, w.held, w.load_at_acquire.one, w.clean]),
    [['bench:a.row', true, 9, false]]
  )
  assert.match(a.decision, /^repeat \(unclean: /)
  // b: its first window is quiet, the renewed part is not: the row is unclean and the reason names the part.
  assert.equal(b.load.at_measure.one, 1)
  assert.equal(b.unclean, true)
  assert.match(b.unclean_reason, /load 9 >= 4 at the start of bench:b\.row:part2/)
  assert.doesNotMatch(b.unclean_reason, /measure start/)
  assert.deepEqual(
    b.windows.map(w => [w.who, w.clean]),
    [
      ['bench:b.row', true],
      ['bench:b.row:part2', false]
    ]
  )
  // c: quiet throughout: clean, judged.
  assert.deepEqual([c.unclean, c.unclean_reason, c.load.at_measure.one], [false, null, 1])
  assert.match(c.decision, /^stays in Python/)
  assert.equal(doc.clean_rows, 1)
  assert.deepEqual(readdirSync(marks), [], 'a window was left held')
})

test('install.first_launch classes its miss by its dominant stage; the decision names the stage and its seconds', async () => {
  const { dominantStage } = await import('../rows/install.first_launch.mjs')
  const pkg = stages => Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, { p50: v, p95: v + 1 }]))
  const line = { bandwidth: 12_500_000, latencyMs: 20 }
  // The window-4 shape: the transfer over the simulated line dominates ('total' is not a stage).
  const net = dominantStage(
    {
      chromium: pkg({ download: 14100, unpack: 2000, verify: 1000, total: 17100 }),
      node: pkg({ download: 16100, unpack: 2400, verify: 1400, digest: 1100, publish: 800 })
    },
    [7000, 7200, 7400],
    line
  )
  assert.equal(net.class, 'network')
  assert.match(
    net.cause,
    /^download 30\.2 s of 45\.0 s of the cold first launch \(dominant stage, .*12\.5 MB\/s line with 20 ms/
  )
  assert.deepEqual(net.stage_ms, {
    download: 30200,
    unpack: 4400,
    verify: 2400,
    publish: 800,
    venv: 7200
  })
  const cpu = dominantStage({ node: pkg({ download: 1000, unpack: 9000 }) }, [500, 600, 700], line)
  assert.equal(cpu.class, 'cpu')
  assert.match(cpu.cause, /^unpack 9\.0 s of 10\.6 s /)
  assert.doesNotMatch(cpu.cause, /MB\/s/)
  const io = dominantStage({ node: pkg({ download: 1000 }) }, [8000, 9000, 10000], line)
  assert.deepEqual([io.class, io.cause.split(' (')[0]], ['io', 'venv 9.0 s of 10.0 s of the cold first launch'])
  assert.throws(() => dominantStage({ node: pkg({ download: 1 }) }, [], line), HarnessError)

  const row = { miss_class: 'network', budget: { stat: 'cold.p95' }, unit: 'ms', lang: 'Python' }
  const base = { verdict: 'MISSES', unclean: false, deficit: 1253, secondary: [] }
  assert.equal(
    decide(row, { ...base, miss_class: net.class, miss_cause: net.cause }),
    `fix in place (network): cold.p95 +1253 ms; cause: ${net.cause}`
  )
  assert.equal(
    decide(row, { ...base, miss_class: 'cpu', miss_cause: cpu.cause }),
    `candidate for a native port (cpu deficit: cold.p95 +1253 ms; cause: ${cpu.cause})`
  )
  // Through the runner: a measured class replaces the declared one; an unknown class is a harness error.
  const measured = cls =>
    fixtureRow(
      'm.row',
      `async measure() { return { cold: [150, 200], extra: { miss: { class: '${cls}', cause: 'download 9 s of 10 s' } } } }, ${GOOD_CONTROL}`
    )
  const ok = runFixture({ 'm.row.mjs': measured('network') })
  assert.equal(ok.code, 0, ok.stderr)
  assert.deepEqual(
    [ok.doc.rows[0].verdict, ok.doc.rows[0].miss_class, ok.doc.rows[0].miss_cause],
    ['MISSES', 'network', 'download 9 s of 10 s']
  )
  const bad = runFixture({ 'm.row.mjs': measured('disk') })
  assert.equal(bad.code, 2)
  assert.match(bad.doc.rows[0].error, /extra\.miss must be \{ class: cpu \| io \| network \| memory \| browser/)
})

// Two fake installers over the same packages, shaped as the harness writes a sample (packages, order, events): the
// serial one downloads each archive in its own turn; the overlapped one prefetches the NEXT package's archive while
// the current one unpacks and verifies (its own turn then finds the archive in the download cache). As the harness
// does, a download is credited to the package whose artifact it fetched, wherever it ran.
const FAKE_PACKAGES = [
  { name: 'ffmpeg', download: 2400, unpack: 100, verify: 500 },
  { name: 'node', download: 2600, unpack: 1900, verify: 900 },
  { name: 'npm', download: 300, unpack: 1100, verify: 0 },
  { name: 'python', download: 1500, unpack: 2500, verify: 200 },
  { name: 'ripgrep', download: 200, unpack: 50, verify: 20 },
  { name: 'chromium', download: 8000, unpack: 2000, verify: 1000 }
]
function fakeInstall({ prefetch, delay = null }) {
  const dl = p => p.download + (delay?.pkg === p.name ? delay.ms : 0)
  const events = []
  const packages = {}
  let t = 0
  let ready = 0
  FAKE_PACKAGES.forEach((p, i) => {
    const start = t
    let credited = dl(p)
    if (prefetch && i > 0) {
      t = Math.max(t, ready) // waits for its prefetched archive, then a cache hit
      events.push({ kind: 'download', packages: [p.name], t0: t, t1: t + 0.5 })
      t += 0.5
      credited += 0.5
    } else {
      events.push({ kind: 'download', packages: [p.name], t0: t, t1: t + dl(p) })
      t += dl(p)
    }
    const next = FAKE_PACKAGES[i + 1]
    if (prefetch && next) {
      events.push({ kind: 'download', packages: [next.name], t0: t, t1: t + dl(next) })
      ready = t + dl(next)
    }
    events.push({ kind: 'unpack', package: p.name, t0: t, t1: t + p.unpack })
    t += p.unpack
    events.push({ kind: 'verify', package: p.name, t0: t, t1: t + p.verify })
    t += p.verify
    events.push({ kind: 'install', package: p.name, t0: start, t1: t })
    packages[p.name] = {
      bytes: 1,
      download: credited,
      unpack: p.unpack,
      stage: 0,
      verify: p.verify,
      publish: 0,
      digest: 0,
      total: t - start
    }
  })
  return { total_ms: t, order: FAKE_PACKAGES.map(p => p.name), packages, events }
}
const VENV_MS = 6000
const fakeTaker = prefetch => async (name, injectPackage) => {
  const s = fakeInstall({ prefetch, delay: injectPackage ? { pkg: injectPackage, ms: 2000 } : null })
  return {
    total_ms: s.total_ms + VENV_MS,
    order: s.order,
    events: s.events,
    parts: { install_ms: s.total_ms, venv_stage_ms: VENV_MS }
  }
}

test('install.first_launch control: a delay on the first package in install order fires on both installers', async () => {
  const { delayControl } = await import('../rows/install.first_launch.mjs')
  for (const prefetch of [false, true]) {
    const c = await delayControl(fakeTaker(prefetch))
    assert.equal(c.detail.first_package, 'ffmpeg', 'the order comes from the base sample')
    assert.match(c.name, /first package in install order \(ffmpeg\) → first_launch_total grows/)
    assert.deepEqual([c.ok, c.value, c.base.length, c.variant.length], [true, 2000, 3, 3], `prefetch=${prefetch}`)
    assert.equal(c.base[0], c.detail.parts[0].base.install_ms + VENV_MS, 'samples are first_launch_total')
  }
  // Why the first package: the old control's package (ripgrep) is prefetched under python's unpack, so its 2 s delay
  // vanishes from the overlapped installer's wall time (the 0 ms the evidence run observed) but not the serial one's.
  const grows = prefetch =>
    fakeInstall({ prefetch, delay: { pkg: 'ripgrep', ms: 2000 } }).total_ms - fakeInstall({ prefetch }).total_ms
  assert.deepEqual([grows(false), grows(true)], [2000, 0])
  // An install order that changes between samples is a harness error, not a control result.
  let calls = 0
  const shifting = async () => ({ total_ms: 1, order: [calls++ === 0 ? 'ffmpeg' : 'node'], parts: {} })
  await assert.rejects(delayControl(shifting), HarnessError)
})

test('install.first_launch control: it fires only when the total AND every delayed download span grow', async () => {
  const { delayControl } = await import('../rows/install.first_launch.mjs')
  const { checkControls } = await import('../lib/runner.mjs')
  const fired = checkControls(await delayControl(fakeTaker(false)))[0]
  assert.deepEqual([fired.ok, fired.checks.length, fired.checks[0].ok, fired.checks[0].value], [true, 1, true, 2000])
  assert.deepEqual(fired.detail.download_span_ms, { base: [2400, 2400, 2400], delayed: [4400, 4400, 4400] })
  assert.match(fired.observed, /^total 2000 ms .*; ffmpeg download span grew by 2000\/2000\/2000 ms, min 2000 /)

  // Shared bandwidth hides the delay in the total: the download span grew, first_launch_total did not.
  const hidden = async (name, injectPackage) => {
    const real = await fakeTaker(false)(name, injectPackage)
    const plain = await fakeTaker(false)(name, null)
    return { ...real, total_ms: plain.total_ms }
  }
  const h = checkControls(await delayControl(hidden))[0]
  assert.deepEqual([h.ok, h.checks[0].ok], [false, true], 'a total that did not grow must not fire')
  assert.ok(h.value < h.threshold)
  assert.match(h.observed, /^total 0 ms /)

  // The total grew, but one delayed sample's own download of the first package did not: every delayed sample must
  // show the delay in its own events.
  const elsewhere = async (name, injectPackage) => {
    const plain = await fakeTaker(false)(name, null)
    if (!injectPackage) {
      return plain
    }
    const real = await fakeTaker(false)(name, injectPackage)
    return name === 'control-delay-1' ? { ...real, events: plain.events } : real
  }
  const e = checkControls(await delayControl(elsewhere))[0]
  assert.equal(e.value >= e.threshold, true, 'the total alone would have fired')
  assert.deepEqual([e.ok, e.checks[0].ok, e.checks[0].value], [false, false, 0])
  assert.match(e.observed, /grew by 2000\/0\/2000 ms, min 0 /)

  // A run whose control does not fire is INVALID (exit 3), never a good number; a check whose ok lies is refused.
  const r = runFixture({
    'k.row.mjs': fixtureRow(
      'k.row',
      `async measure() { return { cold: [10, 20] } },
       async control() { return ${JSON.stringify({ ...h, detail: undefined })} }`
    )
  })
  assert.equal(r.code, 3, r.stderr)
  assert.equal(r.doc.status, 'invalid')
  assert.match(readFileSync(join(r.out, 'table.md'), 'utf8'), /\*\*DID NOT FIRE\*\*.*; and ffmpeg download span/)
  const lie = { ...e, ok: true }
  assert.throws(() => checkControls(lie), /ok=true contradicts .* and 0\/1 check\(s\) holding/)
  assert.throws(() => checkControls({ ...fired, checks: [{ ...fired.checks[0], ok: false }] }), /checks\[0\]/)
})

// A fake bench context for the install row's control: python children are answered in-process from the fake
// installer, and the venv samples fail the way uv does when the shipped cache is missing (network blocked).
function fakeInstallCtx(dir, calls, { warmupBuildsCache = true } = {}) {
  return {
    scratch: dir,
    app: dir,
    keep: false,
    mode: 'quick',
    log() {},
    coolDown: async () => ({ waited_s: 0, capped: false, load_at_start: { one: 1 } }),
    sh: async (cmd, args) => {
      mkdirSync(args.at(-1), { recursive: true })
      return { code: 0, stdout: '', stderr: '' }
    },
    python: async args => {
      const arg = k => args[args.indexOf(k) + 1]
      let result = { python_version: '3.11' }
      if (args[3] === 'prime') {
        calls.push('prime')
      } else if (args.includes('--venv') && args.includes('--uv-cache-ship')) {
        calls.push('venv warm-up')
        if (warmupBuildsCache) {
          mkdirSync(arg('--uv-cache-ship'), { recursive: true })
        }
        result = { packages: { venv: { total: 30000 }, uv: { total: 100 } } }
      } else if (args.includes('--venv')) {
        calls.push('venv sample')
        if (!existsSync(arg('--uv-cache-payload'))) {
          writeFileSync(arg('--out'), JSON.stringify({ failed: ['uv: setuptools not in the cache, network blocked'] }))
          return { code: 1, stdout: '', stderr: 'uv failed' }
        }
        result = { packages: { venv: { total: VENV_MS - 100 }, uv: { total: 100 } } }
      } else {
        calls.push('install sample')
        const pkg = args.includes('--inject-package') ? arg('--inject-package') : null
        result = fakeInstall({
          prefetch: false,
          delay: pkg ? { pkg, ms: 1000 * Number(arg('--inject-delay-s')) } : null
        })
      }
      writeFileSync(arg('--out'), JSON.stringify(result))
      return { code: 0, stdout: '', stderr: '' }
    }
  }
}

test('install.first_launch control: its own venv warm-up runs before any control sample, without measure()', async () => {
  const { default: row } = await import('../rows/install.first_launch.mjs')
  // A fresh scratch: measure() never ran, so no shipped uv cache exists (the --control-only case).
  const dir = tempDir()
  const calls = []
  const c = await row.control(fakeInstallCtx(dir, calls))
  const warm = calls.indexOf('venv warm-up')
  assert.ok(warm >= 0, JSON.stringify(calls))
  assert.ok(
    calls.findIndex(x => x.endsWith('sample')) > warm,
    `a control sample ran before the warm-up: ${JSON.stringify(calls)}`
  )
  assert.deepEqual(
    [calls.filter(x => x === 'venv warm-up').length, calls.filter(x => x === 'venv sample').length],
    [1, 6]
  )
  assert.equal(calls[0], 'prime', 'the artifact cache is primed before the warm-up')
  assert.equal(c.ok, true)
  assert.deepEqual([c.detail.venv_warmup.sample, c.detail.venv_warmup.venv_stage_ms], [false, 30100])
  assert.equal(typeof c.detail.venv_warmup.samples_done_s_after, 'number')
  assert.equal(c.detail.sample_cooldowns.length, 12)
  const left = readdirSync(dir).filter(f => f !== 'uv-cache-shipped' && !f.endsWith('.json'))
  assert.deepEqual(left, [], 'a clone or work directory was left in the scratch')
  // The same control without a cache to resolve from fails as uv does offline: a harness error, never a number.
  await assert.rejects(row.control(fakeInstallCtx(tempDir(), [], { warmupBuildsCache: false })), /uv: setuptools/)
})

test('install.first_launch stages: serial spans are attributable; overlapped downloads are not, never a negative other', async () => {
  const { downloadOverlaps, stageReport, dominantStage, NOT_ATTRIBUTABLE } =
    await import('../rows/install.first_launch.mjs')
  const serial = [fakeInstall({ prefetch: false }), fakeInstall({ prefetch: false })]
  const overlapped = [fakeInstall({ prefetch: true }), fakeInstall({ prefetch: true })]
  assert.deepEqual(downloadOverlaps(serial[0].events), [])
  const seen = downloadOverlaps(overlapped[0].events)
  assert.ok(
    seen.some(o => o.download === 'node' && o.during === 'unpack of ffmpeg'),
    JSON.stringify(seen)
  )
  assert.deepEqual(downloadOverlaps([{ kind: 'download', packages: ['a', 'b'], t0: 0, t1: 5 }]), [
    { download: 'a+b', during: 'one call for several packages', ms: 5 }
  ])
  assert.throws(() => downloadOverlaps(undefined), HarnessError)

  const s = stageReport(serial)
  assert.equal(s.attributable, true)
  assert.deepEqual([s.packages.node.download.p50, s.packages.node.other.p50], [2600, 0])
  const o = stageReport(overlapped)
  assert.deepEqual([o.attributable, o.stages], [false, NOT_ATTRIBUTABLE])
  assert.ok(o.overlap_count > 0)
  for (const [name, pkg] of Object.entries(o.packages)) {
    assert.ok(!('download' in pkg) && !('other' in pkg), `${name} reports a non-attributable stage`)
  }
  // Hand-made nesting (a hook inside another): the remainder is clamped and the double count reported.
  const nested = stageReport([
    { order: ['x'], packages: { x: { bytes: 1, download: 10, unpack: 80, verify: 30, total: 100 } }, events: [] }
  ])
  assert.deepEqual([nested.packages.x.other.p50, nested.packages.x.overcount.p50], [0, 20])
  const negatives = JSON.stringify([s, o, nested]).match(/"p(50|95)":-/g)
  assert.equal(negatives, null, 'a negative stage time was emitted')

  // The miss, from what is attributable only: unowned time that dominates is `unattributed`, never `network`.
  const line = { bandwidth: 12_500_000, latencyMs: 20 }
  const firstLaunch = overlapped[0].total_ms + VENV_MS
  const un = dominantStage(o.packages, [VENV_MS], line, { firstLaunchMs: firstLaunch })
  assert.equal(un.class, 'unattributed')
  assert.match(un.cause, /s of .* s of the cold first launch is not attributable to a stage \(downloads overlap/)
  assert.ok(Object.values(un.stage_ms).every(v => v >= 0))
  // The fake's prefetch leaves ~10 s of download waits no stage owns (above); with 1 s unowned, unpack (7.65 s) leads.
  const cpu = dominantStage(o.packages, [VENV_MS], line, { firstLaunchMs: 7650 + 2620 + VENV_MS + 1000 })
  assert.equal(cpu.class, 'cpu')
  assert.match(
    cpu.cause,
    /^unpack 7\.7 s of 17\.3 s .*\(dominant attributable stage, .*; 1\.0 s not attributable: downloads overlap/
  )
  assert.equal(cpu.stage_ms.unattributed, 1000)
  const row = { miss_class: 'network', budget: { stat: 'cold.p95' }, unit: 'ms', lang: 'Python' }
  assert.equal(
    decide(row, {
      verdict: 'MISSES',
      unclean: false,
      deficit: 10,
      secondary: [],
      miss_class: un.class,
      miss_cause: un.cause
    }),
    `not classed (unattributed): cold.p95 +10 ms; cause: ${un.cause}`
  )
})

test('install.first_launch stages: a prefetch that only overlaps another download still makes a sample not attributable', async () => {
  const { downloadOverlaps, stageReport, NOT_ATTRIBUTABLE } = await import('../rows/install.first_launch.mjs')
  // ripgrep's small archive is prefetched and done while node's own download is still running: no unpack or verify
  // overlaps it, but its download lies outside ripgrep's install span, so ripgrep's stages cannot be attributed.
  const events = [
    { kind: 'install', package: 'node', t0: 0, t1: 3000 },
    { kind: 'download', packages: ['node'], t0: 0, t1: 2400 },
    { kind: 'download', packages: ['ripgrep'], t0: 100, t1: 300 },
    { kind: 'unpack', package: 'node', t0: 2400, t1: 2500 },
    { kind: 'verify', package: 'node', t0: 2500, t1: 3000 },
    { kind: 'install', package: 'ripgrep', t0: 3000, t1: 3100 },
    { kind: 'download', packages: ['ripgrep'], t0: 3000, t1: 3000.5 },
    { kind: 'unpack', package: 'ripgrep', t0: 3000.5, t1: 3050 },
    { kind: 'verify', package: 'ripgrep', t0: 3050, t1: 3100 }
  ]
  const seen = downloadOverlaps(events)
  assert.deepEqual(seen, [
    { download: 'node', during: 'download of ripgrep', ms: 200 },
    { download: 'ripgrep', during: 'outside the install span of ripgrep', ms: 200 },
    { download: 'ripgrep', during: 'download of node', ms: 200 }
  ])
  assert.ok(!seen.some(o => /unpack|verify/.test(o.during)), 'the case has no unpack/verify overlap')
  const pkg = (download, total) => ({ bytes: 1, download, unpack: 50, stage: 0, verify: 50, publish: 0, total })
  const sample = { order: ['node', 'ripgrep'], packages: { node: pkg(2400, 3000), ripgrep: pkg(200.5, 100) }, events }
  const r = stageReport([sample])
  assert.deepEqual([r.attributable, r.stages], [false, NOT_ATTRIBUTABLE])
  assert.equal(r.overlap_count, 3)
  assert.ok(!('download' in r.packages.ripgrep), 'a prefetched download was attributed to a stage')
  // The same timeline without the prefetch is serial; a download with no install span of its own is not.
  const serial = events.filter(e => !(e.kind === 'download' && e.t0 === 100))
  assert.deepEqual(downloadOverlaps(serial), [])
  assert.deepEqual(downloadOverlaps(serial.filter(e => !(e.kind === 'install' && e.package === 'ripgrep'))), [
    { download: 'ripgrep', during: 'outside the install span of ripgrep', ms: 0.5 }
  ])
})

test('--out or BENCH_OUT_ROOT inside the repository checkout is refused (exit 2) before any row runs', () => {
  const checkout = join(dirname(RUN), '..')
  const rowsDir = join(tempDir(), 'rows')
  mkdirSync(rowsDir)
  const ran = join(dirname(rowsDir), 'ran')
  writeFileSync(
    join(rowsDir, 'o.row.mjs'),
    fixtureRow(
      'o.row',
      `async measure() { (await import('node:fs')).writeFileSync(${JSON.stringify(ran)}, 'x'); return { cold: [1, 2] } }, ${GOOD_CONTROL}`
    )
  )
  const inside = join(checkout, 'bench', 'never-written-results')
  const runWith = (args, env) =>
    spawnSync(process.execPath, [RUN, '--rows', rowsDir, '--cooldown-max', '0', ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
      env: { ...process.env, BENCH_GPU_LOCK: '', BENCH_OUT_ROOT: '', ...env }
    })
  for (const [args, env, source] of [
    [['--out', inside], {}, '--out'],
    [['--out', checkout], {}, '--out'],
    [[], { BENCH_OUT_ROOT: join(checkout, 'bench') }, 'BENCH_OUT_ROOT']
  ]) {
    const r = runWith(args, env)
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, new RegExp(`${source} resolves inside the repository checkout`))
  }
  assert.equal(existsSync(inside), false, 'a results directory was created inside the checkout')
  assert.equal(existsSync(ran), false, 'a row ran although its results could not be written')
  // Outside the checkout it runs (the other tests all write to a temp directory).
  const ok = runWith(['--out', join(dirname(rowsDir), 'out')], {})
  assert.equal(ok.status, 0, ok.stderr)
})

test('an ERROR row is not printed as a judged number; its error is cut at a word or line boundary', async () => {
  const { clip, clipTail } = await import('../lib/table.mjs')
  const long = `${'harness exploded while reading the sample '.repeat(20)}tail`
  const r = runFixture({
    'e.row.mjs': fixtureRow(
      'e.row',
      `async measure() { return { cold: [10, 20], warm: [5, 6], extra: { secondary: [
         { name: 'mem', value: 1, unit: 'MB', budget: 2, op: '<=', ok: true }] } } },
       async control() { throw new Error(${JSON.stringify(long)}) }`
    )
  })
  assert.equal(r.code, 2, r.stderr)
  const row = r.doc.rows[0]
  assert.equal(row.verdict, 'ERROR')
  assert.deepEqual(
    [row.cold.p50, row.warm.p50, row.secondary[0].value],
    [10, 5, 1],
    'results.json keeps the raw values'
  )
  const line = readFileSync(join(r.out, 'table.md'), 'utf8')
    .split('\n')
    .find(l => l.startsWith('| e.row |'))
  const cells = line.split(' | ')
  assert.deepEqual([cells[2], cells[3], cells[6]], ['(unjudged)', '(unjudged)', '(unjudged)'])
  assert.doesNotMatch(line, /10 \/ 20/)
  const err = cells[7]
  assert.match(err, /^ERROR: Error: harness exploded .* …$/)
  assert.ok(err.length <= 'ERROR: '.length + 400, err.length)
  assert.match(err, /sample …$|the …$|while …$|reading …$|exploded …$|harness …$/, 'cut mid-word')
  assert.match(r.stdout, /measured=\(unjudged\)/)

  assert.equal(clip('short', 10), 'short')
  assert.equal(clip('alpha beta gamma delta', 14), 'alpha beta …')
  assert.equal(clip('first line\nsecond line here', 20), 'first line …')
  assert.equal(clip('x'.repeat(30), 10).length, 10, 'one long word is cut hard')
  assert.equal(clipTail('alpha beta gamma delta', 14), '… gamma delta')
  assert.equal(clipTail('one\ntwo three four', 16), '… two three four')
})

test('ctx.coolDown: a per-sample wait is recorded, and one that hits its cap makes the row unclean', async () => {
  const dir = tempDir()
  const rowsDir = join(dir, 'rows')
  mkdirSync(rowsDir)
  const body = busy => `async measure(ctx) {
    globalThis.__benchBusy = ${busy}
    const w = await ctx.coolDown('sample-1', { maxS: 0 })
    globalThis.__benchBusy = false
    return { cold: [10, 20], extra: { wait: w } }
  }, ${GOOD_CONTROL}`
  writeFileSync(join(rowsDir, 'quiet.row.mjs'), fixtureRow('quiet.row', body(false)))
  writeFileSync(join(rowsDir, 'busy.row.mjs'), fixtureRow('busy.row', body(true)))
  const loadFn = () => ({ one: globalThis.__benchBusy ? 9 : 1, five: 0, fifteen: 0 })
  const { doc } = await runBench({ app: dir, rowsDir, out: join(dir, 'out'), mode: 'quick', cooldownMax: 0, loadFn })
  const [quiet, busy] = ['quiet.row', 'busy.row'].map(id => doc.rows.find(r => r.id === id))
  assert.deepEqual(
    [quiet.extra.wait.before, quiet.extra.wait.capped, quiet.extra.wait.waited_s],
    ['sample-1', false, 0]
  )
  assert.doesNotMatch(String(quiet.unclean_reason), /before sample-1/)
  assert.equal(busy.extra.wait.capped, true)
  assert.equal(busy.unclean, true)
  assert.match(busy.unclean_reason, /load 9 still >= 4 after the 0 s cool-down before sample-1/)
})
