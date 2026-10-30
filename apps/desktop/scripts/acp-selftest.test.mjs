import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { confinedTree } from './acp-launch-fixture.mjs'
import { acpLayout, judgeChainList, judgePackagedSelftest } from './acp-selftest.mjs'
import { listPackages, pruneToRuntime } from './stage-acp-cli.mjs'

describe('judgeChainList — what counts as a working CLI', () => {
  it('accepts a chain list, even behind a dotenv tip that carries braces', () => {
    const stdout =
      '[dotenv@17.4.2] injecting env (0) from .env -- tip: ⚙️  enable debug logging with { debug: true }\n' +
      '{"environment":"mainnet","chains":[{"id":8453,"name":"Base","family":"evm"}]}\n'

    expect(judgeChainList({ status: 0, stdout, stderr: '' })).toEqual({ ok: true, chains: 1 })
  })

  it('reads the argv bug as a failure, with commander’s line as the reason', () => {
    const stderr =
      "error: unknown command '/Applications/iclone os.app/Contents/Resources/acp-cli/runtime/node_modules/@virtuals-protocol/acp-cli/dist/bin/acp.js'\n"

    expect(judgeChainList({ status: 1, stdout: '', stderr })).toEqual({
      ok: false,
      error: `exit 1: ${stderr.trim()}`
    })
  })

  it('refuses a clean exit that did not answer', () => {
    expect(judgeChainList({ status: 0, stdout: '1.0.38\n', stderr: '' }).ok).toBe(false)
    expect(judgeChainList({ status: 0, stdout: '{"environment":"mainnet","chains":[]}', stderr: '' }).ok).toBe(false)
  })
})

describe('acpLayout', () => {
  it('names the launcher beside the runtime tree, never inside it', () => {
    const layout = acpLayout('/R/acp-cli')

    expect(layout.launcher).toBe('/R/acp-cli/launch.cjs')
    expect(layout.entry).toBe('/R/acp-cli/runtime/node_modules/@virtuals-protocol/acp-cli/dist/bin/acp.js')
    expect(layout.nodeModules).toBe('/R/acp-cli/runtime/node_modules')
  })
})

describe('judgePackagedSelftest — the shipped app’s own report', () => {
  const pass = {
    selftest: 'all',
    ok: true,
    acp: { ok: true, bundled: false, version: '1.0.38', lockSha256: 'a'.repeat(64) },
    pty: { ok: true }
  }

  it('passes a clean report at the pinned version', () => {
    const stdout = `[iclone-selftest] mode=all\n${JSON.stringify(pass)}\n`

    expect(judgePackagedSelftest({ status: 0, stdout, stderr: '' }, '1.0.38')).toEqual({
      ok: true,
      version: '1.0.38',
      lockSha256: 'a'.repeat(64)
    })
  })

  it('REL-6: refuses an app that reports a bundled CLI (or says nothing about it)', () => {
    for (const acp of [
      { ok: true, version: '1.0.38', chains: 4 },
      { ok: true, bundled: true, version: '1.0.38' }
    ]) {
      const stdout = JSON.stringify({ ...pass, acp })

      expect(judgePackagedSelftest({ status: 0, stdout, stderr: '' }, '1.0.38').error).toMatch(/bundled ACP CLI/)
    }
  })

  it('names the failing part, a version drift, or a missing report', () => {
    const broken = { ...pass, ok: false, pty: { ok: false, error: 'node-pty: exit 1' } }

    expect(judgePackagedSelftest({ status: 1, stdout: JSON.stringify(broken), stderr: '' }, '1.0.38').error).toBe(
      'pty: node-pty: exit 1'
    )
    expect(judgePackagedSelftest({ status: 0, stdout: JSON.stringify(pass), stderr: '' }, '1.0.39').ok).toBe(false)
    expect(judgePackagedSelftest({ status: 9, stdout: '', stderr: 'dyld: boom' }).error).toMatch(/dyld: boom/)
  })
})

describe('judgePackagedSelftest — a bundle dyld refuses', () => {
  it('names library validation instead of quoting the first dyld line', () => {
    const stderr =
      'dyld[1]: Library not loaded: @rpath/Electron Framework.framework/Electron Framework\n' +
      "  Reason: tried: '/x/Electron Framework' (code signature in <UUID> '/x/Electron Framework' not valid for use in process\n"
    const result = judgePackagedSelftest({ status: null, stdout: '', stderr }, '1.0.38')

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/library validation .*hardened runtime/)
  })
})

