/**
 * F1-S (v0.0.9) — main's owner-click lock on the window's ACP writes (gesture-locks-acp.ts): `agent register-erc8004`
 * and the Market catalogue writes. Main's real gesture verdict (V3-F `permissionGestureOk`) decides; the facts it is
 * given stand for what the preload and the browser process saw.
 */
import { describe, expect, it } from 'vitest'

import { ACP_WRITE_REFUSED, createAcpOwnerWrites } from './gesture-locks-acp'
import { gestureOf, permissionGestureOk } from './iclone-permissions/gesture'

const REGISTER = ['agent', 'register-erc8004', '--agent-id', 'a1', '--chain-id', '8453', '--json']

const CREATE = [
  'offering',
  'create',
  '--name',
  'Token report',
  '--description',
  'A digest.',
  '--price-type',
  'fixed',
  '--price-value',
  '0.5',
  '--sla-minutes',
  '30',
  '--requirements',
  'The ticker.',
  '--deliverable',
  'A report.',
  '--required-funds',
  '--no-hidden',
  '--json'
]

const UPDATE = ['offering', 'update', '--offering-id', 'off-1', '--price-value', '0.02', '--json']
const DELETE = ['offering', 'delete', '--offering-id', 'off-1', '--force', '--json']

const RESOURCE = [
  'resource',
  'create',
  '--name',
  'Price feed',
  '--description',
  'Prices.',
  '--url',
  'https://api.example/price',
  '--params',
  '{}',
  '--no-hidden',
  '--json'
]

/** What the preload sends for a real click on the marked control (activation + its trusted confirm). */
const REAL_CLICK = { activation: true, confirm: true }
/** What a script gets: `el.click()` / dispatchEvent carry no activation and no trusted confirm. */
const SCRIPTED = { activation: false, confirm: false }

function world(options: { audit?: boolean; auditDown?: boolean } = {}) {
  let now = 10_000
  let lastInputAt = 0
  const audits: { kind: string; gesture: boolean; command: string; lock: string; reason: string }[] = []

  const writes = createAcpOwnerWrites({
    // Main's real verdict: the preload's two flags AND real input to this window within the window.
    gestureOk: (_event, input) => permissionGestureOk({ payload: gestureOf(input), lastInputAt, now }),
    audit:
      options.audit === false
        ? undefined
        : entry => {
            audits.push(entry)

            return options.auditDown ? null : { id: audits.length }
          },
    now: () => now
  })

  const sender = (id: number) => ({ sender: { id } })

  return {
    writes,
    audits,
    sender,
    /** The browser process delivered real input to the window (before-input-event). */
    realInput: () => {
      lastInputAt = now
    },
    advance: (ms: number) => {
      now += ms
    }
  }
}

const confirmOf = (lock: string, argv: string[], gesture: unknown, inftId = 'inft-1') => ({ inftId, argv, lock, gesture })

