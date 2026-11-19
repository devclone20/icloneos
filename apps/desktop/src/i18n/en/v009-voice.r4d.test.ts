/**
 * v0.0.9 r4d (design r4 F2-1): one failure, one voice. The stopped banner, the crash toast and its centre entry name the
 * action one way ("Restart agent"), never print a signal name in a body (it goes to Details), and the banner's line is
 * a plain sentence. Red on 52cae17554: "(SIGKILL)" in the toast body, "Retry" on the banner, "Use Retry…" in the line.
 */
import { describe, expect, it } from 'vitest'

import { backendExitCause, backendExitDetail } from '@/store/backend-restart'

import { f2Crash, f2Restart } from './v009-f2'
import { f3Banner } from './v009-f3'

const SIGNAL = /SIG[A-Z]+/

describe('one voice for a stopped agent', () => {
  it.each(['SIGKILL', 'SIGTERM', 'SIGSEGV', 'SIGABRT'])('a %s exit: the body names no signal, Details does', signal => {
    expect(backendExitCause({ code: null, signal })).not.toMatch(SIGNAL)
    expect(backendExitDetail({ code: null, signal })).toBe(`Exit signal: ${signal}`)
  })

  it('a code exit keeps its code in Details too', () => {
    expect(backendExitDetail({ code: 1, signal: null })).toBe('Exit code: 1')
    expect(backendExitDetail(undefined)).toBe('No exit status was reported.')
  })

  it('every body sentence is free of signal names, and the action has one name', () => {
    const bodies = [
      f2Crash.causeSignal('SIGKILL'),
      f2Crash.causeCode(1),
      f2Crash.causeClean,
      f2Crash.causeUnknown,
      f2Crash.nextStep,
      f2Restart.stoppedLimit,
      f2Restart.stoppedDeterministic,
      f3Banner.composerReason
    ]

    for (const body of bodies) {
      expect(body).not.toMatch(SIGNAL)
      expect(body).not.toMatch(/\bRetry\b/)
      expect(body).not.toMatch(/iclone os tries/)
    }

    expect(f3Banner.retry).toBe(f2Crash.restart)
    expect(f2Crash.restart).toBe('Restart agent')
    expect(f2Restart.stoppedLimit).toBe("It stopped and didn't come back after several tries.")
  })
})

// r5 (design R5-2, R5-3): red on b290e6d7f3 — "Show details" (banner), "Detail" (centre), "More" (toast), and the wallet
// line "…the network did not answer, so no network could be read".
describe('one disclosure label; no repeated word in the wallet error', () => {
  it('the banner, the centre entry and the toast name their disclosure the same: "Details"', async () => {
    const { f4Banner, f4Centre, f4Notes } = await import('./v009-f4')
    const labels = new Set([f3Banner.details, f4Banner.showDetails, f4Centre.detail, f4Notes.more])

    expect([...labels]).toEqual(['Details'])
  })

  // G-4 (design G): red on 0d197361ab — the body ended "…so balances could not be read.", the title's own words.
  it('the wallet error names "network" once and never repeats its title', async () => {
    const { f5Wallet } = await import('./v009-f5')

    expect(f5Wallet.failedCause).toBe('The balance service or the network did not answer. Your funds are unchanged.')
    expect(f5Wallet.failedCause.match(/network/g)).toHaveLength(1)
    expect(f5Wallet.failedCause.toLowerCase()).not.toContain(f5Wallet.failed.replace(/\.$/, '').toLowerCase())
  })
})

// G-7 (design G): red on 0d197361ab — "It is started again automatically." (passive: nobody does it).
describe('the crash toast says who restarts the agent', () => {
  it('the next step is active and names icloneOS', () => {
    expect(f2Crash.nextStep).toBe('icloneOS restarts it automatically. If it stays stopped, choose Restart agent.')
    expect(f2Crash.nextStep).not.toMatch(/\bis (?:started|restarted)\b/)
  })
})
