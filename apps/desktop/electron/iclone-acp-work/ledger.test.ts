import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createLedger,
  decisionsOf,
  DEFAULT_LEVEL,
  headFileOf,
  holdOf,
  levelOf,
  readLedger,
  totalsOf,
  wantsOnline,
  workHolds
} from './ledger'

let dir = ''
let file = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3i-ledger-'))
  file = path.join(dir, 'slug', 'ledger.jsonl')
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const ledger = () => createLedger({ file })

describe('the work ledger', () => {
  it('appends hash-chained records, 0600, and verifies them', () => {
    const l = ledger()

    l.append({ kind: 'online', gesture: true })
    l.append({ kind: 'earn', jobId: '1', micros: 5_000_000 })

    const read = l.read()

    expect(read.ok).toBe(true)
    expect(read.records.map(record => record.seq)).toEqual([1, 2])
    expect(read.records[1].prev).toBe(read.records[0].sha)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('detects an edited line and refuses to extend a broken chain', () => {
    const l = ledger()

    l.append({ kind: 'earn', jobId: '1', micros: 1 })
    l.append({ kind: 'earn', jobId: '2', micros: 2 })
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"micros":1', '"micros":999'))

    expect(readLedger(file)).toMatchObject({ ok: false, brokenAt: 1 })
    expect(l.append({ kind: 'online' })).toBeNull()
  })

  it('detects a deleted line', () => {
    const l = ledger()

    l.append({ kind: 'online' })
    l.append({ kind: 'offline' })
    l.append({ kind: 'online' })

    const lines = fs.readFileSync(file, 'utf8').split('\n')

    fs.writeFileSync(file, [lines[0], lines[2], ''].join('\n'))
    expect(readLedger(file).ok).toBe(false)
  })

  it('redacts secrets in notes', () => {
    const l = ledger()

    l.append({ kind: 'fix', note: 'token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leaked' })
    expect(l.read().records[0].note).not.toContain('AAAAAAAAAAAAAAAAAAAA')
  })
})

describe('folds', () => {
  it('the level starts at L1 (D1) and only a gesture record changes it', () => {
    const l = ledger()

    expect(DEFAULT_LEVEL).toBe('L1')
    expect(levelOf(l.read())).toBe('L1')
    l.append({ kind: 'level', level: 'L2', gesture: false })
    expect(levelOf(l.read())).toBe('L1')
    l.append({ kind: 'level', level: 'L2', gesture: true })
    expect(levelOf(l.read())).toBe('L2')
  })

  it('a broken chain folds the level to L0', () => {
    const l = ledger()

    l.append({ kind: 'level', level: 'L2', gesture: true })
    fs.appendFileSync(file, 'garbage\n')
    expect(levelOf(readLedger(file))).toBe('L0')
  })

  it('a decline is final: a later approve does not reopen it', () => {
    const l = ledger()

    l.append({ kind: 'decline', jobId: '9' })
    l.append({ kind: 'approve', jobId: '9' })
    l.append({ kind: 'approve', jobId: '10' })
    l.append({ kind: 'decline', jobId: '10' })

    const decisions = decisionsOf(l.read().records)

    expect(decisions.get('9')).toBe('decline')
    expect(decisions.get('10')).toBe('decline')
  })

  it('totals are exact and count each job once; spend is always 0', () => {
    const l = ledger()

    l.append({ kind: 'earn', jobId: '1', micros: 100_001 })
    l.append({ kind: 'earn', jobId: '2', micros: 2_999_999 })
    l.append({ kind: 'earn', jobId: '1', micros: 100_001 })
    l.append({ kind: 'spend-refused', jobId: '3', micros: 0 })
    expect(totalsOf(l.read().records)).toEqual({ earnedMicros: 3_100_000, spentMicros: 0 })
  })

  it('wantsOnline follows the last lifecycle intent', () => {
    const l = ledger()

    expect(wantsOnline(l.read().records)).toBe(false)
    l.append({ kind: 'online' })
    l.append({ kind: 'fix', note: 'x' })
    expect(wantsOnline(l.read().records)).toBe(true)
    l.append({ kind: 'offline' })
    expect(wantsOnline(l.read().records)).toBe(false)
  })
})

const here = path.dirname(fileURLToPath(import.meta.url))
const desktop = path.resolve(here, '..', '..')
const kinds = (l: ReturnType<typeof ledger>) => l.read().records.map(record => record.kind)
const leftovers = () => fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp'))

describe('crash safety (M-D)', () => {
  it('a kill before the rename leaves the old ledger whole; the next start drops the temp file and writes on', () => {
    const l = ledger()

    l.append({ kind: 'online', gesture: true })

    const before = fs.readFileSync(file, 'utf8')

    const killed = createLedger({
      file,
      beforeRename: () => {
        throw new Error('SIGKILL')
      }
    })

    expect(killed.append({ kind: 'decline', jobId: '7' })).toBeNull()
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(leftovers()).toHaveLength(1)

    const next = ledger()

    expect(leftovers()).toHaveLength(0)
    expect(next.append({ kind: 'decline', jobId: '7' })).not.toBeNull()
    expect(next.read()).toMatchObject({ ok: true })
    expect(kinds(next)).toEqual(['online', 'decline'])
  })

  it('a kill between the ledger rename and the head write loses nothing; the next write heals the head', () => {
    const l = ledger()

    l.append({ kind: 'online' })

    const headless = createLedger({
      file,
      beforeRename: (_temp, target) => {
        if (target.endsWith('.head')) {
          throw new Error('SIGKILL')
        }
      }
    })

    expect(headless.append({ kind: 'offline' })).not.toBeNull()
    expect(JSON.parse(fs.readFileSync(headFileOf(file), 'utf8'))).toMatchObject({ seq: 1 })

    const next = ledger()

    expect(next.read().ok).toBe(true)
    next.append({ kind: 'fix', note: 'x' })
    expect(JSON.parse(fs.readFileSync(headFileOf(file), 'utf8'))).toMatchObject({ seq: 3 })
    expect(next.read().ok).toBe(true)
  })

  it('a torn last record is cut back on load, recorded as a gap, and the ledger writes on (never blocked)', () => {
    const l = ledger()

    l.append({ kind: 'online', gesture: true })
    l.append({ kind: 'decline', jobId: '9' })
    // An older build's append killed mid-record: half a line, no newline.
    const torn = '{"v":1,"seq":3,"ts":"2026-10-21T'

    fs.appendFileSync(file, torn)

    const next = ledger()
    const read = next.read()

    expect(read.ok).toBe(true)
    expect(kinds(next)).toEqual(['online', 'decline', 'gap'])
    expect(read.records[2].note).toMatch(new RegExp(`^torn tail: ${torn.length} bytes cut`))
    expect(fs.readFileSync(file, 'utf8').endsWith('\n')).toBe(true)
    expect(fs.readdirSync(path.dirname(file)).some(name => name.startsWith('ledger.jsonl.torn-'))).toBe(true)
    expect(next.append({ kind: 'approve', jobId: '10' })).not.toBeNull()
    expect(readLedger(file)).toMatchObject({ ok: true, torn: null })
    expect(kinds(next)).toEqual(['online', 'decline', 'gap', 'approve'])
    // The verified decline survives; the gap keeps the iNFT from coming back online by itself.
    expect(decisionsOf(next.read().records).get('9')).toBe('decline')
    expect(wantsOnline(next.read().records)).toBe(false)
  })

  it('real kills: a writer SIGKILLed at random points never leaves a ledger that cannot load and write', async () => {
    const script = path.join(dir, 'writer.mjs')

    fs.writeFileSync(
      script,
      `import { createLedger } from ${JSON.stringify(path.join(here, 'ledger.ts'))}
const l = createLedger({ file: ${JSON.stringify(file)} })
for (let i = 0; ; i += 1) {
  l.append({ kind: 'fix', note: 'n'.repeat(400) + i })
  if (i === 0) process.stdout.write('ready\\n')
}
`
    )

    for (let trial = 0; trial < 4; trial += 1) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', script], {
          cwd: desktop,
          stdio: ['ignore', 'pipe', 'pipe']
        })

        child.stdout.once('data', () => setTimeout(() => child.kill('SIGKILL'), 40 + trial * 37))
        child.once('exit', (_code, signal) =>
          signal === 'SIGKILL' ? resolve() : reject(new Error(`exit ${String(_code)}`))
        )
        child.once('error', reject)
      })

      const after = ledger()
      const read = after.read()

      expect(read).toMatchObject({ ok: true, problem: null })
      expect(read.records.length).toBeGreaterThan(0)
      expect(after.append({ kind: 'fix', note: `after kill ${trial}` })).not.toBeNull()
      expect(after.read().ok).toBe(true)
      expect(leftovers()).toHaveLength(0)
    }
  }, 60_000)
})

