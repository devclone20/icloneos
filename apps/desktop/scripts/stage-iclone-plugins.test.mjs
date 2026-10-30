import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'vitest'

import {
  ICLONE_PLUGIN_MANIFEST_FILE,
  iclonePluginDirs,
  readManifestFile,
  treeFiles
} from '../electron/iclone-plugin-tree.ts'

import afterPack from './after-pack.mjs'
import { bundleRepoRuntime, PIN_PATH, readPin } from './fetch-runtime-pin.mjs'
import { tryRuntimePython } from './runtime-artifact.mjs'
import {
  REPO_PLUGINS,
  stageIclonePlugins,
  stagePackedIclonePlugins,
  verifyPackedIclonePlugins
} from './stage-iclone-plugins.mjs'

const temps = []

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3s-stage-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

function packed() {
  const resources = temp()
  const staged = stagePackedIclonePlugins(resources)
  return { resources, staged }
}

test('stages every repo plugins/iclone-* with a manifest of its shipped files, never tests/', () => {
  const { resources, staged } = packed()
  const root = path.join(resources, 'hermes-plugins')
  const manifest = readManifestFile(path.join(root, ICLONE_PLUGIN_MANIFEST_FILE))

  assert.deepEqual(staged.names, iclonePluginDirs(REPO_PLUGINS))
  assert.ok(staged.names.includes('iclone-permissions'))
  assert.ok(manifest)

  for (const name of staged.names) {
    assert.equal(fs.existsSync(path.join(root, name, 'tests')), false)
    assert.deepEqual(treeFiles(path.join(root, name)), manifest.plugins[name].files)
    // Byte-identical to the repo's shipped files.
    assert.deepEqual(manifest.plugins[name].files, treeFiles(path.join(REPO_PLUGINS, name)))
    assert.ok(manifest.plugins[name].files['__init__.py'])
    assert.ok(manifest.plugins[name].files['plugin.yaml'])
  }

  assert.deepEqual(verifyPackedIclonePlugins(resources), [])
})

test('the packed-copy check fails on a missing plugin, a changed file, shipped tests or no manifest', () => {
  const missing = packed().resources
  fs.rmSync(path.join(missing, 'hermes-plugins', 'iclone-confinement'), { recursive: true })
  assert.match(verifyPackedIclonePlugins(missing).join('\n'), /iclone-confinement is not packed/)

  const changed = packed().resources
  fs.appendFileSync(path.join(changed, 'hermes-plugins', 'iclone-permissions', 'policy.py'), '\n# x\n')
  assert.match(verifyPackedIclonePlugins(changed).join('\n'), /iclone-permissions differs/)

  const tests = packed().resources
  fs.mkdirSync(path.join(tests, 'hermes-plugins', 'iclone-permissions', 'tests'))
  assert.match(verifyPackedIclonePlugins(tests).join('\n'), /ships its tests/)

  const noManifest = packed().resources
  fs.rmSync(path.join(noManifest, 'hermes-plugins', ICLONE_PLUGIN_MANIFEST_FILE))
  assert.match(verifyPackedIclonePlugins(noManifest).join('\n'), /missing or invalid/)
})

test('m6: a packed copy consistent with its own manifest but staged from other sources than this repo fails', () => {
  const older = path.join(temp(), 'plugins')
  fs.cpSync(REPO_PLUGINS, older, { recursive: true, filter: src => !src.includes('__pycache__') })
  fs.appendFileSync(path.join(older, 'iclone-permissions', 'policy.py'), '\n# an older commit\n')
  const resources = temp()
  stageIclonePlugins({ from: older, to: path.join(resources, 'hermes-plugins') })

  // The pack is self-consistent: only the comparison with the repo catches it.
  assert.deepEqual(verifyPackedIclonePlugins(resources, { repo: older }), [])
  assert.match(
    verifyPackedIclonePlugins(resources).join('\n'),
    /iclone-permissions differs from the repo \(1 changed \(policy\.py\)\)/
  )
})

