/**
 * The runtime part of the confinement layer: the env a confined Hermes gets, its launch under the runtime profile,
 * the launcher it owns (an injected fake here) and what it reports for the state.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Launcher, LauncherOptions, LauncherState } from './launcher'
import { realOrSelf } from './profiles'
import { generateRuntimeProfile, runtimeRoots } from './runtime-profile'

import { createConfinement, currentConfinement, launcherScript, type RuntimeSpawnFacts } from './index'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function world(
  platform: NodeJS.Platform = 'darwin',
  hermesHome?: (root: string) => string,
  memberPython?: (root: string) => string
) {
  const root = realOrSelf(mkdtempSync(path.join(os.tmpdir(), 'v006-runtime-')))
  const python = memberPython?.(root) ?? path.join(root, 'venv', 'bin', 'python')

  dirs.push(root)
  mkdirSync(path.dirname(python), { recursive: true })

  if (!memberPython) {
    writeFileSync(python, '')
  }

  const made: LauncherOptions[] = []
  const logs: string[] = []

  const launchers: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; state: () => LauncherState }[] =
    []

  const layer = createConfinement({
    userDataDir: path.join(root, 'userData'),
    home: path.join(root, 'home'),
    hermesHome: hermesHome ? hermesHome(root) : path.join(root, 'home', '.hermes'),
    hermesRoot: null,
    hermesPids: () => [],
    audit: () => [],
    ps: async () => [],
    platform,
    memberPython: python,
    log: line => logs.push(line),
    probes: {
      seatbelt: async () => ({
        id: 'seatbelt' as const,
        status: 'ready' as const,
        enforcing: true,
        version: null,
        detail: 'enforcing' as const,
        evidence: '',
        ownerStep: null
      })
    },
    createLauncher: (options): Launcher => {
      let state: LauncherState = 'down'

      const fake = {
        start: vi.fn(async (): Promise<LauncherState> => (state = 'up')),
        stop: vi.fn(async () => {
          state = 'down'
        }),
        state: () => state
      }

      made.push(options)
      launchers.push(fake)

      return fake
    }
  })

  return { layer, made, launchers, logs, python, root }
}

const FACTS: RuntimeSpawnFacts = {
  runtimeRoot: '/rt',
  venvRoot: '/rt/venv',
  python: '/base/bin/python3.11',
  pythonHome: '/base',
  project: '/work',
  webDist: '/web',
  tmpDir: '/rtmp',
  cacheDir: null
}

describe('spawnEnv — the runtime pair', () => {
  it('on + darwin: the launcher socket under userData and the confined flag', () => {
    const { layer, root } = world()
    const env = layer.spawnEnv()

    expect(env.ICLONE_CONFINEMENT_LAUNCHER).toBe(path.join(root, 'userData', 'confinement', 'run', 'launcher.sock'))
    expect(env.ICLONE_RUNTIME_CONFINED).toBe('1')
    expect(layer.runtimeConfined()).toBe(true)
  })

  it('off, or another platform: nothing, and the runtime is off', () => {
    const linux = world('linux').layer

    expect(linux.spawnEnv()).toEqual({})
    expect(linux.runtimeConfined()).toBe(false)
    expect(linux.launcherState()).toBe('off')
    expect(linux.runtimeView()).toBeNull()
    expect(linux.seatbeltOff()).toBe(false)

    const off = world().layer

    expect(off.seatbeltOff()).toBe(false)
    off.setEnabled(false)
    expect(off.spawnEnv()).toEqual({ ICLONE_CONFINEMENT: 'off' })
    expect(off.seatbeltOff()).toBe(true)
    expect(off.runtimeConfined()).toBe(false)
    expect(off.launcherState()).toBe('off')
  })
})

describe('runtimeSpawn', () => {
  it('sandbox-exec -p <generated profile> -D… then the command and its args; the view reports that profile', () => {
    const { layer, root, python } = world()
    const userData = path.join(root, 'userData')

    expect(layer.runtimeView()).toBeNull()

    const facts: RuntimeSpawnFacts = {
      ...FACTS,
      python,
      permDir: path.join(userData, 'run'),
      permSocket: path.join(userData, 'run', 'acp.sock'),
      paySocket: path.join(userData, 'run', 'pay.sock'),
      policyFile: path.join(userData, 'run', 'policy-1.json')
    }

    const launch = layer.runtimeSpawn(python, ['-s', '-P', '-m', 'hermes_cli.main', 'serve'], facts)
    // A plain file as the interpreter: no link on its way, so the profile carries no link literal.
    const expected = generateRuntimeProfile(layer.paths)

    expect(launch.command).toBe('/usr/bin/sandbox-exec')
    expect(launch.args.slice(0, 2)).toEqual(['-p', expected.text])
    expect(launch.profile.sha256).toBe(expected.sha256)
    expect(launch.args.slice(-6)).toEqual([python, '-s', '-P', '-m', 'hermes_cli.main', 'serve'])

    const defines = launch.args.slice(2, -6)
    const confinement = path.join(userData, 'confinement')

    for (const define of [
      `HERMES_HOME=${path.join(root, 'home', '.hermes')}`,
      `HOME_DIR=${path.join(root, 'home')}`,
      'RUNTIME_ROOT=/rt',
      'VENV_ROOT=/rt/venv',
      'PYTHON_HOME=/base',
      `PYTHON_EXE=${python}`,
      `RUN_DIR=${path.join(confinement, 'run')}`,
      `READY_DIR=${path.join(userData, 'backend-ready')}`,
      `LAUNCHER_SOCKET=${path.join(confinement, 'run', 'launcher.sock')}`,
      `PROFILES_DIR=${path.join(confinement, 'profiles')}`,
      `MEMBERS_DIR=${realOrSelf(layer.paths.membersDir)}`,
      `SCRATCH_ROOT=${realOrSelf(layer.paths.scratchRoot)}`,
      'TMP=/rtmp',
      'PROJECT=/work',
      'WEB_DIST=/web',
      `PERM_DIR=${path.join(userData, 'run')}`,
      `PERM_SOCKET=${path.join(userData, 'run', 'acp.sock')}`,
      `PAY_SOCKET=${path.join(userData, 'run', 'pay.sock')}`,
      `POLICY_FILE=${path.join(userData, 'run', 'policy-1.json')}`,
      `REFUSALS_DIR=${path.join(confinement, 'refusals')}`,
      `HARDLINK_ACKS=${path.join(confinement, 'hardlink-acks.json')}`
    ]) {
      expect(defines).toContain(define)
    }

    expect(defines.some(define => define.startsWith('CACHE='))).toBe(false)
    expect(layer.runtimeView()).toEqual({ profileSha: expected.sha256, ...expected.view })
  })

  it('a cwd that is the home is no project: PROJECT is left out and the spawn still goes', () => {
    const { layer, root, python } = world()
    const launch = layer.runtimeSpawn(python, [], { ...FACTS, python, project: path.join(root, 'home') })

    expect(launch.args.some(arg => arg.startsWith('PROJECT='))).toBe(false)
  })

  it('a parameter the runtime needs with no safe value refuses the spawn, naming it; nothing is recorded', () => {
    const { layer, root, python } = world()

    // The temp folder at the home itself would open the whole home for writing: dropped, so the spawn is refused.
    expect(() => layer.runtimeSpawn(python, [], { ...FACTS, python, tmpDir: path.join(root, 'home') })).toThrow(
      /no safe value for TMP/
    )
    // A permission socket outside userData is not main's: refused rather than dropped silently.
    expect(() => layer.runtimeSpawn(python, [], { ...FACTS, python, permSocket: '/elsewhere/acp.sock' })).toThrow(
      /no safe value for PERM_SOCKET/
    )
    expect(layer.runtimeView()).toBeNull()
  })

  it('an interpreter reached through links: each link is a metadata literal of the profile, nothing wider', () => {
    const { layer, root, python } = world()
    const facts: RuntimeSpawnFacts = { ...FACTS, python }

    // uv's layout: `<store>/<minor alias>` links the versioned install; a venv's `bin/python` points through it; a
    // checkout keeps its venv behind one more folder link.
    const real = path.join(root, 'store', 'cpython-3.14.7', 'bin')
    const alias = path.join(root, 'store', 'cpython-3.14')
    const venv = path.join(root, 'linked-venv')
    const front = path.join(root, 'checkout', 'venv')

    mkdirSync(real, { recursive: true })
    mkdirSync(path.join(venv, 'bin'), { recursive: true })
    mkdirSync(path.dirname(front), { recursive: true })
    writeFileSync(path.join(real, 'python3.14'), '')
    symlinkSync(path.join(root, 'store', 'cpython-3.14.7'), alias)
    symlinkSync(path.join(alias, 'bin', 'python3.14'), path.join(venv, 'bin', 'python'))
    symlinkSync(venv, front)

    const command = path.join(front, 'bin', 'python')
    const launch = layer.runtimeSpawn(command, [], { ...facts, python: path.join(real, 'python3.14') })
    const line = `(allow file-read-metadata (literal "${front}") (literal "${path.join(venv, 'bin', 'python')}") (literal "${alias}"))`

    expect(launch.args[1]).toContain(`\n${line}\n`)
    expect(launch.args[1]).not.toContain(`(subpath "${path.join(root, 'store')}")`)
    expect(launch.args[1]).not.toContain(`(literal "${path.join(root, 'store')}")`)
    expect(launch.profile.sha256).not.toBe(generateRuntimeProfile(layer.paths).sha256)

    // Another chain (a plain interpreter) regenerates the text; the same chain reuses it.
    expect(layer.runtimeSpawn(python, [], facts).profile.sha256).toBe(generateRuntimeProfile(layer.paths).sha256)
    expect(layer.runtimeSpawn(command, [], { ...facts, python: path.join(real, 'python3.14') }).profile.text).toBe(
      launch.args[1]
    )
  })

  it('an interpreter the chain cannot explain refuses the spawn by name: missing, looping, or through a denied folder', () => {
    const { layer, root, python } = world()
    const facts: RuntimeSpawnFacts = { ...FACTS, python }
    const missing = path.join(root, 'gone', 'bin', 'python')
    const loop = path.join(root, 'loop')
    const secret = path.join(root, 'home', '.ssh', 'python')

    symlinkSync(loop, loop)
    mkdirSync(path.dirname(secret), { recursive: true })
    symlinkSync(python, secret)

    expect(() => layer.runtimeSpawn(missing, [], facts)).toThrow(`${missing} is not reachable: ${path.join(root, 'gone')} does not exist`)
    expect(() => layer.runtimeSpawn(loop, [], facts)).toThrow(`${loop} is not reachable: the link ${loop} loops`)
    expect(() => layer.runtimeSpawn(secret, [], facts)).toThrow(/a link inside .*\.ssh, which the runtime may never read/)
    expect(layer.runtimeView()).toBeNull()
  })

  it('the runtime temp folder sits beside the scratch root, a 0700 directory of this user, made on demand', () => {
    const { layer, root } = world()
    const dir = layer.runtimeTmpDir()

    expect(dir).toBe(path.join(root, 'home', 'Library', 'Caches', 'iclone-os-confinement', 'tmp'))
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(layer.runtimeTmpDir()).toBe(dir)
  })
})

describe('the launcher', () => {
  it('is started with the runtime python, the runtime plugin script, the socket, the journal dir and the spec', async () => {
    const { layer, made, python, root } = world()

    // Configured and not running: down (commands would be refused). Off is only for confinement off or not macOS; the
    // fold says "not running" for the runtime then, not a second launcher reason.
    expect(layer.launcherState()).toBe('down')
    layer.leaseLauncher()
    expect(layer.launcherState()).toBe('down')
    await expect(layer.ensureLauncher('/rt', FACTS)).resolves.toBe('up')
    expect(layer.launcherState()).toBe('up')
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({
      python,
      script: launcherScript('/rt'),
      socketPath: path.join(root, 'userData', 'confinement', 'run', 'launcher.sock'),
      journalDir: path.join(root, 'userData', 'confinement', 'ledger')
    })
    expect(launcherScript('/rt')).toBe('/rt/plugins/iclone-confinement/launcher.py')
    expect((made[0].spec as () => string)()).toBe(layer.spawnEnv().ICLONE_CONFINEMENT_SPEC)
  })

  it('is told the runtime profile’s own roots, from the same values the profile is given', async () => {
    const { layer, made, root } = world()

    await layer.ensureLauncher('/rt', FACTS)

    const roots = (made[0].roots as () => { reads: string[]; writes: string[] })()

    expect(roots).toEqual(runtimeRoots(layer.paths, FACTS))
    expect(roots.reads).toEqual(
      expect.arrayContaining(['/rt', '/rt/venv', '/base', '/web', '/work', layer.paths.profilesDir])
    )
    expect(roots.writes).toEqual([
      realOrSelf(path.join(root, 'home', '.hermes')),
      realOrSelf(layer.paths.scratchRoot),
      '/rtmp'
    ])

    for (const item of [...roots.reads, ...roots.writes]) {
      expect(item === layer.paths.profilesDir || !item.startsWith(path.join(root, 'userData')), item).toBe(true)
    }
  })

  it('regenerate restarts a launcher that is up, so it validates against the profiles main holds now', async () => {
    const { layer, launchers } = world()

    await layer.regenerate()
    expect(launchers).toHaveLength(0)

    await layer.ensureLauncher('/rt', FACTS)
    expect(launchers[0].start).toHaveBeenCalledTimes(1)

    await layer.regenerate()
    expect(launchers[0].stop).toHaveBeenCalledTimes(1)
    expect(launchers[0].start).toHaveBeenCalledTimes(2)
    expect(layer.launcherState()).toBe('up')

    await layer.stopLauncher()
    await layer.regenerate()
    expect(launchers[0].start).toHaveBeenCalledTimes(2)
  })

  it('one launcher per runtime: the same runtime reuses it, another stops it first', async () => {
    const { layer, made, launchers } = world()

    await layer.ensureLauncher('/rt', FACTS)
    await layer.ensureLauncher('/rt', FACTS)
    expect(made).toHaveLength(1)
    expect(launchers[0].start).toHaveBeenCalledTimes(2)

    await layer.ensureLauncher('/other', FACTS)
    expect(launchers[0].stop).toHaveBeenCalledTimes(1)
    expect(made).toHaveLength(2)
  })

  it('the last live claim stops it: a replaced Hermes releasing late leaves the new one its launcher', async () => {
    const { layer, launchers } = world()
    const first = layer.leaseLauncher()

    await layer.ensureLauncher('/rt', FACTS)

    const second = layer.leaseLauncher()

    await layer.ensureLauncher('/rt', FACTS)
    await first()
    expect(launchers[0].stop).not.toHaveBeenCalled()
    expect(layer.launcherState()).toBe('up')
    await second()
    await second()
    expect(launchers[0].stop).toHaveBeenCalledTimes(1)
    expect(layer.launcherState()).toBe('down')
  })

  it('a pool backend holds it too: the window backend exiting first leaves the pool its launcher', async () => {
    const { layer, launchers } = world()
    const primary = layer.leaseLauncher()
    const pool = layer.leaseLauncher()

    await layer.ensureLauncher('/rt', FACTS)
    await primary()
    expect(launchers[0].stop).not.toHaveBeenCalled()
    expect(layer.launcherState()).toBe('up')
    await pool()
    expect(launchers[0].stop).toHaveBeenCalledTimes(1)
  })

  it('no runtime python yet ⇒ down, nothing made', async () => {
    const { layer, made, python } = world()

    rmSync(python)
    await expect(layer.ensureLauncher('/rt', FACTS)).resolves.toBe('down')
    expect(made).toHaveLength(0)
  })

  it('stopLauncher stops it; the layer registered last is the one the spawn path finds', async () => {
    const { layer, launchers } = world()

    expect(currentConfinement()).toBe(layer)
    await layer.ensureLauncher('/rt', FACTS)
    const release = layer.leaseLauncher()

    await layer.stopLauncher()
    expect(launchers[0].stop).toHaveBeenCalledTimes(1)
    // A confined Hermes still holds a claim: its launcher is down, said red.
    expect(layer.launcherState()).toBe('down')
    await release()
    expect(layer.launcherState()).toBe('down')
    expect(layer.runtimeView()).toBeNull()
  })

  it('without the active venv’s Python, the launcher runs with the interpreter the confined spawn named', async () => {
    const { layer, made, python, root } = world()
    const spawned = path.join(root, 'elsewhere', 'bin', 'python')

    mkdirSync(path.dirname(spawned), { recursive: true })
    writeFileSync(spawned, '')
    rmSync(python)
    await expect(layer.ensureLauncher('/rt', FACTS)).resolves.toBe('down')
    expect(made).toHaveLength(0)

    layer.runtimeSpawn(spawned, [], { ...FACTS, python: spawned })
    await expect(layer.ensureLauncher('/rt', FACTS)).resolves.toBe('up')
    expect(made[0].python).toBe(spawned)
  })
})

describe('the helper interpreter is never one the runtime could rewrite', () => {
  const planted = (root: string) => path.join(root, 'home', '.hermes', 'cache', 'v', 'bin', 'python')

  it('an active venv Python inside HERMES_HOME (outside PM’s records) is refused: the launcher stays down and the log names the folder', async () => {
    const { layer, made, logs, python, root } = world('darwin', undefined, planted)

    writeFileSync(python, '#!/bin/sh\n')
    await expect(layer.ensureLauncher('/rt', FACTS)).resolves.toBe('down')
    expect(made).toHaveLength(0)

    const hermesHome = realOrSelf(path.join(root, 'home', '.hermes'))

    expect(logs.at(-1)).toBe(`[confinement] launcher not started: ${python} lies in ${hermesHome}, which the agent runtime can write`)
    expect(layer.helperInterpreter()).toEqual({ python: null, refusals: [`${python} lies in ${hermesHome}, which the agent runtime can write`] })
    expect(layer.interpreterRefusal(python)).toBe(`${python} lies in ${hermesHome}, which the agent runtime can write`)
  })

  it('PM’s venv under HERMES_HOME/installs is trusted (that folder is never written): the launcher starts with it', async () => {
    const venvPython = (root: string) =>
      path.join(root, 'home', '.hermes', 'installs', '0123456789abcdef', 'environments', 'gen1', 'venv', 'bin', 'python')

    const { layer, made, root } = world('darwin', undefined, venvPython)
    const binary = path.join(root, 'home', '.hermes', 'tools', 'python-3.14', 'bin', 'python3.14')

    mkdirSync(path.dirname(binary), { recursive: true })
    writeFileSync(binary, '')
    symlinkSync(binary, venvPython(root))

    await expect(layer.ensureLauncher('/rt', FACTS)).resolves.toBe('up')
    expect(made[0].python).toBe(venvPython(root))
    expect(layer.interpreterRefusal(venvPython(root))).toBeNull()
  })

  it('a refused active venv never falls back on a refused spawn interpreter; a trusted spawn interpreter is used', async () => {
    const { layer, made, python, root } = world('darwin', undefined, planted)
    const trusted = path.join(root, 'elsewhere', 'bin', 'python')

    writeFileSync(python, '')
    mkdirSync(path.dirname(trusted), { recursive: true })
    writeFileSync(trusted, '')

    expect(() => layer.runtimeSpawn(python, [], { ...FACTS, python })).toThrow(/is not trusted: .*which the agent runtime can write/)
    await expect(layer.ensureLauncher('/rt', FACTS)).resolves.toBe('down')

    layer.runtimeSpawn(trusted, [], { ...FACTS, python: trusted })
    await expect(layer.ensureLauncher('/rt', FACTS)).resolves.toBe('up')
    expect(made[0].python).toBe(trusted)
  })
})

describe('HERMES_HOME inside userData', () => {
  it('a HERMES_HOME of its own inside userData is opened for this spawn: passed, and a launcher write root', () => {
    const { layer, python, root } = world('darwin', at => path.join(at, 'userData', 'hermes-home'))
    const launch = layer.runtimeSpawn(python, [], { ...FACTS, python })

    expect(launch.args).toContain(`HERMES_HOME=${realOrSelf(path.join(root, 'userData', 'hermes-home'))}`)
    expect(runtimeRoots(layer.paths, FACTS).writes).toContain(realOrSelf(path.join(root, 'userData', 'hermes-home')))
  })

  it('one that is or holds userData, or lies in its confinement folder, refuses the spawn with a plain reason', () => {
    for (const [where, hermesHome] of [
      ['userData itself', (at: string) => path.join(at, 'userData')],
      ['its parent', (at: string) => at],
      ['the ledger', (at: string) => path.join(at, 'userData', 'confinement', 'ledger')],
      ['the run dir', (at: string) => path.join(at, 'userData', 'confinement', 'run')]
    ] as const) {
      const { layer, python } = world('darwin', hermesHome)

      expect(() => layer.runtimeSpawn(python, [], { ...FACTS, python }), where).toThrow(
        /^HERMES_HOME \(.+\) (is or holds the app's own data folder \(.+\); it must be a folder of its own|overlaps the app's own .+, which the agent runtime may never reach)$/
      )
      expect(layer.runtimeView(), where).toBeNull()
    }
  })
})
