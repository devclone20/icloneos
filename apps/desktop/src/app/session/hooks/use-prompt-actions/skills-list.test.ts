import { describe, expect, it } from 'vitest'

import { slash as copy } from '@/i18n/en/slash'
import type { CommandsCatalogLike } from '@/lib/desktop-slash-commands'

import { renderSkillsList } from './skills-list'

const CATALOG: CommandsCatalogLike & { canon?: Record<string, string> } = {
  categories: [{ name: 'Session', pairs: [['/new', 'Start a new session']] }],
  pairs: [
    ['/new', 'Start a new session'],
    ['/economyos', 'Use when paying. More words.'],
    ['/ridervoice', "Use when speaking text in the owner's own voice. More."],
    ['/research', 'Look it up before answering'],
    ['/docx', 'Edit Word documents'],
    ['/github-pr', 'Open pull requests'],
    ['/mystery', 'No origin known']
  ],
  skills: {
    '/research': { usage: 60, origin: 'local' as const },
    '/docx': { usage: 0, origin: 'hub' as const },
    '/github-pr': { usage: 1, origin: 'bundled' as const }
  }
}

const ICLONE = {
  skills: [
    { name: 'economyos', whenToOpen: 'Use when paying.' },
    {
      name: 'ridervoice',
      whenToOpen: 'Use when speaking.',
      port: { needs: [{ kind: 'bin' as const, name: 'ffmpeg' }] }
    },
    {
      name: 'hm-qa',
      whenToOpen: 'Use when testing.',
      port: { needs: [], attribution: { author: 'Rodrigo Lopes', license: 'MIT' } }
    },
    { name: 'broken', whenToOpen: '', problem: 'no frontmatter block' },
    { name: 'badport', whenToOpen: 'Use when ported badly.', manifestProblem: 'schema 2 ≠ 1' }
  ]
}

describe('renderSkillsList', () => {
  const text = renderSkillsList({ catalog: CATALOG, iclone: ICLONE, copy })
  const lines = text.split('\n')

  it('groups: ported first, then the bundle, then the backend by origin; one line per skill', () => {
    const headers = lines.filter(line => line.endsWith(':'))

    expect(headers).toEqual(['icloneOS · from your library:', 'icloneOS:', 'Learned:', 'Upstream:', 'Hub:', 'Skills:'])
    expect(lines.filter(line => line.startsWith('/'))).toHaveLength(9)
    expect(text).not.toContain('/new')
  })

  it('a ported skill names what this machine lacks; one the agent has not loaded says so; a third-party one its author', () => {
    expect(lines.find(line => line.startsWith('/ridervoice'))).toBe(
      `${'/ridervoice'.padEnd(22)} Use when speaking. · needs ffmpeg`
    )
    expect(lines.find(line => line.startsWith('/hm-qa'))).toBe(
      `${'/hm-qa'.padEnd(22)} Use when testing. · by Rodrigo Lopes (MIT) · ${copy.skillsRestartNote}`
    )
    expect(lines.find(line => line.startsWith('/broken'))).toContain('broken')
  })

  it('F8: a bundled skill whose manifest.json is invalid is named with the problem, never a plain row', () => {
    expect(lines.find(line => line.startsWith('/badport'))).toBe(
      `${'/badport'.padEnd(22)} Use when ported badly. · manifest.json invalid — schema 2 ≠ 1 · ${copy.skillsRestartNote}`
    )
  })

  it('backend skills land by origin and the footer counts everything, naming the unavailable ones', () => {
    const at = (name: string) => lines.findIndex(line => line.startsWith(name))

    expect(at('Learned:')).toBeLessThan(at('/research'))
    expect(at('/research')).toBeLessThan(at('Upstream:'))
    expect(at('Upstream:')).toBeLessThan(at('/github-pr'))
    expect(at('Hub:')).toBeLessThan(at('/docx'))
    expect(at('Skills:')).toBeLessThan(at('/mystery'))
    expect(lines.at(-2)).toBe(copy.skillsFooter(9))
    expect(lines.at(-1)).toBe(copy.skillsUnavailable(1))
  })

  it('without the icloneOS catalog (web shim) it still lists the backend skills; nothing at all says so', () => {
    const only = renderSkillsList({ catalog: CATALOG, iclone: null, copy })

    expect(only).toContain('/economyos')
    expect(only).not.toContain('from your library')
    expect(renderSkillsList({ catalog: { pairs: [['/new', 'x']] }, iclone: null, copy })).toBe(copy.skillsEmpty)
  })
})
