import { describe, expect, it } from 'vitest'

import { buildBacklog, clusterOf, type Commit, globToRegExp, isoWeek, noiseOf, parseLog } from './adoption'

const DAY = 86400
const T0 = Date.parse('2026-09-07T10:00:00Z') / 1000
let n = 0

const commit = (subject: string, files: string[], at: number, parents = 1): Commit => {
  n += 1

  return {
    sha: `${n.toString(16).padStart(10, '0')}${'a'.repeat(30)}`,
    at,
    parents: Array.from({ length: parents }, () => 'p'),
    subject,
    files
  }
}

const range = { from: 'base', to: 'tip', mode: 'full' as const }

describe('iclone-compat adoption', () => {
  it('P4a.report.fixtures.flap: a display.* add -> revert -> re-land flap reaches the inbox once, as the re-land', () => {
    const add = commit('feat(display): message reactions', ['apps/desktop/src/display/reactions.ts'], T0)

    const revert = commit(
      'Revert "feat(display): message reactions"',
      ['apps/desktop/src/display/reactions.ts'],
      T0 + DAY
    )

    const reland = commit(
      'feat(display): message reactions, take two',
      ['apps/desktop/src/display/reactions.ts'],
      T0 + 5 * DAY
    )

    const b = buildBacklog({ commits: [reland, revert, add], range })

    expect(Object.keys(b.dispositions).sort()).toEqual([add.sha, revert.sha, reland.sha].sort())
    expect(b.dispositions[add.sha]).toBe('ignore')
    expect(b.dispositions[revert.sha]).toBe('ignore')
    expect(b.inbox.map(r => r.sha)).toEqual([reland.sha])
    expect(b.noise).toEqual({ revert: 1, reverted: 1 })
  })

  it('gives every commit exactly one disposition and is byte-stable', () => {
    const commits = [
      commit('fix(chat): composer loses focus', ['apps/desktop/src/chat/composer.tsx'], T0),
      commit('test: cover composer', ['apps/desktop/src/chat/composer.test.tsx'], T0 + 60),
      commit('chore(i18n): update strings', ['apps/desktop/src/locales/pt.json'], T0 + 120),
      commit('style: prettier', ['apps/desktop/src/chat/composer.tsx'], T0 + 180),
      commit('Merge branch main', [], T0 + 240, 2),
      commit('fix: sanitize markdown links (XSS)', ['apps/desktop/src/markdown.tsx'], T0 + 300),
      commit('feat: add telemetry opt-in', ['apps/desktop/src/settings/telemetry.tsx'], T0 + 360)
    ]

    const a = JSON.stringify(buildBacklog({ commits, range }))
    const b = JSON.parse(a)

    expect(JSON.stringify(buildBacklog({ commits, range }))).toBe(a)
    expect(Object.keys(b.dispositions)).toHaveLength(commits.length)
    expect(b.noise).toEqual({ fmt: 1, locale: 1, merge: 1, tests: 1 })
    const security = b.inbox.find((r: { sha: string }) => r.sha === commits[5].sha)
    expect(security).toMatchObject({ disposition: 'adopt', week: isoWeek(T0) })
    expect(security.terms).toContain('security')
    const telemetry = b.inbox.find((r: { sha: string }) => r.sha === commits[6].sha)
    expect(telemetry).toMatchObject({ disposition: 'watch' })
    expect(telemetry.terms).toContain('privacy')
  })

  it('caps the inbox at 12 rows per ISO week, ranked by score, and drops ledger-decided commits', () => {
    const commits = Array.from({ length: 30 }, (_, i) =>
      commit(i % 3 ? `chore: tweak ${i}` : `fix: bug ${i}`, [`apps/desktop/src/f${i}.ts`], T0 + i * 600)
    )

    const ledger = [
      {
        v: 1,
        at: 'x',
        by: 'lead',
        cs: 'CS-1',
        upstream: [commits[0].sha.slice(0, 10)],
        decision: 'implemented',
        lane: 'adopt' as const
      }
    ]

    const b = buildBacklog({ commits, range, ledger })

    expect(b.inbox).toHaveLength(12)
    expect(b.inbox.every(r => r.week === isoWeek(T0))).toBe(true)
    expect(b.inbox.slice(0, 9).every(r => r.terms.includes('fix'))).toBe(true)
    expect(b.dispositions[commits[0].sha]).toBe('adopt')
    expect(b.inbox.some(r => r.sha === commits[0].sha)).toBe(false)
  })

  it('clusters commits that share a non-hub file within a 72 h span', () => {
    const a = commit('feat: a', ['apps/desktop/src/x.ts'], T0)
    const b = commit('fix: a', ['apps/desktop/src/x.ts'], T0 + DAY)
    const c = commit('fix: a again', ['apps/desktop/src/x.ts'], T0 + 4 * DAY)
    const cl = clusterOf([a, b, c])

    expect(cl.get(a.sha)?.id).toBe(cl.get(b.sha)?.id)
    expect(cl.get(c.sha)?.id).not.toBe(cl.get(a.sha)?.id)
    expect(noiseOf([a, b, c]).size).toBe(0)
  })

  it('parses git log records and matches globs', () => {
    const log = '\x1eaaa\x1f1757800000\x1fp1\x1ffeat: x\n\napps/desktop/src/a.ts\napps/shared/b.ts\n'
    expect(parseLog(log)).toEqual([
      {
        sha: 'aaa',
        at: 1757800000,
        parents: ['p1'],
        subject: 'feat: x',
        files: ['apps/desktop/src/a.ts', 'apps/shared/b.ts']
      }
    ])
    expect(globToRegExp('apps/**/*.md').test('apps/desktop/docs/a.md')).toBe(true)
    expect(globToRegExp('**/*.md').test('README.md')).toBe(true)
    expect(globToRegExp('apps/shared/src/gateway-contract*').test('apps/shared/src/x/gateway-contract.ts')).toBe(false)
  })
})
