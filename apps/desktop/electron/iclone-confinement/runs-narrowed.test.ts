/** fx14: the launcher's narrowed start rows and its kill row, read and folded (contract: DESIGN_FOLDER_PASS). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RunNarrowedWhy } from '../../src/iclone-shared/confinement'

import { foldRuns, parseRunLine, readRunEvents, refusalWhy, type RunEvent, type RunFiles } from './runs'

const SHA = 'a'.repeat(64)
const token = (n: number) => `project+${SHA.slice(0, 12)}+sess-1+${n.toString(16).padStart(32, '0')}`
const T0 = Date.parse('2026-11-01T10:00:00.000Z')
const at = (sec: number) => new Date(T0 + sec * 1_000).toISOString()
const FOLDER = '/Users/me/Elsewhere/p'

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
  cwd: FOLDER,
  project: FOLDER,
  net: false,
  write: false,
  ...over
})

const end = (n: number, sec: number, code: number | null, signal: number | null) => ({
  v: 1,
  ev: 'end',
  ts: at(sec),
  run: token(n),
  pid: 1_000 + n,
  code,
  signal
})

const STOPPED =
  'the run was stopped: the modes changed and no longer allow what it was started with (no mode allows it)'

const kill = (n: number, sec: number) => ({
  v: 1,
  ev: 'refused',
  ts: at(sec),
  run: token(n),
  code: 'policy',
  detail: STOPPED
})

const launcher = (...lines: object[]): RunEvent[] =>
  lines.flatMap(line => parseRunLine(JSON.stringify(line), 'launcher') ?? [])

const fold = (events: readonly RunEvent[]) =>
  foldRuns({ nowMs: T0 + 600_000, events, rows: [], verified: true, refusals: new Map() })

const spec = { denied: [], deniedGlobs: [], network: 'grant' as const, protectedWrites: [] } as never
const WRITE = { process: 'touch', operation: 'file-write-create', target: `${FOLDER}/a` }

describe('a narrowed start row', () => {
  it.each(['unlisted-folder', 'needs-allow', 'needs-network'])('%s reaches the view with its folder', why => {
    const [view] = fold(launcher(start(1, 0, { narrowed: true, narrowed_why: why }), end(1, 1, 1, null)))

    expect(view).toMatchObject({ narrowed: true, narrowedWhy: why, projectRoot: FOLDER, writeProject: false })
  })

  it('a reason this app does not know reads as narrowed with no reason; the row is never dropped', () => {
    const [view] = fold(launcher(start(1, 0, { narrowed: true, narrowed_why: '<b>made up' })))

    expect(view).toMatchObject({ narrowed: true, narrowedWhy: null })
  })

  it('the earlier row form, an object of flags, reads as the matching reason', () => {
    const [write] = fold(launcher(start(1, 0, { narrowed: { WRITE_PROJECT: 'x' } })))
    const [net] = fold(launcher(start(2, 0, { narrowed: { NET: 'x' } })))

    expect(write?.narrowedWhy).toBe('needs-allow')
    expect(net?.narrowedWhy).toBe('needs-network')
  })

  it('not narrowed leaves the view as it was: no narrowed field at all', () => {
    for (const said of [false, undefined, 'yes', 1, {}, []]) {
      const [view] = fold(launcher(start(1, 0, { narrowed: said, narrowed_why: 'needs-allow' })))

      expect(view).not.toHaveProperty('narrowed')
    }
  })
})

describe('why a narrowed run was refused a write', () => {
  const run = (narrowedWhy: RunNarrowedWhy | null, narrowed = true) => ({
    project: FOLDER,
    write: false,
    narrowed,
    narrowedWhy
  })

  it('says its own reason, never that the mode did not allow it', () => {
    expect(refusalWhy(WRITE, spec, run('unlisted-folder'))).toBe('narrowed-unlisted-folder')
    expect(refusalWhy(WRITE, spec, run('needs-allow'))).toBe('narrowed-needs-allow')
    expect(refusalWhy(WRITE, spec, run('needs-file-writing'))).toBe('narrowed-needs-file-writing')
  })

  it('a run that never asked for writes keeps the mode sentence', () => {
    expect(refusalWhy(WRITE, spec, { project: FOLDER, write: false })).toBe('project-read-only')
    expect(refusalWhy(WRITE, spec, run('needs-network'))).toBe('project-read-only')
  })

  it('the network has its own reason when that is what was narrowed', () => {
    const net = { process: 'curl', operation: 'network-outbound', target: 'x:443' }

    expect(refusalWhy(net, spec, run('needs-network'))).toBe('narrowed-needs-network')
    expect(refusalWhy(net, spec, run('needs-allow'))).toBe('network-not-granted')
  })
})

describe('a policy refusal', () => {
  it('keeps its code and its sentence', () => {
    const row = { v: 1, ev: 'refused', ts: at(0), session: 's', command: 'ls', code: 'policy', detail: 'no mode' }

    expect(parseRunLine(JSON.stringify(row), 'launcher')).toMatchObject({ code: 'policy', detail: 'no mode' })
    expect(fold(launcher(row))[0]).toMatchObject({ refusedReason: 'policy', refusedDetail: 'no mode' })
  })
})

describe('the kill row folds onto its run', () => {
  it('the run reads stopped by the modes, in one view, with no refused row beside it', () => {
    const views = fold(launcher(start(1, 0), kill(1, 5), end(1, 5, null, 9)))

    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ id: token(1), phase: 'stopped', stoppedByModes: true, stoppedDetail: STOPPED })
  })

  it('with the end not yet written, the kill row gives the time', () => {
    expect(fold(launcher(start(1, 0), kill(1, 5)))[0]).toMatchObject({ phase: 'stopped', endedAt: at(5) })
  })

  it('a run that ended by itself before the kill keeps its own end', () => {
    const [view] = fold(launcher(start(1, 0), end(1, 4, 0, null), kill(1, 5)))

    expect(view?.phase).toBe('exited')
    expect(view).not.toHaveProperty('stoppedByModes')
  })

  it("the owner's Stop speaks first", () => {
    const stop = { v: 1, ev: 'stop', ts: at(3), run: token(1) }
    const [view] = fold([...launcher(start(1, 0), kill(1, 5), end(1, 5, null, 9)), parseRunLine(JSON.stringify(stop))!])

    expect(view?.phase).toBe('stopped')
    expect(view).not.toHaveProperty('stoppedByModes')
  })

  it('a row whose run has left the window and has no command shows nothing; with a command it is listed', () => {
    expect(fold(launcher(kill(1, 5)))).toEqual([])
    expect(fold(launcher({ ...kill(1, 5), command: 'make' }))[0]).toMatchObject({ phase: 'refused', command: 'make' })
  })

  it("the runtime's file cannot say why a run ended: it writes that file at will", () => {
    expect(parseRunLine(JSON.stringify(kill(1, 5)), 'runtime')).toBeNull()

    const forged = parseRunLine(JSON.stringify({ ...kill(1, 5), command: 'x', session: 's' }), 'runtime')

    expect(forged).not.toHaveProperty('run')

    const views = fold([...launcher(start(1, 0), end(1, 5, null, 9)), forged!])

    expect(views.find(view => view.id === token(1))).toMatchObject({ phase: 'failed', signal: 9 })
  })
})

describe('reading the files', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('newer refusals never evict the reason a run ended', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx14-'))

    dirs.push(root)

    const files: RunFiles = {
      ledgerDir: path.join(root, 'ledger'),
      refusedDir: path.join(root, 'run'),
      stopsFile: path.join(root, 'stops.jsonl')
    }

    fs.mkdirSync(files.ledgerDir)

    const noise = Array.from({ length: 40 }, (_, i) => ({
      v: 1,
      ev: 'refused',
      ts: at(10 + i),
      session: 's',
      command: `cmd ${i}`,
      code: 'policy',
      detail: 'd'
    }))

    fs.writeFileSync(
      path.join(files.ledgerDir, 'runs.jsonl'),
      [start(1, 0), kill(1, 5), end(1, 5, null, 9)].map(line => JSON.stringify(line)).join('\n')
    )
    fs.writeFileSync(path.join(files.ledgerDir, 'refused.jsonl'), noise.map(line => JSON.stringify(line)).join('\n'))

    expect(fold(readRunEvents(files)).find(view => view.id === token(1))).toMatchObject({ stoppedByModes: true })
  })
})
