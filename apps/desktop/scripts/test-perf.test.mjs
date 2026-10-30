// K127: an all-skipped perf run is a failure, never "ok" (V3-K fix critic r2 m6).
// G3-5: ok only when every @perf test ran (a partial run under load is NOT-RUN, exit 3), and the runner's exit code —
// what the gate reads — is proven end to end against a stub vitest (m-A1), with the child's ICLONE_PERF and filter.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { PERF_NAME_FILTER, PERF_NOT_RUN_EXIT, perfVerdict } from './test-perf.mjs'

const file = (statuses, status = 'passed', names = statuses.map((_, i) => `t${i} @perf`)) => ({
  assertionResults: statuses.map((s, i) => ({ fullName: names[i], status: s })),
  status
})

describe('perfVerdict', () => {
  it('fails a run where every @perf test skipped (the r2 gate: 0 of 104 ran, reported ok)', () => {
    const report = { testResults: [file(Array(100).fill('skipped')), file(Array(4).fill('pending'))] }
    const verdict = perfVerdict(report, { exitCode: 0, loadSkips: 5 })

    expect(verdict.ok).toBe(false)
    expect(verdict.ran).toBe(0)
    expect(verdict.skipped).toBe(104)
    expect(verdict.line).toBe(
      'test:perf FAIL: 0 @perf ran (0 passed, 0 failed), 104 skipped (5 for load): nothing was measured (a loaded machine skips every @perf test; re-run when idle)'
    )
  })

  it("passes when every @perf test ran and none failed (the -t filter's other skips do not count), and says how many", () => {
    const verdict = perfVerdict({
      testResults: [file(['passed', 'skipped', 'skipped'], 'passed', ['a @perf', 'b', 'c']), file(['passed'])]
    })

    expect(verdict.ok).toBe(true)
    expect(verdict.exitCode).toBe(0)
    expect(verdict.ran).toBe(2)
    expect(verdict.perfTests).toBe(2)
    expect(verdict.line).toBe('test:perf ok: 2 @perf ran (2 passed, 0 failed), 2 skipped (0 for load)')
  })

  it('G3-5 — a partial run under load is NOT-RUN with the count (exit 3), never ok', () => {
    // 1 of 5 @perf ran; 4 skipped for load (G7, R2, …): four budgets unmeasured — the critic's m-A2 case.
    const report = {
      testResults: [file(['passed', 'skipped', 'skipped', 'skipped', 'skipped']), file(['skipped'], 'passed', ['x'])]
    }
    const verdict = perfVerdict(report, { exitCode: 0, loadSkips: 4 })

    expect(verdict.ok).toBe(false)
    expect(verdict.notRun).toBe(true)
    expect(verdict.exitCode).toBe(PERF_NOT_RUN_EXIT)
    expect(PERF_NOT_RUN_EXIT).toBe(3)
    expect(verdict.line).toBe(
      'test:perf NOT-RUN: 1 of 5 @perf ran (1 passed, 0 failed), 4 @perf skipped (4 for load): partial measurement: SKIP(load) on a busy machine; re-run when idle'
    )
  })

  it('G3-5 — a @perf test skipped without a load reason is a FAIL, and so is one more skip than the load notes', () => {
    const report = { testResults: [file(['passed', 'skipped', 'skipped'])] }

    expect(perfVerdict(report, { loadSkips: 0 })).toMatchObject({ ok: false, notRun: false, exitCode: 1 })
    expect(perfVerdict(report, { loadSkips: 1 })).toMatchObject({ ok: false, notRun: false, exitCode: 1 })
    expect(perfVerdict(report, { loadSkips: 2 })).toMatchObject({ ok: false, notRun: true, exitCode: 3 })
    expect(perfVerdict(report, { loadSkips: 0 }).line).toMatch(/2 @perf test\(s\) skipped without a load reason/)
  })

  it('fails on a failed test, a file that did not load, a missing report or a non-zero vitest exit', () => {
    expect(perfVerdict({ testResults: [file(['passed', 'failed'])] }).ok).toBe(false)
    expect(perfVerdict({ testResults: [file(['passed']), file([], 'failed')] }).ok).toBe(false)
    expect(perfVerdict(null).ok).toBe(false)
    expect(perfVerdict({ testResults: [file(['passed'])] }, { exitCode: 1 }).ok).toBe(false)
  })

  it('a failure under load is still a FAIL, never NOT-RUN', () => {
    const verdict = perfVerdict({ testResults: [file(['failed', 'skipped'])] }, { exitCode: 1, loadSkips: 1 })

    expect(verdict).toMatchObject({ ok: false, notRun: false, exitCode: 1 })
  })

  it('is what `npm run test:perf` runs', () => {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'))

    expect(pkg.scripts['test:perf']).toBe('node scripts/test-perf.mjs')
  })
})

