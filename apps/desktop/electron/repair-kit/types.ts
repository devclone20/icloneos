/**
 * v0.0.9 F3 — the repair kit's shapes, shared by main (electron/repair-kit/kit.ts, ipc.ts) and the renderer
 * (Settings › Diagnostics › Repair kit, the boot-failure card). Pure types and constants: no Node, no Electron.
 *
 * The kit repairs by KNOWN CLASSES. Each class: detect → plan → (on the owner's own click) back up dated, move aside
 * (never delete), apply, verify, report — and undo from the dated manifest.
 */

export const REPAIR_CLASS_IDS = [
  /** `~/.hermes/installs/<runtime key>` left by an older layout: the runtime takes it as its owner and cannot write it
   *  under the sandbox (the 14 Nov 2026 case). */
  'stale-install-record',
  /** The runtime's own dependency record names a missing or broken venv (another version, a dangling interpreter). */
  'runtime-venv',
  /** `plugins.disabled` in config.yaml (or a profile's) lists the app's own iclone plugins. */
  'plugins-disabled',
  /** The roots (`~/.hermes`, the app's data folder, the runtime, the sandbox profiles) are links, foreign-owned or
   *  writable by group/others. */
  'root-permissions',
  /** The last start was refused by the permission gate. */
  'gate-not-starting',
  /** A socket or port of the app is held by a leftover. */
  'port-busy',
  /** Backends this app started (by its own pid records) whose app process is gone. */
  'orphan-processes'
] as const

export type RepairClassId = (typeof REPAIR_CLASS_IDS)[number]

export function isRepairClassId(value: unknown): value is RepairClassId {
  return typeof value === 'string' && (REPAIR_CLASS_IDS as readonly string[]).includes(value)
}

/**
 * ok: nothing to do · found: the kit can repair it · manual: something is wrong that only the owner can change (a link,
 * a foreign owner) — the kit says what and touches nothing · skipped: the class does not apply here (dev layout).
 */
export type RepairFindingStatus = 'found' | 'manual' | 'ok' | 'skipped'

export interface RepairFinding {
  classId: RepairClassId
  status: RepairFindingStatus
  /** Plain facts (paths, names, pids) behind the verdict, for the report. */
  facts: string[]
}

export type RepairStep =
  | { kind: 'move-aside'; from: string; to: string }
  | { kind: 'chmod'; path: string; fromMode: number; toMode: number }
  | { kind: 'edit-config'; file: string; remove: string[]; preSha256: string; nextText: string }
  | { kind: 'reap-orphans'; pids: number[] }
  | { kind: 'reinstall-runtime' }

/** A step as it ran: kept in the manifest so undo can replay it backwards. */
export interface AppliedStep {
  step: RepairStep
  ok: boolean
  detail?: string
  /** edit-config: where the original was copied, and the file's hash after the edit (undo restores only over it). */
  backup?: string
  postSha256?: string
}

export interface RepairReport {
  classId: RepairClassId
  dryRun: boolean
  ok: boolean
  /** What the kit found before acting. */
  before: RepairFinding
  steps: RepairStep[]
  applied: AppliedStep[]
  /** The class re-checked after the repair (null for a dry run). */
  after: RepairFinding | null
  /** 'now': verified by the re-check · 'next-start': verified by the next start of the agent (a reinstall). */
  verify: 'next-start' | 'now' | null
  manifestId: string | null
  manifestDir: string | null
  /** Why nothing ran: no owner click, another repair under way, or a step failed (and was rolled back). */
  refused?: 'busy' | 'gesture'
  /** A step failed and the kit rolled back: `applied` then lists only the steps that could NOT be put back. */
  rolledBack?: boolean
  error?: string
}

export interface RepairManifest {
  schema: 1
  id: string
  classId: RepairClassId
  createdAt: string
  appVersion?: string
  applied: AppliedStep[]
  undoneAt: string | null
}

export interface RepairHistoryEntry {
  id: string
  classId: RepairClassId
  createdAt: string
  undoneAt: string | null
  /** True while at least one step can still be put back. */
  undoable: boolean
}

export interface UndoReport {
  ok: boolean
  manifestId: string
  restored: string[]
  /** `outside-home`: the manifest names a path outside the app's and the agent's folders (never touched). */
  skipped: { what: string; reason: 'changed-since' | 'missing' | 'not-undoable' | 'occupied' | 'outside-home' }[]
  refused?: 'busy' | 'gesture' | 'unknown-manifest' | 'already-undone'
  error?: string
}

/** The bridge the preload exposes as `window.hermesDesktop.iclone.repairKit` (requested from F1-S, v0.0.9). */
export interface RepairKitBridge {
  scan(): Promise<RepairFinding[] | null>
  /** dryRun defaults to true; a real repair carries the owner's click (`data-repair-kit-confirm`). */
  apply(input: { classId: RepairClassId; dryRun?: boolean }): Promise<RepairReport | null>
  undo(manifestId: string): Promise<UndoReport | null>
  history(): Promise<RepairHistoryEntry[] | null>
}

/** The attribute the preload's owner-click lock looks for on a repair or undo control. */
export const REPAIR_KIT_CONFIRM_ATTR = 'data-repair-kit-confirm'
