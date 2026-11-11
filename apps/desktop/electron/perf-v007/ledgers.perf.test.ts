/**
 * v0.0.7 PERF gates L4-03 / L4-04 / L4-06: how long the main thread is held by
 *   - the Payments pane's poll and a payment's append on a 100k-row payments ledger (L4-03),
 *   - an ACP-work append on a 100k-record WORK ledger (L4-04),
 *   - removing a 1000-frame recording folder (L4-06),
 * each measured BEFORE (the v0.0.6 code path, replayed here on the same fixture) and AFTER (the shipped path), with
 * the event-loop delay histogram and the synchronous slice of the call (gate-helpers' block meter).
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createLedger as createWorkLedger, readLedger as readWork, headFileOf as workHeadOf } from '../iclone-acp-work/ledger'
import { createLedger, headFileOf, readLedger } from '../iclone-x402/ledger'
import { ledgerSync } from '../lib/append-log'
import { writeFileAtomicSync } from '../lib/atomic-write'
import { removeFramesFolder } from '../main/screen-frames-removal'

import { below, type GateItem, PERF_V007_ENABLED, report, startBlockMeter, timed } from './gate-helpers'

const ROWS = 100_000
const FRAMES = 1_000
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex')

/** A payments chain shaped like the real one (a signature row per paid call), written straight to disk. */
function writePaymentsFixture(file: string, rows: number, startMs: number): void {
  const out: string[] = []
  let prev = '0'.repeat(64)

  for (let seq = 1; seq <= rows; seq += 1) {
    const body = {
      v: 1,
      seq,
      ts: new Date(startMs + seq).toISOString(),
      kind: 'signed',
      agent: 'agent-one',
      resource: `https://api.example.com/v1/tools/search?q=item-${seq}&page=${seq % 7}`,
      payTo: '0x1111111111111111111111111111111111111111',
      network: 'eip155:8453',
      micros: 1_000,
      rule: null,
      mandate: null,
      transactionId: null,
      nonce: `0x${sha256(`nonce-${seq}`)}`,
      transaction: null,
      note: 'paid per call',
      prev
    }

    const sha = sha256(JSON.stringify(body))

    out.push(`${JSON.stringify({ ...body, sha })}\n`)
    prev = sha
  }

  fs.writeFileSync(file, out.join(''), { mode: 0o600 })
  fs.writeFileSync(headFileOf(file), JSON.stringify({ seq: rows, sha: prev }), { mode: 0o600 })
}

function writeWorkFixture(file: string, rows: number, startMs: number): void {
  const out: string[] = []
  let prev = '0'.repeat(64)

  for (let seq = 1; seq <= rows; seq += 1) {
    const body = {
      v: 1,
      seq,
      ts: new Date(startMs + seq).toISOString(),
      kind: seq % 2 ? 'offer' : 'quote',
      jobId: String(seq),
      chainId: 8453,
      micros: 1_000,
      rule: null,
      level: null,
      gesture: null,
      note: 'watchdog saw an offer within policy',
      prev
    }

    const sha = sha256(JSON.stringify(body))

    out.push(`${JSON.stringify({ ...body, sha })}\n`)
    prev = sha
  }

  fs.writeFileSync(file, out.join(''), { mode: 0o600 })
  fs.writeFileSync(workHeadOf(file), JSON.stringify({ seq: rows, sha: prev }), { mode: 0o600 })
}

const REPEATS = 15

/**
 * A deferred-fsync append is measured REPEATS times in the one run: the gate reads the median (what the call costs),
 * the max is reported next to it. One sample reads the whole event loop, so a GC pause or a disk stall from another
 * process lands in it (one run read 37 ms where the same append is 0.25 ms median, 1.5 ms p95, over 300 appends).
 */
async function repeatedBlockOf(call: () => unknown): Promise<{ median: number; max: number }> {
  const samples: number[] = []

  for (let i = 0; i < REPEATS; i += 1) {
    samples.push(await blockOf(call))
  }

  samples.sort((a, b) => a - b)

  return { median: samples[Math.floor(samples.length / 2)], max: samples[samples.length - 1] }
}

async function blockOf(call: () => unknown): Promise<number> {
  const meter = startBlockMeter()

  await timed(meter, call)

  return (await meter.stop()).maxMs
}

