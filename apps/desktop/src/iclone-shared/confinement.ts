/**
 * V3-G — the confinement vocabulary shared by main (electron/iclone-confinement) and the Dock pane
 * (src/app/home/containers). Plain TS: no DOM or Node imports. Main folds the state from live `ps`, the backends'
 * probes and the audit trail on every read; the pane renders only from `ConfinementStateView` and never counts.
 */

/** research: net by grant, writes scratch · project: + project root · build: + package caches · offline: project, net
 *  never · media: reads the project, writes one output dir. */
export const ACTIVITY_CLASSES = ['research', 'project', 'build', 'offline', 'media'] as const
export type ActivityClass = (typeof ACTIVITY_CLASSES)[number]

const CONFINEMENT_BACKENDS = ['seatbelt', 'container'] as const
export type ConfinementBackendId = (typeof CONFINEMENT_BACKENDS)[number]

/** FX-6: confinement is ON unless the owner turns it off (Containers › This Mac): main's default settings and the
 *  Permissions pane's note both read this one value. */
export const CONFINEMENT_ON_BY_DEFAULT = true

export const CONFINEMENT_STATE_SCHEMA = 'iclone.confinement.state/12'

/** Today's (UTC) refusal record in main: the day's file closes into numbered parts past a size, so no read outgrows it. */
export interface RefusalDayView {
  /** UTC day, `YYYY-MM-DD`. */
  day: string
  /** Every row of the day, its closed parts included; null while main is still counting the files it found at start. */
  rows: number | null
  /** Rows in the day's closed parts, all older than the live file's; null while counting. */
  olderRows: number | null
  /** How many closed parts the day has. */
  parts: number
}

/** The newest refusals the state carries (`ConfinementStateView.refusals`); older ones stay in main's record. */
export const REFUSALS_LISTED = 100

export const isActivityClass = (value: unknown): value is ActivityClass =>
  typeof value === 'string' && (ACTIVITY_CLASSES as readonly string[]).includes(value)

export const isConfinementBackendId = (value: unknown): value is ConfinementBackendId =>
  typeof value === 'string' && (CONFINEMENT_BACKENDS as readonly string[]).includes(value)

/** ready: confines now · installed: present and answering, but this version does not use it (Apple `container`
 *  before spike C1: neutral, never a fault) · not-installed: an owner step is missing · unsupported: this Mac cannot ·
 *  broken: present but a probe failed (a removed or non-enforcing binary reads RED, never silently unconfined) ·
 *  unknown: the check did not finish in time (a busy Mac), so nothing is known either way — neutral, never "Not
 *  working", and never confining (G3-2). */
export type BackendStatus = 'broken' | 'installed' | 'not-installed' | 'ready' | 'unknown' | 'unsupported'

/** Why a backend has its status, as a catalogue key: the pane words it in the owner's language. */
export type BackendDetail =
  | 'binary-missing'
  | 'cannot-run'
  | 'enforcing'
  | 'macos-only'
  | 'needs-apple-silicon'
  | 'no-version'
  | 'not-enforcing'
  | 'not-installed'
  | 'not-wired'
  | 'probe-failed'
  | 'probe-timeout'

export interface BackendStatusView {
  id: ConfinementBackendId
  status: BackendStatus
  version: string | null
  detail: BackendDetail
  /** The measured facts behind `detail` (stderr, a version, a path): logs and tests, never shown as a sentence. */
  evidence: string
  /** The owner's one-time step, a shell command (not translated), when there is one. */
  ownerStep: string | null
  /** The negative control ran and a profile that must deny did deny. */
  enforcing: boolean
}

export interface ProfileView {
  cls: ActivityClass
  sha256: string
  /** 'grant' = only when the permission mode or a live grant allows the network; 'never' = no grant opens it. */
  network: 'grant' | 'never'
  reads: string[]
  writes: string[]
  denied: string[]
}

export interface ConfinedProcessView {
  pid: number
  ppid: number
  /** The confined root this process descends from (itself for the root). */
  root: number
  cls: ActivityClass | null
  profileSha: string
  /** The profile hash is one main generated in this run. */
  profileKnown: boolean
  /** The profile text allows by default or drops the default deny. */
  widened: boolean
  sessionId: string | null
  elapsedSec: number
  command: string
}

