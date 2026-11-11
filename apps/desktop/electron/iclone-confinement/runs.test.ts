import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RefusalView, RefusalWhy, RunView } from '../../src/iclone-shared/confinement'

import {
  appendStop,
  capRuns,
  explainRefusals,
  foldAllRuns,
  foldRuns,
  HOUSEKEEPING_MAX,
  orphanOwners,
  parseRunLine,
  readRunEvents,
  refusalWhy,
  REFUSED_MAX,
  type RunEvent,
  runFiles,
  RUNS_MAX,
  runStarts,
  tailLines,
  type WhySpec
} from './runs'
import type { PsRow } from './state'

const dirs: string[] = []

const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'v006-runs-'))

  dirs.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const SHA = 'a'.repeat(64)
const token = (n: number, cls = 'project') => `${cls}+${SHA.slice(0, 12)}+sess-1+${n.toString(16).padStart(32, '0')}`
const T0 = Date.parse('2026-11-01T10:00:00.000Z')
const at = (sec: number) => new Date(T0 + sec * 1_000).toISOString()

const start = (n: number, sec: number, over: Record<string, unknown> = {}) => ({
  v: 1,
  ev: 'start',
  ts: at(sec),
  run: token(n),
  pid: 1_000 + n,
  kind: 'shell',
  cls: 'project',
  sha: SHA,
  session: 'sess-1',
  command: `echo ${n}`,
  cwd: '/Users/me/p',
  project: '/Users/me/p',
  net: false,
  write: true,
  ...over
})

const end = (n: number, sec: number, code: number | null = 0, signal: number | null = null) => ({
  v: 1,
  ev: 'end',
  ts: at(sec),
  run: token(n),
  pid: 1_000 + n,
  code,
  signal
})

const refused = (sec: number, code = 'launcher-unavailable', command = 'ls') => ({
  v: 1,
  ev: 'refused',
  ts: at(sec),
  session: 'sess-1',
  command,
  code,
  detail: 'the launcher is not answering'
})

const stop = (n: number, sec: number) => ({ v: 1, ev: 'stop', ts: at(sec), run: token(n) })

const events = (...lines: object[]): RunEvent[] =>
  lines.map(line => parseRunLine(JSON.stringify(line))).filter((event): event is RunEvent => event !== null)

const member = (n: number, pid: number, over: Partial<PsRow> = {}): PsRow => ({
  pid,
  ppid: 1,
  pgid: pid,
  elapsedSec: 5,
  command: 'x',
  run: token(n),
  ...over
})

const fold = (lines: object[], rows: PsRow[] = [], nowSec = 600, verified = true) =>
  foldRuns({ nowMs: T0 + nowSec * 1_000, events: events(...lines), rows, verified, refusals: new Map() })

describe('parseRunLine — every field validated, a malformed line dropped', () => {
  it('reads the three journal shapes and main’s stop', () => {
    expect(parseRunLine(JSON.stringify(start(1, 0)))).toMatchObject({ ev: 'start', run: token(1), pid: 1_001 })
    expect(parseRunLine(JSON.stringify(end(1, 2, null, 9)))).toMatchObject({ ev: 'end', code: null, signal: 9 })
    expect(parseRunLine(JSON.stringify(refused(1)))).toMatchObject({ ev: 'refused', code: 'launcher-unavailable' })
    expect(parseRunLine(JSON.stringify(stop(1, 1)))).toMatchObject({ ev: 'stop', run: token(1) })
  })

  it.each([
    ['not json', '{"v":1,'],
    ['an array', '[1,2]'],
    ['wrong version', JSON.stringify({ ...start(1, 0), v: 2 })],
    ['a bad timestamp', JSON.stringify({ ...start(1, 0), ts: 'yesterday' })],
    ['a forged run id', JSON.stringify({ ...start(1, 0), run: '../../etc/passwd' })],
    ['pid 1', JSON.stringify({ ...start(1, 0), pid: 1 })],
    ['a string pid', JSON.stringify({ ...start(1, 0), pid: '1001' })],
    ['an unknown kind', JSON.stringify({ ...start(1, 0), kind: 'daemon' })],
    ['an unknown class', JSON.stringify({ ...start(1, 0), cls: 'root' })],
    ['a short sha', JSON.stringify({ ...start(1, 0), sha: 'abc' })],
    ['a session with a slash', JSON.stringify({ ...start(1, 0), session: 'a/b' })],
    ['a relative cwd', JSON.stringify({ ...start(1, 0), cwd: 'p' })],
    ['a cwd through ..', JSON.stringify({ ...start(1, 0), cwd: '/Users/me/.ssh/../p' })],
    ['a cwd ending in ..', JSON.stringify({ ...start(1, 0), cwd: '/Users/me/p/..' })],
    ['a cwd with .', JSON.stringify({ ...start(1, 0), cwd: '/Users/me/./p' })],
    ['a cwd with //', JSON.stringify({ ...start(1, 0), cwd: '//Users/me' })],
    ['a project through ..', JSON.stringify({ ...start(1, 0), project: '/a/../b' })],
    ['a string net', JSON.stringify({ ...start(1, 0), net: 'true' })],
    ['a float exit code', JSON.stringify({ ...end(1, 1), code: 1.5 })],
    ['an unknown event', JSON.stringify({ v: 1, ev: 'exec', ts: at(0) })],
    ['a stop without a run', JSON.stringify({ v: 1, ev: 'stop', ts: at(0) })]
  ])('drops %s', (_name, line) => {
    expect(parseRunLine(line)).toBeNull()
  })

  it('an unknown refusal code reads other; long commands are clipped and secrets redacted', () => {
    const line = parseRunLine(
      JSON.stringify(refused(0, 'made-up', `curl -H "Authorization: Bearer sk-${'x'.repeat(40)}" ${'y'.repeat(3_000)}`))
    )

    expect(line).toMatchObject({ ev: 'refused', code: 'other' })
    expect((line as { command: string }).command.length).toBeLessThanOrEqual(2_000)
    expect((line as { command: string }).command).not.toContain('x'.repeat(40))
  })
})

