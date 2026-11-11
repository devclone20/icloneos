/**
 * Test-only: a realistic Containers state with every run phase, a live run with three refusals of different rules, a
 * background run, a run refused before it started, and the runtime profile on. Tests and design screenshots read it;
 * the app never imports it.
 */
import {
  CONFINEMENT_STATE_SCHEMA,
  type ConfinementStateView,
  type HardlinkBlockView,
  type RefusalView,
  type RunView
} from '@/iclone-shared/confinement'

export const FIXTURE_AT = '2026-11-01T14:30:00.000Z'

const SHA_PROJECT = '3f9c2a7be81d4c06a5e2f10b9d7c3e4a6b8f0d1c2e3a4b5c6d7e8f9a0b1c2d3e'
const SHA_BUILD = '8a1e4d7c0b3f6e9a2d5c8b1e4f7a0d3c6b9e2f5a8d1c4b7e0a3f6d9c2b5e8a1d'
const SHA_RUNTIME = 'c47e1a9d3b6f2e8c5a0d7b4e1f8c3a6d9b2e5f0a7c4d1b8e3f6a9c2d5b0e7f4a'
const PROJECT = '/Users/me/Code/atlas'

const ago = (seconds: number): string => new Date(Date.parse(FIXTURE_AT) - seconds * 1000).toISOString()

function run(over: Partial<RunView> & Pick<RunView, 'command' | 'id' | 'phase' | 'startedAt'>): RunView {
  return {
    origin: 'agent',
    kind: 'shell',
    cls: 'project',
    profileSha: SHA_PROJECT,
    sessionId: 's-7f3a',
    cwd: PROJECT,
    projectRoot: PROJECT,
    network: false,
    writeProject: true,
    endedAt: null,
    exitCode: null,
    signal: null,
    rootPid: null,
    live: 0,
    refusals: 0,
    refusedReason: null,
    refusedDetail: null,
    ...over
  }
}

export const FIXTURE_RUNS = {
  running: run({
    id: 'run-a1c4',
    phase: 'running',
    command: 'npm test -- --watch=false\necho "done"',
    startedAt: ago(12),
    rootPid: 48211,
    live: 3,
    refusals: 3
  }),
  background: run({
    id: 'run-b7e2',
    phase: 'background',
    command: 'pnpm dev --port 5174 &',
    startedAt: ago(312),
    exitCode: 0,
    rootPid: 47902,
    live: 2,
    network: true
  }),
  exited: run({
    id: 'run-c2d9',
    phase: 'exited',
    command: 'git status --short',
    startedAt: ago(41),
    endedAt: ago(40),
    exitCode: 0,
    writeProject: false
  }),
  failed: run({
    id: 'run-d5f0',
    phase: 'failed',
    cls: 'build',
    profileSha: SHA_BUILD,
    command: 'cd crates/core\ncargo build --release',
    startedAt: ago(250),
    endedAt: ago(184),
    exitCode: 101,
    refusals: 1
  }),
  stopped: run({
    id: 'run-e8a3',
    phase: 'stopped',
    stoppedByOwner: true,
    cls: 'research',
    command: 'python3 scripts/crawl.py --depth 4',
    startedAt: ago(900),
    endedAt: ago(780),
    signal: 9,
    network: true,
    writeProject: false
  }),
  refused: run({
    id: 'run-f1b6',
    phase: 'refused',
    command: 'rg --files node_modules/.pnpm',
    startedAt: ago(1500),
    endedAt: ago(1500),
    refusedReason: 'hard-links',
    refusedDetail: 'node_modules/.pnpm has 501 hard links to files outside the project',
    reportedBy: 'runtime'
  }),
  unknown: run({
    id: 'run-a9c7',
    phase: 'unknown',
    kind: 'program',
    cls: 'media',
    command: 'ffmpeg -i in/take-03.mov -c:v libx264 out/take-03.mp4',
    startedAt: ago(7300)
  }),
  /** The runtime's own shell session set-up: confined like the rest, listed only behind the disclosure. */
  housekeeping: run({
    id: 'run-b3d8',
    origin: 'runtime',
    phase: 'exited',
    command: 'Prepare the shell environment for this session',
    startedAt: ago(14),
    endedAt: ago(13),
    exitCode: 0,
    writeProject: false
  })
} satisfies Record<string, RunView>

const UNLISTED = '/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Client work/2026 autumn/atlas-handover-final'

