import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { appendStop, foldAllRuns, leftRunningCount, parseRunLine, readRunEvents, type RunFiles } from './runs'

const made: string[] = []

function ledger(rows: readonly unknown[], older: readonly unknown[] = []): RunFiles {
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'fx21-'))

  made.push(ledgerDir)
  mkdirSync(ledgerDir, { recursive: true })
  writeFileSync(path.join(ledgerDir, 'runs.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n{torn')
  writeFileSync(path.join(ledgerDir, 'runs.jsonl.1'), older.map(row => JSON.stringify(row)).join('\n'))

  return { ledgerDir, refusedDir: ledgerDir, stopsFile: path.join(ledgerDir, 'stops') }
}

afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const always = () => true

test('a row with no end counts, an ended one does not, across the rotated file', () => {
  const files = ledger(
    [
      { ev: 'left-ended', run: 'a', pid: 10 },
      { ev: 'left-running', run: 'b', pid: 11 },
      { ev: 'end', run: 'c', pid: 12 },
      { ev: 'left-running', run: 'd', pid: 'x' }
    ],
    [{ ev: 'left-running', run: 'a', pid: 10 }]
  )

  expect(leftRunningCount(files, always)).toBe(1)
})

test('a row whose group is gone is a launcher that died first: it does not hold the quit', () => {
  const files = ledger([{ ev: 'left-running', run: 'b', pid: 11 }])

  expect(leftRunningCount(files, () => false)).toBe(0)
})

test('no ledger, no prompt', () => {
  expect(leftRunningCount({ ledgerDir: '/nonexistent/fx21', refusedDir: '', stopsFile: '' }, always)).toBe(0)
})

const SHA = 'a'.repeat(64)
const TOKEN = `project+${SHA.slice(0, 12)}+sess-1+${'1'.padStart(32, '0')}`
const at = (sec: number) => new Date(Date.parse('2026-11-01T10:00:00.000Z') + sec * 1_000).toISOString()

const START = {
  v: 1,
  ev: 'start',
  ts: at(0),
  run: TOKEN,
  pid: 1_001,
  kind: 'shell',
  cls: 'project',
  sha: SHA,
  session: 'sess-1',
  command: '( nohup server ) &',
  cwd: '/Users/me/p',
  project: '/Users/me/p',
  net: false,
  write: true
}

const END = { v: 1, ev: 'end', ts: at(1), run: TOKEN, pid: 1_001, code: 0, signal: null }
const LEFT = { v: 1, ev: 'left-running', ts: at(2), run: TOKEN, pid: 1_001 }
const member = { pid: 2_000, run: TOKEN }

const leftEnded = (over: Record<string, unknown> = {}) => ({
  v: 1,
  ev: 'left-ended',
  ts: at(60),
  run: TOKEN,
  pid: 1_001,
  stopped: false,
  why: null,
  ...over
})

function view(rows: readonly unknown[], fold: { verified: boolean; members?: readonly object[] }) {
  const [run] = foldAllRuns({
    nowMs: Date.parse(at(90)),
    events: readRunEvents(ledger(rows)),
    rows: (fold.members ?? []) as never,
    verified: fold.verified,
    refusals: new Map()
  })

  return run
}

test('fx22: what a run left running keeps it live, not "Exited 0", when the kernel holds it', () => {
  expect(view([START, END, LEFT], { verified: true, members: [member] })).toMatchObject({
    phase: 'background',
    live: 1,
    exitCode: 0
  })
})

test('fx22: with no kernel answer, the launcher word keeps it live', () => {
  expect(view([START, END, LEFT], { verified: false })).toMatchObject({ phase: 'background', live: 1 })
})

test('fx22: the kernel saying nobody is left is the end of it: a launcher that died says nothing more', () => {
  expect(view([START, END, LEFT], { verified: true })).toMatchObject({ phase: 'exited', live: 0, endedAt: at(1) })
})

