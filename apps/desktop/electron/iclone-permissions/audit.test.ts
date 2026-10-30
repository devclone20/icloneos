import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAuditLog, verifyAuditChain } from './audit'

const KEY = Buffer.alloc(32, 5)
const KID = 'kid-test'

let root: string
let dir: string

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'iclone-audit-'))
  dir = path.join(root, 'audit')
})

const opened: { close: () => void }[] = []

afterEach(() => {
  // Tests open the same log many times in one process: release the writer lock like a clean quit does.
  opened.splice(0).forEach(log => log.close())
  rmSync(root, { recursive: true, force: true })
})

const open = (extra: { expectExisting?: boolean } = {}) => {
  const log = createAuditLog({ dir, key: KEY, kid: KID, durable: false, ...extra })

  opened.push(log)

  return log
}

const onlyFile = () => path.join(dir, readdirSync(dir).find(name => name.endsWith('.jsonl')) as string)
const lines = () => readFileSync(onlyFile(), 'utf8').split('\n').filter(Boolean)
const verify = () => verifyAuditChain(dir, { key: KEY, kid: KID })

function fill(count: number) {
  const log = open()

  for (let i = 1; i <= count; i += 1) {
    log.appendSourced({
      src: 'plugin',
      kind: 'use',
      hermes_pid: 41,
      src_seq: i,
      src_key: 'k1',
      class: 'R',
      reason: `call ${i}`
    })
  }

  log.close()

  return log
}