/** runtime: a process the kernel holds in the runtime profile (Hermes' own children, the launcher's stubs). */
export type OutsideKind = 'agent-command' | 'hermes' | 'runtime' | 'tool'

export interface OutsideProcessView {
  pid: number
  ppid: number
  kind: OutsideKind
  elapsedSec: number
  command: string
}

/** Why the kernel refused an operation, as a catalogue key the pane words (main derives it from the operation, the
 *  target and the profile the process ran under; it never trusts a reason a process gave). */
export type RefusalWhy =
  /** A read outside every root the profile allows. */
  | 'outside-roots'
  /** A path on the never list (secrets, the app's own state): refused in every class and every mode. */
  | 'never-list'
  /** A write outside the writable roots (the scratch, the project when writes are granted, the output folder). */
  | 'not-writable'
  /** A write inside the project while the permission mode keeps the project read-only. */
  | 'project-read-only'
  /** The same write, in a run that asked for project writes and was given none: the app did not have this folder open
   *  and the user never named it. */
  | 'narrowed-unlisted-folder'
  /** The same write, in a run that asked for project writes and was given none: its mode asks, and no allow was in
   *  effect for this folder. */
  | 'narrowed-needs-allow'
  | 'narrowed-needs-file-writing'
  /** The network, in a run that asked for it and was given none: its mode asks, and no allow was in effect. */
  | 'narrowed-needs-network'
  /** A write to a file the floor protects even inside the project (the agent's own config). */
  | 'protected-file'
  /** A write to the config, hooks or `.git` of the repository the project already was: those name programs git runs. */
  | 'git-config'
  /** The network, with no grant for it in this session. */
  | 'network-not-granted'
  /** The network, in a class that never has it (offline). */
  | 'network-never'
  /** A program outside the readable roots, or one refused by name (launchctl, osascript, open, security…). */
  | 'program-refused'
  /** A system service (Mach lookup) the profile does not reach: credential stores, other apps. */
  | 'system-service'
  /** A hard link to an outside file appeared during a run (detected after the run, not prevented). */
  | 'hard-link'
  | 'other'

export interface RefusalView {
  ts: string
  pid: number
  process: string
  operation: string
  target: string
  sessionId: string | null
  /** Rows the layer writes itself (`hard-link-appeared`, T3): the project root the scan after the run looked at. */
  root?: string
  /** The run this refusal belongs to (`RunView.id`), when the kernel placed the process in one. */
  run?: string | null
  /** Main's reading of the refusal; the pane words it. */
  why?: RefusalWhy
  /** A shell's look at a folder: its metadata or its listing (a `cd`, a wildcard). Words and groups the row, never hides it. */
  shellLook?: boolean
}

/**
 * One confined command from start to end. Main folds it from the launcher's journal (start and end, written by the
 * process that starts and reaps the command), the plugin's refusals (commands that never started), the owner's stops,
 * and the kernel's live membership (how many processes of the run are alive now).
 *
 * running: the root is alive · background: the root exited but processes it started are still alive in its sandbox ·
 * exited: ended with status 0 · failed: ended with another status or a signal nobody asked for · stopped: stopped by
 * the owner's Stop (`stoppedByOwner`), the modes, the agent's process tool or the launcher at quit · refused: never started (`refusedReason` says why) · unknown: a start with no end and no
 * live process (the app or the launcher quit while it ran).
 */
export type RunPhase = 'background' | 'exited' | 'failed' | 'refused' | 'running' | 'stopped' | 'unknown'

/** Why a command never started: the plugin or the launcher refused it before the kernel was asked. */
export type RunRefusalCode =
  | 'bad-request'
  | 'cwd-spelling'
  | 'cwd-gone'
  | 'cannot-scan'
  | 'hard-links'
  | 'launcher-unavailable'
  | 'no-profile'
  /** The modes set on this Mac, or a switch, do not allow what the command asked for. */
  | 'policy'
  | 'profile-unknown'
  | 'other'

