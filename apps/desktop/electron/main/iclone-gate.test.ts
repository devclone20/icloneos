/**
 * V3-S (K139, r2 M1): `prepareHermesSpawn`, the one preparation of every app-launched Hermes. The gate (install, verify,
 * armed probe) runs first; only then is a key minted. A pool spawn without a key, any role without the gate, and a
 * Hermes outside main are refused with `IcloneGateError`. What it returns is what the spawn must carry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  confinementEnv: {} as Record<string, string>,
  ensure: vi.fn(),
  fresh: vi.fn(),
  integrity: vi.fn(),
  release: vi.fn(),
  permissionAttach: vi.fn(),
  permissions: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => '/ud', getVersion: () => '0.0.3', isPackaged: true } }))
vi.mock('../iclone-confinement/ipc', () => ({ confinementSpawnEnv: () => h.confinementEnv }))
vi.mock('../iclone-permissions/ipc', () => ({ permissionsSpawn: h.permissions }))
vi.mock('../iclone-pycache', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  freshPycachePrefix: h.fresh,
  releasePycachePrefix: h.release
}))
vi.mock('../iclone-hermes-plugins', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureIcloneHermesPlugins: h.ensure
}))
// V3-RT (RT-3): the runtime's manifest check (iclone-runtime-integrity.test.ts) runs before the plugin gate.
vi.mock('../iclone-runtime-integrity', () => ({ ensureRuntimeIntegrity: h.integrity }))
vi.mock('./env', () => ({ ACTIVE_HERMES_ROOT: '/managed', HERMES_HOME: '/hh', SOURCE_REPO_ROOT: '/repo' }))
vi.mock('./log', () => ({ rememberLog: vi.fn() }))

vi.mock('./managed-hermes-runtime', () => ({
  devBackendRoots: () => ['/dev-checkout'],
  devPluginOverlayRoot: () => '/ud/hermes-dev-plugins',
  managedHermesRuntimeRoot: () => '/managed',
  managedRuntimePin: () => ({
    appVersion: '0.0.3',
    lockHash: 'c'.repeat(64),
    manifestSha256: 'd'.repeat(64),
    root: '/managed'
  })
}))

const { forgetRuntimeIntegrity, GATED_STDIO, prepareHermesSpawn } = await import('./iclone-gate')
const { IcloneGateError } = await import('../iclone-hermes-plugins')

const backend = { command: '/managed/venv/bin/python', env: {}, root: '/managed' }
const LOCK = { ICLONE_POLICY_FILE: '/ud/permissions/p.json', ICLONE_POLICY_KEY_FD: '3', ICLONE_POLICY_LOCK: '1' }

function keyed(keyLine: null | string) {
  h.permissions.mockReturnValue({ attach: h.permissionAttach, env: LOCK, keyLine })
}

beforeEach(() => {
  h.ensure.mockReset()
  h.permissions.mockReset()
  h.permissionAttach.mockReset()
  h.confinementEnv = { ICLONE_CONFINEMENT: '1', TERMINAL_ENV: 'iclone_seatbelt' }
  h.fresh.mockReset()
  h.release.mockReset()
  let n = 0
  h.fresh.mockImplementation((root: string, tag: string) => `${root}/${tag}-1-${(n += 1)}`)
  h.ensure.mockResolvedValue({ loaded: ['iclone-permissions'] })
  h.integrity.mockReset()
  forgetRuntimeIntegrity()
  // A runtime the check does not manage (a dev run, a checkout): V3-S r4's interim bytecode prefix. The managed rows
  // (verified / repaired: the shipped checked-hash bytecode, ruling 37) are in their own describe below.
  h.integrity.mockResolvedValue({ action: 'skipped', files: 0, ms: 0 })
})

describe('V3-RT RT-3: the runtime is this release before its plugins are checked', () => {
  it('the manifest check runs first, on the backend root, packaged, with the compiled pin', async () => {
    keyed('v1 k1 abcd\n')

    await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })

    expect(h.integrity).toHaveBeenCalledTimes(1)
    expect(h.integrity).toHaveBeenCalledWith(
      expect.objectContaining({
        appVersion: '0.0.3',
        managedRoot: '/managed',
        packaged: true,
        pin: expect.objectContaining({ source: 'repo' }),
        root: '/managed'
      })
    )
    expect(h.integrity.mock.invocationCallOrder[0]!).toBeLessThan(h.ensure.mock.invocationCallOrder[0]!)
  })

  it('a runtime the check refuses starts nothing: no plugin gate, no key, no prefix', async () => {
    keyed('v1 k1 abcd\n')
    h.integrity.mockRejectedValue(new IcloneGateError('the agent runtime still differs from this release'))

    await expect(prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })).rejects.toThrow(
      /^\[iclone-gate\] .*still differs from this release/
    )
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.permissions).not.toHaveBeenCalled()
    expect(h.fresh).not.toHaveBeenCalled()
  })
})

describe('V3-RT ruling 37: the managed runtime runs on its shipped checked-hash bytecode', () => {
  for (const action of ['verified', 'repaired'] as const) {
    it(`${action}: no prefix, nothing written, --check-hash-based-pycs always before the module`, async () => {
      keyed('v1 k1 abcd\n')
      h.integrity.mockResolvedValue({ action, files: 1, ms: 1 })

      const gated = await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })
      const env = gated.seal({ PYTHONPYCACHEPREFIX: '/planted' })

      expect(env.PYTHONDONTWRITEBYTECODE).toBe('1')
      expect(env).not.toHaveProperty('PYTHONPYCACHEPREFIX')
      expect(gated.argv(['-m', 'hermes_cli.main', 'serve'])).toEqual([
        '-s',
        '-P',
        '--check-hash-based-pycs',
        'always',
        '-m',
        'hermes_cli.main',
        'serve'
      ])
      expect(h.fresh).not.toHaveBeenCalled()
    })
  }

  it('a checkout (verified-checkout) keeps the interim prefix: its bytecode is not the release manifest', async () => {
    keyed('v1 k1 abcd\n')
    h.integrity.mockResolvedValue({ action: 'verified-checkout', files: 1, ms: 1 })

    const gated = await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })

    expect(gated.seal({}).PYTHONPYCACHEPREFIX).toBe('/ud/hermes-pycache/spawn-1-1')
    expect(gated.argv(['-m', 'x'])).toEqual(['-s', '-P', '-m', 'x'])
  })
})

describe('prepareHermesSpawn', () => {
  it('pool: gate first (with this profile and confinement), then the key; returns lock + confinement + cache env', async () => {
    keyed('v1 k1 abcd\n')

    const gated = await prepareHermesSpawn({ backend, cwd: '/work', profile: 'work', role: 'pool' })

    expect(h.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        activeRoot: '/managed',
        backend,
        confinement: true,
        cwd: '/work',
        hermesHome: '/hh',
        profile: 'work',
        pycacheRoot: '/ud/hermes-pycache'
      })
    )
    expect(h.ensure.mock.invocationCallOrder[0]!).toBeLessThan(h.permissions.mock.invocationCallOrder[0]!)
    expect(h.permissions).toHaveBeenCalledWith('/ud/run')
    expect(gated.seal({})).toEqual({
      ...LOCK,
      // Ruling 69: every gated runtime is told English (sealHermesSpawnEnv, 13554c3dff).
      HERMES_LANGUAGE: 'en',
      ICLONE_CONFINEMENT: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPYCACHEPREFIX: '/ud/hermes-pycache/spawn-1-1',
      TERMINAL_ENV: 'iclone_seatbelt'
    })
    expect(gated.stdio).toEqual(['ignore', 'pipe', 'pipe', 'pipe'])
    expect(gated.stdio).toBe(GATED_STDIO)
  })

  it('attach: the key goes down fd 3 once and the pipe closes; the pid is registered with the authority', async () => {
    keyed('v1 k1 abcd\n')
    const gated = await prepareHermesSpawn({ backend, cwd: '/work', profile: 'work', role: 'pool' })
    const pipe = { end: vi.fn(), on: vi.fn() }
    const child = { once: vi.fn(), pid: 4242, stdio: [null, null, null, pipe] }

    gated.attach(child as never)

    expect(pipe.end).toHaveBeenCalledExactlyOnceWith('v1 k1 abcd\n')
    expect(h.permissionAttach).toHaveBeenCalledWith(child)
  })

  it('m-a′: each spawn’s bytecode prefix is taken after the gate passed, with no bytecode written; released on exit', async () => {
    keyed('v1 k1 abcd\n')
    const first = await prepareHermesSpawn({ backend, cwd: '/work', profile: 'work', role: 'pool' })
    const second = await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })

    expect(h.fresh).toHaveBeenNthCalledWith(1, '/ud/hermes-pycache', 'spawn')
    expect(h.ensure.mock.invocationCallOrder[0]!).toBeLessThan(h.fresh.mock.invocationCallOrder[0]!)
    expect(second.seal({}).PYTHONDONTWRITEBYTECODE).toBe('1')

    const exits: Array<() => void> = []

    const child = {
      once: vi.fn((event: string, cb: () => void) => event === 'exit' && exits.push(cb)),
      pid: 7,
      stdio: [null, null, null, { end: vi.fn(), on: vi.fn() }]
    }

    first.attach(child as never)
    expect(h.release).not.toHaveBeenCalled()
    exits.forEach(cb => cb())
    expect(h.release).toHaveBeenCalledExactlyOnceWith(first.seal({}).PYTHONPYCACHEPREFIX)
  })

  it('m-a: a bytecode prefix that cannot be made safe ⇒ IcloneGateError, nothing to spawn', async () => {
    keyed('v1 k1 abcd\n')
    h.fresh.mockImplementation(() => {
      throw new Error('/ud/hermes-pycache is not a directory')
    })

    await expect(prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })).rejects.toThrow(
      /\[iclone-gate\] .*bytecode cache could not be prepared/
    )
  })

  it('m-f: seal() — the lock wins over anything composed before it, for the primary and a pool backend', async () => {
    keyed('v1 k1 abcd\n')

    const composed = {
      ICLONE_CONFINEMENT: '0',
      // Not ICLONE_-prefixed: only the order of seal() keeps the confined shell (V3-G).
      TERMINAL_ENV: 'local',
      ICLONE_POLICY_FILE: '/evil/policy.json',
      ICLONE_POLICY_KEY_FD: '9',
      ICLONE_POLICY_LOCK: '0',
      PYTHONDONTWRITEBYTECODE: '0',
      PYTHONPYCACHEPREFIX: '/shared/cache'
    }

    for (const role of ['primary', 'pool'] as const) {
      const gated = await prepareHermesSpawn({ backend, cwd: '/work', profile: 'work', role })
      const env = gated.seal(composed)

      expect(env).toMatchObject({
        ...LOCK,
        ICLONE_CONFINEMENT: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        TERMINAL_ENV: 'iclone_seatbelt'
      })
      expect(env.PYTHONPYCACHEPREFIX).toMatch(/^\/ud\/hermes-pycache\/spawn-/)
    }
  })

  it('r4 (ruling 36): an unmanaged dev runtime — the plugin folder the probe armed from is in the gate env, applied last', async () => {
    keyed('v1 k1 abcd\n')
    h.ensure.mockResolvedValue({
      env: { HERMES_BUNDLED_PLUGINS: '/ud/hermes-dev-plugins/plugins' },
      loaded: ['iclone-permissions']
    })

    const gated = await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })

    expect(h.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        devOverlayRoot: '/ud/hermes-dev-plugins',
        devRoots: ['/dev-checkout'],
        pin: expect.objectContaining({ lockHash: 'c'.repeat(64), manifestSha256: 'd'.repeat(64) })
      })
    )
    expect(gated.seal({ HERMES_BUNDLED_PLUGINS: '/evil/plugins' }).HERMES_BUNDLED_PLUGINS).toBe(
      '/ud/hermes-dev-plugins/plugins'
    )
  })

  it('m-f: seal() — a pool backend keeps no payment env; the primary keeps its own', async () => {
    keyed('v1 k1 abcd\n')
    const pay = { ICLONE_PAY_SOCKET: '/ud/pay.sock', ICLONE_PAY_TOKEN_FILE: '/ud/pay/t' }

    const pool = (await prepareHermesSpawn({ backend, cwd: '/work', profile: 'work', role: 'pool' })).seal(pay)
    const primary = (await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })).seal(pay)

    expect(Object.keys(pool).filter(key => key.startsWith('ICLONE_PAY_'))).toEqual([])
    expect(primary).toMatchObject(pay)
  })

  it('pool without a key (the permission authority is not up) ⇒ IcloneGateError, fail closed', async () => {
    keyed(null)

    const error = await prepareHermesSpawn({ backend, cwd: '/work', profile: 'work', role: 'pool' }).catch(e => e)

    expect(error).toBeInstanceOf(IcloneGateError)
    expect(String(error.message)).toMatch(/^\[iclone-gate\] .*could not issue a permission key .*"work"/)
  })

  it('primary without a key still starts locked (V3-F F-7: the gate runs Manual and refuses all but reading)', async () => {
    keyed(null)

    const gated = await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })

    expect(gated.seal({ ICLONE_POLICY_LOCK: '0' })).toMatchObject({ ICLONE_POLICY_LOCK: '1' })
  })

  it('a refused gate mints no key and returns nothing', async () => {
    h.ensure.mockRejectedValue(new IcloneGateError('Hermes loaded iclone-permissions but it registered no hook'))

    await expect(prepareHermesSpawn({ backend, cwd: '/work', profile: 'w', role: 'pool' })).rejects.toThrow(
      /\[iclone-gate\]/
    )
    await expect(prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })).rejects.toThrow(
      /\[iclone-gate\]/
    )
    expect(h.permissions).not.toHaveBeenCalled()
  })

  it('confinement off ⇒ the gate is asked without it and the env carries no confinement', async () => {
    h.confinementEnv = {}
    keyed('v1 k1 abcd\n')

    const gated = await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })

    expect(h.ensure).toHaveBeenCalledWith(expect.objectContaining({ confinement: false }))
    expect(gated.seal({ ICLONE_CONFINEMENT: '1' })).not.toHaveProperty('ICLONE_CONFINEMENT')
  })

  it('external-terminal ⇒ refused before any gate work or key', async () => {
    keyed('v1 k1 abcd\n')

    await expect(
      prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'external-terminal' })
    ).rejects.toBeInstanceOf(IcloneGateError)
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.permissions).not.toHaveBeenCalled()
  })
})
