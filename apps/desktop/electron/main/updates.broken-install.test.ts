/**
 * v0.0.9 r2 (m-r2-2): a broken install of the app's own runtime is a boot failure, not a first run.
 *
 * Red on the old code: with the bootstrap marker written and the source tree in place, a dangling `venv/bin/python`
 * made the runtime "unusable" and the resolver returned the plain `bootstrap-needed` sentinel — the first-run
 * "Set up iclone os" chooser, no cause, the repair kit unreachable under it (r2 proof, App 21).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { brokenAppInstallReason } from '../active-runtime-state'
import { createFirstRunSetupGate } from '../first-run-setup-gate'

const h = vi.hoisted(() => ({
  bootState: { bootstrapRepairRequested: false } as Record<string, unknown>,
  marker: null as null | Record<string, unknown>,
  recorded: true,
  root: '',
  python: ''
}))

h.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'broken-install-')))
h.python = path.join(h.root, 'venv', 'bin', 'python')
afterAll(() => fs.rmSync(h.root, { force: true, recursive: true }))

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' }, BrowserWindow: {}, dialog: {} }))
vi.mock('../backend-probes', () => ({
  canImportHermesCli: () => true,
  shouldTrustHermesOverride: () => false,
  verifyHermesCli: () => true
}))
vi.mock('../bootstrap-platform', () => ({ isWindowsBinaryPathInWsl: () => false }))
vi.mock('../bootstrap-runner', () => ({}))
vi.mock('../gitlock', () => ({}))
vi.mock('../handoff-result', () => ({}))
vi.mock('../iclone-runtime-closed', () => ({ isRecordedInstall: () => h.recorded, sealRuntimeDependencies: vi.fn() }))
vi.mock('../lib/fs-json', () => ({ readJsonFileSync: () => h.marker }))
vi.mock('../packaged-env', () => ({ codePathEnv: () => undefined }))
vi.mock('../update-count', () => ({}))
vi.mock('../update-gate', () => ({}))
vi.mock('../update-marker', () => ({}))
vi.mock('../update-policy', () => ({ BUNDLED_RUNTIME_PIN: null, runtimePinStatus: vi.fn() }))
vi.mock('../update-remote', () => ({}))
vi.mock('../update-runtime-align', () => ({}))
vi.mock('../update-swap-guard', () => ({}))
vi.mock('../updater-process', () => ({}))
vi.mock('./boot-progress', () => ({}))
vi.mock('./desktop-settings', () => ({}))
vi.mock('./env', () => ({
  get ACTIVE_HERMES_ROOT() {
    return h.root
  },
  activeVenvRoot: () => path.join(h.root, 'venv'),
  directoryExists: () => false,
  fileExists: (file: string) => {
    try {
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  },
  HERMES_HOME: '/hh',
  INSTALL_STAMP: null,
  IS_MAC: true,
  IS_PACKAGED: true,
  IS_WINDOWS: false,
  IS_WSL: false,
  isHermesSourceRoot: (root: string) => root === h.root,
  SOURCE_REPO_ROOT: '/repo',
  get VENV_ROOT() {
    return path.join(h.root, 'venv')
  }
}))
vi.mock('./executables', () => ({
  findOnPath: () => null,
  findSystemPython: () => null,
  getVenvPython: (venv: string) => path.join(venv, 'bin', 'python'),
  isCommandScript: () => false,
  looksLikeDesktopAppBinary: () => false,
  runResolvedGit: vi.fn(),
  unwrapWindowsVenvHermesCommand: () => null
}))
vi.mock('./log', () => ({ rememberLog: vi.fn(), updatePolicy: () => 'curated' }))
vi.mock('./paths', () => ({ BOOTSTRAP_COMPLETE_MARKER: '/managed/.marker', BOOTSTRAP_MARKER_SCHEMA_VERSION: 1 }))
vi.mock('./runtime', () => ({
  createActiveBackend: (args: string[]) => ({ args, command: h.python, kind: 'python', root: h.root }),
  createPythonBackend: vi.fn(),
  curatedRuntimeConfig: vi.fn()
}))
vi.mock('./state', () => ({ bootState: h.bootState, quitState: {} }))

const { resolveHermesBackend } = await import('./updates')

const MARKER = { pinnedCommit: '1234567890abcdef1234567890abcdef12345678', schemaVersion: 1 }

function venv(state: 'dangling' | 'missing' | 'present') {
  fs.rmSync(path.join(h.root, 'venv'), { force: true, recursive: true })

  if (state === 'missing') {
    return
  }

  fs.mkdirSync(path.dirname(h.python), { recursive: true })

  if (state === 'dangling') {
    fs.symlinkSync(path.join(h.root, 'gone', 'python3.14'), h.python)
  } else {
    fs.writeFileSync(h.python, '')
  }
}

beforeEach(() => {
  h.bootState.bootstrapRepairRequested = false
  h.marker = MARKER
  h.recorded = true
})

describe('resolveHermesBackend: a broken install of the app runtime (m-r2-2)', () => {
  it('a dangling venv python under a finished install is a broken install, never the first-run choice', () => {
    venv('dangling')

    const backend = resolveHermesBackend(['serve'])

    expect(backend).toMatchObject({ kind: 'bootstrap-needed' })
    expect((backend as { brokenInstall?: string }).brokenInstall).toBe(
      `the agent's Python interpreter ${h.python} points at a file that is gone`
    )
    expect(createFirstRunSetupGate().shouldGate(backend as never)).toBe(false)
  })

  it('a missing interpreter under a finished install is broken too', () => {
    venv('missing')

    expect((resolveHermesBackend(['serve']) as { brokenInstall?: string }).brokenInstall).toContain('is missing')
  })

  it('a real first run (no marker, no record) still gets the chooser', () => {
    venv('missing')
    h.marker = null
    h.recorded = false

    const backend = resolveHermesBackend(['serve'])

    expect((backend as { brokenInstall?: string }).brokenInstall).toBeUndefined()
    expect(createFirstRunSetupGate().shouldGate(backend as never)).toBe(true)
  })

  it('once the owner asked Repair for the installer it is a reinstall, not a broken-install failure again', () => {
    venv('dangling')
    h.bootState.bootstrapRepairRequested = true

    const backend = resolveHermesBackend(['serve'])

    expect((backend as { brokenInstall?: string }).brokenInstall).toBeUndefined()
  })
})

describe('brokenAppInstallReason', () => {
  const base = {
    activeRuntimeUsable: false,
    hasSourceTree: true,
    installedByApp: true,
    repairRequested: false,
    venvPython: '/r/venv/bin/python',
    venvPythonState: 'dangling' as const
  }

  it('names the interpreter for each state', () => {
    expect(brokenAppInstallReason(base)).toContain('points at a file that is gone')
    expect(brokenAppInstallReason({ ...base, venvPythonState: 'missing' })).toContain('is missing')
    expect(brokenAppInstallReason({ ...base, venvPythonState: 'present' })).toContain('cannot start the agent')
  })

  it('is null for a usable runtime, a pending repair, no tree, or an install the app never finished', () => {
    expect(brokenAppInstallReason({ ...base, activeRuntimeUsable: true })).toBeNull()
    expect(brokenAppInstallReason({ ...base, repairRequested: true })).toBeNull()
    expect(brokenAppInstallReason({ ...base, hasSourceTree: false })).toBeNull()
    expect(brokenAppInstallReason({ ...base, installedByApp: false })).toBeNull()
  })
})
