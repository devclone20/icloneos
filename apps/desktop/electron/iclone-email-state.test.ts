import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mergeInftRegistry, parseInftRegistry, type RegistryRow } from './iclone-acp-store'
import {
  EMAIL_STATE_MAX_BYTES,
  emailStateCall,
  emailStateFile,
  isEmailState,
  readEmailState,
  salvageEmailState,
  writeEmailState
} from './iclone-email-state'

const SLUG = 'robinhood-0x4dfb000000000000000000000000000000005631-7'
const STATE = { v: 1, w: 1_700_000_000_000, read: { a: [true, 5] }, archived: {}, trashed: { b: 6 }, purged: { c: 7 } }

let root = ''

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'iclone-email-state-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('email-state.json — the file copy of the Email marks', () => {
  it('round-trips through an atomic 0600 write, one file per iNFT', () => {
    expect(writeEmailState(root, SLUG, STATE)).toEqual({ ok: true, value: STATE })
    expect(readEmailState(root, SLUG)).toEqual({ ok: true, value: STATE })
    expect(statSync(emailStateFile(root, SLUG)).mode & 0o777).toBe(0o600)
    expect(readEmailState(root, 'robinhood-0x4dfb000000000000000000000000000000005631-6')).toEqual({
      ok: true,
      value: null
    })
  })

  it('a file that cannot be parsed is moved aside, never overwritten in place — R3d r3', () => {
    mkdirSync(path.join(root, SLUG), { recursive: true })
    writeFileSync(emailStateFile(root, SLUG), '{"v":1,"purged":{"c":')
    expect(readEmailState(root, SLUG, 1000)).toEqual({ ok: true, value: null })
    expect(readFileSync(path.join(root, SLUG, 'email-state.bad-1000.json'), 'utf8')).toBe('{"v":1,"purged":{"c":')
    expect(writeEmailState(root, SLUG, STATE).ok).toBe(true)
    expect(JSON.parse(readFileSync(emailStateFile(root, SLUG), 'utf8'))).toEqual(STATE)

    for (const at of [2000, 3000, 4000, 5000]) {
      writeFileSync(emailStateFile(root, SLUG), '[]')
      expect(readEmailState(root, SLUG, at)).toEqual({ ok: true, value: null })
    }

    expect(readdirSync(path.join(root, SLUG)).filter(name => name.startsWith('email-state.bad-'))).toEqual([
      'email-state.bad-3000.json',
      'email-state.bad-4000.json',
      'email-state.bad-5000.json'
    ])
  })

  it('a file that fails validation keeps every valid tombstone (unknown key, one bad value) — R3d r3', () => {
    const purged = { p1: 1, p2: 2, p3: 3, p4: 4, p5: 5 }
    mkdirSync(path.join(root, SLUG), { recursive: true })
    writeFileSync(emailStateFile(root, SLUG), JSON.stringify({ ...STATE, purged, labels: { x: 1 } }))
    expect(readEmailState(root, SLUG)).toEqual({ ok: true, value: { ...STATE, purged } })

    writeFileSync(
      emailStateFile(root, SLUG),
      JSON.stringify({ v: 2, read: { a: [true, 5], b: ['yes', 1] }, purged: { ...purged, bad: 'yesterday', '': 1 } })
    )
    expect(readEmailState(root, SLUG)).toEqual({
      ok: true,
      value: { v: 1, read: { a: [true, 5] }, archived: {}, trashed: {}, purged }
    })
    expect(readdirSync(path.join(root, SLUG))).toEqual(['email-state.json'])

    writeFileSync(emailStateFile(root, SLUG), JSON.stringify({ foreign: true }))
    expect(readEmailState(root, SLUG, 7)).toEqual({ ok: true, value: null })
    expect(readdirSync(path.join(root, SLUG))).toEqual(['email-state.bad-7.json'])
    expect(salvageEmailState('text')).toBeNull()
  })

  it('refuses unsafe slugs, malformed states, oversized states and unknown operations', () => {
    expect(readEmailState(root, '../etc').ok).toBe(false)
    expect(writeEmailState(root, 'a/b', STATE).ok).toBe(false)
    expect(writeEmailState(root, SLUG, { ...STATE, v: 2 }).ok).toBe(false)
    expect(writeEmailState(root, SLUG, { ...STATE, read: { a: ['yes', 1] } }).ok).toBe(false)
    expect(isEmailState({ ...STATE, trashed: { ['x'.repeat(257)]: 1 } })).toBe(false)
    const huge = Object.fromEntries(Array.from({ length: 30_000 }, (_, i) => [`id-${i}-${'x'.repeat(30)}`, i]))
    expect(writeEmailState(root, SLUG, { ...STATE, purged: huge })).toMatchObject({ ok: false })
    expect(emailStateCall(root, 'delete', SLUG)).toEqual({ ok: false, error: 'unknown operation' })
    expect(emailStateCall(root, 'set', SLUG, STATE).ok).toBe(true)
    expect(emailStateCall(root, 'get', SLUG)).toEqual({ ok: true, value: STATE })
  })

  it('accepts every set the renderer writes (recovered too) and validates each — R3d r2', () => {
    const full = { ...STATE, recovered: { d: 9 } }

    expect(isEmailState(full)).toBe(true)
    expect(writeEmailState(root, SLUG, full)).toEqual({ ok: true, value: full })
    expect(readEmailState(root, SLUG)).toEqual({ ok: true, value: full })
    expect(isEmailState({ ...STATE, recovered: { d: 'later' } })).toBe(false)
    expect(isEmailState({ ...STATE, recovered: [] })).toBe(false)
    expect(isEmailState({ ...STATE, extra: {} })).toBe(false)
  })

  it('a file over the size cap is moved aside before it is parsed — R3d r2/r3', () => {
    mkdirSync(path.join(root, SLUG), { recursive: true })
    const purged = Object.fromEntries(Array.from({ length: 40_000 }, (_, i) => [`id-${i}-${'x'.repeat(20)}`, i]))
    const text = JSON.stringify({ ...STATE, purged })

    expect(Buffer.byteLength(text)).toBeGreaterThan(EMAIL_STATE_MAX_BYTES)
    writeFileSync(emailStateFile(root, SLUG), text)
    expect(readEmailState(root, SLUG, 42)).toEqual({ ok: true, value: null })
    expect(statSync(path.join(root, SLUG, 'email-state.bad-42.json')).size).toBe(Buffer.byteLength(text))
  })

  it('a failed write leaves the old file whole and says why', () => {
    expect(writeEmailState(root, SLUG, STATE).ok).toBe(true)
    chmodSync(path.join(root, SLUG), 0o500)

    try {
      expect(writeEmailState(root, SLUG, { ...STATE, w: 2 }).ok).toBe(false)
      expect(readEmailState(root, SLUG)).toEqual({ ok: true, value: STATE })
    } finally {
      chmodSync(path.join(root, SLUG), 0o700)
    }
  })

  it('only a missing file reads as "no marks"; an unreadable one is a failure and is never written over — R3d r4', () => {
    expect(readEmailState(root, SLUG)).toEqual({ ok: true, value: null })
    expect(writeEmailState(root, SLUG, STATE).ok).toBe(true)
    const file = emailStateFile(root, SLUG)

    chmodSync(file, 0o000)

    try {
      const read = readEmailState(root, SLUG)

      expect(read.ok).toBe(false)
      expect(writeEmailState(root, SLUG, { ...STATE, purged: {} }).ok).toBe(false)
    } finally {
      chmodSync(file, 0o600)
    }

    expect(readEmailState(root, SLUG)).toEqual({ ok: true, value: STATE })
  })

  it('EIO/EMFILE-class read errors fail; ENOENT and ENOTDIR mean absent — R3d r4', () => {
    // A regular file where the iNFT dir should be: ENOTDIR = absent.
    writeFileSync(path.join(root, SLUG), 'not a dir')
    expect(readEmailState(root, SLUG)).toEqual({ ok: true, value: null })
    rmSync(path.join(root, SLUG))

    // A directory where the file should be: EISDIR stands in for EIO — any
    // error that is not "missing" must not read as an empty state.
    mkdirSync(emailStateFile(root, SLUG), { recursive: true })
    expect(readEmailState(root, SLUG).ok).toBe(false)
    expect(writeEmailState(root, SLUG, STATE).ok).toBe(false)
  })
})

