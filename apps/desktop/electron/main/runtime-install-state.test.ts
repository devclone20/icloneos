/**
 * v0.0.9 F2 point A (gate G3, app side): main DETECTS install state for the app's own runtime under HERMES_HOME and
 * never moves or writes it (lead decision 17 Nov: it can be the user's own standalone Hermes state; moving is the
 * repair kit's job on the owner's click). The sandbox rule stays as it is. Disposable HOME under the OS temp dir only.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HERMES_HOME_NEVER_WRITTEN } from '../iclone-confinement/runtime-profile'

import {
  dependencyHomeRoot,
  detectForeignInstallState,
  isAppManagedRuntime,
  managedRuntimeEnv,
  privateDependencyHome,
  runtimeInstallKey
} from './runtime-install-state'

let base: string
let home: string
let hermesHome: string
let runtimeRoot: string
let key: string

/** A stale record as the runtime leaves it: facts.json + a lease-managed environment generation. */
function plantStaleRecord(root: string): string {
  const record = path.join(root, 'installs', key)
  const generation = path.join(record, 'environments', 'd2a0574ad8364ad4a87cee896f2a3bea')

  fs.mkdirSync(path.join(generation, '.leases'), { recursive: true })
  fs.writeFileSync(path.join(generation, '.lease-managed'), '')
  fs.writeFileSync(
    path.join(record, 'facts.json'),
    JSON.stringify({ packages: { venv: { environment: path.join(generation, 'venv') } } })
  )

  return record
}

/** Every path under `dir` with its mtime, sorted (a manifest to diff before/after). */
function manifest(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return []
  }

  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .map(String)
    .sort()
    .map(rel => `${rel}@${fs.lstatSync(path.join(dir, rel)).mtimeMs}`)
}

const detect = (hermes = hermesHome, root: string = runtimeRoot) =>
  detectForeignInstallState({ hermesHome: hermes, home, platform: 'darwin', runtimeRoot: root })

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f2-installs-')))
  home = path.join(base, 'home')
  hermesHome = path.join(home, '.hermes')
  runtimeRoot = path.join(base, 'userData', 'hermes-runtime', 'sha')
  fs.mkdirSync(path.join(runtimeRoot, '.iclone-deps', 'hermes', 'installs'), { recursive: true })
  fs.mkdirSync(hermesHome, { recursive: true })
  key = runtimeInstallKey(runtimeRoot)
})

afterEach(() => {
  fs.rmSync(base, { force: true, recursive: true })
})

