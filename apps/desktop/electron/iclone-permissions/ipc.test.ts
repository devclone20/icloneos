import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { verifyAuditChain } from './audit'
import {
  permissionsSpawn,
  recordConfinement,
  recordInstall,
  recordPayment,
  recordWatchdog,
  registerPermissions
} from './ipc'

const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-perm-ipc-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('registerPermissions: the spawn seam and the writers other fronts use', () => {
  const sealed = new Map<string, string>()

  const authority = registerPermissions({
    ipcMain: { handle: () => undefined },
    isTrustedSender: () => true,
    userDataDir: dir,
    paths: { hermesHome: path.join(dir, 'hermes'), home: dir, hermesRoot: null },
    door: null,
    consent: () => null,
    lastInputAt: () => 0,
    sealer: {
      seal: plain => {
        sealed.set('t', plain)

        return 't'
      },
      unseal: token => sealed.get(token) ?? ''
    },
    confirmIgnore: async () => false
  })

  it('F-2: a spawn gets the lock and its fd in env, the key only on its pipe line', () => {
    const spawn = permissionsSpawn(path.join(dir, 'run'))
    const key = spawn.keyLine?.trim().split(' ')[2] ?? ''

    expect(spawn.env).toMatchObject({ ICLONE_POLICY_LOCK: '1', ICLONE_POLICY_KEY_FD: '3' })
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(spawn.env)).not.toContain(key)
    expect(authority.state().enforcement).toBe('starting')

    // Retire this spawn (its child exits) so the seam test below starts from a clean authority.
    const child = Object.assign(new EventEmitter(), { pid: 7 })

    spawn.attach(child)
    child.emit('exit')
    expect(authority.state().enforcement).toBe('no-agent')
  })

  it('V3-I / V3-G write watchdog and confinement records into the one authenticated chain, and nothing else', () => {
    expect(recordWatchdog({ kind: 'refuse', reason: 'earn-only: transfer refused' })).toMatchObject({ src: 'watchdog' })
    expect(recordConfinement({ kind: 'refuse', reason: 'write outside the profile' })).toMatchObject({
      src: 'confinement'
    })
    expect(recordWatchdog({ kind: 'mode_set' as never, reason: 'x' })).toBeNull()
    // V3-J (merge round): payment decisions, class `$`, named by the profile slug; nobody ⇒ no agent.
    expect(recordPayment({ kind: 'refuse', reason: 'per_day', agent: 'inft-7' })).toMatchObject({
      src: 'payment',
      kind: 'refuse',
      class: '$',
      reason: 'per_day',
      agent: { profile: 'inft-7', inft: null }
    })
    expect(recordPayment({ kind: 'refuse', reason: 'agent', agent: '' })).toMatchObject({ src: 'payment', agent: null })
    expect(recordPayment({ kind: 'grant' as never, reason: 'x', agent: 'inft-7' })).toBeNull()

    // REL-6: the ACP tools install is an `I` (install) action, with main's gesture verdict on the record.
    expect(
      recordInstall({ kind: 'use', reason: 'acp tools: the owner asked to install 1.0.38', gesture: true })
    ).toMatchObject({
      src: 'install',
      kind: 'use',
      class: 'I',
      gesture: true,
      action: { tool: 'acp-tools.install', target: 'https://registry.npmjs.org/' }
    })
    expect(recordInstall({ kind: 'refuse', reason: 'no click', gesture: false })).toMatchObject({
      class: 'I',
      gesture: false
    })
    expect(recordInstall({ kind: 'grant' as never, reason: 'x', gesture: true })).toBeNull()

    // Consumers read `state().chain` (anchor + key history); the bare verifier below is a test-only cross-check.
    const report = authority.state().chain

    expect(report.ok).toBe(true)
    expect(verifyAuditChain(path.join(dir, 'permissions', 'audit')).breaks).toEqual([])
  })

  it('T7 (critic r2 m4): attach(child) → hello → enforced; the child exits → exited() → no-agent; a replacement → enforced', () => {
    const spawnOne = (pid: number) => {
      const spawn = permissionsSpawn(path.join(dir, 'run'))
      const child = Object.assign(new EventEmitter(), { pid })

      spawn.attach(child)

      return { child, keyId: spawn.keyLine?.split(' ')[1] ?? '' }
    }

    const first = spawnOne(1001)

    expect(authority.state().enforcement).toBe('starting')
    expect(authority.hello(first.keyId, 1001, 0)).toBe(true)
    expect(authority.state().enforcement).toBe('enforced')
    // another pid holding the key is not that process
    expect(authority.hello(first.keyId, 4242, 0)).toBe(false)

    first.child.emit('exit')
    expect(authority.state().enforcement).toBe('no-agent')

    const second = spawnOne(1002)

    expect(authority.state().enforcement).toBe('starting')
    expect(authority.hello(second.keyId, 1002, 0)).toBe(true)
    expect(authority.state().enforcement).toBe('enforced')
  })
})
