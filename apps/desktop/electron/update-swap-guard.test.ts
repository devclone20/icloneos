import assert from 'node:assert/strict'
import path from 'node:path'

import { test } from 'vitest'

import { mayReplaceRunningBundle } from './update-swap-guard'

const INSTALL = '/Users/o/.hermes/hermes-agent'
const REBUILT = `${INSTALL}/apps/desktop/release/mac-arm64/Hermes.app`

test('the bundle the updater rebuilds may be replaced', () => {
  assert.equal(mayReplaceRunningBundle(REBUILT, INSTALL, path), true)
})

test('a Hermes.app under the release tree may be replaced, whatever the arch dir', () => {
  assert.equal(mayReplaceRunningBundle(`${INSTALL}/apps/desktop/release/mac/Hermes.app`, INSTALL, path), true)
  assert.equal(mayReplaceRunningBundle(`${INSTALL}/apps/desktop/release/mac-universal/Hermes.app`, INSTALL, path), true)
})

test('a fork build parked INSIDE the release tree is still not Hermes.app', () => {
  assert.equal(mayReplaceRunningBundle(`${INSTALL}/apps/desktop/release/mac-arm64/iclone os.app`, INSTALL, path), false)
})

test("the owner's installed app is NOT replaceable — this is the whole point", () => {
  // The real hazard: clicking "Update now" inside iclone os would otherwise
  // ditto a stock Hermes.app over it and delete the .old copy on success.
  assert.equal(mayReplaceRunningBundle('/Applications/iclone os.app', INSTALL, path), false)
  assert.equal(mayReplaceRunningBundle('/Users/o/Applications/iclone os.app', INSTALL, path), false)
  assert.equal(mayReplaceRunningBundle('/Applications/Something Else.app', INSTALL, path), false)
})

test('upstream keeping its OWN installed copy fresh still works', () => {
  // The guard is product identity, not location. Refusing this case too would
  // break the legitimate flow the swap exists for.
  assert.equal(mayReplaceRunningBundle('/Applications/Hermes.app', INSTALL, path), true)
  assert.equal(mayReplaceRunningBundle('/Users/o/Applications/Hermes.app', INSTALL, path), true)
})

test('a sibling directory that merely shares a prefix is judged on its name alone', () => {
  // Outside the release tree, so it passes only because it is still Hermes.app.
  assert.equal(
    mayReplaceRunningBundle(`${INSTALL}/apps/desktop/release-backup/mac-arm64/Hermes.app`, INSTALL, path),
    true
  )
  assert.equal(mayReplaceRunningBundle(`${INSTALL}/apps/desktop/releases/x.app`, INSTALL, path), false)
})

test('a path that escapes back out of the release tree is refused', () => {
  assert.equal(
    mayReplaceRunningBundle(`${INSTALL}/apps/desktop/release/../../../../Applications/iclone os.app`, INSTALL, path),
    false
  )
})

test('the name must match exactly — no near misses', () => {
  assert.equal(mayReplaceRunningBundle('/Applications/hermes.app', INSTALL, path), false)
  assert.equal(mayReplaceRunningBundle('/Applications/Hermes 2.app', INSTALL, path), false)
  assert.equal(mayReplaceRunningBundle('/Applications/My Hermes.app', INSTALL, path), false)
})

test('the release directory itself is not a bundle to replace', () => {
  assert.equal(mayReplaceRunningBundle(`${INSTALL}/apps/desktop/release`, INSTALL, path), false)
})

test('missing information answers no — "I cannot tell" must never mean "replace it"', () => {
  assert.equal(mayReplaceRunningBundle(null, INSTALL, path), false)
  assert.equal(mayReplaceRunningBundle(undefined, INSTALL, path), false)
  assert.equal(mayReplaceRunningBundle('', INSTALL, path), false)
  assert.equal(mayReplaceRunningBundle(REBUILT, null, path), false)
  assert.equal(mayReplaceRunningBundle(REBUILT, '', path), false)
})

test('a differently named bundle inside a foreign release tree is still refused', () => {
  assert.equal(
    mayReplaceRunningBundle(
      `${INSTALL}/apps/desktop/release/mac-arm64/iclone os.app`,
      '/Users/o/.hermes/other-agent',
      path
    ),
    false
  )
})