test('the packed copy is listed strictly: a cache, a dot-file or an empty directory fails it', () => {
  for (const extra of ['__pycache__/policy.cpython-311.pyc', '.hidden.py', 'sub/']) {
    const { resources } = packed()
    const file = path.join(resources, 'hermes-plugins', 'iclone-permissions', extra)

    if (extra.endsWith('/')) {
      fs.mkdirSync(file)
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'x')
    }

    assert.match(
      verifyPackedIclonePlugins(resources).join('\n'),
      /iclone-permissions differs from its manifest \(\d+ extra/,
      extra
    )
  }
})

test('r3: a plugin folder that is a symbolic link, a stray iclone-* folder or file, or a linked root fails the packed check', () => {
  {
    const { resources } = packed()
    const dir = path.join(resources, 'hermes-plugins', 'iclone-permissions')
    const elsewhere = path.join(temp(), 'iclone-permissions')
    fs.renameSync(dir, elsewhere)
    fs.symlinkSync(elsewhere, dir)

    assert.match(verifyPackedIclonePlugins(resources).join('\n'), /iclone-permissions is a symbolic link/)
  }

  {
    // Other bundled plugins share hermes-plugins/ (claude-code): not ours to judge.
    const { resources } = packed()
    fs.mkdirSync(path.join(resources, 'hermes-plugins', 'claude-code'))
    fs.writeFileSync(path.join(resources, 'hermes-plugins', 'claude-code', 'plugin.json'), '{}')

    assert.deepEqual(verifyPackedIclonePlugins(resources), [])
  }

  for (const stray of ['iclone-extra/', 'iclone-extra.py']) {
    const { resources } = packed()
    const file = path.join(resources, 'hermes-plugins', stray)

    if (stray.endsWith('/')) {
      fs.mkdirSync(file)
      fs.writeFileSync(path.join(file, '__init__.py'), 'x = 1\n')
    } else {
      fs.writeFileSync(file, 'x')
    }

    assert.match(verifyPackedIclonePlugins(resources).join('\n'), /is a stray iclone entry in hermes-plugins/, stray)
  }

  {
    const { resources } = packed()
    const root = path.join(resources, 'hermes-plugins')
    const elsewhere = path.join(temp(), 'hermes-plugins')
    fs.renameSync(root, elsewhere)
    fs.symlinkSync(elsewhere, root)

    assert.match(verifyPackedIclonePlugins(resources).join('\n'), /is not a directory/)
  }
})

test('m5: afterPack accepts a pack fixture staged with stagePackedIclonePlugins, and refuses one without plugins', async () => {
  const quiet = async fn => {
    const { log, warn } = console
    console.log = () => {}
    console.warn = () => {}
    try {
      return await fn()
    } finally {
      Object.assign(console, { log, warn })
    }
  }

  for (const platform of ['darwin', 'linux']) {
    const appOutDir = temp()
    const resources =
      platform === 'darwin'
        ? path.join(appOutDir, 'iclone os.app', 'Contents', 'Resources')
        : path.join(appOutDir, 'resources')
    fs.mkdirSync(resources, { recursive: true })
    const context = {
      appOutDir,
      electronPlatformName: platform,
      packager: { appInfo: { productFilename: 'iclone os' } }
    }

    await assert.rejects(
      quiet(() => afterPack(context)),
      /iclone Hermes plugins not packed correctly/,
      platform
    )
    stagePackedIclonePlugins(resources)
    // V3-RT: afterPack also verifies the packed runtime folder; a fixture pack carries the real pinned bundle.
    await assert.rejects(
      quiet(() => afterPack(context)),
      /Hermes runtime is not packed correctly/,
      platform
    )
    const pin = readPin(fs.readFileSync(PIN_PATH, 'utf8'))

    // Building the real bundle needs the pin's exact CPython for its bytecode (V3RT_gates.sh sets ICLONE_RUNTIME_PY).
    if (!pin.python || tryRuntimePython(pin.python, pin.pythonBuild?.executable_sha256)) {
      bundleRepoRuntime({ pin, outDir: path.join(resources, 'hermes-runtime') })
      await quiet(() => afterPack(context))
    }
  }
}, 240_000)
