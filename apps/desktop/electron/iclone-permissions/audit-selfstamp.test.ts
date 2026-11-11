/**
 * v0.0.7 auditself — this writer's own append is recognised as its own even when one of its stamps lands on a whole
 * millisecond, and an outside write that lands on that same whole-millisecond stamp is still caught.
 *
 * On a fine-grained volume (APFS, ext4) about one stat in a few thousand reads back with no sub-millisecond part; the
 * stamp then reads as coarse and carries a content digest. The append after it used to hash the prefix only when its
 * own post-write stamp was coarse too, so the next (fractional) append compared the coarse stamp's digest with no
 * digest at all, judged its own record an outside change and re-verified the whole log.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAuditLog } from './audit'

const KEY = Buffer.alloc(32, 11)
const KID = 'kid-selfstamp'

let root: string
let dir: string
const opened: { close: () => void }[] = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-selfstamp-'))
  dir = path.join(root, 'audit')
})

afterEach(() => {
  vi.restoreAllMocks()
  opened.splice(0).forEach(log => log.close())
  fs.rmSync(root, { recursive: true, force: true })
})

const open = () => {
  const log = createAuditLog({ dir, key: KEY, kid: KID, durable: false })

  opened.push(log)

  return log
}

type Log = ReturnType<typeof open>

function append(log: Log, count: number) {
  for (let i = 0; i < count; i += 1) {
    log.append({ src: 'main', kind: 'use', reason: `r${i}` })
  }
}

const dayFile = () => path.join(dir, fs.readdirSync(dir).find(name => name.endsWith('.jsonl')) as string)

/** Same-size edit of the first record's reason: the hash no longer matches, the size and inode do. */
function editFirstRecord() {
  const file = dayFile()
  const text = fs.readFileSync(file, 'utf8')
  const at = text.indexOf('"reason":"r0') + '"reason":"'.length

  fs.writeFileSync(file, `${text.slice(0, at)}Z${text.slice(at + 1)}`)
}

/** Full verifications the writer runs from now on (each one settles and notifies). */
function countVerifications(log: Log) {
  const seen = { count: 0 }

  log.onVerified(() => {
    seen.count += 1
  })

  return seen
}

/**
 * Stat stub: every timestamp has a sub-millisecond part, except the first state of the day file past `pinAfter` bytes,
 * which reads back with one fixed whole-millisecond ctime and mtime for as long as that inode keeps that size (so an
 * outsider's same-size edit lands on exactly the same stamp, as it would inside one coarse tick).
 */
function stubWholeMillisecond() {
  const pin = { ino: -1, after: Number.POSITIVE_INFINITY, size: -1, ctimeMs: 0, mtimeMs: 0, hits: 0 }

  const shape = <T extends fs.Stats>(stat: T): T => {
    const copy = Object.assign(Object.create(Object.getPrototypeOf(stat)) as T, stat)

    if (stat.ino === pin.ino && pin.size === -1 && stat.size > pin.after) {
      pin.size = stat.size
      pin.ctimeMs = Math.floor(stat.ctimeMs)
      pin.mtimeMs = Math.floor(stat.mtimeMs)
    }

    if (stat.ino === pin.ino && stat.size === pin.size) {
      pin.hits += 1
      copy.ctimeMs = pin.ctimeMs
      copy.mtimeMs = pin.mtimeMs
    } else {
      copy.ctimeMs = Number.isInteger(stat.ctimeMs) ? stat.ctimeMs + 0.5 : stat.ctimeMs
      copy.mtimeMs = Number.isInteger(stat.mtimeMs) ? stat.mtimeMs + 0.5 : stat.mtimeMs
    }

    return copy
  }

  const realStat = fs.statSync
  const realFstat = fs.fstatSync

  vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, opts?: fs.StatSyncOptions) => {
    const stat = realStat(target, opts)

    return stat && !opts?.bigint ? shape(stat as fs.Stats) : stat
  }) as typeof fs.statSync)
  vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, opts?: fs.StatOptions) => {
    const stat = realFstat(fd, opts as never)

    return opts?.bigint ? stat : shape(stat as fs.Stats)
  }) as typeof fs.fstatSync)

  return {
    pin,
    /** The next append's post-write stamp is the whole-millisecond one. */
    armNextAppend() {
      const real = realStat(dayFile())

      pin.ino = real.ino
      pin.after = real.size
      pin.size = -1
    }
  }
}

async function verifiedLog(stub: ReturnType<typeof stubWholeMillisecond>) {
  const log = open()

  append(log, 3)
  expect((await log.whenVerified()).ok).toBe(true)
  stub.armNextAppend()

  return log
}

describe('auditself: a whole-millisecond stamp of our own append', () => {
  it('the appends after it are recognised as ours: no re-verification, never verifying', async () => {
    const stub = stubWholeMillisecond()
    const log = await verifiedLog(stub)
    const verifications = countVerifications(log)

    append(log, 1)
    expect(stub.pin.size).toBeGreaterThan(0)
    append(log, 20)

    expect(stub.pin.hits).toBeGreaterThan(0)
    expect(verifications.count).toBe(0)
    expect(log.health()).toEqual({ ...log.verify(), verifying: false })
    expect(log.health().ok).toBe(true)
  })

  it('an outside same-size edit on that same whole-millisecond stamp is caught at the next read', async () => {
    const stub = stubWholeMillisecond()
    const log = await verifiedLog(stub)

    append(log, 1)
    const pinnedHits = stub.pin.hits

    editFirstRecord()
    expect(fs.statSync(dayFile()).ctimeMs).toBe(stub.pin.ctimeMs)
    expect(stub.pin.hits).toBeGreaterThan(pinnedHits)

    expect(log.verify().ok).toBe(false)
    expect(log.health()).toEqual({ ...log.verify(), verifying: false })
  })

  it('an outside same-size edit on that stamp is caught by our next append (not taken as ours)', async () => {
    const stub = stubWholeMillisecond()
    const log = await verifiedLog(stub)
    const verifications = countVerifications(log)

    append(log, 1)
    editFirstRecord()
    append(log, 1)

    expect(verifications.count).toBe(1)
    expect(log.verify().ok).toBe(false)
    expect(log.health()).toEqual({ ...log.verify(), verifying: false })
  })
})

describe('auditself: real files, no stub', () => {
  it('1,300 own appends never trigger a re-verification', async () => {
    const log = open()

    append(log, 3)
    expect((await log.whenVerified()).ok).toBe(true)
    const verifications = countVerifications(log)

    for (let i = 0; i < 1_300; i += 1) {
      append(log, 1)
    }

    expect(verifications.count).toBe(0)
    expect(log.health().verifying).toBe(false)
    expect(log.health().ok).toBe(true)
  })
})
