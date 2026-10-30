import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { paySpawn, setSpawnSeed } from './ipc'
import {
  foldedCollisions,
  installerConfigTemplate,
  minimalConfig,
  seedAllShippedDisabled,
  seedShippedDisabled,
  SHIPPED_DISABLED,
  watchHermesProfiles,
  withDisabledSkill
} from './skill-defaults'

const BUNDLE = path.resolve(__dirname, '../../../../iclone/skills')
// The runtime's own config template: what `install.sh --stage config` copies (the tarball carries this very file).
const REPO_TEMPLATE = path.resolve(__dirname, '../../../../cli-config.yaml.example')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function home(config?: string): { configFile: string; markerFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3jsk-'))

  dirs.push(dir)

  const configFile = path.join(dir, 'hermes', 'config.yaml')

  if (config !== undefined) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.writeFileSync(configFile, config, { mode: 0o640 })
  }

  return { configFile, markerFile: path.join(dir, 'ud', 'payments', 'skills-seeded.json') }
}

describe('agentcard-disabled: the shapes Hermes writes, edited narrowly', () => {
  const cases: [string, string, string][] = [
    ['no file content', '', 'skills:\n  disabled:\n  - agentcard\n'],
    ['no skills block', 'model:\n  default: x\n', 'model:\n  default: x\nskills:\n  disabled:\n  - agentcard\n'],
    ['no trailing newline', 'model: x', 'model: x\nskills:\n  disabled:\n  - agentcard\n'],
    ['inline empty mapping', 'skills: {}\nmodel: x\n', 'skills:\n  disabled:\n  - agentcard\nmodel: x\n'],
    [
      'a skills block without disabled',
      'skills:\n  external_dirs:\n  - /x\nmodel: x\n',
      'skills:\n  disabled:\n  - agentcard\n  external_dirs:\n  - /x\nmodel: x\n'
    ],
    [
      'an indentless list (PyYAML default)',
      'skills:\n  disabled:\n  - foo\n  - bar\nmodel: x\n',
      'skills:\n  disabled:\n  - foo\n  - bar\n  - agentcard\nmodel: x\n'
    ],
    [
      'an indented list',
      'skills:\n    disabled:\n        - foo\nmodel: x\n',
      'skills:\n    disabled:\n        - foo\n        - agentcard\nmodel: x\n'
    ],
    ['an empty flow list', 'skills:\n  disabled: []\n', 'skills:\n  disabled:\n  - agentcard\n'],
    ['a flow list', 'skills:\n  disabled: [foo, "bar"]\n', 'skills:\n  disabled:\n  - foo\n  - bar\n  - agentcard\n'],
    ['an empty block key', 'skills:\n  disabled:\n  other: 1\n', 'skills:\n  disabled:\n  - agentcard\n  other: 1\n']
  ]

  it.each(cases)('agentcard-disabled: %s', (_name, before, after) => {
    expect(withDisabledSkill(before, 'agentcard')).toBe(after)
    // Idempotent: a second pass changes nothing.
    expect(withDisabledSkill(after, 'agentcard')).toBe(after)
  })

  it('agentcard-disabled: a name already there (block, flow, quoted) leaves the text as it is', () => {
    for (const text of [
      'skills:\n  disabled:\n  - agentcard\n',
      "skills:\n  disabled:\n  - 'agentcard'\n",
      'skills:\n  disabled: [x, agentcard]\n'
    ]) {
      expect(withDisabledSkill(text, 'agentcard')).toBe(text)
    }
  })

  it('agentcard-disabled: a shape it does not understand is left alone (null), never guessed at', () => {
    for (const text of [
      'skills:\n  disabled: agentcard-cli\n',
      'skills: whatever\n',
      'skills : {}\n',
      'skills: {}\n  disabled: []\n'
    ]) {
      expect(withDisabledSkill(text, 'agentcard'), text).toBeNull()
    }

    expect(withDisabledSkill('', 'Agent Card')).toBeNull()
  })
})

describe('agentcard-disabled: seeded once per install; the user’s later choice stands', () => {
  it('agentcard-disabled: adds the name, keeps the file’s mode, records it 0600; a second launch changes nothing', () => {
    const paths = home('model:\n  default: x\n')
    const first = seedShippedDisabled({ ...paths, now: () => new Date('2026-10-21T10:00:00Z') })

    expect(first).toMatchObject({ created: false, seeded: ['agentcard'], kept: [], skipped: null })
    expect(fs.readFileSync(paths.configFile, 'utf8')).toBe(
      'model:\n  default: x\nskills:\n  disabled:\n  - agentcard\n'
    )
    expect(fs.statSync(paths.configFile).mode & 0o777).toBe(0o640)
    expect(fs.statSync(paths.markerFile).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(paths.markerFile, 'utf8'))).toMatchObject({
      v: 2,
      configs: { [paths.configFile]: { skills: { agentcard: '2026-10-21T10:00:00.000Z' } } }
    })

    // The user turns it on (the Skills page removes it from the list): the next launch leaves that alone.
    fs.writeFileSync(paths.configFile, 'model:\n  default: x\nskills:\n  disabled: []\n')
    expect(seedShippedDisabled(paths)).toMatchObject({ seeded: [], kept: ['agentcard'], skipped: null })
    expect(fs.readFileSync(paths.configFile, 'utf8')).toBe('model:\n  default: x\nskills:\n  disabled: []\n')
  })

  it('agentcard-disabled: a shape not understood ⇒ nothing written, no marker, tried again next pass', () => {
    const odd = home('skills:\n  disabled: agentcard-cli\n')

    expect(seedShippedDisabled(odd).skipped).toMatch(/not understood/)
    expect(fs.readFileSync(odd.configFile, 'utf8')).toBe('skills:\n  disabled: agentcard-cli\n')
    expect(fs.existsSync(odd.markerFile)).toBe(false)
  })

  it('agentcard-disabled: the list is exactly the bundled skills whose metadata touches $ and says shipped disabled', () => {
    // A ported skill carries manifest.json; a vendored one (agentcard) carries VENDORED.json. Either may say it.
    const metaOf = (name: string): { touches?: string[]; shipped?: string } | null => {
      for (const file of ['manifest.json', 'VENDORED.json']) {
        const at = path.join(BUNDLE, name, file)

        if (fs.existsSync(at)) {
          const meta = JSON.parse(fs.readFileSync(at, 'utf8')) as { touches?: string[]; shipped?: string }

          if (meta.shipped !== undefined) {
            return meta
          }
        }
      }

      return null
    }

    const shipped = fs.readdirSync(BUNDLE).filter(name => metaOf(name)?.shipped === 'disabled')

    expect(shipped.sort()).toEqual([...SHIPPED_DISABLED].sort())

    for (const name of SHIPPED_DISABLED) {
      expect(metaOf(name)?.touches).toContain('$')
    }
  })
})

