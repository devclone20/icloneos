import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { CONFINEMENT_STATE_SCHEMA, type ConfinementStateView } from '../../src/iclone-shared/confinement'

import { confinementMarker, parseMarker } from './backend'
import {
  agentActivity,
  type AuditSlice,
  confinedProcesses,
  descendants,
  type FoldInput,
  foldState,
  type KnownProfile,
  outsideProcesses,
  parseElapsed,
  parsePs,
  type PsRow
} from './state'

const SHA = 'a'.repeat(64)
const known: KnownProfile[] = [{ cls: 'project', sha256: SHA, widened: false, generated: true }]
const marker = confinementMarker('project', SHA, 'sess-1')
/** The kernel's answer for one run (members.ts token name). */
const RUN = `project+${SHA.slice(0, 12)}+sess-1+${'b'.repeat(32)}`

const rows: PsRow[] = [
  { pid: 100, ppid: 1, pgid: 100, elapsedSec: 60, command: '/opt/hermes/python -m hermes serve' },
  {
    pid: 200,
    ppid: 100,
    pgid: 200,
    elapsedSec: 5,
    command: `/bin/bash -c source snap; cd /p; ls __HERMES_CWD_x__ ${marker}`,
    run: RUN
  },
  { pid: 201, ppid: 200, pgid: 200, elapsedSec: 4, command: '/bin/ls -la', run: RUN },
  { pid: 202, ppid: 201, pgid: 202, elapsedSec: 3, command: '/bin/sleep 9', run: RUN },
  { pid: 300, ppid: 100, pgid: 300, elapsedSec: 2, command: '/bin/bash -c printf __HERMES_CWD_y__' },
  { pid: 301, ppid: 300, pgid: 300, elapsedSec: 1, command: 'curl https://example.com' },
  { pid: 400, ppid: 100, pgid: 400, elapsedSec: 9, command: 'node mcp-server.js' },
  { pid: 500, ppid: 1, pgid: 500, elapsedSec: 9, command: 'unrelated app' }
]

const base = (over: Partial<FoldInput> = {}): FoldInput => ({
  now: new Date('2026-10-21T10:00:00Z'),
  backend: 'seatbelt',
  enabled: true,
  notes: [],
  defaultClass: 'project',
  backends: [
    {
      id: 'seatbelt',
      status: 'ready',
      enforcing: true,
      version: null,
      detail: 'enforcing',
      evidence: '',
      ownerStep: null
    },
    {
      id: 'container',
      status: 'not-installed',
      enforcing: false,
      version: null,
      detail: 'not-installed',
      evidence: '',
      ownerStep: 'install it'
    }
  ],
  profiles: [],
  known,
  rows: rows.filter(row => row.pid !== 300 && row.pid !== 301),
  verified: true,
  hermesPids: [100],
  pluginAckPids: [100],
  audit: [],
  refusals: [],
  tampered: [],
  hardlinks: [],
  ...over
})

describe('ps parsing', () => {
  it('parses etime in every ps shape', () => {
    expect(parseElapsed('05')).toBe(0)
    expect(parseElapsed('01:05')).toBe(65)
    expect(parseElapsed('02:01:05')).toBe(7265)
    expect(parseElapsed('3-02:01:05')).toBe(266465)
  })

  it('parses rows and keeps the full command', () => {
    expect(parsePs('  42     1    42    01:02 /bin/bash -c echo hi there\nnoise\n')).toEqual([
      { pid: 42, ppid: 1, pgid: 42, elapsedSec: 62, command: '/bin/bash -c echo hi there' }
    ])
  })

  it('walks a tree breadth first and tolerates a self-parented row', () => {
    expect(descendants(rows, 200).map(row => row.pid)).toEqual([200, 201, 202])
    expect(descendants([{ pid: 0, ppid: 0, pgid: 0, elapsedSec: 0, command: 'kernel' }], 0)).toHaveLength(1)
  })
})

describe('the marker', () => {
  it('round-trips and is read only as the last argv', () => {
    expect(parseMarker(`bash -c x ${marker}`)).toEqual({ cls: 'project', sha12: SHA.slice(0, 12), sessionId: 'sess-1' })
    expect(parseMarker(`bash -c 'echo ${marker}; rm -rf x'`)).toBeNull()
    expect(confinementMarker('build', SHA, 'bad session/../x')).toBe(`iclone-confined:build:${SHA.slice(0, 12)}:-`)
  })
})

