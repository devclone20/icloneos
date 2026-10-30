// Renderer view of the diagnostics runner (electron/iclone-doctor.ts). Shapes only — main owns the logic.
import type { DiagnosticsFileView, DiagnosticsSaveResult } from '@/iclone-shared/diagnostics-file'
import { formatAgo, toEpochMs } from '@/iclone-shared/time'

export type DoctorStatus = 'fail' | 'pass' | 'skip' | 'warn'
type DoctorRisk = 'high' | 'low' | 'medium'

export interface DoctorCheckRow {
  id: string
  title: string
  status: DoctorStatus
  detail: string
  fixId?: string
  risk?: DoctorRisk
  consent?: string | null
  durationMs: number
}

interface DoctorPackRow {
  id: string
  title: string
  status: DoctorStatus
  checks: DoctorCheckRow[]
}

export interface DoctorReport {
  schema: number
  startedAt: string
  durationMs: number
  live: boolean
  status: DoctorStatus
  counts: Record<DoctorStatus, number>
  packs: DoctorPackRow[]
  lines: string[]
}

interface DoctorFixDef {
  id: string
  title: string
  risk: DoctorRisk
  consent: string | null
}

export interface DoctorCatalogue {
  packs: { id: string; title: string; checks: { id: string; title: string }[]; fixes: DoctorFixDef[] }[]
  errors: string[]
}

export interface DoctorFixResult {
  ok: boolean
  fixId: string
  dryRun: boolean
  plan: string[]
  applied: boolean
  backupDir: string | null
  undo: string
  refused?: 'consent' | 'risk' | 'unknown'
  needsConsent?: string
  error?: string
}

export interface DoctorProgress {
  packId: string
  done: number
  total: number
}

export interface IcloneDoctorBridge {
  list: () => Promise<DoctorCatalogue | null>
  run: (options?: { packs?: string[]; live?: boolean }) => Promise<DoctorReport | null>
  fix: (input: { fixId: string; dryRun: boolean }) => Promise<DoctorFixResult | null>
  report: () => Promise<DoctorReport | null>
  openLogs: () => Promise<boolean | null>
  /** FX-7: the report a save would write, and its parts (null: not a trusted sender). */
  diagnosticsPreview?: (input: { errorContext?: string }) => Promise<DiagnosticsFileView | null>
  /** FX-7: asks main to write it to a file the owner chooses in a native save dialog. */
  diagnosticsSave?: (input: { errorContext?: string }) => Promise<DiagnosticsSaveResult | null>
  onProgress: (callback: (progress: DoctorProgress) => void) => () => void
}

/** Pure: one row per catalogue pack, with its status from the report when there is one. */
const isPackRow = (p: unknown): p is DoctorPackRow =>
  typeof p === 'object' &&
  p !== null &&
  typeof (p as DoctorPackRow).id === 'string' &&
  Array.isArray((p as DoctorPackRow).checks) &&
  (p as DoctorPackRow).checks.every(c => typeof c === 'object' && c !== null && typeof c.id === 'string')

/** A junk report (old schema, hand-edited file) degrades to "not run yet", never to a crash. */
export function packRows(catalogue: DoctorCatalogue | null, report: DoctorReport | null): DoctorPackRow[] {
  const packs: DoctorPackRow[] = Array.isArray(report?.packs) ? (report.packs as unknown[]).filter(isPackRow) : []

  if (!catalogue) {
    return packs
  }

  return catalogue.packs.map(
    pack =>
      packs.find(p => p.id === pack.id) ?? {
        id: pack.id,
        title: pack.title,
        status: 'skip',
        checks: []
      }
  )
}

export function formatRunDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

export function ageLabel(
  iso: string,
  now: number,
  copy: { justNow: string; minAgo(n: number): string; hoursAgo(n: number): string; daysAgo(n: number): string }
): string {
  const ms = toEpochMs(iso)

  if (ms === null) {
    return copy.justNow
  }

  return formatAgo(
    ms,
    { now: copy.justNow, minutes: copy.minAgo, hours: copy.hoursAgo, days: copy.daysAgo },
    { nowMs: now, rounding: 'round' }
  )
}
