import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
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

import {
  type BackendStatusView,
  CONFINEMENT_STATE_SCHEMA,
  type ConfinementStateView
} from '../../src/iclone-shared/confinement'

import { containerRefusal } from './backend-container'
import { activeFirstScan, createHardlinkGuard, hardlinkFiles, type SealedKeyStore } from './hardlinks'
import type { TreeRecords } from './hardlinks-walk'
import { residentInProcess } from './hardlinks-walker'
import {
  CONFINEMENT_CHANNELS,
  confinementSpawnEnv,
  FIRST_SCAN_NOTICE_MS,
  registerConfinement,
  stopConfinement
} from './ipc'
import { realOrSelf } from './profiles'
import { refusalRecordDir, reportedRefusalsDir } from './refusals'
import { runtimeWritableFolders } from './runtime-profile'
import { parsePs, verdictOf } from './state'

import {
  createConfinement,
  DEFAULT_SETTINGS,
  HERMES_BACKEND_NAME,
  readAckCommands,
  readAckPids,
  readSettings,
  sweepAcks
} from './index'

const dirs: string[] = []

/**
 * These worlds start no Hermes, so on macOS the runtime reads "not running" and the verdict is red for that one
 * reason. The verdict the rest of the state gives, which is what these cases are about: the real rule (state.ts
 * `verdictOf`, the one foldState applies) over the reasons minus that one.
 */