/** Why a run was started with less than it asked for (the launcher's word on its start row). */
export type RunNarrowedWhy =
  'needs-allow' | 'needs-file-writing' | 'needs-network' | 'needs-web-browsing' | 'unlisted-folder'

/** Who issued a confined command, as the launcher read the request: the agent (its terminal, its tools), or the
 *  runtime's own housekeeping (the shell environment's session snapshot and shell probes, the runtime's environment
 *  probes), confined like any other command but not something the agent asked for. */
export type RunOrigin = 'agent' | 'runtime'

export interface RunView {
  /** The run token's name (members.ts): stable from start to end. */
  id: string
  origin: RunOrigin
  /** shell: the agent's terminal · program: an app-fixed helper (browser, media, probe). */
  kind: 'program' | 'shell'
  cls: ActivityClass | null
  /** Full sha256 of the profile text the run started under. */
  profileSha: string
  sessionId: string | null
  /** What ran, as the launcher saw it (the agent's script, or the helper's argv), clipped. */
  command: string
  cwd: string | null
  projectRoot: string | null
  network: boolean
  writeProject: boolean
  startedAt: string
  endedAt: string | null
  phase: RunPhase
  exitCode: number | null
  /** The signal that ended it (9 after Stop), when one did. */
  signal: number | null
  rootPid: number | null
  /** Processes of this run alive now, by the kernel's membership (0 once it is over). */
  live: number
  /** Kernel refusals attributed to this run: the rows of its own refusal file, the same number while it runs and
   *  after it ends (capped there, never an accumulator). */
  refusals: number
  refusedReason: RunRefusalCode | null
  /** The plugin's or launcher's sentence for a refusal (English, logs and tooltips; the pane words the code), with the
   *  count and the last time when the view stands for several identical refusals. */
  refusedDetail: string | null
  /** A refused view: how many identical refusals it stands for (`startedAt` the first, `endedAt` the last). */
  refusedCount?: number
  /** The launcher's word: the folder was asked for through a link to one outside the run's project. */
  cwdLink?: boolean
  /** fx29: the live count is a process whose run record is gone, shown under this row by the clock; it may be another's. */
  orphanLive?: boolean
  /** What it left running has ended by itself: the launcher knows that and when, not that command's status. */
  backgroundEnded?: boolean
  /** It was started with less than it asked for: `writeProject` and `network` say what it had. Absent: not narrowed. */
  narrowed?: boolean
  /** Why, when the launcher gave a reason this app knows. */
  narrowedWhy?: RunNarrowedWhy | null
  /** Phase `stopped`, and the owner's Stop is on record. Absent: nobody can say the owner did it (the agent's process
   *  tool, the launcher at quit, the modes). */
  stoppedByOwner?: boolean
  /** Phase `stopped`, and the launcher stopped it because the modes changed, not the owner's Stop. */
  stoppedByModes?: boolean
  /** The launcher's sentence for that stop (English, data). */
  stoppedDetail?: string | null
  /** Who recorded the run: the launcher's own ledger, or the runtime's refusal file (its word, not the launcher's). */
  reportedBy?: 'launcher' | 'runtime'
}

/** The runtime's own confinement (Hermes and the interpreter children it starts), as the kernel reports it. */
export interface RuntimeConfinementView {
  /** on: Hermes runs inside the runtime profile (kernel-checked) · off: runtime confinement is not configured
   *  (confinement is off, or not macOS) · stopped: it is configured but no runtime process exists (not started yet,
   *  or it exited) · broken: a runtime process runs and the kernel does not hold it in the runtime profile (or could
   *  not be asked). */
  state: 'broken' | 'off' | 'on' | 'stopped'
  profileSha: string | null
  /** The launcher that starts confined commands outside the runtime's sandbox: up, down (not answering, or not
   *  running while runtime confinement is configured: commands are refused), off only when it is not configured. */
  launcher: 'down' | 'off' | 'up'
  pids: number[]
  /** What the runtime profile allows, for the Profiles view (paths as main generated them; empty when off). */
  reads: string[]
  writes: string[]
  denied: string[]
}

