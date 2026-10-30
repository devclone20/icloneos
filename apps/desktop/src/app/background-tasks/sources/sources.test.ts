import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuditRecordView } from '@/iclone-shared/permissions'
import { $desktopActionTasks } from '@/store/activity'
import {
  $backgroundStatusBySession,
  $backgroundStopWatch,
  type ComposerStatusItem,
  resetBackgroundPollingGuard,
  resetSessionBackground
} from '@/store/composer-status'
import { $cronJobs } from '@/store/cron'
import { $gateway } from '@/store/gateway'
import { $subagentsBySession, type SubagentProgress } from '@/store/subagents'
import type { CronJob } from '@/types/hermes'

import { actionsSource } from './actions'
import { cronSource } from './cron'
import { $permissionAudit, foldPermissionRecords, permissionsSource } from './permissions'
import { processesSource } from './processes'
import { subagentsSource } from './subagents'

const proc = (id: string, patch: Partial<ComposerStatusItem> = {}): ComposerStatusItem => ({
  id,
  state: 'running',
  title: `sleep ${id}`,
  type: 'background',
  ...patch
})

const agent = (id: string, patch: Partial<SubagentProgress> = {}): SubagentProgress => ({
  filesRead: [],
  filesWritten: [],
  goal: `goal ${id}`,
  id,
  parentId: null,
  sessionId: `child-${id}`,
  startedAt: 1_000,
  status: 'running',
  stream: [],
  taskCount: 1,
  taskIndex: 0,
  updatedAt: 2_000,
  ...patch
})

const job = (id: string, state: string, patch: Partial<CronJob> = {}): CronJob => ({
  enabled: true,
  id,
  last_run_at: '2026-10-21T08:00:00Z',
  name: `job ${id}`,
  state,
  ...patch
})

const record = (
  seq: number,
  kind: string,
  sid: string | null,
  patch: Partial<AuditRecordView> = {}
): AuditRecordView => ({
  action: { project_root: null, target: `target-${seq}`, tool: 'terminal' },
  agent: { inft: null, session_id: sid },
  answer: null,
  class: 'X',
  kind,
  mode: 'manual',
  reason: null,
  scope: null,
  seq_main: seq,
  ts: new Date(1_000_000 + seq * 1_000).toISOString(),
  ...patch
})

afterEach(() => {
  $backgroundStatusBySession.set({})
  $backgroundStopWatch.set({})
  $desktopActionTasks.set({})
  resetBackgroundPollingGuard()
  $subagentsBySession.set({})
  $cronJobs.set([])
  $gateway.set(null)
  vi.unstubAllGlobals()
})

describe('processes source', () => {
  it('maps the registry: exit codes, a negative code as its signal, Stop real only while running', () => {
    $backgroundStatusBySession.set({
      rt1: [
        proc('p1', { output: 'line 1\nline 2\n\n' }),
        proc('p2', { exitCode: -9, state: 'failed' }),
        proc('p3', { exitCode: 3, state: 'failed' }),
        proc('p4', { state: 'done' })
      ]
    })

    const [p1, p2, p3, p4] = processesSource().snapshot()

    expect(p1).toMatchObject({ id: 'shell:rt1/p1', kind: 'shell', lastLine: 'line 2', startedAt: null, stop: 'real' })
    expect(p2).toMatchObject({ exit: { signal: 'SIGKILL' }, state: 'failed', stop: 'none' })
    expect(p3).toMatchObject({ exit: { code: 3 }, state: 'failed' })
    expect(p4).toMatchObject({ exit: { code: 0 }, state: 'done' })
  })

  it('stop sends process.kill for that session and process, then re-reads the registry twice', async () => {
    const request = vi.fn(() => Promise.resolve({ processes: [] }))
    const later: (() => void)[] = []

    $gateway.set({ request } as never)

    const result = await processesSource(fn => void later.push(fn)).stop('rt1/proc_9')

    expect(result).toEqual({ effect: 'killed', ok: true })
    expect(request).toHaveBeenCalledWith('process.kill', { process_id: 'proc_9', session_id: 'rt1' })
    expect(request).toHaveBeenCalledWith('process.list', { session_id: 'rt1' })
    expect(later).toHaveLength(1)
  })

  it('stop reports a refusal and a missing gateway as not ok', async () => {
    expect(await processesSource().stop('rt1/p')).toMatchObject({ ok: false })

    $gateway.set({ request: () => Promise.reject(new Error('no such process')) } as never)

    expect(await processesSource().stop('rt1/p')).toEqual({ detail: 'no such process', effect: 'killed', ok: false })
  })
})

