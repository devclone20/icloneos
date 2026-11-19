// K146 — afterPack removes Electron's default app from every packed bundle, before signing.
//
// The tests must not depend on what else afterPack checks (V3-S verifies the packed iclone Hermes plugins first and
// throws on a pack without them): the removal itself is tested through `removeDefaultApp`, and the afterPack wiring
// runs on a fixture that carries a valid plugin set whenever that gate exists in this tree.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import asar from '@electron/asar'
import { beforeAll, test } from 'vitest'

import afterPack, { removeDefaultApp } from './after-pack.mjs'
import { packedDevFixtureLeaks } from './dev-fixtures-check.mjs'
import { ADDON_OUTPUT, assertPinnedAddon } from './build-iclone-fsevents.mjs'
import { electronDistDir } from './electron-dist.mjs'
import { CHROMIUM_LICENSES_FILE } from './electron-licenses.mjs'
import { packedAddonPath } from './iclone-fsevents-check.mjs'

const PLATFORMS = ['darwin', 'linux', 'win32']

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

/** V3-S's packed-plugins gate, when this tree has it (null otherwise). */
async function pluginGate() {
  const file = fileURLToPath(new URL('./stage-iclone-plugins.mjs', import.meta.url))

  return fs.existsSync(file) ? import(/* @vite-ignore */ pathToFileURL(file).href) : null
}

/** V3-RT's pinned runtime bundle (built once from the repository when this tree has the runtime pin; null otherwise). */
let bundled = null

async function runtimeBundleDir() {
  const file = fileURLToPath(new URL('./fetch-runtime-pin.mjs', import.meta.url))

  if (!fs.existsSync(file)) {
    return null
  }

  if (!bundled) {
    const { BUNDLE_DIR, PIN_PATH, bundleRepoRuntime, readPin, verifyPackedRuntime } = await import(
      /* @vite-ignore */ pathToFileURL(file).href
    )
    const pin = readPin(fs.readFileSync(PIN_PATH, 'utf8'))

    if (pin.source === 'repo' && (await verifyPackedRuntime(BUNDLE_DIR, pin)).length > 0) {
      await quiet(() => bundleRepoRuntime({ pin }))
    }

    bundled = BUNDLE_DIR
  }

  return bundled
}

async function packed(platform, { withPlugins = false, asarExtra = {} } = {}) {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k146-pack-'))
  const resources =
    platform === 'darwin'
      ? path.join(appOutDir, 'iclone os.app', 'Contents', 'Resources')
      : path.join(appOutDir, 'resources')
  fs.mkdirSync(resources, { recursive: true })
  fs.writeFileSync(path.join(resources, 'default_app.asar'), 'electron default app')
  // r4d: a real archive (afterPack lists it to prove no dev fixture is packed).
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k146-app-'))

  fs.writeFileSync(path.join(appDir, 'package.json'), '{"name":"our-app","main":"dist/electron-main.mjs"}')
  fs.mkdirSync(path.join(appDir, 'dist'))
  fs.writeFileSync(path.join(appDir, 'dist', 'electron-main.mjs'), 'export {}\n')

  for (const [rel, body] of Object.entries(asarExtra)) {
    fs.mkdirSync(path.dirname(path.join(appDir, rel)), { recursive: true })
    fs.writeFileSync(path.join(appDir, rel), body)
  }

  await asar.createPackage(appDir, path.join(resources, 'app.asar'))
  fs.rmSync(appDir, { force: true, recursive: true })

  const gate = withPlugins ? await pluginGate() : null

  if (gate) {
    gate.stageIclonePlugins({ to: path.join(resources, 'hermes-plugins') })
  }

  // V3-RT (merge of main, declared conflict resolution): afterPack also verifies the packed runtime bundle on macOS and
  // Linux, so the wiring fixture carries the pinned bundle whenever this tree has that gate.
  const runtime = withPlugins ? await runtimeBundleDir() : null

  if (runtime && platform !== 'win32') {
    fs.cpSync(runtime, path.join(resources, 'hermes-runtime'), { recursive: true })
  }

  // afterPack also refuses a pack without the exact Chromium licence file of the dist it packed (every platform).
  if (withPlugins) {
    fs.copyFileSync(path.join(electronDistDir(), CHROMIUM_LICENSES_FILE), path.join(resources, CHROMIUM_LICENSES_FILE))
  }

  // FSEV (e1de8634fd): afterPack refuses a macOS pack without the pinned FSEvents addon (stage-iclone-plugins m5 proves
  // the refusal), so the wiring fixture carries the pinned build; assertPinnedAddon throws if this tree has none.
  if (withPlugins && platform === 'darwin') {
    const addon = packedAddonPath(path.join(appOutDir, 'iclone os.app'))

    assertPinnedAddon(ADDON_OUTPUT)
    fs.mkdirSync(path.dirname(addon), { recursive: true })
    fs.copyFileSync(ADDON_OUTPUT, addon)
  }

  return {
    resources,
    context: { appOutDir, electronPlatformName: platform, packager: { appInfo: { productFilename: 'iclone os' } } }
  }
}

