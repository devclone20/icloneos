import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { CONFINEMENT_STATE_SCHEMA, type ConfinementStateView } from '../../src/iclone-shared/confinement'

import { confinementMarker, parseMarker } from './backend'
import { RUNTIME_ANSWER } from './members'
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
  PLUGIN_REASON_MAX,
  type PsRow,
  runtimePids,
  withMembership
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
  // The command sandboxes on their own: the runtime's confinement is configured only on macOS (its own block below).
  darwin: false,
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

describe('the runtime profile — by the kernel’s mark, never by argv or ancestry', () => {
  const PROFILE = { profileSha: 'f'.repeat(64), reads: ['/usr'], writes: ['/run'], denied: ['/secret'] }

  /** Hermes and its stub, both held in the runtime profile; the stub carries the confined argv while it waits. */
  const runtimeRows: PsRow[] = [
    { pid: 100, ppid: 1, pgid: 100, elapsedSec: 60, command: '/opt/hermes/python -m hermes serve', runtime: true },
    {
      pid: 150,
      ppid: 100,
      pgid: 150,
      elapsedSec: 5,
      command: `/opt/py -I -S stub.py /run/launcher.sock -- /usr/bin/sandbox-exec -p x /bin/bash -c 'ls __HERMES_CWD_z__' ${marker}`,
      runtime: true
    },
    { pid: 160, ppid: 100, pgid: 160, elapsedSec: 5, command: '/opt/py -c "import x"', runtime: true }
  ]

  const on = (over: Partial<FoldInput> = {}) =>
    foldState(base({ rows: runtimeRows, darwin: true, runtimeProfile: PROFILE, launcher: 'up', ...over }))

  it('withMembership reads the runtime answer as a mark, never as a run', async () => {
    const snap = await withMembership(
      [
        { pid: 100, ppid: 1, pgid: 100, elapsedSec: 1, command: 'hermes' },
        { pid: 200, ppid: 1, pgid: 200, elapsedSec: 1, command: 'bash' },
        { pid: 300, ppid: 1, pgid: 300, elapsedSec: 1, command: 'other' }
      ],
      async () =>
        new Map([
          [100, RUNTIME_ANSWER],
          [200, RUN]
        ])
    )

    expect(snap.rows.map(row => [row.pid, row.run, row.runtime])).toEqual([
      [100, undefined, true],
      [200, RUN, undefined],
      [300, undefined, undefined]
    ])
  })

  it('ON: Hermes stays hermes, its held children are runtime (the stub too: not an agent command, not a forgery)', () => {
    const view = on()

    expect(view.runtime).toEqual({ state: 'on', launcher: 'up', pids: [100], ...PROFILE })
    expect(view.outside.map(item => [item.pid, item.kind])).toEqual([
      [100, 'hermes'],
      [150, 'runtime'],
      [160, 'runtime']
    ])
    expect(view.reasons).toEqual([])
    expect(view.verdict).toBe('green')
  })

  it('a forged argv the kernel does NOT hold is still an agent command, and red', () => {
    const forged = runtimeRows.map(row => (row.pid === 150 ? { ...row, runtime: undefined } : row))
    const view = on({ rows: forged })

    expect(view.outside.find(item => item.pid === 150)?.kind).toBe('agent-command')
    expect(view.reasons).toEqual(
      expect.arrayContaining([
        { code: 'forged-marker', pid: 150 },
        { code: 'agent-command-outside', pid: 150 }
      ])
    )
    expect(view.verdict).toBe('red')
  })

  it('BROKEN: a Hermes the kernel does not hold in the runtime profile is red, by pid', () => {
    const loose = runtimeRows.map(row => (row.pid === 100 ? { ...row, runtime: undefined } : row))
    const view = on({ rows: loose })

    expect(view.runtime.state).toBe('broken')
    expect(view.reasons).toContainEqual({ code: 'runtime-not-confined', pid: 100 })
    expect(view.verdict).toBe('red')
  })

  it('unverified: broken (not kernel-checked), said by membership-unverified, never runtime-not-confined', () => {
    const view = on({ rows: runtimeRows.map(({ runtime: _runtime, ...row }) => row), verified: false })

    expect(view.runtime.state).toBe('broken')
    expect(view.reasons.map(reason => reason.code)).not.toContain('runtime-not-confined')
    expect(view.reasons).toContainEqual({ code: 'membership-unverified' })
  })

  it('launcher down is red, and the card says so; a launcher that is not running while configured is down, never off', () => {
    for (const launcher of ['down', 'off', undefined] as const) {
      const view = on({ launcher })

      expect(view.runtime).toMatchObject({ state: 'on', launcher: 'down' })
      expect(view.reasons).toEqual([{ code: 'launcher-down' }])
      expect(view.verdict).toBe('red')
    }
  })

  it('OFF only when runtime confinement is not configured: confinement off, or not macOS', () => {
    for (const over of [{ enabled: false }, { darwin: false }] as Partial<FoldInput>[]) {
      const view = on({ ...over, rows: runtimeRows.map(row => ({ ...row, runtime: undefined })) })

      expect(view.runtime).toMatchObject({
        state: 'off',
        launcher: 'off',
        profileSha: null,
        reads: [],
        writes: [],
        denied: []
      })
      expect(view.reasons.map(reason => reason.code)).not.toContain('runtime-not-confined')
      expect(view.reasons.map(reason => reason.code)).not.toContain('runtime-not-running')
    }

    expect(foldState(base()).runtime).toMatchObject({ state: 'off', launcher: 'off' })
  })

  it('STOPPED: configured but no Hermes process (dead before ready, or not started): red, never off, never green', () => {
    // Hermes died before it was ready: main still names its pid, ps no longer lists it; the launcher stopped with it.
    for (const over of [
      { hermesPids: [100], rows: [], launcher: 'down' },
      { hermesPids: [], rows: [], launcher: 'off', runtimeProfile: null },
      { hermesPids: [], rows: runtimeRows.slice(1), launcher: 'up' }
    ] as Partial<FoldInput>[]) {
      const view = on(over)

      expect(view.runtime.state).toBe('stopped')
      expect(view.runtime.launcher).toBe(over.launcher === 'up' ? 'up' : 'down')
      expect(view.verdict).toBe('red')
      // One reason: the launcher stopping with the last runtime is a consequence, said on This Mac.
      expect(view.reasons.filter(reason => reason.code !== 'membership-unverified')).toEqual([
        { code: 'runtime-not-running' }
      ])
    }

    expect(on({ hermesPids: [], rows: [], runtimeProfile: null }).runtime).toMatchObject({
      profileSha: null,
      reads: []
    })
  })

  it('a live Hermes with no runtime profile while confinement is on is not held: broken, red by pid', () => {
    const view = on({ runtimeProfile: null, rows: runtimeRows.map(row => ({ ...row, runtime: undefined })) })

    expect(view.runtime.state).toBe('broken')
    expect(view.reasons).toContainEqual({ code: 'runtime-not-confined', pid: 100 })
  })

  describe('the plugin’s word on the agent’s commands (its acknowledgement), a fact the runtime reports', () => {
    const report = (available: boolean, pid = 100, reason = 'the launcher is not answering') => ({
      pid,
      available,
      reason: available ? '' : reason
    })

    it('G22 B1: two runtimes, each with its own word: both confined and acknowledged reads green', () => {
      const rows = [...runtimeRows, { ...runtimeRows.find(row => row.pid === 100)!, pid: 500, ppid: 1 }]

      expect(
        on({ rows, hermesPids: [100, 500], pluginAckPids: [100, 500], pluginCommands: [report(true), report(true, 500)] })
      ).toMatchObject({ verdict: 'green', reasons: [] })
    })

    it('G22 B1: a second runtime that never confirmed, or was never held, still reads red, by its own facts', () => {
      const rows = [...runtimeRows, { ...runtimeRows.find(row => row.pid === 100)!, pid: 500, ppid: 1, elapsedSec: 300 }]

      expect(on({ rows, hermesPids: [100, 500], pluginAckPids: [100], pluginCommands: [report(true)] }).reasons).toContainEqual({
        code: 'plugin-not-loaded'
      })

      const loose = rows.map(row => (row.pid === 500 ? { ...row, runtime: undefined } : row))

      expect(on({ rows: loose, hermesPids: [100, 500], pluginAckPids: [100, 500] }).reasons).toContainEqual({
        code: 'runtime-not-confined',
        pid: 500
      })
      expect(
        on({ rows, hermesPids: [100, 500], pluginAckPids: [100, 500], pluginCommands: [report(true), report(false, 500)] }).reasons[0]
      ).toMatchObject({ code: 'agent-commands-unavailable' })
    })

    it('M4: the window\'s runtime dead or gone reads stopped whatever the pool does, and the pool\'s commands are still judged', () => {
      const pool = { ...runtimeRows.find(row => row.pid === 100)!, pid: 500, ppid: 1, elapsedSec: 300 }
      const loose = { pid: 501, ppid: 500, elapsedSec: 300, command: 'sh -c __HERMES_CWD_ x', pgid: 501 } as typeof pool
      const rows = [pool, loose]

      for (const over of [
        { primaryPid: null, hermesPids: [500] },
        { primaryPid: 100, hermesPids: [100, 500] },
        { hermesPids: [100, 500] }
      ] as Partial<FoldInput>[]) {
        const view = on({ ...over, rows, pluginAckPids: [500] })

        expect(view.runtime.state).toBe('stopped')
        expect(view.verdict).toBe('red')
        expect(view.reasons).toContainEqual({ code: 'runtime-not-running' })
        expect(view.outside.map(process => process.pid)).toContain(501)
      }
    })

    it('G24: the window runtime dead with a pool runtime outside the Seatbelt reads broken, never stopped', () => {
      const pool = { ...runtimeRows.find(row => row.pid === 100)!, pid: 500, ppid: 1, runtime: false }
      const view = on({ primaryPid: 100, hermesPids: [100, 500], rows: [pool], pluginAckPids: [500] })

      expect(view.runtime.state).toBe('broken')
    })

    it('M4: a live window runtime with a pool runtime is still judged on every live runtime', () => {
      const rows = [...runtimeRows, { ...runtimeRows.find(row => row.pid === 100)!, pid: 500, ppid: 1 }]
      const loose = rows.map(row => (row.pid === 500 ? { ...row, runtime: undefined } : row))
      const facts = { primaryPid: 100, hermesPids: [100, 500], pluginAckPids: [100, 500] }

      expect(on({ ...facts, rows }).runtime.state).toBe('on')
      expect(on({ ...facts, rows: loose }).runtime.state).toBe('broken')
    })

    it('M4: with no window runtime the pool\'s pids still reach the fold, so its commands are judged; the state comes from primaryPid, not from this list', () => {
      expect(runtimePids(100, [{ process: { pid: 500 } }, { process: null }, { process: { pid: 100 } }, { process: { pid: undefined } }])).toEqual([100, 500])
      expect(runtimePids(undefined, [{ process: { pid: 500 } }])).toEqual([500])
      expect(runtimePids(undefined, [])).toEqual([])
    })

    it('every kernel fact green, but the plugin withholds the commands: red, with its plain reason, labelled', () => {
      const view = on({ pluginCommands: [report(false)] })

      expect(view.runtime).toMatchObject({ state: 'on', launcher: 'up' })
      expect(view.reasons).toEqual([
        { code: 'agent-commands-unavailable', reason: 'the launcher is not answering', reportedBy: 'runtime' }
      ])
      expect(view.verdict).toBe('red')
    })

    it('R20: an unreadable config is a note, not a refusal: green stays green, and a dead process says nothing', () => {
      const view = on({ pluginCommands: [{ ...report(true), note: 'config.yaml could not be read' }] })

      expect(view.verdict).toBe('green')
      expect(view.reasons).toEqual([{ code: 'agent-config-unreadable' }])

      expect(on({ pluginCommands: [{ ...report(true, 999), note: 'x' }] }).reasons).toEqual([])
    })

    it('a child of Hermes said it (the plugin loads in its interpreter children too): still red', () => {
      expect(on({ pluginCommands: [report(false, 160)] }).verdict).toBe('red')
    })

    it('available never turns a red verdict green: it adds nothing, and the kernel facts still decide', () => {
      expect(on({ pluginCommands: [report(true)] })).toMatchObject({ verdict: 'green', reasons: [] })

      const loose = runtimeRows.map(row => (row.pid === 100 ? { ...row, runtime: undefined } : row))
      const broken = on({ rows: loose, pluginCommands: [report(true)] })

      expect(broken.verdict).toBe('red')
      expect(broken.reasons).toContainEqual({ code: 'runtime-not-confined', pid: 100 })

      expect(on({ launcher: 'down', pluginCommands: [report(true)] }).reasons).toEqual([{ code: 'launcher-down' }])
    })

    it('with the launcher down both facts are said: main’s own, and the runtime’s', () => {
      expect(on({ launcher: 'down', pluginCommands: [report(false)] }).reasons).toEqual([
        { code: 'launcher-down' },
        { code: 'agent-commands-unavailable', reason: 'the launcher is not answering', reportedBy: 'runtime' }
      ])
    })

    it('a report from a process outside every live Hermes tree (a Hermes that exited) says nothing', () => {
      expect(on({ pluginCommands: [report(false, 4242)] })).toMatchObject({ verdict: 'green', reasons: [] })
      expect(
        on({ hermesPids: [], rows: [], pluginCommands: [report(false)] }).reasons.map(reason => reason.code)
      ).not.toContain('agent-commands-unavailable')
    })

    it('confinement off: nothing the plugin says makes a reason', () => {
      expect(on({ enabled: false, pluginCommands: [report(false)] }).reasons).toEqual([])
    })

    it('the reason is clipped, and an empty one still reads as a reason', () => {
      const long = on({ pluginCommands: [report(false, 100, 'x'.repeat(5000))] }).reasons[0]
      const empty = on({ pluginCommands: [report(false, 100, '')] }).reasons[0]

      expect(long).toMatchObject({ code: 'agent-commands-unavailable' })
      expect(long?.code === 'agent-commands-unavailable' ? long.reason.length : 0).toBe(PLUGIN_REASON_MAX)
      expect(empty).toEqual({ code: 'agent-commands-unavailable', reason: 'no reason given', reportedBy: 'runtime' })
    })
  })
})

