// V3-B — the host evaluation of a ported skill's manifest, on fixtures and on the real bundle (B4, B5).
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  attachSkillRequirements,
  expandPlace,
  hostPathEntries,
  readSkillManifest,
  realSkillHost
} from './iclone-skill-requires'
import { readSkillCatalog } from './iclone-skills'
import { deriveSkillCatalog } from './iclone-skills-catalog'

const BUNDLE = path.resolve(__dirname, '..', '..', '..', 'iclone', 'skills')

/** The scope set the contract names (§0: 15). */
const PORT_NAMES = [
  'parrallello',
  'fable-orchestrator',
  'camera-and-action',
  'videoediting',
  'ridervoice',
  'higgsfield-blender',
  'inft',
  'davinci-resolve',
  'spec-driven',
  'hm-deploy',
  'hm-designer',
  'hm-engineer',
  'hm-init',
  'hm-qa',
  'hm-security'
]

const tmp = () => mkdtempSync(path.join(tmpdir(), 'v3b-req-'))

function skill(root: string, name: string, manifest?: unknown, description = `Use when ${name}.`) {
  mkdirSync(path.join(root, name), { recursive: true })
  writeFileSync(
    path.join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "${description}"\nversion: 1.0.0\n---\n# ${name}\n`
  )

  if (manifest !== undefined) {
    writeFileSync(
      path.join(root, name, 'manifest.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
    )
  }
}

const manifestOf = (
  name: string,
  requires = { os: [] as string[], bins: [] as string[], mcp: [] as string[], paths: [] as string[] }
) => ({
  schema: 1,
  name,
  version: '1.0.0',
  source: { library: 'claude-code-skills', path: name, sha256: 'b'.repeat(64), ported_at: '2026-10-21T10:00:00.000Z' },
  requires,
  touches: ['X'],
  scrubbed: true
})

describe('readSkillManifest', () => {
  it('null without a manifest; problems for bad JSON or a bad schema; the manifest otherwise', () => {
    const root = tmp()
    skill(root, 'plain')
    skill(root, 'broken', '{not json')
    skill(root, 'wrong', { schema: 1 })
    skill(root, 'good', manifestOf('good'))

    expect(readSkillManifest(path.join(root, 'plain'))).toBeNull()
    expect(readSkillManifest(path.join(root, 'broken'))).toEqual({ problems: ['manifest.json is not JSON'] })
    expect(readSkillManifest(path.join(root, 'wrong'))).toMatchObject({
      problems: expect.arrayContaining(['version is not MAJOR.MINOR.PATCH'])
    })
    expect(readSkillManifest(path.join(root, 'good'))).toMatchObject({ manifest: { name: 'good', version: '1.0.0' } })
  })
})

describe('realSkillHost', () => {
  it('finds a binary on the given PATH only when it is an executable file; ~ paths expand to the given home', () => {
    const bin = tmp()
    const home = tmp()
    writeFileSync(path.join(bin, 'ffmpeg'), '#!/bin/sh\n')
    chmodSync(path.join(bin, 'ffmpeg'), 0o755)
    writeFileSync(path.join(bin, 'notexec'), '')
    mkdirSync(path.join(home, 'voice-model'), { recursive: true })
    mkdirSync(path.join(home, 'Movies'), { recursive: true })

    const host = realSkillHost({
      env: { PATH: bin, RIDERVOICE_HOME: path.join(home, 'voice-model') },
      platform: 'darwin',
      home
    })

    expect(host.os).toBe('macos')
    expect(host.hasBin('ffmpeg')).toBe(true)
    expect(host.hasBin('notexec')).toBe(false)
    expect(host.hasBin('nothere')).toBe(false)
    expect(host.hasBin('../ffmpeg')).toBe(false)
    expect(host.hasPath('$RIDERVOICE_HOME')).toBe(true)
    // Both branches of expandPlace need a case that PASSES: a ~ path that resolves AND a $VAR that resolves.
    // With only the negative ~ case below, a hygiene pass turned the ~ branch into `return null` undetected.
    expect(host.hasPath('~/Movies')).toBe(true)
    expect(host.hasPath('~/.missing')).toBe(false)
    expect(host.hasPath('relative/path')).toBe(false)
    expect(host.mcp).toBeNull()
  })

  it('K140 r2: a named place ($NAME, $NAME/…) is met only when the host sets NAME to an absolute folder that exists', () => {
    const home = tmp()
    const engine = tmp()
    mkdirSync(path.join(engine, 'engine'))

    const host = realSkillHost({
      env: {
        PATH: '',
        RIDERVOICE_DIR: engine,
        EMPTY_DIR: '',
        RELATIVE_DIR: 'rel/dir',
        GONE_DIR: path.join(engine, 'x')
      },
      platform: 'darwin',
      home
    })

    expect(host.hasPath('$RIDERVOICE_DIR')).toBe(true)
    expect(host.hasPath('$RIDERVOICE_DIR/engine')).toBe(true)
    expect(host.hasPath('$RIDERVOICE_DIR/missing')).toBe(false)
    expect(host.hasPath('$UNSET_DIR')).toBe(false)
    expect(host.hasPath('$EMPTY_DIR')).toBe(false)
    expect(host.hasPath('$RELATIVE_DIR')).toBe(false)
    expect(host.hasPath('$GONE_DIR')).toBe(false)
    expect(expandPlace('$RIDERVOICE_DIR/a', { home, env: { RIDERVOICE_DIR: '/x' } })).toBe('/x/a')
    expect(expandPlace('$1BAD', { home, env: {} })).toBe('$1BAD')
  })

  it('the PATH it searches is the process PATH plus the sane POSIX entries, deduplicated', () => {
    const entries = hostPathEntries({ PATH: '/opt/homebrew/bin:/x/bin' }, 'darwin')

    expect(entries[0]).toBe('/opt/homebrew/bin')
    expect(entries).toContain('/x/bin')
    expect(entries).toContain('/usr/bin')
    expect(entries.filter(entry => entry === '/opt/homebrew/bin')).toHaveLength(1)
    expect(hostPathEntries({ PATH: 'C:\\x;C:\\y' }, 'win32')).toEqual(['C:\\x', 'C:\\y'])
  })
})

describe('attachSkillRequirements', () => {
  it('attaches port facts and the unmet needs; a row without a manifest is untouched; a bad manifest is named', () => {
    const root = tmp()
    skill(root, 'plain')
    skill(
      root,
      'ported',
      manifestOf('ported', { os: ['macos'], bins: ['ffmpeg', 'ghost'], mcp: ['resolve'], paths: ['~/x'] })
    )
    skill(root, 'bad', { schema: 1 })
    skill(root, 'third', {
      ...manifestOf('third'),
      author: 'Rodrigo Lopes',
      license: 'MIT',
      upstream: { name: 'highermind-code-skills', license_file: 'LICENSE' }
    })
    skill(root, 'mislabelled', {
      ...manifestOf('mislabelled'),
      author: 'the owner (ported from his library)',
      upstream: { name: 'somewhere' }
    })

    const catalog = attachSkillRequirements(deriveSkillCatalog(root)!, root, {
      os: 'macos',
      hasBin: name => name === 'ffmpeg',
      hasPath: () => false,
      mcp: null
    })

    const rows = Object.fromEntries(catalog.skills.map(row => [row.name, row]))

    expect(rows.plain).not.toHaveProperty('port')
    expect(rows.bad.manifestProblem).toContain('version is not MAJOR.MINOR.PATCH')
    // F1: the attribution rides on the port facts; a third-party manifest claiming the owner is a named problem.
    expect(rows.third.port?.attribution).toEqual({
      author: 'Rodrigo Lopes',
      license: 'MIT',
      upstream: 'highermind-code-skills'
    })
    expect(rows.ported.port?.attribution).toBeUndefined()
    expect(rows.mislabelled.manifestProblem).toContain('true author (never the owner)')
    expect(rows.ported.port).toEqual({
      version: '1.0.0',
      portedAt: '2026-10-21T10:00:00.000Z',
      requires: { os: ['macos'], bins: ['ffmpeg', 'ghost'], mcp: ['resolve'], paths: ['~/x'] },
      touches: ['X'],
      needs: [
        { kind: 'bin', name: 'ghost' },
        { kind: 'mcp', name: 'resolve' },
        { kind: 'path', name: '~/x' }
      ]
    })
  })
})

describe('the real bundle (B4/B5)', () => {
  it('readSkillCatalog lists all 15 ported skills with a valid manifest, needs evaluated, on a host whose HOME is empty', () => {
    const emptyHome = tmp()

    const catalog = readSkillCatalog(
      BUNDLE,
      'darwin',
      realSkillHost({ env: { PATH: '' }, platform: 'darwin', home: emptyHome })
    )

    expect(catalog).not.toBeNull()

    const ported = catalog!.skills.filter(row => row.port)

    expect(ported.map(row => row.name).sort()).toEqual([...PORT_NAMES].sort())
    expect(catalog!.skills.filter(row => row.manifestProblem)).toEqual([])

    for (const row of ported) {
      expect(row.port!.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(row.problem).toBeUndefined()
    }

    // Machine-bound skills name what this empty host lacks instead of hiding; the pure-method ones run anywhere.
    const needsOf = (name: string) =>
      ported.find(row => row.name === name)!.port!.needs.map(need => `${need.kind}:${need.name}`)

    expect(needsOf('ridervoice')).toEqual(expect.arrayContaining(['path:$RIDERVOICE_HOME', 'path:$F5TTS_VENV']))
    expect(needsOf('davinci-resolve')).toEqual(expect.arrayContaining(['mcp:davinci-resolve']))
    expect(needsOf('hm-designer')).toEqual([])

    // F6: the engine roots the tool scripts cd into are declared, so an empty host says "needs …" before a run.
    // K140 r2: they are named places now (a variable the host sets), never the owner's folder layout.
    expect(needsOf('ridervoice')).toEqual(
      expect.arrayContaining([
        'path:$RIDERVOICE_DIR',
        'path:$RIDERVOICE_SUBTITLES_DIR',
        'path:$RIDERVOICE_PIPELINE_DIR'
      ])
    )
    expect(needsOf('videoediting')).toContain('path:$VIDEOEDITING_PIPELINE_DIR')
    // K140 r4: the engine's variable carries no name of the owner's either.
    expect(needsOf('higgsfield-blender')).toContain('path:$VIDEO_ENGINE_DIR')
    expect(needsOf('davinci-resolve')).toEqual(expect.arrayContaining(['path:~/Movies/ResolveBridge']))
    expect(ported.flatMap(row => row.port!.needs.map(need => need.name)).join('\n')).not.toMatch(/Desktop|Developer/)

    // F3: the one skill whose text says it spends credits carries `$`.
    expect(ported.find(row => row.name === 'higgsfield-blender')!.port!.touches).toContain('$')

    // F1: the six highermind skills are third-party work and say so; the owner's own carry no attribution.
    for (const name of ['hm-deploy', 'hm-designer', 'hm-engineer', 'hm-init', 'hm-qa', 'hm-security']) {
      expect(ported.find(row => row.name === name)!.port!.attribution).toEqual({
        author: 'Rodrigo Lopes',
        license: 'MIT',
        upstream: 'highermind-code-skills'
      })
    }

    expect(ported.find(row => row.name === 'ridervoice')!.port!.attribution).toBeUndefined()
    // I4: the catalog row keeps the owner's own version number; the port version lives on the port facts.
    expect(catalog!.skills.find(row => row.name === 'ridervoice')!.version).toBe('1.5')
  })

  it('no ported skill is hidden from an OS by `platforms` (the manifest carries the OS requirement instead)', () => {
    const catalog = deriveSkillCatalog(BUNDLE)!

    for (const name of PORT_NAMES) {
      expect(catalog.skills.find(row => row.name === name)!.platforms).toEqual([])
    }
  })
})
