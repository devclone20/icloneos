import { EventEmitter } from 'node:events'
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import type { RefusalView } from '../../src/iclone-shared/confinement'

import {
  createNoticeThrottle,
  createRefusalLog,
  isGitObjectFallback,
  isProbeQuestion,
  isShellFolderProbe,
  logTimestamp,
  parseSandboxMessage,
  REPORTED_MAX,
  reportedRow,
  RUN_REFUSALS_MAX,
  runOfTag,
  startRefusalStream
} from './refusals'
import { explainRefusals } from './runs'

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
  it('reads ours by the tag the profile adds: the class and the run token file', () => {
    expect(
      parseSandboxMessage(
        'Sandbox: cat(5015) deny(1) file-read-data /Users/o/.ssh/id\niclone-confined:project:/m/members/project+aaaaaaaaaaaa+-+bb'
      )
    ).toEqual({
      cls: 'project',
      member: '/m/members/project+aaaaaaaaaaaa+-+bb',
      process: 'cat',
      pid: 5015,
      operation: 'file-read-data',
      target: '/Users/o/.ssh/id'
    })
    expect(
      parseSandboxMessage('Sandbox: cat(5015) deny(1) file-read-data /Users/o/.ssh/id\niclone-confined:project')
    ).toMatchObject({ cls: 'project', member: null })
  })

  it('runOfTag: the token’s name when its file lies in this instance’s members folder, else nothing', () => {
    const run = `project+${'a'.repeat(12)}+-+${'b'.repeat(32)}`

    expect(runOfTag(`/m/members/${run}`, ['/m/members'])).toBe(run)
    expect(runOfTag(`/m/members/${run}`, ['/other/members', '/m/members'])).toBe(run)
    expect(runOfTag(`/elsewhere/members/${run}`, ['/m/members'])).toBeNull()
    expect(runOfTag(`/m/members/sub/${run}`, ['/m/members'])).toBeNull()
    expect(runOfTag('/m/members/.decoy', ['/m/members'])).toBeNull()
    expect(runOfTag(null, ['/m/members'])).toBeNull()
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

const RUN = `project+${'a'.repeat(12)}+sess-9+${'b'.repeat(32)}`
const RUN2 = `research+${'c'.repeat(12)}+sess-2+${'d'.repeat(32)}`
/** This instance's members folder (never created: the stream compares names). */
const MEMBERS = '/m/instance-a/members'
const tagged = (cls: string, run: string, members = MEMBERS) => `iclone-confined:${cls}:${members}/${run}`

const event = (message: string, timestamp = '2026-10-21 10:00:00.000000+0000') =>
  `${JSON.stringify({ timestamp, eventMessage: message })}\n`

const fakeChild = () => {
  const stdout = new PassThrough()
  let killed = 0

  return {
    child: Object.assign(new EventEmitter(), { stdout, kill: () => (killed += 1) > 0 }),
    stdout,
    killed: () => killed
  }
}

describe('startRefusalStream', () => {
  it('keeps only tagged denials, attaches the live session and the run the kernel named, batches the ps lookup', async () => {
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdout, kill: () => true })
    const log = createRefusalLog(tempDir())
    const seen: number[] = []
    let lookups = 0

    const stream = startRefusalStream({
      log,
      membersDir: MEMBERS,
      confined: async () => {
        lookups += 1

        return new Map([[11, { sessionId: 'sess-9', run: RUN }]])
      },
      onRefusal: refusal => seen.push(refusal.pid),
      spawnLog: () => child as never
    })

    stdout.write('Filtering the log data using "sender == \\"Sandbox\\""\n')
    stdout.write(event(`Sandbox: cat(11) deny(1) file-read-data /x\n${tagged('project', RUN)}`))
    stdout.write(event('Sandbox: sharingd(749) deny(1) syscall-unix 494'))
    stdout.write(event(`Sandbox: cat(12) deny(1) file-read-data /gone\n${tagged('research', RUN2)}`).slice(0, 30))
    stdout.write(event(`Sandbox: cat(12) deny(1) file-read-data /gone\n${tagged('research', RUN2)}`).slice(30))
    await new Promise(resolve => setTimeout(resolve, 250))
    stream.stop()

    expect(seen).toEqual([11, 12])
    expect(lookups).toBe(1)
    // pid 12 is gone (no live fold entry): its run and session come from the kernel's line alone.
    expect(log.recent().map(item => [item.pid, item.sessionId, item.run])).toEqual([
      [12, 'sess-2', RUN2],
      [11, 'sess-9', RUN]
    ])
  })

  it('a refusal is attributed to its run by the kernel’s line even when its process is already gone', async () => {
    const { child, stdout } = fakeChild()
    const log = createRefusalLog(tempDir())

    const stream = startRefusalStream({
      log,
      membersDir: MEMBERS,
      // Nothing is confined any more by the time the batch is folded: the `cat` lasted a few milliseconds.
      confined: async () => new Map(),
      spawnLog: () => child as never
    })

    stdout.write(event(`Sandbox: cat(51243) deny(1) file-read-data /Users/o/.ssh/config\n${tagged('project', RUN)}`))
    await new Promise(resolve => setTimeout(resolve, 250))
    stream.stop()

    expect(log.recent()).toMatchObject([{ pid: 51243, run: RUN, sessionId: 'sess-9', target: '/Users/o/.ssh/config' }])
    expect(log.runCount(RUN)).toBe(1)
  })

  it('a denial whose token lies in another instance’s members folder is not this instance’s refusal', async () => {
    const { child, stdout } = fakeChild()
    const log = createRefusalLog(tempDir())
    let lookups = 0

    const stream = startRefusalStream({
      log,
      membersDir: MEMBERS,
      confined: async () => {
        lookups += 1

        return new Map()
      },
      spawnLog: () => child as never
    })

    stdout.write(
      event(`Sandbox: touch(70) deny(1) file-write-create /private/tmp/other/outside/w1\n${tagged('project', RUN, '/m/instance-b/members')}`)
    )
    // An older profile's tag names no token: nothing says whose it is.
    stdout.write(event('Sandbox: cat(71) deny(1) file-read-data /x\niclone-confined:project'))
    stdout.write(event(`Sandbox: cat(72) deny(1) file-read-data /y\n${tagged('project', RUN)}`))
    await new Promise(resolve => setTimeout(resolve, 250))
    stream.stop()

    expect(log.recent().map(item => item.pid)).toEqual([72])
    expect(lookups).toBe(1)
  })

  it('fx23: a shell looking at a folder keeps its row, marked; its read of a file, its write and any other program are not marked', async () => {
    const { child, stdout } = fakeChild()
    const log = createRefusalLog(tempDir())
    const folder = tempDir()

    const stream = startRefusalStream({
      log,
      membersDir: MEMBERS,
      confined: async () => new Map(),
      spawnLog: () => child as never
    })

    stdout.write(event(`Sandbox: bash(90) deny(1) file-read-metadata /sib/three\n${tagged('project', RUN)}`))
    stdout.write(event(`Sandbox: bash(91) deny(1) file-read-data ${folder}\n${tagged('project', RUN)}`))
    stdout.write(event(`Sandbox: bash(92) deny(1) file-read-data /sib/three/secret\n${tagged('project', RUN)}`))
    stdout.write(event(`Sandbox: bash(93) deny(1) file-write-create /sib/three/h.txt\n${tagged('project', RUN)}`))
    stdout.write(event(`Sandbox: stat(94) deny(1) file-read-metadata /sib/three\n${tagged('project', RUN)}`))
    stdout.write(event(`Sandbox: ls(95) deny(1) file-read-data ${folder}\n${tagged('project', RUN)}`))
    await new Promise(resolve => setTimeout(resolve, 250))
    stream.stop()

    expect(log.recent().map(item => item.pid).sort()).toEqual([90, 91, 92, 93, 94, 95])
    expect(log.recent().filter(item => item.shellLook).map(item => item.pid).sort()).toEqual([90, 91])
    expect(log.runCount(RUN)).toBe(6)
  })

  it('fx24: every refusal is listed and counted, wherever it pointed and whatever the run says its folder is', async () => {
    const { child, stdout } = fakeChild()
    const dir = tempDir()
    const log = createRefusalLog(dir)

    // r3-B: the runtime's own spelling of cwd put ~/.ssh "above" it. No folder a run names decides anything now.
    const start = { cwd: '/Users/me/.ssh/../p', project: '/Users/me/p' }

    const stream = startRefusalStream({
      log,
      membersDir: MEMBERS,
      confined: async () => new Map(),
      spawnLog: () => child as never
    })

    stdout.write(event(`Sandbox: bash(80) deny(1) file-read-metadata /Users/me/.ssh\n${tagged('project', RUN)}`))
    stdout.write(event(`Sandbox: bash(81) deny(1) file-read-metadata /Users/me\n${tagged('project', RUN)}`))
    stdout.write(event(`Sandbox: bash(82) deny(1) file-read-metadata /Users/me/p\n${tagged('project', RUN)}`))
    await new Promise(resolve => setTimeout(resolve, 250))
    stream.stop()

    expect(log.runCount(RUN)).toBe(3)
    expect(log.runCounts([RUN]).get(RUN)).toBe(3)

    const explained = explainRefusals(log.recent(), [], new Map([[RUN, start as never]]), 'project')

    expect(explained.map(item => item.target).sort()).toEqual(['/Users/me', '/Users/me/.ssh', '/Users/me/p'])
    expect(explained.every(item => item.shellLook === true)).toBe(true)
  })

  it('fx24: a shell’s stat of a file is not a look at a folder; a folder, or a path that is not there, is', () => {
    const dir = tempDir()
    const file = path.join(dir, 'id_ed25519')

    writeFileSync(file, 'x')

    const stat = (target: string) => ({ operation: 'file-read-metadata', process: 'bash', target })

    expect(isShellFolderProbe(stat(file))).toBe(false)
    expect(isShellFolderProbe(stat(dir))).toBe(true)
    expect(isShellFolderProbe(stat(path.join(dir, 'gone')))).toBe(true)
    expect(isShellFolderProbe({ ...stat(dir), operation: 'file-read-data' })).toBe(true)
    expect(isShellFolderProbe({ ...stat(file), operation: 'file-read-data' })).toBe(false)
    expect(isShellFolderProbe({ ...stat(dir), process: 'stat' })).toBe(false)
  })

  it('only the probe’s own question is dropped; a write, a new file or a listing aimed at the members folder is kept', async () => {
    const { child, stdout } = fakeChild()
    const log = createRefusalLog(tempDir())

    const stream = startRefusalStream({
      log,
      membersDir: MEMBERS,
      confined: async () => new Map(),
      spawnLog: () => child as never
    })

    for (const target of [`${MEMBERS}/.decoy`, `${MEMBERS}/.runtime`, `${MEMBERS}/${RUN2}`]) {
      stdout.write(event(`Sandbox: sleep(80) deny(1) file-read-data ${target}\n${tagged('project', RUN)}`))
    }

    stdout.write(event(`Sandbox: touch(81) deny(1) file-write-create ${MEMBERS}/${RUN2}x\n${tagged('project', RUN)}`))
    stdout.write(event(`Sandbox: ls(82) deny(1) file-read-data ${MEMBERS}\n${tagged('project', RUN)}`))
    stdout.write(event(`Sandbox: rm(83) deny(1) file-write-unlink ${MEMBERS}/.member\n${tagged('project', RUN)}`))
    stdout.write(event(`Sandbox: sleep(84) deny(1) file-read-data /m/instance-a/members-of-another-kind\n${tagged('project', RUN)}`))
    await new Promise(resolve => setTimeout(resolve, 250))
    stream.stop()

    expect(log.recent().map(item => item.pid).sort()).toEqual([81, 82, 83, 84])
    expect(log.runCount(RUN)).toBe(4)
    expect(isProbeQuestion({ operation: 'file-read-data', target: `${MEMBERS}/.member` }, [MEMBERS])).toBe(true)
    expect(isProbeQuestion({ operation: 'file-read-metadata', target: `${MEMBERS}/.member` }, [MEMBERS])).toBe(false)
  })
})

