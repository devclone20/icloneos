/**
 * V-2 — the maintained chain health (`audit.health()`, read by `state().chain`) reports exactly what the full verifier
 * reports, without walking the log on a read: every record the writer appends extends it, and anything else that
 * touches the files (an edit, a same-size edit, a cut, a planted day file, the anchor) is verified again from disk —
 * in place for a small log, by a pass that yields the loop for a large one (RED with `verifying` until it ends).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAuditLog } from './audit'

const KEY = Buffer.alloc(32, 7)
const KID = 'kid-health'

let root: string
let dir: string
const opened: { close: () => void }[] = []

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'iclone-health-'))
  dir = path.join(root, 'audit')
})

afterEach(() => {
  opened.splice(0).forEach(log => log.close())
  rmSync(root, { recursive: true, force: true })
})

const open = () => {
  const log = createAuditLog({ dir, key: KEY, kid: KID, durable: false })

  opened.push(log)

  return log
}

type Log = ReturnType<typeof open>

/** `count` records; `pad` makes each one ~pad bytes longer (a log past the in-place verification size). */
function append(log: Log, count: number, pad = 0) {
  for (let i = 0; i < count; i += 1) {
    log.append({ src: 'main', kind: 'use', reason: `r${i} ${'x'.repeat(pad)}` })
  }
}

const dayFile = () => path.join(dir, readdirSync(dir).find(name => name.endsWith('.jsonl')) as string)

/** The health without its `verifying` flag is the full verifier's report, field for field. */
function expectSameAsVerifier(log: Log) {
  const { verifying, ...health } = log.health()

  expect(verifying).toBe(false)
  expect(health).toEqual(log.verify())
}

describe('a small log (verified in place)', () => {
  it('GREEN as appended, and equal to the full verifier after every append', () => {
    const log = open()

    append(log, 20)
    expectSameAsVerifier(log)
    expect(log.health()).toMatchObject({ ok: true, records: 20, verifying: false })
  })

  it('NEGATIVE CONTROL: an edited record with no append after it is RED at the next read, as the verifier says', () => {
    const log = open()

    append(log, 10)
    expect(log.health().ok).toBe(true)

    const file = dayFile()

    writeFileSync(file, readFileSync(file, 'utf8').replace('"reason":"r4 "', '"reason":"r9 "'))
    expect(log.health().ok).toBe(false)
    expect(log.health().breaks.map(b => b.problem)).toContain('hash')
    expectSameAsVerifier(log)
  })

  it('a same-size in-place edit is still seen (the stamp includes ctime and mtime, not only the size)', () => {
    const log = open()

    append(log, 6)

    const file = dayFile()
    const text = readFileSync(file, 'utf8')
    const edited = text.replace('"reason":"r3 "', '"reason":"r7 "')

    expect(edited.length).toBe(text.length)
    writeFileSync(file, edited)
    expect(log.health().ok).toBe(false)
    expectSameAsVerifier(log)
  })

  it('a planted day file and a cut tail are RED; the next append continues from memory, still RED', () => {
    const log = open()

    append(log, 8)

    const file = dayFile()
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)

    writeFileSync(path.join(dir, '2099-01-01.jsonl'), `${lines[2]}\n`)
    expect(log.health().ok).toBe(false)
    expectSameAsVerifier(log)

    rmSync(path.join(dir, '2099-01-01.jsonl'))
    expect(log.health().ok).toBe(true)

    writeFileSync(file, `${lines.slice(0, 5).join('\n')}\n`)
    expect(log.health().ok).toBe(false)
    expectSameAsVerifier(log)
    append(log, 1)
    expect(log.health().ok).toBe(false)
    expectSameAsVerifier(log)
  })
})

describe('a large log (verified by a pass that yields the event loop)', () => {
  it('RED with `verifying` while the pass runs, then exact; appends during the pass are counted once', async () => {
    const seed = open()

    append(seed, 1_400, 800)
    seed.close()

    const log = open()

    // Opening a log past the in-place size starts the pass: nothing is GREEN before it has read every record.
    expect(log.health()).toMatchObject({ ok: false, verifying: true })
    append(log, 5)
    await log.whenVerified()
    expectSameAsVerifier(log)
    expect(log.health()).toMatchObject({ ok: true, records: 1_400 + 5 })
  })

  it('NEGATIVE CONTROL: a record edited in the middle of a large log is RED after the re-verification', async () => {
    const seed = open()

    append(seed, 1_400, 800)
    seed.close()

    const log = open()

    await log.whenVerified()
    expect(log.health().ok).toBe(true)

    const file = dayFile()

    writeFileSync(file, readFileSync(file, 'utf8').replace('"reason":"r700 ', '"reason":"r701 '))
    expect(log.health()).toMatchObject({ ok: false, verifying: true })
    await log.whenVerified()
    expect(log.health().breaks.map(b => b.problem)).toContain('hash')
    expectSameAsVerifier(log)
  })
})
