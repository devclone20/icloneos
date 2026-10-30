import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { buildBacklog } from './adoption'
import {
  beginOwnerHold,
  bindInstallTarget,
  compatGate,
  mintOwnerAck,
  publishGateVerdict,
  refreshInstallTarget
} from './gate'
import { guard, OPENRPC_PATH } from './guard'
import { runProbe } from './probe'
import { storePath, storeRoot, writeStoreJson } from './store'
import { createWatch } from './watch'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-writes-'))
const userData = path.join(tmp, 'userData')
const root = storeRoot(userData)
const HEAD = 'e'.repeat(40)

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
afterEach(() => vi.restoreAllMocks())

const WRITERS = [
  'writeFileSync',
  'appendFileSync',
  'renameSync',
  'mkdirSync',
  'rmSync',
  'unlinkSync',
  'copyFileSync',
  'openSync'
] as const

function spyWrites(): string[] {
  const paths: string[] = []

  for (const name of WRITERS) {
    const original = fs[name] as (...a: unknown[]) => unknown
    vi.spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
      const flags = args[1]
      const writeBits = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT

      const readOnly =
        name === 'openSync' &&
        (flags === undefined || flags === 'r' || (typeof flags === 'number' && (flags & writeBits) === 0))

      // A numeric first argument is a descriptor: the openSync that produced it was recorded.
      if (!readOnly && typeof args[0] !== 'number') {
        paths.push(path.resolve(String(args[0])))

        if (name === 'renameSync') {
          paths.push(path.resolve(String(args[1])))
        }
      }

      return original.apply(fs, args)
    }) as never)
  }

  return paths
}

describe('iclone-compat writes', () => {
  it('P4a.writes: gate, store, guard, probe, watch and adoption write only under userData/iclone-compat', async () => {
    const rt = path.join(tmp, 'rt')
    fs.mkdirSync(path.join(rt, '.git', 'logs'), { recursive: true })
    fs.mkdirSync(path.join(rt, path.dirname(OPENRPC_PATH)), { recursive: true })
    fs.writeFileSync(path.join(rt, '.git', 'HEAD'), `${HEAD}\n`)
    fs.writeFileSync(path.join(rt, '.git', 'logs', 'HEAD'), '')
    fs.writeFileSync(path.join(rt, OPENRPC_PATH), '{"methods":[]}')
    const now = Date.parse('2026-10-07T12:00:00Z')

    const v = {
      id: 'v-1',
      level: 'RED',
      computedAt: new Date(now - 1000).toISOString(),
      cards: [{ level: 'RED', names: ['x'] }],
      runtime: { to: HEAD.slice(0, 11) }
    }

    bindInstallTarget(() => HEAD)
    await refreshInstallTarget()
    publishGateVerdict(v)
    writeStoreJson(root, 'pending.json', v)
    const { nonce } = beginOwnerHold('v-1', now - 3000)
    expect(mintOwnerAck({ verdictId: 'v-1', nonce, names: ['x'] }, now).ok).toBe(true)

    const writes = spyWrites()
    expect(compatGate(userData, now)).toBeNull()
    writeStoreJson(root, 'verdicts/latest.json', v)
    guard({ runtimeDir: rt, healthCommit: HEAD, lockHash: 'f', cached: () => false })
    await runProbe({ lock: { methods: { a: {} } }, spec: { methods: {} }, call: async () => ({ result: 1 }) })

    const w = createWatch({
      runtimeDir: rt,
      receiptsDir: path.join(tmp, 'receipts'),
      verdictFor: async () => ({ level: 'GREEN' }),
      healthCommit: async () => HEAD,
      onVerdict: () => undefined
    })

    await w.poll()
    w.close()
    buildBacklog({ commits: [], range: { from: 'a', to: 'b', mode: 'full' } })

    expect(writes.length).toBeGreaterThanOrEqual(4)
    expect(writes.filter(p => !p.startsWith(`${root}${path.sep}`) && p !== root)).toEqual([])
  })

  it('P4a.writes: the store refuses any path that leaves userData/iclone-compat', () => {
    const writes = spyWrites()
    expect(() => writeStoreJson(root, '../escape.json', {})).toThrow(/refused/)
    expect(() => storePath(path.join(tmp, 'elsewhere'), 'x.json')).toThrow(/refused/)
    expect(() => storePath(root, '')).toThrow(/refused/)
    expect(writes).toEqual([])
  })
})