export interface AgentActivityView {
  sessionId: string
  inft: string | null
  lastTs: string
  /** The last few audited actions for this session, newest first. */
  actions: { ts: string; kind: string; tool: string; target: string; outcome: string | null }[]
  inside: number
  outside: number
}

export type ConfinementVerdict = 'green' | 'off' | 'red'

/** Why the verdict is red, as data: the pane words each one from the catalogue. */
export type ConfinementReason =
  | { code: 'backend-not-confining'; backend: ConfinementBackendId; detail: BackendDetail | null }
  | { code: 'profile-changed'; cls: ActivityClass }
  | { code: 'widened-profile'; pid: number; sha: string }
  | { code: 'unknown-profile'; pid: number; sha: string }
  | { code: 'agent-command-outside'; pid: number }
  /** Carries the confinement marker, yet the kernel says no icloneOS sandbox holds it (forged, or widened past ours). */
  | { code: 'forged-marker'; pid: number }
  /** Hermes runs but its confinement plugin never said it loaded: the agent's shell is refused, not confined. */
  | { code: 'plugin-not-loaded' }
  /** Hermes runs, but the kernel does not hold it in the runtime profile. */
  | { code: 'runtime-not-confined'; pid: number }
  /** Runtime confinement is configured, but no runtime process exists: no command can run until it starts. */
  | { code: 'runtime-not-running' }
  /** The launcher is not answering: confined commands are refused until it is back. */
  | { code: 'launcher-down' }
  /** The runtime's own confinement plugin says the agent's commands cannot run now (its terminal tool is withheld), and
   *  why, in its words (English, clipped). A fact the runtime reports, not one the kernel checked: it can only turn the
   *  verdict red, never green (green still needs every kernel fact). */
  | { code: 'agent-commands-unavailable'; reason: string; reportedBy: 'runtime' }
  /** The kernel could not be asked which processes are confined: counts and Kill fall back to ancestry. */
  | { code: 'membership-unverified' }
  | { code: 'agent-config-unreadable' }
  /** A hard link to an outside inode appeared in `root` while run `pid` was running (the scan after its exit found
   *  it). It could not be prevented, only detected: the run is over and the next one is refused until it is allowed. */
  | { code: 'hardlink-appeared'; pid: number; root: string; path: string }
  /** The settings file on disk was not signed by this app (forged, edited, or left by another install): it was
   *  ignored and confinement runs with its defaults, on (T7, F8). */
  | { code: 'settings-ignored' }

/** One directory group of hard-linked files the owner may allow with one gesture (T2): every open inode whose
 *  inside name lies under `dir` at the moment main scanned; `digest` fingerprints that exact {dev, ino} set, so the
 *  gesture allows what the pane showed and nothing planted since. `paths` names up to three. */
export interface HardlinkGroupView {
  dir: string
  paths: string[]
  count: number
  digest: string
}

/** CF5 (B3-n5): what a `changed` notice may carry. With `firstScan`, only the running first scan's count moved: the
 *  window updates its line from it without reading the whole state again. Without a payload, read the state. */
export interface ConfinementChangeNotice {
  firstScan: HardlinkFirstScanView
}

/** CF5 (B3-n2): one page of a refused group's file names (the view carries the first 1 000), so "Show all" reaches
 *  every one. `changed`: the group is not the one the pane read (read the state again). */
export type HardlinkGroupPathsResult =
  { ok: true; count: number; offset: number; paths: string[] } | { ok: false; reason: 'changed' | 'invalid' }

/** A project confinement refused to start in (F7). `hard-links`: files there are hard links whose other name lies
 *  outside it; `paths` names up to three, `count` is how many such inodes are not acknowledged, `groups` is the same
 *  set by directory. `cannot-scan`: directories inside it could not be listed (`paths`, `count`), so nothing can be
 *  proven; fail closed until the owner fixes their permissions (no group to allow). */
export interface HardlinkBlockView {
  root: string
  kind: 'cannot-scan' | 'hard-links'
  paths: string[]
  count: number
  groups: HardlinkGroupView[]
}

