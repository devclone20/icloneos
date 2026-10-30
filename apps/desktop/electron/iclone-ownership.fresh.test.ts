import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createOwnershipService, emittedOwnershipState, freshOwnershipAnswer } from './iclone-ownership'
import { BUNDLED_REGISTRY } from './iclone-ownership-registry'

describe('freshOwnershipAnswer — WORK acts only on a proof made during the call (V3-I r2 M-E)', () => {
  it('a decisive held proof made at or after the call is held', () => {
    expect(freshOwnershipAnswer({ checkedAt: 100, pending: false, state: 'held' }, 100)).toBe('held')
  })

  it('a held proof older than the call, or still pending, is unknown', () => {
    expect(freshOwnershipAnswer({ checkedAt: 99, pending: false, state: 'held' }, 100)).toBe('unknown')
    expect(freshOwnershipAnswer({ checkedAt: 200, pending: true, state: 'held' }, 100)).toBe('unknown')
    expect(freshOwnershipAnswer({ checkedAt: null, pending: false, state: 'held' }, 100)).toBe('unknown')
    expect(freshOwnershipAnswer(null, 100)).toBe('unknown')
  })

  it('lost is lost, whatever its age', () => {
    expect(freshOwnershipAnswer({ checkedAt: 1, pending: true, state: 'lost' }, 100)).toBe('lost')
  })

  it('real guard: held once, then the verify fails (sold while closed, RPC down) -> unknown, never the stale held', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3i-own-fresh-'))
    const contract = BUNDLED_REGISTRY.entries[0]!.contract
    let verdict: 'held' | 'unknown' = 'held'

    try {
      const svc = createOwnershipService({
        archiver: {
          archive: async () => ({ dir: '', ok: true, remote: null }),
          ghStatus: async () => ({ detail: '', ok: true })
        } as never,
        door: { applyDeactivation: async () => [] } as never,
        now: () => Date.now(),
        registry: () => Promise.resolve(BUNDLED_REGISTRY),
        root,
        verify: () =>
          Promise.resolve({
            agentStatus: null,
            head: verdict === 'held' ? { number: 100, timestamp: 1 } : null,
            reason: verdict,
            transfer: null,
            verdict,
            verifications: []
          } as never)
      })

      const item = {
        chain: 'Robinhood',
        configured: true,
        contract,
        id: `robinhood:${contract}:7`,
        image: null,
        name: 'x',
        tokenId: '7'
      }

      const views = await svc.observe('0x000000000000000000000000000000000000dEaD', [item])
      const slug = views[0]?.slug ?? `robinhood-${contract}-7`

      const prove = async (s: string) => {
        const startedAt = Date.now()

        return freshOwnershipAnswer(await svc.check(s), startedAt)
      }

      expect(await prove(slug)).toBe('held')
      verdict = 'unknown'
      expect(await prove(slug)).toBe('unknown')
    } finally {
      fs.rmSync(root, { force: true, recursive: true })
    }
  })
})

describe('emittedOwnershipState — only a new proof made this launch is news to WORK (V3-I r4 m-H)', () => {
  const launchedAt = 1_000

  it('a fresh decisive held proof made this launch is held', () => {
    expect(emittedOwnershipState({ checkedAt: 1_500, pending: false, state: 'held' }, launchedAt, undefined)).toBe(
      'held'
    )
  })

  it('S1b: a non-proof save on a record held in a previous launch is unknown, never held', () => {
    expect(emittedOwnershipState({ checkedAt: 900, pending: false, state: 'held' }, launchedAt, undefined)).toBe(
      'unknown'
    )
  })

  it('a second save with the same checkedAt (no new proof) is unknown', () => {
    expect(emittedOwnershipState({ checkedAt: 1_500, pending: false, state: 'held' }, launchedAt, 1_500)).toBe(
      'unknown'
    )
  })

  it('pending is unknown; lost is lost whatever its age', () => {
    expect(emittedOwnershipState({ checkedAt: 1_500, pending: true, state: 'held' }, launchedAt, undefined)).toBe(
      'unknown'
    )
    expect(emittedOwnershipState({ checkedAt: 1, pending: true, state: 'lost' }, launchedAt, 1)).toBe('lost')
  })
})
