/**
 * v0.0.9 F3 — one fixture per repair class, each in a throwaway HOME (never the real one). For each: the kit finds it,
 * a dry run touches nothing, the repair backs up dated and moves aside (nothing deleted), the next start is green
 * without any other help, and undo puts it back where undo is possible.
 *
 * "Green boot" here is the kit's own model of the next start: every class re-checked with the latch cleared (what
 * main does after a repair) reads ok or skipped. The live proof (a Seatbelt spawn reaching ready) belongs to the
 * packaged-app run, not to this suite.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BootCause } from '../boot-cause'
import { EXPECTED_ICLONE_PLUGINS } from '../iclone-hermes-plugins'

import { ownOrphanCandidates } from './ipc'
import { asideDate, createRepairKit, parsePluginsDisabled, type RepairKitDeps, runtimeInstallKey } from './kit'

interface Fixture {
  root: string
  home: string
  hermesHome: string
  userData: string
  runtimeRoot: string
  privateHermesHome: string
  cause: BootCause | null
  orphans: number[]
  deadSockets: Set<string>
  reinstallRequested: number
  stops: number
  deps: RepairKitDeps
}

let fx: Fixture

const NOW = new Date(2026, 10, 14, 9, 33, 0, 0) // the owner's own move, 14 Nov 2026 09:33 local

function makeFixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repair-kit-')))
  const home = path.join(root, 'home')
  // Short on purpose: a unix socket path must stay under 104 bytes on macOS (the port-busy fixture binds real ones).
  const userData = path.join(root, 'ud')
  const runtimeRoot = path.join(userData, 'hermes-runtime', '20e847b8893745fb')

  const f = {
    cause: null,
    deadSockets: new Set<string>(),
    hermesHome: path.join(home, '.hermes'),
    home,
    orphans: [],
    privateHermesHome: path.join(runtimeRoot, '.iclone-deps', 'hermes'),
    reinstallRequested: 0,
    root,
    runtimeRoot,
    stops: 0,
    userData
  } as unknown as Fixture

  for (const dir of [f.hermesHome, userData, runtimeRoot, f.privateHermesHome]) {
    fs.mkdirSync(dir, { mode: 0o755, recursive: true })
    fs.chmodSync(dir, 0o755) // whatever the umask: a clean machine starts with no root writable by others
  }

  f.deps = {
    appVersion: '0.0.9-test',
    bootCause: () => f.cause,
    hermesHome: f.hermesHome,
    log: () => undefined,
    now: () => NOW,
    orphans: {
      list: async () => f.orphans.map(pid => ({ command: 'hermes serve', pid })),
      reap: async () => {
        const reaped = f.orphans
        f.orphans = []

        return reaped
      }
    },
    privateHermesHome: f.privateHermesHome,
    requestReinstall: () => {
      f.reinstallRequested += 1
    },
    runtimeRoot,
    socketAlive: async file => !f.deadSockets.has(file),
    stopAgent: async () => {
      f.stops += 1
    },
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    userData
  }

  return f
}

/** The next start as the kit models it: main cleared the latch, every class re-checked reads ok or skipped. */
async function nextStartIsGreen(): Promise<boolean> {
  fx.cause = null
  const findings = await createRepairKit(fx.deps).scan()

  return findings.every(finding => finding.status === 'ok' || finding.status === 'skipped')
}

beforeEach(() => {
  fx = makeFixture()
})

afterEach(() => {
  fs.rmSync(fx.root, { force: true, recursive: true })
  vi.restoreAllMocks()
})

describe('a clean machine', () => {
  it('scans green and every repair is an empty plan', async () => {
    const kit = createRepairKit(fx.deps)

    expect(await nextStartIsGreen()).toBe(true)

    for (const finding of await kit.scan()) {
      expect((await kit.apply(finding.classId, { dryRun: false })).applied).toEqual([])
    }

    expect(fx.stops).toBe(0)
  })
})

