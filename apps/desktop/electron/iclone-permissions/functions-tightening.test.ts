// V3-F2 r5 — the lead contingency: with F2_LOOSENING_ENABLED off (this file mocks the one flag), every loosening level
// is unreachable from the IPC, the stored file and the body main signs for the plugin. The pane's half is
// src/components/permissions/function-matrix-tightening.test.tsx; the plugin's half is pytest (TestF2R5Tightening).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Shared from '../../src/iclone-shared/permissions'
import { createConsentDoor } from '../iclone-consent-door'

import { createAuditLog } from './audit'
import { createPermissionAuthority } from './authority'
import { FUNCTION_LEVELS, normalizeLevels, PERMISSION_FUNCTIONS } from './functions'
import { type KeySealer, loadPermissionKeys } from './keys'
import { createPolicySigner } from './policy-file'
import { createPermissionStore } from './store'

vi.mock('../../src/iclone-shared/permissions', async importOriginal => ({
  ...(await importOriginal<typeof Shared>()),
  F2_LOOSENING_ENABLED: false
}))

const LOOSENING = ['ignore', 'automatic', 'askOnce'] as const
const TIGHTENING = ['mode', 'askAlways', 'manual'] as const

const memorySealer = (): KeySealer => {
  const sealed = new Map<string, string>()

  return {
    seal: plain => {
      const token = `sealed-${sealed.size}`
      sealed.set(token, plain)

      return token
    },
    unseal: token => sealed.get(token) ?? ''
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'v3f2-tight-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function build() {
  const permissions = path.join(dir, 'permissions')
  const keys = loadPermissionKeys(permissions, memorySealer())

  const audit = createAuditLog({
    dir: path.join(permissions, 'audit'),
    key: keys.auditKey,
    kid: keys.kid,
    durable: false
  })

  const store = createPermissionStore(permissions, keys)

  const door = createConsentDoor({
    store: { read: () => null, write: () => undefined } as never,
    show: () => undefined,
    userDataDir: dir
  })

  const authority = createPermissionAuthority({
    store,
    audit,
    signer: createPolicySigner(permissions, keys, () => Date.now()),
    door,
    consent: () => null,
    paths: { userDataDir: dir, hermesHome: path.join(dir, 'hermes'), home: dir, hermesRoot: null },
    confirmIgnore: async () => true,
    confirmFunctionRaise: async () => true,
    keysSealed: keys.sealed
  })

  return { authority, audit, permissions, store }
}

describe('V3-F2 r5 contingency — F2_LOOSENING_ENABLED off: tightening only', () => {
  it('the IPC refuses every loosening level and still takes the three tightening ones', async () => {
    const { authority, audit } = build()

    for (const fn of PERMISSION_FUNCTIONS) {
      for (const level of LOOSENING) {
        expect(await authority.setFunctionLevel({ fn, level }, true)).toMatchObject({ ok: false, error: 'invalid' })
      }

      for (const level of TIGHTENING) {
        expect((await authority.setFunctionLevel({ fn, level }, true)).ok, `${fn} ${level}`).toBe(true)
      }
    }

    audit.close()
  })

  it('a stored file holding a loosening level reads as Follow mode, and so does the body main signs', () => {
    const { authority, audit, permissions, store } = build()

    writeFileSync(
      path.join(permissions, 'functions.json'),
      JSON.stringify({
        v: 1,
        levels: Object.fromEntries(
          PERMISSION_FUNCTIONS.map((fn, i) => [fn, FUNCTION_LEVELS[i % FUNCTION_LEVELS.length]])
        ),
        updatedAt: '2026-10-22T00:00:00.000Z'
      })
    )

    const read = store.readFunctionLevels()

    for (const fn of PERMISSION_FUNCTIONS) {
      expect(TIGHTENING).toContain(read[fn])
    }

    expect(Object.values(authority.state().functions).some(level => LOOSENING.includes(level as never))).toBe(false)
    expect(normalizeLevels({ email: 'automatic', shell: 'manual' })).toMatchObject({ email: 'mode', shell: 'manual' })
    audit.close()
  })
})