/** A throwaway Hermes home: `files` maps a relative path to its text (a trailing `/` makes a folder). */
function hermesHomeWith(files: Record<string, string> = {}): { hermesHome: string; markerFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3jsk-all-'))

  dirs.push(dir)

  const hermesHome = path.join(dir, 'hermes')

  for (const [rel, text] of Object.entries(files)) {
    const at = path.join(hermesHome, rel)

    if (rel.endsWith('/')) {
      fs.mkdirSync(at, { recursive: true })
    } else {
      fs.mkdirSync(path.dirname(at), { recursive: true })
      fs.writeFileSync(at, text, { mode: 0o640 })
    }
  }

  return { hermesHome, markerFile: path.join(dir, 'ud', 'payments', 'skills-seeded.json') }
}

const MINIMAL = 'skills:\n  disabled:\n  - agentcard\n'
const read = (file: string) => fs.readFileSync(file, 'utf8')
const modeOf = (file: string) => fs.statSync(file).mode & 0o777

describe('agentcard-disabled: first launch (fix JM1) — a missing config is created, never left missing', () => {
  it('agentcard-disabled: JM1 (critic RULING-A): no config.yaml ⇒ the FIRST pass writes it 0600 with exactly the block, and the marker', () => {
    const hh = fs.mkdtempSync(path.join(os.tmpdir(), 'v3jsk-hh-'))
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v3jsk-ud-')), 'skills-seeded.json')

    dirs.push(hh, path.dirname(marker))

    const configFile = path.join(hh, 'config.yaml')
    const first = seedShippedDisabled({ configFile, markerFile: marker, now: () => new Date('2026-10-21T10:00:00Z') })

    expect(first).toEqual({ configFile, created: true, seeded: ['agentcard'], kept: [], skipped: null })
    expect(read(configFile)).toBe(MINIMAL)
    expect(read(configFile)).toBe(minimalConfig(SHIPPED_DISABLED))
    expect(modeOf(configFile)).toBe(0o600)
    expect(modeOf(marker)).toBe(0o600)
    // The very first session reads agentcard as disabled: the text already holds it (the editor finds nothing to add).
    expect(withDisabledSkill(read(configFile), 'agentcard')).toBe(read(configFile))

    // Hermes later rewrites the file with its own keys and keeps the block: the second pass changes nothing.
    fs.writeFileSync(configFile, `model:\n  default: x\n${MINIMAL}`)
    expect(seedShippedDisabled({ configFile, markerFile: marker })).toMatchObject({
      created: false,
      seeded: [],
      kept: ['agentcard']
    })
    expect(read(configFile)).toBe(`model:\n  default: x\n${MINIMAL}`)
  })

  it('agentcard-disabled: the root home and every profile — created when missing, edited when present, only real profile folders', () => {
    const { hermesHome, markerFile } = hermesHomeWith({
      'profiles/inft-alpha-1/': '',
      'profiles/inft-beta-2/config.yaml': 'model:\n  default: y\n',
      'profiles/Not A Profile/': '',
      'profiles/.trash/': '',
      'profiles/notes.txt': 'x'
    })

    fs.symlinkSync(path.join(hermesHome, 'profiles', 'inft-alpha-1'), path.join(hermesHome, 'profiles', 'linked'))

    const { configs, markerError } = seedAllShippedDisabled({ hermesHome, markerFile })
    const byRel = Object.fromEntries(configs.map(r => [path.relative(hermesHome, r.configFile), r]))

    expect(markerError).toBeNull()
    expect(Object.keys(byRel)).toEqual([
      'config.yaml',
      'profiles/inft-alpha-1/config.yaml',
      'profiles/inft-beta-2/config.yaml'
    ])
    expect(byRel['config.yaml']).toMatchObject({ created: true, seeded: ['agentcard'] })
    expect(byRel['profiles/inft-alpha-1/config.yaml']).toMatchObject({ created: true, seeded: ['agentcard'] })
    expect(byRel['profiles/inft-beta-2/config.yaml']).toMatchObject({ created: false, seeded: ['agentcard'] })
    expect(read(path.join(hermesHome, 'config.yaml'))).toBe(MINIMAL)
    expect(read(path.join(hermesHome, 'profiles/inft-alpha-1/config.yaml'))).toBe(MINIMAL)
    expect(read(path.join(hermesHome, 'profiles/inft-beta-2/config.yaml'))).toBe(`model:\n  default: y\n${MINIMAL}`)
    expect(modeOf(path.join(hermesHome, 'profiles/inft-beta-2/config.yaml'))).toBe(0o640)
    expect(fs.existsSync(path.join(hermesHome, 'profiles/Not A Profile/config.yaml'))).toBe(false)
    expect(fs.existsSync(path.join(hermesHome, 'profiles/.trash/config.yaml'))).toBe(false)

    // A second pass: nothing new, nothing rewritten.
    const again = seedAllShippedDisabled({ hermesHome, markerFile })

    expect(again.configs.every(r => !r.created && r.seeded.length === 0 && r.kept.includes('agentcard'))).toBe(true)
  })

  it('agentcard-disabled: a missing Hermes home is created 0700 with its config; a profile folder is never created', () => {
    const { hermesHome, markerFile } = hermesHomeWith()

    expect(fs.existsSync(hermesHome)).toBe(false)

    const { configs } = seedAllShippedDisabled({ hermesHome, markerFile })

    expect(configs).toHaveLength(1)
    expect(modeOf(hermesHome)).toBe(0o700)
    expect(read(path.join(hermesHome, 'config.yaml'))).toBe(MINIMAL)
    expect(fs.existsSync(path.join(hermesHome, 'profiles'))).toBe(false)
  })

  it('agentcard-disabled: the user’s later choice stands per config; a deleted config or a re-created profile is new', () => {
    const { hermesHome, markerFile } = hermesHomeWith({ 'profiles/inft-alpha-1/config.yaml': 'model: x\n' })

    seedAllShippedDisabled({ hermesHome, markerFile })

    const root = path.join(hermesHome, 'config.yaml')
    const profile = path.join(hermesHome, 'profiles/inft-alpha-1/config.yaml')

    // The user turns agentcard on in both (the Skills page empties the list): the next passes leave that alone.
    fs.writeFileSync(root, 'skills:\n  disabled: []\n')
    fs.writeFileSync(profile, 'model: x\nskills:\n  disabled: []\n')
    seedAllShippedDisabled({ hermesHome, markerFile })
    expect(read(root)).toBe('skills:\n  disabled: []\n')
    expect(read(profile)).toBe('model: x\nskills:\n  disabled: []\n')

    // The profile is deleted and created again under the same name (a new folder), with a config: seeded again.
    fs.rmSync(path.dirname(profile), { recursive: true })
    fs.mkdirSync(path.dirname(profile))
    fs.writeFileSync(profile, 'model: z\n')
    seedAllShippedDisabled({ hermesHome, markerFile })
    expect(read(profile)).toBe(`model: z\n${MINIMAL}`)

    // The root config is deleted: no choice is recorded anywhere any more, so the shipped default is written again.
    fs.rmSync(root)
    expect(seedAllShippedDisabled({ hermesHome, markerFile }).configs[0]).toMatchObject({ created: true })
    expect(read(root)).toBe(MINIMAL)
  })

  it('agentcard-disabled: a config the user wrote is never replaced — an odd shape stays byte for byte, a comment survives', () => {
    const { hermesHome, markerFile } = hermesHomeWith({
      'config.yaml': '# mine\nskills:\n  disabled: agentcard-cli\n',
      'profiles/inft-alpha-1/config.yaml': '# keep this comment\nmodel: x\n'
    })

    const { configs } = seedAllShippedDisabled({ hermesHome, markerFile })

    expect(configs[0].skipped).toMatch(/not understood/)
    expect(read(path.join(hermesHome, 'config.yaml'))).toBe('# mine\nskills:\n  disabled: agentcard-cli\n')
    expect(read(path.join(hermesHome, 'profiles/inft-alpha-1/config.yaml'))).toBe(
      `# keep this comment\nmodel: x\n${MINIMAL}`
    )
  })

  it('agentcard-disabled: the first marker shape ({name: stamp}) is read as the root config’s record', () => {
    const { hermesHome, markerFile } = hermesHomeWith({ 'config.yaml': 'skills:\n  disabled: []\n' })

    fs.mkdirSync(path.dirname(markerFile), { recursive: true })
    fs.writeFileSync(markerFile, JSON.stringify({ agentcard: '2026-10-20T00:00:00.000Z' }))

    expect(seedAllShippedDisabled({ hermesHome, markerFile }).configs[0]).toMatchObject({
      seeded: [],
      kept: ['agentcard']
    })
    expect(read(path.join(hermesHome, 'config.yaml'))).toBe('skills:\n  disabled: []\n')
  })

  it('agentcard-disabled: every Hermes spawn runs the seed first, with or without a pay socket', () => {
    const { hermesHome, markerFile } = hermesHomeWith({ 'config.yaml': 'model: x\n' })

    seedAllShippedDisabled({ hermesHome, markerFile })
    fs.mkdirSync(path.join(hermesHome, 'profiles', 'inft-new-3'), { recursive: true })
    setSpawnSeed(() => seedAllShippedDisabled({ hermesHome, markerFile }))

    try {
      expect(paySpawn('inft-new-3').env).toEqual({})
      expect(read(path.join(hermesHome, 'profiles/inft-new-3/config.yaml'))).toBe(MINIMAL)

      // A seed that throws never stops the spawn.
      setSpawnSeed(() => {
        throw new Error('boom')
      })
      expect(() => paySpawn('inft-new-3')).not.toThrow()
    } finally {
      setSpawnSeed(null)
    }
  })

  it('agentcard-disabled: a profile folder that appears is seeded by the watch (profiles/ created later too)', async () => {
    const { hermesHome, markerFile } = hermesHomeWith({ 'config.yaml': MINIMAL })
    let passes = 0

    const stop = watchHermesProfiles(
      hermesHome,
      () => {
        passes += 1
        seedAllShippedDisabled({ hermesHome, markerFile })
      },
      20
    )

    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }

    try {
      // The watch arms (its own first pass), then profiles/ appears and is watched in turn.
      await until(() => passes > 0)
      await new Promise(resolve => setTimeout(resolve, 300))
      fs.mkdirSync(path.join(hermesHome, 'profiles'))
      await until(() => passes > 1)
      await new Promise(resolve => setTimeout(resolve, 300))
      fs.mkdirSync(path.join(hermesHome, 'profiles', 'inft-late-4'))

      const created = path.join(hermesHome, 'profiles/inft-late-4/config.yaml')

      await until(() => fs.existsSync(created))
      expect(read(created)).toBe(MINIMAL)
    } finally {
      stop()
    }
  })
})