describe('foldRuns — every phase', () => {
  it('running: the root is alive in its run', () => {
    expect(fold([start(1, 0)], [member(1, 1_001)])).toMatchObject([
      { id: token(1), phase: 'running', live: 1, rootPid: 1_001, endedAt: null, kind: 'shell', writeProject: true }
    ])
  })

  it('background: the root ended, processes it started are still in its sandbox', () => {
    expect(fold([start(1, 0), end(1, 5)], [member(1, 2_000, { ppid: 1 })])).toMatchObject([
      { phase: 'background', live: 1, exitCode: 0, endedAt: at(5) }
    ])
  })

  it('exited, failed by status, failed by a signal nobody asked for', () => {
    const runs = fold([start(1, 0), end(1, 1), start(2, 0), end(2, 2, 2), start(3, 0), end(3, 3, null, 15)])

    expect(runs.map(run => [run.id, run.phase, run.exitCode, run.signal])).toEqual([
      [token(3), 'failed', null, 15],
      [token(2), 'failed', 2, null],
      [token(1), 'exited', 0, null]
    ])
  })

  it('stopped: the stop is written before the kill, the end lands after it (stop-then-end)', () => {
    expect(fold([start(1, 0), stop(1, 10), end(1, 11, null, 9)])).toMatchObject([
      { phase: 'stopped', signal: 9, endedAt: at(11) }
    ])
    // The same lines in the other order (an end read before the stop) fold the same.
    expect(fold([start(1, 0), end(1, 11, null, 9), stop(1, 10)])).toMatchObject([{ phase: 'stopped' }])
  })

  it('a stop while members still live reads background until the kernel finds none', () => {
    expect(fold([start(1, 0), stop(1, 10)], [member(1, 2_000)])).toMatchObject([{ phase: 'background', live: 1 }])
  })

  it('refused: a command that never started, even before any start in the window', () => {
    const runs = fold([refused(-60), start(1, 0), end(1, 1)])

    expect(runs.map(run => run.phase)).toEqual(['exited', 'refused'])
    expect(runs[1]).toMatchObject({
      id: expect.stringMatching(/^refused-[0-9a-f]{24}$/),
      refusedReason: 'launcher-unavailable',
      refusedDetail: 'the launcher is not answering',
      live: 0,
      rootPid: null
    })
  })

  it('a start with no end and nothing alive: running for 3 s, then unknown', () => {
    expect(fold([start(1, 0)], [], 2)).toMatchObject([{ phase: 'running', live: 0 }])
    expect(fold([start(1, 0)], [], 4)).toMatchObject([{ phase: 'unknown', endedAt: null }])
  })

  it('clock skew: a start a little ahead of main’s clock is starting, far ahead is unknown', () => {
    expect(fold([start(1, 2)], [], 0)).toMatchObject([{ phase: 'running' }])
    expect(fold([start(1, 60)], [], 0)).toMatchObject([{ phase: 'unknown' }])
    // An end stamped before its start (the launcher's clock stepped back) still ends it.
    expect(fold([start(1, 10), end(1, 5)], [], 600)).toMatchObject([{ phase: 'exited', endedAt: at(5) }])
  })

  it('a recycled root pid the kernel does not hold in the run is not the root', () => {
    expect(fold([start(1, 0)], [{ pid: 1_001, ppid: 1, pgid: 1, elapsedSec: 1, command: 'Safari' }])).toMatchObject([
      { phase: 'unknown', live: 0 }
    ])
  })

  it('unverified membership: only the root pid is known alive', () => {
    expect(
      fold([start(1, 0)], [{ pid: 1_001, ppid: 1, pgid: 1, elapsedSec: 1, command: 'x' }], 600, false)
    ).toMatchObject([{ phase: 'running', live: 1 }])
  })

  it('order: live first (newest start first), then the rest newest first; capped', () => {
    const runs = fold(
      [start(1, 0), start(2, 10), start(3, 20), end(3, 30), refused(40), start(4, 5), end(4, 50)],
      [member(1, 1_001), member(2, 1_002)]
    )

    expect(runs.map(run => run.phase)).toEqual(['running', 'running', 'exited', 'refused', 'exited'])
    expect(runs.slice(0, 2).map(run => run.id)).toEqual([token(2), token(1)])
    expect(runs[2].id).toBe(token(4))

    const many = Array.from({ length: 150 }, (_, i) => [start(i + 1, i), end(i + 1, i + 1)]).flat()

    expect(fold(many)).toHaveLength(RUNS_MAX)
    expect(fold(many)[0].id).toBe(token(150))
  })

  it('a refusal count per run', () => {
    const runs = foldRuns({
      nowMs: T0,
      events: events(start(1, 0), end(1, 1)),
      rows: [],
      verified: true,
      refusals: new Map([[token(1), 3]])
    })

    expect(runs[0].refusals).toBe(3)
  })
})

