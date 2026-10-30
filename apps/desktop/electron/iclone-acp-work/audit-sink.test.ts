import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAuditLog, verifyAuditChain } from '../iclone-permissions/audit'

import { createWorkAuditSink, interimAuditKey, type SharedAuditWriter } from './audit-sink'
import type { WorkAuditEntry } from './watchdog'

let root = ''
let dir = ''

beforeEach(() => {
  // The chain lives one level down: V3-F anchors its head beside the audit dir, never in the shared tmp root.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3i-audit-'))
  dir = path.join(root, 'audit')
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const decline: WorkAuditEntry = { verb: 'decline', jobId: '7', gesture: true, allowed: true, reason: 'owner declined' }
const records = () => createAuditLog({ dir, ...interimAuditKey(dir) }).tail(0)

function dayFile(): string {
  const name = fs.readdirSync(dir).find(file => file.endsWith('.jsonl'))

  if (!name) {
    throw new Error('no audit day file')
  }

  return path.join(dir, name)
}

describe('the interim chain (until V3-F exports its watchdog writer)', () => {
  it('writes the V3-F record shape; the writer anchors the head beside the chain', () => {
    const sink = createWorkAuditSink({ dir, shared: null })

    sink.record('robinhood-1', decline)
    sink.record('robinhood-1', { ...decline, verb: 'level', jobId: null, allowed: false, reason: 'no gesture' })

    expect(records().map(record => [record.kind, record.action?.tool, record.answer])).toEqual([
      ['use', 'acp-work.decline', 'deny'],
      ['mode_refused', 'acp-work.level', null]
    ])
    expect(JSON.parse(fs.readFileSync(path.join(root, 'audit-head.json'), 'utf8'))).toMatchObject({ seq: 2 })
    expect(sink.integrity()).toEqual({ ok: true, problem: null })
  })

  it('a cut tail is detected on the next start and recorded as a gap, and stays visible from then on', () => {
    const sink = createWorkAuditSink({ dir, shared: null })

    sink.record('robinhood-1', decline)
    sink.record('robinhood-1', { ...decline, jobId: '8' })
    sink.record('robinhood-1', { ...decline, jobId: '9' })

    const lines = fs.readFileSync(dayFile(), 'utf8').split('\n').filter(Boolean)

    fs.writeFileSync(dayFile(), `${lines.slice(0, 1).join('\n')}\n`)
    // Without the anchor the bare verifier is blind to the cut: only the writer (V3-F T1) can see it.
    expect(verifyAuditChain(dir).ok).toBe(true)

    const next = createWorkAuditSink({ dir, shared: null })

    expect(next.integrity()).toEqual({ ok: false, problem: 'truncated' })
    expect(records().at(-1)).toMatchObject({ kind: 'gap', src: 'main', seq_main: 4 })
    expect(records().at(-1)?.reason).toMatch(/^audit integrity: records 2\.\.3 were cut from the end of the log$/)
    // The numbering continues after the anchor, so the hole stays visible to every verifier and every later start.
    expect(createWorkAuditSink({ dir, shared: null }).integrity()).toEqual({ ok: false, problem: 'truncated' })
    expect(verifyAuditChain(dir)).toMatchObject({ ok: false, gaps: 1 })
  })

  it('a forged or missing anchor is reported', () => {
    const sink = createWorkAuditSink({ dir, shared: null })

    sink.record('robinhood-1', decline)
    fs.writeFileSync(path.join(root, 'audit-head.json'), JSON.stringify({ seq: 1, sha: 'f'.repeat(64) }))
    expect(createWorkAuditSink({ dir, shared: null }).integrity()).toEqual({ ok: false, problem: 'head' })
    expect(records().at(-1)?.reason).toMatch(/^audit integrity: the chain's head anchor was changed or forged$/)
  })
})

describe('K98 follow-up: the interim sink only OPENS an existing chain', () => {
  const removed = /^audit integrity: the log and its anchor were removed$/

  it('K98-I: the chain and its anchor removed after a first start ⇒ refused: the first record says so, integrity is missing', () => {
    const sink = createWorkAuditSink({ dir, shared: null })

    sink.record('robinhood-1', decline)
    sink.record('robinhood-1', { ...decline, jobId: '8' })

    // Everything but the key: the day files, the lock and the anchor (an agent resetting the chain to a green start).
    for (const name of fs.readdirSync(dir).filter(file => file !== 'interim.key')) {
      fs.rmSync(path.join(dir, name), { force: true })
    }

    fs.rmSync(path.join(root, 'audit-head.json'))

    const next = createWorkAuditSink({ dir, shared: null })

    expect(next.integrity()).toEqual({ ok: false, problem: 'missing' })
    expect(records()[0]).toMatchObject({ kind: 'gap', src: 'main', seq_main: 1 })
    expect(records()[0].reason).toMatch(removed)
    // The refusal stays in the chain: every later start and every verifier still sees it.
    next.record('robinhood-1', { ...decline, jobId: '9' })
    expect(records().filter(record => removed.test(record.reason ?? ''))).toHaveLength(1)
  })

  it('K98-I: the whole audit dir and its anchor removed, WORK state left ⇒ still refused, never a fresh green chain', () => {
    createWorkAuditSink({ dir, shared: null }).record('robinhood-1', decline)
    fs.mkdirSync(path.join(root, 'robinhood-1'), { recursive: true })
    fs.writeFileSync(path.join(root, 'robinhood-1', 'ledger.jsonl'), '')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(path.join(root, 'audit-head.json'))

    expect(createWorkAuditSink({ dir, shared: null }).integrity()).toEqual({ ok: false, problem: 'missing' })
    expect(records()[0].reason).toMatch(removed)
  })

  it('K98-I: control — a true first start (nothing on disk) opens a new chain, green, with no refusal', () => {
    const sink = createWorkAuditSink({ dir, shared: null })

    expect(sink.integrity()).toEqual({ ok: true, problem: null })
    sink.record('robinhood-1', decline)
    expect(records().some(record => record.kind === 'gap')).toBe(false)
    // And a normal second start (chain + anchor present) stays green.
    expect(createWorkAuditSink({ dir, shared: null }).integrity()).toEqual({ ok: true, problem: null })
  })
})

describe('the switch to the V3-F writer', () => {
  it('with `shared` set, every decision goes to it with the watchdog source, and no interim chain is written', () => {
    const appended: Array<Parameters<SharedAuditWriter['append']>[0]> = []
    const sink = createWorkAuditSink({ dir, shared: { append: entry => appended.push(entry) } })

    sink.record('robinhood-1', decline)
    expect(appended).toMatchObject([
      { src: 'watchdog', kind: 'use', answer: 'deny', action: { tool: 'acp-work.decline', target: 'robinhood-1#7' } }
    ])
    expect(fs.existsSync(dir)).toBe(false)
  })
})
