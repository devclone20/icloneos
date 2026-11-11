// FSEV (L1-4): the packed and the Team-signed FSEvents addon are checked against the committed pin.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'

import { checkIcloneFsevents, packedAddonPath } from './iclone-fsevents-check.mjs'

const sha256 = data => createHash('sha256').update(data).digest('hex')

function fakeApp(bytes, { oldModule = false } = {}) {
  const app = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fsev-check-')), 'x.app')
  const file = packedAddonPath(app)

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)

  if (oldModule) {
    fs.mkdirSync(path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'dist', 'node_modules', 'fsevents'), {
      recursive: true
    })
  }

  return app
}

const bytes = Buffer.from('built addon bytes')
const pin = { sha256: sha256(bytes), sha256Unsigned: sha256(Buffer.from('stripped')), source: sha256(bytes) }

test('unsigned: the pinned bytes pass; one byte off, a missing addon, or the old module fail', () => {
  assert.deepEqual(checkIcloneFsevents(fakeApp(bytes), { pin }).problems, [])
  assert.match(checkIcloneFsevents(fakeApp(Buffer.from('built addon bytez')), { pin }).problems.join(), /not the pinned build/)
  assert.match(checkIcloneFsevents(fakeApp(bytes, { oldModule: true }), { pin }).problems.join(), /fsevents npm module/)
  assert.match(checkIcloneFsevents(path.join(os.tmpdir(), 'nope.app'), { pin }).problems.join(), /no app\.asar\.unpacked/)
})

test('signed: strict verify, the Team ID, and the pinned bytes under the signature', () => {
  const app = fakeApp(Buffer.from('signed'))
  const run = team => (command, args) =>
    args[0] === '-dv' ? { status: 0, stdout: '', stderr: `TeamIdentifier=${team}\n` } : { status: 0, stdout: '', stderr: '' }
  const good = { signed: true, team: 'ABCDE12345', pin, run: run('ABCDE12345'), stripped: () => pin.sha256Unsigned }

  assert.deepEqual(checkIcloneFsevents(app, good).problems, [])
  assert.match(checkIcloneFsevents(app, { ...good, run: run('ZZZZZ99999') }).problems.join(), /signed by ZZZZZ99999/)
  assert.match(checkIcloneFsevents(app, { ...good, stripped: () => pin.sha256 }).problems.join(), /without its signature/)
  assert.match(
    checkIcloneFsevents(app, { ...good, run: () => ({ status: 1, stdout: '', stderr: '' }) }).problems.join(),
    /codesign --verify --strict fails/
  )
  assert.match(checkIcloneFsevents(app, { ...good, team: null }).problems.join(), /needs --team/)
})
