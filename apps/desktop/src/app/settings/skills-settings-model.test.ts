import { describe, expect, it } from 'vitest'

import { enSkills } from '@/i18n/en'
import { slash as enSlash } from '@/i18n/en/slash'
import type { SkillInfo } from '@/types/hermes'

import {
  filterGroups,
  groupSkills,
  hiddenOnHost,
  lastSyncLabel,
  manifestProblemLines,
  needsLines,
  offWarnings,
  osLabel,
  rowNotes,
  skillBody,
  type SkillCatalog,
  warnsOnDisable
} from './skills-settings-model'

const catalog: SkillCatalog = {
  schema: 1,
  category: 'iclone',
  count: 1,
  skills: [
    {
      name: 'economyos',
      version: '1.0.0',
      description: 'Use when emailing. More.',
      whenToOpen: 'Use when emailing.',
      tags: [],
      relatedSkills: []
    }
  ]
}

const skill = (name: string, provenance?: SkillInfo['provenance']): SkillInfo => ({
  name,
  category: 'x',
  description: `${name} line`,
  enabled: true,
  provenance
})

describe('skills-settings-model', () => {
  it('the catalog wins over the backend provenance; the rest by provenance', () => {
    const groups = groupSkills(
      [skill('economyos', 'agent'), skill('b', 'bundled'), skill('h', 'hub'), skill('l', 'agent'), skill('u')],
      catalog
    )

    expect(groups.iclone.map(row => [row.name, row.line])).toEqual([['economyos', 'Use when emailing.']])
    expect(groups.upstream.map(row => row.name)).toEqual(['b'])
    expect(groups.hub.map(row => row.name)).toEqual(['h'])
    expect(groups.learned.map(row => row.name)).toEqual(['l', 'u'])
  })

  it('without a catalog nothing is labelled icloneOS', () => {
    expect(groupSkills([skill('economyos', 'agent')], null).iclone).toEqual([])
  })

  it('filters by name and line', () => {
    const groups = groupSkills([skill('b', 'bundled')], catalog)

    expect(filterGroups(groups, 'EMAIL').iclone.length).toBe(1)
    expect(filterGroups(groups, 'email').upstream.length).toBe(0)
    expect(filterGroups(groups, '  ')).toBe(groups)
  })

  it('warns only for the skills the runtime instructions name', () => {
    expect(warnsOnDisable('economyos')).toBe(true)
    expect(warnsOnDisable('consent')).toBe(true)
    expect(warnsOnDisable('iclone-os')).toBe(false)
  })

  it('offWarnings: runtime skills off or untaught, related targets off; never ordinary or untaught ordinary ones', () => {
    const row = (name: string, relatedSkills: string[] = []) => ({
      name,
      version: '1.0.0',
      description: `Use when ${name}.`,
      whenToOpen: `Use when ${name}.`,
      tags: [],
      relatedSkills
    })

    const cat: SkillCatalog = {
      ...catalog,
      skills: [
        row('economyos'),
        row('consent'),
        row('alpha', ['beta', 'economyos']),
        row('beta'),
        row('gamma', ['delta']),
        row('delta'),
        row('epsilon')
      ]
    }

    const off = (name: string) => ({ ...skill(name, 'agent'), enabled: false })

    const groups = groupSkills(
      [off('economyos'), skill('alpha'), off('beta'), off('gamma'), off('delta'), off('ordinary')],
      cat
    )

    const warnings = offWarnings(groups)

    expect(Object.fromEntries(warnings)).toEqual({
      economyos: { kind: 'runtime' },
      consent: { kind: 'untaught' },
      beta: { kind: 'related', neededBy: ['alpha'] }
    })
    // delta is only named by gamma, which is off too; epsilon is untaught but nothing names it.
    expect(warnings.has('delta')).toBe(false)
    expect(warnings.has('epsilon')).toBe(false)
  })

  it('offWarnings: a runtime-named skill missing from the agent tree warns even with every other skill on', () => {
    const cat: SkillCatalog = {
      ...catalog,
      skills: ['economyos', 'iclone-os'].map(name => ({
        name,
        version: '1.0.0',
        description: `Use when ${name}.`,
        whenToOpen: `Use when ${name}.`,
        tags: [],
        relatedSkills: []
      }))
    }

    const warnings = offWarnings(groupSkills([skill('iclone-os')], cat))

    expect(Object.fromEntries(warnings)).toEqual({ economyos: { kind: 'untaught' } })
  })

  it('strips the frontmatter from the sheet body', () => {
    expect(skillBody('---\nname: a\n---\n\n# A\n')).toBe('# A\n')
    expect(skillBody('# no frontmatter\n')).toBe('# no frontmatter\n')
  })

  it('a linux-only bundled row on a macOS host is OS-hidden, not untaught, and never warns', () => {
    const linuxOnly = {
      ...catalog.skills[0],
      name: 'vps-provision',
      whenToOpen: 'Use when a VPS.',
      platforms: ['linux']
    }

    const both = {
      ...catalog.skills[0],
      name: 'ssh-access',
      whenToOpen: 'Use when ssh.',
      platforms: ['macos', 'linux']
    }

    const consent = { ...catalog.skills[0], name: 'consent', whenToOpen: 'Use when consent.', platforms: ['linux'] }

    const groups = groupSkills([skill('economyos')], {
      ...catalog,
      count: 4,
      host: 'macos',
      skills: [catalog.skills[0], linuxOnly, both, consent]
    })

    const row = (name: string) => groups.iclone.find(item => item.name === name)

    expect(row('vps-provision')).toMatchObject({ taught: false, hiddenOn: { host: 'macos', only: ['linux'] } })
    // Same OS-allowed row missing from the tree: genuinely untaught (Re-sync can fix it).
    expect(row('ssh-access')?.hiddenOn).toBeUndefined()
    expect(row('ssh-access')?.taught).toBe(false)
    // A runtime-named skill hidden by platforms is not reported "missing — Re-sync" either.
    expect(offWarnings(groups).has('consent')).toBe(false)
    expect(offWarnings(groups).has('vps-provision')).toBe(false)
    expect(groupSkills([], { ...catalog, host: 'linux', skills: [linuxOnly] }).iclone[0].hiddenOn).toBeUndefined()
    expect(groupSkills([], { ...catalog, skills: [linuxOnly] }).iclone[0].hiddenOn).toBeUndefined()
  })

  it('a bundled skill with an unreadable frontmatter stays in the iclone group, flagged, never "learned"', () => {
    const odd = { ...catalog.skills[0], name: 'odd', whenToOpen: '', description: '', problem: 'no frontmatter block' }

    const groups = groupSkills([skill('odd', 'agent'), skill('economyos')], {
      ...catalog,
      skills: [catalog.skills[0], odd]
    })

    const row = groups.iclone.find(item => item.name === 'odd')

    expect(row).toMatchObject({ line: 'odd', taught: true, problem: 'no frontmatter block' })
    expect(groups.learned.map(item => item.name)).not.toContain('odd')
    expect(groupSkills([], { ...catalog, skills: [odd] }).iclone[0]).toMatchObject({
      taught: false,
      problem: 'no frontmatter block'
    })
    expect(groups.iclone.find(item => item.name === 'economyos')?.problem).toBeUndefined()
  })

  it('hiddenOnHost follows Hermes: [] = every OS, darwin = macos; osLabel names the OS', () => {
    const base = catalog.skills[0]

    expect(hiddenOnHost({ ...base, platforms: [] }, 'macos')).toBe(false)
    expect(hiddenOnHost(base, 'macos')).toBe(false)
    expect(hiddenOnHost({ ...base, platforms: ['darwin'] }, 'macos')).toBe(false)
    expect(hiddenOnHost({ ...base, platforms: ['windows'] }, 'linux')).toBe(true)
    expect(hiddenOnHost({ ...base, platforms: ['linux'] }, undefined)).toBe(false)
    expect([osLabel('macos'), osLabel('darwin'), osLabel('linux'), osLabel('freebsd')]).toEqual([
      'macOS',
      'macOS',
      'Linux',
      'freebsd'
    ])
  })
})