describe('stale-install-record — the exact state of 14 Nov 2026', () => {
  function plant() {
    const key = runtimeInstallKey(fx.runtimeRoot)!
    const record = path.join(fx.hermesHome, 'installs', key)
    const venv = path.join(record, 'environments', 'd2a0574ad8364ad4a87cee896f2a3bea', 'venv')

    fs.mkdirSync(venv, { recursive: true })
    fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), 'home = /nowhere\nversion = 3.11.9\n')
    fs.writeFileSync(
      path.join(record, 'facts.json'),
      JSON.stringify({ extras: ['all', 'stt-whisper'], packages: { venv: { environment: venv } } })
    )
    // The cache the installer keeps beside it, and another runtime's record: neither is touched.
    fs.mkdirSync(path.join(fx.hermesHome, 'installs', 'bootstrap-cache'), { recursive: true })
    fs.mkdirSync(path.join(fx.hermesHome, 'installs', '0123456789abcdef'), { recursive: true })
    fs.writeFileSync(path.join(fx.hermesHome, 'installs', '0123456789abcdef', 'facts.json'), '{}')
    fx.cause = {
      code: 'install-state-not-writable',
      line: `hermes: install state is not writable by this user (${record}/environments/d2a0574ad8364ad4a87cee896f2a3bea/.leases/x)`
    }

    return { key, record }
  }

  it('is found; a dry run plans the move and touches nothing', async () => {
    const { record } = plant()
    const report = await createRepairKit(fx.deps).apply('stale-install-record', { dryRun: true })

    expect(report.before.status).toBe('found')
    expect(report.steps).toEqual([
      { from: record, kind: 'move-aside', to: path.join(fx.hermesHome, `installs-aside-2026-11-14`, path.basename(record)) }
    ])
    expect(fs.existsSync(path.join(record, 'facts.json'))).toBe(true)
    expect(fx.stops).toBe(0)
  })

  it('the repair moves it to installs-aside-<date>/<key> (nothing deleted), and the next start is green', async () => {
    const { key, record } = plant()
    const report = await createRepairKit(fx.deps).apply('stale-install-record', { dryRun: false })
    const aside = path.join(fx.hermesHome, `installs-aside-${asideDate(NOW)}`, key)

    expect(report).toMatchObject({ ok: true, verify: 'now' })
    expect(report.after?.status).toBe('ok')
    expect(fx.stops).toBe(1)
    expect(fs.existsSync(record)).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(aside, 'facts.json'), 'utf8')).extras).toEqual(['all', 'stt-whisper'])
    expect(fs.existsSync(path.join(fx.hermesHome, 'installs', 'bootstrap-cache'))).toBe(true)
    expect(fs.existsSync(path.join(fx.hermesHome, 'installs', '0123456789abcdef', 'facts.json'))).toBe(true)
    expect(fs.existsSync(path.join(report.manifestDir!, 'manifest.json'))).toBe(true)
    expect(fx.reinstallRequested).toBe(0)
    expect(await nextStartIsGreen()).toBe(true)
  })

  it('a second aside the same day never overwrites the first', async () => {
    const { key } = plant()
    await createRepairKit(fx.deps).apply('stale-install-record', { dryRun: false })
    plant()
    await createRepairKit(fx.deps).apply('stale-install-record', { dryRun: false })

    const day = path.join(fx.hermesHome, `installs-aside-${asideDate(NOW)}`)
    expect(fs.readdirSync(day).sort()).toEqual([key, `${key}-2`])
  })

  it('undo puts the record back exactly; a second undo is refused', async () => {
    const { record } = plant()
    const kit = createRepairKit(fx.deps)
    const { manifestId } = await kit.apply('stale-install-record', { dryRun: false })

    expect(kit.history()[0]).toMatchObject({ classId: 'stale-install-record', undoable: true })

    const undone = await kit.undo(manifestId!)

    expect(undone.ok).toBe(true)
    expect(fs.existsSync(path.join(record, 'facts.json'))).toBe(true)
    expect((await kit.undo(manifestId!)).refused).toBe('already-undone')
    expect(kit.history()[0]).toMatchObject({ undoable: false })
  })

  it('undo never overwrites a record created there since', async () => {
    const { record } = plant()
    const kit = createRepairKit(fx.deps)
    const { manifestId } = await kit.apply('stale-install-record', { dryRun: false })

    fs.mkdirSync(record, { recursive: true })
    fs.writeFileSync(path.join(record, 'facts.json'), '{"new":true}')

    const undone = await kit.undo(manifestId!)

    expect(undone.skipped[0]?.reason).toBe('occupied')
    expect(fs.readFileSync(path.join(record, 'facts.json'), 'utf8')).toBe('{"new":true}')
  })

  it('in the dev layout (no private deps home) the record is the runtime\'s own: skipped, never moved', async () => {
    const { record } = plant()
    const kit = createRepairKit({ ...fx.deps, privateHermesHome: null })

    expect((await kit.detect('stale-install-record')).finding.status).toBe('skipped')
    expect((await kit.apply('stale-install-record', { dryRun: false })).applied).toEqual([])
    expect(fs.existsSync(record)).toBe(true)
  })
})

