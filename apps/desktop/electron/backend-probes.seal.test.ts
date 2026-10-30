/**
 * V3-S r5b (K-RT11): the runtime import probe runs the gated spawn's sealed interpreter (`-s -P`, the env allowlist, no
 * bytecode read or written), so probing a runtime tree never writes into it — not one pyc, not one mtime. Runs with
 * this checkout's venv Python (or V3S_PY) on a small temp tree; skipped when there is none.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { canImportHermesCli } from './backend-probes'

const REPO = path.resolve(import.meta.dirname, '../../..')

const PY = [
  process.env.V3S_PY,
  path.join(REPO, 'venv', 'bin', 'python'),
  path.join(REPO, '.venv', 'bin', 'python')
].find((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate)))

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

/** A runtime tree with every module the import probe names (whichever pin's probe string is compiled in). */
function runtimeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3s-probe-'))
  temps.push(root)

  for (const name of ['yaml', 'dotenv', 'hermes_bootstrap', 'hermes_yaml']) {
    fs.writeFileSync(path.join(root, `${name}.py`), `NAME = ${JSON.stringify(name)}\n`)
  }

  fs.mkdirSync(path.join(root, 'hermes_cli'))
  fs.writeFileSync(path.join(root, 'hermes_cli', '__init__.py'), '')
  fs.writeFileSync(path.join(root, 'hermes_cli', 'config.py'), 'LOADED = True\n')

  return root
}

/** Every entry (links not followed): type, mode, size, mtime and bytes — any write shows. */
function untouched(dir: string): Record<string, string> {
  const out: Record<string, string> = {}

  const walk = (rel: string) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const relPath = rel ? `${rel}/${name}` : name
      const stat = fs.lstatSync(path.join(dir, relPath))
      const bytes = stat.isFile() ? fs.readFileSync(path.join(dir, relPath)).toString('base64') : ''
      out[relPath] = `${stat.mode}:${stat.size}:${stat.mtimeMs}:${bytes}`

      if (stat.isDirectory()) {
        walk(relPath)
      }
    }
  }

  walk('')

  return out
}

describe.runIf(process.platform !== 'win32' && Boolean(PY))(
  'K-RT11: the import probe never writes into the runtime',
  () => {
    it('control: the same import without the seal writes bytecode into the tree', () => {
      const root = runtimeTree()

      execFileSync(PY!, ['-c', 'import hermes_cli.config'], {
        env: { HOME: os.tmpdir(), PATH: '/usr/bin:/bin', PYTHONPATH: root },
        stdio: 'ignore'
      })

      expect(fs.existsSync(path.join(root, 'hermes_cli', '__pycache__'))).toBe(true)
    })

    it('the sealed probe imports the tree and leaves it byte-identical, mtimes included (an inherited cache env too)', () => {
      const root = runtimeTree()
      const before = untouched(root)
      const saved = { ...process.env }

      // What a launchd / shell environment could carry: a writable cache prefix, bytecode writing switched back on.
      process.env.PYTHONPYCACHEPREFIX = path.join(root, 'cache')
      process.env.PYTHONDONTWRITEBYTECODE = ''

      try {
        expect(canImportHermesCli(PY!, { env: { PYTHONPATH: [root, '/elsewhere'].join(path.delimiter) } })).toBe(true)
      } finally {
        process.env = saved
      }

      expect(untouched(root)).toEqual(before)
    }, 60_000)
  }
)