describe.skipIf(!PERF_V007_ENABLED)('L4-03 / L4-04 / L4-06 main-thread blocking', () => {
  let root = ''
  const items: GateItem[] = []
  const info: Record<string, number> = {}

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pv7-ledg-')))

    if (!root.startsWith('/private/tmp/')) {
      throw new Error(`TMPDIR resolves to ${root}: run through iso_env.sh`)
    }
  })

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
    expect(report('L4-ledgers', items, info)).toBe(true)
  })

  it('L4-03 payments: the 3 s poll and an append on 100k rows', async () => {
    const file = path.join(root, 'payments', 'ledger.jsonl')
    const start = Date.parse('2026-11-01T00:00:00.000Z')

    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    writePaymentsFixture(file, ROWS, start)
    info.paymentsBytes = fs.statSync(file).size

    // BEFORE: every poll re-read and re-hashed the whole file on the main thread.
    const beforePoll = await blockOf(() => readLedger(file))

    // BEFORE: every append = that read + a durable rewrite of the file and of the head.
    const beforeAppend = await blockOf(() => {
      const read = readLedger(file)
      const text = read.records.map(row => `${JSON.stringify(row)}\n`).join('')

      writeFileAtomicSync(`${file}.before`, text, { mode: 0o600 })
      writeFileAtomicSync(`${file}.before.head`, JSON.stringify({ seq: 1, sha: '0' }), { mode: 0o600 })
    })

    fs.rmSync(`${file}.before`, { force: true })
    fs.rmSync(`${file}.before.head`, { force: true })

    const ledger = createLedger({ file, now: () => new Date(start + ROWS + 1_000) })

    // AFTER, first poll of a launch (or after any foreign change): the full verify, off the loop.
    const firstPoll = await blockOf(() => ledger.readAsync())
    // AFTER, every later poll: the stamp holds, nothing is re-read.
    const cachedPoll = await blockOf(() => ledger.readAsync())
    const refused = await repeatedBlockOf(() => ledger.append({ kind: 'refuse', agent: 'agent-one', rule: 'per_day' }))
    const signed = await blockOf(() => ledger.append({ kind: 'signed', agent: 'agent-one', micros: 1_000 }))

    await ledger.flush()
    expect(ledger.read()).toMatchObject({ ok: true })
    expect(ledger.read().records).toHaveLength(ROWS + REPEATS + 1)
    expect(readLedger(file)).toMatchObject({ ok: true })
    expect(readLedger(file).records).toHaveLength(ROWS + REPEATS + 1)

    // A tampered row is still caught after all that caching: the stamp moved, the whole chain is verified again.
    const text = fs.readFileSync(file, 'utf8')
    const at = text.indexOf('"micros":1000', Math.floor(text.length / 2))

    fs.writeFileSync(file, `${text.slice(0, at)}"micros":9000${text.slice(at + '"micros":1000'.length)}`)

    const tamperedPoll = await blockOf(async () => expect((await ledger.readAsync()).ok).toBe(false))

    expect(ledger.append({ kind: 'refuse', agent: 'agent-one', rule: 'per_day' })).toBeNull()

    Object.assign(info, {
      beforePoll,
      beforeAppend,
      firstPoll,
      cachedPoll,
      refused: refused.median,
      refusedMax: refused.max,
      signed,
      tamperedPoll
    })
    items.push(
      below('L4-03 poll (cached) block', cachedPoll, 5),
      below('L4-03 poll (re-verify of 100k rows) block', firstPoll, 30),
      below('L4-03 poll (re-verify after tamper) block', tamperedPoll, 30),
      below('L4-03 append (refusal, deferred fsync) block, median of 15', refused.median, 8),
      below('L4-03 append (signature, fsynced) block', signed, 30),
      below('L4-03 poll block vs before (ratio)', cachedPoll / beforePoll, 0.1, 'x'),
      below('L4-03 append block vs before (ratio)', signed / beforeAppend, 0.5, 'x')
    )
  })

  it('L4-04 ACP work: an append on 100k records', async () => {
    const file = path.join(root, 'acp-work', 'slug', 'ledger.jsonl')
    const start = Date.parse('2026-11-01T00:00:00.000Z')

    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    writeWorkFixture(file, ROWS, start)

    const ledger = createWorkLedger({ file, now: () => new Date(start + ROWS + 1_000) })

    expect(ledger.read()).toMatchObject({ ok: true })

    // BEFORE: an append rewrote the whole record set, then the head, each durably.
    const before = await blockOf(() => {
      const text = ledger.read().records.map(row => `${JSON.stringify(row)}\n`).join('')

      writeFileAtomicSync(`${file}.before`, text, { mode: 0o600 })
      writeFileAtomicSync(`${file}.before.head`, JSON.stringify({ seq: 1, sha: '0' }), { mode: 0o600 })
    })

    fs.rmSync(`${file}.before`, { force: true })
    fs.rmSync(`${file}.before.head`, { force: true })

    const offer = await repeatedBlockOf(() => ledger.append({ kind: 'offer', jobId: 'next' }))
    const decline = await blockOf(() => ledger.append({ kind: 'decline', jobId: 'next' }))

    await ledger.flush()
    expect(ledgerSync.pending()).toBe(0)

    const after = readWork(file)

    expect(after).toMatchObject({ ok: true, torn: null })
    expect(after.records.slice(-2).map(row => row.kind)).toEqual(['offer', 'decline'])
    expect(after.records.filter(row => row.kind === 'offer' && row.jobId === 'next')).toHaveLength(REPEATS)

    Object.assign(info, { workBefore: before, workOffer: offer.median, workOfferMax: offer.max, workDecline: decline })
    items.push(
      below('L4-04 append (offer, deferred fsync) block, median of 15', offer.median, 8),
      below('L4-04 append (decline, fsynced) block', decline, 30),
      below('L4-04 append block vs before (ratio)', decline / before, 0.5, 'x')
    )
  })

  it('L4-06 screen frames: removing a 1000-frame folder', async () => {
    const make = (name: string): string => {
      const folder = path.join(root, 'screen', name)

      fs.mkdirSync(folder, { recursive: true, mode: 0o700 })

      for (let i = 0; i < FRAMES; i += 1) {
        fs.writeFileSync(path.join(folder, `screen-t${String(i).padStart(4, '0')}s.png`), Buffer.alloc(4096, i % 251))
      }

      return folder
    }

    const beforeFolder = make('before')
    const before = await blockOf(() => fs.rmSync(beforeFolder, { recursive: true, force: true }))
    const afterFolder = make('after')
    const after = await blockOf(() => removeFramesFolder(afterFolder))

    expect(fs.existsSync(afterFolder)).toBe(false)

    Object.assign(info, { framesBefore: before, framesAfter: after })
    items.push(
      below('L4-06 remove 1000 frames block', after, 8),
      below('L4-06 remove block vs before (ratio)', after / before, 0.5, 'x')
    )
  })
})