describe('runtime-venv — the runtime\'s own record names a venv that is gone', () => {
  it('moves the private record aside, asks for the installer, and the next start is green', async () => {
    const key = runtimeInstallKey(fx.runtimeRoot)!
    const install = path.join(fx.privateHermesHome, 'installs', key)
    fs.mkdirSync(path.join(install, 'environments', 'fef8b4d0'), { recursive: true })
    fs.writeFileSync(
      path.join(install, 'facts.json'),
      JSON.stringify({ packages: { venv: { environment: path.join(install, 'environments', 'fef8b4d0', 'venv') } } })
    )
    fs.mkdirSync(path.join(fx.userData, 'hermes-runtime', 'dd86ca00older'), { recursive: true })
    fx.cause = { code: 'python-import', line: "ModuleNotFoundError: No module named 'hermes_cli'" }

    const kit = createRepairKit(fx.deps)
    const before = await kit.detect('runtime-venv')
    expect(before.finding.status).toBe('found')
    expect(before.finding.facts.join('\n')).toContain('other runtime:')

    const report = await kit.apply('runtime-venv', { dryRun: false })

    expect(report).toMatchObject({ ok: true, verify: 'next-start' })
    expect(fx.reinstallRequested).toBe(1)
    expect(fs.existsSync(install)).toBe(false)
    expect(fs.existsSync(path.join(fx.privateHermesHome, `installs-aside-${asideDate(NOW)}`, key, 'facts.json'))).toBe(true)
    // Other runtimes are listed, never moved by this class.
    expect(fs.existsSync(path.join(fx.userData, 'hermes-runtime', 'dd86ca00older'))).toBe(true)
    expect(await nextStartIsGreen()).toBe(true)
  })
})

