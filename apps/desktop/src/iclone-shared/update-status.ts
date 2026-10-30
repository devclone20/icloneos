/**
 * App Atualisation — the wire contract between electron/iclone-updates.ts and
 * the Settings pane (single source; `src/types/iclone-updates.ts` and
 * `electron/iclone-updates.ts` re-export it). Types only: the main process and
 * the renderer both import this file, so it must stay free of Electron, Node
 * and React.
 */

// ── Track B: the fork vs upstream ──────────────────────────────────────────

export interface IcloneUpstreamDiff {
  deletions: number
  files: number
  insertions: number
}

/** A release tag on upstream: the only kind of point a re-import may start from. */
export interface IcloneUpstreamTag {
  /** Tagger (or commit) date, ISO 8601. */
  date: string
  name: string
  /** The tagged COMMIT, 40 hex (annotated tags are peeled). */
  sha: string
}

export interface IcloneUpstreamStatus {
  available: boolean
  /** Our own HEAD in the fork's history. */
  baseCommit?: string
  baseSubject?: string
  /** Commits on upstream/main since the import base. The real distance. */
  behind?: number
  /** Content distance between the imported tree and upstream's tip. */
  diff?: IcloneUpstreamDiff
  /** When git actually fetched, ISO 8601. A cached answer keeps its original time. */
  fetchedAt?: string
  /** The newest upstream RELEASE tag (canaries and pre-releases excluded). */
  latestTag?: IcloneUpstreamTag | null
  /** Our commits a re-import must replay: on HEAD, not the parentless import. */
  ownCommits?: number
  reason?: string
  recent?: string[]
  /** Set when a forced re-check failed and this is the last good answer. */
  refreshError?: string
  /** A cache-only read found nothing: no fetch has run in this app session. */
  unchecked?: boolean
  /** The upstream commit our tree was imported from (`iclone/UPSTREAM_BASE`). */
  upstreamBase?: string
  /** Upstream's current main tip, as `<short sha> <subject>`. */
  upstreamTip?: string
}

export interface IcloneUpstreamCheckOptions {
  /** Answer from the main-process cache only; never runs git. */
  cacheOnly?: boolean
  /** Bypass the main-process cache and fetch upstream now. */
  force?: boolean
}

// ── Track A: the Hermes runtime beneath the app ────────────────────────────

interface IcloneRuntimeHead {
  /** Committer date, ISO 8601. */
  date: string
  sha: string
  short: string
  subject: string
}

/** One side of an update, as the updater recorded it. */
export interface IcloneCodeIdentity {
  sha: null | string
  version: null | string
}

/**
 * The pre-update backup as the receipt recorded it: a `step` when the updater
 * tried it, a `skip` when it was switched off on purpose.
 */
interface IcloneReceiptBackup {
  detail: string
  kind: 'skip' | 'step'
  ok: boolean
}

export type IcloneReceiptOutcome = 'failed' | 'partial' | 'running' | 'success' | 'unknown'

/** `~/.hermes/logs/update_receipts/*.json` (schema 1), reduced to what the pane shows. */
export interface IcloneUpdateReceipt {
  backup: IcloneReceiptBackup | null
  finishedAt: null | string
  /** Bare `--flags` of the run; values and paths are dropped. */
  flags: string[]
  outcome: IcloneReceiptOutcome
  post: IcloneCodeIdentity
  pre: IcloneCodeIdentity
  startedAt: string
  /** `--gateway` in argv: the desktop's "Update now", not a terminal run. */
  viaDesktop: boolean
}

export interface IcloneBackupZip {
  bytes: number
  /** mtime, ISO 8601. */
  at: string
  name: string
}

export interface IcloneRuntimeStatus {
  available: boolean
  /** The newest `pre-update-*.zip` under HERMES_HOME/backups. */
  backupZip: IcloneBackupZip | null
  branch: null | string
  dirty: boolean | null
  head: IcloneRuntimeHead | null
  /** When these local reads ran, ISO 8601. */
  readAt: string
  reason?: string
  receipt: IcloneUpdateReceipt | null
  /** The last agent update the pane shows as a receipt card; null = none recorded. */
  lastUpdate?: IcloneAgentLastUpdate | null
  /** Short shas of the rollback clones under ~/.hermes-update-backups, newest first. */
  rollbackClones: string[]
  /** HERMES_HOME/hermes-agent — what both desktop apps run. */
  runtimeRoot: string
  shallow: boolean | null
  /** The tree the desktop's own updater would fetch and rewrite. */
  updaterRoot: string
  updaterRootIsRuntime: boolean
  /**
   * V3-S r4 (ruling 36): the agent runs a checkout the dev-backend setting chose, not the app's own runtime — the gate
   * only verifies it and loads its plugins from the app; the pane says "unmanaged runtime".
   */
  unmanaged?: boolean
  /** The receipt's post-update version, only when it describes HEAD; null = unknown. */
  version: null | string
}

// R1 — curated-only updates (electron/update-policy.ts, electron/update-runtime-align.ts)
type IcloneUpdatePolicy = 'curated' | 'developer'

export interface IcloneRuntimeAlignRecord {
  answer: 'align' | 'later'
  at: string
  error?: string
  head: string
  pinSha: string
  result?: 'aligned' | 'failed'
}

