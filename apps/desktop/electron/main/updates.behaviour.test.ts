/**
 * Critics' panel CRITICOS_V3RT, minor 5: three guarantees of the update module that the gate's mutation rows used to
 * prove by reading updates.ts as text. Here they are exercised: the real module, its neighbours mocked, and the calls
 * it makes observed.
 *   - M2: git in the update root is bounded (a ceiling at the root's parent, no optional locks).
 *   - ruling 42 (V3-RT-B r2): a packaged boot decides the runtime is usable from file reads and the install record,
 *     never from a blocking Python probe.
 *   - critic r2 M1: the curated (pinned) update path never records the Python environment; only an install from
 *     nothing does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  canImport: vi.fn(() => true),
  classify: vi.fn((_marker: unknown, _schema: unknown, usable: boolean) => ({
    hasValidMarker: true,
    shouldUseActiveRuntime: usable
  })),
  isRecordedInstall: vi.fn(() => true),
  runPinnedRuntimeUpdate: vi.fn(async () => ({ ok: true })),
  runResolvedGit: vi.fn(async () => ({ code: 0, stderr: '', stdout: 'https://example.invalid/repo.git\n' })),
  seal: vi.fn(() => ({ files: 1 }))
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent', getVersion: () => '0.0.3' },
  BrowserWindow: {},
  dialog: {}
}))
vi.mock('../active-runtime-state', () => ({ classifyActiveRuntime: h.classify }))
vi.mock('../backend-probes', () => ({
  canImportHermesCli: h.canImport,
  shouldTrustHermesOverride: () => false,
  verifyHermesCli: () => true
}))
vi.mock('../bootstrap-platform', () => ({ isWindowsBinaryPathInWsl: () => false }))
vi.mock('../bootstrap-runner', () => ({ runPinnedRuntimeUpdate: h.runPinnedRuntimeUpdate }))
vi.mock('../gitlock', () => ({}))
vi.mock('../handoff-result', () => ({}))
vi.mock('../iclone-runtime-closed', () => ({
  isRecordedInstall: h.isRecordedInstall,
  sealRuntimeDependencies: h.seal
}))
vi.mock('../lib/fs-json', () => ({ readJsonFileSync: () => null }))
vi.mock('../packaged-env', () => ({ codePathEnv: () => undefined }))
vi.mock('../update-count', () => ({}))
vi.mock('../update-gate', () => ({}))
vi.mock('../update-marker', () => ({}))
vi.mock('../update-policy', () => ({ BUNDLED_RUNTIME_PIN: { sha: 'a'.repeat(40) }, runtimePinStatus: vi.fn() }))
vi.mock('../update-remote', () => ({}))
vi.mock('../update-runtime-align', () => ({}))
vi.mock('../update-swap-guard', () => ({}))
vi.mock('../updater-process', () => ({}))
vi.mock('./boot-progress', () => ({}))
vi.mock('./desktop-settings', () => ({}))
vi.mock('./env', () => ({
  ACTIVE_HERMES_ROOT: '/app/runtime/hermes-agent',
  activeVenvRoot: () => '/app/runtime/hermes-agent/venv',
  directoryExists: () => true,
  fileExists: () => true,
  HERMES_HOME: '/hh',
  INSTALL_STAMP: null,
  IS_MAC: true,
  IS_PACKAGED: true,
  IS_WINDOWS: false,
  IS_WSL: false,
  isHermesSourceRoot: () => true,
  resolveUpdateRoot: () => '/app/runtime/hermes-agent',
  runtimePrivateDependencies: () => null,
  SOURCE_REPO_ROOT: '/repo',
  VENV_ROOT: '/app/runtime/hermes-agent/venv'
}))
vi.mock('./executables', () => ({
  findOnPath: () => null,
  findSystemPython: () => null,
  getVenvPython: () => '/app/runtime/hermes-agent/venv/bin/python',
  isCommandScript: () => false,
  looksLikeDesktopAppBinary: () => false,
  runResolvedGit: h.runResolvedGit,
  unwrapWindowsVenvHermesCommand: () => null
}))
vi.mock('./log', () => ({ rememberLog: vi.fn(), updatePolicy: () => 'curated' }))
vi.mock('./paths', () => ({ BOOTSTRAP_COMPLETE_MARKER: '/app/runtime/.marker', BOOTSTRAP_MARKER_SCHEMA_VERSION: 1 }))
vi.mock('./runtime', () => ({
  createActiveBackend: (args: string[]) => ({
    args,
    command: '/app/runtime/hermes-agent/venv/bin/python',
    kind: 'python',
    root: '/app/runtime/hermes-agent'
  }),
  createPythonBackend: vi.fn(),
  curatedRuntimeConfig: vi.fn()
}))
vi.mock('./state', () => ({ bootState: { bootstrapRepairRequested: false }, quitState: {} }))

const { applyUpdatesPosixHandoff, getOriginUrl, resolveHermesBackend } = await import('./updates')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the update module, exercised (critics panel minor 5)', () => {
  it('M2: git in the update root gets a ceiling at the root parent and takes no optional lock', async () => {
    expect(await getOriginUrl('/Users/u/Library/rt/hermes-agent')).toBe('https://example.invalid/repo.git')

    expect(h.runResolvedGit).toHaveBeenCalledTimes(1)
    expect(h.runResolvedGit).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/Users/u/Library/rt/hermes-agent',
      env: { GIT_CEILING_DIRECTORIES: '/Users/u/Library/rt', GIT_OPTIONAL_LOCKS: '0' }
    })
  })

  it('ruling 42: a packaged boot finds its runtime usable from the install record, with no Python probe', () => {
    const backend = resolveHermesBackend(['serve'])

    expect(h.canImport).not.toHaveBeenCalled()
    expect(h.isRecordedInstall).toHaveBeenCalledWith('/app/runtime/hermes-agent')
    expect(h.classify).toHaveBeenCalledWith(null, 1, true)
    expect(backend).toMatchObject({ kind: 'python', root: '/app/runtime/hermes-agent' })
  })

  it('ruling 42: a packaged runtime whose install was never recorded is not usable, still with no probe', () => {
    h.isRecordedInstall.mockReturnValueOnce(false)

    resolveHermesBackend(['serve'])

    expect(h.canImport).not.toHaveBeenCalled()
    expect(h.classify).toHaveBeenCalledWith(null, 1, false)
  })

  it('critic r2 M1: the curated update path runs the pinned update and never records the environment', async () => {
    expect(await applyUpdatesPosixHandoff({})).toEqual({ ok: true })

    expect(h.runPinnedRuntimeUpdate).toHaveBeenCalledTimes(1)
    expect(h.seal).not.toHaveBeenCalled()
  })
})
