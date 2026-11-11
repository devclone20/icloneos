import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { credentialReadFloor, credentialWriteFloor } from '../iclone-permissions/classify-policy'

import { diskFold } from './disk-name'
import { oneShotFile } from './one-shot'
import { fileRunsOrHoldsKeys } from './profiles'

interface DiskNames {
  folds: Record<string, string>
  credential: [string, boolean][]
}

const corpus: DiskNames = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '../../../../tests/fixtures/iclone_disk_names.json'), 'ascii')
)

describe('G27: names as the disk reads them, one corpus with agent/disk_name.py', () => {
  it('every folding code point gets the corpus answer', () => {
    const wrong = Object.entries(corpus.folds).filter(([point, want]) => diskFold(String.fromCodePoint(Number.parseInt(point, 16))) !== want)

    expect(wrong).toEqual([])
  })

  const home = path.join(os.tmpdir(), 'g27-no-such-home', 'José')

  for (const [form, other] of [
    ['NFC', 'NFD'],
    ['NFD', 'NFC']
  ] as const) {
    it.each(corpus.credential)(`the credential floor judges %s as %s, home in ${form}`, (rel, listed) => {
      const floor = credentialWriteFloor('write_file', path.join(home.normalize(other), rel), home.normalize(form))

      expect(floor !== null).toBe(listed)
    })
  }

  it.each(corpus.credential)('the read floor judges %s as %s with the Seatbelt off, and adds nothing while it is on', (rel, listed) => {
    expect(credentialReadFloor('read_file', path.join(home, rel), home, () => true) !== null).toBe(listed)
    expect(credentialReadFloor('search_files', path.join(home, rel), home, () => true) !== null).toBe(listed)
    expect(credentialReadFloor('read_file', path.join(home, rel), home, () => false)).toBeNull()
    expect(credentialReadFloor('write_file', path.join(home, rel), home, () => true)).toBeNull()
  })

  it('the sheet holds a disk alias of a key folder like the true name', () => {
    const spec = { denied: ['/h/.ssh'], protectedWrites: ['/h/.zshrc'] }

    expect(fileRunsOrHoldsKeys('/h/.ſsh/config', spec, '/h')).toBe(true)
    expect(fileRunsOrHoldsKeys('/h/.ZſHRC', spec, '/h')).toBe(true)
    expect(fileRunsOrHoldsKeys('/h/.ſshy/config', spec, '/h')).toBe(false)
  })

  it('this app’s own folder stays out of the route by every spelling', () => {
    const tmp = path.join(os.tmpdir())
    const own = path.join(tmp, 'iCloneOS')

    expect(oneShotFile(path.join(tmp, 'ICLONEOſ', 'consent.json'), tmp, { appFiles: [own] })).toBeNull()
  })
})