describe('plugins-disabled — config.yaml switches the app\'s own plugins off', () => {
  const BLOCK = 'model: x\nplugins:\n  disabled:\n  - iclone-permissions\n  - my-plugin\n  - iclone-confinement\nother: 1\n'
  const FLOW = 'plugins:\n  disabled: [iclone-consent, "theirs"]\n'

  it('the parser keeps the owner\'s own entries and layout', () => {
    expect(parsePluginsDisabled(BLOCK)?.names).toEqual(['iclone-permissions', 'my-plugin', 'iclone-confinement'])
    expect(parsePluginsDisabled(BLOCK)?.edit([...EXPECTED_ICLONE_PLUGINS])).toBe(
      'model: x\nplugins:\n  disabled:\n  - my-plugin\nother: 1\n'
    )
    expect(parsePluginsDisabled(FLOW)?.edit(['iclone-consent'])).toBe('plugins:\n  disabled: [theirs]\n')
    // Security m2: an earlier section with the same bare `  disabled:` line keeps its list; only plugins.disabled empties.
    expect(
      parsePluginsDisabled(
        'tools:\n  disabled:\n  - x\nplugins:\n  disabled:\n  - iclone-permissions\n  - iclone-consent\n'
      )?.edit(['iclone-permissions', 'iclone-consent'])
    ).toBe('tools:\n  disabled:\n  - x\nplugins:\n  disabled: []\n')
    expect(parsePluginsDisabled('plugins:\n  disabled:\n  - iclone-permissions\n')?.edit(['iclone-permissions'])).toBe(
      'plugins:\n  disabled: []\n'
    )
    expect(parsePluginsDisabled('model: x\n')).toBeNull()
  })

  it('removes only the app\'s plugins (home + profile), backs the files up, the next start is green, undo restores bytes', async () => {
    const main = path.join(fx.hermesHome, 'config.yaml')
    const profile = path.join(fx.hermesHome, 'profiles', 'work', 'config.yaml')
    fs.writeFileSync(main, BLOCK)
    fs.mkdirSync(path.dirname(profile), { recursive: true })
    fs.writeFileSync(profile, FLOW)

    const kit = createRepairKit(fx.deps)
    const report = await kit.apply('plugins-disabled', { dryRun: false })

    expect(report.ok).toBe(true)
    expect(fs.readFileSync(main, 'utf8')).toContain('- my-plugin')
    expect(fs.readFileSync(main, 'utf8')).not.toContain('iclone-')
    expect(fs.readFileSync(profile, 'utf8')).toBe('plugins:\n  disabled: [theirs]\n')
    expect(report.applied.every(step => step.backup && fs.existsSync(step.backup))).toBe(true)
    expect(await nextStartIsGreen()).toBe(true)

    expect((await kit.undo(report.manifestId!)).ok).toBe(true)
    expect(fs.readFileSync(main, 'utf8')).toBe(BLOCK)
    expect(fs.readFileSync(profile, 'utf8')).toBe(FLOW)
  })

  it('undo never overwrites an edit the owner made after the repair', async () => {
    const main = path.join(fx.hermesHome, 'config.yaml')
    fs.writeFileSync(main, BLOCK)
    const kit = createRepairKit(fx.deps)
    const report = await kit.apply('plugins-disabled', { dryRun: false })

    fs.writeFileSync(main, 'plugins:\n  disabled: []\nmine: 2\n')

    expect((await kit.undo(report.manifestId!)).skipped[0]?.reason).toBe('changed-since')
    expect(fs.readFileSync(main, 'utf8')).toContain('mine: 2')
  })
})

describe('root-permissions — roots writable by others, links where the sandbox expects folders', () => {
  it('chmods go-w with the old mode in the manifest, the next start is green, undo restores the mode', async () => {
    fs.chmodSync(fx.hermesHome, 0o777)
    fs.mkdirSync(path.join(fx.userData, 'confinement', 'profiles'), { recursive: true })
    fs.chmodSync(path.join(fx.userData, 'confinement', 'profiles'), 0o775)

    const kit = createRepairKit(fx.deps)
    const report = await kit.apply('root-permissions', { dryRun: false })

    expect(report.ok).toBe(true)
    expect(fs.statSync(fx.hermesHome).mode & 0o777).toBe(0o755)
    expect(fs.statSync(path.join(fx.userData, 'confinement', 'profiles')).mode & 0o777).toBe(0o755)
    expect(await nextStartIsGreen()).toBe(true)

    await kit.undo(report.manifestId!)
    expect(fs.statSync(fx.hermesHome).mode & 0o777).toBe(0o777)
  })

  it('a linked installs folder is reported for the owner and never touched', async () => {
    const elsewhere = path.join(fx.root, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, path.join(fx.hermesHome, 'installs'))

    const kit = createRepairKit(fx.deps)
    const { finding, steps } = await kit.detect('root-permissions')

    expect(finding.status).toBe('manual')
    expect(finding.facts.join('\n')).toContain('is a link')
    expect(steps).toEqual([])
    expect(fs.lstatSync(path.join(fx.hermesHome, 'installs')).isSymbolicLink()).toBe(true)
  })
})