describe('tail anchor and Repair', () => {
  it('a cut tail is detected through the head (an unkeyed chain alone cannot see it)', () => {
    const l = ledger()

    l.append({ kind: 'level', level: 'L2', gesture: true })
    l.append({ kind: 'decline', jobId: '5' })

    const lines = fs.readFileSync(file, 'utf8').split('\n')

    fs.writeFileSync(file, `${lines[0]}\n`)

    const read = readLedger(file)

    expect(read).toMatchObject({ ok: false, problem: 'truncated' })
    expect(levelOf(read)).toBe('L0')
    expect(ledger().append({ kind: 'online' })).toBeNull()
  })

  it('a re-hashed edit of the last record is caught by the head', () => {
    const l = ledger()

    l.append({ kind: 'online' })
    l.append({ kind: 'decline', jobId: '5' })

    const forged = createLedger({ file: path.join(dir, 'forge', 'ledger.jsonl') })

    forged.append({ kind: 'online' })
    forged.append({ kind: 'level', level: 'L2', gesture: true })
    // The forger re-chains the file, but the head beside it still names the real last record.
    fs.copyFileSync(forged.file, file)
    expect(readLedger(file)).toMatchObject({ ok: false, problem: 'head' })
  })

  it('Repair archives the damaged file, keeps the verified records, records the gap, and WORK writes on', () => {
    const l = ledger()

    l.append({ kind: 'online', gesture: true })
    l.append({ kind: 'level', level: 'L2', gesture: true })
    l.append({ kind: 'decline', jobId: '5' })
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"jobId":"5"', '"jobId":"6"'))

    const broken = ledger()

    expect(broken.read()).toMatchObject({ ok: false, problem: 'line', brokenAt: 3 })
    expect(broken.append({ kind: 'fix' })).toBeNull()

    const gap = broken.repair()

    expect(gap?.kind).toBe('gap')
    expect(gap?.note).toMatch(/^repair: line 3 broke the chain; the file was kept in ledger\.jsonl\.broken-/)
    expect(broken.read().ok).toBe(true)
    expect(kinds(broken)).toEqual(['online', 'level', 'gap'])
    // Across a gap: L2 must be chosen again, and the iNFT does not come back online by itself.
    expect(levelOf(broken.read())).toBe(DEFAULT_LEVEL)
    expect(wantsOnline(broken.read().records)).toBe(false)
    expect(broken.append({ kind: 'fix' })).not.toBeNull()
    expect(broken.repair()).toBeNull()
  })
})

