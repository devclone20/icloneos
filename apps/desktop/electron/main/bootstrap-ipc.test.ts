import { beforeEach, describe, expect, it, vi } from 'vitest'

import { decideBootstrapRepair } from '../bootstrap-repair-guard'
import { beginInstallBudget, installBudgetDeadline } from '../install-liveness'

import { registerBootstrapIpc } from './bootstrap-ipc'

type Handler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  agentRuntime: {
    clearAgentInstallSkip: vi.fn(),
    getAgentRuntimeStatus: vi.fn(() => ({ state: 'incomplete' })),
    openAgentRuntimeFix: vi.fn(async () => ({ ok: true })),
    skipAgentInstall: vi.fn()
  },
  continueFirstRunLocalBootstrap: vi.fn(),
  gate: { resetForRepair: vi.fn(), resetForRetry: vi.fn() },
  handlers: new Map<string, Handler>(),
  resetBootstrapSnapshot: vi.fn(),
  resetHermesConnection: vi.fn(),
  teardownPrimaryBackendAndWait: vi.fn(async () => undefined)
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) }
}))
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
      'hermes:bootstrap:reset'
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

    await invoke('hermes:bootstrap:repair')

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

    await invoke('hermes:bootstrap:repair')

    expect(decideBootstrapRepair({ attempt: 1, maxSoftAttempts: 3, primaryBackendAlive: false }).hardReinstall).toBe(
      false
    )
    expect(deps.bootState.bootstrapRepairRequested).toBe(true)
    expect(deps.bootState.backendStartFailure).toBeNull()
  })

  it('any other latched failure still follows the soft-restart budget', async () => {
    const deps = makeDeps({ exitCode: 1, signalCode: null })

    ;(deps.bootState as Record<string, unknown>).backendStartFailure = new Error('Hermes backend exited (1)')
    register(deps)

    await invoke('hermes:bootstrap:repair')

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
    await expect(invoke('hermes:agent-runtime:install-again')).resolves.toEqual({ ok: true })
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
      await invoke(channel)
      expect(installBudgetDeadline()).toBeNull()
      const fresh = beginInstallBudget()
      expect(fresh - Date.now()).toBeGreaterThan(14 * 60_000)
    }
  )
})