// Building the pinned bundle compiles the runtime's bytecode (tens of seconds); it is done once, before the rows, when
// the build folder does not already hold it.
beforeAll(() => runtimeBundleDir(), 300_000)

test('K146: removeDefaultApp drops default_app.asar and keeps app.asar on macOS, Linux and Windows', async () => {
  for (const platform of PLATFORMS) {
    const { context, resources } = await packed(platform)

    const removed = await quiet(() => removeDefaultApp(context))

    assert.deepEqual(removed, [path.join(resources, 'default_app.asar')], platform)
    assert.equal(fs.existsSync(path.join(resources, 'default_app.asar')), false, platform)
    assert.equal(fs.existsSync(path.join(resources, 'app.asar')), true, platform)
  }
})

test('K146: afterPack removes the default app on every platform (wiring)', async () => {
  for (const platform of PLATFORMS) {
    const { context, resources } = await packed(platform, { withPlugins: true })

    await quiet(() => afterPack(context))

    assert.equal(fs.existsSync(path.join(resources, 'default_app.asar')), false, platform)
    assert.equal(fs.existsSync(path.join(resources, 'app.asar')), true, platform)
  }
})

test('K146: a pack without the default app is left alone', async () => {
  const { context, resources } = await packed('darwin')
  fs.rmSync(path.join(resources, 'default_app.asar'))

  assert.deepEqual(await quiet(() => removeDefaultApp(context)), [])
})

test("afterPack refuses a pack without Chromium's licence file, on every platform", async () => {
  for (const platform of PLATFORMS) {
    const { context, resources } = await packed(platform, { withPlugins: true })
    fs.rmSync(path.join(resources, CHROMIUM_LICENSES_FILE))

    await assert.rejects(
      quiet(() => afterPack(context)),
      error =>
        error.message.includes(
          `[after-pack] Chromium licences not packed correctly: ${CHROMIUM_LICENSES_FILE} is not in the packed Resources`
        ),
      platform
    )
  }
})

test("afterPack refuses a pack whose Chromium licence file is not the packed dist's, byte for byte", async () => {
  const { context, resources } = await packed('darwin', { withPlugins: true })
  fs.appendFileSync(path.join(resources, CHROMIUM_LICENSES_FILE), '<!-- -->')

  await assert.rejects(
    quiet(() => afterPack(context)),
    error =>
      /Chromium licences not packed correctly: LICENSES\.chromium\.html in the pack \(sha256 [0-9a-f]{64}\) is not the Electron dist's/.test(
        error.message
      )
  )
})

// v0.0.9 r4d (eng r4-m2): the packed app never carries the dev fixture art. Red on 52cae17554 (no such check).
test('r4-m2: afterPack refuses a pack whose app.asar or Resources carry fixtures/, on every platform', async () => {
  for (const platform of PLATFORMS) {
    const leaky = await packed(platform, { withPlugins: true, asarExtra: { 'fixtures/inft-art/101-aurora.svg': '<svg/>' } })

    assert.deepEqual(packedDevFixtureLeaks(leaky.resources), [
      'app.asar carries a dev fixture: fixtures',
      'app.asar carries a dev fixture: fixtures/inft-art',
      'app.asar carries a dev fixture: fixtures/inft-art/101-aurora.svg'
    ], platform)
    await assert.rejects(quiet(() => afterPack(leaky.context)), /dev fixtures in the pack/, platform)

    const extra = await packed(platform, { withPlugins: true })

    fs.mkdirSync(path.join(extra.resources, 'fixtures', 'inft-art'), { recursive: true })
    fs.writeFileSync(path.join(extra.resources, 'fixtures', 'inft-art', '101-aurora.svg'), '<svg/>')
    await assert.rejects(quiet(() => afterPack(extra.context)), /Resources carries a dev fixture: fixtures/, platform)

    const clean = await packed(platform, { withPlugins: true })

    assert.deepEqual(packedDevFixtureLeaks(clean.resources), [], platform)
  }
}, 120_000)