describe('gate-not-starting — the permission gate refused the last start', () => {
  it('when config.yaml switched the gate off: the plugins are switched back on, no reinstall; green after', async () => {
    fs.writeFileSync(path.join(fx.hermesHome, 'config.yaml'), 'plugins:\n  disabled: [iclone-permissions]\n')
    fx.cause = { code: 'gate-not-loaded', line: '[iclone-gate] The icloneOS permission gate is not in place …' }

    const report = await createRepairKit(fx.deps).apply('gate-not-starting', { dryRun: false })

    expect(report.steps.map(step => step.kind)).toEqual(['edit-config'])
    expect(report.verify).toBe('next-start')
    expect(fx.reinstallRequested).toBe(0)
    expect(await nextStartIsGreen()).toBe(true)
  })

  it('otherwise: the runtime (and the gate with it) is reinstalled on the next start', async () => {
    fx.cause = { code: 'gate-not-loaded' }

    const report = await createRepairKit(fx.deps).apply('gate-not-starting', { dryRun: false })

    expect(report.steps).toEqual([{ kind: 'reinstall-runtime' }])
    expect(fx.reinstallRequested).toBe(1)
    expect(await nextStartIsGreen()).toBe(true)
  })

  it('is never found for a crash that is not a gate refusal (the 14 Nov cause)', async () => {
    fx.cause = { code: 'install-state-not-writable' }

    expect((await createRepairKit(fx.deps).detect('gate-not-starting')).finding.status).toBe('ok')
  })
})

describe('port-busy — a socket of an earlier run, and the app\'s own leftover', () => {
  it('moves the dead socket aside, stops the leftover by its pid record; the live socket stays; green after', async () => {
    const run = path.join(fx.userData, 'run')
    fs.mkdirSync(run, { recursive: true })
    const dead = path.join(run, 'pay.sock')
    const live = path.join(run, 'acp.sock')
    const servers = [net.createServer(), net.createServer()]

    await Promise.all([
      new Promise<void>(resolve => servers[0].listen(dead, resolve)),
      new Promise<void>(resolve => servers[1].listen(live, resolve))
    ])

    try {
      fx.deadSockets.add(dead)
      fx.orphans = [424242]
      fx.cause = { code: 'port-in-use', line: 'OSError: [Errno 48] Address already in use' }

      const report = await createRepairKit(fx.deps).apply('port-busy', { dryRun: false })

      expect(report.steps.map(step => step.kind)).toEqual(['move-aside', 'reap-orphans'])
      expect(fs.existsSync(dead)).toBe(false)
      expect(fs.existsSync(path.join(fx.userData, `run-aside-${asideDate(NOW)}`, 'pay.sock'))).toBe(true)
      expect(fs.existsSync(live)).toBe(true)
      expect(await nextStartIsGreen()).toBe(true)
    } finally {
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
    }
  })

  it('a port held by another program is reported for the owner, nothing stopped', async () => {
    fx.cause = { code: 'port-in-use', line: 'EADDRINUSE 127.0.0.1:9119' }

    const { finding, steps } = await createRepairKit(fx.deps).detect('port-busy')

    expect(finding.status).toBe('manual')
    expect(steps).toEqual([])
  })
})

describe('orphan-processes — only the app\'s own, by its own pid records', () => {
  it('reaps through the ownership proof and is green after', async () => {
    fx.orphans = [5150, 5151]

    const report = await createRepairKit(fx.deps).apply('orphan-processes', { dryRun: false })

    expect(report.applied[0]?.detail).toContain('5150, 5151')
    expect(report.after?.status).toBe('ok')
    expect(await nextStartIsGreen()).toBe(true)
  })

  it("the candidates are only what the reap would stop, minus this app run's own children and live backend", () => {
    const verified = [
      // An earlier app's backend whose app is gone (listOrphans proved parent gone + identity).
      { command: 'hermes serve', nonce: 'n1', parentPid: 1, pid: 4001, profile: 'default', startMarker: 's1' },
      // A backend of THIS app run: never a candidate.
      { nonce: 'n2', parentPid: 777, pid: 4002, profile: 'other', startMarker: 's2' }
    ]

    expect(ownOrphanCandidates(verified, 777, null)).toEqual([{ command: 'hermes serve', pid: 4001 }])
    expect(ownOrphanCandidates(verified, 1, null)).toEqual([{ pid: 4002 }])
    expect(ownOrphanCandidates(verified, 777, 4001)).toEqual([])
    expect(ownOrphanCandidates([], 777, null)).toEqual([])
  })
})

describe('the manifest store', () => {
  it('undo refuses an id that is not a manifest of the kit (no path walking)', async () => {
    const kit = createRepairKit(fx.deps)

    expect((await kit.undo('../../etc')).refused).toBe('unknown-manifest')
    expect((await kit.undo('20261114-093300-000-nope')).refused).toBe('unknown-manifest')
  })
})