describe('the files — rotation, tails, malformed lines, never a throw', () => {
  it('reads runs.jsonl.1 then runs.jsonl, the plugin refusals and main’s stops; drops every malformed line', () => {
    const userData = tempDir()
    const files = runFiles(userData)

    mkdirSync(files.ledgerDir, { recursive: true })
    mkdirSync(files.refusedDir, { recursive: true })
    writeFileSync(path.join(files.ledgerDir, 'runs.jsonl.1'), `${JSON.stringify(start(1, 0))}\n{"torn":\n`)
    writeFileSync(
      path.join(files.ledgerDir, 'runs.jsonl'),
      `${JSON.stringify(end(1, 5))}\nnot json\n${JSON.stringify(start(2, 6))}\n${JSON.stringify(stop(2, 7))}\n`
    )
    writeFileSync(
      path.join(files.refusedDir, 'refused.jsonl'),
      `${JSON.stringify(refused(8))}\n${JSON.stringify(start(9, 8))}\n`
    )
    appendStop(files.stopsFile, token(2), at(9))

    const read = readRunEvents(files)

    // The journal cannot say stop and the plugin's file cannot say start: each file speaks for its own writer.
    expect(read.map(event => event.ev)).toEqual(['start', 'end', 'start', 'refused', 'stop'])

    const runs = foldRuns({ nowMs: T0 + 600_000, events: read, rows: [], verified: true, refusals: new Map() })

    expect(runs.map(run => [run.phase, run.id.slice(0, 8)])).toEqual([
      ['stopped', token(2).slice(0, 8)],
      ['refused', 'refused-'],
      ['exited', token(1).slice(0, 8)]
    ])
    expect(statSync(files.stopsFile).mode & 0o777).toBe(0o600)
  })

  it('keeps the newest REFUSED_MAX rows of the runtime-written file and marks their views as the runtime’s word', () => {
    const userData = tempDir()
    const files = runFiles(userData)

    mkdirSync(files.ledgerDir, { recursive: true })
    mkdirSync(files.refusedDir, { recursive: true })
    writeFileSync(path.join(files.ledgerDir, 'runs.jsonl'), `${JSON.stringify(start(1, 0))}\n`)
    writeFileSync(
      path.join(files.refusedDir, 'refused.jsonl'),
      Array.from({ length: REFUSED_MAX + 10 }, (_, i) => JSON.stringify(refused(i + 1, 'other', `cmd-${i + 1}`))).join(
        '\n'
      ) + '\n'
    )

    const read = readRunEvents(files)
    const kept = read.filter(event => event.ev === 'refused')

    expect(kept).toHaveLength(REFUSED_MAX)
    expect(kept[0]).toMatchObject({ command: 'cmd-11' })
    expect(kept[kept.length - 1]).toMatchObject({ command: `cmd-${REFUSED_MAX + 10}` })

    const runs = foldRuns({ nowMs: T0 + 600_000, events: read, rows: [], verified: true, refusals: new Map() })

    expect(runs.find(run => run.phase === 'refused')?.reportedBy).toBe('runtime')
    expect(runs.find(run => run.phase !== 'refused')?.reportedBy).toBe('launcher')
  })

  it('labels a refusal the launcher wrote in its own ledger as the launcher’s', () => {
    const files = runFiles(tempDir())

    mkdirSync(files.ledgerDir, { recursive: true })
    writeFileSync(path.join(files.ledgerDir, 'runs.jsonl'), `${JSON.stringify(refused(5, 'bad-request', 'peer'))}\n`)

    const read = readRunEvents(files)

    expect(read).toMatchObject([{ ev: 'refused', reportedBy: 'launcher' }])

    const runs = foldRuns({ nowMs: T0 + 600_000, events: read, rows: [], verified: true, refusals: new Map() })

    expect(runs).toMatchObject([{ phase: 'refused', command: 'peer', reportedBy: 'launcher' }])
  })

  it('labels a refusal from the plugin’s file as the runtime’s, even one shaped like a launcher row', () => {
    const files = runFiles(tempDir())

    mkdirSync(files.refusedDir, { recursive: true })
    writeFileSync(
      path.join(files.refusedDir, 'refused.jsonl'),
      `${JSON.stringify({ ...refused(5, 'bad-request', 'forged'), reportedBy: 'launcher' })}\n`
    )

    const read = readRunEvents(files)

    expect(read).toMatchObject([{ ev: 'refused', reportedBy: 'runtime' }])

    const runs = foldRuns({ nowMs: T0 + 600_000, events: read, rows: [], verified: true, refusals: new Map() })

    expect(runs).toMatchObject([{ phase: 'refused', command: 'forged', reportedBy: 'runtime' }])
  })

  it('an older ledger with a flood of launcher refusals in runs.jsonl keeps only the newest and every completed run', () => {
    const files = runFiles(tempDir())
    const completed = [start(1, 0), end(1, 1), start(2, 2), end(2, 3), start(3, 4), end(3, 5)]
    const flood = Array.from({ length: 200 }, (_, i) => refused(100 + i, 'bad-request', `bad-${i}`))

    mkdirSync(files.ledgerDir, { recursive: true })
    writeFileSync(
      path.join(files.ledgerDir, 'runs.jsonl'),
      [...completed, ...flood].map(l => JSON.stringify(l)).join('\n') + '\n'
    )

    const read = readRunEvents(files)
    const kept = read.filter(event => event.ev === 'refused')

    expect(kept).toHaveLength(REFUSED_MAX)
    expect(kept[kept.length - 1]).toMatchObject({ command: 'bad-199' })
    expect(read.filter(event => event.ev !== 'refused')).toHaveLength(completed.length)

    const runs = foldRuns({ nowMs: T0 + 600_000, events: read, rows: [], verified: true, refusals: new Map() })

    expect(runs.filter(run => run.phase === 'exited').map(run => run.id)).toEqual([token(3), token(2), token(1)])
  })

  it('300+ launcher refusals in the ledger’s refusal file leave all 3 finished runs visible; a collapsed row shows its count', () => {
    const files = runFiles(tempDir())
    const completed = [start(1, 0), end(1, 1), start(2, 2), end(2, 3), start(3, 4), end(3, 5)]
    const long = 'x'.repeat(500)
    const distinct = Array.from({ length: 320 }, (_, i) => refused(100 + i, 'profile-unknown', `/bin/echo ${long}${i}`))

    // The launcher's window for one repeated refusal: the first row at once, then the rest of the window in one row.
    const repeated = {
      ...refused(500, 'profile-unknown', '/bin/echo again'),
      detail: 'the profile is not one the app generated'
    }

    const first = { ...repeated, count: 1, last: at(500) }
    const rest = { ...repeated, ts: at(501), count: 749, last: at(530) }

    mkdirSync(files.ledgerDir, { recursive: true })
    writeFileSync(path.join(files.ledgerDir, 'runs.jsonl'), completed.map(l => JSON.stringify(l)).join('\n') + '\n')
    writeFileSync(
      path.join(files.ledgerDir, 'refused.jsonl'),
      [first, ...distinct, rest].map(l => JSON.stringify(l)).join('\n') + '\n'
    )

    const read = readRunEvents(files)
    const runs = foldRuns({ nowMs: T0 + 600_000, events: read, rows: [], verified: true, refusals: new Map() })

    expect(runs.filter(run => run.phase === 'exited').map(run => run.id)).toEqual([token(3), token(2), token(1)])

    const refusedViews = runs.filter(run => run.phase === 'refused')

    expect(refusedViews).toHaveLength(REFUSED_MAX)
    expect(refusedViews.every(run => run.reportedBy === 'launcher')).toBe(true)

    const collapsed = refusedViews.find(run => run.command === '/bin/echo again')

    expect(collapsed).toMatchObject({ refusedCount: 750, startedAt: at(500), endedAt: at(530) })
    expect(collapsed?.refusedDetail).toBe(`the profile is not one the app generated · 750 times, last ${at(530)}`)
    expect(refusedViews.filter(run => run.command !== '/bin/echo again').every(run => run.refusedCount === 1)).toBe(
      true
    )
  })

  it('an older ledger’s refusals in runs.jsonl are still read as the launcher’s and share its cap with the new file', () => {
    const files = runFiles(tempDir())

    mkdirSync(files.ledgerDir, { recursive: true })
    writeFileSync(
      path.join(files.ledgerDir, 'runs.jsonl.1'),
      [start(1, 0), refused(1, 'bad-request', 'old-1')].map(l => JSON.stringify(l)).join('\n') + '\n'
    )
    writeFileSync(
      path.join(files.ledgerDir, 'runs.jsonl'),
      [end(1, 2), refused(3, 'bad-request', 'old-2')].map(l => JSON.stringify(l)).join('\n') + '\n'
    )
    writeFileSync(
      path.join(files.ledgerDir, 'refused.jsonl'),
      Array.from({ length: REFUSED_MAX }, (_, i) => JSON.stringify(refused(10 + i, 'other', `new-${i}`))).join('\n') +
        '\n'
    )

    const read = readRunEvents(files)
    const launcherRefusals = read.filter(event => event.ev === 'refused')

    expect(launcherRefusals).toHaveLength(REFUSED_MAX)
    expect(launcherRefusals.every(event => event.ev === 'refused' && event.reportedBy === 'launcher')).toBe(true)
    expect(launcherRefusals.map(event => event.ev === 'refused' && event.command)).not.toContain('old-1')

    const runs = foldRuns({ nowMs: T0 + 600_000, events: read, rows: [], verified: true, refusals: new Map() })

    expect(runs.find(run => run.id === token(1))?.phase).toBe('exited')
  })

  it('a refusal row with a malformed count or last-seen time is dropped', () => {
    for (const over of [{ count: 0 }, { count: 1.5 }, { count: '3' }, { count: 2e9 }, { last: 'yesterday' }]) {
      expect(parseRunLine(JSON.stringify({ ...refused(1), ...over }), 'launcher')).toBeNull()
    }

    expect(parseRunLine(JSON.stringify({ ...refused(1), count: 4, last: at(9) }), 'launcher')).toMatchObject({
      count: 4,
      lastTs: at(9)
    })
    expect(parseRunLine(JSON.stringify(refused(1)), 'launcher')).toMatchObject({ count: 1, lastTs: null })
  })

  it('floods of both refusal files together still leave room for completed runs', () => {
    const files = runFiles(tempDir())
    const completed = [start(1, 0), end(1, 1), start(2, 2), end(2, 3), start(3, 4), end(3, 5)]

    const flood = (tag: string) => {
      const lines = Array.from({ length: 200 }, (_, i) => refused(100 + i, 'bad-request', `${tag}-${i}`))

      return lines.map(l => JSON.stringify(l)).join('\n')
    }

    mkdirSync(files.ledgerDir, { recursive: true })
    mkdirSync(files.refusedDir, { recursive: true })
    writeFileSync(path.join(files.ledgerDir, 'runs.jsonl'), `${completed.map(l => JSON.stringify(l)).join('\n')}\n`)
    writeFileSync(path.join(files.ledgerDir, 'refused.jsonl'), `${flood('launcher')}\n`)
    writeFileSync(path.join(files.refusedDir, 'refused.jsonl'), `${flood('runtime')}\n`)

    const runs = foldRuns({
      nowMs: T0 + 600_000,
      events: readRunEvents(files),
      rows: [],
      verified: true,
      refusals: new Map()
    })

    expect(runs.filter(run => run.phase === 'exited')).toHaveLength(3)
    expect(runs.filter(run => run.reportedBy === 'launcher' && run.phase === 'refused')).toHaveLength(REFUSED_MAX)
    expect(runs.filter(run => run.reportedBy === 'runtime')).toHaveLength(REFUSED_MAX)
    expect(2 * REFUSED_MAX).toBeLessThan(RUNS_MAX)
  })

  it('absent files read as nothing', () => {
    expect(readRunEvents(runFiles(path.join(tempDir(), 'missing')))).toEqual([])
    expect(tailLines('/nonexistent/runs.jsonl')).toEqual([])
  })

  it('reads at most the tail window, dropping the line it cuts', () => {
    const file = path.join(tempDir(), 'big.jsonl')

    for (let i = 0; i < 50; i += 1) {
      appendFileSync(file, `${'x'.repeat(99)}\n`)
    }

    const lines = tailLines(file, 1_050)

    expect(lines).toHaveLength(10)
    expect(lines.every(line => line.length === 99)).toBe(true)
  })

  it('the stops log stays bounded: it rotates once above its size', () => {
    const file = path.join(tempDir(), 'stops.jsonl')

    writeFileSync(file, `${'x'.repeat(300 * 1024)}\n`)
    appendStop(file, token(1), at(0))

    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(statSync(`${file}.1`).size).toBeGreaterThan(256 * 1024)
  })
})