/** v0.0.7 CF1: a root's FIRST hard-link scan while it runs (no completed scan of it yet), so the chat can say why a start
 *  waits ("Checking the project folder: N folders so far"). `root` is the project as main resolved it, `dirs` the
 *  folders the scan reached so far (updated at most every 100 ms), `startedAt` when the scan began (epoch ms). */
export interface HardlinkFirstScanView {
  root: string
  dirs: number
  startedAt: number
}

/** invalid: a malformed request · not-in-project: the directory is not under that root · changed: the files under
 *  that directory are not the set the pane showed (re-read, then decide again) · nothing-to-allow: no open hard link
 *  is left under it · no-gesture: no real click on the button. */
export type HardlinkAckFailure = 'changed' | 'invalid' | 'no-gesture' | 'not-in-project' | 'nothing-to-allow'

export type HardlinkAckResultView = { ok: true; dir: string; count: number } | { ok: false; reason: HardlinkAckFailure }

/** F41: the isolation switch, as main holds it. `on` is main's signed setting; only a click on the app's control and,
 *  for off, a native dialog change it (isolation-switch.ts). */
export interface IsolationView {
  on: boolean
  /** macOS only: elsewhere there is no sandbox and no control. */
  available: boolean
  /** Whether an off outlives the app (the settings key is sealed); otherwise isolation is on again at the next launch. */
  persists: boolean
  /** The kernel says a live agent is running under the other state: what the pane says does not hold for it yet. */
  runningDiffers: boolean
}

/** failed: the state changed, and the agent did not start again; nothing runs under the old state. */
export type IsolationSetResultView =
  | { ok: true; on: boolean; restart: 'done' | 'failed' | 'nothing-running'; error?: string }
  | { ok: false; on: boolean; reason: 'busy' | 'cancelled' | 'invalid' | 'no-gesture' | 'unsupported' }

export interface ConfinementStateView {
  schema: typeof CONFINEMENT_STATE_SCHEMA
  at: string
  backend: ConfinementBackendId
  /** On by default; no permission mode changes it, only the user's own click on the isolation control (G-98). */
  enabled: boolean
  isolation: IsolationView
  verdict: ConfinementVerdict
  reasons: ConfinementReason[]
  backends: BackendStatusView[]
  defaultClass: ActivityClass
  profiles: ProfileView[]
  inside: ConfinedProcessView[]
  outside: OutsideProcessView[]
  agents: AgentActivityView[]
  refusals: RefusalView[]
  /** L4-02: today's own refusal record, counted exactly; `olderRows` of them sit in closed parts of the day the list
   *  does not reach. Null until main's IPC handler adds it. */
  refusalDay: RefusalDayView | null
  /** Projects where confinement refuses to start until their hard links are removed or acknowledged. */
  hardlinks: HardlinkBlockView[]
  /** The first hard-link scan running now (the most recently started one), or null: none is. */
  firstScan: HardlinkFirstScanView | null
  /** Confined commands, newest first: the live ones, then the recent ended and refused ones. */
  runs: RunView[]
  /** Ended runs the ledger still holds beyond the bound of `runs`: the list says it stops short. */
  runsCut: number
  runtime: RuntimeConfinementView
  /** Said in the pane: the terminal tree and the file tools (they run through it) are confined; MCP servers and the
   *  browser run in Hermes itself. */
  scope: { confined: string[]; notConfined: string[] }
}

/** not-confined: the pid is not ours to stop · survivors: `survivors` processes of the run outlived SIGKILL ·
 *  unverified: the kernel could not be asked, so 0 survivors cannot be proven · invalid: a malformed request. */
export type KillFailure = 'invalid' | 'not-confined' | 'survivors' | 'unverified'

/** The owner's Stop on one run: every live process of it, by the kernel's membership (Kill's rules). */
export type StopRunResultView =
  | { ok: true; run: string; killed: number[] }
  | { ok: false; run: string; reason: KillFailure | 'not-running'; survivors: number[]; error: string }

export type KillResultView =
  | { ok: true; pid: number; killed: number[] }
  | { ok: false; pid: number; reason: KillFailure; survivors: number[]; error: string }
