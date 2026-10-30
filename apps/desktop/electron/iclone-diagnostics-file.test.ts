/**
 * V3-FX FX-7 (main): the diagnostics report main composes, shows and writes — redacted by the doctor's redaction,
 * written 0600 only where the owner chose, nothing when they cancel, and no network anywhere in the module.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  collectMacNames,
  composeDiagnosticsFile,
  diagnosticsFileHandlers,
  macNamesOnce,
  redactIdentity
} from './iclone-diagnostics-file'

const HOME = '/Users/ownername'
// Built at run time so no secret-looking literal sits in the repository (the pre-commit scanner).
const FAKE_KEY = ['sk', 'or', 'v1', '0123456789abcdef'.repeat(2)].join('-')
let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx7-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const deps = (over: Partial<Parameters<typeof diagnosticsFileHandlers>[0]> = {}) => ({
  home: HOME,
  appVersion: '0.0.3',
  report: () => ['runtime: pass', `venv at ${HOME}/.hermes/venv`],
  logs: () => ['boot ok', `OPENROUTER_API_KEY=${FAKE_KEY}`, 'signed in as owner@example.com'],
  now: () => new Date(2026, 9, 22, 12, 5),
  chooseFile: async (name: string) => path.join(dir, name),
  ...over
})

describe('FX-7: the diagnostics report file', () => {
  it('holds the report, what failed and the recent log, every line redacted', () => {
    const view = composeDiagnosticsFile(deps(), { errorContext: `turn failed for owner@example.com in ${HOME}/p` })

    expect(view.parts.map(part => part.id)).toEqual(['report', 'context', 'logs'])
    expect(view.suggestedName).toBe('icloneos-diagnostics-20261022-1205.txt')

    for (const secret of [FAKE_KEY, 'owner@example.com', HOME]) {
      expect(view.text).not.toContain(secret)
    }

    expect(view.text).toContain('Nothing was uploaded.')
  })

  it("m4: wallets, Privy ids, LAN addresses and this Mac's name are removed too", () => {
    const view = composeDiagnosticsFile(
      deps({
        machineNames: () => ['Owners-MacBook-Pro'],
        logs: () => [
          'wallet 0x1234567890abcdef1234567890abcdef12345678 signed',
          'user did:privy:cm1abcXYZ0123 signed in',
          'gateway at 192.168.1.23:9119 and 10.0.0.7',
          'host Owners-MacBook-Pro.local'
        ]
      }),
      {}
    )

    for (const leaked of ['0x1234567890abcdef', 'did:privy:cm1', '192.168.1.23', '10.0.0.7', 'Owners-MacBook-Pro']) {
      expect(view.text).not.toContain(leaked)
    }

    expect(view.text).toContain('[wallet]')
    expect(view.text).toContain('[this-mac]')
  })

  it('r3: Solana addresses, bare hex keys, every Mac name, IPv6, Tailscale, link-local and MAC addresses are removed', () => {
    const solana = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
    const hex = 'a'.repeat(16) + '0123456789abcdef'.repeat(3)

    const view = composeDiagnosticsFile(
      deps({
        machineNames: () => ['owners-mbp.local', 'owners-mbp', "Pat Lee's MacBook Pro", 'patlee'],
        logs: () => [
          `sol ${solana} paid`,
          `key ${hex}`,
          "host OWNERS-MBP answered; computer Pat Lee's MacBook Pro; user patlee",
          'v6 fe80::1c2d:3e4f:5a6b:7c8d%en0 and fd7a:115c:a1e0:ab12:4843:cd96:6258:b240 and 2001:db8::1',
          'tailscale 100.101.102.103, link-local 169.254.10.20',
          'mac a4:83:e7:12:34:56 and 3c-22-fb-aa-bb-cc',
          'kept: at 12:30:45 the run took 1.5 s'
        ]
      }),
      {}
    )

    for (const leaked of [
      solana,
      hex,
      'OWNERS-MBP',
      "Pat Lee's MacBook Pro",
      'patlee',
      'fe80::1c2d',
      'fd7a:115c',
      '2001:db8',
      '100.101.102.103',
      '169.254.10.20',
      'a4:83:e7',
      '3c-22-fb'
    ]) {
      expect(view.text, leaked).not.toContain(leaked)
    }

    expect(view.text).toContain('at 12:30:45 the run took 1.5 s')
  })

  it('the renderer context is optional and capped; a part with nothing to say is left out', () => {
    const view = composeDiagnosticsFile(deps({ report: () => null }), { errorContext: 'x'.repeat(20_000) })

    expect(view.parts.map(part => part.id)).toEqual(['context', 'logs'])
    expect(view.text.length).toBeLessThan(12_000)
    expect(composeDiagnosticsFile(deps(), 42).parts.map(part => part.id)).toEqual(['report', 'logs'])
  })

  it('save writes exactly the previewed text, 0600, to the chosen file', async () => {
    const handlers = diagnosticsFileHandlers(deps())
    const preview = handlers.preview({})
    const saved = await handlers.save({})

    expect(saved).toEqual({ ok: true, name: preview.suggestedName })

    const file = path.join(dir, preview.suggestedName)

    expect(fs.readFileSync(file, 'utf8')).toBe(preview.text)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('cancel writes nothing', async () => {
    const write = vi.fn()
    const saved = await diagnosticsFileHandlers(deps({ chooseFile: async () => null, write })).save({})

    expect(saved).toEqual({ ok: false, canceled: true })
    expect(write).not.toHaveBeenCalled()
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('the module makes no network call (no http, https, net, fetch or electron net)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'iclone-diagnostics-file.ts'), 'utf8')

    expect(source).not.toMatch(
      /from 'node:(https?|net|tls)'|from '(https?|net)'|\bfetch\(|\bnet\.request|from 'electron'/
    )
  })
})

describe('r4: the Mac names and the remaining identity residue', () => {
  const read = (answers: Record<string, string | null>) => async (file: string, args: readonly string[]) =>
    answers[`${file} ${args.join(' ')}`] ?? null

  it('collects every name the Mac goes by, with each apostrophe form and the owner before "\'s"', async () => {
    const names = await collectMacNames({
      hostname: 'Zorbas-MBP.local',
      username: 'zorba',
      platform: 'darwin',
      read: read({
        '/usr/sbin/scutil --get ComputerName': 'Zorba\u2019s MacBook Pro',
        '/usr/sbin/scutil --get LocalHostName': 'Zorbas-MBP',
        '/usr/sbin/scutil --get HostName': null,
        '/usr/bin/id -F': 'Zorba Greek'
      })
    })

    for (const name of [
      'Zorbas-MBP.local',
      'Zorbas-MBP',
      'zorba',
      'Zorba\u2019s MacBook Pro',
      "Zorba's MacBook Pro",
      'Zorbas MacBook Pro',
      'Zorba Greek',
      'Zorba'
    ]) {
      expect(names, name).toContain(name)
    }
  })

  it('off macOS only the host, user and full name are read; a failing read never throws', async () => {
    const names = await collectMacNames({
      hostname: 'box',
      username: 'pat',
      platform: 'linux',
      read: async () => {
        throw new Error('no id')
      }
    })

    expect(names).toEqual(['box', 'pat'])
  })

  it('a report with those names in any form keeps none of them', () => {
    const names = ["Zorba's MacBook Pro", 'Zorbas MacBook Pro', 'Zorba']

    const text = redactIdentity(
      "Zorba's MacBook Pro / zorbas macbook pro / ZORBA said hi / mapped ::ffff:192.168.1.5 / user cm4abcdefgh12345678ijklmn",
      names
    )

    expect(text).not.toMatch(/zorba/i)
    expect(text).not.toContain('192.168')
    expect(text).not.toContain('.168.1.5')
    expect(text).not.toContain('cm4abcdefgh12345678ijklmn')
  })

  it('colon times stay times; real IPv6 still goes', () => {
    const text = redactIdentity('at 12:30:45:678 and 00:01:02:03, peer 2001:db8:0:1 and fe80:0:0:0:1c2d:3e4f:5a6b:7c8d')

    expect(text).toContain('12:30:45:678')
    expect(text).toContain('00:01:02:03')
    expect(text).not.toContain('2001:db8')
    expect(text).not.toContain('fe80:0')
  })
})

describe('r5: names on word boundaries, the last name, Privy ids exactly, one read', () => {
  it('a name is removed as a whole word only — "Rob" never garbles "problem" or "robot"', () => {
    const text = redactIdentity('Rob saw a problem with the robot; ROB again; Robert stays', ['Rob'])

    expect(text).toBe('[this-mac] saw a problem with the robot; [this-mac] again; Robert stays')
  })

  it('the first name alone and the last name alone are collected (id -F) and removed', async () => {
    const names = await collectMacNames({
      hostname: 'mbp',
      username: 'zg',
      platform: 'darwin',
      read: async (file: string) => (file === '/usr/bin/id' ? 'Zorba Greekman' : null)
    })

    expect(names).toEqual(expect.arrayContaining(['Zorba Greekman', 'Zorba', 'Greekman']))

    const text = redactIdentity('Zorba here; signed Greekman; Zorba Greekman', names)

    expect(text).not.toMatch(/Zorba|Greekman/)
  })

  it('Privy ids exactly: a bare cuid goes, a longer identifier or a checksum stays', () => {
    const text = redactIdentity(
      'user cm4abcdefgh12345678ijklmn signed; configuration2resolverservice; czzzzzzzzzz123456789012345678; ' +
        'path/cm4abcdefgh12345678ijklmn.json'
    )

    expect(text).toContain('user [privy-id] signed')
    expect(text).toContain('configuration2resolverservice')
    expect(text).toContain('czzzzzzzzzz123456789012345678')
    expect(text).toContain('path/cm4abcdefgh12345678ijklmn.json')
  })

  it('the names are read once per session, however many previews and saves', async () => {
    let reads = 0

    const names = macNamesOnce(async () => {
      reads += 1

      return ['x']
    })

    await Promise.all([names(), names(), names()])
    await names()
    expect(reads).toBe(1)
  })
})
