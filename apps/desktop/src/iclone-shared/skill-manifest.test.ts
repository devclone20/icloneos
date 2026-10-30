import { describe, expect, it } from 'vitest'

import { formatNeeds, parseSkillManifest, portAttribution, type SkillHost, unmetRequires } from './skill-manifest'

const valid = () => ({
  schema: 1,
  name: 'ridervoice',
  version: '1.0.0',
  source: {
    library: 'claude-code-skills',
    path: 'ridervoice',
    sha256: 'a'.repeat(64),
    ported_at: '2026-10-21T10:00:00.000Z'
  },
  requires: { os: ['macos'], bins: ['ffmpeg', 'python3'], mcp: [], paths: ['$RIDERVOICE_HOME'] },
  touches: ['X', 'Wo'],
  scrubbed: true
})

const host = (over: Partial<SkillHost> = {}): SkillHost => ({
  os: 'macos',
  hasBin: () => true,
  hasPath: () => true,
  mcp: null,
  ...over
})

describe('parseSkillManifest', () => {
  it('accepts the port tool shape', () => {
    const result = parseSkillManifest(valid(), 'ridervoice')

    expect(result.ok).toBe(true)
    expect(result.ok && result.manifest.touches).toEqual(['X', 'Wo'])
  })

  it('names every problem instead of the first one', () => {
    const result = parseSkillManifest({ ...valid(), schema: 2, version: '1.0', touches: ['Z'], scrubbed: false })

    expect(result).toEqual({
      ok: false,
      problems: [
        'schema 2 ≠ 1',
        'version is not MAJOR.MINOR.PATCH',
        'touches must be a list of R|Wp|Wo|X|N|$|M|S|I|D',
        'scrubbed is not true'
      ]
    })
  })

  it('rejects a folder/name mismatch, a bad hash, a non-list requires and a non-object', () => {
    expect(parseSkillManifest(valid(), 'other')).toMatchObject({
      ok: false,
      problems: ['name "ridervoice" differs from the folder "other"']
    })
    expect(parseSkillManifest({ ...valid(), source: { ...valid().source, sha256: 'zz' } })).toMatchObject({
      ok: false,
      problems: ['source.sha256 is not sha256 hex']
    })
    expect(parseSkillManifest({ ...valid(), requires: { os: [], bins: 'ffmpeg', mcp: [], paths: [] } })).toMatchObject({
      ok: false,
      problems: ['requires.bins is not a list of names']
    })
    expect(parseSkillManifest(null)).toEqual({ ok: false, problems: ['manifest is not an object'] })
    expect(parseSkillManifest([])).toEqual({ ok: false, problems: ['manifest is not an object'] })
  })

  it('F1: a third-party manifest (one naming an upstream) must carry a true author and a licence', () => {
    const third = {
      ...valid(),
      author: 'Rodrigo Lopes',
      license: 'MIT',
      upstream: { name: 'highermind-code-skills', url: 'https://github.com/x/y', license_file: 'LICENSE' },
      source: { ...valid().source, version: null },
      excluded: []
    }

    expect(parseSkillManifest(third, 'ridervoice').ok).toBe(true)
    expect(portAttribution(third as never)).toEqual({
      author: 'Rodrigo Lopes',
      license: 'MIT',
      upstream: 'highermind-code-skills'
    })
    expect(portAttribution(valid() as never)).toBeUndefined()

    expect(parseSkillManifest({ ...third, author: 'the owner (ported from his library)' })).toMatchObject({
      ok: false,
      problems: ['a third-party skill must name its true author (never the owner)']
    })
    expect(parseSkillManifest({ ...third, author: undefined, license: '' })).toMatchObject({
      ok: false,
      problems: [
        'license is not a name',
        'a third-party skill must name its true author (never the owner)',
        'a third-party skill must name its licence'
      ]
    })
    expect(parseSkillManifest({ ...third, upstream: {} })).toMatchObject({
      ok: false,
      problems: ['upstream names no source']
    })

    // m4: the copyright lines travel with the upstream; a waiver is a named, reasoned decision.
    expect(
      parseSkillManifest({ ...third, upstream: { ...third.upstream, copyright: ['Copyright (c) 2026 Rodrigo Lopes'] } })
        .ok
    ).toBe(true)
    expect(parseSkillManifest({ ...third, upstream: { ...third.upstream, copyright: 'Copyright' } })).toMatchObject({
      ok: false,
      problems: ['upstream.copyright is not a list of lines']
    })
    expect(parseSkillManifest({ ...valid(), waivers: [{ kept: 'Rider Voice', reason: 'his product name' }] }).ok).toBe(
      true
    )
    expect(parseSkillManifest({ ...valid(), waivers: [{ kept: 'Rider Voice' }] })).toMatchObject({
      ok: false,
      problems: ['waivers is not a list of { kept, reason }']
    })
    expect(
      parseSkillManifest({ ...valid(), excluded: 'references/x.md', source: { ...valid().source, version: 2 } })
    ).toMatchObject({
      ok: false,
      problems: ['source.version is not a string', 'excluded is not a list of paths']
    })
  })
})