const verdictApartFromTheRuntime = (state: ConfinementStateView) => {
  expect(state.reasons.filter(reason => reason.code === 'runtime-not-running')).toHaveLength(
    state.enabled && process.platform === 'darwin' ? 1 : 0
  )

  return verdictOf(
    state.enabled,
    state.reasons.filter(reason => reason.code !== 'runtime-not-running')
  )
}

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
  readdirSync(refusalRecordDir(deps.userDataDir))
    .filter(name => name.endsWith('.jsonl'))
    .flatMap(name => readFileSync(path.join(refusalRecordDir(deps.userDataDir), name), 'utf8').split('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line) as { operation: string; target: string })

afterEach(() => {
  stopConfinement()

  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('a run’s refusal count has one source, before and after its end', () => {
  const SHA = 'a'.repeat(64)
  const token = (n: number) => `project+${SHA.slice(0, 12)}+sess-1+${n.toString(16).padStart(32, '0')}`
  const T0 = Date.parse('2026-11-01T10:00:00.000Z')
  const iso = (ms: number) => new Date(T0 + ms).toISOString()

  const startRow = (n: number, command: string) =>
    JSON.stringify({
      v: 1,
      ev: 'start',
      ts: iso(n),
      run: token(n),
      pid: 40_000 + n,
      kind: 'shell',
      cls: 'project',
      sha: SHA,
      session: 'sess-1',
      command,
      cwd: '/Users/me/p',
      project: '/Users/me/p',
      net: false,
      write: true
    })

  it('fx24: a look lists and counts wherever it pointed, whatever the start row’s folders', async () => {
    const deps = { ...world(), now: () => new Date(T0 + 1_500) }
    const layer = createConfinement(deps)
    const ledger = path.join(deps.userDataDir, 'confinement', 'ledger')

    mkdirSync(ledger, { recursive: true })
    writeFileSync(path.join(ledger, 'runs.jsonl'), `${startRow(1, 'cd ~/.ssh; ls')}\n`)

    const look = (target: string, pid: number) => ({
      ts: iso(100 + pid),
      pid,
      process: 'bash',
      operation: 'file-read-metadata',
      target,
      sessionId: 'sess-1',
      run: token(1),
      shellLook: true
    })

    layer.refusals.append(look('/Users/me', 1))
    layer.refusals.append(look('/Users/me/p', 2))
    layer.refusals.append(look('/Users/me/.ssh', 3))

    const state = await layer.state()

    expect(state.refusals.map(row => row.target).sort()).toEqual(['/Users/me', '/Users/me/.ssh', '/Users/me/p'])
    expect(state.runs.find(run => run.id === token(1))).toMatchObject({ refusals: 3 })
  })

  it('three refusals stay three while the run runs, after it ends, and after another run refuses 1 200 times', async () => {
    const deps = { ...world(), now: () => new Date(T0 + 1_500) }
    const layer = createConfinement(deps)
    const ledger = path.join(deps.userDataDir, 'confinement', 'ledger')

    mkdirSync(ledger, { recursive: true })
    writeFileSync(path.join(ledger, 'runs.jsonl'), `${startRow(1, 'cat ~/.ssh/config')}\n${startRow(2, 'sleep 900')}\n`)

    const row = (run: string, index: number) => ({
      ts: iso(100 + index),
      pid: 50_000 + index,
      process: 'cat',
      operation: 'file-read-data',
      target: `/Users/me/.ssh/config-${index}`,
      sessionId: 'sess-1',
      run
    })

    for (let index = 0; index < 3; index += 1) {
      layer.refusals.append(row(token(1), index))
    }

    const countOf = async (n: number) => (await layer.state()).runs.find(run => run.id === token(n))?.refusals

    // Running (its start is within the grace, no end yet).
    expect(await countOf(1)).toBe(3)

    // Ended.
    writeFileSync(
      path.join(ledger, 'runs.jsonl'),
      `${startRow(1, 'cat ~/.ssh/config')}\n${startRow(2, 'sleep 900')}\n${JSON.stringify({ v: 1, ev: 'end', ts: iso(900), run: token(1), pid: 40_001, code: 1, signal: null })}\n`
    )
    expect(await countOf(1)).toBe(3)

    // The other run refuses more than the shared list keeps: the first run's number does not move.
    for (let index = 0; index < 1_200; index += 1) {
      layer.refusals.append(row(token(2), 10 + index))
    }

    const state = await layer.state()

    expect(state.runs.find(run => run.id === token(1))?.refusals).toBe(3)
    expect(state.runs.find(run => run.id === token(2))?.refusals).toBe(1_200)
    expect(state.refusals).toHaveLength(100)
  }, 30_000)

  it('the record a run’s count is read from lies in no folder the runtime may write, and what it writes there counts nothing', async () => {
    const deps = { ...world(), now: () => new Date(T0 + 1_500) }
    const layer = createConfinement(deps)
    const ledger = path.join(deps.userDataDir, 'confinement', 'ledger')
    const inside = (child: string, parent: string) => child === parent || child.startsWith(`${parent}${path.sep}`)
    const record = realpathSync(layer.refusals.dir)

    for (const folder of runtimeWritableFolders(layer.paths)) {
      expect(inside(record, folder), `${record} inside ${folder}`).toBe(false)
      expect(inside(folder, record), `${folder} inside ${record}`).toBe(false)
    }

    mkdirSync(ledger, { recursive: true })
    writeFileSync(path.join(ledger, 'runs.jsonl'), `${startRow(1, 'cat ~/.ssh/config')}\n`)
    layer.refusals.append({
      ts: iso(100),
      pid: 50_000,
      process: 'cat',
      operation: 'file-read-data',
      target: '/Users/me/.ssh/config',
      sessionId: 'sess-1',
      run: token(1)
    })

    // The runtime writes what it may: its report folder, a forged per-run file and kernel-looking rows in it.
    const reported = reportedRefusalsDir(deps.userDataDir)

    const forged = JSON.stringify({
      ts: iso(200),
      pid: 7,
      process: 'cat',
      operation: 'file-read-data',
      target: '/forged',
      sessionId: 'sess-1',
      run: token(1)
    })

    mkdirSync(path.join(reported, 'runs'), { recursive: true })
    writeFileSync(path.join(reported, 'runs', `${token(1)}.jsonl`), `${forged}\n`.repeat(500))
    writeFileSync(path.join(reported, `${iso(200).slice(0, 10)}.jsonl`), `${forged}\n`.repeat(50))

    const state = await layer.state()

    expect(state.runs.find(run => run.id === token(1))?.refusals).toBe(1)
    expect(state.refusals.map(row => row.target)).toEqual(['/Users/me/.ssh/config'])
  })
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

    expect(verdictApartFromTheRuntime(state)).toBe('green')
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
    expect(second.spawnEnv()).toEqual({ ICLONE_CONFINEMENT: 'off' })

    const signed = JSON.parse(readFileSync(settingsFile(deps), 'utf8')) as { body: string; sig: string }

    writeFileSync(
      settingsFile(deps),
      JSON.stringify({ ...signed, sig: signed.sig.replace(/^./, c => (c === '0' ? '1' : '0')) })
    )

    const third = createConfinement(deps)
    const state = await third.state()

    expect(verdictApartFromTheRuntime(state)).toBe('green')
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

    expect(verdictApartFromTheRuntime(state)).toBe('green')
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

    expect(verdictApartFromTheRuntime(await layer.state())).toBe('green')
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
    expect(layer.spawnEnv()).toEqual({ ICLONE_CONFINEMENT: 'off' })
    expect((await layer.state()).verdict).toBe('off')
  })

  it('off macOS the shell is left as it was (Linux and Windows are not in this release)', () => {
    expect(createConfinement({ ...world(), platform: 'linux' }).spawnEnv()).toEqual({})
  })

  it('fx18 (F3): the spawn env carries the user name and e-mail of the global git config, and nothing else of it', () => {
    const layer = createConfinement({
      ...world(),
      platform: 'darwin',
      gitIdentity: () => ({ name: 'Proof Person', email: 'proof@example.invalid' })
    })

    const env = layer.spawnEnv()
    expect(env.ICLONE_GIT_USER_NAME).toBe('Proof Person')
    expect(env.ICLONE_GIT_USER_EMAIL).toBe('proof@example.invalid')

    const none = createConfinement({
      ...world(),
      platform: 'darwin',
      gitIdentity: () => ({ name: '', email: '' })
    }).spawnEnv()

    expect(Object.keys(none).filter(k => k.startsWith('ICLONE_GIT'))).toEqual([])
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
      TERMINAL_ENV: 'iclone_seatbelt',
      ICLONE_CONFINEMENT_LAUNCHER: path.join(path.dirname(layer.paths.profilesDir), 'run', 'launcher.sock'),
      ICLONE_RUNTIME_CONFINED: '1'
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
    const named = path.join(dir, 'hermes-ack.json')
    const file = path.join(dir, 'hermes-ack.4242.json')

    dirs.push(dir)
    expect(readAckPids(named)).toEqual([])
    writeFileSync(file, JSON.stringify({ pid: 4242, backend: 'iclone_seatbelt' }))
    expect(readAckPids(named)).toEqual([4242])

    for (const bad of ['{', '{"pid": "x"}', '{"pid": 1}', '[]', '{"pid": 4243}']) {
      writeFileSync(file, bad)
      expect(readAckPids(named)).toEqual([])
    }
  })

  it('G22 B1: every runtime has its own acknowledgement, a second never hides the first, and a dead one is swept', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'g22-ack-'))
    const named = path.join(dir, 'hermes-ack.json')

    dirs.push(dir)
    writeFileSync(
      path.join(dir, 'hermes-ack.100.json'),
      JSON.stringify({ v: 2, pid: 100, commands: { available: true, reason: '' } })
    )
    writeFileSync(
      path.join(dir, 'hermes-ack.200.json'),
      JSON.stringify({ v: 2, pid: 200, commands: { available: false, reason: 'no' } })
    )
    writeFileSync(named, JSON.stringify({ v: 2, pid: 300 })) // an older runtime's single file says nothing
    writeFileSync(path.join(dir, 'launcher.sock.json'), '{"pid": 400}')
    expect(readAckPids(named).sort()).toEqual([100, 200])
    expect(readAckCommands(named).sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 100, available: true, reason: '' },
      { pid: 200, available: false, reason: 'no' }
    ])

    sweepAcks(named, pid => pid === 100)
    expect(readAckPids(named)).toEqual([100])
    expect(existsSync(named)).toBe(false)
    expect(existsSync(path.join(dir, 'launcher.sock.json'))).toBe(true)
  })

  it('R20: the acknowledgement carries the config note beside available', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'ack-note-')), 'ack.json')

    writeFileSync(
      file.replace('ack.json', 'ack.4242.json'),
      JSON.stringify({
        v: 2,
        pid: 4242,
        backend: 'iclone_seatbelt',
        commands: { available: true, reason: '', note: 'unread' }
      })
    )
    expect(readAckCommands(file)).toEqual([{ pid: 4242, available: true, reason: '', note: 'unread' }])
  })

  it('the acknowledgement’s word on the agent’s commands is read as the plugin wrote it; anything else says nothing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'confinement-ack-'))
    const file = path.join(dir, 'hermes-ack.json')

    dirs.push(dir)
    expect(readAckCommands(file)).toEqual([])

    const ack = (commands: unknown) =>
      writeFileSync(
        path.join(dir, 'hermes-ack.4242.json'),
        JSON.stringify({ v: 2, pid: 4242, backend: 'iclone_seatbelt', commands })
      )

    ack({ available: false, reason: 'the launcher is not answering' })
    expect(readAckCommands(file)).toEqual([{ pid: 4242, available: false, reason: 'the launcher is not answering' }])
    ack({ available: true, reason: '' })
    expect(readAckCommands(file)).toEqual([{ pid: 4242, available: true, reason: '' }])
    ack({ available: false, reason: 'y'.repeat(5000) })
    expect(readAckCommands(file)[0]?.reason).toHaveLength(400)
    ack({ available: false, reason: 7 })
    expect(readAckCommands(file)).toEqual([{ pid: 4242, available: false, reason: '' }])

    // An older plugin (no commands), a malformed answer, or a bad pid: nothing is reported.
    for (const bad of [
      JSON.stringify({ pid: 4242, backend: 'iclone_seatbelt' }),
      JSON.stringify({ pid: 4242, commands: { available: 'no' } }),
      JSON.stringify({ pid: 4242, commands: null }),
      JSON.stringify({ pid: 1, commands: { available: false, reason: 'r' } }),
      '{'
    ]) {
      writeFileSync(path.join(dir, 'hermes-ack.4242.json'), bad)
      expect(readAckCommands(file)).toEqual([])
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

      const spawned = await layer.active().spawn({
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
      await layer.active().spawn({
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

  it('B2-M1: a first hard-link scan that starts after the window mounted is announced at start, as it counts, and at its end, at most one notice per 500 ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    try {
      const deps = world()
      const notices: number[] = []
      const payloads: unknown[] = []
      const project = mkdtempSync(path.join(os.tmpdir(), 'v3g-first-scan-'))

      dirs.push(project)
      registerConfinement({
        ...deps,
        ipcMain: { handle: () => undefined },
        isTrustedSender: () => true,
        broadcast: (channel, notice) => {
          if (channel === CONFINEMENT_CHANNELS.changed) {
            notices.push(Date.now())
            payloads.push(notice)
          }
        }
      })

      let progress: ((dirs: number) => void) | undefined
      let finish: (records: TreeRecords) => void = () => undefined

      const guard = createHardlinkGuard({
        ackFile: path.join(deps.userDataDir, 'cf4-acks.json'),
        fsEvents: null,
        walkFull: (root, options) => {
          progress = options.onProgress

          return new Promise(resolve => (finish = records => resolve(residentInProcess(root, records))))
        }
      })

      const settle = async () => {
        for (let i = 0; i < 20; i += 1) {
          await new Promise(resolve => setImmediate(resolve))
        }
      }

      const prewarmed = guard.prewarm(project)

      await settle()
      expect(progress).toBeTypeOf('function')
      // The start: told at once, and what the window reads then is the running scan.
      expect(notices).toHaveLength(1)
      expect(activeFirstScan()).toMatchObject({ dirs: 0 })

      progress?.(1_000)
      progress?.(2_000)
      expect(notices).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(FIRST_SCAN_NOTICE_MS)
      // The count moved: one trailing notice, reading the newest count.
      expect(notices).toHaveLength(2)
      expect(activeFirstScan()).toMatchObject({ dirs: 2_000 })

      await vi.advanceTimersByTimeAsync(100)
      progress?.(3_000)
      finish(new Map())
      await prewarmed
      expect(activeFirstScan()).toBeNull()
      await vi.advanceTimersByTimeAsync(FIRST_SCAN_NOTICE_MS)
      // The end: announced too (the window's read then finds no scan, and the line goes away).
      expect(notices).toHaveLength(3)
      // CF5 (B3-n5): while it runs, each notice carries the count (no window re-reads the state for it); the end
      // carries nothing, so each window reads the state once.
      expect(payloads[0]).toMatchObject({ firstScan: { dirs: 0 } })
      expect(payloads[1]).toMatchObject({ firstScan: { dirs: 2_000 } })
      expect(payloads[2]).toBeUndefined()
      expect(
        notices
          .slice(1)
          .map((at, i) => at - notices[i])
          .every(gap => gap >= FIRST_SCAN_NOTICE_MS)
      ).toBe(true)
      guard.close()
      stopConfinement()
    } finally {
      vi.useRealTimers()
    }
  })

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

    const refused = await layer.backend('seatbelt').spawn({
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
      expect(handlers.size).toBe(7)

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
      schema: CONFINEMENT_STATE_SCHEMA
    })
    expect(seen).toEqual([CONFINEMENT_CHANNELS.state])
  })

  it('every channel is iclone:confinement:*', () => {
    const { handlers } = register()

    expect([...handlers.keys()].sort()).toEqual(
      [
        CONFINEMENT_CHANNELS.ackHardlink,
        CONFINEMENT_CHANNELS.explain,
        CONFINEMENT_CHANNELS.hardlinkPaths,
        CONFINEMENT_CHANNELS.kill,
        CONFINEMENT_CHANNELS.state,
        CONFINEMENT_CHANNELS.stopRun,
        CONFINEMENT_CHANNELS.setIsolation
      ].sort()
    )
    expect(Object.values(CONFINEMENT_CHANNELS).every(channel => channel.startsWith('iclone:confinement:'))).toBe(true)
  })

  it('CF5 B3-n2: hardlink-paths answers only a well-formed request (no unknown field), and a group it does not hold is `changed`', async () => {
    const { handlers } = register()
    const page = handlers.get(CONFINEMENT_CHANNELS.hardlinkPaths)
    const good = { root: '/p', dir: '/p/d', digest: 'x', offset: 0 }

    expect(await page?.({}, good)).toEqual({ ok: false, reason: 'changed' })

    for (const bad of [
      null,
      {},
      { ...good, offset: -1 },
      { ...good, offset: 1.5 },
      { ...good, root: 1 },
      { ...good, extra: 1 }
    ]) {
      expect(await page?.({}, bad), JSON.stringify(bad)).toEqual({ ok: false, reason: 'invalid' })
    }
  })

  it('state answers the schema; kill refuses a pid that is not confined and any malformed input', async () => {
    const { handlers } = register()

    expect(await handlers.get(CONFINEMENT_CHANNELS.state)?.({})).toMatchObject({ schema: CONFINEMENT_STATE_SCHEMA })
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

describe('stop-run — the owner stops one run of the ledger', () => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown

  const RUN = `project+${'a'.repeat(12)}+sess-1+${'c'.repeat(32)}`
  const children: ChildProcess[] = []

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill('SIGKILL')
    }
  })

  /** A stand-in for the runtime's Python: answers the membership probe with a fixed kernel answer. */
  function fakeMemberPython(root: string, answer: Record<string, string | null>): string {
    const file = path.join(root, 'member-python.sh')

    writeFileSync(file, `#!/bin/sh\n/bin/cat > /dev/null\necho '${JSON.stringify(answer)}'\n`, { mode: 0o700 })

    return file
  }

  function register(over: Record<string, unknown> = {}, trusted = true) {
    const handlers = new Map<string, Handler>()
    const deps = { ...world(), ...over }

    const layer = registerConfinement({
      ...deps,
      ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener as Handler) },
      isTrustedSender: () => trusted
    })

    return { handlers, layer, deps, stop: handlers.get(CONFINEMENT_CHANNELS.stopRun) as Handler }
  }

  const stopsOf = (userDataDir: string) => {
    const file = path.join(userDataDir, 'confinement', 'stops.jsonl')

    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  }

  it('an untrusted sender gets null, and nothing is recorded or signalled', async () => {
    const { deps, stop } = register({}, false)

    expect(await stop({}, { run: RUN })).toBeNull()
    expect(stopsOf(deps.userDataDir)).toEqual([])
  })

  it('a malformed run id is invalid before any scan', async () => {
    const ps = vi.fn(async () => [])
    const { stop } = register({ ps })

    for (const bad of [
      null,
      {},
      { run: 5 },
      { run: '../../etc' },
      { run: `${RUN} ; kill -9 1` },
      { run: 'a'.repeat(300) }
    ]) {
      expect(await stop({}, bad)).toMatchObject({ ok: false, reason: 'invalid' })
    }

    expect(ps).not.toHaveBeenCalled()
  })

  it('unverified membership (no kernel answer) never stops by guesswork', async () => {
    const { stop } = register()

    expect(await stop({}, { run: RUN })).toMatchObject({ ok: false, run: RUN, reason: 'unverified' })
  })

  it('a run with no live member is not-running, and no stop is recorded', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'v006-stop-'))

    dirs.push(root)

    const { deps, stop } = register({
      memberPython: fakeMemberPython(root, {}),
      ps: async () => [{ pid: 4242, ppid: 1, pgid: 4242, elapsedSec: 3, command: '/bin/sleep 30' }]
    })

    expect(await stop({}, { run: RUN })).toMatchObject({ ok: false, run: RUN, reason: 'not-running' })
    expect(stopsOf(deps.userDataDir)).toEqual([])
  })

  it('g17: Stop on an approved background command ends its process group, with the launcher up or killed', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'v006-stop-'))

    dirs.push(root)

    // Its leader gone at once, as the launcher's wrapper: the command lives on in that group, and it ignores the TERM.
    const leader = spawn('/bin/sh', ['-c', "(trap '' TERM; exec /bin/sleep 42) & echo $!"], {
      detached: true,
      stdio: 'ignore'
    })

    const leftGroup = leader.pid as number

    await new Promise(resolve => leader.on('exit', resolve))

    const realPs = async () =>
      parsePs(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,etime=,command='], { encoding: 'utf8' }))

    const inGroup = async () => (await realPs()).filter(row => row.pgid === leftGroup).length

    expect(await inGroup()).toBe(1)

    const OUTSIDE = `oneshot+${'a'.repeat(12)}+outside+${'e'.repeat(32)}`
    const ledger = path.join(root, 'userData', 'confinement', 'ledger')
    const at = new Date().toISOString()

    mkdirSync(ledger, { recursive: true })
    writeFileSync(
      path.join(ledger, 'runs.jsonl'),
      [
        {
          v: 1,
          ev: 'start',
          ts: at,
          run: OUTSIDE,
          pid: leftGroup,
          kind: 'shell',
          cls: null,
          sha: 'a'.repeat(64),
          session: 'sess-1',
          command: '[ran once outside the Seatbelt, approved by the owner] sleep 42',
          cwd: root,
          project: null,
          net: true,
          write: true,
          origin: 'agent',
          unconfined: true,
          one_shot: 'e'.repeat(32)
        },
        { v: 1, ev: 'end', ts: at, run: OUTSIDE, pid: leftGroup, code: 0, signal: null },
        { v: 1, ev: 'left-running', ts: at, run: OUTSIDE, pid: leftGroup }
      ]
        .map(row => JSON.stringify(row))
        .join('\n') + '\n'
    )

    const { deps, stop } = register({
      memberPython: fakeMemberPython(root, {}),
      ps: realPs,
      userDataDir: path.join(root, 'userData')
    })

    expect(await stop({}, { run: OUTSIDE })).toMatchObject({ ok: true, run: OUTSIDE })
    expect(await inGroup()).toBe(0)
    expect(stopsOf(deps.userDataDir)).toHaveLength(1)
    expect(await stop({}, { run: OUTSIDE })).toMatchObject({ ok: false, reason: 'not-running' })
  })

  it('fx26a: a process the kernel holds as confined with no token is stopped by the Stop of the ended run that may own it', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'v006-stop-'))

    dirs.push(root)

    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })

    children.push(child)

    const pid = child.pid as number
    const alive = () => child.exitCode === null && child.signalCode === null
    const journal = path.join(root, 'userData', 'confinement', 'ledger')
    const OTHER = `project+${'a'.repeat(12)}+sess-1+${'d'.repeat(32)}`

    const row = (over: Record<string, unknown>) =>
      JSON.stringify({
        v: 1,
        kind: 'shell',
        cls: 'project',
        sha: 'a'.repeat(64),
        session: 'sess-1',
        command: 'sleep 30',
        cwd: '/tmp',
        project: null,
        net: false,
        write: false,
        ...over
      })

    mkdirSync(journal, { recursive: true })
    // RUN ended a minute ago and left something behind; OTHER was stopped by its owner, so it owns nothing.
    writeFileSync(
      path.join(journal, 'runs.jsonl'),
      [
        row({ ev: 'start', ts: new Date(Date.now() - 60_000).toISOString(), run: RUN, pid: 999_999 }),
        JSON.stringify({
          v: 1,
          ev: 'end',
          ts: new Date(Date.now() - 59_000).toISOString(),
          run: RUN,
          pid: 999_999,
          code: 0,
          signal: null
        }),
        JSON.stringify({ v: 1, ev: 'left-running', ts: new Date(Date.now() - 58_000).toISOString(), run: RUN }),
        row({ ev: 'start', ts: new Date(Date.now() - 30_000).toISOString(), run: OTHER, pid: 999_998 }),
        JSON.stringify({
          v: 1,
          ev: 'end',
          ts: new Date(Date.now() - 29_000).toISOString(),
          run: OTHER,
          pid: 999_998,
          code: 0,
          signal: null
        }),
        ''
      ].join('\n')
    )
    // Main's own stops file: the owner pressed Stop on OTHER before its end landed.
    writeFileSync(
      path.join(root, 'userData', 'confinement', 'stops.jsonl'),
      `${JSON.stringify({ v: 1, ev: 'stop', ts: new Date(Date.now() - 29_500).toISOString(), run: OTHER })}\n`
    )

    // The kernel's answer: confined, and no token names it.
    const { deps, layer, stop } = register({
      userDataDir: path.join(root, 'userData'),
      memberPython: fakeMemberPython(root, { [pid]: null }),
      ps: async () => (alive() ? [{ pid, ppid: 1, pgid: pid, elapsedSec: 3, command: '/bin/sleep 30' }] : [])
    })

    expect((await layer.state()).runs).toMatchObject([
      { id: RUN, phase: 'background', live: 1 },
      { id: OTHER, phase: 'stopped', live: 0 }
    ])
    expect(await stop({}, { run: OTHER })).toMatchObject({ ok: false, run: OTHER, reason: 'not-running' })
    expect(alive()).toBe(true)

    expect(await stop({}, { run: RUN })).toEqual({ ok: true, run: RUN, killed: [pid] })

    for (let left = 100; alive() && left > 0; left -= 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    expect(alive()).toBe(false)
    expect(stopsOf(deps.userDataDir).map(line => (JSON.parse(line) as { run: string }).run)).toEqual([OTHER, RUN])
  })

  describe('fx28: a Stop that does what the row says', () => {
    const OLDER = `project+${'a'.repeat(12)}+sess-1+${'d'.repeat(32)}`
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

    const startLine = (run: string, pid: number, ts: string) =>
      JSON.stringify({
        v: 1,
        ev: 'start',
        ts,
        run,
        pid,
        kind: 'shell',
        cls: 'project',
        sha: 'a'.repeat(64),
        session: 'sess-1',
        command: 'sleep 30',
        cwd: '/tmp',
        project: null,
        net: false,
        write: false
      })

    const endedLeaving = (run: string, pid: number) => [
      startLine(run, pid, ago(60_000)),
      JSON.stringify({ v: 1, ev: 'end', ts: ago(59_000), run, pid, code: 0, signal: null }),
      JSON.stringify({ v: 1, ev: 'left-running', ts: ago(58_000), run })
    ]

    const world = (lines: string[]) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'v006-stop-'))

      dirs.push(root)
      mkdirSync(path.join(root, 'userData', 'confinement', 'ledger'), { recursive: true })
      writeFileSync(path.join(root, 'userData', 'confinement', 'ledger', 'runs.jsonl'), `${lines.join('\n')}\n`)

      return root
    }

    const sleeper = () => {
      const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })

      children.push(child)

      return { child, pid: child.pid as number, alive: () => child.exitCode === null && child.signalCode === null }
    }

    const gone = async (alive: () => boolean) => {
      for (let left = 100; alive() && left > 0; left -= 1) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }

      return !alive()
    }

    const row = (pid: number, elapsedSec: number) => ({ pid, ppid: 1, pgid: pid, elapsedSec, command: '/bin/sleep 30' })

    it('its token gone, its first process alive: running with a Stop that works, and the older run has no claim on it', async () => {
      const first = sleeper()
      const root = world([...endedLeaving(OLDER, 999_999), startLine(RUN, first.pid, ago(1_000))])

      const { layer, stop } = register({
        userDataDir: path.join(root, 'userData'),
        memberPython: fakeMemberPython(root, { [first.pid]: null }),
        ps: async () => (first.alive() ? [row(first.pid, 1)] : [])
      })

      expect((await layer.state()).runs).toMatchObject([
        { id: RUN, phase: 'running', live: 1 },
        { id: OLDER, phase: 'exited', live: 0, backgroundEnded: true }
      ])
      expect(await stop({}, { run: OLDER })).toMatchObject({ ok: false, run: OLDER, reason: 'not-running' })
      expect(first.alive()).toBe(true)
      expect(await stop({}, { run: RUN })).toEqual({ ok: true, run: RUN, killed: [first.pid] })
      expect(await gone(first.alive)).toBe(true)
    })

    it('fx29: the clock the tie is judged by is the moment ps was read, not a later one after the probes', async () => {
      const first = sleeper()
      let clock = Date.now()
      const started = clock - 1_000
      const root = world([startLine(RUN, first.pid, new Date(started).toISOString())])

      const { layer, stop } = register({
        userDataDir: path.join(root, 'userData'),
        memberPython: fakeMemberPython(root, { [first.pid]: null }),
        now: () => new Date(clock),
        ps: async () => {
          // The probes after the read take time: the clock moves on before the fold.
          setTimeout(() => {
            clock += 3_000
          }, 0)

          return first.alive() ? [row(first.pid, Math.round((clock - started) / 1_000))] : []
        }
      })

      expect((await layer.state()).runs).toMatchObject([{ id: RUN, phase: 'running', live: 1 }])
      expect(await stop({}, { run: RUN })).toMatchObject({ ok: true, run: RUN })
    })

    it('a Stop that reported survivors does not end the run: it stays live and its Stop is still there', async () => {
      const held = sleeper()
      const root = world(endedLeaving(RUN, 999_999))

      // The kernel keeps naming the process after the signals: a survivor, as far as the Stop can tell.
      const { deps, layer, stop } = register({
        userDataDir: path.join(root, 'userData'),
        memberPython: fakeMemberPython(root, { [held.pid]: null }),
        ps: async () => [row(held.pid, 3)]
      })

      expect(await stop({}, { run: RUN })).toMatchObject({
        ok: false,
        run: RUN,
        reason: 'survivors',
        survivors: [held.pid]
      })
      expect(stopsOf(deps.userDataDir).map(line => (JSON.parse(line) as { outcome?: string }).outcome)).toEqual([
        undefined,
        'failed'
      ])
      expect((await layer.state()).runs).toMatchObject([{ id: RUN, phase: 'background', live: 1 }])
      expect((await layer.state()).runs[0]).not.toHaveProperty('backgroundEnded')
      // Pressed again, it asks the kernel again; it does not answer not-running.
      expect(await stop({}, { run: RUN })).toMatchObject({ ok: false, reason: 'survivors' })
    })

    it('the first of two orphans dies, the second survives: the whole Stop failed and names the survivor', async () => {
      const first = sleeper()
      const second = sleeper()
      const root = world(endedLeaving(RUN, 999_999))

      const { deps, layer, stop } = register({
        userDataDir: path.join(root, 'userData'),
        memberPython: fakeMemberPython(root, { [first.pid]: null, [second.pid]: null }),
        ps: async () => [...(first.alive() ? [row(first.pid, 5)] : []), row(second.pid, 3)]
      })

      expect(await stop({}, { run: RUN })).toMatchObject({
        ok: false,
        run: RUN,
        reason: 'survivors',
        survivors: [second.pid]
      })
      expect(first.alive()).toBe(false)
      expect(stopsOf(deps.userDataDir).map(line => (JSON.parse(line) as { outcome?: string }).outcome)).toEqual([
        undefined,
        'failed'
      ])
      expect((await layer.state()).runs).toMatchObject([{ id: RUN, phase: 'background', live: 1 }])
    })
  })

  it('a stop record that cannot be written does not hold back the kill', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'v006-stop-'))

    dirs.push(root)

    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })

    children.push(child)

    const pid = child.pid as number
    const alive = () => child.exitCode === null && child.signalCode === null
    const said: string[] = []

    // A directory where the stops file goes: the append fails as it would on a full disk.
    mkdirSync(path.join(root, 'userData', 'confinement', 'stops.jsonl'), { recursive: true })

    const { stop } = register({
      log: (line: string) => said.push(line),
      userDataDir: path.join(root, 'userData'),
      memberPython: fakeMemberPython(root, { [pid]: RUN }),
      ps: async () => (alive() ? [{ pid, ppid: process.pid, pgid: pid, elapsedSec: 1, command: '/bin/sleep 30' }] : [])
    })

    expect(await stop({}, { run: RUN })).toEqual({ ok: true, run: RUN, killed: [pid] })
    expect(said.join('\n')).toMatch(/could not record the stop/)
  })

  it('a live run: the stop is recorded first, every member is killed, and the ledger reads stopped', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'v006-stop-'))

    dirs.push(root)

    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })

    children.push(child)

    const pid = child.pid as number
    const alive = () => child.exitCode === null && child.signalCode === null
    let stopsAtFirstSignal: string[] | null = null
    const realKill = process.kill.bind(process)

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target: number, signal?: string | number) => {
      stopsAtFirstSignal ??= stopsOf(path.join(root, 'userData'))

      return realKill(target, signal)
    })

    const journal = path.join(root, 'userData', 'confinement', 'ledger')

    mkdirSync(journal, { recursive: true })
    writeFileSync(
      path.join(journal, 'runs.jsonl'),
      `${JSON.stringify({
        v: 1,
        ev: 'start',
        ts: new Date().toISOString(),
        run: RUN,
        pid,
        kind: 'shell',
        cls: 'project',
        sha: 'a'.repeat(64),
        session: 'sess-1',
        command: 'sleep 30',
        cwd: '/tmp',
        project: null,
        net: false,
        write: false
      })}\n`
    )

    const { deps, layer, stop } = register({
      userDataDir: path.join(root, 'userData'),
      memberPython: fakeMemberPython(root, { [pid]: RUN }),
      ps: async () => (alive() ? [{ pid, ppid: process.pid, pgid: pid, elapsedSec: 1, command: '/bin/sleep 30' }] : [])
    })

    expect((await layer.state()).runs).toMatchObject([{ id: RUN, phase: 'running', live: 1, rootPid: pid }])

    const result = await stop({}, { run: RUN })

    killSpy.mockRestore()
    expect(result).toEqual({ ok: true, run: RUN, killed: [pid] })
    expect(stopsAtFirstSignal).toHaveLength(1)
    expect(JSON.parse((stopsAtFirstSignal as unknown as string[])[0])).toMatchObject({ v: 1, ev: 'stop', run: RUN })
    expect(statSync(path.join(deps.userDataDir, 'confinement', 'stops.jsonl')).mode & 0o777).toBe(0o600)
    expect((await layer.state()).runs).toMatchObject([{ id: RUN, phase: 'stopped', live: 0 }])
  })
})