describe('the runtime’s own report folder', () => {
  const hardLink = (index: number, extra: Record<string, unknown> = {}) => ({
    ts: new Date(Date.UTC(2026, 10, 1, 11, 0, 0, index)).toISOString(),
    pid: 900 + index,
    process: 'hard-link',
    operation: 'hard-link-appeared',
    target: `/p/link-${index}`,
    sessionId: 'sess-9',
    root: '/p',
    ...extra
  })

  it('reads only the plugin’s hard-link rows, never with a run, and gives them a share of the list, never all of it', () => {
    const record = tempDir()
    const reported = tempDir()
    const log = createRefusalLog(record, reported)
    const day = path.join(reported, '2026-11-01.jsonl')
    const kernelLooking = { ts: '2026-11-01T12:00:00.000Z', pid: 7, process: 'cat', operation: 'file-read-data', target: '/forged', sessionId: null, run: RUN }

    writeFileSync(
      day,
      [
        JSON.stringify(kernelLooking),
        JSON.stringify(hardLink(0, { run: RUN, why: 'secret' })),
        JSON.stringify(hardLink(1, { operation: 'file-read-data' })),
        JSON.stringify(hardLink(2, { pid: 'x' })),
        ...Array.from({ length: 200 }, (_, index) => JSON.stringify(hardLink(10 + index)))
      ].join('\n')
    )

    // The runtime also forges a per-run file under its folder: it is not the run's file.
    mkdirSync(path.join(reported, 'runs'))
    writeFileSync(path.join(reported, 'runs', `${RUN}.jsonl`), `${JSON.stringify(kernelLooking)}\n`.repeat(300))

    for (let index = 0; index < 150; index += 1) {
      log.append({ ts: new Date(Date.UTC(2026, 10, 1, 10, 0, 0, index)).toISOString(), pid: index, process: 'cat', operation: 'file-read-data', target: `/k/${index}`, sessionId: null, run: RUN })
    }

    const list = log.recent(100)
    const fromRuntime = list.filter(item => item.process === 'hard-link')

    expect(list).toHaveLength(100)
    expect(fromRuntime).toHaveLength(REPORTED_MAX)
    expect(list.filter(item => item.process === 'cat')).toHaveLength(100 - REPORTED_MAX)
    expect(list.some(item => item.target === '/forged')).toBe(false)
    expect(fromRuntime.every(item => item.run === null && item.why === undefined)).toBe(true)
    expect(log.runCount(RUN)).toBe(150)
    // Newest first, across both sources.
    expect(list.map(item => item.ts)).toEqual([...list.map(item => item.ts)].sort().reverse())
  })

  it('reportedRow rebuilds a row from the one shape, and refuses every other', () => {
    expect(reportedRow(hardLink(1, { run: RUN, extra: 'x' }))).toEqual({
      ts: hardLink(1).ts,
      pid: 901,
      process: 'hard-link',
      operation: 'hard-link-appeared',
      target: '/p/link-1',
      sessionId: 'sess-9',
      root: '/p',
      run: null
    })
    expect(reportedRow(hardLink(1, { operation: 'cannot-scan-after-run' }))?.operation).toBe('cannot-scan-after-run')
    expect(reportedRow(hardLink(1, { process: 'cat' }))).toBeNull()
    expect(reportedRow(hardLink(1, { ts: 'yesterday' }))).toBeNull()
    expect(reportedRow(hardLink(1, { sessionId: 4 }))).toBeNull()
    expect(reportedRow(hardLink(1, { target: 'x'.repeat(5_000) }))?.target).toHaveLength(1_000)
    expect(reportedRow(null)).toBeNull()
  })

  it('reads only the tail of a file the runtime grew without bound', () => {
    const reported = tempDir()
    const log = createRefusalLog(tempDir(), reported)
    const padding = `${JSON.stringify({ process: 'noise', pad: 'x'.repeat(1_000) })}\n`.repeat(2_000)

    writeFileSync(path.join(reported, '2026-11-01.jsonl'), `${JSON.stringify(hardLink(0))}\n${padding}${JSON.stringify(hardLink(1))}\n`)

    expect(log.recent(100).map(item => item.target)).toEqual(['/p/link-1'])
  })
})

