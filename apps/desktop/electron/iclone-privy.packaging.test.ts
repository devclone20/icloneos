import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { test } from 'vitest'

/**
 * The wallet login was DEAD in every installed build — silently. The login
 * window is served from `iclone/privy/` on a loopback server, and the
 * packaged app simply did not ship that directory: `resolvePrivyDir()`
 * returned null, init logged one console line nobody reads, and every click
 * on the wallet became a no-op. Dev never showed it, because dev resolves the
 * repo checkout. These tests pin the packaging contract so it cannot quietly
 * regress again.
 *
 * The island ships INSIDE app.asar (P7 decision 7b): the window it opens has
 * its own preload, so its HTML/JS must sit under the asar integrity fuse, not
 * as loose files in Contents/Resources.
 */

const desktopRoot = path.resolve(__dirname, '..')

type CopyEntry = { filter?: string[]; from: string; to: string }

const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8')) as {
  build: { asarUnpack?: string[]; extraResources?: Array<CopyEntry | string>; files?: Array<CopyEntry | string> }
}

// resolvePrivyDir()'s `<app.getAppPath()>/iclone-privy` candidate — the name
// here and the name there must agree or the shipped files are invisible.
const PACKAGED_DIR = 'iclone-privy'

// REQUIRED_PRIVY_FILES in electron/iclone-privy.ts — all three must exist for
// the resolver to accept a directory at all.
const REQUIRED = ['privy.html', 'privy-login.js', 'privy-preload.cjs']

function findEntry(list: Array<CopyEntry | string> | undefined) {
  return list?.find((entry): entry is CopyEntry => typeof entry === 'object' && entry.to === PACKAGED_DIR)
}

test('the build ships the privy login assets inside app.asar (build.files)', () => {
  const entry = findEntry(packageJson.build.files)

  assert.ok(
    entry,
    `build.files must carry an entry with to: "${PACKAGED_DIR}" — without it the wallet is dead in every installed build`
  )
})

test('the island is not shipped as loose files outside app.asar', () => {
  assert.equal(
    findEntry(packageJson.build.extraResources),
    undefined,
    'an extraResources copy would put the island outside the asar integrity fuse'
  )
  assert.ok(
    (packageJson.build.asarUnpack ?? []).every(glob => !glob.includes('privy')),
    'asarUnpack must not pull the island back out of app.asar'
  )
})

test('every file the resolver requires is in the shipped filter, and nothing else', () => {
  const entry = findEntry(packageJson.build.files)

  assert.ok(entry?.filter)
  assert.deepEqual([...entry.filter].sort(), [...REQUIRED].sort())
})

test('the source directory actually contains those files', () => {
  const entry = findEntry(packageJson.build.files)

  assert.ok(entry)

  const source = path.resolve(desktopRoot, entry.from)

  for (const file of REQUIRED) {
    assert.ok(
      fs.existsSync(path.join(source, file)),
      `${path.join(entry.from, file)} does not exist — the build.files entry would ship nothing`
    )
  }
})

test('the resolver looks for the island inside the app root', () => {
  const source = fs.readFileSync(path.join(desktopRoot, 'electron', 'iclone-privy.ts'), 'utf8')

  assert.match(source, /path\.join\(appRoot, 'iclone-privy'\)/)
})
