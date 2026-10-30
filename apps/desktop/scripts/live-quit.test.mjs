// V3-RT live harness quit step: leftovers of an earlier launch are stopped, by executable location only.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, test } from 'vitest'

import {
  canonical,
  assertRoots,
  isInside,
  leftovers,
  listProcesses,
  mergeDarwin,
  parseArgs,
  parseLsofText,
  stillRunning,
  stopLeftovers
} from './live-quit.mjs'

/**
 * A real directory tree standing for a user's home (roots must exist): the app runtime folder under it is a root
 * `assertRoots` accepts for that fake home wherever the host's TMPDIR points, so no test depends on os.tmpdir() being
 * one of the allowed temp folders. Fake process rows live under RUNTIME.
 */
const RT = fs.mkdtempSync(path.join(os.tmpdir(), 'live-quit-rt-'))
const HOME = path.join(RT, 'home', 'u')
const RUNTIME = path.join(HOME, '.config', 'iclone os', 'hermes-runtime')
const WHERE = { home: HOME, temp: path.join(RT, 'no-temp') }
/** A root inside the real /tmp (allowed on Linux and macOS alike): the one case the temp clause must accept. */
const TEMP_ROOT = fs.mkdtempSync('/tmp/live-quit-temp-')
const CLI = fileURLToPath(new URL('./live-quit.mjs', import.meta.url))

fs.mkdirSync(RUNTIME, { recursive: true })

afterAll(() => {
  fs.rmSync(RT, { recursive: true, force: true })
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true })
})

/** A fake process table: `term` = the process exits on SIGTERM. */
function fakeTable(rows) {
  const table = new Map(rows.map(row => [row.pid, { ...row }]))
  const sent = []
  const kill = (pid, signal) => {
    const row = table.get(pid)

    if (!row) {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    }

    if (signal !== 0) {
      sent.push([pid, signal])
    }

    if (signal === 'SIGKILL' || (signal === 'SIGTERM' && row.term)) {
      table.delete(pid)
    }
  }

  return { kill, list: () => [...table.values()], sent, table }
}

const quick = { graceMs: 300, sleep: async () => {}, self: 1, where: WHERE }

/** Two copies of /bin/sleep, one inside `root` and one beside it, so a leftover and a look-alike can be spawned. */
function sleepers(root, outside) {
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })

  for (const dir of [root, outside]) {
    const copy = path.join(dir, 'sleep')

    fs.copyFileSync('/bin/sleep', copy)
    fs.chmodSync(copy, 0o755)
    // macOS: a copy of an Apple platform binary carries a signature that no longer matches it, and AMFI kills it on
    // exec (SIGKILL before main). An ad-hoc signature makes the copy runnable while keeping it a real executable
    // image of its own, which is what identity by executable needs.
    if (process.platform === 'darwin') {
      const signed = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', copy], { encoding: 'utf8' })

      assert.equal(signed.status, 0, `codesign ${copy}: ${signed.stderr || signed.error?.message}`)
    }
  }
}

/**
 * Waits until the process table lists `pid` with its executable inside `root` — not merely the pid: right after spawn
 * the row can still carry the parent's image, and a row that unlinks the binary before the exec shows up measures
 * nothing. Throws on timeout (before vitest's 5 s test timeout) so a slow host fails loudly here, not as a wrong
 * `found` further down.
 */
async function untilListed(pid, root, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  const inRoot = canonical(root)
  let seen

  for (;;) {
    seen = listProcesses().find(row => row.pid === pid)

    if (seen?.exe && isInside(canonical(seen.exe), inRoot)) {
      return seen
    }

    if (Date.now() > deadline) {
      throw new Error(
        `pid ${pid} not listed with its executable inside ${inRoot} within ${timeoutMs} ms: ${JSON.stringify(seen ?? null)}`
      )
    }

    await new Promise(done => setTimeout(done, 20))
  }
}

