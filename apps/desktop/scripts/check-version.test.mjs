import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'vitest'

import { versionProblems } from './check-version.mjs'

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'))

const pkg = (version, mac = { bundleShortVersion: version, bundleVersion: version }, build = {}) => ({
  version,
  build: { ...build, mac }
})

describe('version:check (three numbers, ruling 0)', () => {
  test('the repo is 0.0.4 in package.json, CFBundleShortVersionString and CFBundleVersion', () => {
    assert.equal(PKG.version, '0.0.4')
    assert.equal(PKG.build.mac.bundleShortVersion, '0.0.4')
    assert.equal(PKG.build.mac.bundleVersion, '0.0.4')
    assert.deepEqual(versionProblems(PKG), [])
  })

  test('the script passes on the repo and says the three numbers', () => {
    const run = spawnSync(process.execPath, [path.join(DESKTOP, 'scripts', 'check-version.mjs')], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /ok — v0\.0\.4 /)
  })

  test('accepts exactly 0.0.3 in all three places', () => {
    assert.deepEqual(versionProblems(pkg('0.0.3')), [])
  })

  test('refuses the four-digit form anywhere', () => {
    assert.match(
      versionProblems(pkg('0.0.3', { bundleShortVersion: '0.0.0.3', bundleVersion: '0.0.3' })).join(),
      /bundleShortVersion/
    )
    assert.match(
      versionProblems(pkg('0.0.3', { bundleShortVersion: '0.0.3', bundleVersion: '0.0.0.3' })).join(),
      /bundleVersion/
    )
    assert.match(versionProblems(pkg('0.0.0.3')).join(), /three numbers/)
  })

  test('refuses a missing pin and a build.buildVersion that would steer CFBundleVersion', () => {
    assert.match(
      versionProblems(pkg('0.0.3', { bundleShortVersion: '0.0.3' })).join(),
      /bundleVersion \(CFBundleVersion\) is \(missing\)/
    )
    assert.match(versionProblems(pkg('0.0.3', {})).join(), /bundleShortVersion/)
    assert.match(
      versionProblems(
        pkg('0.0.3', { bundleShortVersion: '0.0.3', bundleVersion: '0.0.3' }, { buildVersion: '0.0.3.7' })
      ).join(),
      /build\.buildVersion is set/
    )
  })

  test('the shipped 0.0.0.2-labelled release is older: 0.0.2 and below are refused, 0.0.3 is not', () => {
    assert.match(versionProblems(pkg('0.0.2')).join(), /not newer than the shipped release 0\.0\.0\.2/)
    assert.match(versionProblems(pkg('0.0.1')).join(), /not newer/)
    assert.deepEqual(versionProblems(pkg('0.0.3')), [])
    // A history that ends at a carried label (0.0.1.0 = 0.0.10) is read by value, not digits.
    assert.match(
      versionProblems(pkg('0.0.3'), ['0.0.0.2', '0.0.1.0']).join(),
      /not newer than the shipped release 0\.0\.1\.0/
    )
  })
})
