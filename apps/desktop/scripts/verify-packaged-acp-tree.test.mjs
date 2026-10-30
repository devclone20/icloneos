import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isCliData, pruneShipFiles, shipPrunePlan } from './stage-acp-cli.mjs'
import {
  acpRootOf,
  appAcpVerbs,
  appRuleVerbs,
  judgeHelp,
  judgeReadOnly,
  READ_ONLY_RUNS,
  reportAcpTree,
  splitFailures
} from './verify-packaged-acp-tree.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('appAcpVerbs — the argv the app can run', () => {
  it('reads roots, null roots, multi-line lists and quoted keys, skipping comments', () => {
    const source = `const X = 1
export const AGENT_COMMANDS: Readonly<Record<string, readonly string[] | null>> = {
  agent: [
    'whoami',
    'update'
  ],
  browse: null,
  // a comment with 'quotes': ['nope']
  'chain': ['list']
}
const BARE_ROOTS = new Set(['other'])`

    expect(appAcpVerbs(source)).toEqual([
      ['agent'],
      ['agent', 'whoami'],
      ['agent', 'update'],
      ['browse'],
      ['chain'],
      ['chain', 'list']
    ])
  })

  it('reads the real allowlist', () => {
    const verbs = appAcpVerbs(readFileSync(path.join(desktop, 'electron', 'iclone-acp-ipc.ts'), 'utf8'))

    expect(verbs).toContainEqual(['email', 'inbox'])
    expect(verbs).toContainEqual(['browse'])
    expect(verbs.length).toBeGreaterThan(50)
  })

  it('refuses a source without the literal', () => {
    expect(() => appAcpVerbs('export const OTHER = {}')).toThrow('AGENT_COMMANDS literal not found')
  })

  it('reads a double-quoted key and refuses a value that is neither null nor a list literal', () => {
    expect(appAcpVerbs('export const AGENT_COMMANDS = {\n  "card": [\'list\'],\n}')).toEqual([
      ['card'],
      ['card', 'list']
    ])
    expect(() => appAcpVerbs('export const AGENT_COMMANDS = {\n  card: CARD_SUBS\n}')).toThrow(
      'AGENT_COMMANDS.card: expected null or a list literal'
    )
  })
})

