import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { redactSecrets } from '../../src/iclone-shared/redact'

import { tmpProfile } from './harness.test-helpers'
import { createLedger, headFileOf, limitsViewOf, readLedger } from './ledger'

const dirs: string[] = []

const fresh = () => {
  const dir = tmpProfile()

  dirs.push(dir)

  return path.join(dir, 'payments', 'ledger.jsonl')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('the payment ledger', () => {
  it('chains rows: seq, prev and sha verify on read; the head names the last row; the file is 0600', () => {
    const file = fresh()
    const ledger = createLedger({ file, now: () => new Date('2026-10-21T10:00:00Z') })

    const a = ledger.append({ kind: 'refuse', agent: 'x', rule: 'no_mandate' })
    const b = ledger.append({ kind: 'signed', agent: 'x', micros: 1_000_000, nonce: `0x${'ab'.repeat(32)}` })

    expect(a?.seq).toBe(1)
    expect(b?.seq).toBe(2)
    expect(b?.prev).toBe(a?.sha)
    expect(readLedger(file)).toMatchObject({ ok: true, problem: null, brokenAt: null })
    expect(JSON.parse(fs.readFileSync(headFileOf(file), 'utf8'))).toEqual({ seq: 2, sha: b?.sha })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('one byte changed in a row breaks the chain: read says line N, append refuses (returns null)', () => {
    const file = fresh()
    const ledger = createLedger({ file })

    ledger.append({ kind: 'signed', agent: 'x', micros: 1_000_000 })
    ledger.append({ kind: 'signed', agent: 'x', micros: 2_000_000 })

    const text = fs.readFileSync(file, 'utf8').replace('"micros":1000000', '"micros":1000001')

    fs.writeFileSync(file, text)

    expect(readLedger(file)).toMatchObject({ ok: false, problem: 'line', brokenAt: 1 })
    expect(ledger.append({ kind: 'refuse', rule: 'stop' })).toBeNull()
    expect(ledger.limitsView().ok).toBe(false)
  })

  it('a cut tail is seen through the head (truncated); a head left behind by a lost head write is accepted', () => {
    const file = fresh()
    const ledger = createLedger({ file })

    ledger.append({ kind: 'signed', agent: 'x', micros: 1 })
    ledger.append({ kind: 'signed', agent: 'x', micros: 2 })

    const lines = fs.readFileSync(file, 'utf8').split('\n')

    fs.writeFileSync(file, `${lines[0]}\n`)
    expect(readLedger(file)).toMatchObject({ ok: false, problem: 'truncated' })

    fs.writeFileSync(file, `${lines[0]}\n${lines[1]}\n`)
    fs.writeFileSync(headFileOf(file), JSON.stringify({ seq: 1, sha: JSON.parse(lines[0]).sha }))
    expect(readLedger(file).ok).toBe(true)
  })

  it('m3: a file cut to ONE row with its head deleted is RED (head), and the day it hid is refused (limitsView not ok)', () => {
    const file = fresh()
    const ledger = createLedger({ file })

    ledger.append({ kind: 'signed', agent: 'x', micros: 1_000_000 })
    ledger.append({ kind: 'signed', agent: 'x', micros: 1_000_000 })
    ledger.append({ kind: 'signed', agent: 'x', micros: 1_000_000 })

    const first = fs.readFileSync(file, 'utf8').split('\n')[0]

    fs.writeFileSync(file, `${first}\n`)
    fs.rmSync(headFileOf(file))
    expect(readLedger(file)).toMatchObject({ ok: false, problem: 'head' })
    expect(ledger.limitsView().ok).toBe(false)
    expect(ledger.append({ kind: 'signed', agent: 'x', micros: 1 })).toBeNull()

    // A single honest row whose head was deleted is the same shape, and is RED too: the head predates every row.
    const single = fresh()

    createLedger({ file: single }).append({ kind: 'gap' })
    fs.rmSync(headFileOf(single))
    expect(readLedger(single)).toMatchObject({ ok: false, problem: 'head' })
  })

  it('m3: the genesis head is written before the first row; a crash between that row and its head (head at seq 0) still verifies', () => {
    const file = fresh()
    const ledger = createLedger({ file })

    expect(fs.existsSync(headFileOf(file))).toBe(false)
    ledger.append({ kind: 'gap' })
    expect(JSON.parse(fs.readFileSync(headFileOf(file), 'utf8'))).toMatchObject({ seq: 1 })

    fs.writeFileSync(headFileOf(file), JSON.stringify({ seq: 0, sha: '0'.repeat(64) }))
    expect(readLedger(file)).toMatchObject({ ok: true, problem: null })
    expect(ledger.append({ kind: 'gap' })).toMatchObject({ seq: 2 })
    expect(JSON.parse(fs.readFileSync(headFileOf(file), 'utf8'))).toMatchObject({ seq: 2 })

    // Order proof: a first row whose write fails (the path is a directory) leaves the genesis head behind already.
    const blocked = fresh()

    fs.mkdirSync(blocked, { recursive: true })
    expect(createLedger({ file: blocked }).append({ kind: 'gap' })).toBeNull()
    expect(JSON.parse(fs.readFileSync(headFileOf(blocked), 'utf8'))).toEqual({ seq: 0, sha: '0'.repeat(64) })
  })

  it('a head naming a row the file does not hold (a re-hashed edit) is a head problem', () => {
    const file = fresh()
    const ledger = createLedger({ file })

    ledger.append({ kind: 'signed', agent: 'x', micros: 1 })
    ledger.append({ kind: 'signed', agent: 'x', micros: 2 })
    fs.writeFileSync(headFileOf(file), JSON.stringify({ seq: 2, sha: 'f'.repeat(64) }))

    expect(readLedger(file)).toMatchObject({ ok: false, problem: 'head' })
  })

  it('limitsView folds only signed rows that carry an agent and an amount', () => {
    const file = fresh()
    const ledger = createLedger({ file })

    ledger.append({ kind: 'signed', agent: 'a', micros: 10 })
    ledger.append({ kind: 'settled', agent: 'a', micros: 10 })
    ledger.append({ kind: 'refuse', agent: 'a', micros: 99, rule: 'per_tx' })
    ledger.append({ kind: 'signed', agent: 'b', micros: 5 })
    ledger.append({ kind: 'pending', agent: 'b', micros: 5 })

    const view = limitsViewOf(ledger.read())

    expect(view.ok).toBe(true)
    expect(view.signed.map(row => [row.agent, row.micros])).toEqual([
      ['a', 10],
      ['b', 5]
    ])
  })

  it('notes are scrubbed (a raw key in a note is masked); the transaction field keeps its hash', () => {
    const file = fresh()
    const ledger = createLedger({ file })
    const key = `0x${'ab'.repeat(32)}`
    const tx = `0x${'cd'.repeat(32)}`

    const row = ledger.append({
      kind: 'settled',
      agent: 'a',
      micros: 1,
      transaction: tx,
      note: `EVM_PRIVATE_KEY=${key} leaked ${key}`
    })

    expect(row?.note).not.toContain(key)
    expect(row?.note).not.toContain('ab'.repeat(8))
    expect(row?.transaction).toBe(tx)
    expect(fs.readFileSync(file, 'utf8')).not.toContain(key)
  })

  it('m4: a key in a note is scrubbed in every shape — 0x, bare, UPPER, split across two notes, base64 / base64url of its bytes and of its hex', () => {
    const file = fresh()
    const ledger = createLedger({ file })
    const bare = createHash('sha256').update('v3j r2 throwaway, never a key of anything').digest('hex')
    const bytes = Buffer.from(bare, 'hex')

    const shapes = {
      hex0x: `0x${bare}`,
      bare,
      upper: bare.toUpperCase(),
      halfA: bare.slice(0, 32),
      halfB: bare.slice(32),
      quarter: bare.slice(16, 32),
      b64: bytes.toString('base64'),
      b64url: bytes.toString('base64url'),
      b64hex: Buffer.from(bare).toString('base64')
    }

    for (const [name, shape] of Object.entries(shapes)) {
      ledger.append({ kind: 'gap', note: `${name}=${shape} (sign failed)` })
    }

    const text = fs.readFileSync(file, 'utf8')

    for (const [name, shape] of Object.entries(shapes)) {
      expect(text.includes(shape), name).toBe(false)
    }

    expect(readLedger(file).records.map(row => row.note)).toContain('halfA=[redacted-hex] (sign failed)')

    // Plain words stay readable: the notes the client and the server actually write.
    for (const note of ['door said no', 'x402Version 1', 'settlement failed: invalid_exact_evm_payload_signature']) {
      expect(ledger.append({ kind: 'gap', note })?.note).toBe(note)
    }
  })

  it('an unknown kind or a non-integer amount in the file is a broken line', () => {
    const file = fresh()
    const ledger = createLedger({ file })

    ledger.append({ kind: 'signed', agent: 'a', micros: 1 })

    const text = fs.readFileSync(file, 'utf8').replace('"kind":"signed"', '"kind":"bonus"')

    fs.writeFileSync(file, text)
    expect(readLedger(file)).toMatchObject({ ok: false, problem: 'line', brokenAt: 1 })
  })

  it('an empty or missing file is a valid empty chain', () => {
    const file = fresh()

    expect(readLedger(file)).toMatchObject({ ok: true, records: [] })
    expect(limitsViewOf(readLedger(file))).toEqual({ ok: true, signed: [] })
  })

  it('a leftover temp file from a crashed write is swept on create, never read as the ledger', () => {
    const file = fresh()

    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(path.join(path.dirname(file), '.ledger.jsonl.123.abcdef012345.tmp'), 'garbage')
    createLedger({ file })
    expect(fs.readdirSync(path.dirname(file))).toEqual([])
  })

  it('N1: identity fields are stored RAW (never redacted) and a malformed one refuses the append', () => {
    const file = fresh()
    const ledger = createLedger({ file })

    // Legal profile slugs the secret redactor would rewrite (a provider-key prefix, a Luhn-valid number).
    for (const agent of ['sk-trader-bot-alpha', 'pk-research-agent-01', 'ghp_agentnumberone', '4111111111111111']) {
      expect(redactSecrets(agent, { hex64: true })).not.toBe(agent)
      expect(ledger.append({ kind: 'signed', agent, micros: 1 })?.agent).toBe(agent)
    }

    const id = 'ab'.repeat(16)

    expect(ledger.append({ kind: 'mandate_use', agent: 'a', mandate: id, transactionId: id })).toMatchObject({
      mandate: id,
      transactionId: id
    })
    expect(limitsViewOf(readLedger(file)).signed.map(row => row.agent)).toEqual([
      'sk-trader-bot-alpha',
      'pk-research-agent-01',
      'ghp_agentnumberone',
      '4111111111111111'
    ])

    const before = readLedger(file).records.length

    for (const bad of [
      { agent: 'Agent 7' },
      { agent: '../x' },
      { agent: '' },
      { agent: 'a'.repeat(65) },
      { mandate: 'not-an-id' },
      { transactionId: 'AB'.repeat(16) },
      { payTo: '0xNOTANADDRESS' },
      { network: 'eip155:1' }
    ]) {
      expect(ledger.append({ kind: 'refuse', ...bad })).toBeNull()
    }

    expect(readLedger(file)).toMatchObject({ ok: true })
    expect(readLedger(file).records).toHaveLength(before)
  })

  it('I2: one clock — append(entry, at) seals only with an instant this ledger issued, unmodified; the default clock is the wall clock', () => {
    const file = fresh()
    const ledger = createLedger({ file, now: () => new Date('2026-10-21T10:00:00.000Z') })
    const other = createLedger({ file: fresh() })
    const at = ledger.now()

    expect(at.toISOString()).toBe('2026-10-21T10:00:00.000Z')
    expect(ledger.append({ kind: 'gap' }, at)?.ts).toBe('2026-10-21T10:00:00.000Z')
    expect(ledger.append({ kind: 'gap' }, new Date('2026-10-22T00:00:00.000Z'))).toBeNull()
    expect(ledger.append({ kind: 'gap' }, other.now())).toBeNull()

    const moved = ledger.now()

    moved.setTime(moved.getTime() + 86_400_000)
    expect(ledger.append({ kind: 'gap' }, moved)).toBeNull()
    expect(readLedger(file).records).toHaveLength(1)

    const before = Date.now()
    const wall = other.now().getTime()

    expect(wall).toBeGreaterThanOrEqual(before)
    expect(wall).toBeLessThanOrEqual(Date.now())
  })

  it('I6: the header says exactly what a note scrub covers — every shape it calls masked is masked, every shape it calls NOT masked is not', () => {
    const header = fs.readFileSync(path.join(__dirname, 'ledger.ts'), 'utf8').split('*/')[0]

    // The r2 overclaim is gone; the limits are written down.
    expect(header).not.toContain('a key cannot sit in a note whole, halved or encoded')
    expect(header).toContain('NOT masked')

    const file = fresh()
    const ledger = createLedger({ file })
    const hex = createHash('sha256').update('v3j r3 throwaway, never a key of anything').digest('hex')
    const bytes = Buffer.from(hex, 'hex')
    const b64 = bytes.toString('base64')
    const note = (text: string) => ledger.append({ kind: 'gap', note: text })?.note ?? ''
    const cut = (text: string, size: number) => text.match(new RegExp(`.{1,${size}}`, 'g')) as string[]

    const masked: Record<string, string[]> = {
      hexWhole: [hex],
      hexHalves: cut(hex, 32),
      hexThirds: cut(hex, 22),
      hexQuarters: cut(hex, 16),
      decimal: [BigInt(`0x${hex}`).toString(10)],
      b64Whole: [b64],
      b64Halves: cut(b64, 22),
      b64urlWhole: [bytes.toString('base64url')],
      b64OfHex: [Buffer.from(hex).toString('base64')]
    }

    for (const [name, pieces] of Object.entries(masked)) {
      for (const piece of pieces) {
        expect(note(`${name} ${piece} end`).includes(piece), `${name} masked`).toBe(false)
      }
    }

    const notMasked: Record<string, string[]> = {
      hexSpacedGroupsOf8: [cut(hex, 8).join(' ')],
      hexFifths: cut(hex, 13),
      b64Thirds: cut(b64, 15),
      percentEncoded: [[...hex].map(char => `%${char.charCodeAt(0).toString(16)}`).join('')]
    }

    for (const [name, pieces] of Object.entries(notMasked)) {
      for (const piece of pieces) {
        expect(note(`${name} ${piece} end`), `${name} is a documented limit`).toBe(`${name} ${piece} end`)
      }
    }
  })

  it('I7: timestamps only move forward — a stale issued instant, or a clock stepped back, refuses the append; a day is never backdated', () => {
    const file = fresh()
    let t = Date.parse('2026-10-21T00:00:05.000Z')
    const ledger = createLedger({ file, now: () => new Date(t) })

    // Issued at 00:00:05, held while another row is written at 00:00:06: sealing it now would backdate.
    const stale = ledger.now()

    t += 1000
    expect(ledger.append({ kind: 'signed', agent: 'x', micros: 1 })?.ts).toBe('2026-10-21T00:00:06.000Z')
    expect(ledger.append({ kind: 'signed', agent: 'y', micros: 1 }, stale)).toBeNull()

    // The wall clock steps back across midnight: refused until it passes the last row again.
    t = Date.parse('2026-10-20T23:59:59.000Z')
    expect(ledger.append({ kind: 'signed', agent: 'x', micros: 1 })).toBeNull()
    expect(ledger.append({ kind: 'signed', agent: 'x', micros: 1 }, ledger.now())).toBeNull()

    // The same millisecond as the last row is not earlier: it is accepted.
    t = Date.parse('2026-10-21T00:00:06.000Z')
    expect(ledger.append({ kind: 'gap' })?.ts).toBe('2026-10-21T00:00:06.000Z')

    t += 1
    expect(ledger.append({ kind: 'gap' }, ledger.now())?.ts).toBe('2026-10-21T00:00:06.001Z')

    const read = readLedger(file)

    expect(read.ok).toBe(true)
    expect(read.records.map(row => row.ts)).toEqual([
      '2026-10-21T00:00:06.000Z',
      '2026-10-21T00:00:06.000Z',
      '2026-10-21T00:00:06.001Z'
    ])
    expect(limitsViewOf(read).signed).toEqual([{ ts: '2026-10-21T00:00:06.000Z', agent: 'x', micros: 1 }])
  })

  it('I7: a chain whose ts goes backwards is broken on read even when every hash, prev and the head were recomputed', () => {
    const file = fresh()
    let t = Date.parse('2026-10-21T00:00:01.000Z')
    const ledger = createLedger({ file, now: () => new Date(t) })

    ledger.append({ kind: 'signed', agent: 'x', micros: 1_000_000 })
    t += 1000
    ledger.append({ kind: 'signed', agent: 'x', micros: 1_000_000 })
    t += 1000
    ledger.append({ kind: 'gap' })

    // Today's second signature moved to yesterday, the chain re-hashed from there on, the head rewritten.
    const rows = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)

    rows[1].ts = '2026-10-20T23:00:00.000Z'

    let prev = '0'.repeat(64)

    for (const row of rows) {
      const { sha: _sha, ...body } = row

      row.prev = prev
      row.sha = createHash('sha256')
        .update(JSON.stringify({ ...body, prev }))
        .digest('hex')
      prev = row.sha as string
    }

    fs.writeFileSync(file, rows.map(row => `${JSON.stringify(row)}\n`).join(''))
    fs.writeFileSync(headFileOf(file), JSON.stringify({ seq: rows.length, sha: prev }))

    expect(readLedger(file)).toMatchObject({ ok: false, problem: 'line', brokenAt: 2 })
    expect(ledger.limitsView().ok).toBe(false)

    // Control: the same rewrite with the ts left in order verifies (the rehash itself is sound).
    rows[1].ts = '2026-10-21T00:00:02.000Z'
    prev = '0'.repeat(64)

    for (const row of rows) {
      const { sha: _sha, ...body } = row

      row.prev = prev
      row.sha = createHash('sha256')
        .update(JSON.stringify({ ...body, prev }))
        .digest('hex')
      prev = row.sha as string
    }

    fs.writeFileSync(file, rows.map(row => `${JSON.stringify(row)}\n`).join(''))
    fs.writeFileSync(headFileOf(file), JSON.stringify({ seq: rows.length, sha: prev }))
    expect(readLedger(file)).toMatchObject({ ok: true, problem: null })
  })
})