describe('runtimeClosure — only what the CLI loads ships', () => {
  it('keeps dependencies, optional and peer deps; drops build tooling and orphans', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'iclone-closure-'))
    const nm = path.join(root, 'node_modules')
    const write = (name, manifest) => {
      mkdirSync(path.join(nm, name), { recursive: true })
      writeFileSync(path.join(nm, name, 'package.json'), JSON.stringify({ name, ...manifest }))
    }

    try {
      write('@virtuals-protocol/acp-cli', { dependencies: { lib: '1', tsup: '1' }, peerDependencies: { peer: '1' } })
      write('lib', {
        optionalDependencies: { '@napi-rs/keyring-darwin-arm64': '1' },
        dependencies: { '@types/node': '1' }
      })
      write('@napi-rs/keyring-darwin-arm64', {})
      write('peer', { peerDependencies: { typescript: '5' } })
      write('tsup', { dependencies: { esbuild: '1' } })
      write('esbuild', {})
      write('typescript', {})
      write('@types/node', {})

      expect(pruneToRuntime(nm).sort()).toEqual(['@types/node', 'esbuild', 'tsup', 'typescript'])
      expect(
        listPackages(nm)
          .map(dir => path.relative(nm, dir))
          .sort()
      ).toEqual(['@napi-rs/keyring-darwin-arm64', '@virtuals-protocol/acp-cli', 'lib', 'peer'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('acp-launch.cjs — a utility process exits when the CLI is done', () => {
  const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), 'acp-launch.cjs')

  // Plain Node standing in for a utility process: a parentPort and a ref'd
  // handle the loop never drops, so only the launcher's idle exit can end it.
  const commanderDir = path.dirname(createRequire(import.meta.url).resolve('commander/package.json'))

  // REL-6 round 2: the launcher runs only a confined, manifest-checked tree (acp-launch-fixture.mjs), so the CLI and a
  // copy of commander live inside one.
  const commanderFiles = Object.fromEntries(
    readdirSync(commanderDir, { recursive: true })
      .filter(rel => statSync(path.join(commanderDir, rel)).isFile())
      .map(rel => [`commander/${rel.split(path.sep).join('/')}`, readFileSync(path.join(commanderDir, rel))])
  )

  const run = (body, args = []) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acp-launch-test-'))

    try {
      const tree = confinedTree(dir, { ...commanderFiles, 'cli/cli.mjs': body })

      writeFileSync(path.join(dir, 'utility.cjs'), 'process.parentPort = {}\nsetInterval(() => {}, 60_000)\n')

      const argv = [
        '-r',
        path.join(dir, 'utility.cjs'),
        launcher,
        path.join(tree.nodeModules, 'cli', 'cli.mjs'),
        ...args
      ]

      return spawnSync(process.execPath, argv, {
        encoding: 'utf8',
        env: tree.env,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10_000
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('exits after an action that returns without process.exit', () => {
    const result = run("console.log('chains')\n")

    expect(result.signal).toBeNull()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('chains\n')
  })

  it('waits for pending timers and keeps the CLI exit code', () => {
    const result = run("await new Promise(r => setTimeout(r, 300))\nconsole.log('late')\nprocess.exitCode = 3\n")

    expect(result.status).toBe(3)
    expect(result.stdout).toBe('late\n')
  })

  it('never cuts a large answer short', () => {
    const result = run("process.stdout.write('x'.repeat(4 * 1024 * 1024) + '\\nEND\\n')\n")

    expect(result.status).toBe(0)
    expect(result.stdout.length).toBe(4 * 1024 * 1024 + 5)
  })

  // Thread-pool work is invisible to getActiveResourcesInfo(): only the action
  // promise tells the launcher the command is still running.
  const cliWith = action =>
    [
      "import { createRequire } from 'node:module'",
      "import { pbkdf2 } from 'node:crypto'",
      "const { Command } = createRequire(import.meta.url)('commander')",
      'const program = new Command()',
      `program.command('derive').action(${action})`,
      'program.parse(process.argv)'
    ].join('\n')

  it('waits for an async action whose only work is on the thread pool', () => {
    const action = `() => new Promise(resolve => pbkdf2('a', 'b', 2e6, 32, 'sha256', () => { console.log('derived'); resolve() }))`
    const result = run(cliWith(action), ['derive'])

    expect(result.signal).toBeNull()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('derived\n')
  })

  it('still fails a command whose async action rejects', () => {
    const result = run(cliWith(`async () => { throw new Error('boom') }`), ['derive'])

    expect(result.signal).toBeNull()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/boom/)
  })
})
