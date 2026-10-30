// Review r3, R3-M3: R2-M13's fix only caught a process that HOLDS a path inside a root. The case R2-M13 itself named, a
// venv inside the runtime folder whose base interpreter is the python.org framework's, has the image
// .../Python.app/Contents/MacOS/Python; with its working folder elsewhere it holds nothing inside the root, so the step
// said `holding []` and exited 0 while it ran. Its environment names the venv (`__PYVENV_LAUNCHER__`), so it is
// `holding` now: reported, exit 1, never signalled.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, test } from 'vitest'

import { launchPaths, leftovers, parsePsEnvironment } from './live-quit.mjs'

const CLI = fileURLToPath(new URL('./live-quit.mjs', import.meta.url))
const FRAMEWORK_PYTHON = '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3'
const cleanups = []

afterAll(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

const tempRoot = prefix => {
  const dir = fs.mkdtempSync(path.join('/tmp', prefix))
  const root = path.join(dir, 'hermes-runtime')

  fs.mkdirSync(root)
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))

  return root
}

/** Runs the CLI over `root` and returns its report, its exit status and the pids it listed as holding. */
const quit = root => {
  const run = spawnSync(process.execPath, [CLI, '--root', root, '--grace-ms', '200'], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: '/tmp' }
  })
  const report = JSON.parse(run.stdout)

  return { report, status: run.status, holding: report.holding.map(line => Number(line.split(' ')[0])) }
}

