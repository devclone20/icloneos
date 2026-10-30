import { describe, expect, it } from 'vitest'

import type { SkillInfo, ToolsetInfo } from '@/types/hermes'

import {
  categoryFor,
  filteredSkills,
  filteredToolsets,
  parseFrontmatter,
  skillSubtitleParts,
  toolsetCalls,
  usageOf,
  visibleToolsetCount
} from './skill-logic'

const skill = (over: Partial<SkillInfo> & { name: string }): SkillInfo => ({
  category: '',
  description: '',
  enabled: true,
  ...over
})

const toolset = (over: Partial<ToolsetInfo> & { name: string }): ToolsetInfo => ({
  configured: true,
  description: '',
  enabled: true,
  label: '',
  tools: [],
  ...over
})

describe('usageOf / categoryFor', () => {
  it('reads a missing or non-numeric usage as zero', () => {
    expect(usageOf(skill({ name: 'a' }))).toBe(0)
    expect(usageOf(skill({ name: 'a', usage: 7 }))).toBe(7)
    expect(usageOf({ ...skill({ name: 'a' }), usage: '9' } as unknown as SkillInfo)).toBe(0)
  })

  it('falls back to "general" only for an absent category (whitespace is kept as-is)', () => {
    expect(categoryFor(skill({ category: '', name: 'a' }))).toBe('general')
    expect(categoryFor(skill({ category: '  ', name: 'a' }))).toBe('  ')
    expect(categoryFor(skill({ category: 'research', name: 'a' }))).toBe('research')
  })
})

describe('skillSubtitleParts', () => {
  it('badges only the non-default origins', () => {
    expect(skillSubtitleParts(skill({ category: 'web-search', name: 'a' }))).toEqual({
      badge: null,
      category: 'Web-Search'
    })
    expect(skillSubtitleParts(skill({ name: 'a', provenance: 'bundled' })).badge).toBeNull()
    expect(skillSubtitleParts(skill({ name: 'a', provenance: 'agent' })).badge).toBe('agent')
    expect(skillSubtitleParts(skill({ name: 'a', provenance: 'hub' })).badge).toBe('hub')
  })
})

describe('filteredSkills', () => {
  const rows = [
    skill({ category: 'research', description: 'reads papers', name: 'beta', usage: 1 }),
    skill({ category: 'writing', description: 'drafts posts', name: 'alpha', usage: 5 }),
    skill({ category: 'research', description: 'nothing', name: 'gamma' })
  ]

  it('sorts by usage descending, then by name', () => {
    expect(filteredSkills(rows, '', true).map(s => s.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('flips to least-used first without losing the name tie-break', () => {
    expect(filteredSkills(rows, '', false).map(s => s.name)).toEqual(['gamma', 'beta', 'alpha'])
  })

  it('matches the name, the description and the category', () => {
    expect(filteredSkills(rows, 'papers', true).map(s => s.name)).toEqual(['beta'])
    expect(filteredSkills(rows, 'research', true).map(s => s.name)).toEqual(['beta', 'gamma'])
    expect(filteredSkills(rows, 'ALPH', true).map(s => s.name)).toEqual(['alpha'])
    expect(filteredSkills(rows, 'nope', true)).toEqual([])
  })
})

describe('filteredToolsets', () => {
  const rows = [
    toolset({ description: 'shell access', name: 'terminal', tools: ['run_command'] }),
    toolset({ description: 'images', name: 'vision', tools: ['see'] }),
    toolset({ description: 'hidden plumbing', name: 'moa', tools: ['moa_run'] })
  ]

  it('drops the toolsets the desktop never lists', () => {
    expect(filteredToolsets(rows, '', {}, true).map(ts => ts.name)).toEqual(['terminal', 'vision'])
    expect(visibleToolsetCount(rows)).toBe(2)
  })

  it('sorts by call count and counts a toolset by its tools', () => {
    const calls = { run_command: 2, see: 9 }

    expect(toolsetCalls(rows[0], calls)).toBe(2)
    expect(filteredToolsets(rows, '', calls, true).map(ts => ts.name)).toEqual(['vision', 'terminal'])
    expect(filteredToolsets(rows, '', calls, false).map(ts => ts.name)).toEqual(['terminal', 'vision'])
  })

  it('matches a tool name, not just the label and description', () => {
    expect(filteredToolsets(rows, 'run_command', {}, true).map(ts => ts.name)).toEqual(['terminal'])
    expect(filteredToolsets(rows, 'images', {}, true).map(ts => ts.name)).toEqual(['vision'])
    expect(filteredToolsets(rows, 'moa', {}, true)).toEqual([])
  })
})

describe('parseFrontmatter', () => {
  it('returns the content untouched when there is no fenced block', () => {
    expect(parseFrontmatter('# Title\nbody')).toEqual({ body: '# Title\nbody', meta: [] })
  })

  it('flattens top-level keys and keeps the body after the fence', () => {
    const parsed = parseFrontmatter('---\nname: scout\nversion: 2\n---\nThe body.\n')

    expect(parsed.meta).toEqual([
      ['name', 'scout'],
      ['version', '2']
    ])
    expect(parsed.body).toBe('The body.\n')
  })

  it('keeps an indented block with its key and tolerates CRLF', () => {
    const parsed = parseFrontmatter('---\r\nname: a\r\nallowed:\r\n  - one\r\n  - two\r\n---\r\nbody')

    expect(parsed.meta).toEqual([
      ['name', 'a'],
      ['allowed', '- one\n- two']
    ])
    expect(parsed.body).toBe('body')
  })

  it('ignores a line before any key and a key with an empty value', () => {
    expect(parseFrontmatter('---\nstray text\nname:\n---\nb').meta).toEqual([['name', '']])
  })
})