// v0.0.9 W1b — the stale-install class resolves the ACTIVE agent's homes, never assumes `~/.hermes`. The runtime
// adopts a selection from the dependency root of the HERMES_HOME it runs with AND from the platform default
// `~/.hermes` (main/runtime-install-state.ts); the kit looks in exactly those and moves each record beside its own
// `installs` folder. Red on the old code: it only ever looked at `<root HERMES_HOME>/installs/<key>`.
describe('stale-install-record under the active profile’s homes (W1b)', () => {
  function plantAt(home: string): string {
    const record = path.join(home, 'installs', runtimeInstallKey(fx.runtimeRoot)!)

    fs.mkdirSync(path.join(record, 'environments'), { recursive: true })
    fs.writeFileSync(path.join(record, 'facts.json'), '{"extras":["stt-whisper"]}')

    return record
  }

  it('a custom HERMES_HOME: a record under the platform default ~/.hermes is found and moved aside THERE', async () => {
    const custom = path.join(fx.root, 'custom-hermes')

    fs.mkdirSync(custom, { recursive: true })

    const defaultRecord = plantAt(fx.hermesHome) // `<home>/.hermes` is the platform default here
    const deps: RepairKitDeps = { ...fx.deps, hermesHome: custom, home: fx.home }
    const report = await createRepairKit(deps).apply('stale-install-record', { dryRun: false })
    const key = path.basename(defaultRecord)

    expect(report.before.status).toBe('found')
    expect(fs.existsSync(defaultRecord)).toBe(false)
    expect(fs.existsSync(path.join(fx.hermesHome, `installs-aside-${asideDate(NOW)}`, key, 'facts.json'))).toBe(true)
    expect(fs.existsSync(path.join(custom, `installs-aside-${asideDate(NOW)}`))).toBe(false)
    expect((await createRepairKit(deps).detect('stale-install-record')).finding.status).toBe('ok')
  })

  it('a --profile agent under a custom root: its dependency root (the root) is where the record is read and moved', async () => {
    const custom = path.join(fx.root, 'custom-hermes')
    const work = path.join(custom, 'profiles', 'work')

    fs.mkdirSync(work, { recursive: true })

    const record = plantAt(custom)
    // A record inside the profile folder is not one the runtime reads for the profile: it must stay.
    const notRead = plantAt(work)
    const deps: RepairKitDeps = { ...fx.deps, hermesHome: custom, home: fx.home, activeHermesHome: () => work }
    const plan = await createRepairKit(deps).apply('stale-install-record', { dryRun: true })

    expect(plan.steps).toEqual([
      {
        from: record,
        kind: 'move-aside',
        to: path.join(custom, `installs-aside-${asideDate(NOW)}`, path.basename(record))
      }
    ])

    await createRepairKit(deps).apply('stale-install-record', { dryRun: false })
    expect(fs.existsSync(record)).toBe(false)
    expect(fs.existsSync(path.join(notRead, 'facts.json'))).toBe(true)
  })

  it('records in both homes: both moved, each beside its own installs folder; undo restores both', async () => {
    const custom = path.join(fx.root, 'custom-hermes')

    fs.mkdirSync(custom, { recursive: true })

    const inCustom = plantAt(custom)
    const inDefault = plantAt(fx.hermesHome)
    const kit = createRepairKit({ ...fx.deps, hermesHome: custom, home: fx.home })
    const report = await kit.apply('stale-install-record', { dryRun: false })

    expect(report.applied).toHaveLength(2)
    expect(fs.existsSync(inCustom)).toBe(false)
    expect(fs.existsSync(inDefault)).toBe(false)

    expect((await kit.undo(report.manifestId!)).ok).toBe(true)
    expect(fs.existsSync(path.join(inCustom, 'facts.json'))).toBe(true)
    expect(fs.existsSync(path.join(inDefault, 'facts.json'))).toBe(true)
  })
})