describe('agentcard-disabled: the installer’s config template is never pre-empted (fix m-r2-1)', () => {
  /** An active Hermes root holding the runtime's template, as the repository stage leaves it. */
  function activeRootWithTemplate(text = read(REPO_TEMPLATE)): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3jsk-root-'))

    dirs.push(root)
    fs.writeFileSync(installerConfigTemplate(root), text)

    return root
  }

  /** `seeded` is `template` with exactly the two block lines added right under `skills:`, nothing else changed. */
  function expectTemplatePlusBlock(seeded: string, template: string) {
    const lines = seeded.split('\n')
    const at = lines.indexOf('skills:')

    expect(lines.slice(at + 1, at + 3)).toEqual(['  disabled:', '  - agentcard'])
    expect([...lines.slice(0, at + 1), ...lines.slice(at + 3)].join('\n')).toBe(template)
  }

  it('agentcard-disabled: m-r2-1 the installer’s template file is the one the config stage copies (`--dir` root)', () => {
    expect(installerConfigTemplate('/x/hermes-agent')).toBe('/x/hermes-agent/cli-config.yaml.example')
    expect(fs.existsSync(REPO_TEMPLATE)).toBe(true)
    expect(read(REPO_TEMPLATE)).toMatch(/^ {2}max_turns: 500$/m)
  })

  it('agentcard-disabled: m-r2-1 a missing root config is the installer’s template plus the block, byte for byte', () => {
    const template = read(REPO_TEMPLATE)
    const activeRoot = activeRootWithTemplate()
    const { hermesHome, markerFile } = hermesHomeWith({ 'profiles/inft-alpha-1/': '' })

    for (const rootWithoutTemplate of ['wait', 'create'] as const) {
      fs.rmSync(path.join(hermesHome, 'config.yaml'), { force: true })

      const { configs } = seedAllShippedDisabled({
        hermesHome,
        markerFile,
        template: installerConfigTemplate(activeRoot),
        rootWithoutTemplate
      })

      expect(configs[0]).toMatchObject({ created: true, seeded: ['agentcard'], skipped: null })
      expectTemplatePlusBlock(read(path.join(hermesHome, 'config.yaml')), template)
      expect(modeOf(path.join(hermesHome, 'config.yaml'))).toBe(0o600)
    }

    // A profile without a config still gets the bare block (Hermes reads a profile without one as its defaults).
    expect(read(path.join(hermesHome, 'profiles/inft-alpha-1/config.yaml'))).toBe(MINIMAL)
  })

  it('agentcard-disabled: m-r2-1 with no template yet the launch and profile passes leave the root to the installer; the next pass edits its copy', () => {
    const template = read(REPO_TEMPLATE)
    const activeRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v3jsk-fresh-')), 'hermes-agent')
    const { hermesHome, markerFile } = hermesHomeWith({ 'profiles/inft-alpha-1/': '' })
    const rootConfig = path.join(hermesHome, 'config.yaml')

    dirs.push(path.dirname(activeRoot))

    const launch = seedAllShippedDisabled({
      hermesHome,
      markerFile,
      template: installerConfigTemplate(activeRoot),
      rootWithoutTemplate: 'wait'
    })

    expect(launch.configs[0]).toMatchObject({ created: false, seeded: [], skipped: expect.stringMatching(/installer/) })
    expect(fs.existsSync(rootConfig)).toBe(false)
    expect(read(path.join(hermesHome, 'profiles/inft-alpha-1/config.yaml'))).toBe(MINIMAL)

    // The installer's config stage: `cp "$INSTALL_DIR/cli-config.yaml.example" "$HERMES_HOME/config.yaml"` (no config).
    fs.copyFileSync(REPO_TEMPLATE, rootConfig)

    const spawn = seedAllShippedDisabled({ hermesHome, markerFile, template: installerConfigTemplate(activeRoot) })

    expect(spawn.configs[0]).toMatchObject({ created: false, seeded: ['agentcard'], skipped: null })
    expectTemplatePlusBlock(read(rootConfig), template)
  })

  it('agentcard-disabled: m-r2-1 only the spawn pass creates the bare block when there is no template to read', () => {
    const { hermesHome, markerFile } = hermesHomeWith()
    const rootConfig = path.join(hermesHome, 'config.yaml')
    // A template whose skills block the edit does not understand counts as no template: never guessed at.
    const odd = activeRootWithTemplate('model: x\nskills: [a]\n')

    for (const template of [null, installerConfigTemplate(odd)]) {
      expect(
        seedAllShippedDisabled({ hermesHome, markerFile, template, rootWithoutTemplate: 'wait' }).configs[0].skipped
      ).toMatch(/installer/)
      expect(fs.existsSync(rootConfig)).toBe(false)
      expect(
        seedAllShippedDisabled({ hermesHome, markerFile, template, rootWithoutTemplate: 'create' }).configs[0]
      ).toMatchObject({ created: true, seeded: ['agentcard'] })
      expect(read(rootConfig)).toBe(MINIMAL)
      fs.rmSync(rootConfig)
    }
  })

  it('agentcard-disabled: m-r2-1 main seeds with the installer’s template and lets only the spawn pass create the bare block', () => {
    const index = read(path.join(__dirname, 'index.ts'))

    expect(index).toContain('template: deps.hermesRoot ? installerConfigTemplate(deps.hermesRoot) : null')
    expect(index).toContain("rootWithoutTemplate: when === 'spawn' ? 'create' : 'wait'")
    expect(index).toContain("seed('launch')")
    expect(index).toContain("setSpawnSeed(() => seed('spawn'))")
  })
})