describe('membership-unverified — said only when the kernel truly could not be asked', () => {
  const quiet = (over: Partial<FoldInput>) =>
    foldState(
      base({
        verified: false,
        hermesPids: [],
        rows: [{ pid: 500, ppid: 1, pgid: 500, elapsedSec: 9, command: 'unrelated app' }],
        ...over
      })
    )

  const said = (view: ConfinementStateView) => view.reasons.some(reason => reason.code === 'membership-unverified')

  it('the probe ran and failed: said, whatever runs', () => {
    expect(said(quiet({ membership: 'failed' }))).toBe(true)
    expect(said(quiet({}))).toBe(true)
  })

  it('no probe to run (no runtime Python yet) and nothing to ask about: not said', () => {
    expect(said(quiet({ membership: 'none' }))).toBe(false)
  })

  it('no probe to run while a Hermes lives, or a process carries the confinement marker: said', () => {
    expect(said(quiet({ membership: 'none', hermesPids: [100], rows }))).toBe(true)
    expect(
      said(
        quiet({
          membership: 'none',
          rows: [{ pid: 700, ppid: 1, pgid: 700, elapsedSec: 1, command: `/bin/sleep 9 ${marker}` }]
        })
      )
    ).toBe(true)
  })

  it('answered: never said', () => {
    expect(said(foldState(base({ verified: true, membership: 'answered' })))).toBe(false)
  })

  it('withMembership names why: none without a probe, failed when it throws, answered when it answers', async () => {
    const one: PsRow[] = [{ pid: 9, ppid: 1, pgid: 9, elapsedSec: 1, command: 'x' }]

    expect(await withMembership(one, null)).toMatchObject({ verified: false, probe: 'none' })
    expect(
      await withMembership(one, async () => {
        throw new Error('no python')
      })
    ).toMatchObject({ verified: false, probe: 'failed' })
    expect(await withMembership(one, async () => new Map())).toMatchObject({ verified: true, probe: 'answered' })
  })

  it('schema 8: runs ride on the state as folded', () => {
    expect(foldState(base()).runs).toEqual([])
    expect(foldState(base()).schema).toBe(CONFINEMENT_STATE_SCHEMA)
  })
})