describe('confined and outside processes', () => {
  it('a marked root and all its descendants are inside, with the root class', () => {
    const inside = confinedProcesses(rows, known)

    expect(inside.map(item => [item.pid, item.root, item.cls, item.profileKnown])).toEqual([
      [200, 200, 'project', true],
      [201, 200, 'project', true],
      [202, 200, 'project', true]
    ])
  })

  it('an agent command without the marker is outside and named as such; MCP servers are tools', () => {
    const inside = new Set(confinedProcesses(rows, known).map(item => item.pid))
    const outside = outsideProcesses(rows, [100], inside)

    expect(outside.map(item => [item.pid, item.kind])).toEqual([
      [100, 'hermes'],
      [300, 'agent-command'],
      [400, 'tool'],
      [301, 'agent-command']
    ])
  })
})

describe('F1 — membership comes from the kernel, not from ancestry', () => {
  const daemon: PsRow = { pid: 600, ppid: 1, pgid: 600, elapsedSec: 4, command: 'python3 -c sleep(90)', run: RUN }

  it('a double-forked, setsid daemon (ppid 1, its own group, no marker) is inside its run', () => {
    const inside = confinedProcesses([...rows, daemon], known, true)

    expect(inside.find(item => item.pid === 600)).toMatchObject({ root: 200, cls: 'project', sessionId: 'sess-1' })
    // Ancestry alone (the round-1 behaviour) misses it.
    expect(confinedProcesses([...rows, daemon], known, false).some(item => item.pid === 600)).toBe(false)
  })

  it('once the marked root is gone the run is still attributed, rooted at its oldest member', () => {
    const second: PsRow = { ...daemon, pid: 601, ppid: 600, elapsedSec: 2 }
    const inside = confinedProcesses([rows[0], daemon, second], known, true)

    expect(inside.map(item => [item.pid, item.root, item.cls, item.profileKnown])).toEqual([
      [600, 600, 'project', true],
      [601, 600, 'project', true]
    ])
  })

  it('a marker on a process the kernel does not confine is a forgery, never counted inside', () => {
    const forged: PsRow = { pid: 700, ppid: 1, pgid: 700, elapsedSec: 1, command: `/bin/sleep 99 ${marker}` }

    expect(confinedProcesses([...rows, forged], known, true).some(item => item.pid === 700)).toBe(false)
  })
})

describe('foldState verdicts', () => {
  it('GREEN when the backend enforces and every confined root runs a generated profile', () => {
    const view = foldState(base())

    expect(view.verdict).toBe('green')
    expect(view.reasons).toEqual([])
    expect(view.inside).toHaveLength(3)
    expect(view.schema).toBe(CONFINEMENT_STATE_SCHEMA)
  })

  it('RED when an agent command escapes', () => {
    const view = foldState(base({ rows }))

    expect(view.verdict).toBe('red')
    expect(view.reasons).toContainEqual({ code: 'agent-command-outside', pid: 300 })
  })

  it('RED on a widened, an unknown, or a changed-on-disk profile', () => {
    expect(foldState(base({ known: [{ ...known[0], widened: true }] })).reasons[0]).toMatchObject({
      code: 'widened-profile',
      pid: 200
    })
    expect(foldState(base({ known: [] })).reasons[0]).toMatchObject({ code: 'unknown-profile', pid: 200 })
    expect(foldState(base({ tampered: ['project'] })).reasons[0]).toEqual({ code: 'profile-changed', cls: 'project' })
  })

  it('RED when the selected backend is not confining (Seatbelt removed, or container not installed)', () => {
    const broken = base({
      backends: [
        {
          id: 'seatbelt',
          status: 'broken',
          enforcing: false,
          version: null,
          detail: 'binary-missing',
          evidence: '',
          ownerStep: null
        }
      ]
    })

    expect(foldState(broken).verdict).toBe('red')
    expect(foldState(base({ backend: 'container' })).reasons[0]).toEqual({
      code: 'backend-not-confining',
      backend: 'container',
      detail: 'not-installed'
    })
  })

  it('K130 — a forced container that is `installed` (not used in this version) still never reads as confining', () => {
    const forced = base({ backend: 'container' })

    const installed = {
      ...forced,
      backends: [
        forced.backends[0],
        {
          id: 'container' as const,
          status: 'installed' as const,
          enforcing: false,
          version: '1.5.0',
          detail: 'not-wired' as const,
          evidence: '',
          ownerStep: null
        }
      ]
    }

    const view = foldState(installed)

    expect(view.verdict).toBe('red')
    expect(view.reasons[0]).toEqual({ code: 'backend-not-confining', backend: 'container', detail: 'not-wired' })
  })

  it('G3-2 — a backend whose check timed out (`unknown`) is never confining: selected Seatbelt or forced container', () => {
    const unknown = { status: 'unknown' as const, enforcing: false, version: null, detail: 'probe-timeout' as const }
    const seatbelt = base({ backends: [{ id: 'seatbelt', evidence: '', ownerStep: null, ...unknown }] })
    const forced = base({ backend: 'container' })

    const container = {
      ...forced,
      backends: [forced.backends[0], { id: 'container' as const, evidence: '', ownerStep: null, ...unknown }]
    }

    expect(foldState(seatbelt).verdict).toBe('red')
    expect(foldState(seatbelt).reasons[0]).toEqual({
      code: 'backend-not-confining',
      backend: 'seatbelt',
      detail: 'probe-timeout'
    })
    expect(foldState(container).verdict).toBe('red')
    expect(foldState(container).reasons[0]).toEqual({
      code: 'backend-not-confining',
      backend: 'container',
      detail: 'probe-timeout'
    })
  })

  it('OFF when the owner chose This Mac, whatever runs', () => {
    expect(foldState(base({ enabled: false, rows })).verdict).toBe('off')
  })

  it('says the honest scope: file tools run through the terminal, so they are confined; MCP and the browser are not', () => {
    const { scope } = foldState(base())

    expect(scope.confined).toEqual(['terminal', 'execute_code', 'file tools'])
    expect(scope.notConfined).toEqual(['MCP servers', 'browser'])
  })

  it('F5 — RED when Hermes runs past its boot and the confinement plugin never acknowledged loading', () => {
    const missing = foldState(base({ pluginAckPids: [] }))

    expect(missing.verdict).toBe('red')
    expect(missing.reasons).toContainEqual({ code: 'plugin-not-loaded' })
    // A stale acknowledgement from an earlier Hermes is not this one's.
    expect(foldState(base({ pluginAckPids: [99] })).reasons).toContainEqual({ code: 'plugin-not-loaded' })

    // A child of Hermes may be the Python that loaded it (a launcher wrapper above it).
    expect(foldState(base({ pluginAckPids: [400] })).verdict).toBe('green')

    const booting = rows.map(row => (row.pid === 100 ? { ...row, elapsedSec: 3 } : row))

    expect(
      foldState(base({ pluginAckPids: [], rows: booting.filter(row => row.pid !== 300 && row.pid !== 301) })).verdict
    ).toBe('green')
  })

  it('an unverified snapshot is said, but is not on its own a confinement failure', () => {
    const view = foldState(base({ verified: false }))

    expect(view.verdict).toBe('green')
    expect(view.reasons).toEqual([{ code: 'membership-unverified' }])
  })
})

