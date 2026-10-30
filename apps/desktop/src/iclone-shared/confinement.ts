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

export const CONFINEMENT_STATE_SCHEMA = 'iclone.confinement.state/6'

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

export type OutsideKind = 'agent-command' | 'hermes' | 'tool'

export interface OutsideProcessView {
  pid: number
  ppid: number
  kind: OutsideKind
  elapsedSec: number
  command: string
}

export interface RefusalView {
  ts: string
  pid: number
  process: string
  operation: string
  target: string
  sessionId: string | null
  /** Rows the layer writes itself (`hard-link-appeared`, T3): the project root the scan after the run looked at. */
  root?: string
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
  /** The kernel could not be asked which processes are confined: counts and Kill fall back to ancestry. */
  | { code: 'membership-unverified' }
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

/** invalid: a malformed request · not-in-project: the directory is not under that root · changed: the files under
 *  that directory are not the set the pane showed (re-read, then decide again) · nothing-to-allow: no open hard link
 *  is left under it · no-gesture: no real click on the button. */
export type HardlinkAckFailure = 'changed' | 'invalid' | 'no-gesture' | 'not-in-project' | 'nothing-to-allow'

export type HardlinkAckResultView = { ok: true; dir: string; count: number } | { ok: false; reason: HardlinkAckFailure }

export interface ConfinementStateView {
  schema: typeof CONFINEMENT_STATE_SCHEMA
  at: string
  backend: ConfinementBackendId
  /** Confinement stays on in every permission mode, Ignore permissions included (owner decision D2). */
  enabled: boolean
  verdict: ConfinementVerdict
  reasons: ConfinementReason[]
  backends: BackendStatusView[]
  defaultClass: ActivityClass
  profiles: ProfileView[]
  inside: ConfinedProcessView[]
  outside: OutsideProcessView[]
  agents: AgentActivityView[]
  refusals: RefusalView[]
  /** Projects where confinement refuses to start until their hard links are removed or acknowledged. */
  hardlinks: HardlinkBlockView[]
  /** Said in the pane: the terminal tree and the file tools (they run through it) are confined; MCP servers and the
   *  browser run in Hermes itself. */
  scope: { confined: string[]; notConfined: string[] }
}

/** not-confined: the pid is not ours to stop · survivors: `survivors` processes of the run outlived SIGKILL ·
 *  unverified: the kernel could not be asked, so 0 survivors cannot be proven · invalid: a malformed request. */
export type KillFailure = 'invalid' | 'not-confined' | 'survivors' | 'unverified'

export type KillResultView =
  | { ok: true; pid: number; killed: number[] }
  | { ok: false; pid: number; reason: KillFailure; survivors: number[]; error: string }