test('fx22: it ended by itself: the time is the true end, the status the first process reported', () => {
  expect(view([START, END, LEFT, leftEnded()], { verified: true })).toMatchObject({
    phase: 'exited',
    exitCode: 0,
    endedAt: at(60)
  })
  expect(view([START, END, LEFT, leftEnded()], { verified: false })).toMatchObject({ phase: 'exited', live: 0 })
})

test.each(['quit', 'policy'])('fx22: the launcher stopped it (%s): stopped, at that time', why => {
  expect(view([START, END, LEFT, leftEnded({ stopped: true, why, survivors: 0 })], { verified: true })).toMatchObject({
    phase: 'stopped',
    endedAt: at(60)
  })
})

test('fx22: a policy stop says the mode stopped it, as a run still in its first process does', () => {
  const kill = { v: 1, ev: 'refused', ts: at(59), run: TOKEN, code: 'policy', detail: 'mode-denied' }

  expect(
    view([START, END, LEFT, kill, leftEnded({ stopped: true, why: 'policy' })], { verified: true })
  ).toMatchObject({ phase: 'stopped', stoppedByModes: true })
})

test('fx22: a quit that left survivors did not end it', () => {
  const row = leftEnded({ stopped: true, why: 'quit', survivors: 1 })

  expect(view([START, END, LEFT, row], { verified: false })).toMatchObject({ phase: 'background' })
  expect(view([START, END, LEFT, row], { verified: true, members: [member] })).toMatchObject({ phase: 'background' })
})

test('fx22: only the launcher journal can say it: the runtime reader drops the row', () => {
  expect(parseRunLine(JSON.stringify(LEFT))).toBeNull()
  expect(parseRunLine(JSON.stringify(leftEnded()))).toBeNull()
  expect(parseRunLine(JSON.stringify(LEFT), 'launcher')).toMatchObject({ ev: 'left-running', run: TOKEN })
})

test('fx22 (F-c): an open row of the running launcher counts though the group is gone: a setsid daemon', () => {
  const files = ledger([{ ev: 'left-running', run: 'b', pid: 11, ts: at(10) }])

  expect(leftRunningCount(files, () => false, Date.parse(at(5)))).toBe(1)
  expect(leftRunningCount(files, () => false)).toBe(0)
})

test('fx22 (F-c): a row from before this launcher started counts only while its group lives', () => {
  const files = ledger([{ ev: 'left-running', run: 'b', pid: 11, ts: at(1) }])

  expect(leftRunningCount(files, () => false, Date.parse(at(5)))).toBe(0)
  expect(leftRunningCount(files, pid => pid === 11, Date.parse(at(5)))).toBe(1)
})

test('fx23 (proof6 F1): a background command that ended says so, and the run never reads as its status', () => {
  expect(view([START, END, LEFT, leftEnded()], { verified: true })).toMatchObject({ phase: 'exited', backgroundEnded: true })
  expect(view([START, END, LEFT], { verified: true })).toMatchObject({ phase: 'exited', backgroundEnded: true })
  expect(view([START, { ...END, code: 3 }, LEFT, leftEnded()], { verified: true })).toMatchObject({ backgroundEnded: true })
})

test('fx23: the background wrapper says so too when its command was gone before the launcher looked', () => {
  const wrapped = { ...START, background: true }

  expect(view([wrapped, END], { verified: true })).toMatchObject({ phase: 'exited', backgroundEnded: true })
  // The wrapper itself failed: nothing was left, and that status is the wrapper's own to report.
  expect(view([wrapped, { ...END, code: 1 }], { verified: true })).toMatchObject({ phase: 'failed' })
  expect(view([wrapped, { ...END, code: 1 }], { verified: true }).backgroundEnded).toBeUndefined()
})

test('fx23: a plain run, a live one and a stopped one are not "background ended"', () => {
  expect(view([START, END], { verified: true }).backgroundEnded).toBeUndefined()
  expect(view([START, END, LEFT], { verified: true, members: [member] }).backgroundEnded).toBeUndefined()
  expect(view([START, END, LEFT, leftEnded({ stopped: true, why: 'stop' })], { verified: true }).backgroundEnded).toBeUndefined()
})