describe('the authenticated hash-chained audit log', () => {
  it('chains and authenticates every record; files are 0600', () => {
    const log = fill(5)

    expect(log.verify()).toMatchObject({ ok: true, records: 5, gaps: 0, unauthenticated: 0, breaks: [] })
    expect(statSync(onlyFile()).mode & 0o777).toBe(0o600)
    expect(log.tail(3).map(record => record.seq_main)).toEqual([4, 5])
  })

  it('GAP DETECTOR: one deleted line turns the verifier RED (negative control)', () => {
    fill(6)
    writeFileSync(onlyFile(), `${[...lines().slice(0, 2), ...lines().slice(3)].join('\n')}\n`)

    const report = verify()

    expect(report.ok).toBe(false)
    expect(report.breaks.map(b => b.problem).sort()).toEqual(['prev', 'seq'])
    expect(report.breaks[0].line).toBe(3)
  })

  it('an edited record breaks its own digest', () => {
    fill(3)
    writeFileSync(onlyFile(), readFileSync(onlyFile(), 'utf8').replace('"kind":"use"', '"kind":"refuse"'))
    expect(verify().breaks.some(b => b.problem === 'hash')).toBe(true)
  })

  it('F-10 RE-CHAIN: a record deleted and the chain recomputed with plain sha256 (no key) is RED on every MAC', () => {
    fill(5)

    let prev = '0'.repeat(64)

    const rechained = [...lines().slice(0, 1), ...lines().slice(2)].map((line, index) => {
      const { sha256: _sha, mac, ...body } = JSON.parse(line)
      const next = { ...body, seq_main: index + 1, prev_sha256: prev }
      const sha = createHash('sha256').update(JSON.stringify(next)).digest('hex')

      prev = sha

      return JSON.stringify({ ...next, sha256: sha, mac })
    })

    writeFileSync(onlyFile(), `${rechained.join('\n')}\n`)

    const report = verify()

    expect(report.ok).toBe(false)
    expect(report.breaks.filter(b => b.problem === 'mac').length).toBeGreaterThanOrEqual(3)
    // without the key the hash chain alone looks intact: that is exactly what the MAC is for
    expect(verifyAuditChain(dir).breaks).toEqual([])
  })

  it('F-10 TRUNCATION: a cut tail is RED against the anchor at once, and stays RED after main reopens the log', () => {
    fill(8)
    writeFileSync(onlyFile(), `${lines().slice(0, 5).join('\n')}\n`)

    // RED before main ever reopens it: the signed anchor is ahead of the files.
    const head = JSON.parse(readFileSync(path.join(root, 'audit-head.json'), 'utf8'))

    expect(verifyAuditChain(dir, { key: KEY, kid: KID, head }).breaks.map(b => b.problem)).toEqual(['anchor'])

    const reopened = open()

    expect(reopened.verify().ok).toBe(false)

    const gap = reopened.tail(0, 100).find(record => record.kind === 'gap')

    expect(gap?.reason).toContain('records 6..8 were cut')
    expect(gap?.seq_main).toBe(9)
    reopened.append({ src: 'main', kind: 'restart' })
    expect(reopened.verify().breaks.map(b => b.problem)).toEqual(expect.arrayContaining(['seq', 'anchor']))
  })

  it('the anchor removed or forged is RED; a log emptied together with its anchor is RED when the key pre-existed', () => {
    fill(3)
    rmSync(path.join(root, 'audit-head.json'))
    expect(
      open()
        .verify()
        .breaks.some(b => b.problem === 'anchor')
    ).toBe(true)

    rmSync(root, { recursive: true, force: true })
    expect(open({ expectExisting: true }).verify().ok).toBe(false)
  })

  it('records under another key are not authenticated (a replaced master is visible, not silent)', () => {
    fill(2)
    expect(verifyAuditChain(dir, { key: Buffer.alloc(32, 6), kid: 'other' })).toMatchObject({
      ok: false,
      unauthenticated: 2
    })
  })

  it('F-19: a second live writer cannot open the log; a dead owner’s lock is taken over', () => {
    const log = open()

    writeFileSync(path.join(dir, '.lock'), String(process.ppid))
    expect(() => createAuditLog({ dir, key: KEY, kid: KID, durable: false })).toThrow(/held by another/)
    writeFileSync(path.join(dir, '.lock'), '999999')
    expect(() => open()).not.toThrow()
    log.close()
  })

  it('F-11: a seq already recorded is a duplicate (recorded once), across a reopen; a jump writes a gap first', () => {
    const first = open()

    first.appendSourced({ src: 'plugin', kind: 'use', hermes_pid: 7, src_seq: 1, src_key: 'a' })
    first.appendSourced({ src: 'plugin', kind: 'use', hermes_pid: 7, src_seq: 2, src_key: 'a' })
    first.close()

    const second = open()

    expect(second.appendSourced({ src: 'plugin', kind: 'use', hermes_pid: 7, src_seq: 2, src_key: 'a' })).toEqual({
      duplicate: true
    })
    second.appendSourced({ src: 'plugin', kind: 'use', hermes_pid: 7, src_seq: 5, src_key: 'a' })
    // the same pid under another spawn key (a reused pid) has its own sequence
    second.appendSourced({ src: 'plugin', kind: 'use', hermes_pid: 7, src_seq: 1, src_key: 'b' })
    second.expectThrough(7, 'b', 3)

    const gaps = second
      .tail(0, 100)
      .filter(record => record.kind === 'gap')
      .map(record => record.reason)

    expect(gaps).toEqual([
      'plugin events 3..4 from pid 7 never arrived',
      'plugin events 2..3 from pid 7 were allocated but never arrived'
    ])
    expect(second.verify()).toMatchObject({ ok: true, gaps: 2 })
  })

  it('a torn last line (crash mid-write) is reported by the verifier, and the next record links past it', () => {
    fill(2)
    writeFileSync(onlyFile(), `${readFileSync(onlyFile(), 'utf8')}{"v":1,"id":"torn`)
    open().append({ src: 'main', kind: 'restart' })
    expect(verify().breaks).toEqual([expect.objectContaining({ problem: 'parse', line: 3 })])
  })

  describe('T1 (critic r2 M1): the in-memory tail is authoritative while the log is open', () => {
    const openFilled = (count: number) => {
      const log = open()

      for (let i = 0; i < count; i += 1) {
        log.append({ src: 'main', kind: 'use', reason: `r${i}` })
      }

      return log
    }

    const parsed = () =>
      lines().map(line => JSON.parse(line) as { seq_main: number; kind: string; reason: string | null })

    it('(g) LIVE cut of records 6..8 with the anchor removed: a gap at 9 names them, numbering continues, RED', () => {
      const log = openFilled(8)

      writeFileSync(onlyFile(), `${lines().slice(0, 5).join('\n')}\n`)
      rmSync(path.join(root, 'audit-head.json'), { force: true })
      expect(log.verify().ok).toBe(true) // the anchor is gone, so the bare files look fine until main writes
      log.append({ src: 'main', kind: 'use', reason: 'after live cut' })

      const after = log.verify()
      const tail = parsed().slice(-2)

      expect(after.ok).toBe(false)
      expect(tail.map(r => r.seq_main)).toEqual([9, 10])
      expect(tail[0].kind).toBe('gap')
      expect(tail[0].reason).toBe('audit integrity: records 6..8 are missing from the log')
      expect(after.breaks.map(b => b.problem)).toEqual(expect.arrayContaining(['prev', 'seq', 'anchor']))
    })

    it('(g2) LIVE cut with the anchor kept: RED before and after main appends; the anchor moves with the chain', () => {
      const log = openFilled(8)

      writeFileSync(onlyFile(), `${lines().slice(0, 5).join('\n')}\n`)

      const before = log.verify()

      expect(before.ok).toBe(false)
      expect(before.breaks.map(b => b.problem)).toContain('anchor')
      log.append({ src: 'main', kind: 'use', reason: 'after live cut, anchor kept' })

      const after = log.verify()

      expect(after.ok).toBe(false)
      expect(after.last.seq).toBe(10)
      expect(JSON.parse(readFileSync(path.join(root, 'audit-head.json'), 'utf8')).seq).toBe(10)
      expect(parsed().find(r => r.kind === 'gap')?.reason).toBe(
        'audit integrity: records 6..8 are missing from the log'
      )
    })

    it('(h) LIVE wipe of the whole day file: never re-rooted at genesis; a gap at 9 names records 1..8, RED', () => {
      const log = openFilled(8)

      rmSync(onlyFile())
      log.append({ src: 'main', kind: 'use', reason: 'after live wipe' })

      const after = log.verify()
      const rows = parsed()

      expect(after.ok).toBe(false)
      expect(rows.map(r => r.seq_main)).toEqual([9, 10])
      expect(rows[0]).toMatchObject({ kind: 'gap', reason: 'audit integrity: records 1..8 are missing from the log' })
      expect(after.breaks.map(b => b.problem)).toEqual(expect.arrayContaining(['prev', 'seq', 'anchor']))
    })

    it('a cut noticed at the very first append of a session is a gap too (memory is set at open)', () => {
      fill(8)

      const log = open()

      writeFileSync(onlyFile(), `${lines().slice(0, 5).join('\n')}\n`)
      log.append({ src: 'main', kind: 'restart' })
      expect(
        parsed()
          .slice(-2)
          .map(r => [r.seq_main, r.kind])
      ).toEqual([
        [9, 'gap'],
        [10, 'restart']
      ])
      expect(log.verify().ok).toBe(false)
    })

    it('a disk tail AHEAD of memory is adopted only when it chain-verifies under our key', () => {
      const log = openFilled(3)
      const last = JSON.parse(lines()[2]) as { seq_main: number; sha256: string }

      // (1) records the real writer could have written: they verify, so they are adopted and numbering follows them
      const body = {
        v: 1,
        id: 'x',
        ts: new Date().toISOString(),
        seq_main: 4,
        src: 'main',
        src_seq: null,
        src_key: null,
        hermes_pid: null,
        kind: 'use',
        mode: null,
        scope: null,
        class: null,
        action: null,
        agent: null,
        grant_id: null,
        answer: null,
        gesture: null,
        reason: 'by another writer',
        kid: KID,
        prev_sha256: last.sha256
      }

      const sha = createHash('sha256').update(JSON.stringify(body)).digest('hex')
      const mac = createHmac('sha256', KEY).update(sha).digest('hex')

      writeFileSync(onlyFile(), `${readFileSync(onlyFile(), 'utf8')}${JSON.stringify({ ...body, sha256: sha, mac })}\n`)
      expect(log.append({ src: 'main', kind: 'use', reason: 'after' }).seq_main).toBe(5)
      expect(log.verify().ok).toBe(true)

      // (2) a record that does not verify (another key) is not a tail to continue from: a gap, and the verifier is RED
      const forged = { ...body, seq_main: 6, prev_sha256: log.verify().last.sha, kid: 'other' }
      const forgedSha = createHash('sha256').update(JSON.stringify(forged)).digest('hex')

      writeFileSync(
        onlyFile(),
        `${readFileSync(onlyFile(), 'utf8')}${JSON.stringify({ ...forged, sha256: forgedSha, mac: 'f'.repeat(64) })}\n`
      )
      expect(log.append({ src: 'main', kind: 'use', reason: 'after forged' }).seq_main).toBe(7)
      expect(parsed().find(r => r.seq_main === 6 && r.kind === 'gap')?.reason).toMatch(/do not verify/)
      expect(log.verify().ok).toBe(false)
    })
  })

  it('redacts secrets in targets and reasons', () => {
    const record = open().append({
      src: 'plugin',
      kind: 'use',
      action: {
        tool: 'terminal',
        target: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"',
        project_root: null
      }
    })

    expect(record.action?.target).not.toContain('abcdefghijklmnopqrstuvwxyz123456')
  })
})
