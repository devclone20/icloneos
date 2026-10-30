import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { SkillCatalog } from './iclone-skills'
import {
  deriveSkillCatalog,
  hiddenOn,
  renderCatalogFiles,
  SHIPPED_OS,
  type SkillCatalogEntry
} from './iclone-skills-catalog'

// The one source tree (repo root `iclone/skills`) and its generator.
const SKILLS = path.resolve(__dirname, '..', '..', '..', 'iclone', 'skills')
const GENERATOR = path.join(SKILLS, 'tools', 'build-catalog.mjs')
// Hermes' bundled skills (`<repo>/skills/<category>/<name>`): a related skill may point at one of them.
const UPSTREAM = path.resolve(SKILLS, '..', '..', 'skills')
const PROMPT_CUT = 57
// The repo's own Hermes (agent/skill_utils.py) in its venv: the YAML truth the agents read.
const REPO = path.resolve(SKILLS, '..', '..')
const HERMES_PYTHON = path.join(REPO, 'venv', 'bin', 'python')
const roots: string[] = []

afterAll(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function bundleNames(): string[] {
  return readdirSync(SKILLS)
    .filter(name => /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) && statSync(path.join(SKILLS, name)).isDirectory())
    .filter(name => {
      try {
        return statSync(path.join(SKILLS, name, 'SKILL.md')).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

describe('R14 — the skills catalog is the folder truth', () => {
  const catalog = JSON.parse(readFileSync(path.join(SKILLS, 'CATALOG.json'), 'utf8')) as SkillCatalog

  it('the committed CATALOG.{json,md} and DESCRIPTION.md equal a fresh generation (--check)', () => {
    const run = spawnSync(process.execPath, [GENERATOR, '--check'], { encoding: 'utf8' })
    const result = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}') as { stale?: string[] }

    // The message names the SKILL.md that staled the catalog; the fix is `node iclone/skills/tools/build-catalog.mjs`.
    expect(result, `catalog drifted: ${(result.stale ?? []).join('; ')}`).toMatchObject({
      ok: true,
      problems: 0,
      drift: []
    })
  })

  it('has exactly one row per bundled skill folder', () => {
    expect(catalog.skills.map(skill => skill.name)).toEqual(bundleNames())
    expect(catalog.count).toBe(bundleNames().length)
  })

  it('every description opens with a "Use when" cue that survives the index cut', () => {
    // A vendored skill ships its author's bytes unedited (its sha256 is checked by the generator instead).
    const vendored = (name: string) => existsSync(path.join(SKILLS, name, 'VENDORED.json'))

    for (const skill of catalog.skills.filter(row => !vendored(row.name))) {
      expect(skill.description.startsWith('Use when '), skill.name).toBe(true)
      expect(skill.whenToOpen.length, skill.name).toBeLessThanOrEqual(PROMPT_CUT)
      expect(skill.description.slice(0, PROMPT_CUT).startsWith(skill.whenToOpen), skill.name).toBe(true)
    }
  })

  it('every related skill exists in the bundle or among the skills Hermes bundles', () => {
    const names = new Set(catalog.skills.map(skill => skill.name))

    const upstream = (name: string) =>
      readdirSync(UPSTREAM).some(category => existsSync(path.join(UPSTREAM, category, name, 'SKILL.md')))

    for (const skill of catalog.skills) {
      for (const target of skill.relatedSkills) {
        expect(names.has(target) || upstream(target), `${skill.name} → ${target}`).toBe(true)
      }
    }
  })

  it('the category line is one short frontmatter description (≤ 160 B) that never lists skills', () => {
    const text = readFileSync(path.join(SKILLS, 'DESCRIPTION.md'), 'utf8')
    const line = /^description: (.*)$/m.exec(text)?.[1] ?? ''

    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(160)
    expect(line).toContain('skill_view')
    expect(line).toMatch(/only when/)

    for (const skill of catalog.skills) {
      expect(line.includes(skill.name), skill.name).toBe(false)
    }
  })

  it('a stale catalog names the SKILL.md that drifted (field, old → new), new and removed skills too', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-catalog-'))

    roots.push(dir)

    const write = (name: string, body: string, version = '1.0.0') => {
      mkdirSync(path.join(dir, name), { recursive: true })
      writeFileSync(
        path.join(dir, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: "Use when ${name}."\nversion: ${version}\n---\n${body}\n`
      )
    }

    write('alpha', '# a')
    write('beta', '# b')
    execFileSync(process.execPath, [GENERATOR, '--dir', dir], { encoding: 'utf8' })
    expect(readdirSync(dir).filter(name => name.includes('.tmp-'))).toEqual([])

    write('alpha', '# a, now longer', '1.1.0')
    rmSync(path.join(dir, 'beta'), { recursive: true })
    write('gamma', '# g')

    const run = spawnSync(process.execPath, [GENERATOR, '--check', '--dir', dir], { encoding: 'utf8' })
    const result = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}') as { drift: string[]; stale: string[] }

    expect(run.status).toBe(1)
    expect(result.drift).toEqual(['CATALOG.json', 'CATALOG.md'])
    expect(result.stale).toHaveLength(3)
    expect(result.stale[0]).toBe('alpha/SKILL.md: version 1.0.0 → 1.1.0')
    expect(result.stale.slice(1)).toEqual(['gamma/SKILL.md: new skill', 'beta/SKILL.md: removed'])
    expect(run.stderr).toContain(`drifted ${result.stale[0]}`)
  })

  it('a body-only edit (another front owns the body) never stales the catalog', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-catalog-'))

    roots.push(dir)
    mkdirSync(path.join(dir, 'alpha'))
    writeFileSync(path.join(dir, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: "Use when alpha."\n---\n# a\n')
    execFileSync(process.execPath, [GENERATOR, '--dir', dir], { encoding: 'utf8' })
    appendFileSync(path.join(dir, 'alpha', 'SKILL.md'), '\nA much longer playbook body, edited by its own front.\n')

    const run = spawnSync(process.execPath, [GENERATOR, '--check', '--dir', dir], { encoding: 'utf8' })

    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout.trim()).drift).toEqual([])
    expect(readFileSync(path.join(dir, 'CATALOG.json'), 'utf8')).not.toContain('bytes')
  })

  it('--check reached through a symlinked path still runs and fails on drift (never a silent exit 0)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-catalog-'))
    const link = path.join(dir, 'tools-link')

    roots.push(dir)
    mkdirSync(path.join(dir, 'alpha'))
    writeFileSync(path.join(dir, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: "Use when alpha."\n---\n# a\n')
    symlinkSync(path.dirname(GENERATOR), link)

    const run = spawnSync(process.execPath, [path.join(link, 'build-catalog.mjs'), '--check', '--dir', dir], {
      encoding: 'utf8'
    })

    expect(run.status).toBe(1)
    expect(JSON.parse(run.stdout.trim()).drift).toEqual(['CATALOG.json', 'CATALOG.md', 'DESCRIPTION.md'])
  })

  it('a related skill may point at a skill Hermes bundles (`<repo>/skills/<category>/<name>`)', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'iclone-catalog-'))
    const dir = path.join(repo, 'iclone', 'skills')

    roots.push(repo)
    mkdirSync(path.join(repo, 'skills', 'github', 'github-auth'), { recursive: true })
    writeFileSync(path.join(repo, 'skills', 'github', 'github-auth', 'SKILL.md'), '---\nname: github-auth\n---\n')
    mkdirSync(path.join(dir, 'alpha'), { recursive: true })
    writeFileSync(
      path.join(dir, 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: "Use when alpha."\nmetadata:\n  hermes:\n    related_skills: [github-auth, ghost]\n---\n'
    )

    const run = spawnSync(process.execPath, [GENERATOR, '--dir', dir], { encoding: 'utf8' })

    expect(run.stderr).not.toContain('"github-auth"')
    expect(run.stderr).toContain('alpha: related skill "ghost" is neither in the bundle nor bundled with Hermes')
  })

  it('K-RT8: at 1ac3f97 the six github-* skills are one `github` skill; a bundle pointing at the old names fails', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'iclone-catalog-'))
    const dir = path.join(repo, 'iclone', 'skills')

    roots.push(repo)
    // the pin's layout (upstream c49fa88b80): skills/software-development/github, no skills/github/github-auth
    mkdirSync(path.join(repo, 'skills', 'software-development', 'github'), { recursive: true })
    writeFileSync(path.join(repo, 'skills', 'software-development', 'github', 'SKILL.md'), '---\nname: github\n---\n')

    const write = (related: string) => {
      mkdirSync(path.join(dir, 'alpha'), { recursive: true })
      writeFileSync(
        path.join(dir, 'alpha', 'SKILL.md'),
        `---\nname: alpha\ndescription: "Use when alpha."\nmetadata:\n  hermes:\n    related_skills: [${related}]\n---\n`
      )

      return spawnSync(process.execPath, [GENERATOR, '--dir', dir], { encoding: 'utf8' })
    }

    const old = write('github-auth, github-repo-management, github-pr-workflow')

    expect(old.status).not.toBe(0)
    expect(old.stderr).toContain('alpha: related skill "github-auth" is neither in the bundle nor bundled with Hermes')

    const merged = write('github')

    expect(merged.status, merged.stderr).toBe(0)
    expect(merged.stderr).not.toContain('related skill')
  })

  it('the generator refuses a description without the cue, a long cue and an unknown related skill', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-catalog-'))

    roots.push(dir)

    const write = (name: string, description: string, related = '[]') => {
      mkdirSync(path.join(dir, name), { recursive: true })
      writeFileSync(
        path.join(dir, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: "${description}"\nversion: 1.0.0\nmetadata:\n  hermes:\n    related_skills: ${related}\n---\n# body\n`
      )
    }

    write('good', 'Use when testing. Body.', '[ghost]')
    write('no-cue', 'Drive the app.')
    write('long-cue', `Use when ${'a'.repeat(60)}.`)

    const run = spawnSync(process.execPath, [GENERATOR, '--check', '--dir', dir], { encoding: 'utf8' })

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('no-cue: description must start with "Use when"')
    expect(run.stderr).toContain('long-cue: the cue')
    expect(run.stderr).toContain('good: related skill "ghost" is neither in the bundle nor bundled with Hermes')
  })

  it('V3-L: the official AgentCard skill ships unedited — its bytes match VENDORED.json and the catalog lists it', () => {
    const dir = path.join(SKILLS, 'agentcard')
    const record = JSON.parse(readFileSync(path.join(dir, 'VENDORED.json'), 'utf8')) as Record<string, unknown>
    const bytes = readFileSync(path.join(dir, 'SKILL.md'))

    expect(record.source).toBe('https://agentcard.ai/skill')
    expect(String(record.licence)).toMatch(/^MIT/)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.sha256)
    expect(bytes.toString('utf8')).toMatch(/^---\nname: agentcard\n[\s\S]*\nlicense: MIT\n/)

    const row = catalog.skills.find(skill => skill.name === 'agentcard')

    expect(row?.version).toBe(record.version)
    expect(deriveSkillCatalog(SKILLS)?.skills.find(skill => skill.name === 'agentcard')?.version).toBe(record.version)
  })

  it('V3-L: a vendored skill is exempt from the house style, never from its sha256, version and licence', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-catalog-'))

    roots.push(dir)

    const body =
      '---\nname: vend\ndescription: Lets an agent pay — a long upstream sentence, no cue.\nversion: 2.2.0\nlicense: MIT\nprerequisites:\n  commands:\n    - npm\n---\n# body\n'

    const vendor = (name: string, text: string, record: Record<string, unknown>) => {
      mkdirSync(path.join(dir, name), { recursive: true })
      writeFileSync(path.join(dir, name, 'SKILL.md'), text.replace('name: vend', `name: ${name}`))
      writeFileSync(path.join(dir, name, 'VENDORED.json'), JSON.stringify(record))
    }

    const sha = (name: string, text: string) =>
      createHash('sha256')
        .update(text.replace('name: vend', `name: ${name}`))
        .digest('hex')

    vendor('vend', body, {
      source: 'https://example.com/skill',
      version: '2.2.0',
      licence: 'MIT',
      sha256: sha('vend', body)
    })
    execFileSync(process.execPath, [GENERATOR, '--dir', dir])

    expect(spawnSync(process.execPath, [GENERATOR, '--check', '--dir', dir], { encoding: 'utf8' }).status).toBe(0)

    vendor('edited', body, {
      source: 'https://example.com/skill',
      version: '2.2.0',
      licence: 'MIT',
      sha256: sha('edited', `${body}x`)
    })
    vendor('unlicensed', body, {
      source: 'http://example.com/skill',
      version: '2.1.0',
      sha256: sha('unlicensed', body)
    })
    // The generator still writes the catalog (exit 1 on the problems); --check then fails on the problems alone.
    spawnSync(process.execPath, [GENERATOR, '--dir', dir], { encoding: 'utf8' })

    const run = spawnSync(process.execPath, [GENERATOR, '--check', '--dir', dir], { encoding: 'utf8' })

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('edited: SKILL.md is not the vendored file')
    expect(run.stderr).toContain('unlicensed: VENDORED.json names no https source')
    expect(run.stderr).toContain('unlicensed: VENDORED.json names no licence')
    expect(run.stderr).toContain('unlicensed: VENDORED.json version "2.1.0" differs from the SKILL.md version "2.2.0"')
    expect(run.stderr).not.toContain('vend: description must start')
    expect(run.stderr).not.toContain('a block list')
  })

  it('a stale message cuts a string field around its first differing char, so the drift itself shows', async () => {
    const { changeSides, staleSkills } = (await import(GENERATOR)) as Generator

    const row = {
      name: 'x',
      version: '1',
      description: 'Use when running the Hermes gateway on a server. Old tail.',
      whenToOpen: 'Use when running the Hermes gateway on a server.',
      tags: [],
      relatedSkills: [],
      platforms: []
    }

    const [line] = staleSkills(JSON.stringify({ skills: [row] }), [
      { ...row, description: row.description.replace('Old', 'New') }
    ])

    expect(line).toBe('x/SKILL.md: description …gateway on a server. Old tail. → …gateway on a server. New tail.')
    expect(changeSides('abc', 'abd')).toEqual(['abc', 'abd'])
    expect(changeSides(['a'], ['b'])).toEqual(['["a"]', '["b"]'])
  })

  it('carries `platforms` into every row and flags a bundled skill hidden on an OS the app ships', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-catalog-'))

    roots.push(dir)

    const write = (name: string, platforms: string | null) => {
      mkdirSync(path.join(dir, name), { recursive: true })
      writeFileSync(
        path.join(dir, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: "Use when ${name}."\nversion: 1.0.0\n${platforms ? `platforms: ${platforms}\n` : ''}---\n`
      )
    }

    write('anywhere', null)
    write('both', '[macos, linux]')
    write('darwin-alias', '[darwin, linux]')
    write('linux-only', '[linux]')
    write('mac-scalar', 'macos')

    const run = spawnSync(process.execPath, [GENERATOR, '--dir', dir], { encoding: 'utf8' })
    const rows = (JSON.parse(readFileSync(path.join(dir, 'CATALOG.json'), 'utf8')) as SkillCatalog).skills

    expect(run.status).toBe(1)
    expect(rows.map(row => [row.name, row.platforms])).toEqual([
      ['anywhere', []],
      ['both', ['macos', 'linux']],
      ['darwin-alias', ['darwin', 'linux']],
      ['linux-only', ['linux']],
      ['mac-scalar', ['macos']]
    ])
    expect(run.stderr).toContain('linux-only: hidden from agents on macos by platforms: [linux]')
    expect(run.stderr).toContain('mac-scalar: hidden from agents on linux by platforms: [macos]')
    expect(run.stderr.match(/hidden from agents/g)).toHaveLength(2)
  })

  it('no bundled skill is hidden from agents on an OS the app ships', () => {
    const hidden = catalog.skills.filter(row => hiddenOn(row.platforms ?? [], SHIPPED_OS).length)

    expect(hidden.map(row => `${row.name}: ${row.platforms.join(',')}`)).toEqual([])
  })

  it('parity: the app derivation (TS port) renders the generator bytes, on the real bundle and on odd fixtures', async () => {
    const { buildCatalog, renderFiles } = (await import(GENERATOR)) as Generator
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-catalog-'))

    roots.push(dir)

    const write = (name: string, text: string | null) => {
      mkdirSync(path.join(dir, name), { recursive: true })

      if (text !== null) {
        writeFileSync(path.join(dir, name, 'SKILL.md'), text)
      }
    }

    write(
      'quoted',
      `---\nname: quoted\ndescription: "Use when \\"quoted\\" | piped; then."\nversion: '2.0'\n# a comment\n---\n`
    )
    write(
      'nested',
      '---\nname: nested\ndescription: Use when nested.\nplatforms: [ Linux , DARWIN ]\nmetadata:\n  hermes:\n    tags: [a, "b c"]\n    related_skills: [quoted]\n  other:\n    x: y\n---\n'
    )
    write(
      'scalar-platform',
      '---\nname: scalar-platform\ndescription: Use when one OS.\nplatforms: linux\nversion: [1, 2]\n---\n'
    )
    write('renamed', '---\nname: other\ndescription: Use when renamed.\n---\n')
    write('broken', '---\nname: broken\n- not a key\n---\n')
    write('no-frontmatter', '# body only\n')
    write('empty-folder', null)
    write('Bad_Name', '---\nname: Bad_Name\ndescription: Use when bad.\n---\n')

    for (const [name, text] of Object.entries(R4_FIXTURES)) {
      write(name, text)
    }

    for (const source of [SKILLS, dir]) {
      const ours = deriveSkillCatalog(source)
      const theirs = buildCatalog(source, new Set<string>())
      const theirFiles = renderFiles(theirs.skills)
      const ourFiles = renderCatalogFiles(ours?.skills ?? [])

      expect(ours?.skills).toEqual(theirs.skills)
      expect(ourFiles['CATALOG.json']).toBe(theirFiles['CATALOG.json'])
      expect(ourFiles['CATALOG.md']).toBe(theirFiles['CATALOG.md'])
    }

    // Nothing is dropped: a frontmatter outside what both parsers read is a row with `problem`.
    expect(deriveSkillCatalog(dir)?.skills.map(row => [row.name, row.problem])).toEqual([
      ['block-list', undefined],
      ['block-tags', undefined],
      ['bom-file', undefined],
      ['broken', 'unsupported frontmatter line: - not a key'],
      ['folded-desc', undefined],
      ['json-escape', undefined],
      ['nested', undefined],
      ['no-frontmatter', 'no frontmatter block'],
      ['plain-ok', undefined],
      ['quoted', undefined],
      ['renamed', undefined],
      ['scalar-platform', undefined]
    ])
    expect(renderCatalogFiles(deriveSkillCatalog(dir)?.skills ?? [])['CATALOG.md']).toContain(
      '| `broken` | Frontmatter unreadable — unsupported frontmatter line: - not a key |  |'
    )
  })

  it('reads the YAML Hermes reads: BOM, block lists, folded and literal scalars, YAML escapes (r4 probe)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'iclone-yaml-'))

    roots.push(dir)

    for (const [name, text] of Object.entries(R4_FIXTURES)) {
      mkdirSync(path.join(dir, name))
      writeFileSync(path.join(dir, name, 'SKILL.md'), text)
    }

    const rows = Object.fromEntries((deriveSkillCatalog(dir)?.skills ?? []).map(row => [row.name, row]))

    expect(rows['block-list'].platforms).toEqual(['linux'])
    expect(hiddenOn(rows['block-list'].platforms, ['macos'])).toEqual(['macos'])
    expect(rows['block-tags'].tags).toEqual(['a', 'b'])
    expect(rows['bom-file'].description).toBe('Use when the file has a BOM. More.')
    expect(rows['folded-desc'].description).toBe('Use when the description is folded. More.')
    expect(rows['json-escape'].description).toBe('Use when A escapes appear. More.')
    expect(Object.values(rows).every(row => row.problem === undefined)).toBe(true)

    // The build-time guard still names every one of them (house style: one plain line per key).
    const run = spawnSync(process.execPath, [GENERATOR, '--check', '--dir', dir], { encoding: 'utf8' })

    expect(run.status).toBe(1)

    for (const name of Object.keys(R4_FIXTURES).filter(name => name !== 'plain-ok')) {
      expect(run.stdout + run.stderr).toContain(`${name}: `)
    }
  })

  it.skipIf(!existsSync(HERMES_PYTHON))(
    'every fixture parses to what Hermes parse_frontmatter (full YAML) reads',
    async () => {
      const { parseFrontmatter } = (await import(GENERATOR)) as Generator

      const cases = [
        ...Object.values(R4_FIXTURES),
        '---\nname: a\ndescription: |\n  Line one\n    indented\n  line three\n\n\n---\n',
        '---\nname: a\ndescription: |+\n  keep\n\n---\n',
        '---\nname: a\ndescription: >\n  fold\n    more\n  back\n---\n',
        '---\nname: a\ndescription: Use when plain\n  continues here\n\n  and para.\nversion: 1.0.0\n---\n',
        '---\nname: a\ndescription: "Use \\x41 \\u00e9 \\N \\_ \\t tab \\" q"\n---\n',
        '---\nname: a\nplatforms:\n- linux\n- \'mac os\'\nmetadata:\n  hermes:\n    tags:\n      - a # c\n      - "b c"\n---\n',
        '\ufeff---\nname: a\ndescription: plain # comment\nversion: "1.0"\n---\n',
        '---\nname: a\ndescription: >2-\n    two\n   one-ish\n---\n'
      ]

      const script = [
        'import sys, json',
        `sys.path.insert(0, ${JSON.stringify(REPO)})`,
        'from agent.skill_utils import parse_frontmatter',
        'print(json.dumps([parse_frontmatter(c)[0] for c in json.loads(sys.stdin.read())], default=str))'
      ].join('\n')

      const hermes = execFileSync(HERMES_PYTHON, ['-I', '-c', script], {
        cwd: REPO,
        encoding: 'utf8',
        input: JSON.stringify(cases)
      })

      expect(cases.map(text => parseFrontmatter(text))).toEqual(JSON.parse(hermes))
    }
  )
})

// The r4 critic probe (RESUME/run/gates/R14/extra/2026-10-17_r4_yaml_drop.sh): valid YAML Hermes indexes.
const R4_FIXTURES: Record<string, string> = {
  'block-list':
    '---\nname: block-list\ndescription: Use when a block list is used. More.\nplatforms:\n  - linux\n---\n# Body\n',
  'folded-desc': '---\nname: folded-desc\ndescription: >-\n  Use when the description is folded. More.\n---\n# Body\n',
  'bom-file': '\ufeff---\nname: bom-file\ndescription: Use when the file has a BOM. More.\n---\n# Body\n',
  'block-tags':
    '---\nname: block-tags\ndescription: Use when tags are a block list. More.\nmetadata:\n  hermes:\n    tags:\n      - a\n      - b\n---\n# Body\n',
  'json-escape': '---\nname: json-escape\ndescription: "Use when \\x41 escapes appear. More."\n---\n# Body\n',
  'plain-ok': '---\nname: plain-ok\ndescription: Use when everything is plain. More.\n---\n# Body\n'
}

interface Generator {
  buildCatalog: (dir: string, upstream?: Set<string>) => { problems: string[]; skills: SkillCatalogEntry[] }
  renderFiles: (skills: SkillCatalogEntry[]) => Record<string, string>
  staleSkills: (committedJson: string, skills: SkillCatalogEntry[]) => string[]
  changeSides: (before: unknown, after: unknown) => [string, string]
  parseFrontmatter: (text: string) => Record<string, unknown>
}
