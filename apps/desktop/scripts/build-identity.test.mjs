// K144 r2 (M2) — only the release pipelines build the release identity; every other pack has its own bundle id and
// declares no URL scheme, so it can never take `iclone://` away from the installed app.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, test } from 'vitest'

import {
  declaredSchemes,
  NON_RELEASE_APP_ID,
  nonReleaseBuildConfig,
  planIdentity,
  RELEASE_APP_ID,
  RELEASE_IDENTITY_FLAG
} from './build-identity.mjs'

const require = createRequire(import.meta.url)
const DESKTOP_DIR = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8'))
const read = file => fs.readFileSync(path.join(DESKTOP_DIR, 'scripts', file), 'utf8')

describe('K144 r2: release vs non-release identity', () => {
  test('package.json build is the release identity: io.cloneframe.icloneos with the iclone scheme', () => {
    assert.equal(pkg.build.appId, RELEASE_APP_ID)
    assert.deepEqual(declaredSchemes(pkg.build), ['iclone'])
  })

  test('the non-release config has its own bundle id and declares no URL scheme on any platform', () => {
    const config = nonReleaseBuildConfig(pkg.build)

    assert.equal(config.appId, NON_RELEASE_APP_ID)
    assert.notEqual(NON_RELEASE_APP_ID, RELEASE_APP_ID)
    assert.deepEqual(declaredSchemes(config), [])
    assert.equal(config.protocols, undefined)
    assert.equal(config.linux.desktop.entry.MimeType, undefined)
    // Everything else is the release config (same product, same files, same hooks).
    assert.equal(config.productName, pkg.build.productName)
    assert.deepEqual(config.files, pkg.build.files)
    assert.deepEqual(config.mac.extendInfo, pkg.build.mac.extendInfo)
    assert.equal(config.afterPack, pkg.build.afterPack)
    // The input is not modified.
    assert.equal(pkg.build.appId, RELEASE_APP_ID)
    assert.deepEqual(declaredSchemes(pkg.build), ['iclone'])
  })

  test('platform-level protocols, CFBundleURLTypes and Linux scheme handlers are all stripped; other MIME types stay', () => {
    const config = nonReleaseBuildConfig({
      appId: RELEASE_APP_ID,
      protocols: { name: 'p', schemes: ['iclone'] },
      mac: {
        protocols: [{ name: 'm', schemes: 'iclone' }],
        extendInfo: { CFBundleURLTypes: [{ CFBundleURLSchemes: ['iclone'] }], NSFoo: 'kept' }
      },
      win: { protocols: [{ name: 'w', schemes: ['iclone'] }] },
      linux: { desktop: { entry: { MimeType: 'text/plain;x-scheme-handler/iclone;' } } }
    })

    assert.deepEqual(declaredSchemes(config), [])
    assert.equal(config.mac.extendInfo.NSFoo, 'kept')
    assert.equal(config.linux.desktop.entry.MimeType, 'text/plain;')
  })

  test('the non-release config passes electron-builder schema validation', async () => {
    const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js')
    await validateConfiguration(nonReleaseBuildConfig(pkg.build), { isEnabled: false, add() {} })
  })

  test('a config that is not the release one is refused (the derivation never guesses)', () => {
    assert.throws(() => nonReleaseBuildConfig(undefined), /no "build" config/)
    assert.throws(() => nonReleaseBuildConfig({ appId: NON_RELEASE_APP_ID }), /expected io\.cloneframe\.icloneos/)
  })

  test('non-release is the default: no flag → non-release; the flag → release and is not passed to electron-builder', () => {
    assert.deepEqual(planIdentity(['--dir', '--publish', 'never']), {
      release: false,
      args: ['--dir', '--publish', 'never'],
      needsConfigFile: true
    })
    assert.deepEqual(planIdentity(['--mac', '-c.forceCodeSigning=true', RELEASE_IDENTITY_FLAG]), {
      release: true,
      args: ['--mac', '-c.forceCodeSigning=true'],
      needsConfigFile: false
    })
    // Dot-notation overrides are fine; a config FILE would replace the derived one.
    assert.equal(planIdentity(['-c.mac.identity=null']).release, false)

    for (const argv of [['--config', 'x.yml'], ['-c', 'x.json'], ['--config=x.yml']]) {
      assert.throws(() => planIdentity(argv), /cannot take its own config file/, argv.join(' '))
    }
  })
})

describe('K144 r2 wiring', () => {
  test('run-electron-builder applies the plan: non-release packs get the derived config file', () => {
    const runner = read('run-electron-builder.mjs')

    assert.match(runner, /planIdentity\(process\.argv\.slice\(2\)\)/)
    assert.match(runner, /if \(identity\.needsConfigFile\) \{[\s\S]*nonReleaseBuildConfig\(pkg\.build\)/)
    assert.match(runner, /args\.push\("--config", configFile\)/)
    assert.match(runner, /args\.push\(\.\.\.identity\.args\)/)
    assert.doesNotMatch(runner, /args\.push\(\.\.\.process\.argv/)
  })

  test('only release-mac and release-linux pass the release flag; the npm scripts never do', () => {
    const scripts = fs.readdirSync(path.join(DESKTOP_DIR, 'scripts')).filter(f => /\.(mjs|cjs|js)$/.test(f))
    const users = scripts.filter(f => !f.endsWith('.test.mjs') && read(f).includes('RELEASE_IDENTITY_FLAG'))

    assert.deepEqual(users.sort(), ['build-identity.mjs', 'release-linux.mjs', 'release-mac.mjs'])
    assert.equal((read('release-mac.mjs').match(/RELEASE_IDENTITY_FLAG\n/g) ?? []).length, 2, 'both mac packs')

    for (const [name, command] of Object.entries(pkg.scripts)) {
      assert.ok(!command.includes(RELEASE_IDENTITY_FLAG), name)
    }
  })
})