// ── m-A1: the exit code reaches the gate. The real runner (`run`) in a child node, against a stub vitest that writes
// the report it is told to, prints the SKIP(load) notes, records its argv and ICLONE_PERF, and exits with a given code.
const STUB = `import { writeFileSync } from 'node:fs'
const out = process.argv.find(arg => arg.startsWith('--outputFile.json='))?.slice('--outputFile.json='.length)
writeFileSync(process.env.STUB_RECORD, JSON.stringify({ argv: process.argv.slice(2), perf: process.env.ICLONE_PERF ?? null }))
for (const line of JSON.parse(process.env.STUB_STDOUT)) console.log(line)
if (process.env.STUB_REPORT !== 'none' && out) writeFileSync(out, process.env.STUB_REPORT)
process.exit(Number(process.env.STUB_EXIT))
`

const scratch = mkdtempSync(path.join(os.tmpdir(), 'iclone-test-perf-stub-'))
const stub = path.join(scratch, 'vitest-stub.mjs')

writeFileSync(stub, STUB)
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const runner = pathToFileURL(path.join(import.meta.dirname, 'test-perf.mjs')).href

function runPerf({ report, stdout = [], exit = 0 }) {
  const record = path.join(scratch, `record-${Math.random().toString(36).slice(2)}.json`)
  const env = {
    ...process.env,
    STUB_EXIT: String(exit),
    STUB_RECORD: record,
    STUB_REPORT: report,
    STUB_STDOUT: JSON.stringify(stdout)
  }

  delete env.ICLONE_PERF // the runner must set it on its child itself

  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const m = await import(${JSON.stringify(runner)}); m.run([], { vitest: ${JSON.stringify(stub)} })`
    ],
    { encoding: 'utf8', env, timeout: 20_000 }
  )

  return {
    code: child.status,
    last: child.stdout.trim().split('\n').at(-1),
    seen: JSON.parse(readFileSync(record, 'utf8'))
  }
}

const reportOf = statuses => JSON.stringify({ testResults: [file(statuses)] })

describe("G3-5 — the runner's exit code is the verdict (what the gate reads)", { timeout: 60_000 }, () => {
  it('every @perf test ran and passed → exit 0', () => {
    const result = runPerf({ report: reportOf(['passed', 'passed']) })

    expect(result.code).toBe(0)
    expect(result.last).toBe('test:perf ok: 2 @perf ran (2 passed, 0 failed), 0 skipped (0 for load)')
  })

  it('all skipped → exit 1; partial under load → exit 3; vitest exit 1 → exit 1; no report → exit 1', () => {
    const load = ['SKIP(load 14.0 > 9)', 'SKIP(load 14.0 > 9)']

    expect(runPerf({ report: reportOf(['skipped', 'skipped']), stdout: load }).code).toBe(1)
    expect(runPerf({ report: reportOf(['passed', 'skipped', 'skipped']), stdout: load })).toMatchObject({
      code: 3,
      last: expect.stringMatching(/^test:perf NOT-RUN: 1 of 3 @perf ran/)
    })
    expect(runPerf({ report: reportOf(['passed']), exit: 1 })).toMatchObject({
      code: 1,
      last: expect.stringMatching(/vitest exited 1$/)
    })
    expect(runPerf({ report: 'none' })).toMatchObject({ code: 1, last: expect.stringMatching(/no vitest report$/) })
  })

  it('the child vitest gets ICLONE_PERF=1, the perf project and exactly the "@perf$" filter', () => {
    const { seen } = runPerf({ report: reportOf(['passed']) })

    expect(seen.perf).toBe('1')
    expect(seen.argv.slice(0, 5)).toEqual(['run', '--project', 'perf', '-t', '@perf$'])
    expect(PERF_NAME_FILTER).toBe('@perf$')
  })
})
