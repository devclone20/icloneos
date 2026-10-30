import { describe, expect, it } from 'vitest'

import type { IcloneCompatCard, IcloneCompatInboxRow, IcloneCompatVerdict } from '@/types/iclone-compat'

import { compatHeadline, installTip } from './compat'
import { digestView } from './digest'
import { INBOX_ROWS, inboxDecision, inboxRows } from './inbox'

const row = (sha: string, week: string, score: number, cluster: null | string = null): IcloneCompatInboxRow => ({
  week,
  sha,
  at: '2026-10-05T10:00:00.000Z',
  subject: `subject ${sha}`,
  score,
  terms: [],
  disposition: 'adopt',
  cluster
})

describe('P4a.ui.pane', () => {
  it('P4a.ui.pane maps a decision to a ledger line main accepts', () => {
    const now = Date.parse('2026-10-07T12:00:00.000Z')
    const lone = row('0123456789abcdef', '2026-W41', 5)

    expect(inboxDecision(lone, 'adopt', now)).toEqual({ cs: 'CS-0123456789', upstream: [lone.sha], decision: 'adopt' })
    expect(inboxDecision(row('fedcba9876', '2026-W41', 5, 'CL-abcdef0123'), 'watch', now).cs).toBe('CS-abcdef0123')
    expect(inboxDecision(lone, 'defer', now).decision).toBe('defer:2026-10-14')
  })

  it('P4a.ui.pane shows only the newest week, best score first, at most 12 rows', () => {
    const rows = [row('old', '2026-W40', 99), ...Array.from({ length: 20 }, (_, i) => row(`s${i}`, '2026-W41', i))]
    const shown = inboxRows(rows)

    expect(shown).toHaveLength(INBOX_ROWS)
    expect(shown.every(r => r.week === '2026-W41')).toBe(true)
    expect(shown[0].score).toBe(19)
  })

  it('P4a.ui.pane narrows backlog.json without trusting its shape', () => {
    expect(digestView(null)).toBeNull()
    expect(digestView({ commits: 'x', counts: { adopt: 3 }, noise: { fmt: 2, bad: 'y' }, range: 7 })).toEqual({
      range: { from: null, to: null },
      commits: 0,
      counts: { adopt: 3, ignore: 0, watch: 0 },
      noise: { fmt: 2, bad: 0 },
      clusters: 0
    })
  })

  it('P4a.ui.pane names why an UNKNOWN verdict is unverified, and says "no verdict" only when none was computed', () => {
    const card = (rules: string[]): IcloneCompatCard => ({
      root: 'engine',
      level: 'UNKNOWN',
      items: 1,
      names: ['spec'],
      rules,
      upstream: [],
      ticket: null,
      sites: 0
    })

    const verdict = (cards: IcloneCompatCard[], kind = 'preview') =>
      ({ kind, level: 'UNKNOWN', cards }) as unknown as IcloneCompatVerdict

    const fetchFailed = verdict([card(['FETCH-FAILED'])])

    expect(compatHeadline('UNKNOWN', null)).toMatch(/^No verdict yet/)
    expect(compatHeadline('UNKNOWN', fetchFailed, 'a'.repeat(40))).toBe(
      'Could not verify — the update target could not be read'
    )
    expect(compatHeadline('UNKNOWN', fetchFailed)).toBe('Could not verify — the update target could not be read')
    expect(compatHeadline('UNKNOWN', fetchFailed, null)).toBe(
      'Could not verify — the update target could not be resolved'
    )
    expect(compatHeadline('UNKNOWN', verdict([card(['FETCH-FAILED'])], 'boot'), null)).toBe(
      'Could not verify — the installed runtime could not be read'
    )

    for (const tip of [undefined, null, 'a'.repeat(40)]) {
      for (const kind of ['preview', 'boot', 'post-update', 'reflog']) {
        expect(compatHeadline('UNKNOWN', verdict([card(['FETCH-FAILED'])], kind), tip)).not.toMatch(/API contract/)
      }
    }

    expect(installTip(null)).toBeUndefined()
    expect(installTip({ probe: null })).toBeUndefined()
    expect(installTip({ installTarget: null })).toBeNull()
    expect(installTip({ installTarget: 7 })).toBeNull()
    expect(installTip({ installTarget: 'abc' })).toBe('abc')
    expect(compatHeadline('UNKNOWN', verdict([card(['NO-OPENRPC']), card(['LOCK-MISSING'])]))).toMatch(
      /lock is missing$/
    )
    expect(compatHeadline('UNKNOWN', verdict([]))).toMatch(/^Could not verify/)
    expect(compatHeadline('GREEN', verdict([]))).toMatch(/^Every call/)
  })
})
