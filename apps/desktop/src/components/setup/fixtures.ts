import { vi } from 'vitest'

import {
  type FunctionLevels,
  PERMISSION_FUNCTIONS,
  type PermissionStateView,
  type SetFunctionLevelResultView
} from '@/iclone-shared/permissions'

import { accepted, bundledPolicy, fakeConsentBridge } from '../consent/fixtures'
import type { ConsentRecord, IclonePermissionsBridge } from '../consent/types'

import type { AgentRuntimeBridge, AgentRuntimeStatus, PackageLine } from './agent-runtime'
import type { IcloneSetupBridge, SetupChoice, SetupSection, SetupSystemRow } from './types'

/** Main's shipped state: every function at Follow mode over the standing Manual mode (every action asks). */
export const SHIPPED_LEVELS = Object.fromEntries(PERMISSION_FUNCTIONS.map(fn => [fn, 'mode'])) as FunctionLevels

export const permissionState = (functions: FunctionLevels = SHIPPED_LEVELS, sealed = true): PermissionStateView => ({
  sealed,
  unconfirmed: [],
  mode: { standing: 'manual', projects: {}, sessions: {}, updatedAt: '2026-10-22T00:00:00.000Z' },
  grants: [],
  functions,
  fnGrants: [],
  ceilings: {},
  chain: { ok: true, records: 0, gaps: 0 },
  integrity: [],
  project: null,
  enforcement: 'enforced'
})

export const SYSTEM_ROWS: SetupSystemRow[] = [
  { id: 'microphone', status: 'notDetermined', action: 'request' },
  // A fresh install: macOS says `denied` for screen before any attempt; main reports it as not set up (r2 M1).
  { id: 'screen', status: 'notSetUp', action: 'request', restartToApply: true },
  { id: 'notifications', status: 'unknown', action: 'request' }
]

const line = (name: string, state: PackageLine['state'], over: Partial<PackageLine> = {}): PackageLine => ({
  name,
  state,
  percent: null,
  done: null,
  total: null,
  totalBytes: null,
  parts: 1,
  startedAt: null,
  finishedAt: null,
  error: null,
  optional: true,
  ...over
})

/** RT-B's per-package lines after a first launch the user skipped part-way (one failed, one never started). */
export const PACKAGE_LINES: PackageLine[] = [
  line('agent-browser', 'done', { totalBytes: 202_375_168 }),
  line('cua-driver', 'failed', { totalBytes: 67_108_864, error: '✗ download failed' }),
  line('node', 'waiting'),
  line('ripgrep', 'not-needed')
]

/** What the section shows for PACKAGE_LINES (a not-needed line is not shown). */
export const PACKAGES = [
  { id: 'agent-browser', state: 'installed' },
  { id: 'cua-driver', state: 'failed' },
  { id: 'node', state: 'skipped' }
] as const

export const runtimeStatus = (packages: PackageLine[], skippedAt: null | number = 1): AgentRuntimeStatus => ({
  schema: 1,
  state: skippedAt === null ? 'installing' : 'incomplete',
  packages,
  diagnosis: null,
  skipCount: skippedAt === null ? 0 : 1,
  skippedAt,
  stageDurations: {},
  updatedAt: 1
})

/**
 * The RT-B bridge the tests wire in (setup.test.tsx mocks `setupAgentRuntime()` to read it). Null = production today:
 * RT-B is not wired, the Packages section does not exist.
 */
export const wiredRuntime: { current: AgentRuntimeBridge | null } = { current: null }

/** A fake RT-B `agentRuntime`, exactly its shape. */
export function fakeAgentRuntime(status: AgentRuntimeStatus): AgentRuntimeBridge & {
  installAgain: ReturnType<typeof vi.fn>
} {
  return {
    status: vi.fn(async () => ({ ...status, skippedThisRun: status.skippedAt !== null })),
    skip: vi.fn(async () => ({ ok: true })),
    installAgain: vi.fn(async () => ({ ok: true })),
    openFix: vi.fn(async () => ({ ok: true })),
    onChange: vi.fn(() => () => undefined)
  }
}

/**
 * A fake main for the Set up step: the consent bridge (with `setSetup` keeping decisions in the record), the setup
 * bridge (system rows), RT-B's agentRuntime (wired with PACKAGE_LINES by default; `packages: null` = not wired, as in
 * production until RT-B merges) and the V3-F permissions bridge (levels).
 */
export function fakeSetup(
  initial: ConsentRecord | null,
  over: { system?: SetupSystemRow[]; packages?: AgentRuntimeStatus | null; permissions?: boolean } = {}
) {
  const consent = fakeConsentBridge(initial)
  let rows = over.system ?? SYSTEM_ROWS
  // Default: wired (as after the RT-B merge) with PACKAGE_LINES; `packages: null` = production today, not wired.
  const status = over.packages === undefined ? runtimeStatus(PACKAGE_LINES) : over.packages
  const runtime = status ? fakeAgentRuntime(status) : null

  wiredRuntime.current = runtime

  let latest: ConsentRecord | null = null

  const setSetup = vi.fn(async ({ sections }: { sections: Partial<Record<SetupSection, SetupChoice>> }) => {
    const record = latest ?? consent.record() ?? accepted()
    const setup = { ...record.setup }

    for (const [section, state] of Object.entries(sections)) {
      setup[section as SetupSection] = { state: state as SetupChoice, at: '2026-10-22T10:00:00.000Z' }
    }

    const next = { ...record, setup }

    latest = next

    // The consent fixture's own record is read through its closure: route later reads to the new one.
    consent.bridge.get = vi.fn(async () => ({
      state: 'ok' as const,
      record: next,
      bundled: bundledPolicy,
      keychainEncrypted: false
    }))

    return { ok: true as const, record: next }
  })

  consent.bridge.setSetup = setSetup

  const setup: IcloneSetupBridge = {
    system: vi.fn(async () => rows),
    act: vi.fn(async ({ item }) => {
      rows = rows.map(row => (row.id === item ? { ...row, status: 'granted' as const, action: 'none' as const } : row))

      return rows
    })
  }

  const setFunctionLevel = vi.fn(async (): Promise<SetFunctionLevelResultView> => ({
    ok: true,
    fn: 'email',
    level: 'askAlways',
    raised: false
  }))

  const permissions: IclonePermissionsBridge = {
    setMode: vi.fn(),
    revoke: vi.fn(async () => true),
    setFunctionLevel,
    hermesApproval: vi.fn(),
    state: vi.fn(async () => permissionState()),
    tail: vi.fn(async () => []),
    onChanged: vi.fn(() => () => undefined)
  }

  if (over.permissions !== false) {
    consent.bridge.permissions = permissions
  }

  Object.assign(window, { hermesDesktop: { ...window.hermesDesktop, icloneSetup: setup } })

  return { ...consent, setSetup, setup, permissions, runtime }
}
