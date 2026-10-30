// REL-6 round 2, critic M1 — the launcher confines the installed CLI to its verified tree. The critic's scenario is
// permanent here: a fake `@napi-rs/keyring-darwin-universal` planted at every level Node would walk up to (and on
// NODE_PATH) must never load; the real (in-tree) binding must. Plus: ESM, absolute and climbing paths, worker
// threads, native add-ons, executables, and a file or manifest changed after the check. Run on this Node and on
// Electron's own Node (the app's), when installed.
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { confinedTree, LAUNCHER, runners, seal } from './acp-launch-fixture.mjs'

const temps = []

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const home = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acp-confine-'))

  temps.push(dir)

  return dir
}

const KEYRING = {
  // The shape of @napi-rs/keyring/index.js on darwin: the universal binding first, then the arch's own.
  '@napi-rs/keyring/package.json': '{"name":"@napi-rs/keyring","main":"index.js"}',
  '@napi-rs/keyring/index.js': [
    'let binding = null',
    "try { binding = require('@napi-rs/keyring-darwin-universal') } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e }",
    "if (!binding) binding = require('@napi-rs/keyring-darwin-arm64')",
    'module.exports = binding'
  ].join('\n'),
  '@napi-rs/keyring-darwin-arm64/package.json': '{"name":"@napi-rs/keyring-darwin-arm64","main":"index.js"}',
  '@napi-rs/keyring-darwin-arm64/index.js': "module.exports = 'REAL-BINDING'"
}

const PLANT = {
  'package.json': '{"name":"x","main":"index.js"}',
  'index.js': "process.stdout.write('PLANTED-RAN\\n'); module.exports = 'PLANTED'"
}

function plant(dir, name) {
  for (const [file, text] of Object.entries(PLANT)) {
    mkdirSync(path.join(dir, name), { recursive: true })
    writeFileSync(path.join(dir, name, file), text)
  }
}

const ENTRY = '@virtuals-protocol/acp-cli/dist/bin/acp.js'

function cli(files, entryBody) {
  return { ...files, '@virtuals-protocol/acp-cli/package.json': '{"type":"module"}', [ENTRY]: entryBody }
}

const run = (runner, tree, extraEnv = {}, args = []) =>
  spawnSync(runner.exec, [LAUNCHER, path.join(tree.nodeModules, ...ENTRY.split('/')), ...args], {
    encoding: 'utf8',
    env: { ...tree.env, ...runner.env, ...extraEnv },
    timeout: 20_000
  })

