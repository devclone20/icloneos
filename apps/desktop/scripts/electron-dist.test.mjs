// The scripts find the installed Electron by its package and path.txt, and never download it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'vitest'

import {
  electronDistDir,
  electronPackageDir,
  findElectronBinary,
  INSTALL_ELECTRON_COMMAND,
  installElectronCommand
} from './electron-dist.mjs'

const temps = []

function fakePackage({ pathTxt = 'Electron.app/Contents/MacOS/Electron', binary = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-pkg-'))
  temps.push(dir)

  if (pathTxt !== null) {
    fs.writeFileSync(path.join(dir, 'path.txt'), `${pathTxt}\n`)
  }

  if (binary && pathTxt) {
    const file = path.join(dir, 'dist', pathTxt)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '#!/bin/sh\n')
  }

  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

test('the package and its dist resolve from electron/package.json; null when electron is not installed', () => {
  assert.equal(
    electronPackageDir(() => '/x/node_modules/electron/package.json'),
    '/x/node_modules/electron'
  )
  assert.equal(electronDistDir('/x/node_modules/electron'), path.join('/x/node_modules/electron', 'dist'))
  assert.equal(
    electronPackageDir(() => {
      throw new Error("Cannot find module 'electron/package.json'")
    }),
    null
  )
  assert.equal(electronDistDir(null), null)
})

test('the binary is the one path.txt names inside dist', () => {
  const dir = fakePackage()

  assert.equal(findElectronBinary(dir), path.join(dir, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'))
})

test('no path.txt, or a named binary that is not there, names the install command instead of downloading', () => {
  for (const dir of [fakePackage({ pathTxt: null }), fakePackage({ binary: false })]) {
    assert.throws(findElectronBinary.bind(null, dir, {}), error => {
      assert.match(error.message, /Electron binary not found under .*dist/)
      // The hint runs the install.js of the package that was resolved, wherever npm put it.
      assert.ok(error.message.includes(`node "${path.join(dir, 'install.js')}"`), error.message)
      assert.match(error.message, /never download/)

      return true
    })
  }

  assert.throws(
    () => findElectronBinary(null, {}),
    error => error.message.includes(INSTALL_ELECTRON_COMMAND)
  )
})

test('the install hint names the resolved package, and the repo-root form only when none resolved', () => {
  assert.equal(
    installElectronCommand('/w/apps/desktop/node_modules/electron'),
    `node "${path.join('/w/apps/desktop/node_modules/electron', 'install.js')}"`
  )
  assert.equal(installElectronCommand(null), INSTALL_ELECTRON_COMMAND)
})

test('ELECTRON_OVERRIDE_DIST_PATH wins: <override>/<path.txt>, or <override>/electron without a path.txt', () => {
  const pkg = fakePackage()
  const override = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-override-'))
  temps.push(override)

  const named = path.join(override, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  fs.mkdirSync(path.dirname(named), { recursive: true })
  fs.writeFileSync(named, '#!/bin/sh\n')
  fs.writeFileSync(path.join(override, 'electron'), '#!/bin/sh\n')

  const env = { ELECTRON_OVERRIDE_DIST_PATH: override }

  // The package's own dist binary exists too; the override still wins.
  assert.equal(findElectronBinary(pkg, env), named)
  assert.equal(findElectronBinary(fakePackage({ pathTxt: null }), env), path.join(override, 'electron'))
  assert.equal(findElectronBinary(null, env), path.join(override, 'electron'))
})

test('an override whose binary is missing is refused, never downloaded, and never falls back to the package dist', () => {
  const pkg = fakePackage()
  const override = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-override-'))
  temps.push(override)

  assert.throws(findElectronBinary.bind(null, pkg, { ELECTRON_OVERRIDE_DIST_PATH: override }), error => {
    assert.ok(
      error.message.includes(path.join(override, 'Electron.app', 'Contents', 'MacOS', 'Electron')),
      error.message
    )
    assert.match(error.message, /ELECTRON_OVERRIDE_DIST_PATH/)
    assert.match(error.message, /never download/)

    return true
  })
})

test('this repo: the installed binary is found without require("electron")', () => {
  const binary = findElectronBinary()

  assert.ok(fs.existsSync(binary), binary)
  assert.ok(binary.startsWith(path.join(electronDistDir(), path.sep)), binary)
})
