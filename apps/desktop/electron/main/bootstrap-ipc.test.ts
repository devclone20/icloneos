import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { decideBootstrapRepair } from '../bootstrap-repair-guard'
import { beginInstallBudget, installBudgetDeadline } from '../install-liveness'
import { asideDate, runtimeInstallKey } from '../repair-kit/kit'

import { registerBootstrapIpc } from './bootstrap-ipc'

type Handler = (...args: unknown[]) => Promise<unknown>

// v0.0.9 F3: a throwaway HOME for the repair kit the IPC now builds (never the real one).
const tmp = vi.hoisted(() => ({
  root: '',
  get hermesHome() {
    return path.join(this.root, 'home', '.hermes')
  },
  get userData() {
    return path.join(this.root, 'userData')
  },
  get runtimeRoot() {
    return path.join(this.userData, 'hermes-runtime', 'sha-under-test')
  },
  get privateHermesHome() {
    return path.join(this.runtimeRoot, '.iclone-deps', 'hermes')
  }
}))

tmp.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bipc-')))

afterAll(() => fs.rmSync(tmp.root, { force: true, recursive: true }))

const CLICK = { gesture: { activation: true, confirm: true } }

const mocks = vi.hoisted(() => ({
  agentRuntime: {
    clearAgentInstallSkip: vi.fn(),
    getAgentRuntimeStatus: vi.fn(() => ({ state: 'incomplete' })),
    openAgentRuntimeFix: vi.fn(async () => ({ ok: true })),
    skipAgentInstall: vi.fn()
  },
  continueFirstRunLocalBootstrap: vi.fn(),
  gate: { resetForOwnerReinstall: vi.fn(), resetForRepair: vi.fn(), resetForRetry: vi.fn() },
  handlers: new Map<string, Handler>(),
  resetBootstrapSnapshot: vi.fn(),
  resetHermesConnection: vi.fn(),
  teardownPrimaryBackendAndWait: vi.fn(async () => undefined),
  trustedSender: true,
  /** How old the last real input main saw is (tests-perf 11: the third gesture fact, exercised negatively). */
  inputAgeMs: 0
}))

vi.mock('electron', () => ({
  app: { getPath: () => tmp.userData, getVersion: () => '0.0.9-test' },
  ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) }
}))
vi.mock('./env', () => ({
  get ACTIVE_HERMES_ROOT() {
    return tmp.runtimeRoot
  },
  DEV_SERVER: null,
  get HERMES_HOME() {
    return tmp.hermesHome
  },
  runtimePrivateDependencies: () => ({ hermesHome: tmp.privateHermesHome, home: path.join(tmp.root, 'deps-home') })
}))
vi.mock('./paths', () => ({
  get DESKTOP_BACKEND_OWNERSHIP_PATH() {
    return path.join(tmp.userData, 'backend-ownership.json')
  }
}))
vi.mock('./runtime', () => ({ resolveRendererIndex: () => '/app/index.html' }))
vi.mock('./agent-update', () => ({ lastTrustedInputAt: () => Date.now() - mocks.inputAgeMs }))
vi.mock('./backend-ownership', () => ({
  backendOwnership: { listOrphans: async () => [], reapOrphans: async () => [] }
}))
vi.mock('../ipc-sender-guard', () => ({ createAppSenderGuard: () => () => mocks.trustedSender }))
vi.mock('./backend', () => ({
  resetHermesConnection: mocks.resetHermesConnection,
  teardownPrimaryBackendAndWait: mocks.teardownPrimaryBackendAndWait
}))
vi.mock('./backend-state', () => ({ MAX_BOOTSTRAP_REPAIR_SOFT_ATTEMPTS: 3 }))
vi.mock('./agent-runtime-status', () => mocks.agentRuntime)
vi.mock('./boot-progress', () => ({
  continueFirstRunLocalBootstrap: mocks.continueFirstRunLocalBootstrap,
  getBootstrapState: () => ({ phase: 'probe' }),
  getFirstRunSetupGate: () => mocks.gate,
  resetBootstrapSnapshot: mocks.resetBootstrapSnapshot
}))
vi.mock('./log', () => ({ rememberLog: () => undefined }))