/** Waits until `ps -E` shows `needle` in the environment of `pid` (the process has exec'd and set it up). */
const untilEnvironmentShows = async (pid, needle) => {
  for (let i = 0; i < 50; i++) {
    const out = spawnSync('/bin/ps', ['-wwE', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout

    if (out.includes(needle)) {
      return
    }

    await new Promise(done => setTimeout(done, 100))
  }

  throw new Error(`pid ${pid} never showed ${needle} in its environment`)
}

describe('live-quit: a process launched as a program inside a root (R3-M3)', () => {
  test('ps -E: the launch variables of each pid, a value with spaces kept whole, relative values dropped', () => {
    const paths = parsePsEnvironment(
      [
        '  31 /Library/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python -c x TERM=xterm __PYVENV_LAUNCHER__=/Users/u/Library/Application Support/iClone OS/hermes-runtime/venv/bin/python HOME=/Users/u',
        '  32 /bin/zsh -l VIRTUAL_ENV=/w/.venv _=/usr/bin/env PATH=/usr/bin',
        '  33 /usr/bin/env _=python3 LANG=C',
        '  34 /bin/sleep 30',
        ''
      ].join('\n')
    )

    assert.deepEqual(paths.get(31), ['/Users/u/Library/Application Support/iClone OS/hermes-runtime/venv/bin/python'])
    assert.deepEqual(paths.get(32), ['/w/.venv', '/usr/bin/env'])
    assert.deepEqual(paths.get(33), [])
    assert.deepEqual(paths.get(34), [])
  })

  test('/proc environ entries: only the three launch variables, only absolute values', () => {
    assert.deepEqual(
      launchPaths([
        '__PYVENV_LAUNCHER__=/rt/venv/bin/python',
        'VIRTUAL_ENV=/rt/venv',
        '_=/rt/bin/hermes',
        'PWD=/rt',
        '_=rel',
        'X'
      ]),
      ['/rt/venv/bin/python', '/rt/venv', '/rt/bin/hermes']
    )
  })

  test('an image outside the roots launched as a program inside one is holding; launched elsewhere, it is nobody', () => {
    const root = tempRoot('live-quit-launch-')
    const python = '/Library/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python'
    const rows = [
      { pid: 40, exe: python, files: ['/tmp'], launched: [path.join(root, 'venv', 'bin', 'python')] },
      { pid: 41, exe: python, files: ['/tmp'], launched: ['/Users/u/project/.venv/bin/python'] },
      { pid: 42, exe: '/bin/zsh', files: [], launched: [] }
    ]

    const found = leftovers(rows, [root], { self: 1, platform: 'darwin' })

    assert.deepEqual(found.inside, [])
    assert.deepEqual(
      found.holding.map(row => row.pid),
      [40]
    )
  })

  test('a launch path that is a symbolic link out of the root (a venv bin/python) still counts as inside it', () => {
    const root = tempRoot('live-quit-launch-')
    const python = path.join(root, 'venv', 'bin', 'python')

    fs.mkdirSync(path.dirname(python), { recursive: true })
    // As `python -m venv` makes it: bin/python is a link to the base interpreter, which lives outside the root.
    fs.symlinkSync(process.execPath, python)

    const rows = [{ pid: 50, exe: fs.realpathSync(process.execPath), files: ['/tmp'], launched: [python] }]
    const found = leftovers(rows, [root], { self: 1, platform: process.platform })

    assert.deepEqual(found.inside, [])
    assert.deepEqual(
      found.holding.map(row => row.pid),
      [50]
    )
  })

  test.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'live CLI: a process outside the root holding nothing in it, whose environment names a venv inside it, is holding, exit 1, and left running',
    async () => {
      const root = tempRoot('live-quit-launch-')
      const launcher = path.join(root, 'venv', 'bin', 'python')
      // Node, not /bin/sleep: macOS hides the environment of Apple's platform binaries from `ps -E`.
      const runner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        cwd: '/tmp',
        stdio: 'ignore',
        env: { PATH: process.env.PATH, __PYVENV_LAUNCHER__: launcher }
      })

      cleanups.push(() => runner.kill('SIGKILL'))

      if (process.platform === 'darwin') {
        await untilEnvironmentShows(runner.pid, launcher)
      }

      const { report, status, holding } = quit(root)

      assert.deepEqual(holding, [runner.pid])
      assert.deepEqual(report.found, [])
      assert.equal(status, 1)
      assert.equal(runner.exitCode, null)
      assert.equal(runner.signalCode, null)
    },
    30_000
  )

  // The exact case review r3 measured: python.org's framework Python, a venv inside the root, the working folder outside.
  // A Mac without that framework has no such process to find; there the test above carries the same property.
  test.runIf(process.platform === 'darwin' && fs.existsSync(FRAMEWORK_PYTHON))(
    'live CLI (macOS, python.org framework): a venv python inside the root with its working folder outside is holding, exit 1',
    async () => {
      const root = tempRoot('live-quit-venv-')
      const venv = path.join(root, 'venv')

      spawnSync(FRAMEWORK_PYTHON, ['-m', 'venv', '--without-pip', venv], { stdio: 'ignore' })

      const runner = spawn(path.join(venv, 'bin', 'python'), ['-c', 'import time; time.sleep(60)'], {
        cwd: '/tmp',
        stdio: 'ignore'
      })

      cleanups.push(() => runner.kill('SIGKILL'))
      await untilEnvironmentShows(runner.pid, '__PYVENV_LAUNCHER__=')

      const { report, status, holding } = quit(root)

      assert.deepEqual(holding, [runner.pid])
      assert.match(report.holding[0], /Python\.app\/Contents\/MacOS\/Python$/)
      assert.equal(status, 1)
      assert.equal(runner.exitCode, null)
    },
    30_000
  )
})

/**
 * Review r4, R4-01: a standalone (non-framework) CPython install, as the shipped runtime uses (python-build-standalone,
 * also what uv manages): its root folder (bin/, lib/), or null when this Mac has none or the one found is a framework.
 */
const standaloneInstall = () => {
  if (process.platform !== 'darwin') {
    return null
  }

  const found = spawnSync('uv', ['python', 'find', '--managed-python', '3'], { encoding: 'utf8' })
  const python = found.status === 0 ? found.stdout.trim() : ''

  if (!python || !fs.existsSync(python)) {
    return null
  }

  const install = path.dirname(path.dirname(fs.realpathSync(python)))

  return install.includes('.framework') ? null : install
}

const STANDALONE = standaloneInstall()

