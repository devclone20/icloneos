import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { readSkillCatalog, RETIRED_SKILLS, ROOT_FILES, skillTargets, syncSkillTrees } from './iclone-skills'
import { deriveSkillCatalog, renderCatalogFiles } from './iclone-skills-catalog'
import { isAtomicTempName } from './lib/atomic-write'

const roots: string[] = []

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-skills-'))

  roots.push(dir)

  return dir
}

function skill(root: string, name: string, body = `---\nname: ${name}\n---\n# ${name}\n`): void {
  mkdirSync(path.join(root, name, 'references'), { recursive: true })
  writeFileSync(path.join(root, name, 'SKILL.md'), body)
  writeFileSync(path.join(root, name, 'references', 'notes.md'), `notes for ${name}\n`)
}

afterAll(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('skillTargets — every tree the agent reads', () => {
  it('is the root home plus each iNFT profile, never a foreign profile', () => {
    const home = tmp()

    mkdirSync(path.join(home, 'profiles', 'inft-4dfb27-6'), { recursive: true })
    mkdirSync(path.join(home, 'profiles', 'inft-4dfb27-11'), { recursive: true })
    mkdirSync(path.join(home, 'profiles', 'work'), { recursive: true })
    writeFileSync(path.join(home, 'profiles', 'inft-file'), '')

    expect(skillTargets(home)).toEqual([
      path.join(home, 'skills', 'iclone'),
      path.join(home, 'profiles', 'inft-4dfb27-11', 'skills', 'iclone'),
      path.join(home, 'profiles', 'inft-4dfb27-6', 'skills', 'iclone')
    ])
  })

  it('is just the root when there are no profiles yet', () => {
    const home = tmp()

    expect(skillTargets(home)).toEqual([path.join(home, 'skills', 'iclone')])
  })
})

describe('syncSkillTrees — the app teaches every tree', () => {
  it('installs the bundle everywhere, retires the mini app, and is idempotent', () => {
    const source = tmp()
    const home = tmp()

    skill(source, 'economyos')
    skill(source, 'iclone-os')
    mkdirSync(path.join(source, 'not-a-skill'))
    mkdirSync(path.join(home, 'profiles', 'inft-4dfb27-6', 'skills', 'iclone'), { recursive: true })

    // Stale mini-app skill in the profile, the owner's own skill at the root.
    skill(path.join(home, 'profiles', 'inft-4dfb27-6', 'skills', 'iclone'), 'iclone-mini-economyos')
    skill(path.join(home, 'skills', 'iclone'), 'banner-press', 'owner text')

    const first = syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: '1.0.0-test' })

    expect(first.ok).toBe(true)
    expect(first.skills).toEqual(['economyos', 'iclone-os'])
    expect(first.targets).toHaveLength(2)
    // 2 skills + the derived CATALOG.json/.md, in each of the 2 trees.
    expect(first.written).toHaveLength(8)
    expect(first.retired).toEqual([
      path.join(home, 'profiles', 'inft-4dfb27-6', 'skills', 'iclone', 'iclone-mini-economyos')
    ])

    for (const target of first.targets) {
      expect(readFileSync(path.join(target, 'economyos', 'SKILL.md'), 'utf8')).toContain('name: economyos')
      expect(readFileSync(path.join(target, 'economyos', 'references', 'notes.md'), 'utf8')).toBe(
        'notes for economyos\n'
      )
      expect(readFileSync(path.join(target, 'economyos', '.iclone-managed'), 'utf8')).toBe('1.0.0-test\n')
    }

    // Retired = moved, never deleted; the owner's skill untouched.
    expect(existsSync(path.join(home, 'profiles', 'inft-4dfb27-6', 'skills', 'iclone', 'iclone-mini-economyos'))).toBe(
      false
    )
    expect(
      readFileSync(
        path.join(
          home,
          'skills-retired',
          '1.0.0-test',
          'profiles__inft-4dfb27-6__skills__iclone',
          'iclone-mini-economyos',
          'SKILL.md'
        ),
        'utf8'
      )
    ).toContain('iclone-mini-economyos')
    expect(readFileSync(path.join(home, 'skills', 'iclone', 'banner-press', 'SKILL.md'), 'utf8')).toBe('owner text')

    const second = syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: '1.0.0-test' })

    expect(second.written).toEqual([])
    expect(second.retired).toEqual([])
  })

  it('rewrites a skill the bundle changed, and only that one', () => {
    const source = tmp()
    const home = tmp()

    skill(source, 'economyos')
    skill(source, 'iclone-os')
    syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: 'a' })
    writeFileSync(path.join(source, 'economyos', 'SKILL.md'), 'newer\n')

    const report = syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: 'b' })

    // The new SKILL.md has no frontmatter, so its catalog row turns into a flagged one and the derived CATALOG.* follow.
    expect(report.written).toEqual([
      path.join(home, 'skills', 'iclone', 'economyos'),
      path.join(home, 'skills', 'iclone', 'CATALOG.md'),
      path.join(home, 'skills', 'iclone', 'CATALOG.json')
    ])
    expect(readFileSync(path.join(home, 'skills', 'iclone', 'economyos', 'SKILL.md'), 'utf8')).toBe('newer\n')
    expect(readFileSync(path.join(home, 'skills', 'iclone', 'iclone-os', '.iclone-managed'), 'utf8')).toBe('a\n')
  })

  it('reports a missing bundle instead of throwing', () => {
    const home = tmp()
    const report = syncSkillTrees({ sourceDir: path.join(home, 'nope'), hermesHome: home, stamp: 'x' })

    expect(report.ok).toBe(false)
    expect(report.errors[0]).toMatch(/bundled skills missing/)
    expect(existsSync(path.join(home, 'skills'))).toBe(false)
  })

  it('retires exactly the mini-app set and the pre-isolation CLI notes', () => {
    expect([...RETIRED_SKILLS]).toEqual([
      'iclone-mini-agentcard',
      'iclone-mini-app',
      'iclone-mini-appmap',
      'iclone-mini-commands',
      'iclone-mini-economyos',
      'iclone-mini-machines',
      'iclone-mini-voice',
      'virtuals-protocol-cli'
    ])
  })
})