describe('agent activity — joined from the V3-F audit by session id', () => {
  const audit: AuditSlice[] = [
    {
      ts: '2026-10-21T09:00:00Z',
      kind: 'use',
      hermes_pid: 100,
      action: { tool: 'terminal', target: 'ls' },
      agent: { inft: 'i01-7', session_id: 'sess-1' },
      answer: null
    },
    {
      ts: '2026-10-21T09:01:00Z',
      kind: 'refuse',
      hermes_pid: 100,
      action: { tool: 'terminal', target: 'rm -rf ~' },
      agent: { inft: 'i01-7', session_id: 'sess-1' },
      answer: null
    },
    { ts: '2026-10-21T09:02:00Z', kind: 'use', hermes_pid: 100, action: null, agent: null, answer: null }
  ]

  it('newest first, counts inside per session from the live processes', () => {
    const inside = confinedProcesses(rows, known)
    const view = agentActivity(audit, inside, [])

    expect(view).toHaveLength(1)
    expect(view[0]).toMatchObject({ sessionId: 'sess-1', inft: 'i01-7', inside: 3, outside: 0 })
    expect(view[0].actions.map(item => item.target)).toEqual(['rm -rf ~', 'ls'])
  })
})

describe('G3 — no module-level state feeds the pane numbers', () => {
  it('the fold, the backends and the layer keep no counter between reads', () => {
    for (const file of ['state.ts', 'backend-seatbelt.ts', 'backend-container.ts', 'index.ts']) {
      const source = readFileSync(path.join(import.meta.dirname, file), 'utf8')
      const moduleLets = source.split('\n').filter(line => /^(let|var) /.test(line))

      expect(moduleLets, file).toEqual([])
    }
  })
})

describe('G9 — the state schema, and every pane field traces to it', () => {
  it('every key the pane reads exists on the state', () => {
    const view: ConfinementStateView = foldState(base({ rows }))

    const pane = readFileSync(
      path.join(import.meta.dirname, '../../src/app/home/containers/containers-app.tsx'),
      'utf8'
    )

    const reads = [...pane.matchAll(/\bstate\.(\w+)/g)].map(match => match[1])

    expect(reads.length).toBeGreaterThan(5)

    for (const key of reads) {
      expect(Object.keys(view), key).toContain(key)
    }
  })
})