// Two instances share ~/.iclone-os/inft.tsv (the lab and a second --user-data-dir).
describe('inft.tsv — merged by token, never clobbered by another instance', () => {
  const rowOf = (base: string, token: string, name = `#${token}`): RegistryRow => ({
    token,
    slug: `robinhood-0x4dfb000000000000000000000000000000005631-${token}`,
    configDir: path.join(base, `robinhood-0x4dfb000000000000000000000000000000005631-${token}`, 'acp'),
    name,
    profile: `inft-4dfb00-${token}`
  })

  const tsv = (rows: RegistryRow[]) =>
    [
      '# token\tslug\tconfigDir\tname\tprofile',
      ...rows.map(r => [r.token, r.slug, r.configDir, r.name, r.profile].join('\t'))
    ]
      .join('\n')
      .concat('\n')

  it('a second instance with no iNFTs keeps every row of the first', () => {
    const lab = path.join(root, 'devdata', 'inft')
    const other = path.join(root, 'devdata2', 'inft')
    const first = [rowOf(lab, '1'), rowOf(lab, '6'), rowOf(lab, '7')]
    first.forEach(row => mkdirSync(path.dirname(row.configDir), { recursive: true }))

    const merged = mergeInftRegistry(
      parseInftRegistry(tsv(first)),
      [],
      other,
      dir => statSync(dir, { throwIfNoEntry: false }) !== undefined
    )

    expect(merged.map(row => row.token)).toEqual(['1', '6', '7'])
  })

  it("this instance's rows win for their own tokens and replace its stale ones", () => {
    const lab = path.join(root, 'devdata', 'inft')
    const other = path.join(root, 'devdata2', 'inft')
    const existing = [rowOf(lab, '6'), rowOf(lab, '7', 'Lab seven'), rowOf(other, '9', 'Detached here')]
    existing.forEach(row => mkdirSync(path.dirname(row.configDir), { recursive: true }))
    const mine = [rowOf(other, '7', 'Other seven')]
    const merged = mergeInftRegistry(parseInftRegistry(tsv(existing)), mine, other, () => true)
    expect(merged.map(row => [row.token, row.name])).toEqual([
      ['7', 'Other seven'],
      ['6', '#6']
    ])
  })

  it("drops another instance's row once its iNFT dir is gone, and skips malformed lines", () => {
    const lab = path.join(root, 'devdata', 'inft')
    const text = `${tsv([rowOf(lab, '1')])}garbage line\n12\tbad slug!\tx\ty\tz\n`
    expect(parseInftRegistry(text)).toHaveLength(1)
    expect(mergeInftRegistry(parseInftRegistry(text), [], path.join(root, 'mine'), () => false)).toEqual([])
  })
})
