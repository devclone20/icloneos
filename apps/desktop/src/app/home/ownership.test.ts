import { describe, expect, it } from 'vitest'

import {
  bridgeItems,
  deactivationCountdown,
  isDeactivated,
  type OwnershipView,
  withDeactivatedCards
} from './ownership'

const C = '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631'

const view = (o: Partial<OwnershipView>): OwnershipView =>
  ({
    slug: `robinhood-${C}-6`,
    inftId: `robinhood:${C}:6`,
    tokenId: '6',
    chain: 'Robinhood',
    contract: C,
    name: 'i01 #6',
    image: null,
    state: 'lost',
    daysLeft: 3,
    deactivation: null,
    ...o
  }) as OwnershipView

describe('ownership signal (renderer)', () => {
  it('keeps a proven-lost iNFT on the roster without a model', () => {
    const cards = withDeactivatedCards([], { [view({}).slug]: view({}) })
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ id: `robinhood:${C}:6`, configured: false })
    expect(cards[0].modelUrl).toBeUndefined()
  })

  it('does not duplicate a card still in the scan, nor add held ones', () => {
    const card = { id: `robinhood:${C}:6`, name: 'x', collection: 'c', chain: 'Robinhood', configured: true }
    expect(withDeactivatedCards([card], { a: view({}) })).toHaveLength(1)
    expect(withDeactivatedCards([], { a: view({ state: 'held' }) })).toHaveLength(0)
  })

  it('counts down, then reports the applied deactivation', () => {
    expect(deactivationCountdown(view({ daysLeft: 1 }))).toBe('Automatic deactivation in 1 day')
    expect(deactivationCountdown(view({ daysLeft: 0 }))).toBe('Automatic deactivation is due now')
    expect(
      deactivationCountdown(
        view({ deactivation: { appliedAt: 0, by: 'timer', steps: [] }, deactivationComplete: true, pendingSteps: [] })
      )
    ).toMatch(/^Deactivated everywhere/)

    // A failed step is named — never "everywhere".
    const partial = deactivationCountdown(
      view({
        deactivation: { appliedAt: 0, by: 'timer', steps: [{ step: 'virtuals', ok: false, detail: 'no config' }] },
        deactivationComplete: false,
        pendingSteps: ['virtuals']
      })
    )

    expect(partial).toContain('Virtuals agent name')
    expect(partial).not.toMatch(/everywhere/)
    expect(deactivationCountdown(view({ deactivation: { appliedAt: 0, by: 'timer', steps: [] } }))).not.toMatch(
      /everywhere/
    )
    expect(isDeactivated(view({ state: 'unknown' }))).toBe(false)
  })

  it('maps cards to bridge items with the proper-case chain', () => {
    const items = bridgeItems([
      { id: `robinhood:${C}:7`, name: 'n', collection: 'c', chain: 'Robinhood', configured: true }
    ])

    expect(items).toEqual([
      {
        id: `robinhood:${C}:7`,
        chain: 'Robinhood',
        contract: C,
        tokenId: '7',
        name: 'n',
        image: null,
        configured: true
      }
    ])
  })
})