describe('schema 9 — runs and the runtime ride on every state', () => {
  it('the runtime is off when not configured, not running when configured with no Hermes, and follows the optional deps', async () => {
    const linux = createConfinement({ ...world(), platform: 'linux' })

    expect((await linux.state()).runtime).toMatchObject({ state: 'off', launcher: 'off', profileSha: null })

    // On macOS with confinement on and no Hermes process: not running and the launcher down, never off.
    const idle = await createConfinement({ ...world(), platform: 'darwin' }).state()

    expect(idle.runtime).toMatchObject({ state: 'stopped', launcher: 'down', profileSha: null })
    expect(idle.reasons).toContainEqual({ code: 'runtime-not-running' })
    expect(idle.reasons).not.toContainEqual({ code: 'launcher-down' })
    expect(idle.verdict).toBe('red')

    const wired = createConfinement({
      ...world(),
      platform: 'darwin',
      // A Hermes runs (not kernel-checked here: no probe in this world), so the launcher's state is its own reason.
      hermesPids: () => [4242],
      ps: async () => [{ pid: 4242, ppid: 1, pgid: 4242, elapsedSec: 5, command: 'python -m hermes_cli.main serve' }],
      runtime: () => ({ profileSha: 'f'.repeat(64), reads: ['/usr'], writes: ['/w'], denied: ['/d'] }),
      launcher: () => 'down'
    })

    const state = await wired.state()

    expect(state.runtime).toMatchObject({ profileSha: 'f'.repeat(64), launcher: 'down', reads: ['/usr'] })
    expect(state.reasons).toContainEqual({ code: 'launcher-down' })
    expect(state.verdict).toBe('red')
    expect(state.runs).toEqual([])
  })

  it('the plugin’s acknowledgement that commands are unavailable turns the state red with its reason; available adds nothing', async () => {
    const layer = createConfinement({
      ...world(),
      platform: 'darwin',
      hermesPids: () => [4242],
      ps: async () => [{ pid: 4242, ppid: 1, pgid: 4242, elapsedSec: 5, command: 'python -m hermes_cli.main serve' }],
      runtime: () => ({ profileSha: 'f'.repeat(64), reads: [], writes: [], denied: [] }),
      launcher: () => 'up'
    })

    const ackFile = layer.spawnEnv().ICLONE_CONFINEMENT_ACK

    const ack = (commands: { available: boolean; reason: string }) => {
      mkdirSync(path.dirname(ackFile), { recursive: true })
      writeFileSync(
        ackFile.replace('hermes-ack.json', 'hermes-ack.4242.json'),
        JSON.stringify({ v: 2, pid: 4242, backend: 'iclone_seatbelt', commands })
      )
    }

    const codes = async () => (await layer.state()).reasons.map(reason => reason.code)

    ack({ available: true, reason: '' })
    expect(await codes()).not.toContain('agent-commands-unavailable')

    ack({ available: false, reason: 'the launcher is not answering' })

    const red = await layer.state()

    expect(red.reasons).toContainEqual({
      code: 'agent-commands-unavailable',
      reason: 'the launcher is not answering',
      reportedBy: 'runtime'
    })
    expect(red.verdict).toBe('red')
  })
})

