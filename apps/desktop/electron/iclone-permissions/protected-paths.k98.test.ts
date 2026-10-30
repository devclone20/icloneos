/**
 * K98 (V3-K pass 2, S2): the agent never resets V3-I's audit chain, never removes the pocket key and never forges a
 * confinement membership token, in any mode. Main's half: `protectedPaths` covers the three stores. The plugin's half
 * (`tests/plugins/test_iclone_permissions_k98.py`) reads the fixture this file pins and floors the writes in all five
 * modes, so a path dropped here turns both suites red.
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { confinementMembersDir, protectedPaths } from './classify-policy'

const input = { userDataDir: '/ud', hermesHome: '/home/u/.hermes', home: '/home/u', hermesRoot: null }

const FIXTURE = path.resolve(
  __dirname,
  '../../../../plugins/iclone-permissions/tests/fixtures/protected_paths_k98.json'
)

const covers = (list: readonly string[], target: string) =>
  list.some(root => target === root || target.startsWith(`${root}${path.sep}`))

describe('K98 protected paths', () => {
  const list = protectedPaths(input)

  it('covers the V3-I work store: the interim audit chain, its MAC key and the ledger', () => {
    for (const target of [
      '/ud/acp-work',
      '/ud/acp-work/audit',
      '/ud/acp-work/audit/chain.jsonl',
      '/ud/acp-work/audit/interim.key',
      '/ud/acp-work/ledger.jsonl'
    ]) {
      expect(covers(list, target), target).toBe(true)
    }
  })

  it('covers the V3-J payments store: the sealed pocket key, the ledger, STOP and the mandates', () => {
    for (const target of [
      '/ud/payments',
      '/ud/payments/keys/pocket.sealed',
      '/ud/payments/ledger.jsonl',
      '/ud/payments/STOP',
      '/ud/payments/mandates/x.sdjwt'
    ]) {
      expect(covers(list, target), target).toBe(true)
    }
  })

  it('covers the confinement members folder, which lives outside userData', () => {
    const members = confinementMembersDir(input.home)

    expect(members).toBe('/home/u/Library/Caches/iclone-os-confinement/members')
    expect(covers(list, path.join(members, 'run-token'))).toBe(true)
    // The confined run's scratch is the agent's to write: protecting it would floor every confined build.
    expect(covers(list, '/home/u/Library/Caches/iclone-os-confinement/scratch/x')).toBe(false)
  })

  it('does not reach look-alike siblings or project folders', () => {
    for (const target of [
      '/ud/acp-work-export/ledger.jsonl',
      '/ud/payments-export/ledger.jsonl',
      '/home/u/project/acp-work/audit',
      '/home/u/project/payments/keys/pocket.sealed'
    ]) {
      expect(covers(list, target), target).toBe(false)
    }
  })

  it("pins the plugin's fixture: the Python floor test reads exactly this list", () => {
    const pinned = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { input: typeof input; protectedPaths: string[] }

    expect(pinned.input).toEqual(input)
    expect(pinned.protectedPaths).toEqual(list)
  })
})
