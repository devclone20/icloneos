import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BackendStatusView } from '../../src/iclone-shared/confinement'

import { containerRefusal } from './backend-container'
import { hardlinkFiles, type SealedKeyStore } from './hardlinks'
import { CONFINEMENT_CHANNELS, confinementSpawnEnv, registerConfinement, stopConfinement } from './ipc'

import { createConfinement, DEFAULT_SETTINGS, HERMES_BACKEND_NAME, readAckPids, readSettings } from './index'

const dirs: string[] = []

function world() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'v3g-index-'))

  dirs.push(root)

  return {
    userDataDir: path.join(root, 'userData'),
    home: path.join(root, 'home'),
    hermesHome: path.join(root, 'home', '.hermes'),
    hermesRoot: null,
    hermesPids: () => [],
    audit: () => [],
    ps: async () => [],
    probes: {
      seatbelt: async () => ({
        id: 'seatbelt' as const,
        status: 'ready' as const,
        enforcing: true,
        version: null,
        detail: 'enforcing' as const,
        evidence: '',
        ownerStep: null
      }),
      container: async () => ({
        id: 'container' as const,
        status: 'not-installed' as const,
        enforcing: false,
        version: null,
        detail: 'not-installed' as const,
        evidence: '',
        ownerStep: 'install it'
      })
    }
  }
}

/** A stand-in for Electron's safeStorage (one secret): what main passes when the keychain policy is on. */
const keyStore: SealedKeyStore = {
  seal: key => `kc:${key.toString('base64')}`,
  open: sealed => {
    if (!sealed.startsWith('kc:')) {
      throw new Error('not this keychain')
    }

    return Buffer.from(sealed.slice(3), 'base64')
  }
}

const settingsFile = (deps: { userDataDir: string }) => path.join(deps.userDataDir, 'confinement', 'settings.json')