describe('G23, the owner: what main records for one file', () => {
  const judge = () => {
    const deps = world()

    mkdirSync(deps.home, { recursive: true })

    const layer = createConfinement(deps)
    const home = realpathSync(deps.home)

    return {
      issued: (rel: string) => layer.issueOneFile(path.join(home, rel), home),
      runs: (rel: string) => layer.oneFileRuns(path.join(home, rel), home),
      deps
    }
  }

  it.each([
    '.zshrc',
    '.gitconfig',
    '.ssh/config',
    '.ssh/authorized_keys',
    '.aws/credentials',
    '.npmrc',
    '.pgpass',
    'Library/LaunchAgents/x.plist',
    'Library/Keychains/x',
    'Library/Application Support/Google/Chrome/Default/Login Data',
    'Library/Safari/Bookmarks.plist',
    'Library/app/.git/config',
    'Library/app/.GIT/config',
    'Library/Caches/pip/d/x',
    'notes.txt'
  ])('records: %s', rel => {
    expect(judge().issued(rel)).toBe(true)
  })

  it.each(['.hermes/config.yaml', '.hermes/plugins/x.py', '.HERMES/.env', '.hermes/auth.json', 'plain-folder/x.txt'])(
    'never: %s',
    rel => {
      expect(judge().issued(rel)).toBe(false)
    }
  )

  it("this app's data, in any case, takes no row", () => {
    const { deps } = judge()
    const layer = createConfinement(deps)
    const data = realOrSelf(deps.userDataDir)

    expect(layer.issueOneFile(path.join(data, 'consent.json'), data)).toBe(false)
    expect(layer.issueOneFile(path.join(data, 'CONFINEMENT/ledger/oneshots.jsonl'), data)).toBe(false)
  })

  it.each([
    '.zshrc',
    '.ssh/config',
    '.aws/credentials',
    'Library/LaunchAgents/x',
    'Library/Application Support/Firefox/x',
    'a/.git/config',
    '.pgpass'
  ])('the sheet adds its line for: %s', rel => {
    expect(judge().runs(rel)).toBe(true)
  })

  it.each(['notes.txt', 'Library/Application Support/Some App/x.json'])('and not for: %s', rel => {
    expect(judge().runs(rel)).toBe(false)
  })
})