describe('lifecycle folds', () => {
  it('holdOf reads the reason recorded with the last offline; workHolds is set by any lifecycle record', () => {
    const l = ledger()

    expect(workHolds(l.read().records)).toBe(false)
    l.append({ kind: 'online' })
    expect(workHolds(l.read().records)).toBe(true)
    l.append({ kind: 'offline', note: 'ownership-lost' })
    expect(holdOf(l.read().records)).toBe('ownership-lost')
    l.append({ kind: 'online' })
    expect(holdOf(l.read().records)).toBeNull()
  })
})

describe('K28 n1: the crash window is exactly one record', () => {
  it('a head one record behind is the crash window (ok); three well-chained records past it are a head problem', () => {
    const l = ledger()

    l.append({ kind: 'level', level: 'L1', gesture: true })

    const headAfterFirst = fs.readFileSync(headFileOf(file), 'utf8')

    l.append({ kind: 'offline' })

    const headAfterSecond = fs.readFileSync(headFileOf(file), 'utf8')

    // One record past the head: what a kill between the rename and the head write leaves.
    fs.writeFileSync(headFileOf(file), headAfterFirst)
    expect(readLedger(file)).toMatchObject({ ok: true, problem: null })

    // Records appended without their head writes (the forged L2 + online + approve of the V3-I critic, T3).
    fs.writeFileSync(headFileOf(file), headAfterSecond)
    l.append({ kind: 'level', level: 'L2', gesture: true })
    l.append({ kind: 'online' })
    l.append({ kind: 'approve', jobId: '9' })
    fs.writeFileSync(headFileOf(file), headAfterSecond)

    const read = readLedger(file)

    expect(read.problem).toBe('head')
    expect(read.ok).toBe(false)

    // n2: Repair keeps the records but its gap says which of them no head ever vouched for.
    const gap = createLedger({ file }).repair()

    expect(gap?.note).toContain('records 3..5 are unverified')
  })
})