describe('F1-S main: an owner-locked write runs only on the owner’s click', () => {
  it('without any confirm, main refuses the run and audits refuse · gesture:false', () => {
    const w = world()

    expect(w.writes.admit(w.sender(1), 'inft-1', REGISTER)).toBe(ACP_WRITE_REFUSED.gesture)
    expect(w.audits).toEqual([
      expect.objectContaining({ kind: 'refuse', gesture: false, command: 'agent register-erc8004', lock: 'acp-register' })
    ])
  })

  it('a scripted call (synthetic el.click: no activation, no trusted confirm) is refused and audited gesture:false', () => {
    const w = world()

    w.realInput()
    expect(w.writes.confirm(w.sender(1), confirmOf('acp-register', REGISTER, SCRIPTED))).toEqual({
      ok: false,
      error: ACP_WRITE_REFUSED.gesture
    })
    expect(w.writes.admit(w.sender(1), 'inft-1', REGISTER)).toBe(ACP_WRITE_REFUSED.gesture)
    expect(w.audits.map(entry => [entry.kind, entry.gesture])).toEqual([
      ['refuse', false],
      ['refuse', false]
    ])
  })

  it('a page script that forges the flags still fails without real input to the window (the agent driving the page)', () => {
    const w = world()

    // No before-input-event reached this window: the forged `{ activation: true, confirm: true }` is not enough.
    expect(w.writes.confirm(w.sender(1), confirmOf('acp-register', REGISTER, REAL_CLICK)).ok).toBe(false)
    expect(w.writes.admit(w.sender(1), 'inft-1', REGISTER)).toBe(ACP_WRITE_REFUSED.gesture)
  })

  for (const [name, lock, argv] of [
    ['register-erc8004', 'acp-register', REGISTER],
    ['offering create', 'acp-market', CREATE],
    ['offering update', 'acp-market', UPDATE],
    ['offering delete', 'acp-market', DELETE],
    ['resource create', 'acp-market', RESOURCE]
  ] as const) {
    it(`${name}: the owner's click admits exactly one run, audited use · gesture:true`, () => {
      const w = world()

      w.realInput()
      expect(w.writes.confirm(w.sender(1), confirmOf(lock, [...argv], REAL_CLICK))).toEqual({ ok: true })
      expect(w.writes.admit(w.sender(1), 'inft-1', [...argv])).toBeNull()
      // Single use: the same argv again needs a new click.
      expect(w.writes.admit(w.sender(1), 'inft-1', [...argv])).toBe(ACP_WRITE_REFUSED.gesture)
      expect(w.audits.map(entry => [entry.kind, entry.gesture, entry.lock])).toEqual([
        ['use', true, lock],
        ['refuse', false, lock]
      ])
    })
  }

  it('the admission is bound to the exact argv, the iNFT and the window', () => {
    const w = world()

    w.realInput()
    w.writes.confirm(w.sender(1), confirmOf('acp-market', DELETE, REAL_CLICK))

    expect(w.writes.admit(w.sender(1), 'inft-1', ['offering', 'delete', '--offering-id', 'off-2', '--force', '--json'])).toBe(
      ACP_WRITE_REFUSED.gesture
    )
    expect(w.writes.admit(w.sender(1), 'inft-2', DELETE)).toBe(ACP_WRITE_REFUSED.gesture)
    expect(w.writes.admit(w.sender(2), 'inft-1', DELETE)).toBe(ACP_WRITE_REFUSED.gesture)
    // The right one is still there, once.
    expect(w.writes.admit(w.sender(1), 'inft-1', DELETE)).toBeNull()
  })

  it('a click on one lock’s control never opens another lock’s write', () => {
    const w = world()

    w.realInput()
    expect(w.writes.confirm(w.sender(1), confirmOf('acp-market', REGISTER, REAL_CLICK))).toEqual({
      ok: false,
      error: ACP_WRITE_REFUSED.invalid
    })
    expect(w.writes.admit(w.sender(1), 'inft-1', REGISTER)).toBe(ACP_WRITE_REFUSED.gesture)
  })

  it('a confirm expires', () => {
    const w = world()

    w.realInput()
    w.writes.confirm(w.sender(1), confirmOf('acp-register', REGISTER, REAL_CLICK))
    w.advance(300_001)

    expect(w.writes.admit(w.sender(1), 'inft-1', REGISTER)).toBe(ACP_WRITE_REFUSED.gesture)
  })

  it('no audit, or an audit that cannot record: nothing owner-locked runs', () => {
    const none = world({ audit: false })

    none.realInput()
    expect(none.writes.confirm(none.sender(1), confirmOf('acp-register', REGISTER, REAL_CLICK)).ok).toBe(false)
    expect(none.writes.admit(none.sender(1), 'inft-1', REGISTER)).toBe(ACP_WRITE_REFUSED.audit)

    const down = world({ auditDown: true })

    down.realInput()
    expect(down.writes.confirm(down.sender(1), confirmOf('acp-register', REGISTER, REAL_CLICK)).ok).toBe(true)
    expect(down.writes.admit(down.sender(1), 'inft-1', REGISTER)).toBe(ACP_WRITE_REFUSED.audit)
  })

  it('reads and writes outside F1-S pass untouched (the argv allowlist still decides them)', () => {
    const w = world()

    expect(w.writes.admit(w.sender(1), 'inft-1', ['offering', 'list', '--json'])).toBeNull()
    expect(w.writes.admit(w.sender(1), 'inft-1', ['wallet', 'balance', '--json'])).toBeNull()
    expect(w.writes.admit(w.sender(1), 'inft-1', ['not', 'allowed'])).toBeNull()
    expect(w.audits).toEqual([])
  })

  it('a confirm for an argv that is not owner-locked is refused as invalid, and nothing is remembered', () => {
    const w = world()

    w.realInput()
    expect(w.writes.confirm(w.sender(1), confirmOf('acp-market', ['offering', 'list', '--json'], REAL_CLICK))).toEqual({
      ok: false,
      error: ACP_WRITE_REFUSED.invalid
    })
    expect(w.writes.pendingCount()).toBe(0)
  })
})