function makeDeps(process: unknown = null) {
  return {
    backendConnectionState: { getProcess: () => process },
    bootState: {
      backendStartFailure: 'start failed',
      bootstrapAbortController: null as AbortController | null,
      bootstrapFailure: 'bootstrap failed',
      bootstrapRepairAttempt: 0,
      bootstrapRepairRequested: false,
      remoteReauthFailure: 'reauth failed'
    },
    progressState: { bootProgressState: { phase: 'running', progress: 42 } }
  }
}

function register(deps: ReturnType<typeof makeDeps>) {
  registerBootstrapIpc(deps as unknown as Parameters<typeof registerBootstrapIpc>[0])
}

function invoke(channel: string, ...args: unknown[]) {
  const handler = mocks.handlers.get(channel)

  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }

  return handler({}, ...args)
}

describe('registerBootstrapIpc', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    vi.clearAllMocks()
    mocks.trustedSender = true
  })

  it('security m1: Repair from a sender that is not the app renderer is refused and changes nothing', async () => {
    const deps = makeDeps()

    register(deps)
    mocks.trustedSender = false

    await expect(
      invoke('hermes:bootstrap:repair', { gesture: { activation: true, confirm: true } })
    ).resolves.toBeNull()
    expect(deps.bootState).toMatchObject({
      backendStartFailure: 'start failed',
      bootstrapFailure: 'bootstrap failed',
      bootstrapRepairAttempt: 0,
      bootstrapRepairRequested: false
    })
    expect(mocks.resetHermesConnection).not.toHaveBeenCalled()
    expect(mocks.gate.resetForRepair).not.toHaveBeenCalled()
  })

  it('F3 rerun (major): a scripted Repair with no click restarts nothing, counts nothing, never escalates', async () => {
    const deps = makeDeps({ exitCode: 1, signalCode: null })

    ;(deps.bootState as Record<string, unknown>).backendStartFailure = new Error('Hermes backend exited (1)')
    register(deps)

    for (const input of [undefined, {}, { gesture: { activation: true, confirm: false } }]) {
      for (let i = 0; i < 5; i += 1) {
        await expect(invoke('hermes:bootstrap:repair', input)).resolves.toMatchObject({ ok: false, refused: 'gesture' })
      }
    }

    expect(deps.bootState).toMatchObject({ bootstrapRepairAttempt: 0, bootstrapRepairRequested: false })
    expect(deps.bootState.backendStartFailure).toBeInstanceOf(Error)
    expect(mocks.resetHermesConnection).not.toHaveBeenCalled()
    expect(mocks.gate.resetForRepair).not.toHaveBeenCalled()
  })

  it('F3 rerun: the click proof with stale input is refused too', async () => {
    const deps = makeDeps()

    register(deps)
    mocks.inputAgeMs = 60_000

    await expect(invoke('hermes:bootstrap:repair', CLICK)).resolves.toMatchObject({ refused: 'gesture' })
    expect(mocks.resetHermesConnection).not.toHaveBeenCalled()
    mocks.inputAgeMs = 0
  })

  it('F3 rerun: Install again (a reinstall) needs the click and the app sender; Retry needs the app sender', async () => {
    const deps = makeDeps()

    register(deps)

    await expect(invoke('hermes:agent-runtime:install-again')).resolves.toEqual({ ok: false, refused: 'gesture' })
    expect(mocks.agentRuntime.clearAgentInstallSkip).not.toHaveBeenCalled()
    expect(mocks.teardownPrimaryBackendAndWait).not.toHaveBeenCalled()

    mocks.trustedSender = false
    await expect(invoke('hermes:agent-runtime:install-again', CLICK)).resolves.toBeNull()
    await expect(invoke('hermes:bootstrap:reset')).resolves.toBeNull()
    expect(mocks.teardownPrimaryBackendAndWait).not.toHaveBeenCalled()
    expect(deps.bootState.bootstrapFailure).toBe('bootstrap failed')
  })

  it('critic m6: continue-local starts the network install only on the owner click from the app window', async () => {
    register(makeDeps())

    await expect(invoke('hermes:bootstrap:continue-local')).resolves.toEqual({ ok: false, refused: 'gesture' })
    expect(mocks.continueFirstRunLocalBootstrap).not.toHaveBeenCalled()

    mocks.inputAgeMs = 60_000
    await expect(invoke('hermes:bootstrap:continue-local', CLICK)).resolves.toEqual({ ok: false, refused: 'gesture' })
    mocks.inputAgeMs = 0
    expect(mocks.continueFirstRunLocalBootstrap).not.toHaveBeenCalled()

    mocks.trustedSender = false
    await expect(invoke('hermes:bootstrap:continue-local', CLICK)).resolves.toBeNull()
    expect(mocks.continueFirstRunLocalBootstrap).not.toHaveBeenCalled()

    mocks.trustedSender = true
    await expect(invoke('hermes:bootstrap:continue-local', CLICK)).resolves.toEqual({ ok: true })
    expect(mocks.continueFirstRunLocalBootstrap).toHaveBeenCalledTimes(1)
  })

  it('critic m6: cancel, skip and open-fix answer the app window only (no click needed)', async () => {
    const deps = makeDeps()
    const controller = new AbortController()

    deps.bootState.bootstrapAbortController = controller
    register(deps)
    mocks.trustedSender = false

    await expect(invoke('hermes:bootstrap:cancel')).resolves.toBeNull()
    expect(controller.signal.aborted).toBe(false)
    deps.bootState.bootstrapAbortController = null
    await expect(invoke('hermes:agent-runtime:skip')).resolves.toBeNull()
    expect(mocks.agentRuntime.skipAgentInstall).not.toHaveBeenCalled()
    await expect(invoke('hermes:agent-runtime:open-fix', 'reveal-folder')).resolves.toBeNull()
    expect(mocks.agentRuntime.openAgentRuntimeFix).not.toHaveBeenCalled()

    mocks.trustedSender = true
    deps.bootState.bootstrapAbortController = controller
    await expect(invoke('hermes:bootstrap:cancel')).resolves.toEqual({ cancelled: true, ok: true })
    expect(controller.signal.aborted).toBe(true)
  })

  it('registers the bootstrap channels and nothing else', () => {
    register(makeDeps())

    expect([...mocks.handlers.keys()].sort()).toEqual([
      'hermes:agent-runtime:get',
      'hermes:agent-runtime:install-again',
      'hermes:agent-runtime:open-fix',
      'hermes:agent-runtime:skip',
      'hermes:boot-progress:get',
      'hermes:bootstrap:cancel',
      'hermes:bootstrap:continue-local',
      'hermes:bootstrap:get',
      'hermes:bootstrap:repair',
      'hermes:bootstrap:reset',
      'iclone:repair-kit:apply',
      'iclone:repair-kit:history',
      'iclone:repair-kit:scan',
      'iclone:repair-kit:undo'
    ])
  })

  it('reset tears the primary backend down and clears the latched failures of the injected boot state', async () => {
    const deps = makeDeps()
    register(deps)

    await expect(invoke('hermes:bootstrap:reset')).resolves.toEqual({ ok: true })

    expect(mocks.teardownPrimaryBackendAndWait).toHaveBeenCalledOnce()
    expect(deps.bootState).toMatchObject({
      backendStartFailure: null,
      bootstrapFailure: null,
      remoteReauthFailure: null
    })
    expect(mocks.gate.resetForRetry).toHaveBeenCalledOnce()
    expect(mocks.resetBootstrapSnapshot).toHaveBeenCalledOnce()
  })

  it('repair counts the attempt and follows the repair guard for the live primary backend', async () => {
    const deps = makeDeps({ exitCode: null, signalCode: null })
    register(deps)

    await invoke('hermes:bootstrap:repair', CLICK)

    const expected = decideBootstrapRepair({ attempt: 1, maxSoftAttempts: 3, primaryBackendAlive: true })
    expect(deps.bootState.bootstrapRepairAttempt).toBe(1)
    expect(deps.bootState.bootstrapRepairRequested).toBe(expected.hardReinstall)
    expect(deps.bootState.bootstrapFailure).toBeNull()
    expect(mocks.gate.resetForRepair).toHaveBeenCalledOnce()
    expect(mocks.resetHermesConnection).toHaveBeenCalledOnce()
  })

  it('V3-S r2 m1: after a permission-gate refusal the first Repair already reinstalls (no soft-restart loop)', async () => {
    const deps = makeDeps({ exitCode: 1, signalCode: null })

    ;(deps.bootState as Record<string, unknown>).backendStartFailure = new Error(
      '[iclone-gate] The icloneOS permission gate is not in place, so the agent was not started: not one icloneOS installed'
    )
    register(deps)

    await invoke('hermes:bootstrap:repair', CLICK)

    expect(decideBootstrapRepair({ attempt: 1, maxSoftAttempts: 3, primaryBackendAlive: false }).hardReinstall).toBe(
      false
    )
    expect(deps.bootState.bootstrapRepairRequested).toBe(true)
    expect(deps.bootState.backendStartFailure).toBeNull()
  })

  it('m-r2-2: a broken install of the app runtime: Repair (owner click) routes to the kit runtime-venv and reinstalls with no chooser', async () => {
    const deps = makeDeps({ exitCode: 1, signalCode: null })

    ;(deps.bootState as Record<string, unknown>).backendStartFailure = Object.assign(
      new Error(
        "The agent's environment is broken: the agent's Python interpreter /r/venv/bin/python points at a file that is gone."
      ),
      { bootCause: { code: 'runtime-env-broken' } }
    )
    register(deps)

    const answer = (await invoke('hermes:bootstrap:repair', CLICK)) as {
      cause: string
      kit: { classId: string } | null
    }

    expect(answer.cause).toBe('runtime-env-broken')
    expect(answer.kit?.classId).toBe('runtime-venv')
    expect(deps.bootState.bootstrapRepairRequested).toBe(true)
    // The owner's Repair click is the choice: the next start reinstalls without the first-run chooser.
    expect(mocks.gate.resetForOwnerReinstall).toHaveBeenCalledOnce()
    expect(mocks.gate.resetForRepair).not.toHaveBeenCalled()
  })

  it('m-r2-2: a scripted Repair of that broken install changes nothing (no reinstall, no confirmed choice)', async () => {
    const deps = makeDeps({ exitCode: 1, signalCode: null })

    ;(deps.bootState as Record<string, unknown>).backendStartFailure = Object.assign(new Error('broken'), {
      bootCause: { code: 'runtime-env-broken' }
    })
    register(deps)

    await invoke('hermes:bootstrap:repair', {})

    expect(deps.bootState.bootstrapRepairRequested).toBe(false)
    expect(mocks.gate.resetForOwnerReinstall).not.toHaveBeenCalled()
  })

  it('any other latched failure still follows the soft-restart budget', async () => {
    const deps = makeDeps({ exitCode: 1, signalCode: null })

    ;(deps.bootState as Record<string, unknown>).backendStartFailure = new Error('Hermes backend exited (1)')
    register(deps)

    await invoke('hermes:bootstrap:repair', CLICK)

    expect(deps.bootState.bootstrapRepairRequested).toBe(false)
  })

  it('cancel aborts the running install only when one is in flight', async () => {
    const deps = makeDeps()
    register(deps)

    await expect(invoke('hermes:bootstrap:cancel')).resolves.toEqual({ cancelled: false, ok: false })

    const controller = new AbortController()
    deps.bootState.bootstrapAbortController = controller

    await expect(invoke('hermes:bootstrap:cancel')).resolves.toEqual({ cancelled: true, ok: true })
    expect(controller.signal.aborted).toBe(true)
  })

  it('serves boot progress from the injected progress holder', async () => {
    const deps = makeDeps()
    register(deps)

    await expect(invoke('hermes:boot-progress:get')).resolves.toBe(deps.progressState.bootProgressState)
    deps.progressState.bootProgressState = { phase: 'ready', progress: 100 }
    await expect(invoke('hermes:boot-progress:get')).resolves.toBe(deps.progressState.bootProgressState)
  })

  it('RTB-6 skip: refused while an install runs; otherwise recorded and the install failure no longer latched', async () => {
    const running = makeDeps()
    running.bootState.bootstrapAbortController = new AbortController()
    register(running)
    await expect(invoke('hermes:agent-runtime:skip')).resolves.toEqual({ ok: false, reason: 'install-running' })
    expect(mocks.agentRuntime.skipAgentInstall).not.toHaveBeenCalled()

    mocks.handlers.clear()
    const failed = makeDeps()
    register(failed)
    await expect(invoke('hermes:agent-runtime:skip')).resolves.toEqual({ ok: true })
    expect(mocks.agentRuntime.skipAgentInstall).toHaveBeenCalledOnce()
    expect(failed.bootState.bootstrapFailure).toBeNull()
  })

  it('RTB-6 install again: clears the skip and every latch so the reloaded boot resumes the install', async () => {
    const deps = makeDeps()
    register(deps)
    await expect(invoke('hermes:agent-runtime:install-again', CLICK)).resolves.toEqual({ ok: true })
    expect(mocks.agentRuntime.clearAgentInstallSkip).toHaveBeenCalledOnce()
    expect(mocks.teardownPrimaryBackendAndWait).toHaveBeenCalledOnce()
    expect(deps.bootState).toMatchObject({
      backendStartFailure: null,
      bootstrapFailure: null,
      remoteReauthFailure: null
    })
  })

  it('RTB-6 open-fix passes the named fix through (main decides what it opens)', async () => {
    register(makeDeps())
    await invoke('hermes:agent-runtime:open-fix', 'open-storage-settings')
    expect(mocks.agentRuntime.openAgentRuntimeFix).toHaveBeenCalledWith('open-storage-settings')
  })

  it.each(['hermes:bootstrap:reset', 'hermes:bootstrap:repair', 'hermes:agent-runtime:install-again'])(
    'r2b (critic X1/X17): %s gives the next install a FRESH first-launch budget',
    async channel => {
      register(makeDeps())
      beginInstallBudget(Date.now() - 14 * 60_000)
      expect(installBudgetDeadline()).not.toBeNull()
      await invoke(channel, CLICK)
      expect(installBudgetDeadline()).toBeNull()
      const fresh = beginInstallBudget()
      expect(fresh - Date.now()).toBeGreaterThan(14 * 60_000)
    }
  )
})