describe('g17: an approved background command runs outside the Seatbelt, so its process group says whether it lives', () => {
  const OUTSIDE = `oneshot+${'a'.repeat(12)}+outside+${'e'.repeat(32)}`
  const GROUP = 5_001
  const START_OUTSIDE = { ...START, run: OUTSIDE, pid: GROUP, unconfined: true, one_shot: 'e'.repeat(32), project: null }
  const END_OUTSIDE = { ...END, run: OUTSIDE, pid: GROUP }
  const LEFT_OUTSIDE = { ...LEFT, run: OUTSIDE, pid: GROUP }
  const ps = (pid: number, pgid: number) => ({ pid, ppid: 1, pgid, elapsedSec: 5, command: 'sleep 3917' })

  test('alive in its group, its first process gone: Background with the count, and never Background ended', () => {
    const run = view([START_OUTSIDE, END_OUTSIDE, LEFT_OUTSIDE], { verified: true, members: [ps(5_002, GROUP), ps(5_003, GROUP)] })

    expect(run).toMatchObject({ phase: 'background', live: 2 })
    expect(run).not.toHaveProperty('backgroundEnded')
    expect(run).not.toHaveProperty('orphanLive')
  })

  test('the launcher killed: no left-ended will ever come, and the group still answers', () => {
    expect(view([START_OUTSIDE, END_OUTSIDE, LEFT_OUTSIDE], { verified: true, members: [ps(5_002, GROUP)] })).toMatchObject({ phase: 'background', live: 1 })
    expect(view([START_OUTSIDE, END_OUTSIDE, LEFT_OUTSIDE], { verified: true, members: [] })).toMatchObject({ phase: 'exited', backgroundEnded: true, live: 0 })
  })

  test('a process leading that group number is a recycled pid, never this command', () => {
    expect(view([START_OUTSIDE, END_OUTSIDE, LEFT_OUTSIDE], { verified: true, members: [ps(GROUP, GROUP), ps(5_002, GROUP)] })).toMatchObject({ live: 0, backgroundEnded: true })
  })

  test('the launcher said it ended: the group is not asked', () => {
    const ended = { ...leftEnded(), run: OUTSIDE, pid: GROUP, survivors: 0 }

    expect(view([START_OUTSIDE, END_OUTSIDE, LEFT_OUTSIDE, ended], { verified: true, members: [ps(5_002, GROUP)] })).toMatchObject({ live: 0, backgroundEnded: true })
  })

  test('a confined run: the kernel alone says who is its, whatever the group', () => {
    expect(view([{ ...START, pid: GROUP }, { ...END, pid: GROUP }, { ...LEFT, pid: GROUP }], { verified: true, members: [ps(5_002, GROUP)] })).toMatchObject({ live: 0 })
  })
})

describe('g18: who stopped it, said only when the code knows', () => {
  test.each(["the agent's process tool stopped it", 'quit'])('the launcher stopped it (%s): stopped, and not by the owner', why => {
    const run = view([START, END, LEFT, leftEnded({ stopped: true, why, survivors: 0 })], { verified: true })

    expect(run).toMatchObject({ phase: 'stopped' })
    expect(run).not.toHaveProperty('stoppedByOwner')
  })

  test('the owner pressed Stop: the only line that says so', () => {
    const files = ledger([START, { ...END, ts: at(31), code: null, signal: 15 }])

    appendStop(files.stopsFile, TOKEN, at(30))

    const [run] = foldAllRuns({
      nowMs: Date.parse(at(90)),
      events: readRunEvents(files),
      rows: [],
      verified: true,
      refusals: new Map()
    })

    expect(run).toMatchObject({ phase: 'stopped', stoppedByOwner: true })
  })

  test('a policy stop stays the modes\' own', () => {
    const kill = { v: 1, ev: 'refused', ts: at(59), run: TOKEN, code: 'policy', detail: 'mode-denied' }
    const run = view([START, END, LEFT, kill, leftEnded({ stopped: true, why: 'policy' })], { verified: true })

    expect(run).toMatchObject({ stoppedByModes: true })
    expect(run).not.toHaveProperty('stoppedByOwner')
  })
})
