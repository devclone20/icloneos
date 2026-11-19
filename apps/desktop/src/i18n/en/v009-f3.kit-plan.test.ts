/**
 * v0.0.9 eng r3-n3: the boot card's repair hint agrees with what the repair kit really does for that cause. Each case
 * plants the runtime's private record in a throwaway tree (never the real HOME), runs the REAL kit's runtime-venv
 * repair (the class every python-import / runtime-env-broken cause routes to), and holds the card's words against the
 * steps and the manifest.
 *
 * Red on bf42e8eb02: the fastapi card said "The broken environment record is moved aside first … Settings › Diagnostics
 * can undo it", while the live repair ran 0 kit steps and wrote no manifest (proofs-r3 §2).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BootCause } from '../../../electron/boot-cause'
import { createRepairKit, type RepairKitDeps, runtimeInstallKey } from '../../../electron/repair-kit/kit'

import { f3CauseCopy } from './v009-f3'

let root = ''
let runtimeRoot = ''
let privateHermesHome = ''
let cause: BootCause | null = null

function deps(): RepairKitDeps {
  const home = path.join(root, 'home')
  const userData = path.join(root, 'ud')

  return {
    appVersion: '0.0.9-test',
    bootCause: () => cause,
    hermesHome: path.join(home, '.hermes'),
    log: () => undefined,
    now: () => new Date(2026, 10, 18, 13, 0, 0, 0),
    orphans: { list: async () => [], reap: async () => [] },
    privateHermesHome,
    requestReinstall: () => undefined,
    runtimeRoot,
    socketAlive: async () => true,
    stopAgent: async () => undefined,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    userData
  }
}

/** An intact private record: facts.json names a venv whose interpreter home and python link both exist. */
function intactRecord(): { install: string; venv: string } {
  const install = path.join(privateHermesHome, 'installs', runtimeInstallKey(runtimeRoot)!)
  const venv = path.join(install, 'environments', 'fef8b4d0', 'venv')

  fs.mkdirSync(path.join(venv, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), `home = ${root}\nversion = 3.14.0\n`)
  fs.symlinkSync('/bin/sh', path.join(venv, 'bin', 'python'))
  fs.writeFileSync(path.join(install, 'facts.json'), JSON.stringify({ packages: { venv: { environment: venv } } }))

  return { install, venv }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f3-kit-plan-')))
  runtimeRoot = path.join(root, 'ud', 'hermes-runtime', '20e847b8893745fb')
  privateHermesHome = path.join(runtimeRoot, '.iclone-deps', 'hermes')

  for (const dir of [path.join(root, 'home', '.hermes'), runtimeRoot, privateHermesHome]) {
    fs.mkdirSync(dir, { mode: 0o755, recursive: true })
  }
})

afterEach(() => {
  fs.rmSync(root, { force: true, recursive: true })
  cause = null
})

const PROMISES_MOVE = /moved aside|move[sd]? .*aside|undo/i

describe.runIf(process.platform !== 'win32')("r3-n3: the boot card's hint agrees with what the kit does", () => {
  it('fastapi missing, record intact: the kit moves nothing and writes no manifest, and the hint promises no move or undo', async () => {
    const { install } = intactRecord()

    cause = { code: 'python-import', line: "ModuleNotFoundError: No module named 'fastapi'" }

    const report = await createRepairKit(deps()).apply('runtime-venv', { dryRun: false })

    expect(report.steps.some(step => step.kind === 'move-aside')).toBe(false)
    expect(report.manifestDir).toBeNull()
    expect(fs.existsSync(install)).toBe(true)

    const copy = f3CauseCopy(cause)!

    expect(copy.cause).toBe('A part of the agent is missing (fastapi). Repair reinstalls it.')
    expect(`${copy.cause} ${copy.remedy}`).not.toMatch(PROMISES_MOVE)
  })

  it('another python-import failure, record intact: nothing is moved, and the hint names a move only as conditional', async () => {
    intactRecord()
    cause = { code: 'python-import', line: "ImportError: cannot import name 'serve' from 'hermes_cli'" }

    const report = await createRepairKit(deps()).apply('runtime-venv', { dryRun: false })

    expect(report.steps.some(step => step.kind === 'move-aside')).toBe(false)

    const { remedy } = f3CauseCopy(cause)!

    expect(remedy).not.toMatch(/undo/i)

    // Every sentence that speaks of a move is an "If … broken" sentence.
    for (const sentence of remedy.split(/(?<=\.)\s+/).filter(line => /aside/i.test(line))) {
      expect(sentence).toMatch(/^If .*broken/)
    }
  })

  it('the interpreter is gone (runtime-env-broken): the kit does move the record aside, as that hint says', async () => {
    const { venv } = intactRecord()

    fs.rmSync(path.join(venv, 'bin', 'python'))
    cause = { code: 'runtime-env-broken', line: 'bin/python: No such file or directory' }

    const report = await createRepairKit(deps()).apply('runtime-venv', { dryRun: false })

    expect(report.steps.some(step => step.kind === 'move-aside')).toBe(true)
    expect(report.manifestDir).not.toBeNull()
    expect(f3CauseCopy(cause)!.remedy).toMatch(/moved aside/)
  })
})
