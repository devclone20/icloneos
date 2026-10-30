import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { createRefusalLog, logTimestamp, parseSandboxMessage, startRefusalStream } from './refusals'

const dirs: string[] = []

const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'v3g-refusals-'))

  dirs.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('parseSandboxMessage', () => {
  it('reads ours by the tag the profile adds', () => {
    expect(
      parseSandboxMessage('Sandbox: cat(5015) deny(1) file-read-data /Users/o/.ssh/id\niclone-confined:project')
    ).toEqual({
      cls: 'project',
      process: 'cat',
      pid: 5015,
      operation: 'file-read-data',
      target: '/Users/o/.ssh/id'
    })
  })

  it('another app sandbox has no tag; noise is not a denial', () => {
    expect(parseSandboxMessage('Sandbox: sharingd(749) deny(1) syscall-unix 494')?.cls).toBeNull()
    expect(parseSandboxMessage('1 duplicate report for Sandbox: x(1) deny(1) y')).toBeNull()
    expect(
      parseSandboxMessage('Sandbox: my proc(7) deny(1) mach-lookup com.apple.securityd\niclone-confined:build')?.process
    ).toBe('my proc')
  })
})

it('logTimestamp converts the log format to ISO', () => {
  expect(logTimestamp('2026-10-21 10:14:10.235910+0100')).toBe('2026-10-21T09:14:10.235Z')
  expect(logTimestamp('garbage', () => new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z')
})

describe('the refusal log', () => {
  it('appends 0600 JSONL per day and reads newest first, redacting secrets', () => {
    const log = createRefusalLog(tempDir())

    log.append({
      ts: '2026-10-20T23:59:00Z',
      pid: 1,
      process: 'cat',
      operation: 'file-read-data',
      target: '/a',
      sessionId: null
    })
    log.append({
      ts: '2026-10-21T00:01:00Z',
      pid: 2,
      process: 'curl',
      operation: 'network-outbound',
      target: 'Bearer sk-abcdefghijklmnopqrstuvwxyz123456',
      sessionId: 's'
    })

    const recent = log.recent()

    expect(recent.map(item => item.pid)).toEqual([2, 1])
    expect(recent[0].target).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
    expect(statSync(path.join(log.dir, '2026-10-21.jsonl')).mode & 0o777).toBe(0o600)
  })
})

describe('startRefusalStream', () => {
  it('keeps only tagged denials, attaches the live session, batches the ps lookup', async () => {
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdout, kill: () => true })
    const log = createRefusalLog(tempDir())
    const seen: number[] = []
    let lookups = 0

    const stream = startRefusalStream({
      log,
      confined: async () => {
        lookups += 1

        return new Map([[11, 'sess-9']])
      },
      onRefusal: refusal => seen.push(refusal.pid),
      spawnLog: () => child as never
    })

    const event = (message: string) =>
      `${JSON.stringify({ timestamp: '2026-10-21 10:00:00.000000+0000', eventMessage: message })}\n`

    stdout.write('Filtering the log data using "sender == \\"Sandbox\\""\n')
    stdout.write(event('Sandbox: cat(11) deny(1) file-read-data /x\niclone-confined:project'))
    stdout.write(event('Sandbox: sharingd(749) deny(1) syscall-unix 494'))
    stdout.write(event('Sandbox: cat(12) deny(1) file-read-data /gone\niclone-confined:research').slice(0, 30))
    stdout.write(event('Sandbox: cat(12) deny(1) file-read-data /gone\niclone-confined:research').slice(30))
    await new Promise(resolve => setTimeout(resolve, 250))
    stream.stop()

    expect(seen).toEqual([11, 12])
    expect(lookups).toBe(1)
    expect(log.recent().map(item => [item.pid, item.sessionId])).toEqual([
      [12, null],
      [11, 'sess-9']
    ])
  })
})

describe('startRefusalStream — K97 idle cost', () => {
  const fakeChild = () => {
    const stdout = new PassThrough()
    let killed = 0

    return {
      child: Object.assign(new EventEmitter(), { stdout, kill: () => (killed += 1) > 0 }),
      stdout,
      killed: () => killed
    }
  }

  const event = (message: string, timestamp = '2026-10-21 10:00:00.000000+0000') =>
    `${JSON.stringify({ timestamp, eventMessage: message })}\n`

  it('1 000 foreign denials cost 0 ps folds and 0 records', async () => {
    const { child, stdout } = fakeChild()
    const log = createRefusalLog(tempDir())
    let lookups = 0

    const stream = startRefusalStream({
      log,
      confined: async () => {
        lookups += 1

        return new Map()
      },
      spawnLog: () => child as never
    })

    for (let index = 0; index < 1_000; index += 1) {
      stdout.write(event(`Sandbox: sharingd(${700 + (index % 50)}) deny(1) syscall-unix ${index}`))
    }

    await new Promise(resolve => setTimeout(resolve, 250))
    stream.stop()

    expect(lookups).toBe(0)
    expect(log.recent()).toEqual([])
  })

  it('the look-back reads the moment before the stream connected, and a denial read twice counts once', async () => {
    const live = fakeChild()
    const show = fakeChild()
    const log = createRefusalLog(tempDir())
    const asked: number[] = []

    const stream = startRefusalStream({
      log,
      confined: async () => new Map(),
      backfillSeconds: 5,
      spawnLog: () => live.child as never,
      spawnShow: seconds => {
        asked.push(seconds)

        return show.child as never
      }
    })

    const early = event(
      'Sandbox: cat(21) deny(1) file-read-data /early\niclone-confined:project',
      '2026-10-21 10:00:00.1+0000'
    )

    const both = event(
      'Sandbox: cat(22) deny(1) file-read-data /both\niclone-confined:project',
      '2026-10-21 10:00:00.2+0000'
    )

    show.stdout.write(early)
    show.stdout.write(both)
    show.stdout.end()
    live.stdout.write(both)
    await new Promise(resolve => setTimeout(resolve, 250))
    stream.stop()

    expect(asked).toEqual([5])
    expect(
      log
        .recent()
        .map(item => item.pid)
        .sort()
    ).toEqual([21, 22])
    expect(live.killed()).toBe(1)
  })
})