const refusalRows = (deps: { userDataDir: string }) =>
  readdirSync(path.join(deps.userDataDir, 'confinement', 'refusals'))
    .flatMap(name => readFileSync(path.join(deps.userDataDir, 'confinement', 'refusals', name), 'utf8').split('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line) as { operation: string; target: string })

afterEach(() => {
  stopConfinement()

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('settings (T7: trusted only under main’s own signature)', () => {
  it('defaults to Seatbelt, on, project; a corrupt or unsigned file never turns confinement off', () => {
    const deps = world()
    const dir = path.join(deps.userDataDir, 'confinement')
    const key = Buffer.alloc(32, 7)

    expect(readSettings(dir, key)).toEqual({ settings: DEFAULT_SETTINGS, ignored: null })
    createConfinement(deps)
    writeFileSync(settingsFile(deps), '{"enabled": "no", "backend": "docker"')
    expect(readSettings(dir, key)).toEqual({ settings: DEFAULT_SETTINGS, ignored: 'malformed' })
    writeFileSync(settingsFile(deps), '{"enabled": false, "backend": "docker", "defaultClass": "x"}')
    expect(readSettings(dir, key)).toEqual({ settings: DEFAULT_SETTINGS, ignored: 'unsigned' })
  })

  it('a forged {"enabled":false} written while main is down is ignored at the next start: enforced, said, audited once', async () => {
    const deps = { ...world(), keyStore }

    mkdirSync(path.dirname(settingsFile(deps)), { recursive: true })
    writeFileSync(settingsFile(deps), JSON.stringify({ ...DEFAULT_SETTINGS, enabled: false }))

    const layer = createConfinement(deps)

    expect(layer.spawnEnv().TERMINAL_ENV).toBe(HERMES_BACKEND_NAME.seatbelt)

    const state = await layer.state()

    expect(state.verdict).toBe('green')
    expect(state.enabled).toBe(true)
    expect(state.reasons).toContainEqual({ code: 'settings-ignored' })
    await layer.state()
    expect(
      refusalRows(deps)
        .filter(row => row.operation === 'hardlink-settings-rejected')
        .map(row => row.target)
    ).toEqual([`${settingsFile(deps)} (unsigned)`])
  })

  it('a forged signature is a forgery too; main’s own off, signed, holds across a restart with safeStorage', async () => {
    const deps = { ...world(), keyStore }
    const first = createConfinement(deps)

    first.setEnabled(false)
    expect(first.settingsPersist()).toBe(true)
    expect((await first.state()).verdict).toBe('off')

    const second = createConfinement(deps)

    expect((await second.state()).verdict).toBe('off')
    expect(second.spawnEnv()).toEqual({})

    const signed = JSON.parse(readFileSync(settingsFile(deps), 'utf8')) as { body: string; sig: string }

    writeFileSync(
      settingsFile(deps),
      JSON.stringify({ ...signed, sig: signed.sig.replace(/^./, c => (c === '0' ? '1' : '0')) })
    )

    const third = createConfinement(deps)
    const state = await third.state()

    expect(state.verdict).toBe('green')
    expect(state.reasons).toContainEqual({ code: 'settings-ignored' })
    expect(refusalRows(deps).map(row => row.target)).toContain(`${settingsFile(deps)} (signature)`)
  })

  it('without safeStorage an off is session-only: the next start is on again, with no forgery to audit', async () => {
    const deps = world()
    const first = createConfinement(deps)

    first.setEnabled(false)
    expect(first.settingsPersist()).toBe(false)
    expect((await first.state()).verdict).toBe('off')

    const second = createConfinement(deps)
    const state = await second.state()

    expect(state.verdict).toBe('green')
    expect(state.reasons).not.toContainEqual({ code: 'settings-ignored' })
    expect(refusalRows(deps)).toEqual([])
  })

  it('a file forged while main runs is ignored from the next read', async () => {
    const deps = world()
    const layer = createConfinement(deps)

    writeFileSync(settingsFile(deps), JSON.stringify({ ...DEFAULT_SETTINGS, enabled: false }))
    expect(layer.spawnEnv().TERMINAL_ENV).toBe(HERMES_BACKEND_NAME.seatbelt)
    expect((await layer.state()).reasons).toContainEqual({ code: 'settings-ignored' })
  })
})

describe('G6 — one seam: flipping the backend is one setting', () => {
  it('only settings.json changes, and the state and spawn env follow it', async () => {
    const deps = world()
    const layer = createConfinement(deps)

    const files = () =>
      execFileSync('/usr/bin/find', [deps.userDataDir, '-type', 'f'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .sort()

    const snapshot = () => Object.fromEntries(files().map(file => [file, readFileSync(file, 'utf8')]))
    const before = snapshot()

    expect((await layer.state()).verdict).toBe('green')
    expect(layer.spawnEnv().TERMINAL_ENV).toBe(HERMES_BACKEND_NAME.seatbelt)

    layer.setBackend('container')

    const after = snapshot()
    const changed = Object.keys(after).filter(file => after[file] !== before[file])

    expect(changed.map(file => path.relative(deps.userDataDir, file))).toEqual([
      path.join('confinement', 'settings.json')
    ])
    expect(layer.active().id).toBe('container')
    expect(layer.spawnEnv().TERMINAL_ENV).toBe(HERMES_BACKEND_NAME.container)

    const state = await layer.state()

    expect(state.verdict).toBe('red')
    expect(state.reasons[0]).toEqual({ code: 'backend-not-confining', backend: 'container', detail: 'not-installed' })
  })

  it('confinement off ⇒ no spawn env and an OFF verdict', async () => {
    const deps = world()
    const layer = createConfinement(deps)

    layer.setEnabled(false)
    expect(layer.spawnEnv()).toEqual({})
    expect((await layer.state()).verdict).toBe('off')
  })

  it('off macOS the shell is left as it was (Linux and Windows are not in this release)', () => {
    expect(createConfinement({ ...world(), platform: 'linux' }).spawnEnv()).toEqual({})
  })

  it('the spawn env routes Hermes through the layer, with the default class', () => {
    const layer = createConfinement({ ...world(), platform: 'darwin' })

    const env = layer.spawnEnv()

    expect(env).toEqual({
      ICLONE_CONFINEMENT: '1',
      ICLONE_CONFINEMENT_DIR: layer.paths.profilesDir,
      ICLONE_CONFINEMENT_CLASS: 'project',
      ICLONE_CONFINEMENT_SPEC: expect.any(String),
      ICLONE_CONFINEMENT_ACK: path.join(path.dirname(layer.paths.profilesDir), 'run', 'hermes-ack.json'),
      ICLONE_CONFINEMENT_LINK_KEY: expect.stringMatching(/^[0-9a-f]{64}$/),
      TERMINAL_ENV: 'iclone_seatbelt'
    })
  })

  it('F2 — the plugin gets every profile hash from main at spawn, and nothing it trusts sits next to the profiles', () => {
    const layer = createConfinement({ ...world(), platform: 'darwin' })
    const spec = JSON.parse(layer.spawnEnv().ICLONE_CONFINEMENT_SPEC) as { sha256: Record<string, string> }

    for (const profile of layer.profiles()) {
      expect(spec.sha256[profile.spec.cls]).toBe(createHash('sha256').update(readFileSync(profile.file)).digest('hex'))
      expect(statSync(profile.file).mode & 0o777).toBe(0o600)
    }

    expect(Object.keys(spec.sha256).sort()).toEqual(['build', 'media', 'offline', 'project', 'research'])
    expect(readdirSync(layer.paths.profilesDir).sort()).toEqual([
      'build.sb',
      'media.sb',
      'offline.sb',
      'project.sb',
      'research.sb'
    ])
    expect(layer.paths.scratchRoot.startsWith(layer.paths.profilesDir)).toBe(false)
  })

  it('r5 MINOR-2 — the store roots main hands the plugin (spec v5) never name a denied folder, the Hermes home or userData; a $PNPM_HOME that does is dropped', () => {
    const deps = world()

    const roots = (pnpmHome: string | undefined) => {
      const saved = process.env.PNPM_HOME

      if (pnpmHome === undefined) {
        delete process.env.PNPM_HOME
      } else {
        process.env.PNPM_HOME = pnpmHome
      }

      try {
        const layer = createConfinement({ ...deps, platform: 'darwin' })
        const spec = JSON.parse(layer.spawnEnv().ICLONE_CONFINEMENT_SPEC) as { v: number; pnpmStoreRoots: string[] }

        return { v: spec.v, roots: spec.pnpmStoreRoots.map(root => path.relative(deps.home, root)) }
      } finally {
        if (saved === undefined) {
          delete process.env.PNPM_HOME
        } else {
          process.env.PNPM_HOME = saved
        }
      }
    }

    mkdirSync(deps.hermesHome, { recursive: true })

    const defaults = ['Library/pnpm', '.local/share/pnpm']

    expect(roots(undefined)).toEqual({ v: 5, roots: defaults })

    for (const denied of ['.ssh', '.gnupg', 'Library/Keychains', 'Library', '.hermes', '.hermes/store/v3']) {
      const under = path.join(deps.home, denied)

      expect(roots(under), denied).toEqual({ v: 5, roots: defaults })
    }

    expect(roots(deps.userDataDir)).toEqual({ v: 5, roots: defaults })
    expect(roots(path.join(deps.userDataDir, 'confinement'))).toEqual({ v: 5, roots: defaults })
    expect(roots(path.dirname(deps.userDataDir))).toEqual({ v: 5, roots: defaults })
    expect(roots(path.join(deps.home, 'pnpm-elsewhere'))).toEqual({ v: 5, roots: [...defaults, 'pnpm-elsewhere'] })
  })

  it('F5 — the plugin acknowledgement is read by pid; anything malformed acknowledges nothing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'v3g-ack-'))
    const file = path.join(dir, 'hermes-ack.json')

    dirs.push(dir)
    expect(readAckPids(file)).toEqual([])
    writeFileSync(file, JSON.stringify({ pid: 4242, backend: 'iclone_seatbelt' }))
    expect(readAckPids(file)).toEqual([4242])

    for (const bad of ['{', '{"pid": "x"}', '{"pid": 1}', '[]']) {
      writeFileSync(file, bad)
      expect(readAckPids(file)).toEqual([])
    }
  })
})

describe('G3-3 — the pane and the refusal read the same probe, at the same time', () => {
  it('a forced container: across installed → probe throws → timed out, the state row and the spawn refusal agree', async () => {
    const installed = {
      id: 'container' as const,
      status: 'installed' as const,
      enforcing: false,
      version: '1.5.0',
      detail: 'not-wired' as const,
      evidence: '',
      ownerStep: null
    }

    const steps: (() => typeof installed | BackendStatusView)[] = [
      () => installed,
      () => {
        throw new Error('container probe crashed')
      },
      () => ({ ...installed, status: 'unknown', version: null, detail: 'probe-timeout' })
    ]

    let step = 0
    let clock = Date.parse('2026-10-22T03:00:00Z')
    const deps = world()

    const layer = createConfinement({
      ...deps,
      now: () => new Date(clock),
      probes: { ...deps.probes, container: async () => steps[step]() }
    })

    layer.setBackend('container')

    const words: string[] = []

    for (step = 0; step < steps.length; step += 1) {
      const row = (await layer.state()).backends.find(backend => backend.id === 'container')

      const spawned = layer.active().spawn({
        cls: 'project',
        argv: ['ls'],
        cwd: '/',
        projectRoot: null,
        network: false,
        writeProject: false
      })

      expect(row).toBeDefined()
      expect(spawned).toEqual({ ok: false, error: containerRefusal(row ?? null) })
      words.push(`${row?.status}/${row?.detail}`)
      clock += 60_000 // past the probe TTL: the next read re-probes
    }

    expect(words).toEqual(['installed/not-wired', 'broken/probe-failed', 'unknown/probe-timeout'])
  })
})

describe('G3 r2 m-3 — one probe per backend in flight, kept for the TTL', () => {
  const installed: BackendStatusView = {
    id: 'container',
    status: 'installed',
    enforcing: false,
    version: '1.5.0',
    detail: 'not-wired',
    evidence: '',
    ownerStep: null
  }

  it('four overlapping reads start ONE container probe, and all four read its answer', async () => {
    const deps = world()
    const pending: ((view: BackendStatusView) => void)[] = []

    const layer = createConfinement({
      ...deps,
      probes: { ...deps.probes, container: () => new Promise(resolve => pending.push(resolve)) }
    })

    layer.setBackend('container')

    const reads = [layer.state(), layer.state(), layer.state(), layer.state()]

    await vi.waitFor(() => expect(pending.length).toBe(1))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(pending.length).toBe(1)
    pending[0](installed)

    const rows = (await Promise.all(reads)).map(state => state.backends.find(backend => backend.id === 'container'))

    expect(rows).toEqual([installed, installed, installed, installed])
    expect(pending.length).toBe(1)

    // The spawn refusal reads the same answer.
    expect(
      layer.active().spawn({
        cls: 'project',
        argv: ['ls'],
        cwd: '/',
        projectRoot: null,
        network: false,
        writeProject: false
      })
    ).toEqual({ ok: false, error: containerRefusal(installed) })
  })

  it('an answer is kept for exactly the TTL (15 s) from when it landed, then probed again', async () => {
    const deps = world()
    let calls = 0
    let clock = Date.parse('2026-10-22T05:00:00Z')
    const broken: BackendStatusView = { ...installed, status: 'broken', version: null, detail: 'no-version' }
    const row = async () => (await layer.state()).backends.find(backend => backend.id === 'container')

    const layer = createConfinement({
      ...deps,
      now: () => new Date(clock),
      probes: {
        ...deps.probes,
        container: async () => {
          calls += 1

          return calls === 1 ? installed : broken
        }
      }
    })

    expect(await row()).toEqual(installed)
    expect(calls).toBe(1)
    clock += 14_999
    expect(await row()).toEqual(installed)
    expect(await row()).toEqual(installed)
    expect(calls).toBe(1)
    clock += 1
    expect(await row()).toEqual(broken)
    expect(calls).toBe(2)
    // The new answer is cached in turn (G3 r2 m-4, critic row C06): read again inside its TTL, no new probe.
    clock += 14_999
    expect(await row()).toEqual(broken)
    expect(calls).toBe(2)
  })
})

describe('ipc', () => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown

  function register(trusted = true, lastInputAt?: () => number) {
    const handlers = new Map<string, Handler>()
    const deps = world()

    const layer = registerConfinement({
      ...deps,
      ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener as Handler) },
      isTrustedSender: () => trusted,
      lastInputAt
    })

    return { handlers, layer, deps }
  }

  it('F7/T2 — allowing a group needs the real-click lock; with it, the files under that folder are recorded', async () => {
    const { deps, handlers, layer } = register(true, () => Date.now())
    const project = path.join(realpathSync(path.dirname(deps.userDataDir)), 'project')
    const outside = path.join(path.dirname(deps.userDataDir), 'outside')

    mkdirSync(path.join(project, 'vendor'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(path.join(outside, 'secret'), 's\n')
    writeFileSync(path.join(outside, 'other'), 'o\n')
    linkSync(path.join(outside, 'secret'), path.join(project, 'vendor', 'linked'))
    linkSync(path.join(outside, 'other'), path.join(project, 'vendor', 'linked2'))

    const refused = layer.backend('seatbelt').spawn({
      cls: 'project',
      argv: ['/usr/bin/true'],
      cwd: project,
      projectRoot: project,
      network: false,
      writeProject: true
    })

    expect(refused.ok).toBe(false)

    const [group] = (await layer.state()).hardlinks[0].groups

    expect(group).toMatchObject({ dir: path.join(project, 'vendor'), count: 2 })

    const ack = handlers.get(CONFINEMENT_CHANNELS.ackHardlink)
    const input = { root: project, dir: group.dir, digest: group.digest }
    const acks = () => readFileSync(hardlinkFiles(deps.userDataDir).acks, 'utf8')

    for (const gesture of [undefined, { activation: true, confirm: false }, { activation: false, confirm: true }]) {
      expect(await ack?.({}, { ...input, gesture })).toEqual({ ok: false, reason: 'no-gesture' })
    }

    expect(acks()).not.toContain('linked')
    expect(await ack?.({}, { ...input, gesture: { activation: true, confirm: true } })).toEqual({
      ok: true,
      dir: group.dir,
      count: 2
    })
    expect(acks()).toContain('linked2')
    expect(await ack?.({}, { root: project, dir: group.dir, gesture: { activation: true, confirm: true } })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect((await layer.state()).hardlinks).toEqual([])
  })

  it('F7 — a click main did not see (no trusted input in the window) acknowledges nothing', async () => {
    const { handlers } = register(true, () => 0)

    expect(
      await handlers.get(CONFINEMENT_CHANNELS.ackHardlink)?.(
        {},
        { root: '/x', dir: '/x/y', digest: 'd', gesture: { activation: true, confirm: true } }
      )
    ).toEqual({ ok: false, reason: 'no-gesture' })
  })

  it('T6 — registerConfinement needs the sender guard at the type level: there is no fail-open default', () => {
    const deps = world()

    // @ts-expect-error — isTrustedSender is required (L9): a channel without it would answer any renderer.
    const register = () => registerConfinement({ ...deps, ipcMain: { handle: () => undefined } })

    expect(typeof register).toBe('function')
  })

  it('T6′ — and at runtime: without the guard, registration throws and no channel exists to answer a renderer', () => {
    const deps = world()
    const handlers = new Map<string, Handler>()
    const ipcMain = { handle: (channel: string, listener: Handler) => void handlers.set(channel, listener) }

    expect(() => registerConfinement({ ...deps, ipcMain, isTrustedSender: undefined as never })).toThrow(
      /isTrustedSender is required/
    )
    expect(handlers.size).toBe(0)
    expect(existsSync(path.join(deps.userDataDir, 'confinement'))).toBe(false)
    expect(confinementSpawnEnv()).toEqual({})
  })

  it('r5 MINOR-1 — the guard’s answer counts only as exactly true: a truthy non-boolean answers nothing on any channel', async () => {
    const synthetic = { sender: { id: 999, getURL: () => 'http://evil/' }, senderFrame: null }
    const answers: unknown[] = ['false', 'yes', 1, {}, [], 0, '', null, undefined, false]

    for (const answer of answers) {
      const deps = world()
      const handlers = new Map<string, Handler>()

      registerConfinement({
        ...deps,
        ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener as Handler) },
        isTrustedSender: (() => answer) as never
      })
      expect(handlers.size).toBe(4)

      for (const [channel, handler] of handlers) {
        expect(await handler(synthetic, { pid: 2 }), `${channel} with ${JSON.stringify(answer)}`).toBeNull()
      }

      stopConfinement()
    }

    const deps = world()
    const handlers = new Map<string, Handler>()
    const seen: string[] = []

    registerConfinement({
      ...deps,
      ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener as Handler) },
      isTrustedSender: (_event, channel) => {
        seen.push(channel)

        return true
      }
    })
    expect(await handlers.get(CONFINEMENT_CHANNELS.state)?.(synthetic)).toMatchObject({
      schema: 'iclone.confinement.state/6'
    })
    expect(seen).toEqual([CONFINEMENT_CHANNELS.state])
  })

  it('every channel is iclone:confinement:*', () => {
    const { handlers } = register()

    expect([...handlers.keys()].sort()).toEqual(
      [
        CONFINEMENT_CHANNELS.ackHardlink,
        CONFINEMENT_CHANNELS.explain,
        CONFINEMENT_CHANNELS.kill,
        CONFINEMENT_CHANNELS.state
      ].sort()
    )
    expect(Object.values(CONFINEMENT_CHANNELS).every(channel => channel.startsWith('iclone:confinement:'))).toBe(true)
  })

  it('state answers the schema; kill refuses a pid that is not confined and any malformed input', async () => {
    const { handlers } = register()

    expect(await handlers.get(CONFINEMENT_CHANNELS.state)?.({})).toMatchObject({ schema: 'iclone.confinement.state/6' })
    expect(await handlers.get(CONFINEMENT_CHANNELS.kill)?.({}, { pid: process.pid })).toMatchObject({
      ok: false,
      reason: 'not-confined'
    })

    for (const bad of [null, {}, { pid: 1 }, { pid: -5 }, { pid: '12; rm -rf /' }, { pid: 1.5 }]) {
      expect(await handlers.get(CONFINEMENT_CHANNELS.kill)?.({}, bad)).toMatchObject({
        ok: false,
        reason: 'invalid'
      })
    }
  })

  it('an untrusted sender gets null from every channel', async () => {
    const { handlers } = register(false)

    for (const handler of handlers.values()) {
      expect(await handler({}, { pid: 123 })).toBeNull()
    }
  })

  it('confinementSpawnEnv follows the registered layer, and is empty after stop', () => {
    register()
    expect(confinementSpawnEnv().TERMINAL_ENV).toBe('iclone_seatbelt')
    stopConfinement()
    expect(confinementSpawnEnv()).toEqual({})
  })
})
