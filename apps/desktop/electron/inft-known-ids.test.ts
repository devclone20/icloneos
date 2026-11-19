// v0.0.9 critic m5: the ids main's own scans returned, and the acp-run rule built on them.
import { describe, expect, it } from 'vitest'

import { acpRunInftRefusal } from './iclone-acp'
import { createKnownInftIds, createSessionScopedInftIds, inftCardId } from './inft-known-ids'

const CONTRACT = '0x' + 'AB'.repeat(20)

describe('known iNFT ids', () => {
  it('a scanned token is known by the renderer card id (lower case chain and contract)', () => {
    const known = createKnownInftIds()

    known.note([{ chain: 'Robinhood', contract: CONTRACT, tokenId: '7' }, null, { chain: 'Base' }])

    expect(inftCardId({ chain: 'Robinhood', contract: CONTRACT, tokenId: '7' })).toBe(
      `robinhood:${CONTRACT.toLowerCase()}:7`
    )
    expect(known.has(`robinhood:${CONTRACT.toLowerCase()}:7`)).toBe(true)
    expect(known.has(`robinhood:${CONTRACT.toLowerCase()}:8`)).toBe(false)
    expect(known.has(42)).toBe(false)

    known.clear()
    expect(known.has(`robinhood:${CONTRACT.toLowerCase()}:7`)).toBe(false)
  })

  it('the cap bounds what a pathological answer can make main remember', () => {
    const known = createKnownInftIds(2)

    known.note(['1', '2', '3'].map(tokenId => ({ chain: 'base', contract: CONTRACT, tokenId })))

    expect(known.has(`base:${CONTRACT.toLowerCase()}:3`)).toBe(false)
  })
})

describe('acpRunInftRefusal', () => {
  const never = () => false

  it('refuses an id that is neither scanned nor already has a home', () => {
    expect(acpRunInftRefusal('robinhood:0xdead:999', never, never)).toBe('unknown iNFT: it is not in this wallet')
    expect(acpRunInftRefusal('  ', never, never)).toBe('no iNFT given')
    expect(acpRunInftRefusal(undefined, never, never)).toBe('no iNFT given')
  })

  it('admits a scanned id, or an iNFT whose home already exists (by its slug)', () => {
    expect(acpRunInftRefusal('base:0xabc:1', id => id === 'base:0xabc:1', never)).toBeNull()
    expect(acpRunInftRefusal('base:0xabc:1', never, slug => slug === 'base-0xabc-1')).toBeNull()
  })
})

describe('v0.0.9 r3 (eng n2): notes are the signed-in wallet\'s, of the current sign-in', () => {
  const MINE = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'
  const OTHER = '0x1111111111111111111111111111111111111111'
  const token = (n: string) => ({ chain: 'base', contract: '0xabc', tokenId: n })

  it("a scan of another wallet's address notes nothing (red on fb85: any scanned address was admitted)", () => {
    const ids = createSessionScopedInftIds()

    ids.session(MINE)

    expect(ids.noteScan(ids.begin(OTHER), [token('1')])).toBe(false)
    expect(ids.has('base:0xabc:1')).toBe(false)
    expect(ids.noteScan(ids.begin(MINE.toUpperCase().replace('0X', '0x')), [token('2')])).toBe(true)
    expect(ids.has('base:0xabc:2')).toBe(true)
  })

  it('a scan that resolves after sign-out notes nothing into the cleared set', () => {
    const ids = createSessionScopedInftIds()

    ids.session(MINE)
    const running = ids.begin(MINE)

    ids.clear() // logoutPrivy
    ids.session(null)

    expect(ids.noteScan(running, [token('3')])).toBe(false)
    expect(ids.has('base:0xabc:3')).toBe(false)
  })

  it('sign-out and back in to the same wallet: the scan begun before still notes nothing; a new one does', () => {
    const ids = createSessionScopedInftIds()

    ids.session(MINE)
    const before = ids.begin(MINE)

    ids.clear()
    ids.session(MINE)

    expect(ids.noteScan(before, [token('4')])).toBe(false)
    expect(ids.noteScan(ids.begin(MINE), [token('5')])).toBe(true)
  })

  it('a switch to another wallet forgets the old wallet\'s ids and refuses its running scan', () => {
    const ids = createSessionScopedInftIds()

    ids.session(MINE)
    ids.noteScan(ids.begin(MINE), [token('6')])
    const running = ids.begin(MINE)

    ids.session(OTHER)

    expect(ids.has('base:0xabc:6')).toBe(false)
    expect(ids.noteScan(running, [token('7')])).toBe(false)
  })

  it('a cold start: a scan begun before the session is known notes once the session is that wallet', () => {
    const ids = createSessionScopedInftIds()
    const early = ids.begin(MINE)

    ids.session(MINE)

    expect(ids.noteScan(early, [token('8')])).toBe(true)
  })

  // r3-n6 (red on bf42e8eb02): on a reopen the first scan can land before main learns the restored session; it noted
  // nothing, and learning the session did not re-note, so the reopened iNFT's acp-run was refused as "unknown iNFT".
  it('a cold start: a scan that RESOLVED before the session was known is noted when the session is that wallet', () => {
    const ids = createSessionScopedInftIds()

    expect(ids.noteScan(ids.begin(MINE), [token('8')])).toBe(false)
    expect(ids.has('base:0xabc:8')).toBe(false)

    ids.session(MINE)

    expect(ids.has('base:0xabc:8')).toBe(true)
    expect(acpRunInftRefusal('base:0xabc:8', ids.has, () => false)).toBeNull()
  })

  it('restore session → first scan → acp-run of the persisted iNFT admitted (the usual reopen order)', () => {
    const ids = createSessionScopedInftIds()

    ids.session(MINE)
    expect(ids.noteScan(ids.begin(MINE), [token('8')])).toBe(true)
    expect(acpRunInftRefusal('base:0xabc:8', ids.has, () => false)).toBeNull()
  })

  it('a cold-start scan of ANOTHER address is never noted for this session, and a later sign-out drops what was held', () => {
    const ids = createSessionScopedInftIds()

    ids.noteScan(ids.begin(OTHER), [token('9')])
    ids.session(MINE)
    expect(ids.has('base:0xabc:9')).toBe(false)

    const fresh = createSessionScopedInftIds()

    fresh.noteScan(fresh.begin(MINE), [token('9')])
    fresh.clear()
    fresh.session(MINE)
    expect(fresh.has('base:0xabc:9')).toBe(false)
  })

  it('signed out, nothing is noted at all; a malformed address never matches', () => {
    const ids = createSessionScopedInftIds()

    expect(ids.noteScan(ids.begin(MINE), [token('9')])).toBe(false)
    ids.session('not-an-address')
    expect(ids.noteScan(ids.begin('not-an-address'), [token('9')])).toBe(false)
  })
})