describe('requires.paths alternatives (m2)', () => {
  const requires = (paths: unknown) => ({ ...valid(), requires: { ...valid().requires, paths } })

  it('a list inside paths is one need met by any of its places; a lone alternative or an empty name is refused', () => {
    expect(parseSkillManifest(requires(['~/a', ['~/new/engine', '~/old/engine']])).ok).toBe(true)
    expect(parseSkillManifest(requires([['~/only-one']]))).toMatchObject({
      ok: false,
      problems: ['requires.paths is not a list of places (or of two or more alternative places)']
    })
    expect(parseSkillManifest(requires(['~/a', ['~/b', '']]))).toMatchObject({ ok: false })
  })

  it('met when any alternative exists; named once, with every alternative, when none does', () => {
    const paths = ['~/a', ['~/new/engine', '~/old/engine']]
    const some = host({ hasPath: p => p === '~/a' || p === '~/old/engine' })

    expect(unmetRequires({ ...valid().requires, paths }, some)).toEqual([])
    expect(unmetRequires({ ...valid().requires, paths }, host({ hasPath: p => p === '~/a' }))).toEqual([
      { kind: 'path', name: '~/new/engine or ~/old/engine' }
    ])
  })
})

describe('unmetRequires', () => {
  it('is empty when the host has everything', () => {
    expect(unmetRequires(valid().requires, host())).toEqual([])
  })

  it('names the missing bin and path, in manifest order', () => {
    const needs = unmetRequires(valid().requires, host({ hasBin: name => name !== 'ffmpeg', hasPath: () => false }))

    expect(needs).toEqual([
      { kind: 'bin', name: 'ffmpeg' },
      { kind: 'path', name: '$RIDERVOICE_HOME' }
    ])
  })

  it('an OS the skill does not run on is one need; [] means any OS', () => {
    expect(unmetRequires(valid().requires, host({ os: 'linux' }))).toEqual([{ kind: 'os', name: 'macos' }])
    expect(unmetRequires({ ...valid().requires, os: [] }, host({ os: 'linux' }))).toEqual([])
  })

  it('an MCP server is reported unless the host can see it', () => {
    const requires = { ...valid().requires, mcp: ['davinci-resolve'] }

    expect(unmetRequires(requires, host())).toEqual([{ kind: 'mcp', name: 'davinci-resolve' }])
    expect(unmetRequires(requires, host({ mcp: new Set(['davinci-resolve']) }))).toEqual([])
    expect(unmetRequires(requires, host({ mcp: new Set(['other']) }))).toEqual([
      { kind: 'mcp', name: 'davinci-resolve' }
    ])
  })
})

describe('formatNeeds', () => {
  it('reads as one clause of names', () => {
    expect(
      formatNeeds([
        { kind: 'os', name: 'macos' },
        { kind: 'bin', name: 'ffmpeg' },
        { kind: 'mcp', name: 'davinci-resolve' },
        { kind: 'path', name: '~/Movies' }
      ])
    ).toBe('macos only, ffmpeg, MCP davinci-resolve, ~/Movies')
    expect(formatNeeds([])).toBe('')
  })
})
