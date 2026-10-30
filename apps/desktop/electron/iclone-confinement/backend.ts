/**
 * V3-G §1 — the one seam every confinement backend implements. Seatbelt is deprecated and Apple offers no
 * replacement, so the product talks to this interface only: the day `sandbox-exec` goes, one implementation changes
 * and nothing else (G6). Nothing here keeps a count: `list` folds a fresh `ps` snapshot every time.
 */
import type { ChildProcess } from 'node:child_process'

import type {
  ActivityClass,
  BackendStatusView,
  ConfinedProcessView,
  ConfinementBackendId,
  HardlinkBlockView,
  KillResultView
} from '../../src/iclone-shared/confinement'

import type { Snapshot } from './state'

export interface SpawnRequest {
  cls: ActivityClass
  argv: readonly string[]
  cwd: string
  env?: Readonly<Record<string, string | undefined>>
  /** The project the command may write when `writeProject` is true. Refused roots fall back to the scratch dir. */
  projectRoot: string | null
  /** From the permission mode and live grants (V3-F): the class may only open the network when this is true. */
  network: boolean
  writeProject: boolean
  sessionId?: string | null
  outputDir?: string | null
}

export type SpawnResult =
  | { ok: true; pid: number; child: ChildProcess; marker: string; params: Record<string, string> }
  | { ok: false; error: string; hardlinks?: HardlinkBlockView }

export interface ConfinementBackend {
  readonly id: ConfinementBackendId
  probe(): Promise<BackendStatusView>
  spawn(request: SpawnRequest): SpawnResult
  /** The processes this backend confines, derived from one `ps` snapshot and the kernel's membership answer. */
  list(snapshot: Snapshot): ConfinedProcessView[]
  /** Stops the run `pid` belongs to; succeeds only once a fresh snapshot shows none of it alive. */
  kill(pid: number): Promise<KillResultView>
  /** Plain lines: which profile a confined process runs under and what it allows. */
  explain(pid: number, snapshot: Snapshot): string[]
}

/** `$0` of the confined shell: `iclone-confined:<class>:<profile sha, 12 hex>:<session or ->`. Always the last argv. */
const MARKER_PREFIX = 'iclone-confined'
const MARKER_RE = /(?:^|\s)iclone-confined:([a-z]+):([0-9a-f]{12}):([A-Za-z0-9_.-]{1,64})$/

export function confinementMarker(cls: ActivityClass, sha256: string, sessionId: string | null | undefined): string {
  const session = sessionId && /^[A-Za-z0-9_.-]{1,64}$/.test(sessionId) ? sessionId : '-'

  return `${MARKER_PREFIX}:${cls}:${sha256.slice(0, 12)}:${session}`
}

export function parseMarker(command: string): { cls: string; sha12: string; sessionId: string | null } | null {
  const match = MARKER_RE.exec(command)

  return match ? { cls: match[1], sha12: match[2], sessionId: match[3] === '-' ? null : match[3] } : null
}