describe('RefusalWhy — main reads the reason from the operation, the target and the profile', () => {
  const spec: WhySpec = {
    network: 'grant',
    denied: ['/Users/me/.ssh', '/Users/me/Library/Application Support/iclone-os'],
    deniedGlobs: ['/Users/me/.config/*/credentials'],
    protectedWrites: ['/Users/me/q/guarded']
  }

  const offline: WhySpec = { ...spec, network: 'never' }
  const readOnlyRun = { project: '/Users/me/p', write: false }
  const writableRun = { project: '/Users/me/p', write: true }

  const table: [string, string, string, WhySpec | null, typeof readOnlyRun | null, RefusalWhy][] = [
    ['cat', 'file-read-data', '/Users/me/.ssh/id_ed25519', spec, null, 'never-list'],
    ['cat', 'file-read-metadata', '/Users/me/.config/gcloud/credentials', spec, null, 'never-list'],
    ['cat', 'file-read-data', '/Users/me/.sshx/notes', spec, null, 'outside-roots'],
    ['cat', 'file-read-data', '/Users/other/doc.txt', spec, null, 'outside-roots'],
    ['sh', 'file-write-data', '/Users/me/p/.git/hooks/pre-commit', spec, writableRun, 'git-config'],
    ['sh', 'file-write-data', '/Users/me/q/guarded', spec, writableRun, 'protected-file'],
    ['sh', 'file-write-create', '/Users/me/.ssh/authorized_keys', spec, writableRun, 'never-list'],
    ['git', 'file-write-create', '/Users/me/p/.git/config', spec, writableRun, 'git-config'],
    ['git', 'file-write-unlink', '/Users/me/p/.git', spec, writableRun, 'git-config'],
    ['sh', 'file-write-create', '/Users/me/p/.git/commondir', spec, writableRun, 'git-config'],
    ['sh', 'file-write-data', '/Users/me/p/.git/worktrees/w/config.worktree', spec, writableRun, 'git-config'],
    ['git', 'file-write-create', '/Users/me/p/.git/config', spec, readOnlyRun, 'project-read-only'],
    ['git', 'file-write-create', '/Users/me/p/sub/.git/config', spec, writableRun, 'not-writable'],
    ['git', 'file-write-create', '/Users/me/p/.git/configx', spec, writableRun, 'not-writable'],
    ['sh', 'file-write-data', '/Users/me/p/src/a.ts', spec, readOnlyRun, 'project-read-only'],
    ['sh', 'file-write-data', '/Users/me/p/src/a.ts', spec, writableRun, 'not-writable'],
    ['sh', 'file-write-unlink', '/Users/me/Desktop/x', spec, readOnlyRun, 'not-writable'],
    ['sh', 'file-write-data', '/Users/me/p/src/a.ts', spec, null, 'not-writable'],
    ['curl', 'network-outbound', '*:443', spec, null, 'network-not-granted'],
    ['curl', 'network-outbound', '*:443', offline, null, 'network-never'],
    ['sh', 'process-exec*', '/bin/launchctl', spec, null, 'program-refused'],
    ['security', 'mach-lookup', 'com.apple.SecurityServer', spec, null, 'system-service'],
    ['hard-link', 'hard-link-appeared', '/Users/me/p/link', spec, null, 'hard-link'],
    ['sh', 'sysctl-write', 'kern.x', spec, null, 'other'],
    ['cat', 'file-read-data', '/Users/me/.ssh/id_rsa', null, null, 'outside-roots']
  ]

  it.each(table)('%s %s %s ⇒ %s', (process, operation, target, profile, run, why) => {
    expect(refusalWhy({ process, operation, target }, profile, run)).toBe(why)
  })

  it('attributes each refusal to its run’s class (offline ⇒ network-never) and the unattributed to the active class', () => {
    const specs = [
      { ...spec, cls: 'project' as const },
      { ...offline, cls: 'offline' as const }
    ]

    const offlineRun = token(7, 'offline')
    const starts = runStarts(events(start(7, 0, { run: offlineRun, cls: 'offline' }), start(8, 0, { write: false })))

    const row = (over: Partial<RefusalView>): RefusalView => ({
      ts: at(1),
      pid: 1_007,
      process: 'curl',
      operation: 'network-outbound',
      target: '*:443',
      sessionId: 'sess-1',
      ...over
    })

    const out = explainRefusals(
      [
        row({ run: offlineRun }),
        row({ run: null }),
        row({ run: 'not-a-token', why: 'other' }),
        row({ run: token(8), process: 'sh', operation: 'file-write-data', target: '/Users/me/p/a' })
      ],
      specs,
      starts,
      'project'
    )

    expect(out.map(item => [item.run, item.why])).toEqual([
      [offlineRun, 'network-never'],
      [null, 'network-not-granted'],
      [null, 'network-not-granted'],
      [token(8), 'project-read-only']
    ])
  })
})

