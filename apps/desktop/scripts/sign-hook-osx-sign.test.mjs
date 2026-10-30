// The pack's signing pass and the `ignore` the hook hands @electron/osx-sign. osx-sign 1.3.x drops an `ignore` that is
// an array, which is how the first Developer ID release run of v0.0.3 re-signed the ACP add-ons under
// Resources/acp-native and failed ruling 33's byte check (2026-10-29). The second test runs the REAL osx-sign with an
// ad-hoc identity: no keychain, and codesign never timestamps an ad-hoc signature, so nothing goes to the network.
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import signHook, { acpNativeIgnore } from './sign-hook.mjs'

const temps = []

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')

describe('the ignore rule the hook hands osx-sign', () => {
  it('is ONE function that skips the add-ons and keeps every rule Builder passed', () => {
    const app = '/R/iclone os.app'
    const addon = `${app}/Contents/Resources/acp-native/darwin-arm64/bufferutil.node`
    const kext = `${app}/Contents/Library/X.kext`
    const plugin = `${app}/Contents/PlugIns/p.appex`
    const other = `${app}/Contents/Resources/app.asar.unpacked/node_modules/x.node`

    for (const ignore of [undefined, null, f => f.endsWith('.kext'), [/\.kext$/, 'PlugIns'], 'PlugIns']) {
      const rule = acpNativeIgnore(app, ignore)

      expect(typeof rule).toBe('function')
      expect(rule(addon)).toBe(true)
      expect(rule(other)).toBe(false)
    }

    expect(acpNativeIgnore(app, f => f.endsWith('.kext'))(kext)).toBe(true)
    expect(acpNativeIgnore(app, [/\.kext$/, 'PlugIns'])(kext)).toBe(true)
    expect(acpNativeIgnore(app, [/\.kext$/, 'PlugIns'])(plugin)).toBe(true)
    expect(acpNativeIgnore(app, 'PlugIns')(plugin)).toBe(true)
    expect(acpNativeIgnore(app, undefined)(kext)).toBe(false)
  })
})

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Fixture</string>
<key>CFBundleIdentifier</key><string>io.example.sign-hook-fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`

/** A minimal bundle: its executable, one add-on where release:mac puts them, one file Builder's own rule skips, and one
 * native module that must be signed. */
function fixtureApp() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'sign-hook-'))

  temps.push(home)

  const app = path.join(home, 'Fixture.app')
  const addon = path.join(app, 'Contents', 'Resources', 'acp-native', 'darwin-arm64', 'x.node')
  const kext = path.join(app, 'Contents', 'Library', 'Extensions', 'Fixture.kext')
  const other = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'y', 'y.node')

  for (const file of [path.join(app, 'Contents', 'MacOS', 'Fixture'), addon, kext, other]) {
    mkdirSync(path.dirname(file), { recursive: true })
    // Any Mach-O will do; its Apple signature is replaced wherever osx-sign signs, and kept wherever it skips.
    copyFileSync('/usr/bin/true', file)
  }

  writeFileSync(path.join(app, 'Contents', 'Info.plist'), PLIST)

  return { app, addon, kext, other }
}

describe('the pack signing pass, with the real osx-sign', () => {
  it.skipIf(process.platform !== 'darwin')(
    'keeps the add-ons and what Builder skips byte for byte, and signs the rest',
    async () => {
      const { app, addon, kext, other } = fixtureApp()
      const before = { addon: sha256(addon), kext: sha256(kext), other: sha256(other) }

      // Builder's buildSignOptions hands the hook ONE function (kext, PlugIns, browser downloads): the shape that broke.
      await signHook({ app, identity: '-', platform: 'darwin', type: 'distribution', ignore: f => f.endsWith('.kext') })

      expect(sha256(addon)).toBe(before.addon)
      expect(sha256(kext)).toBe(before.kext)
      expect(sha256(other)).not.toBe(before.other)
    },
    60_000
  )
})