describe('agentcard-disabled: profile folders that are links (fix m-r2-2)', () => {
  it('agentcard-disabled: m-r2-2 a link inside the Hermes home is seeded where it lives; one outside is never written and is unprotected', () => {
    const { hermesHome, markerFile } = hermesHomeWith({
      'profiles/inft-alpha-1/': '',
      'kept/inft-in-5/': '',
      'kept/inft-in-mine-7/config.yaml': '# mine\n'
    })

    const outsideBase = fs.mkdtempSync(path.join(os.tmpdir(), 'v3jsk-out-'))

    dirs.push(outsideBase)
    fs.mkdirSync(path.join(outsideBase, 'inft-out-6'))
    fs.mkdirSync(path.join(outsideBase, 'inft-out-mine-8'))
    fs.writeFileSync(path.join(outsideBase, 'inft-out-mine-8', 'config.yaml'), '# theirs\n')

    const link = (name: string, target: string) => fs.symlinkSync(target, path.join(hermesHome, 'profiles', name))

    link('inft-in-5', path.join(hermesHome, 'kept', 'inft-in-5'))
    link('inft-in-mine-7', path.join(hermesHome, 'kept', 'inft-in-mine-7'))
    link('inft-out-6', path.join(outsideBase, 'inft-out-6'))
    link('inft-out-mine-8', path.join(outsideBase, 'inft-out-mine-8'))
    link('inft-gone-9', path.join(outsideBase, 'no-such-folder'))
    link('inft-alias-1', path.join(hermesHome, 'profiles', 'inft-alpha-1'))
    link('inft-home-0', hermesHome)

    const { configs, unprotected } = seedAllShippedDisabled({ hermesHome, markerFile })

    expect(unprotected).toEqual(['inft-out-6', 'inft-out-mine-8'])
    // Root, the real profile, and the two inside links (an alias of a folder already listed is that folder's config;
    // a link to the home itself is the root config).
    expect(configs).toHaveLength(4)
    expect(read(path.join(hermesHome, 'kept/inft-in-5/config.yaml'))).toBe(MINIMAL)
    expect(read(path.join(hermesHome, 'kept/inft-in-mine-7/config.yaml'))).toBe(`# mine\n${MINIMAL}`)
    expect(read(path.join(hermesHome, 'profiles/inft-alpha-1/config.yaml'))).toBe(MINIMAL)
    expect(fs.readdirSync(path.join(outsideBase, 'inft-out-6'))).toEqual([])
    expect(read(path.join(outsideBase, 'inft-out-mine-8', 'config.yaml'))).toBe('# theirs\n')
    expect(fs.existsSync(path.join(outsideBase, 'no-such-folder'))).toBe(false)
  })

  it('agentcard-disabled: m-r2-2 a profiles folder that is itself a link outside the home leaves every profile in it unprotected', () => {
    const { hermesHome, markerFile } = hermesHomeWith({ 'config.yaml': 'model: x\n' })
    const outsideBase = fs.mkdtempSync(path.join(os.tmpdir(), 'v3jsk-outp-'))

    dirs.push(outsideBase)
    fs.mkdirSync(path.join(outsideBase, 'inft-a-1'))
    fs.symlinkSync(outsideBase, path.join(hermesHome, 'profiles'))

    const { configs, unprotected } = seedAllShippedDisabled({ hermesHome, markerFile })

    expect(unprotected).toEqual(['inft-a-1'])
    expect(configs).toHaveLength(1)
    expect(fs.readdirSync(path.join(outsideBase, 'inft-a-1'))).toEqual([])
  })
})