describe('a run’s own refusal file', () => {
  const row = (run: string, index: number): RefusalView => ({
    ts: new Date(Date.UTC(2026, 10, 1, 10, 0, 0, index)).toISOString(),
    pid: 100 + index,
    process: 'cat',
    operation: 'file-read-data',
    target: `/x/${index}`,
    sessionId: null,
    run
  })

  it('holds the same number while the run lives and after it ends, whatever newer runs refuse', () => {
    const log = createRefusalLog(tempDir())

    for (let index = 0; index < 3; index += 1) {
      log.append(row(RUN, index))
    }

    expect(log.runCount(RUN)).toBe(3)

    // Another run refuses far more than the shared list keeps: the first run's count does not move.
    for (let index = 0; index < 1_200; index += 1) {
      log.append(row(RUN2, 10 + index))
    }

    expect(log.recent(1_000).filter(item => item.run === RUN)).toHaveLength(0)
    expect(log.runCount(RUN)).toBe(3)
    expect(log.runCounts([RUN, RUN2, `project+${'f'.repeat(12)}+-+${'0'.repeat(32)}`])).toEqual(
      new Map([
        [RUN, 3],
        [RUN2, 1_200]
      ])
    )
    // A second reader of the same folder (the next main) counts the file, not a memory.
    expect(createRefusalLog(log.dir).runCount(RUN)).toBe(3)
    expect(statSync(path.join(log.dir, 'runs', `${RUN}.jsonl`)).mode & 0o777).toBe(0o600)
    // About 0.1 ms per append (two small synchronous writes), measured under load: the time here is the 1,203 rows'
    // disk round trips on a contended test machine, not the product.
  }, 120_000)

  it('stops at the cap and is never written for a row with no run token', () => {
    const log = createRefusalLog(tempDir())

    for (let index = 0; index < RUN_REFUSALS_MAX + 5; index += 1) {
      log.append(row(RUN, index))
    }

    log.append({ ...row('not-a-token', 1), run: null })
    expect(log.runCount(RUN)).toBe(RUN_REFUSALS_MAX)
    expect(log.runCount('not-a-token')).toBe(0)
    expect(readdirSync(path.join(log.dir, 'runs'))).toEqual([`${RUN}.jsonl`])
    // 10,006 appends, the same cost per row as above. 18 s and 77 s measured in full runs on a loaded machine.
  }, 180_000)

  it('sweeps a run file untouched for a week, and keeps a fresh one', () => {
    const log = createRefusalLog(tempDir())
    const old = `project+${'e'.repeat(12)}+-+${'1'.repeat(32)}`

    log.append(row(old, 0))
    log.append(row(RUN, 1))
    utimesSync(path.join(log.dir, 'runs', `${old}.jsonl`), new Date(0), new Date(0))
    expect(log.sweepRuns(Date.now(), [])).toBe(1)
    expect(readdirSync(path.join(log.dir, 'runs'))).toEqual([`${RUN}.jsonl`])
    expect(log.runCount(old)).toBe(0)
  })

  it('never sweeps the file of a run still alive or still in the ledger, however old its last refusal', () => {
    const log = createRefusalLog(tempDir())
    const old = `project+${'e'.repeat(12)}+-+${'1'.repeat(32)}`

    log.append(row(old, 0))
    log.append(row(RUN, 1))
    utimesSync(path.join(log.dir, 'runs', `${old}.jsonl`), new Date(0), new Date(0))
    utimesSync(path.join(log.dir, 'runs', `${RUN}.jsonl`), new Date(0), new Date(0))
    expect(log.sweepRuns(Date.now(), [old])).toBe(1)
    expect(readdirSync(path.join(log.dir, 'runs'))).toEqual([`${old}.jsonl`])
    expect(log.runCount(old)).toBe(1)
  })
})