function bundleRoot(root: string): void {
  writeFileSync(
    path.join(root, 'DESCRIPTION.md'),
    '---\ndescription: icloneOS skills — open one only when needed\n---\n'
  )
  writeFileSync(path.join(root, 'CATALOG.md'), '# catalog\n')
  writeFileSync(
    path.join(root, 'CATALOG.json'),
    JSON.stringify({ schema: 1, category: 'iclone', count: 1, skills: [] })
  )
  writeFileSync(path.join(root, 'README.md'), 'not synced\n')
}

function temps(dir: string): string[] {
  const out: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      out.push(...temps(full))
    } else if (entry.name.includes('.iclone-tmp-') || isAtomicTempName(entry.name)) {
      out.push(full)
    }
  }

  return out
}

describe('R14 — bundle-root files, atomic writes, catalog', () => {
  it('copies DESCRIPTION.md, writes CATALOG.* derived from the SKILL.md files (never the stale bundled copy), never README.md', () => {
    const source = tmp()
    const home = tmp()

    skill(source, 'economyos')
    bundleRoot(source)
    mkdirSync(path.join(home, 'profiles', 'inft-4dfb27-6'), { recursive: true })

    const report = syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: '1.1.0-202610170300' })

    expect(report.ok).toBe(true)
    expect(report.catalogHash).toMatch(/^[0-9a-f]{12}$/)

    for (const target of report.targets) {
      const derived = renderCatalogFiles(deriveSkillCatalog(source)?.skills ?? [])

      expect(ROOT_FILES).toEqual(['DESCRIPTION.md', 'CATALOG.md', 'CATALOG.json'])
      expect(
        readFileSync(path.join(target, 'DESCRIPTION.md')).equals(readFileSync(path.join(source, 'DESCRIPTION.md')))
      ).toBe(true)
      expect(readFileSync(path.join(target, 'CATALOG.json'), 'utf8')).toBe(derived['CATALOG.json'])
      expect(readFileSync(path.join(target, 'CATALOG.md'), 'utf8')).toBe(derived['CATALOG.md'])
      // The bundled CATALOG.json lists no skill (stale): the tree's copy lists economyos all the same.
      expect(
        JSON.parse(readFileSync(path.join(target, 'CATALOG.json'), 'utf8')).skills.map((r: { name: string }) => r.name)
      ).toEqual(['economyos'])

      expect(existsSync(path.join(target, 'README.md'))).toBe(false)
      expect(temps(target)).toEqual([])
    }

    expect(report.written).toContain(path.join(home, 'skills', 'iclone', 'DESCRIPTION.md'))
  })

  it('is idempotent: a second run writes nothing', () => {
    const source = tmp()
    const home = tmp()

    skill(source, 'economyos')
    bundleRoot(source)
    syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: 'a' })

    const second = syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: 'b' })

    expect(second.written).toEqual([])
    expect(second.ok).toBe(true)
  })

  it('a crash between the temp write and the rename leaves the old bytes, never half a file; the next run heals', () => {
    const source = tmp()
    const home = tmp()

    skill(source, 'economyos', '---\nname: economyos\n---\n# v1\n')
    bundleRoot(source)
    syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: 'a' })

    const live = path.join(home, 'skills', 'iclone', 'economyos', 'SKILL.md')
    const v2 = `---\nname: economyos\n---\n# v2\n${'x'.repeat(200_000)}\n`

    writeFileSync(path.join(source, 'economyos', 'SKILL.md'), v2)

    const crashed = syncSkillTrees({
      sourceDir: source,
      hermesHome: home,
      stamp: 'b',
      hooks: {
        beforeRename: () => {
          throw new Error('killed')
        }
      }
    })

    expect(crashed.ok).toBe(false)
    expect(readFileSync(live, 'utf8')).toBe('---\nname: economyos\n---\n# v1\n')
    expect(temps(path.join(home, 'skills', 'iclone')).length).toBeGreaterThan(0)

    const healed = syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: 'c' })

    expect(healed.ok).toBe(true)
    expect(readFileSync(live, 'utf8')).toBe(v2)
    expect(temps(path.join(home, 'skills', 'iclone'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('a copied file keeps its permission bits (a script stays executable)', () => {
    const source = tmp()
    const home = tmp()
    const script = path.join(source, 'economyos', 'run.sh')

    skill(source, 'economyos')
    bundleRoot(source)
    writeFileSync(script, '#!/bin/sh\n')
    chmodSync(script, 0o755)
    syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: 'a' })

    expect(statSync(path.join(home, 'skills', 'iclone', 'economyos', 'run.sh')).mode & 0o777).toBe(0o755)
  })

  it('never touches an owner-made skill or its temp-looking files outside our folders', () => {
    const source = tmp()
    const home = tmp()
    const mine = path.join(home, 'skills', 'iclone', 'banner-press')

    skill(source, 'economyos')
    bundleRoot(source)
    mkdirSync(mine, { recursive: true })
    writeFileSync(path.join(mine, 'SKILL.md'), 'owner\n')
    writeFileSync(path.join(mine, '.SKILL.md.iclone-tmp-1'), 'owner scratch\n')

    syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: 'a' })

    expect(readFileSync(path.join(mine, 'SKILL.md'), 'utf8')).toBe('owner\n')
    expect(existsSync(path.join(mine, '.SKILL.md.iclone-tmp-1'))).toBe(true)
  })

  it('a bundle without root files still syncs its skills (older package); the trees get the derived catalog', () => {
    const source = tmp()
    const home = tmp()

    skill(source, 'economyos')

    const report = syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: 'a' })

    expect(report.ok).toBe(true)
    expect(report.catalogHash).toMatch(/^[0-9a-f]{12}$/)
    expect(existsSync(path.join(home, 'skills', 'iclone', 'DESCRIPTION.md'))).toBe(false)
    expect(JSON.parse(readFileSync(path.join(home, 'skills', 'iclone', 'CATALOG.json'), 'utf8')).count).toBe(1)
  })

  it('readSkillCatalog derives the rows from the SKILL.md files; null when the folder is missing or holds no skill', () => {
    const source = tmp()

    expect(readSkillCatalog(path.join(source, 'missing'))).toBeNull()
    bundleRoot(source)
    expect(readSkillCatalog(source)).toBeNull()
    skill(
      source,
      'economyos',
      '---\nname: economyos\ndescription: "Use when paying. Then more."\nversion: 1.2.0\n---\n# e\n'
    )

    const catalog = readSkillCatalog(source, 'darwin')

    expect(catalog).toMatchObject({ schema: 1, category: 'iclone', count: 1, host: 'macos' })
    expect(catalog?.skills[0]).toEqual({
      name: 'economyos',
      version: '1.2.0',
      description: 'Use when paying. Then more.',
      whenToOpen: 'Use when paying.',
      tags: [],
      relatedSkills: [],
      platforms: []
    })
    expect(readSkillCatalog(source, 'linux')?.host).toBe('linux')
  })

  it('readSkillCatalog never reads the committed CATALOG.json: a hostile or stale copy changes nothing', () => {
    const source = tmp()

    skill(source, 'beta', '---\nname: beta\ndescription: "Use when beta."\nversion: 1.0.0\nplatforms: [linux]\n---\n')
    skill(source, 'broken', 'no frontmatter at all\n')
    writeFileSync(
      path.join(source, 'CATALOG.json'),
      JSON.stringify({ schema: 9, skills: [null, 5, 'alpha', { name: 'alpha', whenToOpen: 'x', version: '0' }] })
    )

    const catalog = readSkillCatalog(source, 'darwin')

    expect(catalog?.schema).toBe(1)
    expect(catalog?.skills.map(row => [row.name, row.platforms, row.problem])).toEqual([
      ['beta', ['linux'], undefined],
      ['broken', [], 'no frontmatter block']
    ])
  })

  it('a SKILL.md whose frontmatter cannot be read is still synced, kept as a flagged row and named in the errors', () => {
    const source = tmp()
    const home = tmp()

    skill(source, 'economyos')
    mkdirSync(path.join(source, 'odd'), { recursive: true })
    writeFileSync(path.join(source, 'odd', 'SKILL.md'), '---\nname: odd\ndescription: [unclosed\n  - x\n---\n# Body\n')

    const report = syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: 'a' })

    const synced = JSON.parse(readFileSync(path.join(home, 'skills', 'iclone', 'CATALOG.json'), 'utf8')) as {
      skills: { name: string; problem?: string }[]
    }

    expect(report.skills).toEqual(['economyos', 'odd'])
    expect(existsSync(path.join(home, 'skills', 'iclone', 'odd', 'SKILL.md'))).toBe(true)
    expect(report.errors).toEqual(['odd: frontmatter unreadable — unsupported frontmatter line: - x'])
    expect(synced.skills.find(row => row.name === 'odd')?.problem).toBe('unsupported frontmatter line: - x')
    expect(readSkillCatalog(source, 'darwin')?.skills.map(row => row.name)).toEqual(['economyos', 'odd'])
  })

  it('a body-only or frontmatter edit by another front reaches what the app reads with no generator run', () => {
    const source = tmp()
    const home = tmp()

    const body = (text: string, version: string) =>
      `---\nname: economyos\ndescription: "Use when paying."\nversion: ${version}\n---\n${text}\n`

    skill(source, 'economyos', body('# v1', '1.0.0'))
    bundleRoot(source)
    syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: 'a' })
    skill(source, 'economyos', body('# v1, a longer body', '1.0.0'))
    expect(readSkillCatalog(source)?.skills[0].version).toBe('1.0.0')
    skill(source, 'economyos', body('# v2', '2.0.0'))
    expect(readSkillCatalog(source)?.skills[0].version).toBe('2.0.0')
    syncSkillTrees({ sourceDir: source, hermesHome: home, stamp: 'b' })
    expect(
      JSON.parse(readFileSync(path.join(home, 'skills', 'iclone', 'CATALOG.json'), 'utf8')).skills[0].version
    ).toBe('2.0.0')
  })
})