describe('agentcard-disabled: a config.yaml that is a link (lead ruling: never write outside the Hermes home)', () => {
  it('agentcard-disabled: m-r2-2 a config.yaml linked outside the home is never edited and its profile is unprotected; inside, edited where it lives', () => {
    const { hermesHome, markerFile } = hermesHomeWith({
      'profiles/inft-out-cfg-1/': '',
      'profiles/inft-in-cfg-2/': '',
      'profiles/inft-gone-cfg-3/': '',
      'dotfiles/inft-in-cfg-2.yaml': 'model: x\n'
    })

    const outsideBase = fs.mkdtempSync(path.join(os.tmpdir(), 'v3jsk-cfg-'))

    dirs.push(outsideBase)

    const theirs = path.join(outsideBase, 'hermes.yaml')
    const theirsProfile = path.join(outsideBase, 'profile.yaml')

    fs.writeFileSync(theirs, '# theirs\nmodel: y\n')
    fs.writeFileSync(theirsProfile, '# theirs too\n')
    // The root's config and one profile's point out of the home; one profile's points inside; one points at nothing.
    fs.symlinkSync(theirs, path.join(hermesHome, 'config.yaml'))
    fs.symlinkSync(theirsProfile, path.join(hermesHome, 'profiles/inft-out-cfg-1/config.yaml'))
    fs.symlinkSync(
      path.join(hermesHome, 'dotfiles/inft-in-cfg-2.yaml'),
      path.join(hermesHome, 'profiles/inft-in-cfg-2/config.yaml')
    )
    fs.symlinkSync(
      path.join(outsideBase, 'nothing.yaml'),
      path.join(hermesHome, 'profiles/inft-gone-cfg-3/config.yaml')
    )

    for (const rootWithoutTemplate of ['create', 'wait'] as const) {
      const { configs, unprotected } = seedAllShippedDisabled({ hermesHome, markerFile, rootWithoutTemplate })

      expect(unprotected).toEqual(['default', 'inft-gone-cfg-3', 'inft-out-cfg-1'])
      expect(configs.filter(r => r.skipped?.includes('outside the Hermes home')).length).toBe(3)
      expect(read(theirs)).toBe('# theirs\nmodel: y\n')
      expect(read(theirsProfile)).toBe('# theirs too\n')
      expect(fs.existsSync(path.join(outsideBase, 'nothing.yaml'))).toBe(false)
      expect(read(path.join(hermesHome, 'dotfiles/inft-in-cfg-2.yaml'))).toBe(`model: x\n${MINIMAL}`)
      expect(fs.lstatSync(path.join(hermesHome, 'profiles/inft-in-cfg-2/config.yaml')).isSymbolicLink()).toBe(true)
    }
  })
})