describe.each(runners())('acp-launch.cjs confines the CLI to its verified tree — $name', runner => {
  it('the critic’s M1: a fake keyring binding planted at every walk-up level and on NODE_PATH never loads', () => {
    const h = home()
    const tree = confinedTree(
      h,
      cli(
        KEYRING,
        "import { createRequire } from 'node:module'\nconsole.log('binding=' + createRequire(import.meta.url)('@napi-rs/keyring'))\n"
      )
    )
    const nodePath = path.join(h, 'node-path')

    for (const level of [
      path.join(tree.lockDir, 'node_modules'),
      path.join(tree.userData, 'acp-cli', 'node_modules'),
      path.join(tree.userData, 'node_modules'),
      path.join(h, 'node_modules'),
      nodePath
    ]) {
      plant(level, '@napi-rs/keyring-darwin-universal')
      plant(level, 'supports-color')
    }

    const result = run(runner, tree, { NODE_PATH: nodePath })

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('binding=REAL-BINDING\n')
    // Never consulted: the lookup stops at the tree, so not even a refusal had to be reported.
    expect(result.stdout + result.stderr).not.toMatch(/PLANTED|outside the verified tree/)
  })

  it('import() of a name that exists only outside the tree is ERR_MODULE_NOT_FOUND, like a clean npm ci', () => {
    const h = home()
    const tree = confinedTree(
      h,
      cli({}, "try { await import('supports-color'); console.log('loaded') } catch (e) { console.log(e.code) }\n")
    )

    plant(path.join(tree.userData, 'acp-cli', 'node_modules'), 'supports-color')
    plant(path.join(h, 'node_modules'), 'supports-color')

    const result = run(runner, tree)

    expect(result.stdout).toBe('ERR_MODULE_NOT_FOUND\n')
  })

  it('an absolute path or a path that climbs out of the tree is refused (and reported), require and import', () => {
    const h = home()
    const evil = path.join(h, 'evil')

    plant(h, 'evil')

    const tree = confinedTree(
      h,
      cli(
        { 'dep/index.js': `try { require(${JSON.stringify(evil)}) } catch (e) { console.log('require', e.code) }` },
        [
          "import { createRequire } from 'node:module'",
          "createRequire(import.meta.url)('dep')",
          `try { await import(${JSON.stringify(`file://${evil}/index.js`)}) } catch (e) { console.log('import', e.code) }`,
          `try { await import('../../../../../../../../../..${evil}/index.js') } catch (e) { console.log('climb', e.code) }`
        ].join('\n')
      )
    )

    const result = run(runner, tree)

    expect(result.stdout).toBe('require MODULE_NOT_FOUND\nimport ERR_MODULE_NOT_FOUND\nclimb ERR_MODULE_NOT_FOUND\n')
    expect(result.stderr).toMatch(/resolves outside the verified tree/)
    expect(result.stdout).not.toMatch(/PLANTED/)
  })

  it('a worker thread is confined too (its own hooks)', () => {
    const h = home()
    const tree = confinedTree(
      h,
      cli(
        {},
        [
          "import { Worker } from 'node:worker_threads'",
          "const source = \"let r; try { r = require('supports-color') } catch (e) { r = e.code } require('node:worker_threads').parentPort.postMessage(String(r))\"",
          'const w = new Worker(source, { eval: true })',
          "w.once('message', m => { console.log('worker', m); w.terminate() })"
        ].join('\n')
      )
    )

    plant(path.join(tree.userData, 'acp-cli', 'node_modules'), 'supports-color')
    plant(path.join(h, 'node_modules'), 'supports-color')

    const result = run(runner, tree)

    expect(result.stdout).toBe('worker MODULE_NOT_FOUND\n')
  })

  it('a worker that would preload outside code (--require, -r, --import, --loader) is refused (critic r2 m1, r3 F3)', () => {
    const h = home()
    const outside = path.join(h, 'pre.cjs')

    writeFileSync(outside, "process.stdout.write('PRELOADED\\n')")

    const tree = confinedTree(
      h,
      cli(
        {},
        [
          "import { Worker } from 'node:worker_threads'",
          `for (const execArgv of [['--require', ${JSON.stringify(outside)}], ['-r', ${JSON.stringify(outside)}], ['--import=${outside}'], ['--loader', ${JSON.stringify(outside)}]]) {`,
          "  try { new Worker('1', { eval: true, execArgv }); console.log('started') } catch (e) { console.log('refused') }",
          '}'
        ].join('\n')
      )
    )

    const result = run(runner, tree)

    expect(result.stdout).toBe('refused\nrefused\nrefused\nrefused\n')
  })

  it('a native add-on outside the tree is never dlopen-ed', () => {
    const h = home()
    const outside = path.join(h, 'evil.node')

    writeFileSync(outside, 'not really a dylib')

    const tree = confinedTree(
      h,
      cli(
        {},
        `try { process.dlopen({ exports: {} }, ${JSON.stringify(outside)}) } catch (e) { console.log('dlopen', e.code) }\n`
      )
    )

    expect(run(runner, tree).stdout).toBe('dlopen MODULE_NOT_FOUND\n')
  })

  it('a file changed after the check is refused when it loads (critic m1): exit 78, nothing of it runs', () => {
    const h = home()
    const tree = confinedTree(
      h,
      cli(
        { 'dep/index.js': "module.exports = 'ok'" },
        "import { createRequire } from 'node:module'\nconsole.log(createRequire(import.meta.url)('dep'))\n"
      )
    )

    expect(run(runner, tree).stdout).toBe('ok\n')
    appendFileSync(path.join(tree.nodeModules, 'dep', 'index.js'), ";process.stdout.write('EVIL\\n')")

    const result = run(runner, tree)

    expect(result.status).toBe(78)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/refused: runtime\/node_modules\/dep\/index\.js is not the verified file/)
  })

  it('an executable of the tree is hashed again at spawn (the Go signer’s window, critic m1)', () => {
    const h = home()
    const tree = confinedTree(
      h,
      cli(
        { 'signer/run': '#!/bin/sh\necho signed\n' },
        [
          "import { execFileSync } from 'node:child_process'",
          "import { fileURLToPath } from 'node:url'",
          "const signer = fileURLToPath(new URL('../../../../signer/run', import.meta.url))",
          "process.stdout.write(execFileSync(signer, [], { encoding: 'utf8' }))"
        ].join('\n')
      )
    )

    chmodSync(path.join(tree.nodeModules, 'signer', 'run'), 0o755)

    const { env } = seal(tree.lockDir, h)
    const sealed = { ...tree, env }

    expect(run(runner, sealed).stdout).toBe('signed\n')
    writeFileSync(path.join(tree.nodeModules, 'signer', 'run'), '#!/bin/sh\necho forged\n')

    const result = run(runner, sealed)

    expect(result.status).toBe(78)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/refused: runtime\/node_modules\/signer\/run is not the verified file/)
  })

  it('a MANIFEST.json that is not the verified one, or no tree at all, refuses to start', () => {
    const h = home()
    const tree = confinedTree(h, cli({}, "console.log('ran')\n"))

    expect(run(runner, tree).stdout).toBe('ran\n')

    writeFileSync(path.join(tree.nodeModules, 'extra.js'), '1')
    seal(tree.lockDir, h)

    const forged = run(runner, tree)

    expect(forged.status).toBe(78)
    expect(forged.stderr).toMatch(/refused: the manifest is not the verified one/)

    const bare = run(runner, tree, { ICLONE_ACP_TREE: '', ICLONE_ACP_TREE_SHA256: '' })

    expect(bare.status).toBe(78)
    expect(bare.stderr).toMatch(/refused: started without a verified tree/)
  })
})
