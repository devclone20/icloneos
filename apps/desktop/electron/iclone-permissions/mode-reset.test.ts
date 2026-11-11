/**
 * CF4 (B2-m1, B2-m2): the sealed launch's check of mode.json against the audit. It reads no audit file of its own
 * (the audit's open pass already gathered the newest mode_set per layer), keeps a mode whose record is intact however
 * long the history behind it, and when it must narrow a layer it tells the owner once (state().modeReset) until he
 * chooses that layer again.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAuditLog } from './audit'
import { createPermissionAuthority, type PermissionAuthority } from './authority'
import { type KeySealer, loadPermissionKeys } from './keys'
import { createPolicySigner } from './policy-file'
import { createPermissionStore } from './store'

let dir: string
let sealedKeys: Map<string, string>
let audit: ReturnType<typeof createAuditLog> | null
let authority: PermissionAuthority

const memorySealer = (sealed: Map<string, string>): KeySealer => ({
  seal: plain => {
    const token = `sealed-${sealed.size}`

    sealed.set(token, plain)

    return token
  },
  unseal: token => sealed.get(token) as string
})

const auditDir = () => path.join(dir, 'permissions', 'audit')

/** The audit log of the launch now open. */
function openAudit(): ReturnType<typeof createAuditLog> {
  if (!audit) {
    throw new Error('no launch is open')
  }

  return audit
}

/** One sealed launch; `onAuthority` runs just before the authority is created (after the audit opened). */
function launch(onAuthority?: () => void): { authorityMs: number } {
  const permissions = path.join(dir, 'permissions')
  const keys = loadPermissionKeys(permissions, memorySealer(sealedKeys))
  const signer = createPolicySigner(permissions, keys, () => Date.now())

  audit = createAuditLog({ dir: auditDir(), key: keys.auditKey, kid: keys.kid, durable: false })
  onAuthority?.()

  const began = performance.now()

  authority = createPermissionAuthority({
    seatbeltOff: () => false,
    store: createPermissionStore(permissions, keys),
    audit,
    signer,
    door: { askPermissionShown: async () => ({ outcome: 'deny', shown: true }) as never, releaseAsks: () => undefined },
    consent: () => null,
    paths: { userDataDir: dir, hermesHome: path.join(dir, 'hermes'), home: dir, hermesRoot: null },
    confirmIgnore: async () => true,
    keysSealed: keys.sealed,
    now: () => new Date()
  } as Parameters<typeof createPermissionAuthority>[0])

  const authorityMs = performance.now() - began

  authority.mintSpawnKey()

  return { authorityMs }
}

const relaunch = (onAuthority?: () => void) => {
  audit?.close()
  audit = null

  return launch(onAuthority)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-mode-reset-'))
  sealedKeys = new Map()
  audit = null
})

afterEach(() => {
  vi.restoreAllMocks()
  audit?.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('B2-m2: the sealed launch check reads no audit file of its own', () => {
  it('keeps a v0.0.5-shaped history (one old mode_set, a long tail) and reads no day file while it checks', async () => {
    launch()
    expect((await authority.setMode({ mode: 'acceptEdits', scope: 'standing' }, true)).ok).toBe(true)
    expect((await authority.setMode({ mode: 'automatic', scope: 'session', key: 'chat-1' }, true)).ok).toBe(true)

    for (let i = 0; i < 5_000; i += 1) {
      audit?.append({ src: 'main', kind: 'restart', reason: `filler ${i}` })
    }

    const dayFileReads: string[] = []

    const { authorityMs } = relaunch(() => {
      const real = fs.readFileSync
      vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: never) => {
        if (typeof file === 'string' && file.startsWith(auditDir())) {
          dayFileReads.push(file)
        }

        return real(file, options)
      }) as typeof fs.readFileSync)
    })

    expect(dayFileReads).toEqual([])
    expect(authority.state().mode.standing).toBe('acceptEdits')
    expect(authority.state().mode.sessions['chat-1']).toBe('automatic')
    expect(authority.state().modeReset).toEqual([])
    // The check is a map lookup now: well inside one frame at 5 000 records (base: a full readFileSync + parse pass).
    expect(authorityMs).toBeLessThan(50)
  }, 120_000)
})

describe('B2-m1: a layer narrowed for want of its record is told once', () => {
  it('says what went back and what it was, and stops saying it when the owner chooses that layer again', async () => {
    launch()
    expect((await authority.setMode({ mode: 'acceptEdits', scope: 'standing' }, true)).ok).toBe(true)
    expect((await authority.setMode({ mode: 'automatic', scope: 'session', key: 'chat-1' }, true)).ok).toBe(true)
    audit?.close()
    audit = null
    fs.rmSync(auditDir(), { recursive: true, force: true })

    relaunch()

    expect(authority.state().mode.standing).toBe('manual')
    expect(authority.state().mode.sessions['chat-1']).toBeUndefined()

    const resets = authority.state().modeReset

    expect(resets.map(({ scope, key, was, now }) => ({ scope, key, was, now }))).toEqual([
      { scope: 'standing', key: null, was: 'acceptEdits', now: 'manual' },
      { scope: 'session', key: 'chat-1', was: 'automatic', now: null }
    ])

    const refusals = new Set(
      openAudit()
        .tail(0, 100)
        .filter(record => record.kind === 'mode_refused')
        .map(record => record.id)
    )

    expect(resets.every(reset => refusals.has(reset.id))).toBe(true)

    expect((await authority.setMode({ mode: 'acceptEdits', scope: 'standing' }, true)).ok).toBe(true)
    expect(authority.state().modeReset.map(reset => reset.scope)).toEqual(['session'])

    // The next launch finds the record the owner's choice wrote: nothing to tell.
    relaunch()
    expect(authority.state().mode.standing).toBe('acceptEdits')
    expect(authority.state().modeReset).toEqual([])
  })
})