describe('point A: detection of a stale install record for the app’s runtime', () => {
  it('the key is the runtime’s own: sha256(realpath(root))[:16] (pm/environments.py install_key)', () => {
    expect(key).toBe(crypto.createHash('sha256').update(fs.realpathSync(runtimeRoot)).digest('hex').slice(0, 16))
  })

  it('finds the record and changes nothing under HERMES_HOME (no move, no write)', () => {
    const record = plantStaleRecord(hermesHome)
    const before = manifest(hermesHome)

    expect(detect()).toEqual({ records: [record], key })
    expect(manifest(hermesHome)).toEqual(before)
    expect(fs.existsSync(path.join(record, 'facts.json'))).toBe(true)
  })

  it('a profile HERMES_HOME (~/.hermes/profiles/<name>) is scoped to the ~/.hermes root, as the runtime does', () => {
    const profileHome = path.join(hermesHome, 'profiles', 'work')

    fs.mkdirSync(profileHome, { recursive: true })
    expect(dependencyHomeRoot(profileHome, hermesHome)).toBe(hermesHome)

    // Planted BEFORE detecting (inline in toEqual it ran after detect() and the scan found nothing).
    const record = plantStaleRecord(hermesHome)

    expect(detect(profileHome).records).toEqual([record])
  })

  it('a custom HERMES_HOME outside ~/.hermes is its own root (and ~/.hermes is still checked)', () => {
    const custom = path.join(base, 'custom-home')

    fs.mkdirSync(custom, { recursive: true })
    expect(dependencyHomeRoot(custom, hermesHome)).toBe(custom)

    const inCustom = plantStaleRecord(custom)
    const inDefault = plantStaleRecord(hermesHome)

    expect(detect(custom).records.sort()).toEqual([inCustom, inDefault].sort())
  })

  it('the healthy case (no record): nothing found, nothing created', () => {
    const before = manifest(hermesHome)

    expect(detect().records).toEqual([])
    expect(manifest(hermesHome)).toEqual(before)
  })

  it('a folder for the key without a selection record (bootstrap/ records, a lock) is not reported', () => {
    fs.mkdirSync(path.join(hermesHome, 'installs', key, 'bootstrap'), { recursive: true })
    expect(detect().records).toEqual([])
  })

  it('the app’s PRIVATE install state (under the runtime) is never reported', () => {
    const privateHermes = path.join(runtimeRoot, '.iclone-deps', 'hermes')

    plantStaleRecord(privateHermes)
    expect(detect(privateHermes).records).toEqual([])
  })

  it('a runtime the app does not manage (no .iclone-deps) is never looked at', () => {
    const checkout = path.join(base, 'checkout')

    fs.mkdirSync(checkout, { recursive: true })
    expect(isAppManagedRuntime(checkout)).toBe(false)
    expect(detect(hermesHome, checkout).skipped).toBe('unmanaged')
  })

  it('the sandbox rule does not loosen: installs/, plugins/ and tools/ of HERMES_HOME stay never-written', () => {
    expect([...HERMES_HOME_NEVER_WRITTEN].sort()).toEqual(['installs', 'plugins', 'tools'])
  })
})

describe('point A: managedRuntimeEnv, the env every launch of the app’s runtime carries', () => {
  it('the app’s runtime: its private dependency root pinned, lazy installs off', () => {
    expect(managedRuntimeEnv(runtimeRoot)).toEqual({
      HERMES_DEPENDENCY_HOME: path.join(runtimeRoot, '.iclone-deps', 'hermes'),
      HERMES_DISABLE_LAZY_INSTALLS: '1'
    })
    expect(privateDependencyHome(runtimeRoot)).toBe(path.join(runtimeRoot, '.iclone-deps', 'hermes'))
  })

  it('any other runtime (a dev checkout, the user’s own Hermes, none): nothing', () => {
    const checkout = path.join(base, 'checkout')

    fs.mkdirSync(checkout, { recursive: true })
    expect(managedRuntimeEnv(checkout)).toEqual({})
    expect(managedRuntimeEnv(null)).toEqual({})
    expect(managedRuntimeEnv(undefined)).toEqual({})
  })
})

describe('point A: the spawn (source pins)', () => {
  const src = () => fs.readFileSync(path.join(__dirname, 'start-hermes.ts'), 'utf8')

  it('start-hermes never moves, renames or removes anything under installs/ before the start', () => {
    const body = src()

    expect(body).toContain('detectForeignInstallState({')
    expect(body).not.toMatch(/quarantine|renameSync|rmSync|installs-aside/)
  })

  it('the app’s runtime is told never to sync dependencies lazily (no installs/<key> from the backend)', () => {
    // v0.0.9 Q decision 4: passed as the seal's explicit appEnv (never inside the inherited composition).
    expect(src()).toContain('}, managedRuntimeEnv(backend.root)),')
    expect(src()).not.toContain('...managedRuntimeEnv(backend.root),')
  })
})

describe('v0.0.9 Q (F3 rerun): the stale-record log line is truthful', () => {
  it('pinned runtime: the record is ignored, never "cannot start on it"', async () => {
    const { foreignInstallStateLogLine } = await import('./runtime-install-state')
    const pinned = foreignInstallStateLogLine(['/u/.hermes/installs/k'], true)

    expect(pinned).toMatch(/ignores it/)
    expect(pinned).toMatch(/does not block the start/)
    expect(pinned).not.toMatch(/cannot start/)
    expect(foreignInstallStateLogLine(['/u/.hermes/installs/k'], false)).toMatch(/cannot start on it/)
  })
})
