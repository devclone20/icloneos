import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  BUNDLED_RUNTIME_PIN,
  compareWithUpstreamGuarded,
  describeUpdatePolicy,
  DEVELOPER_POLICY_ACK,
  readUpdatePolicyOverride,
  resolveUpdateDoor,
  resolveUpdatePolicy,
  runtimePinStatus,
  writeUpdatePolicyOverride
} from './update-policy'

describe('resolveUpdatePolicy', () => {
  it('packaged builds are curated for every env (R1.policy.packaged default)', () => {
    for (const env of [{}, { ICLONE_UPDATE_POLICY: 'developer' }, { ICLONE_UPDATE_POLICY: 'curated' }]) {
      expect(resolveUpdatePolicy({ isPackaged: true, env })).toBe('curated')
    }
  })

  it('dev is developer unless ICLONE_UPDATE_POLICY=curated rehearses the curated path', () => {
    expect(resolveUpdatePolicy({ isPackaged: false, env: {} })).toBe('developer')
    expect(resolveUpdatePolicy({ isPackaged: false, env: { ICLONE_UPDATE_POLICY: 'curated' } })).toBe('curated')
    expect(resolveUpdatePolicy({ isPackaged: false, env: { ICLONE_UPDATE_POLICY: 'nope' } })).toBe('developer')
  })

  it('only a well-formed operator override makes a packaged build developer, and it is logged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-policy-'))
    const file = path.join(dir, 'update-policy.json')

    try {
      expect(readUpdatePolicyOverride(file)).toBeNull()
      fs.writeFileSync(file, '{"policy":"developer"}')
      expect(readUpdatePolicyOverride(file)).toBeNull()
      fs.writeFileSync(file, 'not json')
      expect(readUpdatePolicyOverride(file)).toBeNull()

      expect(writeUpdatePolicyOverride(file, { ack: 'yes', by: 'owner' })).toEqual({ ok: false, error: 'ack-mismatch' })
      const now = () => new Date('2026-10-16T00:00:00Z')
      const written = writeUpdatePolicyOverride(file, { ack: DEVELOPER_POLICY_ACK, by: ' pat ', now })
      expect(written.ok).toBe(true)

      const override = readUpdatePolicyOverride(file)
      expect(override).toEqual({ policy: 'developer', by: 'pat', at: '2026-10-16T00:00:00.000Z' })
      const policy = resolveUpdatePolicy({ isPackaged: true, env: {}, override })
      expect(policy).toBe('developer')
      expect(describeUpdatePolicy(policy, override)).toBe(
        '[iclone-update-policy] developer (override by pat at 2026-10-16T00:00:00.000Z)'
      )
      expect(describeUpdatePolicy('curated', null)).toBe('[iclone-update-policy] curated')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runtimePinStatus (local, no network)', () => {
  it('reports aligned against the bundled pin and never an update', () => {
    const status = runtimePinStatus({ head: BUNDLED_RUNTIME_PIN.sha, policy: 'curated', now: () => 5 })
    expect(status).toMatchObject({ aligned: true, pinned: true, updateAvailable: false, behind: 0, fetchedAt: 5 })
    expect(runtimePinStatus({ head: BUNDLED_RUNTIME_PIN.sha.slice(0, 12), policy: 'curated' }).aligned).toBe(true)
    expect(runtimePinStatus({ head: '10b388300a63d83857fac3ca4f8b05b64e01bc50', policy: 'curated' }).aligned).toBe(
      false
    )
    expect(runtimePinStatus({ head: null, policy: 'developer' }).aligned).toBeNull()
  })
})

describe('compareWithUpstreamGuarded', () => {
  it('curated never reaches the raw compare; developer runs it once per click', async () => {
    const raw = vi.fn(async () => ({ supported: true, behind: 3 }))

    await expect(compareWithUpstreamGuarded('curated', raw)).resolves.toMatchObject({ reason: 'curated-only' })
    expect(raw).not.toHaveBeenCalled()
    await expect(compareWithUpstreamGuarded('developer', raw)).resolves.toEqual({ supported: true, behind: 3 })
    expect(raw).toHaveBeenCalledTimes(1)
  })
})

describe('resolveUpdateDoor (U1: the agent-latest door)', () => {
  it('agent-latest is open under every policy; anything else follows the policy', () => {
    expect(resolveUpdateDoor('curated', 'agent-latest')).toBe('agent-latest')
    expect(resolveUpdateDoor('developer', 'agent-latest')).toBe('agent-latest')
    expect(resolveUpdateDoor('curated')).toBe('curated-pin')
    expect(resolveUpdateDoor('curated', 'developer')).toBe('curated-pin')
    expect(resolveUpdateDoor('developer', 'nope')).toBe('developer')
  })

  it('the pin stays a floor: the local status never claims an update, whatever the door', () => {
    expect(runtimePinStatus({ head: 'f'.repeat(40), policy: 'curated' }).updateAvailable).toBe(false)
  })
})
