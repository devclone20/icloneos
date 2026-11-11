/**
 * V3-S (K139, r2 M1): `prepareHermesSpawn`, the one preparation of every app-launched Hermes. The gate (install, verify,
 * armed probe) runs first; only then is a key minted. A pool spawn without a key, any role without the gate, and a
 * Hermes outside main are refused with `IcloneGateError`. What it returns is what the spawn must carry.
 */
import { EventEmitter } from 'node:events'
import os from 'node:os'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  confinementEnv: {} as Record<string, string>,
  ensure: vi.fn(),
  fresh: vi.fn(),
  integrity: vi.fn(),
  release: vi.fn(),
  permissionAttach: vi.fn(),
  permissions: vi.fn(),
  layer: null as null | Record<string, ReturnType<typeof vi.fn>>,
  execFile: vi.fn()
}))

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFile: h.execFile
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/ud', getVersion: () => '0.0.3', isPackaged: true }
}))
vi.mock('../iclone-confinement/ipc', () => ({ confinementSpawnEnv: () => h.confinementEnv }))
vi.mock('../iclone-confinement/index', () => ({ currentConfinement: () => h.layer }))
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

const { checkRuntimeIntegrity, forgetRuntimeIntegrity, GATED_STDIO, prepareHermesSpawn } = await import('./iclone-gate')
const { IcloneGateError } = await import('../iclone-hermes-plugins')
const { rememberLog } = await import('./log')
const { appTeardown } = await import('../teardown-registry')

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

