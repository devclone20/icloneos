import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const POSIX_SCRIPT = path.join(REPO_ROOT, 'scripts', 'desktop-update', 'posix.sh')
const HELPER = path.join(REPO_ROOT, 'scripts', 'desktop-update', 'no_follow.pl')
const CANARY = 'a file of the user\n'
// A FIFO hang must fail the test, never hold the worker.
const LIMIT_MS = 30_000
const KINDS = ['link', 'dangling', 'fifo'] as const
const REFUSED = 3

let world: string
let home: string
let outside: string
let canary: string

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nf-hand-')))
  home = path.join(world, 'home')
  outside = path.join(world, 'outside')
  canary = path.join(outside, 'canary')
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(home, 'hermes-agent'))
  fs.mkdirSync(outside)
  fs.writeFileSync(canary, CANARY, { mode: 0o644 })
})

afterEach(() => fs.rmSync(world, { force: true, recursive: true }))

function plant(kind: (typeof KINDS)[number], at: string): void {
  if (kind === 'fifo') {
    execFileSync('/usr/bin/mkfifo', [at])
  } else {
    fs.symlinkSync(kind === 'link' ? canary : path.join(outside, 'created-by-a-follow'), at)
  }
}

function expectOutsideUntouched(): void {
  expect(fs.readdirSync(outside)).toEqual(['canary'])
  expect(fs.readFileSync(canary, 'utf8')).toBe(CANARY)
}

const helper = (op: string, file: string, input = 'new bytes\n', ...rest: string[]) =>
  spawnSync('/usr/bin/perl', [HELPER, op, file, ...rest], { encoding: 'utf8', input, timeout: LIMIT_MS })

const selfTestMarker = () =>
  spawnSync(
    '/bin/bash',
    [POSIX_SCRIPT, '--daemonized', '--install-root', path.join(home, 'hermes-agent'), '--self-test-marker'],
    {
      env: { ...process.env, HERMES_HOME: home },
      // A hung bash defers SIGTERM to its trap, and a hung `tee` would hold a stdout pipe: spawnSync would never return.
      killSignal: 'SIGKILL',
      stdio: 'ignore',
      timeout: LIMIT_MS
    }
  )

describe.skipIf(process.platform === 'win32')('posix.sh on a home the runtime can write', () => {
  test('a clean home still claims its marker and logs (the refusals below are not a broken script)', () => {
    const run = selfTestMarker()

    expect(run.signal).toBeNull()
    expect(run.status).toBe(0)
    expect(fs.lstatSync(path.join(home, '.hermes-update-in-progress')).isFile()).toBe(true)
    expect(fs.readFileSync(path.join(home, 'logs', 'desktop-update-handoff.log'), 'utf8').length).toBeGreaterThan(0)
  })

  test.each(KINDS)('a %s at its log, its marker and its lock is never followed and never hangs it', kind => {
    for (const name of [
      'logs/desktop-update-handoff.log',
      '.hermes-update-in-progress',
      '.hermes-update-in-progress.lock'
    ]) {
      fs.rmSync(path.join(home, name), { force: true })
      plant(kind, path.join(home, name))

      const run = selfTestMarker()

      expect(run.signal, `${name} hung the script`).toBeNull()
      expectOutsideUntouched()
      fs.rmSync(path.join(home, name), { force: true })
    }
  })

  test('a linked logs folder receives nothing', () => {
    fs.rmSync(path.join(home, 'logs'), { force: true, recursive: true })
    fs.symlinkSync(outside, path.join(home, 'logs'))

    selfTestMarker()

    expectOutsideUntouched()
  })
})

describe.skipIf(process.platform === 'win32')('no_follow.pl', () => {
  test.each(KINDS)('append and read refuse a %s', kind => {
    const file = path.join(home, 'file')
    plant(kind, file)

    expect(helper('append', file).status).toBe(REFUSED)
    expect(helper('read', file).status).toBe(REFUSED)
    expect(helper('read', file).stdout).toBe('')
    expectOutsideUntouched()
  })

  test.each(KINDS)('replace puts a plain file in place of a %s (what the result file goes through)', kind => {
    const file = path.join(home, '.hermes-update-result.json')
    plant(kind, file)

    expect(helper('replace', file).status).toBe(0)
    expect(fs.lstatSync(file).isFile()).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('new bytes\n')
    expectOutsideUntouched()
  })

  test.each(KINDS)('publish-new never replaces a %s', kind => {
    const file = path.join(home, 'marker')
    plant(kind, file)

    expect(helper('publish-new', file).status).toBe(1)
    expect(fs.lstatSync(file).isFile()).toBe(false)
    expectOutsideUntouched()
  })

  test.each(KINDS)('exec-log runs the command, its output going nowhere when the log is a %s', kind => {
    const file = path.join(home, 'file')
    const proof = path.join(home, 'ran')
    plant(kind, file)

    const run = helper('exec-log', file, '', '/bin/sh', '-c', `echo secret; echo secret >&2; : > "${proof}"`)

    expect(run.status).toBe(0)
    expect(fs.existsSync(proof)).toBe(true)
    expect(run.stdout + run.stderr).not.toContain('secret')
    expectOutsideUntouched()
  })

  test('every op refuses a linked folder on the way, a hard link too', () => {
    fs.symlinkSync(outside, path.join(home, 'sub'))
    const through = path.join(home, 'sub', 'canary')

    for (const op of ['append', 'read', 'replace', 'publish-new']) {
      expect(helper(op, through).status, op).toBe(REFUSED)
    }

    const second = path.join(home, 'second-name')
    fs.linkSync(canary, second)
    expect(helper('append', second).status).toBe(REFUSED)
    fs.rmSync(second)
    expectOutsideUntouched()
  })

  test('append, read and exec-log work on a plain file', () => {
    const file = path.join(home, 'file')

    expect(helper('append', file, 'one\n').status).toBe(0)
    expect(helper('exec-log', file, '', '/bin/echo', 'two').status).toBe(0)
    expect(helper('read', file).stdout).toBe('one\ntwo\n')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})
