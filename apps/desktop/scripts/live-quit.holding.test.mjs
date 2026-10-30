// Review r2, R2-M13: a process whose executable is OUTSIDE the roots but that holds a file inside one (a venv inside
// the runtime folder whose base interpreter lives elsewhere, e.g. the pm-runtime on a Mac with the python.org framework)
// used to be neither stopped nor reported. It is `holding` now: reported, the step exits 1, and it is never signalled.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, test } from 'vitest'

import { leftovers, parseLsofFiles } from './live-quit.mjs'

const CLI = fileURLToPath(new URL('./live-quit.mjs', import.meta.url))
const cleanups = []

afterAll(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

describe('live-quit: a process that holds a file inside a root (R2-M13)', () => {
  test('lsof -F pn: every absolute path a process holds, deleted names kept, non-paths dropped', () => {
    const files = parseLsofFiles(
      [
        'p10',
        'fcwd',
        'n/rt/work',
        'ftxt',
        'n/usr/bin/python3',
        'f3',
        'n/rt/.install.lock (deleted)',
        'f4',
        'nlocalhost:5000',
        'p11',
        ''
      ].join('\n')
    )

    assert.deepEqual(files.get(10), ['/rt/work', '/usr/bin/python3', '/rt/.install.lock'])
    assert.deepEqual(files.get(11), [])
  })

  test('an image outside the roots holding a path inside one is holding; holding nothing there, it is nobody', () => {
    const dir = fs.mkdtempSync('/tmp/live-quit-hold-')
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))

    const root = path.join(dir, 'hermes-runtime')

    fs.mkdirSync(root)

    const rows = [
      { pid: 20, exe: path.join(root, 'py'), files: [] },
      {
        pid: 21,
        exe: '/Library/Frameworks/Python.framework/Python.app/Contents/MacOS/Python',
        files: [path.join(root, '.install.lock')]
      },
      { pid: 22, exe: '/bin/zsh', files: ['/Users/u/notes.txt'] },
      { pid: 23, exe: '/bin/zsh' }
    ]

    const found = leftovers(rows, [root], { self: 1, platform: 'linux' })

    assert.deepEqual(
      found.inside.map(row => row.pid),
      [20]
    )
    assert.deepEqual(
      found.holding.map(row => row.pid),
      [21]
    )
    assert.deepEqual(found.unknown, [])
  })

  test.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'live CLI: /bin/sleep holding a lock file inside the root is reported as holding, exit 1, and left running',
    async () => {
      const dir = fs.mkdtempSync('/tmp/live-quit-hold-')
      const root = path.join(dir, 'hermes-runtime')
      const lock = path.join(root, '.install.lock')

      fs.mkdirSync(root)
      fs.writeFileSync(lock, '')

      // The shell opens the lock on fd 3 and execs sleep, which keeps it: the image is /bin/sleep, outside the root.
      const holder = spawn('/bin/sh', ['-c', `exec 3<"${lock}"; exec /bin/sleep 60`], { stdio: 'ignore' })

      cleanups.push(() => {
        holder.kill('SIGKILL')
        fs.rmSync(dir, { recursive: true, force: true })
      })

      // Until the exec'd sleep holds the lock (lsof lists it), the run would measure a shell that is about to exec.
      for (let i = 0; i < 50; i++) {
        const seen = spawnSync('/usr/sbin/lsof', ['-n', '-P', '-w', '-p', String(holder.pid), '-F', 'n'], {
          encoding: 'utf8'
        })

        if (/\/bin\/sleep/.test(seen.stdout) || /\.install\.lock/.test(seen.stdout)) {
          break
        }

        await new Promise(done => setTimeout(done, 100))
      }

      const run = spawnSync(process.execPath, [CLI, '--root', root, '--grace-ms', '200'], {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: '/tmp' }
      })

      const report = JSON.parse(run.stdout)
      const pids = rows => rows.map(line => Number(line.split(' ')[0]))

      assert.deepEqual(pids(report.holding), [holder.pid])
      assert.deepEqual(report.found, [])
      assert.equal(run.status, 1)
      assert.equal(holder.exitCode, null)
      assert.equal(holder.signalCode, null)
    }
  )
})
