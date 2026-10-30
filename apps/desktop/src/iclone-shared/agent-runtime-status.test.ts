import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  type AgentRuntimeTracker,
  emptyAgentRuntimeStatus,
  mayAutoInstall,
  parseAgentRuntimeStatus,
  recordInstallAgain,
  recordSkip,
  type StatusBootstrapEvent,
  trackBootstrapEvent
} from './agent-runtime-status'

const rt8h = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '__fixtures__', 'rt8h-python-deps.json'), 'utf8')
) as { log: { line: string; stage: string; ts: number }[] }

function run(events: StatusBootstrapEvent[]): AgentRuntimeTracker {
  return events.reduce<AgentRuntimeTracker>((tracker, ev, i) => trackBootstrapEvent(tracker, ev, i), {
    run: null,
    status: emptyAgentRuntimeStatus()
  })
}

const start: StatusBootstrapEvent[] = [{ type: 'manifest' }, { type: 'stage', name: 'python-deps', state: 'running' }]

describe('agent runtime status (RTB-6/7, V3-ON status API)', () => {
  it('a complete first launch is installed, with every package line done and the stage durations', () => {
    const tracker = run([
      ...start,
      ...rt8h.log.map(entry => ({ type: 'log', stage: 'python-deps', line: entry.line })),
      { type: 'stage', name: 'python-deps', state: 'succeeded', durationMs: 29_688 },
      { type: 'complete' }
    ])

    expect(tracker.status.state).toBe('installed')
    expect(tracker.status.diagnosis).toBeNull()
    expect(tracker.status.packages.every(line => line.state === 'done')).toBe(true)
    expect(tracker.status.stageDurations['python-deps']).toBe(29_688)
  })

  it('an optional package that failed leaves the runtime incomplete, naming it', () => {
    const tracker = run([
      ...start,
      { type: 'log', stage: 'python-deps', line: '✓ venv' },
      { type: 'log', stage: 'python-deps', line: '  cua-driver:  18.9%  12.0 MiB / 63.6 MiB' },
      { type: 'log', stage: 'python-deps', line: '✗ cua-driver: download failed: Connection reset by peer' },
      {
        type: 'log',
        stage: 'python-deps',
        line: '⚠ optional cua-driver was not installed; its tools stay unavailable'
      },
      { type: 'stage', name: 'python-deps', state: 'succeeded' },
      { type: 'complete' }
    ])

    expect(tracker.status.state).toBe('incomplete')
    expect(tracker.status.diagnosis).toMatchObject({ class: 'network', fix: 'retry', packageName: 'cua-driver' })
    expect(tracker.status.packages.find(line => line.name === 'cua-driver')?.state).toBe('failed')
  })

  it('a failed stage is diagnosed from its error and output tail', () => {
    const tracker = run([
      ...start,
      { type: 'log', stage: 'python-deps', line: 'OSError: [Errno 28] No space left on device' },
      { type: 'stage', name: 'python-deps', state: 'failed', error: 'exit code 1' },
      { type: 'failed', error: 'stage python-deps failed', stage: 'python-deps' }
    ])

    expect(tracker.status.state).toBe('not-installed')
    expect(tracker.status.diagnosis).toMatchObject({
      class: 'disk',
      fix: 'open-storage-settings',
      stage: 'python-deps'
    })
  })

  it('skip: this run never installs again by itself; the next launch offers it once; then only Settings', () => {
    let status = emptyAgentRuntimeStatus()

    expect(mayAutoInstall(status, false)).toBe(true)
    status = recordSkip(status, 1)
    expect(mayAutoInstall(status, true)).toBe(false)
    // Next launch: offered again, once.
    expect(mayAutoInstall(status, false)).toBe(true)
    status = recordSkip(status, 2)
    expect(mayAutoInstall(status, false)).toBe(false)
    // Settings > Machine > Agent runtime → Install again.
    status = recordInstallAgain(status, 3)
    expect(mayAutoInstall(status, false)).toBe(true)
  })

  it('a persisted record is parsed defensively; an install that died mid-run is not installed', () => {
    expect(parseAgentRuntimeStatus({ schema: 2 }).state).toBe('not-installed')
    expect(parseAgentRuntimeStatus({ schema: 1, skipCount: -3, state: 'installing' })).toMatchObject({
      skipCount: 0,
      state: 'not-installed'
    })
    expect(parseAgentRuntimeStatus({ schema: 1, skipCount: 2, state: 'incomplete' })).toMatchObject({
      skipCount: 2,
      state: 'incomplete'
    })
  })
})

describe('the r4 package states in the persisted status (G-01 R3-3)', () => {
  it('a nameless ✗ and the stopped rows of a failed stage are persisted, round-trip, and old records still load', () => {
    let tracker = { run: null, status: emptyAgentRuntimeStatus(0) } as Parameters<typeof trackBootstrapEvent>[0]

    for (const ev of [
      { type: 'manifest' },
      { line: '  node: verifying', stage: 'python-deps', type: 'log' },
      { line: '  ✗ uv sync failed; last 3 lines of output follow', stage: 'python-deps', type: 'log' },
      { error: 'exit 1', name: 'python-deps', state: 'failed', type: 'stage' },
      { error: 'exit 1', stage: 'python-deps', type: 'failed' }
    ]) {
      tracker = trackBootstrapEvent(tracker, ev, 1)
    }

    expect(tracker.status.unattributed).toEqual(['uv sync failed; last 3 lines of output follow'])
    expect(tracker.status.packages.find(line => line.name === 'node')?.state).toBe('stopped')
    const reloaded = parseAgentRuntimeStatus(JSON.parse(JSON.stringify(tracker.status)), 2)

    expect(reloaded.packages).toEqual(tracker.status.packages)
    expect(reloaded.unattributed).toEqual(tracker.status.unattributed)
    // A record written before r4 (no `unattributed`, the old states) loads as it was, with nothing unattributed.
    const old = { ...JSON.parse(JSON.stringify(tracker.status)), packages: [{ name: 'node', state: 'waiting' }] }
    delete old.unattributed

    expect(parseAgentRuntimeStatus(old, 3)).toMatchObject({
      packages: [{ name: 'node', state: 'waiting' }],
      unattributed: []
    })
  })
})