describe('who issued a run (origin)', () => {
  it('a start row without an origin is the agent’s (an older launcher); runtime and agent are kept; any other value reads as the agent’s, never drops the run', () => {
    const plain = parseRunLine(JSON.stringify(start(1, 0)), 'launcher')
    const housekeeping = parseRunLine(JSON.stringify(start(2, 0, { origin: 'runtime' })), 'launcher')
    const agent = parseRunLine(JSON.stringify(start(3, 0, { origin: 'agent' })), 'launcher')

    expect(plain?.ev === 'start' && plain.origin).toBe('agent')
    expect(housekeeping?.ev === 'start' && housekeeping.origin).toBe('runtime')
    expect(agent?.ev === 'start' && agent.origin).toBe('agent')

    for (const [n, origin] of [
      [4, 'owner'],
      [5, 1],
      [6, null],
      [7, 'Runtime']
    ] as const) {
      const parsed = parseRunLine(JSON.stringify(start(n, 0, { origin })), 'launcher')

      expect(parsed?.ev === 'start' && parsed.origin, String(origin)).toBe('agent')
    }
  })

  it('the fold carries it onto the view; a command refused before start is the agent’s', () => {
    const dir = tempDir()
    const files = runFiles(dir)

    mkdirSync(files.ledgerDir, { recursive: true })
    mkdirSync(files.refusedDir, { recursive: true })
    writeFileSync(
      path.join(files.ledgerDir, 'runs.jsonl'),
      `${[start(1, 0, { origin: 'runtime', command: 'Prepare the shell environment for this session' }), start(2, 1)]
        .map(row => JSON.stringify(row))
        .join('\n')}\n`
    )
    writeFileSync(
      path.join(files.refusedDir, 'refused.jsonl'),
      `${JSON.stringify({ v: 1, ev: 'refused', ts: at(2), session: 'sess-1', command: 'rg x', code: 'hard-links', detail: 'links' })}\n`
    )

    const views = foldRuns({
      nowMs: T0 + 60_000,
      events: readRunEvents(files),
      rows: [],
      verified: true,
      refusals: new Map()
    })

    expect(views.map(view => [view.command, view.origin])).toEqual([
      ['rg x', 'agent'],
      ['echo 2', 'agent'],
      ['Prepare the shell environment for this session', 'runtime']
    ])
  })
})

