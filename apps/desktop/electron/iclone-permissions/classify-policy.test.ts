import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { paymentPaths } from '../iclone-x402/store'

import { protectedPaths, secretPaths } from './classify-policy'

const input = { userDataDir: '/ud', hermesHome: '/home/u/.hermes', home: '/home/u', hermesRoot: '/opt/hermes-agent' }

describe('protectedPaths (floors 2 + 7)', () => {
  it('T3 (critic r2 M3): the WHOLE Hermes checkout is protected, not a list of files inside it', () => {
    const protectedList = protectedPaths(input)

    const covers = (target: string) =>
      protectedList.some(root => target === root || target.startsWith(`${root}${path.sep}`))

    for (const inside of [
      'tools/file_tools.py',
      'tools/terminal_tool.py',
      'tools/patch_parser.py',
      'tui_gateway/server.py',
      'plugins/other-bundled/__init__.py',
      'plugins/iclone-permissions/classify.py',
      'venv/lib/python3.12/site-packages/sitecustomize.py',
      'venv/lib/python3.12/site-packages/evil.pth',
      'hermes_bootstrap.py'
    ]) {
      expect(covers(path.join(input.hermesRoot, inside)), inside).toBe(true)
    }

    expect(covers(input.hermesRoot)).toBe(true)
    expect(covers('/opt/hermes-agent-notes/readme.md')).toBe(false)
    expect(covers('/home/u/project/tools/file_tools.py')).toBe(false)
  })

  it('without a checkout the authority still guards its own state, the consent record and every user plugin', () => {
    const protectedList = protectedPaths({ ...input, hermesRoot: null })

    expect(protectedList).toEqual(
      expect.arrayContaining([
        path.join('/ud', 'permissions'),
        path.join('/ud', 'consent.json'),
        path.join('/ud', 'run'),
        path.join('/ud', 'confinement'),
        path.join('/home/u/.hermes', 'plugins'),
        path.join('/home/u/.hermes', '.env'),
        path.join('/home/u/.hermes', 'config.yaml')
      ])
    )
    expect(protectedList.some(p => p.startsWith('/opt'))).toBe(false)
  })

  it('merge-floor: every file of V3-J payments is a protected write — ledger, head, STOP, settings, sealed keys, mandates — and only under userData', () => {
    const protectedList = protectedPaths({ ...input, hermesRoot: null })

    const covers = (target: string) =>
      protectedList.some(root => target === root || target.startsWith(`${root}${path.sep}`))

    // The store's own paths, not a copy of them: if payments move, this follows them.
    const payments = paymentPaths(input.userDataDir)

    for (const target of [
      payments.root,
      payments.ledger,
      `${payments.ledger}.head`,
      payments.stop,
      payments.settings,
      path.join(payments.keys, 'pocket.sealed'),
      path.join(payments.mandates, `${'ab'.repeat(16)}.sdjwt`),
      path.join(payments.mandates, `${'ab'.repeat(16)}.revoked`)
    ]) {
      expect(covers(target), target).toBe(true)
    }

    expect(covers(path.join('/ud', 'payments-export', 'ledger.jsonl'))).toBe(false)
    expect(covers(path.join('/home/u/project', 'payments', 'ledger.jsonl'))).toBe(false)
  })
})

/** The plugin's rule (`_matches_secret`): the entry itself, anything under it, or a `*` glob within one segment. */
const secretCovers = (list: readonly string[], target: string) =>
  list.some(entry =>
    entry.includes('*')
      ? new RegExp(`^${entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(target)
      : target === entry || target.startsWith(`${entry}${path.sep}`)
  )

describe('secretPaths (floor 4) — V3-J fix JM2', () => {
  const secrets = secretPaths({ ...input, hermesRoot: null })
  const payments = paymentPaths(input.userDataDir)
  const jti = 'ab'.repeat(16)

  it('secret-floor: the sealed keys, the signed mandates and every spawn pay token are never readable for egress', () => {
    for (const target of [
      path.join(payments.keys, 'pocket.sealed'),
      path.join(payments.keys, 'owner-mandate.sealed'),
      path.join(payments.keys, 'agent-inft-alpha-1.sealed'),
      path.join(payments.mandates, `${jti}.sdjwt`),
      path.join(payments.mandates, `${jti}.revoked`),
      path.join('/ud', 'run', 'pay-0123456789abcdef.token'),
      path.join('/ud', 'run', 'acp.token')
    ]) {
      expect(secretCovers(secrets, target), target).toBe(true)
    }
  })

  it('secret-floor: the ledger, settings, STOP, the sockets and look-alikes stay readable (negative control)', () => {
    for (const target of [
      payments.ledger,
      `${payments.ledger}.head`,
      payments.settings,
      payments.stop,
      path.join(payments.root, 'skills-seeded.json'),
      path.join('/ud', 'run', 'pay.sock'),
      path.join('/ud', 'run', 'pay-x.token.bak'),
      path.join('/ud', 'run', 'nested', 'pay-x.token'),
      path.join('/ud', 'payments-keys', 'pocket.sealed'),
      path.join('/home/u/project', 'payments', 'keys', 'pocket.sealed')
    ]) {
      expect(secretCovers(secrets, target), target).toBe(false)
    }
  })

  it('secret-floor: the payments entries come from the store’s own paths and stay under userData', () => {
    expect(secrets).toEqual(
      expect.arrayContaining([payments.keys, payments.mandates, path.join('/ud', 'run', 'pay-*.token')])
    )
    expect(
      secrets.filter(entry => entry.includes('payments') || entry.includes('pay-')).every(e => e.startsWith('/ud/'))
    ).toBe(true)
  })
})