// v0.0.9 F3 — the 14 Nov 2026 failure, end to end through the Repair IPC.
describe('Repair install routes by cause (v0.0.9 F3)', () => {
  const OWNER_CLICK = { gesture: { activation: true, confirm: true } }
  const ENV = 'd2a0574ad8364ad4a87cee896f2a3bea'

  /** The exact state found on the owner's Mac: a 12 Nov record of THIS runtime under ~/.hermes/installs. */
  function plantStaleRecord(): { record: string; key: string } {
    fs.mkdirSync(tmp.runtimeRoot, { recursive: true })
    const key = runtimeInstallKey(tmp.runtimeRoot)!
    const record = path.join(tmp.hermesHome, 'installs', key)
    const venv = path.join(record, 'environments', ENV, 'venv')

    fs.mkdirSync(venv, { recursive: true })
    fs.writeFileSync(
      path.join(record, 'facts.json'),
      JSON.stringify({ extras: ['all', 'stt-whisper'], packages: { venv: { environment: venv } } })
    )

    return { key, record }
  }

  /** What main latched on 14 Nov: the error's own sentence, then the app log with the gate's SUCCESS line in it. */
  function fourteenNovFailure(record: string): Error {
    return new Error(
      `Hermes backend exited before it became ready (1). Log: /Users/x/.hermes/logs/desktop.log\n` +
        `[iclone-gate] iclone-confinement: verified\n` +
        `[iclone-gate] loaded by Hermes at /runtime: iclone-permissions, iclone-consent, iclone-confinement (1134 ms)\n` +
        `hermes: install state is not writable by this user (${record}/environments/${ENV}/.leases/abc); ` +
        `run as the install owner or grant write access\n` +
        `Hermes backend exited (1)`
    )
  }

  beforeEach(() => {
    mocks.handlers.clear()
    vi.clearAllMocks()
    fs.rmSync(path.join(tmp.root, 'home'), { force: true, recursive: true })
    fs.rmSync(tmp.userData, { force: true, recursive: true })
    mocks.inputAgeMs = 0
    mocks.trustedSender = true
  })

  it('tests-perf 11: the click proof with real input a minute old moves nothing (Repair and the kit IPC)', async () => {
    const { record } = plantStaleRecord()

    const deps = makeDeps({ exitCode: 1, signalCode: null })

    ;(deps.bootState as Record<string, unknown>).backendStartFailure = fourteenNovFailure(record)
    register(deps)
    mocks.inputAgeMs = 60_000

    const kit = (await invoke('iclone:repair-kit:apply', {
      classId: 'stale-install-record',
      dryRun: false,
      ...OWNER_CLICK
    })) as { refused?: string }

    expect(kit.refused).toBe('gesture')

    const repair = (await invoke('hermes:bootstrap:repair', OWNER_CLICK)) as { kit: { refused: null | string } }

    expect(repair.kit.refused).toBe('gesture')
    expect(fs.existsSync(path.join(record, 'facts.json'))).toBe(true)
  })

  it('on the owner click: the stale record is moved aside (dated, not deleted), and no futile reinstall is forced', async () => {
    const { key, record } = plantStaleRecord()

    const deps = makeDeps({ exitCode: 1, signalCode: null })

    ;(deps.bootState as Record<string, unknown>).backendStartFailure = fourteenNovFailure(record)
    register(deps)

    const result = (await invoke('hermes:bootstrap:repair', OWNER_CLICK)) as {
      cause: string
      kit: { applied: number; classId: string; refused: null | string }
    }

    const aside = path.join(tmp.hermesHome, `installs-aside-${asideDate(new Date())}`, key)
    expect(result.cause).toBe('install-state-not-writable')
    expect(result.kit).toMatchObject({ applied: 1, classId: 'stale-install-record', refused: null })
    expect(fs.existsSync(record)).toBe(false)
    expect(fs.existsSync(path.join(aside, 'facts.json'))).toBe(true)
    // Before F3 the gate substring forced the installer here (and it could not help).
    expect(deps.bootState.bootstrapRepairRequested).toBe(false)
    expect(deps.bootState.backendStartFailure).toBeNull()
  })

  it('without the owner click nothing is moved, and it is still not treated as a gate refusal', async () => {
    const { record } = plantStaleRecord()

    const deps = makeDeps({ exitCode: 1, signalCode: null })

    ;(deps.bootState as Record<string, unknown>).backendStartFailure = fourteenNovFailure(record)
    register(deps)

    const result = (await invoke('hermes:bootstrap:repair')) as { kit: { refused: null | string }; refused: string }

    expect(result.refused).toBe('gesture')
    expect(result.kit.refused).toBe('gesture')
    expect(fs.existsSync(path.join(record, 'facts.json'))).toBe(true)
    expect(deps.bootState.bootstrapRepairRequested).toBe(false)
  })

  it('the kit IPC: a real repair needs the click; undo (also on a click) puts the record back exactly', async () => {
    const { key, record } = plantStaleRecord()

    const deps = makeDeps({ exitCode: 1, signalCode: null })

    ;(deps.bootState as Record<string, unknown>).backendStartFailure = fourteenNovFailure(record)
    register(deps)

    const refused = (await invoke('iclone:repair-kit:apply', { classId: 'stale-install-record', dryRun: false })) as {
      refused?: string
    }

    expect(refused.refused).toBe('gesture')
    expect(fs.existsSync(record)).toBe(true)

    const done = (await invoke('iclone:repair-kit:apply', {
      classId: 'stale-install-record',
      dryRun: false,
      ...OWNER_CLICK
    })) as { manifestId: string; ok: boolean; verify: string }

    expect(done).toMatchObject({ ok: true, verify: 'now' })
    expect(fs.existsSync(record)).toBe(false)
    expect(deps.bootState.backendStartFailure).toBeNull()

    expect(
      ((await invoke('iclone:repair-kit:undo', { manifestId: done.manifestId })) as { refused?: string }).refused
    ).toBe('gesture')

    const undone = (await invoke('iclone:repair-kit:undo', { manifestId: done.manifestId, ...OWNER_CLICK })) as {
      ok: boolean
    }

    expect(undone.ok).toBe(true)
    expect(fs.existsSync(path.join(tmp.hermesHome, 'installs', key, 'facts.json'))).toBe(true)
  })
})