describe('L4-01: every spawn checks its runtime, one check at a time, never a verdict reused by age', () => {
  it('two spawns check twice; the second starts only after the first ended; a failed check fails only its spawn', async () => {
    const events: string[] = []
    let release: () => void = () => undefined
    let n = 0

    h.integrity.mockImplementation(async () => {
      const id = (n += 1)
      events.push(`start ${id}`)

      if (id === 1) {
        await new Promise<void>(resolve => (release = resolve))
        events.push('end 1')

        throw new IcloneGateError('the agent runtime still differs from this release')
      }

      events.push(`end ${id}`)

      return { action: 'verified', files: 1, ms: 1 }
    })

    const first = checkRuntimeIntegrity('/managed', '/res')
    const second = checkRuntimeIntegrity('/managed', '/res')
    await new Promise(resolve => setImmediate(resolve))
    expect(events).toEqual(['start 1'])

    release()
    await expect(first).rejects.toThrow(/still differs/)
    await expect(second).resolves.toMatchObject({ action: 'verified' })
    expect(events).toEqual(['start 1', 'end 1', 'start 2', 'end 2'])
    await expect(checkRuntimeIntegrity('/managed', '/res')).resolves.toMatchObject({ action: 'verified' })
    expect(h.integrity).toHaveBeenCalledTimes(3)
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

describe('runtime confinement: Hermes under the runtime profile, the launcher first', () => {
  const TEXT = '(version 1)\n(deny default)\n(allow file-read* (subpath (param "RUNTIME_ROOT")))\n'

  const SPAWN_ENV = {
    ICLONE_CONFINEMENT: '1',
    TERMINAL_ENV: 'iclone_seatbelt',
    ICLONE_CONFINEMENT_LAUNCHER: '/ud/confinement/run/launcher.sock',
    ICLONE_RUNTIME_CONFINED: '1'
  }

  let order: string[]

  /** A confinement layer whose runtimeSpawn wraps like the generator: sandbox-exec, -p text, defines, then the command. */
  function layer(launcher: 'down' | 'up' = 'up') {
    const release = vi.fn(async () => undefined)

    const fake = {
      runtimeConfined: vi.fn(() => true),
      interpreterRefusal: vi.fn((): null | string => null),
      ensureLauncher: vi.fn(async () => {
        order.push('launcher')

        return launcher
      }),
      leaseLauncher: vi.fn(() => release),
      stopLauncher: vi.fn(async () => undefined),
      runtimeTmpDir: vi.fn(() => '/ud/confinement/run/tmp'),
      runtimeSpawn: vi.fn((command: string, args: string[], facts: { project: null | string; runtimeRoot: string }) => ({
        command: '/usr/bin/sandbox-exec',
        args: [
          '-p',
          TEXT,
          '-D',
          `RUNTIME_ROOT=${facts.runtimeRoot}`,
          '-D',
          `PROJECT=${facts.project}`,
          command,
          ...args
        ],
        profile: { text: TEXT, sha256: 'e'.repeat(64), view: { reads: [], writes: [], denied: [] } }
      }))
    }

    h.layer = fake

    return { fake, release }
  }

  beforeEach(() => {
    order = []
    h.layer = null
    h.confinementEnv = { ...SPAWN_ENV }
    h.ensure.mockResolvedValue({ loaded: ['iclone-permissions'], env: {}, runtimeRoot: '/managed' })
    h.execFile.mockReset()
    h.execFile.mockImplementation(
      (command: string, args: string[], _options: unknown, done: (e: null, out: string, err: string) => void) => {
        order.push(`probe ${command === '/usr/bin/getconf' ? args[0] : 'python'}`)
        done(null, '/rt/venv\n/rt/base\n', '')
      }
    )
    keyed('v1 k1 abcd\n')
  })

  it('confinement on: command is sandbox-exec, -p is the generated profile, defines, then python with -s -P', async () => {
    const { fake } = layer()
    const gated = await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary', webDist: '/web' })
    const args = ['-m', 'hermes_cli.main', 'serve']

    expect(gated.command(backend.command)).toBe('/usr/bin/sandbox-exec')

    const argv = gated.argv(args, backend.command)

    expect(argv.slice(0, 2)).toEqual(['-p', TEXT])
    expect(argv.slice(2, 6)).toEqual(['-D', 'RUNTIME_ROOT=/managed', '-D', 'PROJECT=/work'])
    // The interpreter and its isolation flags come right after the defines, unchanged.
    expect(argv.slice(6, 9)).toEqual([backend.command, '-s', '-P'])
    expect(argv.slice(6)).toEqual([backend.command, ...gated.argv(args)])
    expect(argv.slice(-3)).toEqual(args)
    // The fd-3 key pipe and the rest of stdio are what they always were.
    expect(gated.stdio).toBe(GATED_STDIO)
    expect(fake.runtimeSpawn).toHaveBeenLastCalledWith(
      backend.command,
      expect.arrayContaining(['-s', '-P', ...args]),
      expect.objectContaining({
        runtimeRoot: '/managed',
        venvRoot: '/rt/venv',
        pythonHome: '/rt/base',
        python: backend.command,
        tmpDir: '/ud/confinement/run/tmp',
        cacheDir: null,
        project: '/work',
        webDist: '/web',
        permDir: '/ud/run',
        paySocket: '/ud/run/pay.sock'
      })
    )
  })

  it('the runtime-only temp folder is the confined Hermes TMPDIR; a pool backend names no pay socket', async () => {
    const { fake } = layer()
    const gated = await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })

    expect(gated.seal({ TMPDIR: '/var/folders/x/T/' }).TMPDIR).toBe('/ud/confinement/run/tmp/')

    await prepareHermesSpawn({ backend, cwd: '/work', profile: 'work', role: 'pool' })
    expect(fake.runtimeSpawn).toHaveBeenLastCalledWith(
      backend.command,
      [],
      expect.objectContaining({ paySocket: null, tmpDir: '/ud/confinement/run/tmp' })
    )
  })

  it('a cwd that fell back to the home is no project', async () => {
    const { fake } = layer()

    await prepareHermesSpawn({ backend, cwd: os.homedir(), profile: null, role: 'primary' })
    expect(fake.runtimeSpawn).toHaveBeenLastCalledWith(backend.command, [], expect.objectContaining({ project: null }))
  })

  it('confinement off: TMPDIR is whatever the call site composed', async () => {
    layer()
    h.confinementEnv = {}

    const gated = await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })

    expect(gated.seal({ TMPDIR: '/var/folders/x/T/' }).TMPDIR).toBe('/var/folders/x/T/')
  })

  it('the interpreter is asked for its prefixes isolated (-I -S), with a fixed PATH and nothing inherited', async () => {
    layer()
    await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })

    const python = h.execFile.mock.calls.find(call => call[0] === backend.command)

    expect(python?.[1].slice(0, 3)).toEqual(['-I', '-S', '-c'])
    expect(python?.[2]).toMatchObject({ env: { LANG: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } })
  })

  it('a quit that began during the gate refuses before the launcher: no lease and no launcher the registry would miss', async () => {
    const { fake } = layer()
    const { QuitInProgressError, quitState } = await import('./state')

    quitState.quitting = true

    try {
      await expect(prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })).rejects.toBeInstanceOf(
        QuitInProgressError
      )
      expect(fake.leaseLauncher).not.toHaveBeenCalled()
      expect(fake.ensureLauncher).not.toHaveBeenCalled()
    } finally {
      quitState.quitting = false
    }
  })

  it('the launcher is ensured before prepareHermesSpawn returns, for the runtime the gate verified', async () => {
    const { fake } = layer()

    await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })
    order.push('returned')

    expect(fake.ensureLauncher).toHaveBeenCalledWith('/managed', expect.objectContaining({ tmpDir: expect.any(String) }))
    // The profile's facts first (a profile that cannot be built starts nothing), then the launcher, then the spawn.
    expect(order.slice(-2)).toEqual(['launcher', 'returned'])
    // Only the interpreter is asked: the temp folder is the layer's own and the per-user cache is not a fact.
    expect(order.slice(0, 1)).toEqual(['probe python'])
    expect(order.filter(step => step.startsWith('probe'))).toEqual(['probe python'])
  })

  it('the Hermes env carries the launcher socket and the confined flag through the seal; foreign values do not win', async () => {
    layer()

    const gated = await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })

    const env = gated.seal({
      ICLONE_CONFINEMENT_LAUNCHER: '/tmp/evil.sock',
      ICLONE_RUNTIME_CONFINED: '0',
      ICLONE_FOREIGN: 'x'
    })

    expect(env.ICLONE_CONFINEMENT_LAUNCHER).toBe('/ud/confinement/run/launcher.sock')
    expect(env.ICLONE_RUNTIME_CONFINED).toBe('1')
    expect(env).not.toHaveProperty('ICLONE_FOREIGN')
  })

  it('launcher down ⇒ Hermes is still prepared under the runtime profile (its commands refuse), and it is logged', async () => {
    layer('down')

    const gated = await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })

    expect(gated.command(backend.command)).toBe('/usr/bin/sandbox-exec')
    expect(gated.argv(['serve'], backend.command)[0]).toBe('-p')
    expect(vi.mocked(rememberLog).mock.calls.flat().join('\n')).toMatch(/launcher is not answering/)
  })

  it('a profile that cannot be built refuses the spawn ([iclone-gate]); the launcher is not started', async () => {
    const { fake } = layer()

    h.execFile.mockImplementation((_c: string, _a: string[], _o: unknown, done: (e: Error) => void) =>
      done(new Error('python is missing'))
    )

    await expect(prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })).rejects.toThrow(
      /\[iclone-gate\].*confinement profile could not be built/
    )
    expect(fake.ensureLauncher).not.toHaveBeenCalled()
  })

  it('an interpreter the runtime could have chosen is refused before any probe runs it: no gate, no prefix probe, no launcher', async () => {
    const { fake } = layer()

    fake.interpreterRefusal.mockReturnValue(`${backend.command} lies in /Users/owner/.hermes, which the agent runtime can write`)

    await expect(prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })).rejects.toThrow(
      /\[iclone-gate\].*interpreter is not trusted to run outside the sandbox \(.*which the agent runtime can write\), so the agent was not started/
    )
    expect(fake.interpreterRefusal).toHaveBeenCalledWith(backend.command)
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.execFile.mock.calls.find(call => call[0] === backend.command)).toBeUndefined()
    expect(fake.ensureLauncher).not.toHaveBeenCalled()
    expect(fake.runtimeSpawn).not.toHaveBeenCalled()
  })

  it('an unmanaged dev runtime’s plugin overlay is a fact of the profile: the gate’s HERMES_BUNDLED_PLUGINS reaches the spawn as pluginsDir', async () => {
    const { fake } = layer()

    h.ensure.mockResolvedValue({
      loaded: ['iclone-permissions'],
      env: { HERMES_BUNDLED_PLUGINS: '/ud/hermes-dev-plugins/plugins' },
      runtimeRoot: '/checkout'
    })
    await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })
    expect(fake.runtimeSpawn).toHaveBeenLastCalledWith(
      backend.command,
      [],
      expect.objectContaining({ pluginsDir: '/ud/hermes-dev-plugins/plugins', runtimeRoot: '/checkout' })
    )

    h.ensure.mockResolvedValue({ loaded: ['iclone-permissions'], env: {}, runtimeRoot: '/managed' })
    await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })
    expect(fake.runtimeSpawn).toHaveBeenLastCalledWith(backend.command, [], expect.objectContaining({ pluginsDir: null }))
  })

  it('confinement says on but the layer is missing or off ⇒ refused, never an unconfined Hermes', async () => {
    await expect(prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })).rejects.toThrow(
      /\[iclone-gate\]/
    )

    const { fake } = layer()

    fake.runtimeConfined.mockReturnValue(false)
    await expect(prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })).rejects.toThrow(
      /\[iclone-gate\]/
    )
  })

  it('the primary and each pool backend claim the launcher and release it when they exit', async () => {
    const { fake, release } = layer()
    const primary = await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })
    const child = new EventEmitter() as EventEmitter & { pid: number; stdio: unknown[] }

    child.pid = 77
    child.stdio = []
    primary.attach(child as never)
    expect(release).not.toHaveBeenCalled()
    child.emit('exit', 0, null)
    expect(release).toHaveBeenCalledTimes(1)

    fake.leaseLauncher.mockClear()

    const pool = await prepareHermesSpawn({ backend, cwd: '/work', profile: 'work', role: 'pool' })
    const poolChild = new EventEmitter() as EventEmitter & { pid: number; stdio: unknown[] }

    poolChild.pid = 78
    poolChild.stdio = []
    pool.attach(poolChild as never)
    expect(fake.leaseLauncher).toHaveBeenCalledTimes(1)
    expect(fake.ensureLauncher).toHaveBeenCalledTimes(2)
    poolChild.emit('exit', 0, null)
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('the launcher stops on every way out (one registry entry, however many spawns)', async () => {
    const { fake } = layer()

    await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })
    await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })

    expect(appTeardown.names().filter(name => name === 'confinement launcher')).toHaveLength(1)
    expect(appTeardown.run()).toContain('confinement launcher')
    expect(fake.stopLauncher).toHaveBeenCalledTimes(1)
  })

  it('confinement off ⇒ byte-identical to before: command, argv and env untouched, no launcher, no probe', async () => {
    const { fake } = layer()

    h.confinementEnv = {}

    const gated = await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })
    const args = ['-m', 'hermes_cli.main', 'serve']

    expect(gated.command(backend.command)).toBe(backend.command)
    expect(gated.argv(args, backend.command)).toEqual(gated.argv(args))
    expect(gated.argv(args, backend.command)[0]).toBe('-s')
    expect(gated.seal({})).not.toHaveProperty('ICLONE_RUNTIME_CONFINED')
    expect(gated.seal({})).not.toHaveProperty('ICLONE_CONFINEMENT_LAUNCHER')
    expect(fake.ensureLauncher).not.toHaveBeenCalled()
    expect(fake.runtimeSpawn).not.toHaveBeenCalled()
    expect(h.execFile).not.toHaveBeenCalled()
  })

  it('confinement on without the runtime flag (another platform) ⇒ no wrap either', async () => {
    const { fake } = layer()

    h.confinementEnv = { ICLONE_CONFINEMENT: '1', TERMINAL_ENV: 'iclone_seatbelt' }

    const gated = await prepareHermesSpawn({ backend, cwd: '/work', profile: null, role: 'primary' })

    expect(gated.command(backend.command)).toBe(backend.command)
    expect(fake.ensureLauncher).not.toHaveBeenCalled()
  })
})