describe('v0.0.9 Q — a failed step rolls back honestly (correctness 8)', () => {
  const BLOCK = 'plugins:\n  disabled:\n  - iclone-permissions\n'

  function twoConfigs() {
    const main = path.join(fx.hermesHome, 'config.yaml')
    const profile = path.join(fx.hermesHome, 'profiles', 'work', 'config.yaml')

    fs.writeFileSync(main, BLOCK)
    fs.mkdirSync(path.dirname(profile), { recursive: true })
    fs.writeFileSync(profile, BLOCK)

    return { main, profile }
  }

  it('a clean rollback reports nothing applied and records the run as undone', async () => {
    const { main, profile } = twoConfigs()

    // Between detection and the edits, something rewrites the profile's config: step 2 refuses, step 1 is put back.
    const kit = createRepairKit({ ...fx.deps, stopAgent: async () => fs.writeFileSync(profile, `${BLOCK}x: 1\n`) })
    const report = await kit.apply('plugins-disabled', { dryRun: false })

    expect(report).toMatchObject({ ok: false, rolledBack: true, applied: [], manifestId: null })
    expect(report.error).toMatch(/were put back/)
    expect(fs.readFileSync(main, 'utf8')).toBe(BLOCK)
    expect(kit.history()[0]).toMatchObject({ undoable: false })
  })

  it('a step that cannot be put back stays in the report and the manifest, and Undo is still offered', async () => {
    const { main, profile } = twoConfigs()
    const owner = 'plugins:\n  disabled: []\nmine: 2\n'

    const kit = createRepairKit({
      ...fx.deps,
      // The owner edits the first file right after the kit did: its put-back must refuse (his edit wins).
      log: line => {
        if (line.includes(`${main}: removed`)) {
          fs.writeFileSync(main, owner)
        }
      },
      stopAgent: async () => fs.writeFileSync(profile, `${BLOCK}x: 1\n`)
    })

    const report = await kit.apply('plugins-disabled', { dryRun: false })

    expect(report).toMatchObject({ ok: false, rolledBack: true })
    expect(report.applied.map(applied => (applied.step as { file: string }).file)).toEqual([main])
    expect(report.error).toMatch(/could not be put back/)
    expect(report.manifestId).not.toBeNull()
    expect(fs.readFileSync(main, 'utf8')).toBe(owner)

    const entry = kit.history()[0]

    expect(entry).toMatchObject({ undoable: true, undoneAt: null })
  })

  it('the IPC clears no latch after a rolled-back run', async () => {
    const { profile } = twoConfigs()
    const { registerRepairKitIpc } = await import('./ipc')
    const handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
    const afterChange = vi.fn()

    registerRepairKitIpc({
      afterChange,
      handle: (channel, handler) => handlers.set(channel, handler as never),
      isTrustedSender: () => true,
      kit: createRepairKit({ ...fx.deps, stopAgent: async () => fs.writeFileSync(profile, `${BLOCK}x: 1\n`) }),
      lastInputAt: () => 1_000,
      now: () => 1_100
    })

    const report = (await handlers.get('iclone:repair-kit:apply')!(
      {},
      { classId: 'plugins-disabled', dryRun: false, gesture: { activation: true, confirm: true } }
    )) as { ok: boolean; rolledBack?: boolean }

    expect(report).toMatchObject({ ok: false, rolledBack: true })
    expect(afterChange).not.toHaveBeenCalled()
  })
})