/** Starts `<venv>/bin/python` as the app spawns a backend: no shell, an environment of PATH only, working folder /tmp. */
const startVenvPython = async venv => {
  const runner = spawn(path.join(venv, 'bin', 'python'), ['-c', 'import time; time.sleep(60)'], {
    cwd: '/tmp',
    stdio: 'ignore',
    env: { PATH: '/usr/bin:/bin' }
  })

  cleanups.push(() => runner.kill('SIGKILL'))

  // Started once lsof lists its image (the interpreter has exec'd and is running).
  for (let i = 0; i < 50; i++) {
    const txt = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(runner.pid), '-d', 'txt', '-Fn'], { encoding: 'utf8' })

    if (txt.stdout.includes('/bin/python')) {
      return runner
    }

    await new Promise(done => setTimeout(done, 100))
  }

  throw new Error(`venv python ${runner.pid} never showed its image in lsof`)
}

describe('live-quit: a venv on a standalone (non-framework) CPython, launched without a shell (R4-01)', () => {
  // The shipped runtime's layout: the pinned CPython lives INSIDE the runtime folder (.iclone-deps/hermes/tools/...),
  // the venv beside it. Its image is inside the root, so it is found by its executable and stopped.
  test.runIf(STANDALONE)(
    'live CLI (macOS): the base interpreter inside the root -> found, stopped, exit 0',
    async () => {
      const root = tempRoot('live-quit-standalone-in-')
      const base = path.join(root, '.iclone-deps', 'hermes', 'tools', 'python-3')
      const venv = path.join(root, 'venv')

      fs.mkdirSync(path.dirname(base), { recursive: true })
      // An APFS clone (-c): a full copy of the install at no disk cost.
      assert.equal(spawnSync('/bin/cp', ['-cR', STANDALONE, base]).status, 0, 'could not copy the CPython install')
      assert.equal(spawnSync(path.join(base, 'bin', 'python3'), ['-m', 'venv', '--without-pip', venv]).status, 0)

      const runner = await startVenvPython(venv)
      const { report, status } = quit(root)

      assert.deepEqual(
        report.found.map(line => Number(line.split(' ')[0])),
        [runner.pid]
      )
      assert.match(report.found[0], /\/\.iclone-deps\/hermes\/tools\/python-3\/bin\/python3[.\d]*$/)
      assert.deepEqual(report.holding, [])
      assert.deepEqual(report.remaining, [])
      assert.equal(status, 0)
      await new Promise(done => setTimeout(done, 300))
      assert.notEqual(runner.signalCode ?? runner.exitCode, null, 'the venv python inside the root is still running')
    },
    60_000
  )

  // The same venv inside the root, its base interpreter outside every root. What this test REQUIRES is the safety half:
  // a process whose image is outside every root is never signalled (it is not `found`, and it is still running).
  // Whether the step REPORTS it is the gap the header declares (review r5 A5-1: nothing it holds or names is inside the
  // root; only argv[0] is, and argv is never identity, HX003). That half is measured and printed as a report line, never
  // asserted (critics' panel, minor 2): the earlier `holding: []` / `status 0` assertions pinned the gap itself, so a fix
  // that closed it would have turned this test red.
  test.runIf(STANDALONE)(
    'live CLI (macOS): the base interpreter outside every root -> never signalled; reporting it is the declared gap (printed, not asserted)',
    async () => {
      const root = tempRoot('live-quit-standalone-out-')
      const venv = path.join(root, 'venv')

      assert.equal(spawnSync(path.join(STANDALONE, 'bin', 'python3'), ['-m', 'venv', '--without-pip', venv]).status, 0)

      const runner = await startVenvPython(venv)
      const { report, status, holding } = quit(root)

      assert.deepEqual(report.found, [])
      assert.equal(runner.exitCode, null)
      assert.equal(runner.signalCode, null)
      console.log(
        `[A5-1 report] a venv on a base interpreter outside every root: ${
          holding.includes(runner.pid) ? 'REPORTED (holding, the gap is closed)' : 'not reported (the declared gap)'
        }; quit exit ${status}`
      )
    },
    60_000
  )
})