describe('J4-2: never write outside the Hermes home, even when a folder is swapped between the check and the write (fix m-r3-1)', () => {
  const ORIGINAL = 'ORIGINAL OUTSIDE FILE\n'

  /** `<base>/hermes` with `profiles/p1` (a config) and `profiles/p2` (none); `<base>/outside` holds a config.yaml. */
  function raceWorld(): { base: string; hermesHome: string; outside: string; markerFile: string } {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v3jrace-')))
    const hermesHome = path.join(base, 'hermes')
    const outside = path.join(base, 'outside')

    dirs.push(base)
    fs.mkdirSync(path.join(hermesHome, 'profiles', 'p1'), { recursive: true })
    fs.mkdirSync(path.join(hermesHome, 'profiles', 'p2'))
    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), MINIMAL)
    fs.writeFileSync(path.join(hermesHome, 'profiles', 'p1', 'config.yaml'), 'model:\n  default: x\n')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'config.yaml'), ORIGINAL)

    return { base, hermesHome, outside, markerFile: path.join(base, 'marker.json') }
  }

  /** Every entry under `dir` with its bytes. */
  const tree = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .map(entry => `${entry.name}:${entry.isFile() ? read(path.join(dir, entry.name)) : '?'}`)
      .sort()

  /** The folder is moved aside and a link to `outside` takes its name: what a concurrent swapper does. */
  const swap = (folder: string, outside: string) => {
    fs.renameSync(folder, `${folder}.stash`)
    fs.symlinkSync(outside, folder)
  }

  it('J4-2: the re-check — a config.yaml link swapped to an outside file after the link check is never followed', () => {
    const { hermesHome, outside, markerFile } = raceWorld()
    const p1 = path.join(hermesHome, 'profiles', 'p1', 'config.yaml')

    fs.mkdirSync(path.join(hermesHome, 'store'))
    fs.renameSync(p1, path.join(hermesHome, 'store', 'p1.yaml'))
    fs.symlinkSync(path.join(hermesHome, 'store', 'p1.yaml'), p1)

    let swapped = 0

    const { configs, unprotected } = seedAllShippedDisabled({
      hermesHome,
      markerFile,
      seam: (at, file) => {
        if (at === 'checked' && file === p1) {
          fs.rmSync(p1)
          fs.symlinkSync(path.join(outside, 'config.yaml'), p1)
          swapped += 1
        }
      }
    })

    expect(swapped).toBe(1)
    expect(read(path.join(outside, 'config.yaml'))).toBe(ORIGINAL)
    expect(tree(outside)).toEqual([`config.yaml:${ORIGINAL}`])
    expect(unprotected).toEqual(['p1'])
    // Reported as what it is, a link out: the re-check of the resolved target, before any folder is recorded.
    expect(configs.find(r => r.configFile === p1)?.skipped).toMatch(/^config\.yaml links outside the Hermes home/)
  })

  for (const at of ['checked', 'placed', 'staged'] as const) {
    for (const kind of ['edit', 'create'] as const) {
      it(`J4-2: a profile folder swapped for an outside link at the ${at} seam (${kind}) puts no byte outside, ever, and is unprotected`, () => {
        const { hermesHome, outside, markerFile } = raceWorld()
        const profile = kind === 'edit' ? 'p1' : 'p2'
        const folder = path.join(hermesHome, 'profiles', profile)

        // A create races into an EMPTY outside folder (with a config.yaml there, the create would turn into an edit).
        if (kind === 'create') {
          fs.rmSync(path.join(outside, 'config.yaml'))
        }

        const before = tree(outside)
        const seen: string[][] = []
        let swapped = 0

        const { configs, unprotected } = seedAllShippedDisabled({
          hermesHome,
          markerFile,
          seam: (seamAt, file) => {
            if (swapped > 0) {
              seen.push(tree(outside))
            }

            if (seamAt === at && swapped === 0 && path.dirname(file) === folder) {
              swap(folder, outside)
              swapped += 1
            }
          }
        })

        expect(swapped).toBe(1)
        // At every later seam and at the end the outside folder is exactly as it was: no temp file, no edit, no create.
        expect(seen.every(state => state.join('\n') === before.join('\n'))).toBe(true)
        expect(tree(outside)).toEqual(before)
        expect(unprotected).toEqual([profile])
        expect(configs.find(r => r.configFile === path.join(folder, 'config.yaml'))?.skipped).toMatch(
          /outside the Hermes home/
        )
        // The other configs were seeded as usual.
        expect(configs.filter(r => r.skipped === null).length).toBe(2)
      })
    }
  }

  for (const kind of ['edit', 'create'] as const) {
    it(`J4-2: the publish re-check — a swap with our temp name planted outside right before the ${kind} publishes nothing there`, () => {
      const { hermesHome, outside, markerFile } = raceWorld()
      const profile = kind === 'edit' ? 'p1' : 'p2'
      const folder = path.join(hermesHome, 'profiles', profile)

      if (kind === 'create') {
        fs.rmSync(path.join(outside, 'config.yaml'))
      }

      let planted = ''

      const { unprotected } = seedAllShippedDisabled({
        hermesHome,
        markerFile,
        seam: (at, file) => {
          if (at === 'staged' && path.dirname(file) === folder && !planted) {
            swap(folder, outside)
            planted = path.join(outside, path.basename(file))
            fs.writeFileSync(planted, 'PLANTED\n')
          }
        }
      })

      expect(planted).not.toBe('')
      expect(tree(outside)).toEqual(
        [`${path.basename(planted)}:PLANTED\n`, ...(kind === 'edit' ? [`config.yaml:${ORIGINAL}`] : [])].sort()
      )
      expect(unprotected).toEqual([profile])
    })
  }

  it('J4-2: a config replaced in place between the read and the publish is not clobbered: the next pass edits it', () => {
    const { hermesHome, markerFile } = raceWorld()
    const p1 = path.join(hermesHome, 'profiles', 'p1', 'config.yaml')
    let replaced = false

    const first = seedAllShippedDisabled({
      hermesHome,
      markerFile,
      seam: (at, file) => {
        if (at === 'staged' && path.dirname(file) === path.dirname(p1) && !replaced) {
          fs.writeFileSync(`${p1}.new`, 'model:\n  default: theirs\n')
          fs.renameSync(`${p1}.new`, p1)
          replaced = true
        }
      }
    })

    expect(replaced).toBe(true)
    expect(read(p1)).toBe('model:\n  default: theirs\n')
    // Fail closed (m-r4-2): until a pass has the names in the config Hermes reads, p1 is unprotected.
    expect(first.unprotected).toEqual(['p1'])
    expect(first.verified).not.toHaveProperty('p1')
    expect(first.configs.find(r => r.configFile === p1)?.skipped).toMatch(/changed while it was edited/)

    const second = seedAllShippedDisabled({ hermesHome, markerFile })

    expect(second.configs.find(r => r.configFile === p1)?.seeded).toEqual(['agentcard'])
    expect(second.unprotected).toEqual([])
    expect(read(p1)).toBe(`model:\n  default: theirs\n${MINIMAL}`)
  })

  it('J4-2: a config hard-linked to an outside file is split by the rename: the outside file keeps its bytes', () => {
    const { hermesHome, outside, markerFile } = raceWorld()
    const p1 = path.join(hermesHome, 'profiles', 'p1', 'config.yaml')

    fs.rmSync(p1)
    fs.linkSync(path.join(outside, 'config.yaml'), p1)

    const { unprotected } = seedAllShippedDisabled({ hermesHome, markerFile })

    expect(unprotected).toEqual([])
    expect(read(path.join(outside, 'config.yaml'))).toBe(ORIGINAL)
    expect(fs.statSync(path.join(outside, 'config.yaml')).nlink).toBe(1)
    expect(read(p1)).toBe(`${ORIGINAL}${MINIMAL}`)
  })

  for (const kind of ['edit', 'create'] as const) {
    it(`m-r4-4: a folder swapped out exactly at the temp file's create and back right after leaves NOTHING outside (${kind})`, () => {
      // The critic's deterministic probe: the swap lands inside the create itself (after every check) and is undone
      // as soon as the create returns, so the temp name no longer leads to the file it made.
      const { hermesHome, outside, markerFile } = raceWorld()
      const profile = kind === 'edit' ? 'p1' : 'p2'
      const folder = path.join(hermesHome, 'profiles', profile)

      fs.rmSync(path.join(outside, 'config.yaml'))

      const realOpen = fs.openSync
      const realFstat = fs.fstatSync
      let armed = false
      let back = false

      fs.openSync = ((file: fs.PathLike, ...rest: unknown[]) => {
        if (typeof file === 'string' && file.startsWith(folder + path.sep) && file.endsWith('.tmp') && !armed) {
          armed = true
          swap(folder, outside)
        }

        return (realOpen as (...args: unknown[]) => number)(file, ...rest)
      }) as typeof fs.openSync
      fs.fstatSync = ((fd: number, ...rest: unknown[]) => {
        const stat = (realFstat as (...args: unknown[]) => fs.Stats)(fd, ...rest)

        if (armed && !back) {
          back = true
          fs.unlinkSync(folder)
          fs.renameSync(`${folder}.stash`, folder)
        }

        return stat
      }) as typeof fs.fstatSync

      let result: ReturnType<typeof seedAllShippedDisabled>
      // What the outside folder holds at each later seam of that folder: nothing, ever (the post-create re-check stops
      // the write before any byte goes through the descriptor).
      const later: string[][] = []

      try {
        result = seedAllShippedDisabled({
          hermesHome,
          markerFile,
          seam: (at, file) => {
            if (at === 'staged' && path.dirname(file) === folder) {
              later.push(tree(outside))
            }
          }
        })
      } finally {
        fs.openSync = realOpen
        fs.fstatSync = realFstat
      }

      expect([armed, back]).toEqual([true, true])
      expect(later).toEqual([])
      expect(fs.readdirSync(outside)).toEqual([])
      expect(fs.readdirSync(folder).filter(name => name.endsWith('.tmp'))).toEqual([])
      expect(result.unprotected).toEqual([profile])
      // The next pass, folders settled, protects it.
      expect(seedAllShippedDisabled({ hermesHome, markerFile }).unprotected).toEqual([])
    })
  }

  it('m-r4-4: a swap made before the create (at the placed seam) creates no file anywhere, not even one removed later', () => {
    const { hermesHome, outside, markerFile } = raceWorld()
    const folder = path.join(hermesHome, 'profiles', 'p2')
    const created: string[] = []
    const realOpen = fs.openSync

    fs.rmSync(path.join(outside, 'config.yaml'))
    fs.openSync = ((file: fs.PathLike, ...rest: unknown[]) => {
      if (typeof file === 'string' && file.endsWith('.tmp')) {
        created.push(file)
      }

      return (realOpen as (...args: unknown[]) => number)(file, ...rest)
    }) as typeof fs.openSync

    try {
      const { unprotected } = seedAllShippedDisabled({
        hermesHome,
        markerFile,
        seam: (at, file) => {
          if (at === 'placed' && path.dirname(file) === folder) {
            swap(folder, outside)
          }
        }
      })

      expect(unprotected).toEqual(['p2'])
    } finally {
      fs.openSync = realOpen
    }

    expect(created.filter(file => file.startsWith(folder + path.sep))).toEqual([])
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('m-r4-4: leftover temp files inside a profile folder are swept by the next pass; nothing else is touched', () => {
    const { hermesHome, outside, markerFile } = raceWorld()
    const folder = path.join(hermesHome, 'profiles', 'p1')
    const mine = path.join(folder, `.config.yaml.${process.pid}.${'a'.repeat(12)}.tmp`)
    const oldOther = path.join(folder, `.config.yaml.1.${'b'.repeat(12)}.tmp`)
    const freshOther = path.join(folder, `.config.yaml.1.${'c'.repeat(12)}.tmp`)
    const linked = path.join(folder, `.config.yaml.${process.pid}.${'d'.repeat(12)}.tmp`)
    const notOurs = path.join(folder, '.config.yaml.backup.tmp')

    for (const file of [mine, oldOther, freshOther, notOurs]) {
      fs.writeFileSync(file, '')
    }

    const old = new Date(Date.now() - 60 * 60 * 1000)

    fs.utimesSync(oldOther, old, old)
    fs.symlinkSync(path.join(outside, 'config.yaml'), linked)

    seedAllShippedDisabled({ hermesHome, markerFile })

    expect(fs.existsSync(mine)).toBe(false)
    expect(fs.existsSync(oldOther)).toBe(false)
    expect(fs.existsSync(freshOther)).toBe(true)
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(notOurs)).toBe(true)
    expect(read(path.join(outside, 'config.yaml'))).toBe(ORIGINAL)
  })

  for (const kind of ['edit', 'create'] as const) {
    it(`m-r4-5: a same-shape swap (another real folder moved in under the name, as a mount point would be) writes nothing (${kind})`, () => {
      // No link anywhere: only the identity of each folder in the chain tells the swapped folder from the recorded one.
      const { hermesHome, outside, markerFile } = raceWorld()
      const profile = kind === 'edit' ? 'p1' : 'p2'
      const folder = path.join(hermesHome, 'profiles', profile)

      if (kind === 'create') {
        fs.rmSync(path.join(outside, 'config.yaml'))
      }

      const before = tree(outside)
      let swapped = false

      const { configs, unprotected } = seedAllShippedDisabled({
        hermesHome,
        markerFile,
        seam: (at, file) => {
          if (at === 'placed' && path.dirname(file) === folder && !swapped) {
            swapped = true
            fs.renameSync(folder, `${folder}.stash`)
            fs.renameSync(outside, folder)
          }
        }
      })

      fs.renameSync(folder, outside)
      fs.renameSync(`${folder}.stash`, folder)

      expect(swapped).toBe(true)
      expect(tree(outside)).toEqual(before)
      expect(unprotected).toEqual([profile])
      // Caught as a moved folder before the temp file exists (not later, as an edited file that changed).
      expect(configs.find(r => r.configFile === path.join(folder, 'config.yaml'))?.skipped).toBe(
        'a folder of config.yaml changed while it was written: never written outside the Hermes home'
      )
    })
  }

  it('m-r4-5: the temp file is created exclusively: a hard link planted under its name is never written through', () => {
    const { hermesHome, outside, markerFile } = raceWorld()
    const folder = path.join(hermesHome, 'profiles', 'p1')

    const { unprotected } = seedAllShippedDisabled({
      hermesHome,
      markerFile,
      seam: (at, file) => {
        if (at === 'placed' && path.dirname(file) === folder) {
          fs.linkSync(path.join(outside, 'config.yaml'), file)
        }
      }
    })

    expect(read(path.join(outside, 'config.yaml'))).toBe(ORIGINAL)
    expect(unprotected).toEqual(['p1'])
  })

  it('m-r4-5: a config swapped for a link to an outside file right before its edit is never opened', () => {
    const { hermesHome, outside, markerFile } = raceWorld()
    const p1 = path.join(hermesHome, 'profiles', 'p1', 'config.yaml')
    const outsideId = fs.statSync(path.join(outside, 'config.yaml')).ino
    const realFstat = fs.fstatSync
    const opened: number[] = []

    fs.fstatSync = ((fd: number, ...rest: unknown[]) => {
      const stat = (realFstat as (...args: unknown[]) => fs.Stats)(fd, ...rest)

      opened.push(stat.ino)

      return stat
    }) as typeof fs.fstatSync

    let result: ReturnType<typeof seedAllShippedDisabled>

    try {
      result = seedAllShippedDisabled({
        hermesHome,
        markerFile,
        seam: (at, file) => {
          if (at === 'opening' && file === fs.realpathSync.native(p1)) {
            fs.rmSync(p1)
            fs.symlinkSync(path.join(outside, 'config.yaml'), p1)
          }
        }
      })
    } finally {
      fs.fstatSync = realFstat
    }

    expect(opened).not.toContain(outsideId)
    expect(result.configs.find(r => r.configFile === p1)?.skipped).toBe('config.yaml could not be read')
    expect(result.unprotected).toEqual(['p1'])
    expect(read(path.join(outside, 'config.yaml'))).toBe(ORIGINAL)
  })

  it('J4-2: no temp file outlives a pass; created configs are 0600 and edited ones keep their mode', () => {
    const { hermesHome, markerFile } = raceWorld()
    const p1 = path.join(hermesHome, 'profiles', 'p1', 'config.yaml')

    fs.chmodSync(p1, 0o640)
    seedAllShippedDisabled({ hermesHome, markerFile })

    for (const folder of [hermesHome, path.dirname(p1), path.join(hermesHome, 'profiles', 'p2')]) {
      expect(fs.readdirSync(folder).filter(name => name.endsWith('.tmp'))).toEqual([])
    }

    expect(modeOf(p1)).toBe(0o640)
    expect(modeOf(path.join(hermesHome, 'profiles', 'p2', 'config.yaml'))).toBe(0o600)
  })
})