describe("appRuleVerbs — the argv the app's own windows run", () => {
  it("reads quoted and bare keys at the literal's top level only, whatever their values hold", () => {
    const source = [
      'const RULES: Record<string, Rule> = {',
      '  // sign-in',
      "  'configure start': {},",
      "  'card limit set': { flags: { '--amount': decimal } },",
      "  'card 3ds': {",
      "    flags: { 'nested key': id, '--name': re(/^[^'}]{1,20}$/) }",
      '  },',
      '  /* a block comment with a key: { "nope": {} } */',
      '  "card freeze": {},',
      '  chain: { positional: `a ${"template"}` }',
      '}',
      "const READS = new Set(['email inbox'])"
    ].join('\n')

    expect(appRuleVerbs(source)).toEqual([
      ['configure', 'start'],
      ['card', 'limit', 'set'],
      ['card', '3ds'],
      ['card', 'freeze'],
      ['chain']
    ])
  })

  it('reads every key of the real table: the count equals its top-level key lines, bare `browse` included', () => {
    const source = readFileSync(path.join(desktop, 'electron', 'iclone-acp-argv.ts'), 'utf8')
    const literal = source.slice(source.indexOf('const RULES'), source.indexOf('\n}', source.indexOf('const RULES')))
    const keyLines = literal.match(/^ {2}(?:'[^']+'|"[^"]+"|[A-Za-z_$][\w$]*)\s*:/gm)
    const verbs = appRuleVerbs(source)

    expect(verbs).toHaveLength(keyLines.length)
    expect(verbs.length).toBeGreaterThanOrEqual(50)
    expect(verbs).toContainEqual(['browse'])
    expect(verbs).toContainEqual(['wallet', 'sol', 'address'])
    expect(verbs).toContainEqual(['card', 'limit', 'set'])
  })

  it('reads a regex literal after an arrow, a `return` or another keyword, and still a division after a word', () => {
    const source = [
      'const RULES = {',
      "  'card list': { valid: v => /x{2}/.test(v) },",
      "  'card get': { valid(v) { return /[}'\"]{1,3}/.test(v) } },",
      "  'card 3ds': { kind: v => typeof /x/ === 'object' || v instanceof /[{]/.constructor },",
      "  'agent list': { pick: v => { switch (v) { case /a{1}/.source: return 1 } } },",
      "  'agent get': { half: total / 2, ratio: (a) / b, prop: o.return / 2 }",
      '}'
    ].join('\n')

    expect(appRuleVerbs(source)).toEqual([
      ['card', 'list'],
      ['card', 'get'],
      ['card', '3ds'],
      ['agent', 'list'],
      ['agent', 'get']
    ])
  })

  it('refuses a top-level member that is not `key: value`, so no verb is skipped in silence', () => {
    for (const member of ['...OTHER_RULES', 'chain', "['card list']: {}", 'card list: {}']) {
      expect(() => appRuleVerbs(`const RULES = {\n  'agent list': {},\n  ${member},\n}`)).toThrow('unsupported member')
    }
  })

  it('refuses a source without the literal', () => {
    expect(() => appRuleVerbs('export const OTHER = {}')).toThrow('const RULES literal not found')
  })
})

describe('splitFailures — stale allowlist vs broken tree', () => {
  const ok = { argv: ['chain', 'list'], ok: true, unknown: false }
  const crash = { argv: ['email', 'inbox'], ok: false, unknown: false, error: 'exit 1' }
  const ownUnknown = { argv: ['card', 'limit', 'set'], ok: false, unknown: true, error: 'usage "Usage: acp card"' }
  const agentUnknown = { argv: ['sol', 'address'], ok: false, unknown: true, error: 'usage "Usage: acp"' }

  it('calls an agent-only verb the CLI does not know stale, and everything else that failed broken', () => {
    const own = new Set(['card limit set', 'email inbox', 'chain list'])

    expect(splitFailures([ok, crash, ownUnknown, agentUnknown], own)).toEqual({
      broken: [crash, ownUnknown],
      stale: [agentUnknown]
    })
  })

  it('never calls a crash stale, even for an agent-only verb', () => {
    expect(splitFailures([crash], new Set()).broken).toEqual([crash])
  })
})

describe('judgeReadOnly — a read-only run is judged by its data, not only its exit code', () => {
  const root = path.join(os.tmpdir(), 'acp-ro-tree')
  const run = argv => READ_ONLY_RUNS.find(entry => entry.argv.join(' ') === argv)
  const judge = (argv, result) => judgeReadOnly(run(argv), { stderr: '', ...result }, { root, version: '1.0.38' })

  it('runs --version and skill path|print|check', () => {
    expect(READ_ONLY_RUNS.map(entry => entry.argv.join(' '))).toEqual([
      '--version',
      'skill path --json',
      'skill print --json',
      'skill check --json'
    ])
  })

  it('accepts the pinned version, a skill file inside the tree, a full print and a skill hash', () => {
    const file = path.join(root, 'SKILL.md')

    mkdirSync(root, { recursive: true })
    writeFileSync(file, 'skill')

    try {
      expect(judge('--version', { code: 0, stdout: '1.0.38\n' }).ok).toBe(true)
      expect(judge('skill path --json', { code: 0, stdout: JSON.stringify({ path: file }) }).ok).toBe(true)
      expect(judge('skill print --json', { code: 0, stdout: JSON.stringify({ content: 'x'.repeat(10_001) }) }).ok).toBe(
        true
      )
      expect(judge('skill check --json', { code: 0, stdout: '{"skillHash":"747def69253a1b16"}' }).ok).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a non-zero exit, a wrong version, a path outside the tree or missing, a short print and no hash', () => {
    const missing = judge('skill print --json', {
      code: 1,
      stderr: '',
      stdout: '{"error":"Bundled SKILL.md not found."}'
    })

    expect(missing).toMatchObject({ ok: false, error: 'exit 1: {"error":"Bundled SKILL.md not found."}' })
    expect(judge('--version', { code: 0, stdout: '1.0.37' }).ok).toBe(false)
    expect(judge('skill path --json', { code: 0, stdout: '{"path":"/etc/hosts"}' }).ok).toBe(false)
    expect(
      judge('skill path --json', { code: 0, stdout: JSON.stringify({ path: path.join(root, 'SKILL.md') }) }).ok
    ).toBe(false)
    expect(judge('skill print --json', { code: 0, stdout: JSON.stringify({ content: 'short' }) }).ok).toBe(false)
    expect(judge('skill check --json', { code: 0, stdout: 'not json' }).ok).toBe(false)
  })
})

describe('judgeHelp — the verb itself answered', () => {
  it('accepts the exact usage line, with or without arguments after it', () => {
    expect(judgeHelp(['email', 'inbox'], { code: 0, stdout: 'Usage: acp email inbox [options]\n' }).ok).toBe(true)
    expect(judgeHelp(['chain', 'list'], { code: 0, stdout: 'x\nUsage: acp chain list\n' }).ok).toBe(true)
  })

  it("calls the parent's usage unknown, not broken", () => {
    expect(judgeHelp(['email', 'nosuch'], { code: 0, stdout: 'Usage: acp email [options] [command]\n' })).toEqual({
      ok: false,
      unknown: true,
      error: 'usage "Usage: acp email [options] [command]"'
    })
    expect(judgeHelp(['email', 'in'], { code: 0, stdout: 'Usage: acp email inbox [options]\n' }).unknown).toBe(true)
  })

  it('calls a non-zero exit broken', () => {
    expect(judgeHelp(['email'], { code: 1, stdout: '' })).toEqual({ ok: false, unknown: false, error: 'exit 1' })
  })
})

describe('reportAcpTree — the verdict stage-acp-cli acts on', () => {
  it('fails and says so when the tree cannot pass the self-test, before running any verb', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'acp-tree-'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const verdict = await reportAcpTree(root)

      expect(verdict.ok).toBe(false)
      expect(verdict.error).toMatch(/^self-test: /)
      expect(errors.mock.calls[0][0]).toContain('[verify-packaged-acp-tree] FAILED')
    } finally {
      errors.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('is what stage-acp-cli runs on the staged tree after the prune, which the read trace of the full tree precedes', () => {
    const stage = readFileSync(path.join(desktop, 'scripts', 'stage-acp-cli.mjs'), 'utf8')
    const prune = stage.indexOf('pruneShipFiles(layout.nodeModules)')

    expect(stage.indexOf('await reportAcpTree(root')).toBeGreaterThan(prune)
    expect(stage.indexOf('await traceReads({ root })')).toBeGreaterThan(stage.indexOf('copyFileSync('))
    expect(stage.indexOf('await traceReads({ root })')).toBeLessThan(prune)
    expect(stage.indexOf('reads.filter(file => !existsSync(file))')).toBeGreaterThan(prune)
  })
})

describe('acpRootOf', () => {
  it('maps a bundle to its Resources/acp-cli and keeps a dir', () => {
    expect(acpRootOf('/x/iclone os.app')).toBe(path.join('/x/iclone os.app', 'Contents', 'Resources', 'acp-cli'))
    expect(acpRootOf('/x/build/acp-cli')).toBe('/x/build/acp-cli')
  })
})

describe('pruneShipFiles — only what a command can load ships', () => {
  let nm

  function put(rel, body = 'x') {
    const file = path.join(nm, rel)

    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
  }

  beforeEach(() => {
    nm = path.join(mkdtempSync(path.join(os.tmpdir(), 'acp-ship-')), 'node_modules')
    put('lib-a/package.json', '{"name":"lib-a"}')
    put('lib-a/index.js')
    put('lib-a/index.js.map', 'mapmap')
    put('lib-a/index.d.ts')
    put('lib-a/src/index.ts')
    put('lib-a/src/view.tsx')
    put('lib-a/src/esm.d.mts')
    put('lib-a/README.md')
    put('lib-a/LICENSE.md')
    put('lib-a/NOTICE')
    put('lib-a/docs/guide.html')
    put('lib-a/test/a.test.js')
    put('lib-a/lib/test/runtime.js')
    put('lib-a/.npmignore')
    put('lib-a/lib/.gitkeep')
    put('lib-a/.eslintrc.json')
    mkdirSync(path.join(nm, 'lib-a', 'empty-before'))
    put('@scope/native/package.json', '{"name":"@scope/native"}')

    for (const tag of ['darwin-arm64', 'darwin-x64', 'darwin-x64+arm64', 'linux-x64', 'win32-x64']) {
      put(`@scope/native/prebuilds/${tag}/n.node`)
    }

    put('@virtuals-protocol/acp-cli/package.json', '{"name":"@virtuals-protocol/acp-cli"}')

    for (const data of ['SKILL.md', 'README.md', 'migration.md', 'docs/tokenization.md']) {
      put(`@virtuals-protocol/acp-cli/${data}`)
    }

    put('@virtuals-protocol/acp-cli/dist/bin/acp.js')
    put('@virtuals-protocol/acp-cli/dist/bin/acp.js.map')
    put('@virtuals-protocol/acp-cli/test/cli.test.js')
    put('@virtuals-protocol/acp-cli/.npmignore')

    for (const signer of ['acp-cli-signer-macos', 'acp-cli-signer-linux', 'acp-cli-signer-windows.exe']) {
      put(`@virtuals-protocol/acp-cli/bin/${signer}`)
    }

    put('lib-a/node_modules/nested/package.json', '{"name":"nested"}')
    put('lib-a/node_modules/nested/tests/x.js')
    put('lib-a/node_modules/nested/main.cjs')
  })

  afterEach(() => {
    rmSync(path.dirname(nm), { recursive: true, force: true })
  })

  it('plans maps, types, TS sources, docs, placeholders, package-root test/doc dirs, other platforms and signers', () => {
    const plan = shipPrunePlan(nm, { platform: 'darwin', arch: 'arm64' })
      .map(p => path.relative(nm, p))
      .sort()

    expect(plan).toEqual(
      [
        '@scope/native/prebuilds/darwin-x64',
        '@scope/native/prebuilds/linux-x64',
        '@scope/native/prebuilds/win32-x64',
        '@virtuals-protocol/acp-cli/.npmignore',
        '@virtuals-protocol/acp-cli/dist/bin/acp.js.map',
        '@virtuals-protocol/acp-cli/test',
        '@virtuals-protocol/acp-cli/bin/acp-cli-signer-linux',
        '@virtuals-protocol/acp-cli/bin/acp-cli-signer-windows.exe',
        'lib-a/.npmignore',
        'lib-a/README.md',
        'lib-a/docs',
        'lib-a/index.d.ts',
        'lib-a/index.js.map',
        'lib-a/lib/.gitkeep',
        'lib-a/node_modules/nested/tests',
        'lib-a/src/esm.d.mts',
        'lib-a/src/index.ts',
        'lib-a/src/view.tsx',
        'lib-a/test'
      ].sort()
    )
  })

  it('keeps the signer and prebuilds of the target platform', () => {
    const plan = shipPrunePlan(nm, { platform: 'linux', arch: 'x64' }).map(p => path.relative(nm, p))

    expect(plan).toContain('@virtuals-protocol/acp-cli/bin/acp-cli-signer-macos')
    expect(plan).not.toContain('@virtuals-protocol/acp-cli/bin/acp-cli-signer-linux')
    expect(plan).not.toContain('@scope/native/prebuilds/linux-x64')
    expect(plan).toContain('@scope/native/prebuilds/darwin-x64+arm64')
  })

  it('removes the plan and the dirs it emptied, keeps licences, code and dirs that were already empty', () => {
    const result = pruneShipFiles(nm, { platform: 'darwin', arch: 'arm64' })

    expect(result.removed).toBe(19)
    expect(result.bytes).toBeGreaterThan(0)

    for (const kept of [
      'lib-a/index.js',
      'lib-a/LICENSE.md',
      'lib-a/NOTICE',
      'lib-a/lib/test/runtime.js',
      'lib-a/empty-before',
      'lib-a/node_modules/nested/main.cjs',
      '@scope/native/prebuilds/darwin-arm64/n.node',
      '@scope/native/prebuilds/darwin-x64+arm64/n.node',
      '@virtuals-protocol/acp-cli/bin/acp-cli-signer-macos',
      '@virtuals-protocol/acp-cli/dist/bin/acp.js'
    ]) {
      expect(existsSync(path.join(nm, kept)), kept).toBe(true)
    }

    expect(existsSync(path.join(nm, 'lib-a', 'src'))).toBe(false)
    expect(shipPrunePlan(nm, { platform: 'darwin', arch: 'arm64' })).toEqual([])
  })

  it("keeps the CLI's own data through the prune: every file at its root (SKILL.md first) and its docs", () => {
    pruneShipFiles(nm, { platform: 'darwin', arch: 'arm64' })

    for (const data of ['package.json', 'SKILL.md', 'README.md', 'migration.md', 'docs/tokenization.md']) {
      expect(existsSync(path.join(nm, '@virtuals-protocol', 'acp-cli', data)), data).toBe(true)
    }

    expect(existsSync(path.join(nm, 'lib-a', 'README.md'))).toBe(false)
    expect(existsSync(path.join(nm, 'lib-a', 'docs'))).toBe(false)
  })

  it('calls CLI data only a file at its package root or in its docs, never its code dirs or another package', () => {
    const cli = path.join(nm, '@virtuals-protocol', 'acp-cli')

    expect(isCliData(cli, path.join(cli, 'SKILL.md'))).toBe(true)
    expect(isCliData(cli, path.join(cli, 'docs', 'deep', 'x.md'))).toBe(true)
    expect(isCliData(cli, path.join(cli, 'dist', 'bin', 'acp.js.map'))).toBe(false)
    expect(isCliData(cli, path.join(cli, 'node_modules', 'dep', 'README.md'))).toBe(false)
    expect(isCliData(cli, path.join(nm, 'lib-a', 'README.md'))).toBe(false)
    expect(isCliData(cli, cli)).toBe(false)
  })
})