export interface IcloneUpdatePolicyInfo {
  align: IcloneRuntimeAlignRecord | null
  override: null | { at: string; by: string; policy: 'developer' }
  packaged: boolean
  pin: { date: string; sha: string; verified: string }
  policy: IcloneUpdatePolicy
  /** Hermes's own update check was turned off for this HERMES_HOME (curated). */
  runtimeCheckOff: boolean
}

export interface IcloneSetDeveloperPolicyResult {
  error?: string
  ok: boolean
  restartRequired?: boolean
}

// U1 — the user-run agent update (door `agent-latest`): Settings › Updates › Agent.
// Nothing here is fetched on its own: every value comes from one user click.

export type IcloneCompatVerdictName = 'AMBER' | 'GREEN' | 'RED' | 'UNKNOWN'

export interface IcloneAgentCompat {
  /** Short, human-readable finding titles (the compat engine's own wording). */
  findings: string[]
  verdict: IcloneCompatVerdictName
}

/** What runs now under HERMES_HOME/hermes-agent. */
export interface IcloneAgentInstalled {
  branch: null | string
  /** Committer date of HEAD, ISO 8601. */
  date: null | string
  dirty: boolean | null
  sha: null | string
  /** `__version__` of hermes_cli at HEAD. */
  version: null | string
  /** HEAD equals the pin this release was verified with (the floor, never a ceiling). */
  verifiedWithRelease: boolean
}

/** The tip of NousResearch/hermes-agent `main` — what `hermes update` installs. */
interface IcloneAgentLatest {
  /** Commits on `main` after the installed HEAD; null = the compare API was unavailable. */
  commitsNewer: null | number
  date: null | string
  /** Newest `v*` release tag, information only (never an update channel). */
  releaseTag: null | string
  sha: string
  /** Newest stable release the tip carries, `X.Y.Z`; null when no read could prove one. NOT a claim that the tip is
   *  that release — read `versionBasis` before rendering it. */
  version: null | string
  /** How literally `version` names this tip: 'exact' = the tip IS that release's commit, so render `vX.Y.Z`;
   *  'newer' = that release is in the tip and the tip carries commits beyond it, so render `vX.Y.Z+`. Absent (an
   *  older stored check, or `version: null`) must be rendered as 'newer' too — never as the bare release. */
  versionBasis?: 'exact' | 'newer'
}

type IcloneAgentCheckError = 'door-closed' | 'no-runtime' | 'offline' | 'unavailable'

/**
 * K-RT3 (V3-RT): Settings › Updates › Agent's upstream door ("agent latest", NousResearch main) is CLOSED in 0.0.3. The
 * agent runtime is built from icloneOS's own repository and ships inside the app (RUNTIME_PIN source "repo"); the
 * upstream tip has no iclone core, so the permission gate would fail closed and the agent would be read-only. Agent
 * updates come with app updates. Main refuses the check and the apply while the bundled pin is a repo pin; a test holds
 * this flag to that fact.
 */
export const AGENT_UPDATE_DOOR_OPEN = false

/** `hermes:agent-update:check` result, persisted to userData/agent-update-last-check.json. */
export interface IcloneAgentUpdateCheck {
  /** ISO 8601. */
  checkedAt: string
  /** Compat verdict of the TARGET tip against this app; null when it could not be computed. */
  compat: IcloneAgentCompat | null
  error: IcloneAgentCheckError | null
  installed: IcloneAgentInstalled
  latest: IcloneAgentLatest | null
  /** Latest is known and differs from HEAD. */
  updateAvailable: boolean
  /** The pin this release was verified with. */
  verified: { sha: string; version: null | string }
}

/** Single-use token minted by a real pointer/keyboard event on the confirm button (≤ 60 s). */
export interface IcloneAgentGesture {
  expiresAt: number
  token: string
}

export type IcloneAgentGestureResult =
  { gesture: IcloneAgentGesture; ok: true } | { error: 'no-user-activation'; ok: false }

export interface IcloneAgentUpdateApplyRequest {
  gestureToken: string
  targetSha: string
}

export type IcloneAgentApplyError =
  | 'app-update-pending'
  | 'compat-hold'
  | 'door-closed'
  | 'gesture'
  | 'handoff-failed'
  | 'no-check'
  | 'no-runtime'
  | 'origin-mismatch'
  | 'preflight-failed'
  | 'stale-check'
  | 'unsupported-platform'
  | 'updater-running'

export type IcloneAgentUpdateApplyResult =
  | { compat: IcloneAgentCompat | null; ok: true }
  | {
      /** RED/UNKNOWN target: the existing compat ack flow (owner hold) must run first. */
      compat?: IcloneAgentCompat | null
      error: IcloneAgentApplyError
      message: string
      ok: false
    }

/** userData/runtime-choice.json — a runtime the user chose; Repair never downgrades it. */
export interface IcloneRuntimeChoice {
  at: string
  door: 'agent-latest'
  sha: string
  version: null | string
}

/** The last agent update, from update_receipts/latest.json + the hand-off result. */
export interface IcloneAgentLastUpdate {
  /** Finished (or started, when unfinished), ISO 8601. */
  at: string
  /** Absolute path of the pre-update zip; null = none recorded. */
  backupZip: null | string
  durationMs: null | number
  from: IcloneCodeIdentity
  outcome: IcloneReceiptOutcome
  to: IcloneCodeIdentity
}

/** Pushed on `hermes:compat:changed`: a RED verdict is a passive flag (banner + nav dot), never an OS notification. */
export interface IcloneCompatFlag {
  at: string
  red: boolean
  verdict: IcloneCompatVerdictName
}