describe('lastSyncLabel', () => {
  const now = 10_000_000_000
  const at = (ageMs: number) => lastSyncLabel(now - ageMs, enSkills, now)

  it('reads a missing timestamp as never synced', () => {
    expect(lastSyncLabel(undefined, enSkills, now)).toBe('Not synced yet')
    expect(lastSyncLabel(0, enSkills, now)).toBe('Not synced yet')
  })

  it('floors to whole minutes, then whole hours, and never switches to days', () => {
    expect(at(59_000)).toBe('Last sync just now')
    expect(at(60_000)).toBe('Last sync 1 min ago')
    expect(at(89_000)).toBe('Last sync 1 min ago')
    expect(at(3_599_000)).toBe('Last sync 59 min ago')
    expect(at(3_600_000)).toBe('Last sync 1 h ago')
    expect(at(86_340_000)).toBe('Last sync 23 h ago')
    expect(at(90_000_000)).toBe('Last sync 25 h ago')
    expect(at(176_400_000)).toBe('Last sync 49 h ago')
  })

  it('reads a future timestamp as just now', () => {
    expect(at(-120_000)).toBe('Last sync just now')
  })
})

// V3-B — a ported skill's port facts ride on its row; the ones this host cannot run are named with what they lack.
describe('skills-settings-model (V3-B port facts)', () => {
  const port = (needs: { kind: 'bin' | 'mcp' | 'os' | 'path'; name: string }[]) => ({
    version: '1.0.0',
    portedAt: '2026-10-21T10:00:00.000Z',
    requires: { os: [], bins: [], mcp: [], paths: [] },
    touches: ['X' as const],
    needs
  })

  const entry = (name: string, needs?: { kind: 'bin' | 'mcp' | 'os' | 'path'; name: string }[]) => ({
    name,
    version: '1.0.0',
    description: `Use when ${name}.`,
    whenToOpen: `Use when ${name}.`,
    tags: [],
    relatedSkills: [],
    ...(needs ? { port: port(needs) } : {})
  })

  const ported = {
    schema: 1,
    category: 'iclone',
    count: 3,
    skills: [entry('economyos'), entry('ridervoice', [{ kind: 'bin', name: 'ffmpeg' }]), entry('hm-qa', [])]
  }

  it('taught and untaught rows both carry the port facts; an ordinary bundle row carries none', () => {
    const groups = groupSkills([skill('ridervoice', 'agent'), skill('economyos', 'agent')], ported)
    const rows = Object.fromEntries(groups.iclone.map(row => [row.name, row]))

    expect(rows.ridervoice.port?.needs).toEqual([{ kind: 'bin', name: 'ffmpeg' }])
    expect(rows.ridervoice.taught).toBe(true)
    expect(rows['hm-qa'].port?.needs).toEqual([])
    expect(rows['hm-qa'].taught).toBe(false)
    expect(rows.economyos.port).toBeUndefined()
  })

  it('needsLines names only the ported skills with an unmet requirement, with what each lacks', () => {
    const groups = groupSkills([skill('ridervoice', 'agent')], ported)

    expect(needsLines(groups)).toEqual(['ridervoice (ffmpeg)'])
    expect(needsLines(groupSkills([], { ...ported, skills: [entry('hm-qa', [])] }))).toEqual([])
  })

  it('F8: a bundled skill with an invalid manifest.json is carried on its row, taught or not, and named in a line', () => {
    const catalog = {
      ...ported,
      skills: [
        { ...entry('badport'), manifestProblem: 'schema 2 ≠ 1' },
        { ...entry('untaught-bad'), manifestProblem: 'touches must be a list of R|Wp|Wo|X|N|$|M|S|I|D' },
        entry('economyos')
      ]
    }

    const groups = groupSkills([skill('badport', 'agent'), skill('economyos', 'agent')], catalog)
    const rows = Object.fromEntries(groups.iclone.map(row => [row.name, row]))

    expect(rows.badport.manifestProblem).toBe('schema 2 ≠ 1')
    expect(rows['untaught-bad'].manifestProblem).toContain('touches must be')
    expect(rows.economyos.manifestProblem).toBeUndefined()
    expect(manifestProblemLines(groups)).toEqual([
      'badport (schema 2 ≠ 1)',
      'untaught-bad (touches must be a list of R|Wp|Wo|X|N|$|M|S|I|D)'
    ])
    expect(manifestProblemLines(groupSkills([skill('economyos', 'agent')], ported))).toEqual([])
  })

  it('rowNotes: attribution, needs and an invalid manifest sit on the row; a plain bundle row has no note', () => {
    const catalog = {
      ...ported,
      skills: [
        {
          ...entry('hm-qa', []),
          port: { ...port([]), attribution: { author: 'Rodrigo Lopes', license: 'MIT', upstream: 'x' } }
        },
        entry('ridervoice', [{ kind: 'bin', name: 'ffmpeg' }]),
        { ...entry('badport'), manifestProblem: 'schema 2 ≠ 1' },
        entry('economyos')
      ]
    }

    const notes = rowNotes(groupSkills([skill('economyos', 'agent')], catalog), enSlash)

    expect([...notes.entries()]).toEqual([
      ['badport', 'manifest.json invalid — schema 2 ≠ 1'],
      ['hm-qa', 'by Rodrigo Lopes (MIT)'],
      ['ridervoice', 'needs ffmpeg']
    ])
  })
})