describe('live-quit: which processes are leftovers', () => {
  test('containment is by path, not by string prefix', () => {
    assert.equal(isInside('/a/app/bin/python', '/a/app'), true)
    assert.equal(isInside('/a/app', '/a/app'), true)
    assert.equal(isInside('/a/app-other/bin/python', '/a/app'), false)
    assert.equal(isInside('/a/b/../../etc/x', '/a/b'), false)
  })

  test('only executables inside a root count; this process never does; an unreadable executable is unknown', () => {
    const rows = [
      { pid: 10, exe: '/rt/hermes-runtime/abc/.iclone-deps/venv/bin/python3.14' },
      { pid: 11, exe: '/Applications/x.app/Contents/MacOS/x' },
      { pid: 12, exe: '/usr/bin/python3' },
      { pid: 13, exe: '/rt/hermes-runtime-not-ours/bin/python' },
      { pid: 14, exe: null },
      { pid: 99, exe: '/rt/hermes-runtime/node' }
    ]
    const got = leftovers(rows, ['/rt/hermes-runtime', '/Applications/x.app'], { self: 99 })

    assert.deepEqual(
      got.inside.map(row => row.pid),
      [10, 11]
    )
    assert.deepEqual(
      got.unknown.map(row => row.pid),
      [14]
    )
  })

  test('macOS volumes are case-insensitive: a root in another casing still contains its helpers; Linux is not', () => {
    // The user types `ICLONE OS.app`, the bundle on disk (and in lsof) is `iClone OS.app`: statSync accepts both on
    // APFS, so the root passes and its helpers must be found, not silently missed.
    const rows = [
      { pid: 10, exe: '/Applications/iClone OS.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper' },
      { pid: 11, exe: '/rt/Hermes-Runtime/py/bin/python3.14' },
      { pid: 12, exe: '/usr/bin/python3' }
    ]
    const roots = ['/Applications/ICLONE OS.app', '/rt/hermes-runtime']
    const pids = got => got.inside.map(row => row.pid)

    assert.deepEqual(pids(leftovers(rows, roots, { self: 1, platform: 'darwin' })), [10, 11])
    // ext4 and friends: `/rt/Hermes-Runtime` is another folder than `/rt/hermes-runtime`.
    assert.deepEqual(pids(leftovers(rows, roots, { self: 1, platform: 'linux' })), [])
    assert.deepEqual(pids(leftovers(rows, ['/rt/Hermes-Runtime'], { self: 1, platform: 'linux' })), [11])
  })

  test('macOS: the executable is the first text file lsof lists, whatever argv[0] says', () => {
    // A login shell's argv[0] is "-zsh" and a setproctitle'd backend says "hermes": lsof names the image itself.
    const out = [
      'p501',
      'ftxt',
      'n/bin/zsh',
      'ftxt',
      'n/usr/lib/dyld',
      'p777',
      'ftxt',
      'n/Users/u/Library/Application Support/iclone/hermes-runtime/abc/.iclone-deps/py/bin/python3.14',
      'ftxt',
      'n/usr/lib/libSystem.B.dylib',
      ''
    ].join('\n')

    assert.deepEqual(parseLsofText(out), [
      { pid: 501, exe: '/bin/zsh' },
      {
        pid: 777,
        exe: '/Users/u/Library/Application Support/iclone/hermes-runtime/abc/.iclone-deps/py/bin/python3.14'
      }
    ])
  })

  test('macOS: a process of this user that lsof did not list is unknown (fail closed), unless it is gone or a zombie', () => {
    // 779 exited between ps and lsof; 780 and 781 are zombies: no text files for lsof, yet kill(pid, 0) succeeds. A
    // zombie is not a leftover (nothing runs) and cannot be stopped, so it must be neither inside nor unknown.
    const ps = [
      '  501   501 Ss',
      '  777   501 S+',
      '  778   501 R',
      '  779   501 S',
      '  780   501 Z',
      '  781   501 Z+',
      '    1     0 Ss',
      ' 9000   502 S',
      ''
    ].join('\n')
    const lsof = ['p501', 'ftxt', 'n/bin/zsh', 'p777', 'ftxt', 'n/x/hermes-runtime/py', ''].join('\n')
    const rows = mergeDarwin(ps, lsof, 501, pid => pid !== 779)

    assert.throws(() => mergeDarwin(`${ps}  PID   UID STAT\n`, lsof, 501, () => true), /not "<pid> <uid> <stat>"/)
    // The old two-column table is a different table: refused, not guessed at.
    assert.throws(() => mergeDarwin('  501   501\n', lsof, 501, () => true), /not "<pid> <uid> <stat>"/)

    assert.deepEqual(rows, [
      { pid: 501, exe: '/bin/zsh' },
      { pid: 777, exe: '/x/hermes-runtime/py' },
      { pid: 778, exe: null }
    ])
  })

  // FIX_CRITICOS pass 2: the case above passes the zombie through `ps`'s STAT column, but a process that becomes a
  // zombie AFTER the `ps` (it exits before the lsof, its parent has not reaped it) reaches the liveness predicate, and the
  // predicate was kill(pid, 0), which a zombie answers. On a busy machine the quit step went RED on such pids.
  test.runIf(process.platform === 'darwin')(
    'macOS: the liveness check behind an unlisted pid says a zombie and a pid that is gone are not running',
    async () => {
      // A parent that never reaps its child: the child is a zombie for as long as the parent sleeps.
      const parent = spawn(
        'python3',
        [
          '-c',
          'import os, sys, time\npid = os.fork()\nif pid == 0: os._exit(0)\nprint(pid, flush=True)\ntime.sleep(30)'
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      )

      try {
        const zombie = await new Promise(done =>
          parent.stdout.once('data', chunk => done(Number(String(chunk).trim())))
        )

        for (
          let i = 0;
          i < 50 &&
          !spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(zombie)], { encoding: 'utf8' })
            .stdout.trim()
            .startsWith('Z');
          i++
        ) {
          await new Promise(done => setTimeout(done, 50))
        }

        assert.match(spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(zombie)], { encoding: 'utf8' }).stdout, /^Z/)
        // What the old predicate saw: the zombie answers kill(pid, 0).
        assert.doesNotThrow(() => process.kill(zombie, 0))
        assert.equal(stillRunning(zombie), false, 'a zombie runs nothing: it is not unknown')
        assert.equal(stillRunning(parent.pid), true, 'a process that runs is still running')
      } finally {
        parent.kill('SIGKILL')
      }

      await new Promise(done =>
        parent.exitCode !== null || parent.signalCode !== null ? done() : parent.once('exit', done)
      )
      assert.equal(stillRunning(parent.pid), false, 'a pid that is gone is not running')
    },
    20_000
  )
})

