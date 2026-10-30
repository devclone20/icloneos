// V3-ON r2 minor 4 — the window reads Set up decisions with the very function main uses (one validator, not a copy).
import { describe, expect, it } from 'vitest'

import { setupDecisions } from '@/iclone-shared/setup-decisions'

import { setupDecisionsOf } from './store'

describe('setupDecisionsOf', () => {
  it('is the shared validator itself', () => {
    expect(setupDecisionsOf).toBe(setupDecisions)
  })

  it('drops a malformed state or time exactly as main does', () => {
    const record = {
      setup: { agent: { state: 'maybe', at: '2026-10-22T10:00:00.000Z' }, system: { state: 'done', at: 'x' } }
    }

    expect(setupDecisionsOf(record as never)).toEqual({})
  })
})
