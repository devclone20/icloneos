/**
 * Permfix (v0.0.7 lenses L2, L3) — a mode change is applied, recorded and published in click order, NARROW-FIRST:
 * a narrowing reaches the plugin and the launcher right after mode.json is renamed, a broadening only once it is on
 * stable storage and its `mode_set` line exists. A flush that fails never leaves the plugin on a broader mode than
 * main, the UI and the audit hold. The flush is the seam: delayed or failed per call.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AtomicWrite from '../lib/atomic-write'

import { createAuditLog } from './audit'
import { createPermissionAuthority, type PermissionAuthority } from './authority'
import { type KeySealer, loadPermissionKeys } from './keys'
import * as modes from './modes'
import type { PermissionMode } from './modes'
import { createPolicySigner } from './policy-file'
import { createPermissionStore } from './store'

const seam = vi.hoisted(() => ({
  /** Per syncFileAndDir call: a delay in ms, or an error to reject with. Consumed in call order; empty = real flush. */
  plan: [] as (number | Error)[],
  writes: [] as { file: string; durable: boolean | undefined }[],
  /** How many more mode.json writes succeed; after that every one throws. null = all succeed. */
  modeWritesLeft: null as number | null
}))

vi.mock('../lib/atomic-write', async importOriginal => {
  const real = await importOriginal<typeof AtomicWrite>()

  return {
    ...real,
    writeFileAtomicSync: (file: string, data: string | Uint8Array, options?: { durable?: boolean }) => {
      seam.writes.push({ file, durable: options?.durable })

      if (seam.modeWritesLeft !== null && file.endsWith('mode.json')) {
        if (seam.modeWritesLeft <= 0) {
          throw new Error('EIO (injected mode.json write)')
        }

        seam.modeWritesLeft -= 1
      }

      return real.writeFileAtomicSync(file, data, options as never)
    },
    syncFileAndDir: async (file: string) => {
      const step = seam.plan.shift()

      if (step instanceof Error) {
        await new Promise(resolve => setTimeout(resolve, 5))
        throw step
      }

      if (typeof step === 'number') {
        await new Promise(resolve => setTimeout(resolve, step))
      }

      return real.syncFileAndDir(file)
    }
  }
})

const memorySealer = (sealed: Map<string, string>): KeySealer => {
  return {
    seal: plain => {
      const token = `sealed-${sealed.size}`

      sealed.set(token, plain)

      return token
    },
    unseal: token => sealed.get(token) as string
  }
}

// Looked up at run time so the rest of this file runs (and shows its own result) on a tree without it.
const isNarrowing = (from: PermissionMode, to: PermissionMode): boolean =>
  ((modes as Record<string, unknown>).isNarrowing as (a: PermissionMode, b: PermissionMode) => boolean)(from, to)

let dir: string
/** One sealer for the whole test, so a second launch on the same directory unseals the first one's keys. */
let sealedKeys: Map<string, string>
let audit: ReturnType<typeof createAuditLog>
let authority: PermissionAuthority
let released: number
/** Every publish: the standing mode signed, and the last mode_set line in the audit at that moment. */
let published: { standing: PermissionMode; lastModeSet: PermissionMode | null }[]

const lastModeSet = (): PermissionMode | null =>
  audit
    .tail(0, 10_000)
    .filter(record => record.kind === 'mode_set')
    .at(-1)?.mode ?? null

function build(sealedRun: boolean) {
  const permissions = path.join(dir, 'permissions')
  const keys = loadPermissionKeys(permissions, sealedRun ? memorySealer(sealedKeys) : null)
  const signer = createPolicySigner(permissions, keys, () => Date.now())

  audit = createAuditLog({ dir: path.join(permissions, 'audit'), key: keys.auditKey, kid: keys.kid, durable: false })
  authority = createPermissionAuthority({
    seatbeltOff: () => false,
    store: createPermissionStore(permissions, keys),
    audit,
    signer: {
      ...signer,
      publish: body => {
        published.push({ standing: body.standing, lastModeSet: lastModeSet() })

        return signer.publish(body)
      }
    },
    door: {
      askPermissionShown: async () => ({ outcome: 'deny', shown: true }) as never,
      releaseAsks: () => {
        released += 1
      }
    },
    consent: () => null,
    paths: { userDataDir: dir, hermesHome: path.join(dir, 'hermes'), home: dir, hermesRoot: null },
    confirmIgnore: async () => true,
    keysSealed: keys.sealed,
    now: () => new Date()
  } as Parameters<typeof createPermissionAuthority>[0])
  authority.mintSpawnKey()
}

/** What mode.json holds, read through a store of its own (a verified file's body). */
const diskStanding = (): PermissionMode =>
  createPermissionStore(path.join(dir, 'permissions'), loadPermissionKeys(path.join(dir, 'permissions'), memorySealer(sealedKeys))).readMode().standing

const setStanding = (mode: PermissionMode) => authority.setMode({ mode, scope: 'standing' }, true)
const standingInForce = () => authority.state().mode.standing
const lastPublished = () => published.at(-1)?.standing
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-mode-order-'))
  seam.plan = []
  seam.writes = []
  seam.modeWritesLeft = null
  sealedKeys = new Map()
  published = []
  released = 0
})

afterEach(() => {
  audit?.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the partial order of modes (from MODE_TABLE)', () => {
  it('narrowing only where every cell is at most as wide; incomparable pairs are not narrowings', () => {
    expect(isNarrowing('automatic', 'manual')).toBe(true)
    expect(isNarrowing('ignore', 'automatic')).toBe(true)
    expect(isNarrowing('acceptEdits', 'manual')).toBe(true)
    expect(isNarrowing('automatic', 'acceptEdits')).toBe(true)
    expect(isNarrowing('manual', 'automatic')).toBe(false)
    expect(isNarrowing('manual', 'ignore')).toBe(false)
    expect(isNarrowing('manual', 'plan')).toBe(false)
    expect(isNarrowing('plan', 'manual')).toBe(false)
    expect(isNarrowing('manual', 'manual')).toBe(true)
  })
})