describe('m-r4-2: a profile whose protection the seed cannot establish is unprotected (fail closed)', () => {
  const caseInsensitive = (() => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'v3jcase-'))

    try {
      fs.mkdirSync(path.join(probe, 'Aa'))

      return fs.existsSync(path.join(probe, 'aa'))
    } finally {
      fs.rmSync(probe, { recursive: true, force: true })
    }
  })()

  function world(): { base: string; hermesHome: string; markerFile: string } {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v3jfc-')))
    const hermesHome = path.join(base, 'hermes')

    dirs.push(base)
    fs.mkdirSync(path.join(hermesHome, 'profiles'), { recursive: true })
    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), 'model:\n  default: x\n')

    return { base, hermesHome, markerFile: path.join(base, 'marker.json') }
  }

  const idOf = (dir: string) => {
    const stat = fs.statSync(dir)

    return `${stat.dev}:${stat.ino}`
  }

  it('m-r4-2: a profile folder with capitals inside the home is profile `away` to Hermes: never written, unprotected', () => {
    const { hermesHome, markerFile } = world()
    const folder = path.join(hermesHome, 'profiles', 'Away')

    fs.mkdirSync(folder)
    fs.writeFileSync(path.join(folder, 'config.yaml'), 'model:\n  default: y\n')

    const result = seedAllShippedDisabled({ hermesHome, markerFile })

    expect(result.unprotected).toEqual(['away'])
    expect(result.verified).not.toHaveProperty('away')
    expect(result.verified).not.toHaveProperty('Away')
    expect(read(path.join(folder, 'config.yaml'))).toBe('model:\n  default: y\n')
    expect(result.verified.default).toBe(idOf(hermesHome))
  })

  it('m-r4-2: a profile link with capitals to an outside folder (J4-1’s scenario, letter case changed) is unprotected', () => {
    const { base, hermesHome, markerFile } = world()
    const outside = path.join(base, 'elsewhere')

    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'config.yaml'), 'model:\n  default: z\n')
    fs.symlinkSync(outside, path.join(hermesHome, 'profiles', 'Away'))

    const result = seedAllShippedDisabled({ hermesHome, markerFile })

    expect(result.unprotected).toEqual(['away'])
    expect(result.verified).not.toHaveProperty('away')
    expect(fs.readdirSync(outside)).toEqual(['config.yaml'])
    expect(read(path.join(outside, 'config.yaml'))).toBe('model:\n  default: z\n')
  })

  it('m-r4-2: folder names that fold to one profile name are a collision (on a case-sensitive volume both exist)', () => {
    expect([...foldedCollisions(['away', 'AWAY', 'coder', 'Coder', 'Coder', 'solo', 'b2'])].sort()).toEqual([
      'away',
      'coder'
    ])
    expect(foldedCollisions(['away', 'coder'])).toEqual(new Set())

    // Where the volume can hold both (case-sensitive), the seed leaves both alone and names the profile unprotected.
    const { hermesHome, markerFile } = world()

    fs.mkdirSync(path.join(hermesHome, 'profiles', 'away'))

    let both = true

    try {
      fs.mkdirSync(path.join(hermesHome, 'profiles', 'AWAY'))
    } catch {
      both = false
    }

    const result = seedAllShippedDisabled({ hermesHome, markerFile })

    expect(both).toBe(!caseInsensitive)
    expect(result.unprotected).toEqual(both ? ['away'] : [])
    expect(Object.prototype.hasOwnProperty.call(result.verified, 'away')).toBe(!both)
  })

  it('m-r4-2: a read-only profile folder whose config lacks the names is unprotected; one that has them is protected', () => {
    const { hermesHome, markerFile } = world()
    const ro = path.join(hermesHome, 'profiles', 'ro')
    const done = path.join(hermesHome, 'profiles', 'done')
    const empty = path.join(hermesHome, 'profiles', 'empty')

    for (const [folder, text] of [
      [ro, 'model:\n  default: y\n'],
      [done, MINIMAL]
    ]) {
      fs.mkdirSync(folder)
      fs.writeFileSync(path.join(folder, 'config.yaml'), text)
      fs.chmodSync(folder, 0o555)
    }

    fs.mkdirSync(empty, { mode: 0o555 })

    try {
      const result = seedAllShippedDisabled({ hermesHome, markerFile })

      expect(result.unprotected).toEqual(['empty', 'ro'])
      expect(Object.keys(result.verified).sort()).toEqual(['default', 'done'])
      expect(result.configs.find(r => r.configFile === path.join(ro, 'config.yaml'))?.skipped).toBe('write failed')
      expect(read(path.join(ro, 'config.yaml'))).toBe('model:\n  default: y\n')
      expect(fs.existsSync(path.join(empty, 'config.yaml'))).toBe(false)
    } finally {
      for (const folder of [ro, done, empty]) {
        fs.chmodSync(folder, 0o755)
      }
    }
  })

  it('m-r4-2: a config path that fits the path limit while the temp file’s name does not is unprotected', () => {
    const { base, markerFile } = world()
    const name = `p${'x'.repeat(30)}`
    // macOS PATH_MAX is 1024 (Linux 4096): the config path is just under it, the temp name next to it over it.
    const limit = process.platform === 'darwin' ? 1024 : 4096
    const want = limit - 1 - '/.hermes/profiles/'.length - name.length - '/config.yaml'.length - 4
    let at = base

    while (at.length < want - 61) {
      at = path.join(at, 'd'.repeat(60))
    }

    at = path.join(at, 'e'.repeat(Math.max(1, want - at.length - 1)))

    const hermesHome = path.join(at, '.hermes')
    const config = path.join(hermesHome, 'profiles', name, 'config.yaml')

    fs.mkdirSync(path.dirname(config), { recursive: true })
    fs.writeFileSync(config, 'model:\n  default: y\n')
    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), MINIMAL)
    expect(config.length).toBeLessThan(limit)
    expect(`${path.dirname(config)}/.config.yaml.${process.pid}.${'0'.repeat(12)}.tmp`.length).toBeGreaterThan(limit)

    const result = seedAllShippedDisabled({ hermesHome, markerFile })

    expect(result.unprotected).toEqual([name])
    expect(result.verified).not.toHaveProperty(name)
    expect(read(config)).toBe('model:\n  default: y\n')
  })

  it('m-r4-2: a config already decided that is no longer readable is unprotected until it is', () => {
    const { hermesHome, markerFile } = world()
    const folder = path.join(hermesHome, 'profiles', 'sealed')
    const config = path.join(folder, 'config.yaml')

    fs.mkdirSync(folder)
    fs.writeFileSync(config, 'model:\n  default: y\n')
    expect(seedAllShippedDisabled({ hermesHome, markerFile }).verified).toHaveProperty('sealed')

    fs.chmodSync(config, 0o000)

    try {
      const sealed = seedAllShippedDisabled({ hermesHome, markerFile })

      expect(sealed.unprotected).toEqual(['sealed'])
      expect(sealed.verified).not.toHaveProperty('sealed')
    } finally {
      fs.chmodSync(config, 0o600)
    }

    expect(seedAllShippedDisabled({ hermesHome, markerFile }).unprotected).toEqual([])
  })

  it('m-r4-2: a reserved name under profiles/ is not a profile (Hermes never runs it): it never stands in for `default`', () => {
    const { hermesHome, markerFile } = world()

    fs.mkdirSync(path.join(hermesHome, 'profiles', 'default'))
    fs.mkdirSync(path.join(hermesHome, 'profiles', 'coder'))
    fs.symlinkSync(path.join(hermesHome, 'profiles', 'coder'), path.join(hermesHome, 'profiles', 'alias'))

    const result = seedAllShippedDisabled({ hermesHome, markerFile })

    expect(result.verified.default).toBe(idOf(hermesHome))
    expect(fs.existsSync(path.join(hermesHome, 'profiles', 'default', 'config.yaml'))).toBe(false)
    // Two names for one folder: both are that folder's profile, verified together.
    expect(result.verified.alias).toBe(idOf(path.join(hermesHome, 'profiles', 'coder')))
    expect(result.verified.coder).toBe(result.verified.alias)
    expect(result.unprotected).toEqual([])
  })
})