describe('the bound on the list', () => {
  const add = (lines: string[], n: number, sec: number, over: Record<string, unknown> = {}) => {
    lines.push(
      JSON.stringify({ ...start(n, sec, over), ev: 'start' }),
      JSON.stringify({ v: 1, ev: 'end', ts: at(sec + 1), run: token(n), pid: 1000 + n, code: 0, signal: null })
    )
  }

  const fold = (lines: string[]) => {
    const parsed = lines.map(line => parseRunLine(line)).filter((event): event is RunEvent => event !== null)

    return { nowMs: T0 + 900_000, events: parsed, rows: [], verified: true, refusals: new Map<string, number>() }
  }

  it('a burst of housekeeping never evicts an agent command', () => {
    const lines: string[] = []

    add(lines, 1, 0)

    for (let n = 2; n <= 101; n += 1) {
      add(lines, n, n * 2, { origin: 'runtime' })
    }

    const runs = foldRuns(fold(lines))

    expect(runs.filter(run => run.origin === 'agent')).toHaveLength(1)
    expect(runs.filter(run => run.origin === 'runtime')).toHaveLength(100)
  })

  it('each side is bounded on its own and what was cut is counted', () => {
    const lines: string[] = []

    for (let n = 1; n <= RUNS_MAX + 3; n += 1) {
      add(lines, n, n)
    }

    for (let n = 1000; n < 1000 + HOUSEKEEPING_MAX + 2; n += 1) {
      add(lines, n, n, { origin: 'runtime' })
    }

    const { cut, runs } = capRuns(foldAllRuns(fold(lines)))

    expect(runs.filter(run => run.origin === 'agent')).toHaveLength(RUNS_MAX)
    expect(runs.filter(run => run.origin === 'runtime')).toHaveLength(HOUSEKEEPING_MAX)
    expect(cut).toBe(5)
  })

  it('a runtime run that failed or was refused stays with the agent runs: its mark buys no eviction', () => {
    const lines: string[] = []

    lines.push(
      JSON.stringify({ ...start(1, 0, { origin: 'runtime' }), ev: 'start' }),
      JSON.stringify({ v: 1, ev: 'end', ts: at(1), run: token(1), pid: 1001, code: 2, signal: null })
    )

    for (let n = 2; n <= HOUSEKEEPING_MAX + 5; n += 1) {
      add(lines, n, n * 2, { origin: 'runtime' })
    }

    expect(foldRuns(fold(lines)).some(run => run.id === token(1))).toBe(true)
  })
})

