// Chromium's licence file: staged from the Electron dist the pack uses, and verified byte for byte in the pack.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'vitest'

import { electronDistDir } from './electron-dist.mjs'
import {
  CHROMIUM_LICENSES_FILE,
  packedElectronDist,
  stageChromiumLicenses,
  STAGED_CHROMIUM_LICENSES,
  verifyPackedChromiumLicenses
} from './electron-licenses.mjs'

const temps = []

function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.push(dir)

  return dir
}

function fakeDist(html = '<html>chromium licences</html>') {
  const dist = temp('electron-dist-')
  fs.writeFileSync(path.join(dist, CHROMIUM_LICENSES_FILE), html)

  return dist
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

test('package.json extraResources reads the staged file', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const row = pkg.build.extraResources.find(r => r.to === CHROMIUM_LICENSES_FILE)

  assert.deepEqual(row, { from: STAGED_CHROMIUM_LICENSES.split(path.sep).join('/'), to: CHROMIUM_LICENSES_FILE })
})

test('the pack uses the dist run-electron-builder configured, else the installed package', () => {
  assert.equal(packedElectronDist({ packager: { config: { electronDist: '/x/dist' } } }), '/x/dist')
  assert.equal(packedElectronDist({ packager: { config: {} } }), electronDistDir())
  assert.equal(packedElectronDist({}), electronDistDir())
})

test('a relative electronDist resolves against the project directory, as electron-builder does, not the cwd', () => {
  const projectDir = path.join(os.tmpdir(), 'project-dir-not-cwd')
  const context = { packager: { config: { electronDist: '../../node_modules/electron/dist' }, projectDir } }

  assert.notEqual(path.resolve(projectDir), process.cwd())
  assert.equal(packedElectronDist(context), path.resolve(projectDir, '../../node_modules/electron/dist'))
  assert.equal(packedElectronDist({ packager: { config: { electronDist: '/x/dist' }, projectDir } }), '/x/dist')
})

test('staging copies the dist file to the staged path; a dist without it is refused with the install command', () => {
  const dist = fakeDist()
  const to = path.join(temp('staged-'), 'build', 'electron-licenses', CHROMIUM_LICENSES_FILE)

  assert.equal(stageChromiumLicenses({ dist, to }), to)
  assert.equal(fs.readFileSync(to, 'utf8'), '<html>chromium licences</html>')

  assert.throws(
    () => stageChromiumLicenses({ dist: temp('empty-dist-'), to }),
    /LICENSES\.chromium\.html not found .*install\.js/
  )
  assert.throws(() => stageChromiumLicenses({ dist: null, to }), /electron is not installed/)
})

test('verification: exact copy passes; a missing or different packed file, or no dist, is a problem', () => {
  const dist = fakeDist()
  const resources = temp('resources-')

  assert.deepEqual(verifyPackedChromiumLicenses(resources, dist), [
    `${CHROMIUM_LICENSES_FILE} is not in the packed Resources (${resources})`
  ])

  fs.copyFileSync(path.join(dist, CHROMIUM_LICENSES_FILE), path.join(resources, CHROMIUM_LICENSES_FILE))
  assert.deepEqual(verifyPackedChromiumLicenses(resources, dist), [])

  fs.appendFileSync(path.join(resources, CHROMIUM_LICENSES_FILE), '\n')
  const problems = verifyPackedChromiumLicenses(resources, dist)

  assert.equal(problems.length, 1)
  assert.match(problems[0], /in the pack \(sha256 [0-9a-f]{64}\) is not the Electron dist's \(sha256 [0-9a-f]{64}\)/)

  assert.deepEqual(verifyPackedChromiumLicenses(resources, temp('empty-dist-')), [
    `${CHROMIUM_LICENSES_FILE} is not in the Electron dist (${temps.at(-1)})`
  ])
  assert.deepEqual(verifyPackedChromiumLicenses(resources, null), [
    `${CHROMIUM_LICENSES_FILE} is not in the Electron dist (electron is not installed)`
  ])
})

test('this repo: the installed Electron dist carries the file', () => {
  assert.ok(fs.existsSync(path.join(electronDistDir(), CHROMIUM_LICENSES_FILE)))
})