describe('v0.0.9 Q — steps never touch anything outside the homes (tests-perf 6)', () => {
  it('undo of a tampered manifest naming a path outside the homes touches nothing', async () => {
    const outside = path.join(fx.root, 'outside')
    const victim = path.join(outside, 'victim')
    const aside = path.join(fx.hermesHome, 'installs-aside-x', 'victim')

    fs.mkdirSync(outside, { recursive: true })
    fs.mkdirSync(path.dirname(aside), { recursive: true })
    fs.writeFileSync(aside, 'planted')
    fs.writeFileSync(path.join(outside, 'mode'), 'x')
    fs.chmodSync(path.join(outside, 'mode'), 0o600)

    const id = '20261114-093300-000-stale-install-record'
    const dir = path.join(fx.userData, 'diagnostics', 'repair-kit', id)

    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        applied: [
          { detail: 'move', ok: true, step: { from: victim, kind: 'move-aside', to: aside } },
          {
            detail: 'chmod',
            ok: true,
            step: { fromMode: 0o777, kind: 'chmod', path: path.join(outside, 'mode'), toMode: 0o600 }
          }
        ],
        classId: 'stale-install-record',
        createdAt: NOW.toISOString(),
        id,
        schema: 1,
        undoneAt: null
      })
    )

    const report = await createRepairKit(fx.deps).undo(id)

    expect(report.restored).toEqual([])
    expect(report.skipped.map(item => item.reason)).toEqual(['outside-home', 'outside-home'])
    expect(fs.existsSync(victim)).toBe(false)
    expect(fs.readFileSync(aside, 'utf8')).toBe('planted')
    expect(fs.statSync(path.join(outside, 'mode')).mode & 0o777).toBe(0o600)
  })

  it('a linked installs folder: the stale record behind the link is never moved out of its target', async () => {
    const key = runtimeInstallKey(fx.runtimeRoot)!
    const target = path.join(fx.root, 'elsewhere')
    const record = path.join(target, key)

    fs.mkdirSync(record, { recursive: true })
    fs.writeFileSync(path.join(record, 'facts.json'), '{}')
    fs.symlinkSync(target, path.join(fx.hermesHome, 'installs'))

    const report = await createRepairKit(fx.deps).apply('stale-install-record', { dryRun: false })

    expect(report.ok).toBe(false)
    expect(report.applied).toEqual([])
    expect(fs.existsSync(path.join(record, 'facts.json'))).toBe(true)
  })
})

describe('v0.0.9 r3 (eng n4) — every real apply and undo, and every refused one, writes one audit line', () => {
  const BLOCK = 'plugins:\n  disabled:\n  - iclone-permissions\n'

  it('apply → use line (class, manifest, steps); undo → use line; no click → refuse line, no files touched', async () => {
    const main = path.join(fx.hermesHome, 'config.yaml')
    fs.writeFileSync(main, BLOCK)
    const { registerRepairKitIpc } = await import('./ipc')
    const handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
    const audit = vi.fn((_entry: unknown) => ({ id: 'r' }))
    let inputAt = 1_000

    registerRepairKitIpc({
      afterChange: vi.fn(),
      audit,
      handle: (channel, handler) => handlers.set(channel, handler as never),
      isTrustedSender: () => true,
      kit: createRepairKit(fx.deps),
      lastInputAt: () => inputAt,
      now: () => 1_100
    })

    const click = { gesture: { activation: true, confirm: true } }

    // Refused: no recent trusted input → one refuse line, the file untouched.
    inputAt = -1_000_000
    await handlers.get('iclone:repair-kit:apply')!({}, { classId: 'plugins-disabled', dryRun: false, ...click })
    expect(audit).toHaveBeenLastCalledWith({
      gesture: false,
      kind: 'refuse',
      reason: "plugins-disabled: without the owner's click",
      tool: 'repair-kit.apply'
    })
    expect(fs.readFileSync(main, 'utf8')).toBe(BLOCK)

    inputAt = 1_000

    const report = (await handlers.get('iclone:repair-kit:apply')!(
      {},
      { classId: 'plugins-disabled', dryRun: false, ...click }
    )) as { manifestId: string; ok: boolean }

    expect(report.ok).toBe(true)
    expect(audit).toHaveBeenLastCalledWith({
      gesture: true,
      kind: 'use',
      reason: `plugins-disabled: ok; manifest ${report.manifestId}; steps 1 [edit-config]`,
      tool: 'repair-kit.apply'
    })

    await handlers.get('iclone:repair-kit:undo')!({}, { manifestId: report.manifestId, ...click })
    expect(audit).toHaveBeenLastCalledWith({
      gesture: true,
      kind: 'use',
      reason: `undo ${report.manifestId}: ok; restored 1; skipped 0`,
      tool: 'repair-kit.undo'
    })

    // A dry run changes nothing: no line.
    await handlers.get('iclone:repair-kit:apply')!({}, { classId: 'plugins-disabled', dryRun: true })
    expect(audit).toHaveBeenCalledTimes(3)
  })
})
