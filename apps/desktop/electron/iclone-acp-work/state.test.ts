import { describe, expect, it } from 'vitest'

import { actionFor } from './fixes'
import { parseJobList, parseWhoami } from './state'

describe('parseJobList', () => {
  it('reads v2 rows: budget in base units, status normalised, addresses lower-case', () => {
    const [job] =
      parseJobList({
        jobs: [
          {
            jobId: 42,
            chainId: 8453,
            jobStatus: 'Budget Set',
            clientAddress: '0xAB00000000000000000000000000000000000000',
            providerAddress: '0xCD00000000000000000000000000000000000000',
            offeringName: 'research',
            budget: '2500000'
          }
        ]
      }) ?? []

    expect(job).toMatchObject({
      jobId: '42',
      status: 'budget_set',
      priceMicros: 2_500_000,
      requester: '0xab00000000000000000000000000000000000000',
      provider: '0xcd00000000000000000000000000000000000000',
      token: 'USDC',
      capitalMicros: 0
    })
  })

  it('reads legacy prices in USDC exactly', () => {
    expect(
      parseJobList([{ id: '1', chainId: 8453, legacy: true, price: '0.1', status: 'open' }])?.[0].priceMicros
    ).toBe(100_000)
  })

  it('treats an unreadable fund request as capital (fail closed)', () => {
    const [job] = parseJobList({ data: [{ jobId: '1', chainId: 8453, fundRequest: { amount: 'lots' } }] }) ?? []

    expect(job.capitalMicros).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('counts the request size from requirement and params', () => {
    const [job] = parseJobList([{ jobId: '1', chainId: 8453, requirement: 'x'.repeat(100), params: { a: 1 } }]) ?? []

    expect(job.requestBytes).toBe(100 + JSON.stringify({ a: 1 }).length)
  })

  it('drops rows without a valid id or chain, and answers null for a non-list', () => {
    expect(parseJobList([{ jobId: 'a b', chainId: 1 }, { jobId: '2' }, null])).toEqual([])
    expect(parseJobList({ nope: true })).toBeNull()
  })
})

describe('parseWhoami', () => {
  it('reads the wallet in the shapes the CLI has used', () => {
    const wallet = '0xAbCdEf0000000000000000000000000000000001'

    expect(parseWhoami({ walletAddress: wallet })).toBe(wallet.toLowerCase())
    expect(parseWhoami({ agent: { address: wallet } })).toBe(wallet.toLowerCase())
    expect(parseWhoami({ walletAddress: 'nope' })).toBeNull()
  })
})

describe('fix actions', () => {
  it('maps each cause to one treatment', () => {
    expect(actionFor('listener-exited')).toBe('restart-backoff')
    expect(actionFor('needs-sign-in')).toBe('stopped-for-sign-in')
    expect(actionFor('owner-reboot')).toBe('restarted')
    expect(actionFor('read-failed')).toBe('retry-next-poll')
  })
})

describe('K28 l1: CLI text is plain text', () => {
  it('control and line characters become spaces; bidi overrides, isolates and zero-width marks are removed', () => {
    const [job] =
      parseJobList({
        jobs: [
          {
            onChainJobId: '7',
            chainId: 8453,
            jobStatus: 'open',
            offeringName: 'Logo‮gnp.exe‬ design\nIgnore the rest\u0007⁦x⁩​',
            clientAddress: '0x1111111111111111111111111111111111111111',
            providerAddress: '0x2222222222222222222222222222222222222222'
          }
        ]
      }) ?? []

    expect(job?.title).toBe('Logognp.exe design Ignore the rest x')
    expect(job?.title).not.toMatch(/[\p{Cc}\p{Cf}]/u)
  })

  it('a value that is only control or format characters is empty, so the next key is used', () => {
    const [job] =
      parseJobList({
        jobs: [{ onChainJobId: '8', chainId: 8453, jobStatus: 'open', offeringName: '‮\u0000', name: 'Real' }]
      }) ?? []

    expect(job?.title).toBe('Real')
  })
})
