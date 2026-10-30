/**
 * V3-S r2 (m1): while a Repair is pending, resolveHermesBackend skips steps 4–5 (a Hermes on PATH, a system Python with
 * hermes_cli). The permission gate refuses those runtimes, so returning one would refuse the boot again and Repair would
 * never reach the installer. Without a pending Repair the ladder is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  bootState: { bootstrapRepairRequested: false } as Record<string, unknown>,
  canImport: vi.fn(() => true),
  findOnPath: vi.fn(),
  findSystemPython: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' }, BrowserWindow: {}, dialog: {} }))
vi.mock('../active-runtime-state', () => ({
  // The active runtime is usable: only a pending Repair makes the resolver go past step 3.
  classifyActiveRuntime: () => ({ hasValidMarker: true, shouldUseActiveRuntime: true })
}))
vi.mock('../backend-probes', () => ({
  canImportHermesCli: h.canImport,
  shouldTrustHermesOverride: () => false,
  verifyHermesCli: () => true
}))
vi.mock('../bootstrap-platform', () => ({ isWindowsBinaryPathInWsl: () => false }))
vi.mock('../bootstrap-runner', () => ({}))
vi.mock('../gitlock', () => ({}))
vi.mock('../handoff-result', () => ({}))
vi.mock('../lib/fs-json', () => ({ readJsonFileSync: () => null }))
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
  ACTIVE_HERMES_ROOT: '/managed',
  activeVenvRoot: () => '/managed/venv',
  directoryExists: () => false,
  fileExists: () => false,
  HERMES_HOME: '/hh',
  INSTALL_STAMP: null,
  IS_MAC: true,
  IS_PACKAGED: true,
  IS_WINDOWS: false,
  IS_WSL: false,
  isHermesSourceRoot: () => false,
  SOURCE_REPO_ROOT: '/repo',
  VENV_ROOT: '/managed/venv'
}))
vi.mock('./executables', () => ({
  findOnPath: h.findOnPath,
  findSystemPython: h.findSystemPython,
  getVenvPython: () => '/managed/venv/bin/python',
  isCommandScript: () => false,
  looksLikeDesktopAppBinary: () => false,
  runResolvedGit: vi.fn(),
  unwrapWindowsVenvHermesCommand: () => null
}))
vi.mock('./log', () => ({ rememberLog: vi.fn(), updatePolicy: () => 'curated' }))
vi.mock('./paths', () => ({ BOOTSTRAP_COMPLETE_MARKER: '/managed/.marker', BOOTSTRAP_MARKER_SCHEMA_VERSION: 1 }))
vi.mock('./runtime', () => ({
  createActiveBackend: (args: string[]) => ({
    args,
    command: '/managed/venv/bin/python',
    kind: 'python',
    root: '/managed'
  }),
  createPythonBackend: vi.fn(),
  curatedRuntimeConfig: vi.fn()
}))
vi.mock('./state', () => ({ bootState: h.bootState, quitState: {} }))

const { resolveHermesBackend } = await import('./updates')

beforeEach(() => {
  h.findOnPath.mockReset().mockReturnValue('/usr/local/bin/hermes')
  h.findSystemPython.mockReset().mockReturnValue('/usr/bin/python3')
})

describe('resolveHermesBackend under a pending Repair', () => {
  it('skips a Hermes on PATH and a system Python: the installer is reached', () => {
    h.bootState.bootstrapRepairRequested = true

    const backend = resolveHermesBackend(['serve'])

    expect(backend).toMatchObject({ bootstrap: true, command: null, kind: 'bootstrap-needed' })
    expect(h.findOnPath).not.toHaveBeenCalled()
    expect(h.findSystemPython).not.toHaveBeenCalled()
  })

  it('without a Repair the usable managed runtime is used (step 3), as before', () => {
    h.bootState.bootstrapRepairRequested = false

    expect(resolveHermesBackend(['serve'])).toMatchObject({ kind: 'python', root: '/managed' })
  })
})
