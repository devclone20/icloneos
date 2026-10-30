// V3-ON r2 minor 4 — the one validator of the Set up decisions, used by main AND the window (identity proven in
// src/components/setup/store.test.ts and electron/iclone-setup.test.ts).
import { describe, expect, it } from 'vitest'

import { isIsoDateTime, setupDecisions } from './setup-decisions'

const AT = '2026-10-22T10:00:00.000Z'

describe('setupDecisions — shared by main and the window', () => {
  it('keeps only well-formed entries: state done | skipped, at an ISO date-time', () => {
    expect(
      setupDecisions({
        setup: {
          packages: { state: 'done', at: AT },
          system: { state: 'maybe', at: AT },
          agent: { state: 'skipped', at: 'yesterday' }
        }
      })
    ).toEqual({ packages: { state: 'done', at: AT } })
  })

  it('an impossible day, a bare date or a non-string time is not a timestamp', () => {
    expect(isIsoDateTime('2026-02-30T00:00:00Z')).toBe(false)
    expect(isIsoDateTime('2026-10-22')).toBe(false)
    expect(isIsoDateTime(Date.now())).toBe(false)
    expect(setupDecisions({ setup: { agent: { state: 'done', at: '2026-02-30T00:00:00Z' } } })).toEqual({})
  })

  it('a missing, null, array or junk `setup` is nothing decided; unknown sections are ignored', () => {
    for (const setup of [undefined, null, [], 'x', 42]) {
      expect(setupDecisions({ setup })).toEqual({})
    }

    expect(setupDecisions(null)).toEqual({})
    expect(setupDecisions({ setup: { bogus: { state: 'done', at: AT } } })).toEqual({})
  })
})
