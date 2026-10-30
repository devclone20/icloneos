/** V3-I test fixture: one WorkView with an offer per standing and a row per group. */
import type { WorkView } from '@/iclone-shared/acp-work'

export function workViewFixture(patch: Partial<WorkView> = {}): WorkView {
  return {
    slug: 'robinhood-1',
    state: 'online',
    hold: null,
    blocking: [],
    presence: 'unverified',
    level: 'L1',
    effective: 'L1',
    downgrade: null,
    writes: 'off',
    offers: [
      {
        jobId: '4',
        chainId: 8453,
        title: 'memes',
        requester: '0xbb',
        priceMicros: 100,
        status: 'open',
        standing: 'refused',
        rule: 'price-floor',
        note: null
      },
      {
        jobId: '3',
        chainId: 8453,
        title: 'research',
        requester: '0xbb',
        priceMicros: 5_000_000,
        status: 'open',
        standing: 'pending',
        rule: null,
        note: null
      }
    ],
    rows: [
      {
        jobId: '1',
        chainId: 8453,
        title: 'research',
        status: 'completed',
        group: 'payments',
        trace: {
          offer: '2026-10-21T00:00:00.000Z',
          job: '1',
          budgetMicros: 5_000_000,
          deliverable: 'completed',
          paymentMicros: 5_000_000
        }
      },
      {
        jobId: '2',
        chainId: 8453,
        title: 'audit',
        status: 'funded',
        group: 'in-flight',
        trace: { offer: null, job: '2', budgetMicros: 2_000_000, deliverable: null, paymentMicros: null }
      }
    ],
    totals: { earnedMicros: 5_000_000, spentMicros: 0, escrowMicros: 2_000_000 },
    fixes: [
      { id: 'f1', at: '2026-10-21T10:00:00.000Z', cause: 'listener-exited', tried: 'restart-backoff', now: 'starting' }
    ],
    chain: { ok: true, records: 9, gaps: 0 },
    readAt: 1,
    readError: null,
    ...patch
  }
}