describe.each([false, true])('sealed=%s', sealedRun => {
  it('L2-M1 / L3-4: two changes whose flushes finish in reverse order end in click order', async () => {
    build(sealedRun)
    seam.plan = [150, 0]

    const first = setStanding('acceptEdits')
    const second = setStanding('plan')

    await Promise.all([first, second])

    expect(standingInForce()).toBe('plan')
    expect(lastModeSet()).toBe('plan')
    expect(lastPublished()).toBe('plan')
    expect(audit.tail(0, 100).filter(r => r.kind === 'mode_set').map(r => r.mode)).toEqual(['acceptEdits', 'plan'])
  })

  it('L3-2: a narrowing reaches the plugin before its flush ends', async () => {
    build(sealedRun)
    await setStanding('automatic')
    seam.plan = [300, 300, 300, 300]

    const change = setStanding('manual')

    await sleep(60)
    expect(lastPublished()).toBe('manual')
    await change
    expect(lastPublished()).toBe('manual')
    expect(lastModeSet()).toBe('manual')
  })

  it('L3-3: while a broadening is not yet durable, any other publish still signs the old mode', async () => {
    build(sealedRun)
    seam.plan = [300, 300, 300, 300]

    const change = setStanding('automatic')

    await sleep(60)
    authority.mintSpawnKey()
    expect(lastPublished()).toBe('manual')
    expect(standingInForce()).toBe('manual')
    await change
    expect(lastPublished()).toBe('automatic')
    // No policy ever carried Automatic before its mode_set line existed.
    published.filter(p => p.standing === 'automatic').forEach(p => expect(p.lastModeSet).toBe('automatic'))
  })

  it('L3-1: a failed flush on a narrowing leaves the narrower mode in force everywhere', async () => {
    build(sealedRun)
    await setStanding('automatic')
    seam.plan = [new Error('EIO (injected)'), new Error('EIO (injected)'), new Error('EIO (injected)'), new Error('EIO (injected)')]

    const result = await setStanding('manual')

    expect(result.ok).toBe(false)
    expect(standingInForce()).toBe('manual')
    expect(lastPublished()).toBe('manual')
    expect(lastModeSet()).toBe('manual')
  })

  it('L2-minor / L3-1: a failed flush on a broadening is refused and nothing publishes the broader mode', async () => {
    build(sealedRun)
    seam.plan = [new Error('EIO (injected)'), new Error('EIO (injected)'), new Error('EIO (injected)'), new Error('EIO (injected)')]

    const result = await setStanding('automatic')

    expect(result.ok).toBe(false)
    expect(standingInForce()).toBe('manual')
    expect(lastPublished()).toBe('manual')
    expect(published.some(p => p.standing === 'automatic')).toBe(false)
    expect(lastModeSet()).not.toBe('automatic')
    authority.mintSpawnKey()
    expect(lastPublished()).toBe('manual')
  })

  it('Ignore: asks are released only after the change is durable and recorded, never after a failed flush', async () => {
    build(sealedRun)
    seam.plan = [new Error('EIO (injected)'), new Error('EIO (injected)'), new Error('EIO (injected)'), new Error('EIO (injected)')]

    const failed = await setStanding('ignore')

    expect(failed.ok).toBe(false)
    expect(released).toBe(0)
    expect(published.some(p => p.standing === 'ignore')).toBe(false)

    seam.plan = [100, 100, 100, 100]

    const change = setStanding('ignore')

    await sleep(30)
    expect(released).toBe(0)
    expect((await change).ok).toBe(true)
    expect(released).toBe(1)
    expect(lastPublished()).toBe('ignore')
  })
})

describe('L3-5: the first sealed mode write', () => {
  it('re-signs its siblings durably; only mode.json is flushed off the main thread', async () => {
    build(true)
    seam.writes = []
    await setStanding('acceptEdits')

    const stateFiles = new Set(['grants.json', 'functions.json', 'fn-grants.json'])
    const siblings = seam.writes.filter(write => stateFiles.has(path.basename(write.file)))

    expect(siblings.length).toBeGreaterThan(0)
    siblings.forEach(write => expect(write.durable).not.toBe(false))
  })
})


describe('a broadening whose flush and roll-back both fail', () => {
  it('is not trusted by the next launch: the last audited mode stays in force, and the reason is recorded', async () => {
    build(true)
    await setStanding('acceptEdits')
    seam.modeWritesLeft = 1
    seam.plan = [new Error('EIO (injected)'), new Error('EIO (injected)'), new Error('EIO (injected)'), new Error('EIO (injected)')]

    const result = await setStanding('automatic')

    expect(result.ok).toBe(false)
    expect(standingInForce()).toBe('acceptEdits')
    expect(diskStanding()).toBe('automatic')
    audit.close()

    seam.modeWritesLeft = null
    seam.plan = []
    build(true)

    expect(standingInForce()).toBe('acceptEdits')
    expect(lastPublished()).toBe('acceptEdits')
    expect(diskStanding()).toBe('acceptEdits')

    const refusal = audit.tail(0, 100).filter(r => r.kind === 'mode_refused').at(-1)

    expect(refusal?.reason).toContain('automatic')
    expect(refusal?.reason).toContain('acceptEdits stays in force')
  })
})