describe('orphanOwners (fx26a, fx28) — a confined process whose run token is gone', () => {
  // A row with no run: the kernel holds the process as confined, no token claims it. 5 s old, so it started at 595 s.
  const orphan = (pid: number, elapsedSec = 5, over: Partial<PsRow> = {}) => member(0, pid, { run: null, elapsedSec, ...over })

  // The launcher's own journal: its left-running / left-ended rows count only read from its file.
  const launcherEvents = (lines: object[]): RunEvent[] =>
    lines.map(line => parseRunLine(JSON.stringify(line), 'launcher')).filter((event): event is RunEvent => event !== null)

  const owners = (lines: object[], rows: PsRow[], nowSec = 600, verified = true) =>
    orphanOwners({ nowMs: T0 + nowSec * 1_000, events: launcherEvents(lines), rows, verified })

  const foldL = (lines: object[], rows: PsRow[]) =>
    foldRuns({ nowMs: T0 + 600 * 1_000, events: launcherEvents(lines), rows, verified: true, refusals: new Map() })

  const leftRunning = (n: number, sec: number) => ({ v: 1, ev: 'left-running', ts: at(sec), run: token(n) })
  const stopLine = (n: number, sec: number, outcome?: 'failed') => ({ v: 1, ev: 'stop', ts: at(sec), run: token(n), ...(outcome ? { outcome } : {}) })
  const brief = (views: RunView[]) => views.map(view => [view.id, view.phase, view.live, view.backgroundEnded ?? false])
  const rootPid = (n: number) => start(n, 0).pid

  it('no orphan, or an unverified kernel answer: nobody owns anything', () => {
    expect(owners([start(1, 0), end(1, 5)], [member(1, 2_000)])).toEqual({ owners: new Map(), roots: new Set() })
    expect(owners([start(1, 0), end(1, 5)], [orphan(3_000)], 600, false)).toEqual({ owners: new Map(), roots: new Set() })
  })

  it('one orphan has one owner: the newest run that left something and started before it, on one row', () => {
    const lines = [
      start(1, 0),
      end(1, 5),
      leftRunning(1, 6),
      start(2, 100, { background: true }),
      end(2, 105),
      start(3, 200),
      end(3, 205),
      // Started after the orphan (595 s): never its owner, whatever it left.
      start(4, 598, { background: true }),
      end(4, 599)
    ]

    const found = owners(lines, [orphan(3_000)])

    expect([...found.owners.entries()]).toEqual([[token(2), [orphan(3_000)]]])

    // Two orphans of different ages: each goes by its own start, and each is counted once.
    const two = owners(lines, [orphan(3_000), orphan(3_001, 550)])

    expect(two.owners.get(token(2))).toEqual([orphan(3_000)])
    expect(two.owners.get(token(1))).toEqual([orphan(3_001, 550)])
  })

  it('with no such evidence, the newest ended run that started before it; a stopped, a live or a later run never', () => {
    const lines = [
      start(1, 0),
      end(1, 5),
      start(2, 100),
      end(2, 105),
      start(3, 200),
      end(3, 205),
      stopLine(3, 206),
      start(5, 300),
      end(5, 305),
      leftRunning(5, 306),
      { v: 1, ev: 'left-ended', ts: at(307), run: token(5), stopped: true, why: 'policy', survivors: 0 },
      start(6, 400),
      start(7, 598),
      end(7, 599)
    ]

    // Run 6 is still held by the kernel (a member of its own), 5 was stopped with no survivor, 7 started after the orphan.
    // fx29: run 3's stop line has no outcome, the press and not the kill: it does not exclude the newest ended run.
    expect([...owners(lines, [orphan(3_000), member(6, 4_000)]).owners.keys()]).toEqual([token(3)])
    expect([...owners(lines.filter(line => (line as { run?: string }).run !== token(3)), [orphan(3_000), member(6, 4_000)]).owners.keys()]).toEqual([token(2)])
  })

  it('the pane: an owner reads background with the orphan as its live count, never Background ended; a non-owner is exited', () => {
    const lines = [start(1, 0), end(1, 5), leftRunning(1, 6), start(2, 100), end(2, 105)]
    const views = foldL(lines, [orphan(3_000), orphan(3_001)])

    // Live first, as the pane lists them.
    expect(views).toMatchObject([
      { id: token(1), phase: 'background', live: 2, endedAt: at(5) },
      { id: token(2), phase: 'exited', live: 0 }
    ])
    expect(views[0]).not.toHaveProperty('backgroundEnded')
    expect(views[1]).not.toHaveProperty('backgroundEnded')
    // The same ledger with the orphans gone: the run that left something behind has ended, and says so.
    expect(foldL(lines, [])).toMatchObject([
      { id: token(2), phase: 'exited' },
      { id: token(1), phase: 'exited', live: 0, backgroundEnded: true }
    ])
  })

  // fx28: the lens table (work/lensL2/fold_proof.txt), through parseRunLine and foldRuns. Rows are [run, phase, live, Background ended].
  it.each([
    ['A: its token gone, the first process lives: running, never unknown', [start(1, 0)], [member(0, rootPid(1), { run: null, elapsedSec: 600 })], [[1, 'running', 1, false]]],
    [
      'A2: the same with an older ended background run: the older run never takes the live root',
      [start(1, 0, { background: true }), end(1, 1), leftRunning(1, 2), start(2, 100)],
      [member(0, start(2, 100).pid, { run: null, elapsedSec: 500 })],
      [[2, 'running', 1, false], [1, 'exited', 0, true]]
    ],
    ['B: an ended run that left something, token gone', [start(2, 0, { background: true }), end(2, 1), leftRunning(2, 2)], [orphan(2_002, 598)], [[2, 'background', 1, false]]],
    [
      'C: two ended runs that left something, one orphan: one row, the newest that fits',
      [start(3, 0), end(3, 1), leftRunning(3, 2), start(4, 10), end(4, 11), leftRunning(4, 12)],
      [orphan(4_004, 580)],
      [[4, 'background', 1, false], [3, 'exited', 0, true]]
    ],
    ['D: a plain exit, an orphan after it: the newest ended run', [start(5, 0), end(5, 1)], [orphan(5_005, 595)], [[5, 'background', 1, false]]],
    [
      'G: a Stop that reported survivors ended nothing: background, live, Stop still offered',
      [start(6, 0, { background: true }), end(6, 1), leftRunning(6, 2), stopLine(6, 100), stopLine(6, 100, 'failed')],
      [orphan(6_006, 598)],
      [[6, 'background', 1, false]]
    ],
    [
      'G2 (fx29): a stop line with no outcome is the press, not the kill: while something it left is alive the run owns it and reads background; gone, it reads stopped',
      [start(6, 0, { background: true }), end(6, 1), leftRunning(6, 2), stopLine(6, 100)],
      [orphan(6_006, 598)],
      [[6, 'background', 1, false]]
    ],
    [
      'G3: a quit that left survivors did not end the run',
      [start(6, 0), end(6, 1), leftRunning(6, 2), { v: 1, ev: 'left-ended', ts: at(50), run: token(6), stopped: true, why: 'quit', survivors: 1 }],
      [orphan(6_006, 598)],
      [[6, 'background', 1, false]]
    ],
    [
      'H: a run the kernel names by its token keeps its own; the orphan goes to the ended run',
      [start(7, 0), end(7, 1), start(8, 50)],
      [member(8, 8_008, { elapsedSec: 550 }), orphan(7_007, 597)],
      [[8, 'background', 1, false], [7, 'background', 1, false]]
    ],
    [
      'pid reuse: a later process with the pid of a run that never ended is not its first process',
      [start(1, 0)],
      [member(0, rootPid(1), { run: null, elapsedSec: 60 })],
      [[1, 'unknown', 0, false]]
    ],
    [
      'below the root: its child and a process of its group go by ancestry, never to a run that fits the clock better',
      [start(1, 0, { background: true }), end(1, 1), leftRunning(1, 2), start(2, 100), start(3, 300), end(3, 301), leftRunning(3, 302)],
      [
        member(0, start(2, 100).pid, { run: null, elapsedSec: 500 }),
        orphan(9_001, 200, { ppid: start(2, 100).pid }),
        orphan(9_002, 200, { pgid: start(2, 100).pid })
      ],
      [[2, 'running', 3, false], [3, 'exited', 0, true], [1, 'exited', 0, true]]
    ],
    [
      'detached from a run whose root lives: the newest fitting run is that one, not the older one',
      [start(1, 0, { background: true }), end(1, 1), leftRunning(1, 2), start(2, 100)],
      [member(0, start(2, 100).pid, { run: null, elapsedSec: 500 }), orphan(9_003, 400)],
      [[2, 'running', 2, false], [1, 'exited', 0, true]]
    ]
  ] as [string, object[], PsRow[], [number, RunView['phase'], number, boolean][]][])('%s', (_name, lines, rows, expected) => {
    expect(brief(foldL(lines, rows))).toEqual(expected.map(([n, phase, live, ended]) => [token(n), phase, live, ended]))
  })

  it('a cwd-spelling refusal from the launcher reaches the pane as its own reason, with its detail', () => {
    const detail = 'icloneOS: /p/link is a link to another folder'
    const views = foldL([{ v: 1, ev: 'refused', ts: at(1), code: 'cwd-spelling', detail, command: 'ls', session: 'sess-1' }], [])

    expect(views).toMatchObject([{ phase: 'refused', refusedReason: 'cwd-spelling', refusedDetail: detail }])
  })
})


