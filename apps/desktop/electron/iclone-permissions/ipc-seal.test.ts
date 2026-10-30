// Review r2, R2-M4: the ONE production line that hands the launch's seal fact to the authority (`keysSealed:
// keys.sealed` in registerPermissions) — exercised through registerPermissions itself, never a hand-built authority.
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { registerPermissions } from './ipc'
import type { KeySealer } from './keys'

const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const memorySealer = (): KeySealer => {
  const sealed = new Map<string, string>()

  return {
    seal: plain => {
      sealed.set('t', plain)

      return 't'
    },
    unseal: token => sealed.get(token) ?? ''
  }
}

function launch(sealer: KeySealer | null, confirmFunctionRaise: (request: unknown) => Promise<boolean>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-perm-seal-'))

  dirs.push(dir)

  return registerPermissions({
    ipcMain: { handle: () => undefined },
    isTrustedSender: () => true,
    userDataDir: dir,
    paths: { hermesHome: path.join(dir, 'hermes'), home: dir, hermesRoot: null },
    door: null,
    consent: () => null,
    lastInputAt: () => 0,
    sealer,
    confirmIgnore: async () => false,
    confirmFunctionRaise
  })
}

describe('registerPermissions passes the launch’s seal fact to the authority (R2-M4)', () => {
  it('no sealer (Keychain off): the authority is unsealed and a chosen raise is not in force', async () => {
    const authority = launch(null, async () => {
      throw new Error('an unsealed launch shows no dialog')
    })

    expect(authority.state().sealed).toBe(false)
    expect(await authority.setFunctionLevel({ fn: 'payments', level: 'ignore' }, true)).toMatchObject({ ok: true })
    expect(authority.state().unconfirmed).toEqual(['payments'])
    expect(authority.levelOf('payments')).toBe('manual')
  })

  it('a working sealer (Keychain on): the authority is sealed and a raise goes through the dialog', async () => {
    const asked: unknown[] = []

    const authority = launch(memorySealer(), async (request: unknown) => {
      asked.push(request)

      return true
    })

    expect(authority.state().sealed).toBe(true)
    expect(await authority.setFunctionLevel({ fn: 'payments', level: 'ignore' }, true)).toMatchObject({
      ok: true,
      raised: true
    })
    expect(asked).toEqual([{ fn: 'payments', from: 'mode', to: 'ignore' }])
    expect(authority.levelOf('payments')).toBe('ignore')
  })
})
