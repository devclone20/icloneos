/**
 * V3-F — the permission vocabulary shared by main (electron/iclone-permissions) and the window (Settings › Agent ›
 * Permissions, the consent sheet). Plain TS: no DOM or Node imports. Main owns every decision; the window only reads
 * these shapes and asks main to change the mode on the user's own click.
 */

export const PERMISSION_MODES = ['ignore', 'manual', 'automatic', 'plan', 'acceptEdits'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** R read · Wp write in project · Wo write outside · X shell · N network · $ spend · M message · S system permission ·
 *  I install · D delete. */
export const ACTION_CLASSES = ['R', 'Wp', 'Wo', 'X', 'N', '$', 'M', 'S', 'I', 'D'] as const
export type ActionClass = (typeof ACTION_CLASSES)[number]

export type ModeScope = 'project' | 'session' | 'standing'
export type PermissionDoorScope = 'once' | ModeScope

/** V3-F2 — the functions a user sets a level for (Settings › Agent › Permissions › Functions), in display order. The
 *  order also breaks ties when several functions decide a call equally strictly. */
export const PERMISSION_FUNCTIONS = [
  'email',
  'payments',
  'trading',
  'shopping',
  'acp',
  'messaging',
  'shell',
  'files',
  'publish'
] as const
export type PermissionFunction = (typeof PERMISSION_FUNCTIONS)[number]

/** V3-F2 — `mode` follows the global mode (the shipped default, V3-F's behaviour); the other five are the user's. */
export const FUNCTION_LEVELS = ['mode', 'ignore', 'automatic', 'askOnce', 'askAlways', 'manual'] as const
export type FunctionLevel = (typeof FUNCTION_LEVELS)[number]
export type FunctionLevels = Record<PermissionFunction, FunctionLevel>

/**
 * V3-F2 lead contingency (r5) — one flag, the same on both sides (`F2_LOOSENING_ENABLED` in the plugin's policy.py,
 * held equal by the fixture). `false` ships Functions as TIGHTENING ONLY: the levels that can allow what Follow mode
 * would ask (`LOOSENING_LEVELS`) are unreachable from the pane, the IPC and the stored file, and the plugin reads them
 * as Follow mode. What stays: Follow mode (the default), Ask always and Manual (off).
 */
export const F2_LOOSENING_ENABLED = true
export const LOOSENING_LEVELS: readonly FunctionLevel[] = ['ignore', 'automatic', 'askOnce']

/** Is `level` reachable with the loosening levels on or off? (Callers pass `F2_LOOSENING_ENABLED`.) */
export const levelOffered = (level: FunctionLevel, loosening: boolean): boolean =>
  loosening || !LOOSENING_LEVELS.includes(level)

// The switches any row can meet: an unknown tool reaches every row through the terminal switch, and a shell line's
// class brings its own switch to every row the line touches (spend, message, install, automation, delete).
const SHELL_LINE_CEILINGS = ['terminal', 'spendTrade', 'sendMessages', 'installSoftware', 'automation', 'fileWriting']

/**
 * V3-F2 (R2-m6) — every Privacy switch a function's actions can meet: the pane marks a row when any of them is OFF
 * (those actions stay refused) or undecided (an allow asks first). The plugin side holds each structured tool's own
 * switch to its row (tests/plugins/test_iclone_permissions_functions.py, through the fixture).
 */
export const FUNCTION_CEILING_KEYS: Readonly<Record<PermissionFunction, readonly string[]>> = {
  email: SHELL_LINE_CEILINGS,
  payments: SHELL_LINE_CEILINGS,
  trading: SHELL_LINE_CEILINGS,
  shopping: SHELL_LINE_CEILINGS,
  acp: SHELL_LINE_CEILINGS,
  messaging: SHELL_LINE_CEILINGS,
  shell: [...SHELL_LINE_CEILINGS, 'scheduledTasks'],
  files: SHELL_LINE_CEILINGS,
  publish: [...SHELL_LINE_CEILINGS, 'webBrowsing']
}

export const isPermissionFunction = (value: unknown): value is PermissionFunction =>
  typeof value === 'string' && (PERMISSION_FUNCTIONS as readonly string[]).includes(value)

export const isFunctionLevel = (value: unknown): value is FunctionLevel =>
  typeof value === 'string' && (FUNCTION_LEVELS as readonly string[]).includes(value)

interface PermissionGrantView {
  id: string
  cls: ActionClass
  scope: ModeScope
  sessionId: string | null
  project: string | null
  createdAt: string
  source: 'hermes-allowlist' | 'prompt'
}

/** V3-F2 — a grant the owner gave one function from an Ask once sheet. */
interface FunctionGrantView {
  id: string
  fn: PermissionFunction
  scope: ModeScope
  sessionId: string | null
  project: string | null
  createdAt: string
}

/** A-1: the permission state files main authenticates (electron/iclone-permissions/store.ts), by role. */
export type PermissionStateFile = 'fnGrants' | 'functions' | 'grants' | 'mode'

/**
 * Why a state file is not in force as written: `tampered` (present, refused: edited, damaged or another key's),
 * `unverified` (saved by an earlier version or while the Keychain was off, so nobody could sign it), `missing`
 * (deleted while a sibling verifies). The store lands each on its narrowest reading; the pane says so.
 */
export type PermissionIntegrityProblem = 'missing' | 'tampered' | 'unverified'

export interface PermissionIntegrityFinding {
  file: PermissionStateFile
  problem: PermissionIntegrityProblem
}

export interface PermissionStateView {
  /**
   * Whether the master key was sealed in the system keychain at launch. An unsealed policy clamps to Manual
   * everywhere, so the levels below are the user's stored CHOICE. A choice made unsealed takes effect only after a
   * sealed launch AND its confirmation on the system dialog (see `unconfirmed`). The matrix uses it to say that
   * instead of refusing every cell silently.
   */
  sealed: boolean
  /**
   * Functions whose level in `functions` was chosen while the policy was not sealed. No system dialog was shown for
   * it, so it is NOT in force — the row acts as Manual, sealed or not — until the user confirms it on the dialog.
   */
  unconfirmed: PermissionFunction[]
  mode: {
    standing: PermissionMode
    projects: Record<string, PermissionMode>
    sessions: Record<string, PermissionMode>
    updatedAt: string
  }
  grants: PermissionGrantView[]
  /** V3-F2 — the level of every function (all nine, always) and the function grants. */
  functions: FunctionLevels
  fnGrants: FunctionGrantView[]
  ceilings: Record<string, 'off' | 'on' | 'undecided'>
  chain: { ok: boolean; records: number; gaps: number }
  /** A-1: every state file not in force as written (one alert line each in the pane); empty when all verify. */
  integrity: PermissionIntegrityFinding[]
  project: string | null
  /** Whether the permission gate in the running Hermes is proven loaded and answering (main's own observation). */
  enforcement: PermissionEnforcement
}

const PERMISSION_ENFORCEMENT = ['degraded', 'enforced', 'no-agent', 'not-enforced', 'starting'] as const
type PermissionEnforcement = (typeof PERMISSION_ENFORCEMENT)[number]

export interface AuditRecordView {
  seq_main: number
  ts: string
  kind: string
  mode: PermissionMode | null
  scope: string | null
  class: ActionClass | null
  action: { tool: string; target: string; project_root: string | null } | null
  agent: { inft: string | null; session_id: string | null } | null
  answer: string | null
  reason: string | null
  /** Who wrote the record, the Hermes process it names and whether the owner's own click was seen (all in main's
   *  record; the Activity list says a record from them, never from `reason`). */
  src?: string | null
  hermes_pid?: number | null
  gesture?: boolean | null
  /** V3-F2 — the function that decided the call, or whose level changed. Absent on V3-F-era records. */
  fn?: PermissionFunction | null
  level?: FunctionLevel | null
  prev_level?: FunctionLevel | null
}

export type SetModeResultView =
  | { ok: true; mode: PermissionMode; scope: ModeScope }
  | { ok: false; error: 'confirm' | 'gesture' | 'invalid'; message: string }

export type SetFunctionLevelResultView =
  | { ok: true; fn: PermissionFunction; level: FunctionLevel; raised: boolean }
  | { ok: false; error: 'confirm' | 'gesture' | 'invalid'; message: string }