describe('fx29 — the pane says when a live count is an orphan; a stop with no outcome counts only once nothing is alive', () => {
  const orphan = (pid: number, elapsedSec = 5) => member(0, pid, { run: null, elapsedSec })
  const launcherEvents = (lines: object[]): RunEvent[] =>
    lines.map(line => parseRunLine(JSON.stringify(line), 'launcher')).filter((event): event is RunEvent => event !== null)
  const foldL = (lines: object[], rows: PsRow[]) =>
    foldRuns({ nowMs: T0 + 600 * 1_000, events: launcherEvents(lines), rows, verified: true, refusals: new Map() })
  const leftRunning = (n: number, sec: number) => ({ v: 1, ev: 'left-running', ts: at(sec), run: token(n) })
  const stopLine = (n: number, sec: number, outcome?: 'failed') => ({ v: 1, ev: 'stop', ts: at(sec), run: token(n), ...(outcome ? { outcome } : {}) })

  it('a background row whose live count is a process with no run record says so; a row holding its own token does not', () => {
    const lines = [start(1, 0), end(1, 5), leftRunning(1, 6)]

    expect(foldL(lines, [orphan(3_000)])).toMatchObject([{ id: token(1), phase: 'background', live: 1, orphanLive: true }])
    expect(foldL(lines, [member(1, 3_000, { elapsedSec: 5 })])[0]).not.toHaveProperty('orphanLive')
  })

  it('a stop line with no outcome: the run still owns what is alive and reads background; with nothing alive it reads stopped', () => {
    const lines = [start(1, 0), end(1, 5), leftRunning(1, 6), stopLine(1, 10)]

    expect(foldL(lines, [orphan(3_000)])).toMatchObject([{ id: token(1), phase: 'background', live: 1, orphanLive: true }])
    expect(foldL(lines, [])).toMatchObject([{ id: token(1), phase: 'stopped', live: 0 }])
    // A Stop that reported no survivor ended it: it owns nothing.
    const leftEnded = { v: 1, ev: 'left-ended', ts: at(11), run: token(1), stopped: true, survivors: 0, why: 'stop' }

    expect(foldL([...lines, leftEnded], [orphan(3_000)])[0]).toMatchObject({ id: token(1), live: 0 })
  })
})