describe('startRefusalStream — idle cost', () => {
  it('1 000 foreign denials cost 0 ps folds and 0 records', async () => {
    const { child, stdout } = fakeChild()
    const log = createRefusalLog(tempDir())
    let lookups = 0

    const stream = startRefusalStream({
      log,
      membersDir: MEMBERS,
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
      membersDir: MEMBERS,
      confined: async () => new Map(),
      backfillSeconds: 5,
      spawnLog: () => live.child as never,
      spawnShow: seconds => {
        asked.push(seconds)

        return show.child as never
      }
    })

    const early = event(
      `Sandbox: cat(21) deny(1) file-read-data /early\n${tagged('project', RUN)}`,
      '2026-10-21 10:00:00.1+0000'
    )

    const both = event(
      `Sandbox: cat(22) deny(1) file-read-data /both\n${tagged('project', RUN)}`,
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

describe('fx19: git finishing an object is not a refusal; a real refusal in .git still is', () => {
  const OBJ = '/p/repo/.git/objects/1c/tmp_obj_2qeQ4n'

  it('only git, only file-link, only its own temp object', () => {
    expect(isGitObjectFallback({ operation: 'file-link', process: 'git', target: OBJ })).toBe(true)
    expect(isGitObjectFallback({ operation: 'file-link', process: 'git', target: '/p/repo/.git/objects/tmp_obj_x' })).toBe(true)
    // The rename failing too is a write line, and it shows.
    expect(isGitObjectFallback({ operation: 'file-write-create', process: 'git', target: OBJ })).toBe(false)
    expect(isGitObjectFallback({ operation: 'file-write-data', process: 'git', target: '/p/repo/.git/config' })).toBe(false)
    expect(isGitObjectFallback({ operation: 'file-link', process: 'ln', target: OBJ })).toBe(false)
    expect(isGitObjectFallback({ operation: 'file-link', process: 'git', target: '/p/repo/secret' })).toBe(false)
    // fx20 (lens5 m1): only inside a repository's own git folder; any other folder named objects keeps its row.
    expect(isGitObjectFallback({ operation: 'file-link', process: 'git', target: '/Users/x/Documents/objects/tmp_obj_exfil' })).toBe(false)
    expect(isGitObjectFallback({ operation: 'file-link', process: 'git', target: '/p/repo/.git/modules/sub/objects/ab/tmp_obj_1' })).toBe(true)
    expect(isGitObjectFallback({ operation: 'file-link', process: 'git', target: '/p/repo/.git/config' })).toBe(false)
  })

  it('through the stream: the fallback is dropped, the config refusal in the same batch is kept', async () => {
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), kill: () => true })
    const seen: string[] = []
    const fx19 = createRefusalLog(mkdtempSync(path.join(os.tmpdir(), 'iclone-fx19-')))

    const stream = startRefusalStream({
      log: fx19,
      membersDir: MEMBERS,
      confined: async () => new Map(),
      onRefusal: refusal => seen.push(refusal.target),
      spawnLog: () => child as never
    })

    stdout.write(event(`Sandbox: git(21) deny(1) file-link ${OBJ}\n${tagged('project', RUN)}`))
    stdout.write(event(`Sandbox: git(21) deny(1) file-write-data /p/repo/.git/config\n${tagged('project', RUN)}`))
    await new Promise(resolve => setTimeout(resolve, 250))
    stream.stop()

    expect(seen).toEqual(['/p/repo/.git/config'])
  })
})

describe('L4-02: the pane never reads a whole day file', () => {
  const DAY = '2026-11-10'
  const NOW = () => new Date(`${DAY}T12:00:00Z`)

  const row = (index: number, run: string | null = null): RefusalView => ({
    ts: new Date(Date.UTC(2026, 10, 10, 8, 0, 0) + index).toISOString(),
    pid: 1_000 + index,
    process: 'rg',
    operation: 'file-read-data',
    target: `/Users/o/project/deep/path/${index}/${'x'.repeat(200)}`,
    sessionId: null,
    run
  })

  /** A day file of about `megabytes` MB (filler rows) whose last `newest` rows are distinct; returns its row count. */
  const bigDayFile = (dir: string, megabytes: number, newest: number): number => {
    const filler = `${JSON.stringify(row(-1))}\n`
    const perChunk = Math.floor((1024 * 1024) / Buffer.byteLength(filler))
    const chunk = Buffer.from(filler.repeat(perChunk))
    const fd = openSync(path.join(dir, `${DAY}.jsonl`), 'w', 0o600)

    try {
      for (let mb = 0; mb < megabytes; mb += 1) {
        writeSync(fd, chunk)
      }

      writeSync(fd, Array.from({ length: newest }, (_, index) => `${JSON.stringify(row(index))}\n`).join(''))
    } finally {
      closeSync(fd)
    }

    return megabytes * perChunk + newest
  }

  /** Runs `work` while measuring the longest stretch the event loop went without a turn. */
  const longestStall = async (work: () => Promise<unknown>): Promise<number> => {
    let longest = 0
    let last = performance.now()
    let running = true

    const tick = () => {
      const at = performance.now()

      longest = Math.max(longest, at - last)
      last = at

      if (running) {
        setImmediate(tick)
      }
    }

    setImmediate(tick)
    await work()
    running = false

    return longest
  }

  it('200 MB day file: the start never blocks main > 16 ms, state reads take < 5 ms, the count is exact', async () => {
    const dir = tempDir()
    const total = bigDayFile(dir, 200, 1_000)
    // A holder, not a bare `let`: TypeScript narrows a `let` assigned only inside the callback to `null` here.
    const opened: { log: ReturnType<typeof createRefusalLog> | null } = { log: null }

    const stall = await longestStall(async () => {
      const started = performance.now()

      const log = createRefusalLog(dir, null, { now: NOW })

      opened.log = log
      // The constructor's own synchronous part: a listing and a few opens.
      expect(performance.now() - started).toBeLessThan(16)
      await log.ready
    })

    expect(stall).toBeLessThan(16)

    const ready = opened.log

    if (ready === null) {
      throw new Error('the refusal log was never opened')
    }

    let slowest = 0

    for (let read = 0; read < 50; read += 1) {
      const started = performance.now()

      ready.recent(1_000)
      ready.day()
      slowest = Math.max(slowest, performance.now() - started)
    }

    expect(slowest).toBeLessThan(5)
    expect(ready.recent(3).map(item => item.pid)).toEqual([1_999, 1_998, 1_997])
    expect(ready.recent(1_000)).toHaveLength(1_000)
    expect(ready.day()).toEqual({ day: DAY, rows: total, olderRows: 0, parts: 0 })

    // The next row closes the oversized file into part 1: every row is still counted, and the note has a number.
    ready.append(row(5_000))
    expect(ready.day()).toEqual({ day: DAY, rows: total + 1, olderRows: total, parts: 1 })
    expect(readdirSync(dir).sort()).toEqual([`${DAY}.1.jsonl`, `${DAY}.jsonl`, 'runs'])
    expect(ready.recent(2).map(item => item.pid)).toEqual([6_000, 1_999])
  }, 300_000)

  it('past 512 MB (more than one string can hold) today’s rows are still listed and counted', async () => {
    const dir = tempDir()
    const total = bigDayFile(dir, 520, 200)
    const log = createRefusalLog(dir, null, { now: NOW })

    await log.ready
    expect(log.recent(200).map(item => item.pid)).toEqual(Array.from({ length: 200 }, (_, index) => 1_199 - index))
    expect(log.day()).toMatchObject({ rows: total, olderRows: 0 })
  }, 300_000)

  it('rotation: each part stays under the cap, the count stays exact across parts and across a restart', async () => {
    const dir = tempDir()
    const log = createRefusalLog(dir, null, { now: NOW, dayFileMaxBytes: 16 * 1024 })

    await log.ready
    log.appendAll(Array.from({ length: 1_500 }, (_, index) => row(index, RUN)))

    const files = readdirSync(dir).filter(name => name.endsWith('.jsonl'))
    const lines = (name: string) => readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).length
    const parts = files.filter(name => name !== `${DAY}.jsonl`)

    expect(parts.length).toBeGreaterThan(10)

    for (const name of files) {
      expect(statSync(path.join(dir, name)).size).toBeLessThanOrEqual(16 * 1024)
      expect(statSync(path.join(dir, name)).mode & 0o777).toBe(0o600)
    }

    const older = parts.reduce((sum, name) => sum + lines(name), 0)

    expect(older + lines(`${DAY}.jsonl`)).toBe(1_500)
    expect(log.day()).toEqual({ day: DAY, rows: 1_500, olderRows: older, parts: parts.length })
    expect(log.runCount(RUN)).toBe(1_500)
    expect(log.recent(1_000).map(item => item.pid)).toEqual(
      Array.from({ length: 1_000 }, (_, index) => 2_499 - index)
    )

    // The next main: the same count from the files, the same newest rows from their tails.
    const next = createRefusalLog(dir, null, { now: NOW, dayFileMaxBytes: 16 * 1024 })

    await next.ready
    expect(next.day()).toEqual({ day: DAY, rows: 1_500, olderRows: older, parts: parts.length })
    expect(next.recent(1_000).map(item => item.pid)).toEqual(log.recent(1_000).map(item => item.pid))
  })

  it('a row appended while the start-up reads run is neither lost nor counted twice', async () => {
    const dir = tempDir()

    writeFileSync(path.join(dir, `${DAY}.jsonl`), [0, 1, 2].map(index => `${JSON.stringify(row(index))}\n`).join(''))

    const log = createRefusalLog(dir, null, { now: NOW })

    log.append(row(3))
    expect(log.day().rows).toBeNull()
    await log.ready
    expect(log.day()).toMatchObject({ rows: 4 })
    expect(log.recent(10).map(item => item.pid)).toEqual([1_003, 1_002, 1_001, 1_000])
  })

  it('a burst of 10 000 refusals: at most one change notice per 250 ms, the newest rows and the count exact', async () => {
    const dir = tempDir()
    const log = createRefusalLog(dir, null, { now: NOW })
    const { child, stdout } = fakeChild()
    const notices: number[] = []
    let batches = 0
    let lastBatchAt = 0
    const throttle = createNoticeThrottle(() => notices.push(performance.now()), 250, () => performance.now())

    await log.ready

    const startedAt = performance.now()

    const stream = startRefusalStream({
      log,
      membersDir: MEMBERS,
      confined: async () => new Map(),
      onBatch: () => {
        batches += 1
        lastBatchAt = performance.now()
        throttle.notify()
      },
      spawnLog: () => child as never
    })

    for (let sent = 0; sent < 10_000; sent += 250) {
      stdout.write(
        Array.from({ length: 250 }, (_, offset) =>
          event(
            `Sandbox: rg(${sent + offset + 2}) deny(1) file-read-data /p/${sent + offset}\n${tagged('project', RUN)}`,
            `${DAY} 10:00:00.${String(sent + offset).padStart(6, '0')}+0000`
          )
        ).join('')
      )
      await new Promise(resolve => setTimeout(resolve, 30))
    }

    await new Promise(resolve => setTimeout(resolve, 700))
    stream.stop()
    throttle.stop()

    const elapsed = performance.now() - startedAt

    // Load-independent: never closer than 250 ms (so at most one per 250 ms of the run), and the last batch announced.
    expect(batches).toBeGreaterThan(3)
    expect(notices.length).toBeGreaterThan(0)
    expect(notices.length).toBeLessThanOrEqual(Math.ceil(elapsed / 250) + 1)
    expect(notices.at(-1)).toBeGreaterThanOrEqual(lastBatchAt)

    for (let index = 1; index < notices.length; index += 1) {
      expect(notices[index] - notices[index - 1]).toBeGreaterThanOrEqual(249)
    }

    expect(log.recent(3).map(item => item.target)).toEqual(['/p/9999', '/p/9998', '/p/9997'])
    expect(log.day()).toMatchObject({ rows: 10_000 })
    expect(log.runCount(RUN)).toBe(RUN_REFUSALS_MAX)
  }, 60_000)

  it('the throttle always announces the last change, after the interval', async () => {
    let clock = 0
    const sent: number[] = []
    const throttle = createNoticeThrottle(() => sent.push(clock), 250, () => clock)

    throttle.notify()
    clock = 10
    throttle.notify()
    throttle.notify()
    expect(sent).toEqual([0])
    clock = 250
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(sent).toEqual([0, 250])
    throttle.stop()
  })
})