/** fx14: runs started with less than they asked for, a run the modes stopped, a policy refusal, a git-config refusal. */
export const FIXTURE_NARROWED = {
  unlisted: run({
    id: 'run-n1a0',
    phase: 'failed',
    command: 'touch notes.md',
    startedAt: ago(30),
    endedAt: ago(29),
    exitCode: 1,
    refusals: 1,
    cwd: UNLISTED,
    projectRoot: UNLISTED,
    writeProject: false,
    narrowed: true,
    narrowedWhy: 'unlisted-folder'
  }),
  unlistedOlder: run({
    id: 'run-n1a1',
    phase: 'exited',
    command: 'cat README.md',
    startedAt: ago(90),
    endedAt: ago(89),
    exitCode: 0,
    cwd: UNLISTED,
    projectRoot: UNLISTED,
    writeProject: false,
    narrowed: true,
    narrowedWhy: 'unlisted-folder'
  }),
  needsAllow: run({
    id: 'run-n2b0',
    phase: 'failed',
    command: 'npm run build',
    startedAt: ago(200),
    endedAt: ago(190),
    exitCode: 1,
    refusals: 1,
    writeProject: false,
    narrowed: true,
    narrowedWhy: 'needs-allow'
  }),
  needsNetwork: run({
    id: 'run-n3c0',
    phase: 'failed',
    command: 'curl -sS https://example.com/health',
    startedAt: ago(260),
    endedAt: ago(259),
    exitCode: 7,
    refusals: 1,
    narrowed: true,
    narrowedWhy: 'needs-network'
  }),
  stoppedByModes: run({
    id: 'run-n4d0',
    phase: 'stopped',
    command: 'pnpm test --watch',
    startedAt: ago(400),
    endedAt: ago(320),
    signal: 9,
    stoppedByModes: true,
    stoppedDetail:
      'the run was stopped: the modes changed and no longer allow what it was started with (the request asks to write the project (WRITE_PROJECT=1) and no mode set on this Mac allows project writes)'
  }),
  policy: run({
    id: 'run-n5e0',
    phase: 'refused',
    command: 'rm -rf dist',
    startedAt: ago(500),
    endedAt: ago(500),
    writeProject: false,
    refusedReason: 'policy',
    refusedDetail:
      'the request asks to write the project (WRITE_PROJECT=1) and no mode set on this Mac allows project writes',
    reportedBy: 'launcher'
  }),
  gitPush: run({
    id: 'run-n6f0',
    phase: 'exited',
    command: 'git push -u origin feature/menu',
    startedAt: ago(600),
    endedAt: ago(598),
    exitCode: 0,
    refusals: 2,
    network: true
  })
} satisfies Record<string, RunView>

export const FIXTURE_NARROWED_REFUSALS: RefusalView[] = [
  {
    ts: ago(29),
    pid: 48400,
    process: 'touch',
    operation: 'file-write-create',
    target: `${UNLISTED}/notes.md`,
    sessionId: 's-7f3a',
    run: 'run-n1a0',
    why: 'narrowed-unlisted-folder'
  },
  {
    ts: ago(195),
    pid: 48401,
    process: 'node',
    operation: 'file-write-create',
    target: `${PROJECT}/dist/index.js`,
    sessionId: 's-7f3a',
    run: 'run-n2b0',
    why: 'narrowed-needs-allow'
  },
  {
    ts: ago(259),
    pid: 48402,
    process: 'curl',
    operation: 'network-outbound',
    target: 'example.com:443',
    sessionId: 's-7f3a',
    run: 'run-n3c0',
    why: 'narrowed-needs-network'
  },
  {
    ts: ago(599),
    pid: 48403,
    process: 'git',
    operation: 'file-write-create',
    target: `${PROJECT}/.git/config`,
    sessionId: 's-7f3a',
    run: 'run-n6f0',
    why: 'git-config'
  }
]

export const FIXTURE_REFUSALS: RefusalView[] = [
  {
    ts: ago(10),
    pid: 48215,
    process: 'node',
    operation: 'file-read-data',
    target: '/Users/me/Documents/notes.md',
    sessionId: 's-7f3a',
    run: FIXTURE_RUNS.running.id,
    why: 'outside-roots'
  },
  {
    ts: ago(8),
    pid: 48216,
    process: 'cat',
    operation: 'file-read-data',
    target: '/Users/me/.ssh/id_ed25519',
    sessionId: 's-7f3a',
    run: FIXTURE_RUNS.running.id,
    why: 'never-list'
  },
  {
    ts: ago(5),
    pid: 48215,
    process: 'node',
    operation: 'network-outbound',
    target: 'registry.npmjs.org:443',
    sessionId: 's-7f3a',
    run: FIXTURE_RUNS.running.id,
    why: 'network-not-granted'
  },
  {
    ts: ago(200),
    pid: 47100,
    process: 'cargo',
    operation: 'file-write-create',
    target: '/Users/me/.cargo/config.toml',
    sessionId: 's-7f3a',
    run: FIXTURE_RUNS.failed.id,
    why: 'not-writable'
  },
  {
    ts: ago(2400),
    pid: 46001,
    process: 'security',
    operation: 'mach-lookup',
    target: 'com.apple.SecurityServer',
    sessionId: null,
    run: null,
    why: 'system-service'
  }
]