// The real bundle is ~40 skills × 3 trees: a loaded full-suite run needs more than the 5 s default.
describe('V3-L — the official AgentCard skill reaches every Hermes tree', { timeout: 30_000 }, () => {
  // The real bundle (repo root `iclone/skills`), synced into a temp Hermes home — never the owner's ~/.hermes.
  const bundle = path.resolve(__dirname, '..', '..', '..', 'iclone', 'skills')
  const agentcardSkills = ['agentcard', 'agentcard-cli', 'agentcard-signup', 'agentcard-troubleshooting']

  it('one sync writes it unedited into the root and every inft-* profile; the catalogue lists it', () => {
    const home = tmp()

    for (const profile of ['inft-4dfb27-6', 'inft-4dfb27-7']) {
      mkdirSync(path.join(home, 'profiles', profile), { recursive: true })
    }

    const report = syncSkillTrees({ sourceDir: bundle, hermesHome: home, stamp: '0.0.3-test' })
    const official = readFileSync(path.join(bundle, 'agentcard', 'SKILL.md'))

    expect(report.ok, report.errors.join('; ')).toBe(true)
    expect(report.targets).toHaveLength(3)

    for (const target of report.targets) {
      expect(readFileSync(path.join(target, 'agentcard', 'SKILL.md')).equals(official), target).toBe(true)
      expect(existsSync(path.join(target, 'agentcard', 'VENDORED.json')), target).toBe(true)

      const catalog = JSON.parse(readFileSync(path.join(target, 'CATALOG.json'), 'utf8')) as {
        skills: { name: string }[]
      }

      for (const name of agentcardSkills) {
        expect(existsSync(path.join(target, name, 'SKILL.md')), `${target}/${name}`).toBe(true)
        expect(
          catalog.skills.some(row => row.name === name),
          `${target} CATALOG.json lists ${name}`
        ).toBe(true)
      }
    }

    const pane = readSkillCatalog(bundle, 'darwin')

    expect(pane?.skills.find(row => row.name === 'agentcard')?.version).toBe('2.2.0')
    expect(syncSkillTrees({ sourceDir: bundle, hermesHome: home, stamp: '0.0.3-test' }).written).toEqual([])
  })

  it('replaces a hand-written agentcard-cli left in the tree with the bundled 0.4.0 one', () => {
    const home = tmp()
    const root = path.join(home, 'skills', 'iclone')

    skill(
      root,
      'agentcard-cli',
      '---\nname: agentcard-cli\ndescription: "Operate the AgentCard CLI."\n---\n## Command surface (v0.3.0)\n'
    )
    syncSkillTrees({ sourceDir: bundle, hermesHome: home, stamp: '0.0.3-test' })

    const text = readFileSync(path.join(root, 'agentcard-cli', 'SKILL.md'), 'utf8')

    expect(text).toContain('(0.4.0)')
    expect(text).not.toContain('v0.3.0')

    // 0.4.0 removed `create` and `agentic`: our skills name them only to say so, never as a command to run.
    for (const name of ['agentcard-cli', 'agentcard-signup', 'agentcard-troubleshooting']) {
      const lines = readFileSync(path.join(root, name, 'SKILL.md'), 'utf8').split('\n')

      for (const line of lines.filter(row => /agentcard (create|agentic)\b/.test(row))) {
        expect(line, name).toMatch(/REMOVED|removed|gone/)
      }
    }
  })
})
