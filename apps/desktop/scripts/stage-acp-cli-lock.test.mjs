// REL-4 ruling 24: the staged ACP CLI is installed from a committed lockfile with `npm ci`, so the tree (and the
// notices section byte-checked against it) cannot drift with the registry.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, test } from 'vitest'

import { ACP_CLI_VERSION } from './acp-cli-version.mjs'
import { CLI_NAME, installPinned, LOCK_DIR, readPinnedProject } from './stage-acp-cli.mjs'

const temps = []

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A pinned project in a temp dir: `version` for the three places the CLI version appears, `entry` for its lock row. */
function project({ declared = '1.2.3', root = declared, locked = declared, entry = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-lock-'))
  temps.push(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'p', private: true, dependencies: { [CLI_NAME]: declared } })
  )
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'p', dependencies: { [CLI_NAME]: root } },
        [`node_modules/${CLI_NAME}`]: {
          version: locked,
          resolved: 'https://r/cli.tgz',
          integrity: 'sha512-x',
          ...entry
        }
      }
    })
  )

  return dir
}

describe('the ACP CLI lockfile (ruling 24)', () => {
  test('the committed lockfile pins the CLI at ACP_CLI_VERSION, with a resolved URL and integrity for every package', () => {
    const { lock } = readPinnedProject(LOCK_DIR, ACP_CLI_VERSION)
    assert.equal(lock.packages[`node_modules/${CLI_NAME}`].version, ACP_CLI_VERSION)
    assert.ok(Object.keys(lock.packages).length > 1)
  })

  test('a bump that forgets the lockfile, its root entry or the pin fails before any install', () => {
    assert.doesNotThrow(() => readPinnedProject(project(), '1.2.3'))
    assert.throws(() => readPinnedProject(project(), '1.2.4'), /bump all of them together/)
    assert.throws(() => readPinnedProject(project({ locked: '1.2.2' }), '1.2.3'), /lockfile tree 1\.2\.2/)
    assert.throws(() => readPinnedProject(project({ root: '^1.2.0' }), '1.2.3'), /lockfile root \^1\.2\.0/)
  })

  test('a lock row without its integrity is refused (npm ci could not verify the tarball)', () => {
    assert.throws(
      () => readPinnedProject(project({ entry: { integrity: undefined } }), '1.2.3'),
      /no resolved URL or integrity/
    )
  })

  test('staging copies the pinned project and runs npm ci, never a floating npm install', () => {
    const lockDir = project({ declared: ACP_CLI_VERSION })
    const stageDir = join(mkdtempSync(join(tmpdir(), 'acp-stage-')), 'runtime')
    temps.push(stageDir)
    mkdirSync(stageDir, { recursive: true })
    const calls = []
    const result = installPinned(stageDir, {
      lockDir,
      spawn: (cmd, args, opts) => (calls.push({ cmd, args, opts }), { status: 0 })
    })

    assert.equal(result.status, 0)
    assert.deepEqual(
      calls.map(c => [c.cmd, c.args[0]]),
      [['npm', 'ci']]
    )
    assert.ok(calls[0].args.includes('--omit=dev') && !calls[0].args.some(a => a.startsWith(CLI_NAME)))
    assert.equal(calls[0].opts.cwd, stageDir)
    assert.ok(existsSync(join(stageDir, 'package-lock.json')))
    assert.equal(
      readFileSync(join(stageDir, 'package.json'), 'utf8'),
      readFileSync(join(lockDir, 'package.json'), 'utf8')
    )
  })
})
