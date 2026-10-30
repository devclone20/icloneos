// The electron-builder config contract of V3-R2: what the pack must not carry (K146) and the Bluetooth purpose
// strings macOS shows (K149). The pack itself is proved by an unsigned --dir listing (RESUME/run.nosync/scratch).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

import { PURPOSE_ALLOWED } from './sign-hook.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { build } = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'))
const globs = build.files.filter(entry => typeof entry === 'string')

test('K146: public/** is not packed beside dist/ (Vite already copies public/ into dist/)', () => {
  assert.ok(!globs.some(glob => /^public(\/|$)/.test(glob)), `build.files: ${globs.join(', ')}`)
  assert.ok(globs.includes('dist/**'))
  // The window icon's packaged candidate that remains: dist/apple-touch-icon.png comes from public/ via Vite.
  assert.ok(fs.existsSync(path.join(desktop, 'public', 'apple-touch-icon.png')))
})

test('K149: Bluetooth purpose strings are icloneOS copy, plain and honest, never Electron’s generic line', () => {
  for (const key of ['NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription']) {
    const text = build.mac.extendInfo[key]

    assert.equal(typeof text, 'string', key)
    assert.match(text, /^iclone os does not use Bluetooth\./, key)
    assert.doesNotMatch(text, /This app needs access/i, key)
    assert.ok(PURPOSE_ALLOWED.includes(key), `${key} must survive sign-hook's purpose strip`)
  }
})