describe('processes source — why a job left', () => {
  it('a rewound row is explained as "rewind"; an id nobody dismissed is unexplained (a death)', () => {
    $gateway.set({ request: () => Promise.resolve({}) } as never)
    $backgroundStatusBySession.set({ 'rw-1': [proc('p1')] })
    resetSessionBackground('rw-1')

    const source = processesSource()

    expect(source.endReason?.('rw-1/p1')).toBe('rewind')
    expect(source.endReason?.('rw-1/p2')).toBeNull()
    expect(source.endReason?.('malformed')).toBeNull()
  })
})

describe('desktop actions source', () => {
  const action = (name: string, running: boolean, exit_code: number | null, lines: string[] = []) => ({
    status: { exit_code, lines, name, pid: null, running },
    updatedAt: 5_000
  })

  it('lists every action the store keeps: running, done, failed with its exit; Stop honestly unsupported', async () => {
    $desktopActionTasks.set({
      a: action('hermes-update', true, null, ['fetching', 'building ']),
      b: action('toolset-install', false, 0),
      c: action('computer-use', false, 3, ['boom'])
    })

    const source = actionsSource()
    const [a, b, c] = source.snapshot()

    expect(a).toMatchObject({
      id: 'action:hermes-update',
      kind: 'action',
      lastLine: 'building',
      lastLineAt: 5_000,
      startedAt: null,
      state: 'running',
      stop: 'none'
    })
    expect(a).not.toHaveProperty('exit')
    expect(b).toMatchObject({ exit: { code: 0 }, lastLine: null, state: 'done' })
    expect(c).toMatchObject({ exit: { code: 3 }, lastLine: 'boom', state: 'failed' })
    expect(await source.stop('hermes-update')).toMatchObject({ effect: 'unsupported', ok: false })
  })

  it('notifies on every store change', () => {
    const cb = vi.fn()
    const off = actionsSource().subscribe(cb)

    $desktopActionTasks.set({ a: action('x', true, null) })
    off()
    $desktopActionTasks.set({})

    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('sub-agents source', () => {
  it('maps a child with its start time and newest stream line; Stop is honestly unsupported', async () => {
    $subagentsBySession.set({
      parent: [
        agent('a', { stream: [{ at: 5, kind: 'tool', text: 'Read File("x")' }] }),
        agent('q', { status: 'queued' })
      ]
    })

    const src = subagentsSource()
    const [a, q] = src.snapshot()

    expect(a).toMatchObject({
      id: 'agent:parent/a',
      kind: 'agent',
      lastLine: 'Read File("x")',
      sessionId: 'child-a',
      startedAt: 1_000,
      state: 'running',
      stop: 'none',
      title: 'goal a'
    })
    expect(q?.state).toBe('running')
    expect(await src.stop('parent/a')).toMatchObject({ effect: 'unsupported', ok: false })
  })

  it('skips the delegate placeholder rows (their swap for the real child is not a death)', () => {
    $subagentsBySession.set({ parent: [agent('delegate-tool:1'), agent('real')] })

    expect(
      subagentsSource()
        .snapshot()
        .map(t => t.id)
    ).toEqual(['agent:parent/real'])
  })

  it("the chat's own Stop clears a session: its running children read stopped for 60 s, then leave", () => {
    let now = 0
    const src = subagentsSource(() => now)

    $subagentsBySession.set({ parent: [agent('a'), agent('b', { status: 'completed' })] })
    src.snapshot()

    $subagentsBySession.set({})
    now = 1_000
    expect(src.snapshot().map(t => `${t.id}=${t.state}`)).toEqual(['agent:parent/a=stopped'])

    now = 62_000
    expect(src.snapshot()).toEqual([])
  })
})

describe('cron source', () => {
  it('lists a job only while a run is going, then lingers it as done or failed for 10 min', () => {
    let now = 0
    const src = cronSource(() => now)

    $cronJobs.set([job('idle', 'scheduled'), job('r', 'running')])
    expect(src.snapshot().map(t => `${t.id}=${t.state}`)).toEqual(['cron:r=running'])
    expect(src.snapshot()[0]?.startedAt).toBe(Date.parse('2026-10-21T08:00:00Z'))

    $cronJobs.set([job('idle', 'scheduled'), job('r', 'error', { last_error: 'boom' })])
    now = 1_000
    expect(src.snapshot()).toMatchObject([{ id: 'cron:r', lastLine: 'boom', state: 'failed' }])

    now = 1_000 + 10 * 60_000 + 1
    expect(src.snapshot()).toEqual([])
  })

  it('stop is unsupported: a run cannot be killed, pausing stays in Cron (O5)', async () => {
    expect(await cronSource().stop('r')).toMatchObject({ effect: 'unsupported', ok: false })
  })
})

describe('permissions source (V3-F audit trail)', () => {
  it('an open ask is WAITING; an answer clears it; a refusal is the last line for a while', () => {
    const now = 1_000_000 + 10 * 1_000

    expect(
      foldPermissionRecords(
        [
          record(1, 'ask', 's1'),
          record(2, 'ask', 's2'),
          record(3, 'answer', 's2'),
          record(4, 'ask', 's3'),
          record(5, 'refuse', 's3', { reason: 'outside the project' }),
          record(6, 'use', null)
        ],
        now
      ).map(t => `${t.id}=${t.state}:${t.lastLine}`)
    ).toEqual(['perm:s1=waiting:terminal · target-1', 'perm:s3=failed:Refused · terminal · target-5'])
  })

  it('a restart closes every open ask; a refusal older than 10 min is gone', () => {
    expect(foldPermissionRecords([record(1, 'ask', 's1'), record(2, 'restart', null)], 3_000_000)).toEqual([])
    expect(foldPermissionRecords([record(1, 'timeout', 's1')], 1_001_000 + 10 * 60_000 + 1)).toEqual([])
  })

  it('no bridge ⇒ the source is off (null), and the log view says unavailable', () => {
    vi.stubGlobal('hermesDesktop', undefined)

    expect(permissionsSource()).toBeNull()
    expect($permissionAudit.get()).toBeNull()
  })

  describe('with a bridge', () => {
    let changed: (() => void) | null
    let tail: ReturnType<typeof vi.fn>

    beforeEach(() => {
      changed = null
      tail = vi.fn(() => Promise.resolve([record(1, 'ask', 's1')]))
      vi.stubGlobal('hermesDesktop', {
        icloneConsent: {
          permissions: {
            onChanged: (cb: () => void) => {
              changed = cb

              return () => (changed = null)
            },
            tail
          }
        }
      })
    })

    it('G8: re-reads the tail on every change main announces and reports the ask as waiting', async () => {
      const src = permissionsSource(() => 1_000_000)!
      const cb = vi.fn()
      const off = src.subscribe(cb)

      await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1))
      expect(src.snapshot().map(t => t.state)).toEqual(['waiting'])
      expect($permissionAudit.get()).toHaveLength(1)

      tail.mockResolvedValueOnce([record(1, 'ask', 's1'), record(2, 'answer', 's1')])
      changed?.()
      await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(2))
      expect(src.snapshot()).toEqual([])

      off()
      expect(changed).toBeNull()
    })

    it('a failing tail makes the snapshot throw (the panel names the source), never crash', async () => {
      tail.mockRejectedValueOnce(new Error('ipc closed'))

      const src = permissionsSource()!
      const cb = vi.fn()

      src.subscribe(cb)
      await vi.waitFor(() => expect(cb).toHaveBeenCalled())
      expect(() => src.snapshot()).toThrow('ipc closed')
    })
  })
})