export const FIXTURE_HARDLINKS: HardlinkBlockView = {
  root: PROJECT,
  kind: 'hard-links',
  paths: [`${PROJECT}/node_modules/.pnpm/a/index.js`, `${PROJECT}/node_modules/.pnpm/b/index.js`],
  count: 501,
  groups: [
    {
      dir: `${PROJECT}/node_modules/.pnpm`,
      paths: [`${PROJECT}/node_modules/.pnpm/a/index.js`, `${PROJECT}/node_modules/.pnpm/b/index.js`],
      count: 501,
      digest: 'd'.repeat(64)
    }
  ]
}

export function fixtureState(over: Partial<ConfinementStateView> = {}): ConfinementStateView {
  return {
    schema: CONFINEMENT_STATE_SCHEMA,
    at: FIXTURE_AT,
    backend: 'seatbelt',
    enabled: true,
    isolation: { on: true, available: true, persists: true, runningDiffers: false },
    verdict: 'green',
    reasons: [],
    backends: [
      {
        id: 'seatbelt',
        status: 'ready',
        enforcing: true,
        version: null,
        detail: 'enforcing',
        evidence: 'exit 1',
        ownerStep: null
      },
      {
        id: 'container',
        status: 'installed',
        enforcing: false,
        version: '1.5.0',
        detail: 'not-wired',
        evidence: 'container 1.5.0',
        ownerStep: null
      }
    ],
    defaultClass: 'project',
    profiles: [
      {
        cls: 'project',
        sha256: SHA_PROJECT,
        network: 'grant',
        reads: [PROJECT, '/usr', '/System'],
        writes: [PROJECT, '~/Library/Caches/icloneOS/scratch'],
        denied: ['~/.ssh', '~/.aws', '~/Library/Keychains']
      },
      {
        cls: 'build',
        sha256: SHA_BUILD,
        network: 'grant',
        reads: [PROJECT, '~/.cargo', '~/.npm'],
        writes: [PROJECT, '~/.cargo/registry', '~/.npm/_cacache'],
        denied: ['~/.ssh', '~/.aws', '~/Library/Keychains']
      }
    ],
    inside: [
      {
        pid: 48211,
        ppid: 1,
        root: 48211,
        cls: 'project',
        profileSha: SHA_PROJECT.slice(0, 12),
        profileKnown: true,
        widened: false,
        sessionId: 's-7f3a',
        elapsedSec: 12,
        command: '/bin/bash -c npm test -- --watch=false'
      }
    ],
    outside: [
      { pid: 900, ppid: 1, kind: 'hermes', elapsedSec: 3600, command: 'python -s -P -m hermes' },
      { pid: 901, ppid: 900, kind: 'runtime', elapsedSec: 3500, command: 'python -I -S stub.py' }
    ],
    agents: [
      {
        sessionId: 's-7f3a',
        inft: 'i01-7',
        lastTs: ago(5),
        inside: 1,
        outside: 0,
        actions: [{ ts: ago(12), kind: 'use', tool: 'terminal', target: 'npm test -- --watch=false', outcome: null }]
      }
    ],
    refusals: FIXTURE_REFUSALS,
    refusalDay: null,
    hardlinks: [],
    firstScan: null,
    runs: Object.values(FIXTURE_RUNS),
    runsCut: 0,
    runtime: {
      state: 'on',
      profileSha: SHA_RUNTIME,
      launcher: 'up',
      pids: [900, 901],
      reads: ['/usr', '/System', '/Library/Frameworks', '~/Library/Application Support/icloneOS/runtime'],
      writes: ['~/Library/Application Support/icloneOS/confinement/run'],
      denied: ['~/.ssh', '~/Library/Keychains']
    },
    scope: { confined: ['terminal', 'execute_code', 'file tools'], notConfined: ['MCP servers'] },
    ...over
  }
}