describe('live-quit: stopping them', () => {
  test('SIGTERM first; a process that ignores it is SIGKILLed; nothing outside the roots is signalled', async () => {
    const t = fakeTable([
      { pid: 10, exe: `${RUNTIME}/a/python`, term: true },
      { pid: 11, exe: `${RUNTIME}/b/backend`, term: false },
      { pid: 12, exe: '/usr/bin/other', term: true }
    ])
    const result = await stopLeftovers({ roots: [RUNTIME], list: t.list, kill: t.kill, ...quick })

    assert.deepEqual(t.sent, [
      [10, 'SIGTERM'],
      [11, 'SIGTERM'],
      [11, 'SIGKILL']
    ])
    assert.deepEqual(result.killed, [11])
    assert.deepEqual(result.remaining, [])
    assert.deepEqual(
      result.found.map(row => row.pid),
      [10, 11]
    )
    assert.ok(t.table.has(12))
  })

  test('canonical resolves a path that no longer exists through its longest existing ancestor', () => {
    // What the code change actually does, pinned directly — the live row that was supposed to pin it is vacuous on
    // macOS, because lsof prints the image path ALREADY resolved even after the binary is unlinked, so both sides
    // matched with the old code too (review r1, lenses 1 and 6). This row fails the moment canonical() goes back to
    // returning an unresolved path for something that is gone.
    // The symlinked ancestor is built here, so the row proves resolution on every host, not only where /tmp is a link.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-quit-canon-'))

    try {
      const target = path.join(dir, 'target')
      const link = path.join(dir, 'link')
      fs.mkdirSync(target)
      fs.symlinkSync(target, link, 'dir')
      const gone = path.join(link, 'never-existed', 'image')

      assert.equal(canonical(link), fs.realpathSync(target))
      assert.equal(
        canonical(gone),
        path.join(fs.realpathSync(target), 'never-existed', 'image'),
        'a path whose leaf is gone must still resolve through the ancestor that exists'
      )
      assert.notEqual(canonical(gone), gone, 'the ancestor is a symlink: an unresolved path is not the same path')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a leftover that appears after the first scan is signalled too, not just reported', async () => {
    // A supervised backend replaces a SIGTERMed sibling. Acting on one snapshot left the replacement unsignalled: it
    // stayed inside the root, went to `remaining`, and on macOS kept the app's singleton lock, so the next launch
    // never started (live run r1).
    const t = fakeTable([{ pid: 10, exe: `${RUNTIME}/a/supervisor`, term: true }])
    let ticks = 0
    const sleep = async () => {
      if (++ticks === 1) {
        t.table.set(11, { pid: 11, exe: `${RUNTIME}/b/worker`, term: true })
      }
    }
    const result = await stopLeftovers({ roots: [RUNTIME], list: t.list, kill: t.kill, ...quick, sleep })

    assert.deepEqual(t.sent, [
      [10, 'SIGTERM'],
      [11, 'SIGTERM']
    ])
    assert.deepEqual(result.remaining, [], 'the leftover that appeared after the first scan was never stopped')
    assert.deepEqual(
      result.found.map(row => row.pid).sort((a, b) => a - b),
      [10, 11]
    )
  })

  test('a pid reused by another program during the grace period is never SIGKILLed', async () => {
    const t = fakeTable([{ pid: 10, exe: `${RUNTIME}/a/python`, term: false }])
    let ticks = 0
    const sleep = async () => {
      // After the first tick the leftover is gone and its pid now belongs to a program outside the roots.
      if (++ticks === 1) {
        t.table.set(10, { pid: 10, exe: '/usr/bin/unrelated', term: false })
      }
    }
    const result = await stopLeftovers({ roots: [RUNTIME], list: t.list, kill: t.kill, ...quick, sleep })

    assert.deepEqual(t.sent, [[10, 'SIGTERM']])
    assert.deepEqual(result.killed, [])
    assert.deepEqual(result.remaining, [])
  })

  test('fail closed: a survivor of SIGKILL and an unreadable executable are reported', async () => {
    const result = await stopLeftovers({
      roots: [RUNTIME],
      list: () => [
        { pid: 10, exe: `${RUNTIME}/stuck` },
        { pid: 20, exe: null }
      ],
      kill: () => {},
      ...quick
    })

    assert.deepEqual(
      result.remaining.map(row => row.pid),
      [10]
    )
    assert.deepEqual(
      result.unknown.map(row => row.pid),
      [20]
    )
  })

  test('no root at all, or a grace that is not a number, is refused before anything is signalled', async () => {
    const t = fakeTable([{ pid: 10, exe: `${RUNTIME}/a`, term: true }])

    await assert.rejects(stopLeftovers({ roots: [] }), /no root to clear/)
    await assert.rejects(stopLeftovers({ roots: ['/'], list: t.list, kill: t.kill, ...quick }), /refused root \//)
    await assert.rejects(
      stopLeftovers({ roots: [RUNTIME], list: t.list, kill: t.kill, ...quick, graceMs: Number('soon') }),
      /--grace-ms must be a non-negative number/
    )
    assert.deepEqual(t.sent, [])
  })

  test('a root must be in an app data folder, an .app in Applications, or inside the temp folder', () => {
    const home = HOME
    const runtime = path.join(home, 'Library', 'Application Support', 'iclone os', 'hermes-runtime')
    const app = path.join(home, 'Applications', 'iclone os.app')
    for (const dir of [runtime, app, path.join(home, 'Library', 'Preferences'), path.join(RT, 'x.app')]) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const where = WHERE

    assert.doesNotThrow(() => assertRoots([runtime, RUNTIME, app], where))
    assert.doesNotThrow(() => assertRoots([TEMP_ROOT], { home, temp: '/tmp' }))
    // A temp folder outside the usual places (TMPDIR=/) opens nothing, not even a real folder under /tmp.
    assert.throws(() => assertRoots(['/usr/lib'], { home, temp: '/' }), /refused root/)
    assert.throws(() => assertRoots([TEMP_ROOT], { home, temp: '/' }), /refused root/)
    for (const root of [
      '/',
      '/usr',
      '/usr/lib',
      '/bin',
      '/etc',
      '/proc',
      '/tmp',
      os.tmpdir(),
      home,
      path.join(RT, 'home'),
      path.join(home, 'Library'),
      path.join(home, 'Library', 'Preferences'),
      path.join(home, 'Library', 'Application Support'),
      path.join(home, 'Library', 'Application Support', 'iclone os'),
      path.join(home, '.config', 'iclone os'),
      path.join(RT, 'x.app'),
      RT,
      TEMP_ROOT,
      'relative/dir',
      path.join(RT, 'missing'),
      '--grace-ms',
      ''
    ]) {
      assert.throws(() => assertRoots([root], where), /refused root/, root)
    }
  })

  test('command line: --root <dir> and --grace-ms <n> only; anything else is refused, nothing is guessed', () => {
    assert.deepEqual(parseArgs([]), { roots: [], graceMs: 3000 })
    assert.deepEqual(parseArgs(['--root', '/a', '--grace-ms', '5', '--root', '/b']), {
      roots: ['/a', '/b'],
      graceMs: 5
    })

    assert.throws(() => parseArgs(['--root', '/a', '--bogus']), /unknown argument "--bogus"/)
    assert.throws(() => parseArgs(['--roots', '/a']), /unknown argument "--roots"/)
    assert.throws(() => parseArgs(['--root', '/a', '/b']), /unknown argument "\/b"/)
    assert.throws(() => parseArgs(['--root']), /--root needs a value/)
    assert.throws(() => parseArgs(['--root', '/a', '--grace-ms']), /--grace-ms needs a value/)
    assert.throws(() => parseArgs(['--grace-ms', 'soon', '--root', '/a']), /--grace-ms needs a value/)
    assert.throws(() => parseArgs(['--grace-ms', '-1']), /--grace-ms needs a value/)
    assert.throws(() => parseArgs(['--grace-ms', '1.5']), /--grace-ms needs a value/)
  })

  test.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'live: a leftover started from inside the runtime folder is stopped; the same program outside it is not',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-quit-'))
      const home = path.join(dir, 'home', 'u')
      const root = path.join(home, '.config', 'iclone os', 'hermes-runtime')
      const outside = path.join(dir, 'outside')
      sleepers(root, outside)

      // argv[0] is a decoy outside the root: identity must come from the executable, not argv.
      const left = spawn(path.join(root, 'sleep'), ['60'], { argv0: '/usr/bin/decoy', stdio: 'ignore' })
      const other = spawn(path.join(outside, 'sleep'), ['60'], { argv0: path.join(root, 'sleep'), stdio: 'ignore' })
      const exited = new Promise(done => left.once('exit', (_code, signal) => done(signal)))

      try {
        await untilListed(left.pid, root)

        const result = await stopLeftovers({ roots: [root], graceMs: 2000, where: { home, temp: dir } })
        const pids = rows => rows.map(row => row.pid)

        assert.deepEqual(pids(result.found), [left.pid])
        assert.equal(await exited, 'SIGTERM')
        assert.deepEqual(result.remaining, [])
        assert.equal(other.exitCode, null)
        assert.equal(other.signalCode, null)
        // Both spawned executables are readable, so neither may be "unknown" (that would make the step RED on every
        // run); whether OTHER processes of this user are unknown is the host's business (as root, pid 1's executable
        // may be unreadable), so the list is not asserted empty.
        assert.ok(!pids(result.unknown).includes(left.pid), `leftover ${left.pid} reported unknown`)
        assert.ok(!pids(result.unknown).includes(other.pid), `survivor ${other.pid} reported unknown`)
        assert.ok(!pids(result.found).includes(other.pid))
        assert.ok(!pids(result.remaining).includes(other.pid))
      } finally {
        left.kill('SIGKILL')
        other.kill('SIGKILL')
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  test.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'live: a leftover whose executable was unlinked while running is still inside the root',
    async () => {
      // The case the live harness meets after an upgrade re-created the runtime folder: the old backend is still
      // running from an image that no longer exists. macOS lsof still prints that path (no "(deleted)" marker) and
      // Linux's /proc/<pid>/exe prints it with one, so on both the row names a path with a live ancestor and a dead
      // leaf: containment must resolve it the same way it resolves the root, or the leftover escapes the step.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-quit-gone-'))
      const home = path.join(dir, 'home', 'u')
      const root = path.join(home, '.config', 'iclone os', 'hermes-runtime')
      const outside = path.join(dir, 'outside')
      const pids = rows => rows.map(row => row.pid)
      // Measured on macOS 27: inspecting an ad-hoc signed process whose image was just unlinked sometimes makes the
      // kernel SIGKILL it (4 of 60, always while lsof reads it), before or after the scan saw it. A SIGKILL this step
      // never sent proves nothing either way, so that attempt is set up again; the row only passes on an attempt where
      // the process outlived its unlink and was then found and stopped by the step's own SIGTERM.
      const killedByKernel = []

      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          sleepers(root, outside)

          const left = spawn(path.join(root, 'sleep'), ['60'], { stdio: 'ignore' })
          const exited = new Promise(done => left.once('exit', (_code, signal) => done(signal)))

          try {
            await untilListed(left.pid, root)
            fs.rmSync(path.join(root, 'sleep'))

            const result = await stopLeftovers({ roots: [root], graceMs: 2000, where: { home, temp: dir } })
            // Bounded: a leftover the step missed is still running, and must fail on `found` below, not time out here.
            const signal = await Promise.race([exited, new Promise(done => setTimeout(done, 3000, 'still running'))])

            if (signal === 'SIGKILL' && !result.killed.includes(left.pid)) {
              killedByKernel.push(left.pid)
              continue
            }

            assert.deepEqual(pids(result.found), [left.pid], 'leftover with an unlinked executable was not found')
            assert.equal(signal, 'SIGTERM')
            assert.deepEqual(result.remaining, [])
            assert.ok(!pids(result.unknown).includes(left.pid), `leftover ${left.pid} reported unknown`)

            return
          } finally {
            left.kill('SIGKILL')
          }
        }

        assert.fail(
          `the kernel killed every unlinked leftover before it could be stopped: ${killedByKernel.join(', ')}`
        )
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
    15_000
  )

  test.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'live CLI: an unknown argument is refused before anything is signalled; a clean quit exits 0',
    async () => {
      // The CLI checks roots against the real home and temp folder, so its root lives in /tmp (allowed on both
      // platforms) and the child's TMPDIR says so, whatever the host's own TMPDIR is.
      const dir = fs.mkdtempSync('/tmp/live-quit-cli-')
      const root = path.join(dir, 'hermes-runtime')
      const outside = path.join(dir, 'outside')
      sleepers(root, outside)

      const left = spawn(path.join(root, 'sleep'), ['60'], { stdio: 'ignore' })
      const other = spawn(path.join(outside, 'sleep'), ['60'], { stdio: 'ignore' })
      const exited = new Promise(done => left.once('exit', (_code, signal) => done(signal)))
      const cli = args =>
        spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, TMPDIR: '/tmp' } })

      try {
        await untilListed(left.pid, root)

        for (const [args, reason] of [
          [['--root', root, '--bogus'], /^\[live-quit\] RED unknown argument "--bogus"/],
          [['--root', root, '--grace-ms'], /^\[live-quit\] RED --grace-ms needs a value/],
          [['--root', root, '--grace-ms', 'soon'], /^\[live-quit\] RED --grace-ms needs a value/],
          [['--root', root, 'extra'], /^\[live-quit\] RED unknown argument "extra"/]
        ]) {
          const run = cli(args)

          assert.equal(run.status, 1, args.join(' '))
          assert.match(run.stderr, reason)
          assert.equal(run.stdout, '')
        }

        // Nothing was signalled by the refused runs.
        assert.equal(left.exitCode, null)
        assert.equal(left.signalCode, null)

        const run = cli(['--root', root, '--grace-ms', '2000'])
        const report = JSON.parse(run.stdout)
        const pids = rows => rows.map(line => Number(line.split(' ')[0]))

        assert.deepEqual(pids(report.found), [left.pid])
        assert.equal(await exited, 'SIGTERM')
        assert.deepEqual(report.killed, [])
        assert.deepEqual(report.remaining, [])
        assert.ok(!pids(report.unknown).includes(left.pid))
        assert.ok(!pids(report.unknown).includes(other.pid))
        assert.equal(other.exitCode, null)
        // Exit 0 exactly when the table is clean: as a normal user `unknown` is empty and this asserts 0; as root
        // (pid 1's executable may be unreadable) the step is RED by design and the exit code must say so.
        assert.equal(run.status, report.unknown.length ? 1 : 0, run.stderr)
      } finally {
        left.kill('SIGKILL')
        other.kill('SIGKILL')
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})
