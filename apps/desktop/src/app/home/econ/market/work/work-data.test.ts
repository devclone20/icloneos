import { describe, expect, it } from 'vitest'

import { workViewFixture } from './fixture'
import { hopValue, inboxOrder, paymentsMatchLedger, rowsIn } from './work-data'

describe('work-data', () => {
  it('puts what waits for the owner first', () => {
    expect(inboxOrder(workViewFixture().offers).map(offer => offer.standing)).toEqual(['pending', 'refused'])
  })

  it('splits rows by group', () => {
    const view = workViewFixture()

    expect(rowsIn(view, 'payments').map(row => row.jobId)).toEqual(['1'])
    expect(rowsIn(view, 'in-flight').map(row => row.jobId)).toEqual(['2'])
    expect(rowsIn(view, 'history')).toEqual([])
  })

  it('a missing hop is a gap (null), never a filled-in value', () => {
    const row = workViewFixture().rows[1]

    expect(hopValue(row.trace, 'offer')).toBeNull()
    expect(hopValue(row.trace, 'paymentMicros')).toBeNull()
    expect(hopValue(row.trace, 'budgetMicros')).toBe('$2.00')
  })

  it('I3: payments rows add up to the ledger total exactly', () => {
    expect(paymentsMatchLedger(workViewFixture())).toBe(true)
    expect(
      paymentsMatchLedger(workViewFixture({ totals: { earnedMicros: 5_000_001, spentMicros: 0, escrowMicros: 0 } }))
    ).toBe(false)
  })
})
