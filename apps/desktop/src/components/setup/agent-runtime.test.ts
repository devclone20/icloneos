// V3-ON r2 — the Packages stub implements V3-RT-B's `window.hermesDesktop.agentRuntime` EXACTLY (lead, r2): the shapes
// below are copied from RT-B's branch (v3-rtb-boot-budget a3e8bbcb13: src/global.d.ts `agentRuntime?`,
// src/iclone-shared/agent-runtime-status.ts, install-packages.ts, install-diagnosis.ts). `tsc -p tsconfig.json` (gate
// O1) fails if our contract drifts from them by one name or one type, so the merge is a one-line swap.
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  type AgentRuntimeBridge,
  type AgentRuntimeStatus,
  type InstallDiagnosis,
  type PackageLine,
  packageRowsOf,
  setupAgentRuntime
} from './agent-runtime'

type RtbPackageState =
  'done' | 'downloading' | 'failed' | 'installing' | 'not-needed' | 'stopped' | 'unpacking' | 'verifying' | 'waiting'

interface RtbPackageLine {
  name: string
  state: RtbPackageState
  percent: null | number
  done: null | string
  total: null | string
  totalBytes: null | number
  parts: number
  startedAt: null | number
  finishedAt: null | number
  error: null | string
  optional: boolean
}

interface RtbInstallDiagnosis {
  class:
    | 'cancelled'
    | 'disk'
    | 'integrity'
    | 'interpreter'
    | 'killed'
    | 'network'
    | 'permission'
    | 'resolver'
    | 'stalled'
    | 'unknown'
  fix: 'open-network-settings' | 'open-storage-settings' | 'repair' | 'retry' | 'reveal-folder'
  stage: null | string
  packageName: null | string
  neededBytes: null | number
  evidence: null | string
}

interface RtbAgentRuntimeStatus {
  schema: 1
  state: 'incomplete' | 'installed' | 'installing' | 'not-installed'
  packages: RtbPackageLine[]
  diagnosis: RtbInstallDiagnosis | null
  skipCount: number
  skippedAt: null | number
  stageDurations: Record<string, number>
  updatedAt: number
}

interface RtbAgentRuntime {
  status: () => Promise<RtbAgentRuntimeStatus & { skippedThisRun: boolean }>
  skip: () => Promise<{ ok: boolean; reason?: string }>
  installAgain: () => Promise<{ ok: boolean }>
  openFix: (fix: 'open-network-settings' | 'open-storage-settings' | 'reveal-folder') => Promise<{ ok: boolean }>
  onChange: (callback: (status: RtbAgentRuntimeStatus) => void) => () => void
}

describe('the Packages source is RT-B’s agentRuntime, shape for shape', () => {
  it('type level: every name and type equal (tsc fails on drift)', () => {
    expectTypeOf<PackageLine>().toEqualTypeOf<RtbPackageLine>()
    expectTypeOf<InstallDiagnosis>().toEqualTypeOf<RtbInstallDiagnosis>()
    expectTypeOf<AgentRuntimeStatus>().toEqualTypeOf<RtbAgentRuntimeStatus>()
    expectTypeOf<AgentRuntimeBridge>().toEqualTypeOf<RtbAgentRuntime>()
  })

  it('not wired until both fronts merge (r2 minor 2): the source is null', () => {
    expect(setupAgentRuntime()).toBeNull()
  })
})

describe('packageRowsOf — RT-B status as the section rows', () => {
  const line = (name: string, state: RtbPackageState, over: Partial<RtbPackageLine> = {}): RtbPackageLine => ({
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

  const status = (packages: RtbPackageLine[], over: Partial<RtbAgentRuntimeStatus> = {}): RtbAgentRuntimeStatus => ({
    schema: 1,
    state: 'incomplete',
    packages,
    diagnosis: null,
    skipCount: 0,
    skippedAt: null,
    stageDurations: {},
    updatedAt: 1,
    ...over
  })

  it('done → installed, failed → failed, in flight → installing with its percent, not needed → hidden', () => {
    expect(
      packageRowsOf(
        status(
          [
            line('a', 'done', { totalBytes: 10 }),
            line('b', 'failed'),
            line('c', 'downloading', { percent: 42 }),
            line('d', 'not-needed')
          ],
          { state: 'installing' }
        )
      )
    ).toEqual([
      { id: 'a', name: 'a', bytes: 10, state: 'installed', progress: null },
      { id: 'b', name: 'b', bytes: null, state: 'failed', progress: null },
      { id: 'c', name: 'c', bytes: null, state: 'installing', progress: 42 }
    ])
  })

  it('after a skip, the lines that never finished read skipped (Install again is offered for them)', () => {
    const rows = packageRowsOf(status([line('a', 'done'), line('b', 'waiting')], { skippedAt: 5, skipCount: 1 }))

    expect(rows.map(row => [row.id, row.state])).toEqual([
      ['a', 'installed'],
      ['b', 'skipped']
    ])
  })

  it('no status or a malformed one: no rows', () => {
    expect(packageRowsOf(null)).toEqual([])
    expect(packageRowsOf({ packages: 'x' } as never)).toEqual([])
  })
})
