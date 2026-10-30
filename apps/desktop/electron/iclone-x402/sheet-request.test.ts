import { describe, expect, it } from 'vitest'

import { sheetRequestId } from './sheet-request'

describe('J4-4: the canonical request id an owner sheet answer is bound to', () => {
  const request = { terms: { agent: 'agent-a', budget: '0.30', payees: ['0x1', '0x2'] }, network: 'eip155:84532' }

  it('J4-4: one request, one id — whatever order its keys were built in', () => {
    const reordered = { network: 'eip155:84532', terms: { payees: ['0x1', '0x2'], budget: '0.30', agent: 'agent-a' } }

    expect(sheetRequestId('payments.mandate', request)).toMatch(/^[0-9a-f]{32}$/)
    expect(sheetRequestId('payments.mandate', reordered)).toBe(sheetRequestId('payments.mandate', request))
  })

  it('J4-4: any value changed, a list reordered or another sheet kind ⇒ another id', () => {
    const base = sheetRequestId('payments.mandate', request)

    const variants = [
      { ...request, network: 'eip155:8453' },
      { ...request, terms: { ...request.terms, budget: '0.31' } },
      { ...request, terms: { ...request.terms, payees: ['0x2', '0x1'] } },
      { ...request, terms: { ...request.terms, agent: 'agent-b' } }
    ]

    for (const variant of variants) {
      expect(sheetRequestId('payments.mandate', variant)).not.toBe(base)
    }

    expect(sheetRequestId('payments.settings', request)).not.toBe(base)
  })
})
