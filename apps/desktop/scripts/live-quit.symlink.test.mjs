// Review r2, R2-M7: the quit step called through a symlink must still run (and refuse what it does not understand),
// never do nothing and exit 0 — V3RT_quit.sh reads exit 0 as "the roots are clean".
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, test } from 'vitest'

const CLI = fileURLToPath(new URL('./live-quit.mjs', import.meta.url))
const dirs = []

afterAll(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('live-quit: called through a symlink (R2-M7)', () => {
  test.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'a linked CLI path still runs the CLI: an unknown argument is refused with exit 1',
    () => {
      const dir = fs.mkdtempSync('/tmp/live-quit-link-')
      dirs.push(dir)

      const root = path.join(dir, 'hermes-runtime')
      const link = path.join(dir, 'live-quit.mjs')

      fs.mkdirSync(root)
      fs.symlinkSync(CLI, link)
      assert.notEqual(fs.realpathSync(link), link)

      const run = spawnSync(process.execPath, [link, '--root', root, '--bogus'], {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: '/tmp' }
      })

      assert.match(run.stderr, /^\[live-quit\] RED unknown argument "--bogus"/)
      assert.equal(run.status, 1)
    }
  )
})
