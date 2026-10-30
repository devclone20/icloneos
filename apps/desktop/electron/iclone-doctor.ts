/**
 * The diagnostics runner: packs → a structured, redacted Report; fixes behind risk + consent gates with dry-run,
 * backup and undo. Local only — the network pack runs only on an explicit live run. Never throws: a check that
 * throws or hangs becomes a `fail` row.
 */
import fs from 'node:fs'
import path from 'node:path'

import { isRecord } from '../src/iclone-shared/guards'
import { redactSecrets } from '../src/iclone-shared/redact'

import type { ConsentPermissionKey } from './iclone-consent'
import {
  type Catalogue,
  type CheckDef,
  type CheckStatus,
  findFix,
  type FixDef,
  type FixRisk,
  NETWORK_PACK,
  type PackDef
} from './iclone-doctor-catalog'
import { type CheckImpl, CHECKS, type DoctorEnv, execAbsolute } from './iclone-doctor-checks'
import { applySteps, describeStep, FIXES, type FixImpl, isPassive } from './iclone-doctor-fixes'
import { writeFileAtomicSync } from './lib/atomic-write'

/** @public used by RESUME/run/gates/R13/extra/2026-10-17_r1_hostile.mjs */
export const REPORT_SCHEMA = 1
const PARALLEL = 3
const GLYPH: Record<CheckStatus, string> = { pass: '✓', warn: '⚠', fail: '✗', skip: '–' }

interface CheckResult {
  id: string
  title: string
  status: CheckStatus
  detail: string
  evidence?: string
  fixId?: string
  risk?: FixRisk
  consent?: ConsentPermissionKey | null
  durationMs: number
}

interface PackResult {
  id: string
  title: string
  status: CheckStatus
  checks: CheckResult[]
}

interface DoctorReport {
  schema: typeof REPORT_SCHEMA
  startedAt: string
  durationMs: number
  live: boolean
  status: CheckStatus
  counts: Record<CheckStatus, number>
  app: { version: string; electron: string; node: string; packaged: boolean; arch: string }
  os: { platform: string; release: string }
  packs: PackResult[]
  lines: string[]
}

interface FixResult {
  ok: boolean
  fixId: string
  dryRun: boolean
  plan: string[]
  applied: boolean
  backupDir: string | null
  undo: string
  risk?: FixRisk
  after?: CheckResult[]
  refused?: 'consent' | 'risk' | 'unknown'
  needsConsent?: ConsentPermissionKey
  error?: string
}

type DoctorActor = 'agent' | 'user'

export interface DoctorDeps {
  catalogue: Catalogue
  /** Everything a check needs except the per-run fields. */
  env: Omit<DoctorEnv, 'exec' | 'live' | 'signal'> & { exec?: DoctorEnv['exec'] }
  /** `<userData>/diagnostics` — last report + backups. */
  dataDir: string
  app: DoctorReport['app']
  osRelease: string
  consentAllows(key: ConsentPermissionKey): boolean
  checks?: Record<string, CheckImpl>
  fixes?: Record<string, FixImpl>
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g
const USER_PATH = /\/(Users|home)\/[^/\s'"]+/g
const API_KEY = /\b(sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}/g

// Also `GEMINI_API_KEY=…` (prefixed env names) and `"password": "…"` (JSON / YAML quoting).
const ASSIGNED =
  /\b((?:[A-Za-z0-9]+_)*(?:api[_-]?key|token|secret|password|passphrase|private[_-]?key|mnemonic))(["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi

// An EVM private key (or any 32-byte hex secret).
const HEX_KEY = /\b0x[0-9a-fA-F]{64}\b/g
const AWS_KEY_ID = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g
const BOT_TOKEN = /(?<![A-Za-z0-9])\d{6,12}:[A-Za-z0-9_-]{30,64}(?![A-Za-z0-9_-])/g

const STATUSES = new Set<unknown>(['pass', 'warn', 'fail', 'skip'])

const isCheckShape = (c: unknown) =>
  isRecord(c) && typeof c.id === 'string' && STATUSES.has(c.status) && typeof c.detail === 'string'

const isPackShape = (p: unknown) =>
  isRecord(p) &&
  typeof p.id === 'string' &&
  typeof p.title === 'string' &&
  STATUSES.has(p.status) &&
  Array.isArray(p.checks) &&
  p.checks.every(isCheckShape)

/** Pure: a persisted report is trusted only when its whole shape is (a junk file must not reach the pane or the door). */
function isReportShape(value: unknown): value is DoctorReport {
  return (
    isRecord(value) &&
    value.schema === REPORT_SCHEMA &&
    STATUSES.has(value.status) &&
    isRecord(value.counts) &&
    Array.isArray(value.packs) &&
    value.packs.every(isPackShape) &&
    Array.isArray(value.lines) &&
    value.lines.every(l => typeof l === 'string')
  )
}

/** Pure: report text with secrets, tokens, e-mails and home paths removed. */
export function redactReportText(text: string, home: string): string {
  let out = redactSecrets(text)

  if (home && home !== '/') {
    out = out.split(home).join('~')
  }

  return out
    .replace(JWT, '[jwt]')
    .replace(HEX_KEY, '[hex-key]')
    .replace(AWS_KEY_ID, '[aws-key]')
    .replace(BOT_TOKEN, '[bot-token]')
    .replace(API_KEY, '[key]')
    .replace(ASSIGNED, '$1$2[redacted]')
    .replace(EMAIL, '[email]')
    .replace(USER_PATH, '/$1/[user]')
}

function worst(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) {
    return 'fail'
  }

  if (statuses.includes('warn')) {
    return 'warn'
  }

  return statuses.every(s => s === 'skip') && statuses.length ? 'skip' : 'pass'
}

/** Resolves after `ms` unless cleared; the timer never outlives the check. */
function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | 'timeout'> {
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined

  return Promise.race([
    work(abort.signal),
    new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => {
        abort.abort()
        resolve('timeout')
      }, ms)
    })
  ]).finally(() => {
    clearTimeout(timer)
    abort.abort()
  })
}

async function pool<T, R>(items: readonly T[], width: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0

  const lane = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index])
    }
  }

  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane))

  return results
}

interface RunOptions {
  packs?: readonly string[]
  live?: boolean
  actor?: DoctorActor
  onProgress?(progress: { packId: string; done: number; total: number }): void
}

export function createDoctor(deps: DoctorDeps) {
  const checks = deps.checks ?? CHECKS
  const fixes = deps.fixes ?? FIXES
  const exec = deps.env.exec ?? execAbsolute
  const home = deps.env.home
  const redact = (text: string) => redactReportText(text, home)

  const fixDef = (id: string | undefined): FixDef | undefined =>
    id ? (findFix(deps.catalogue, id)?.fix ?? undefined) : undefined

  let last: DoctorReport | null = null

  const runCheck = async (pack: PackDef, def: CheckDef, live: boolean, actor: DoctorActor): Promise<CheckResult> => {
    const started = Date.now()
    const fix = fixDef(def.fix)
    const base = { id: def.id, title: def.title }

    const done = (status: CheckStatus, detail: string, evidence?: string, fixable = true): CheckResult => ({
      ...base,
      status,
      detail: redact(detail),
      ...(evidence ? { evidence: redact(evidence) } : {}),
      ...(status !== 'pass' && status !== 'skip' && fix && fixable
        ? { fixId: fix.id, risk: fix.risk, consent: fix.consent }
        : {}),
      durationMs: Date.now() - started
    })

    if (def.platforms && !def.platforms.includes(deps.env.platform as 'darwin')) {
      return done('skip', `not on ${deps.env.platform}`)
    }

    if ((def.network || pack.id === NETWORK_PACK) && !live) {
      return done('skip', 'live probes are off')
    }

    const impl = checks[def.impl]

    if (!impl) {
      return done('fail', `no implementation for ${def.impl}`)
    }

    try {
      const outcome = await withTimeout(signal => impl({ ...deps.env, exec, live, actor, signal }), def.timeoutMs)

      if (outcome === 'timeout') {
        return done('fail', `timeout after ${(def.timeoutMs / 1000).toFixed(1)} s`)
      }

      const status: CheckStatus =
        outcome.status ?? (outcome.ok === 'skip' ? 'skip' : outcome.ok ? 'pass' : def.severity)

      return done(status, outcome.detail, outcome.evidence, outcome.fixable !== false)
    } catch (error) {
      return done('fail', error instanceof Error ? error.message : String(error))
    }
  }

  const linesFor = (report: Omit<DoctorReport, 'lines'>): string[] => {
    const lines = [
      `icloneOS diagnostics · ${report.startedAt} · ${(report.durationMs / 1000).toFixed(1)} s${report.live ? ' · live probes on' : ''}`,
      `app ${report.app.version} · Electron ${report.app.electron} · ${report.os.platform} ${report.os.release} · ${report.app.arch}`
    ]

    for (const pack of report.packs) {
      lines.push(`${GLYPH[pack.status]} ${pack.title}`)

      for (const check of pack.checks) {
        lines.push(
          `  ${GLYPH[check.status]} ${check.id} — ${check.detail}${check.fixId ? ` (fix: ${check.fixId}, risk ${check.risk})` : ''}`
        )
      }
    }

    const { fail, warn } = report.counts

    lines.push(fail || warn ? `${fail} failed · ${warn} warning${warn === 1 ? '' : 's'}` : 'Everything checks out')

    return lines.map(redact)
  }

  const persist = (report: DoctorReport) => {
    try {
      fs.mkdirSync(deps.dataDir, { recursive: true, mode: 0o700 })

      for (const [name, text] of [
        ['last-report.json', `${JSON.stringify(report, null, 2)}\n`],
        ['last-report.txt', `${report.lines.join('\n')}\n`]
      ] as const) {
        const file = path.join(deps.dataDir, name)
        writeFileAtomicSync(file, text, { mode: 0o600 })
      }
    } catch {
      // A read-only data dir must not fail the run: the report still returns to the caller.
    }
  }

  let inFlight: { ids: Set<string>; live: boolean; actor: DoctorActor; report: Promise<DoctorReport> } | null = null
  // One apply at a time, never interleaved with a run: two applies would plan on the same broken state.
  let fixFlight: { fixId: string; actor: DoctorActor; result: Promise<FixResult> } | null = null

  /** Single flight: a run the in-flight one already covers joins it; any other waits for it, so no check runs twice at once. */
  async function run(options: RunOptions = {}): Promise<DoctorReport> {
    const live = options.live === true
    const actor = options.actor ?? 'user'
    const wanted = options.packs?.length ? new Set(options.packs) : null
    const ids = deps.catalogue.packs.filter(p => (wanted ? wanted.has(p.id) : true)).map(p => p.id)

    while (inFlight || fixFlight) {
      if (fixFlight) {
        await fixFlight.result.catch(() => undefined)

        continue
      }

      const current = inFlight!

      // A user run must not reuse an agent run's keychain skip, and a live request must not get an offline answer.
      if (current.live === live && current.actor === actor && ids.every(id => current.ids.has(id))) {
        return current.report
      }

      await current.report.catch(() => undefined)
    }

    const report = execute(ids, live, actor, options)
    const flight = { ids: new Set(ids), live, actor, report }
    inFlight = flight

    try {
      return await report
    } finally {
      if (inFlight === flight) {
        inFlight = null
      }
    }
  }

  async function execute(
    ids: readonly string[],
    live: boolean,
    actor: DoctorActor,
    options: RunOptions
  ): Promise<DoctorReport> {
    const startedMs = Date.now()
    const packs = deps.catalogue.packs.filter(p => ids.includes(p.id))
    const jobs = packs.flatMap(pack => pack.checks.map(def => ({ pack, def })))
    let finished = 0

    const results = await pool(jobs, PARALLEL, async job => {
      const result = await runCheck(job.pack, job.def, live, actor)
      finished += 1
      options.onProgress?.({ packId: job.pack.id, done: finished, total: jobs.length })

      return result
    })

    const fresh: PackResult[] = packs.map(pack => {
      const rows = results.filter((_, i) => jobs[i].pack === pack)

      return { id: pack.id, title: pack.title, status: worst(rows.map(r => r.status)), checks: rows }
    })

    // A partial run updates its packs inside the last report, so untouched groups keep their last result.
    const previous = packs.length < deps.catalogue.packs.length ? lastReport() : null

    const packResults: PackResult[] = previous
      ? deps.catalogue.packs.flatMap(
          pack => fresh.find(p => p.id === pack.id) ?? previous.packs.find(p => p.id === pack.id) ?? []
        )
      : fresh

    const rows = packResults.flatMap(p => p.checks)
    const counts: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 }

    rows.forEach(r => (counts[r.status] += 1))

    const body = {
      schema: REPORT_SCHEMA,
      startedAt: new Date(startedMs).toISOString(),
      durationMs: Date.now() - startedMs,
      live,
      status: worst(rows.map(r => r.status)),
      counts,
      app: deps.app,
      os: { platform: deps.env.platform, release: deps.osRelease },
      packs: packResults
    } satisfies Omit<DoctorReport, 'lines'>

    const report: DoctorReport = { ...body, lines: linesFor(body) }

    last = report
    persist(report)

    return report
  }

  async function fix(fixId: string, options: { dryRun?: boolean; actor?: DoctorActor } = {}): Promise<FixResult> {
    const dryRun = options.dryRun !== false
    const actor = options.actor ?? 'user'
    const found = findFix(deps.catalogue, fixId)
    const empty = { fixId, dryRun, plan: [], applied: false, backupDir: null }

    if (!found) {
      return { ...empty, ok: false, undo: '', refused: 'unknown', error: `unknown fix ${fixId}` }
    }

    const { pack, fix: def } = found
    const meta = { undo: def.undo, risk: def.risk }

    if (!dryRun && actor === 'agent' && def.risk !== 'low') {
      return {
        ...empty,
        ...meta,
        ok: false,
        refused: 'risk',
        error: `${fixId} is ${def.risk} risk: the owner applies it in Settings › Diagnostics`
      }
    }

    if (!dryRun && def.risk === 'high' && def.consent && !deps.consentAllows(def.consent)) {
      return {
        ...empty,
        ...meta,
        ok: false,
        refused: 'consent',
        needsConsent: def.consent,
        error: `${fixId} needs the ${def.consent} permission`
      }
    }

    if (dryRun) {
      return attempt(pack, def, dryRun, actor)
    }

    // An apply of the same fix BY THE SAME ACTOR joins the one in flight; anything else waits for the apply or run in
    // flight. An owner's click must never be answered with an agent's refusal (agents are refused 'open' steps), nor
    // read after-checks computed with the agent's keychain skip.
    while (fixFlight || inFlight) {
      if (fixFlight?.fixId === fixId && fixFlight.actor === actor) {
        return fixFlight.result
      }

      await (fixFlight ? fixFlight.result : inFlight!.report).catch(() => undefined)
    }

    const result = attempt(pack, def, dryRun, actor)
    const flight = { fixId, actor, result }
    fixFlight = flight

    try {
      return await result
    } finally {
      if (fixFlight === flight) {
        fixFlight = null
      }
    }
  }

  async function attempt(pack: PackDef, def: FixDef, dryRun: boolean, actor: DoctorActor): Promise<FixResult> {
    const fixId = def.id
    const empty = { fixId, dryRun, plan: [], applied: false, backupDir: null }
    const meta = { undo: def.undo, risk: def.risk }
    const owners = pack.checks.filter(c => c.fix === fixId)
    const before = await Promise.all(owners.map(c => runCheck(pack, c, false, actor)))

    // Idempotence: when every owning check already passes there is nothing to do.
    if (before.every(r => r.status === 'pass' || r.status === 'skip')) {
      return { ...empty, ...meta, ok: true, after: before }
    }

    const impl = fixes[def.impl]

    if (!impl) {
      return { ...empty, ...meta, ok: false, error: `no implementation for ${def.impl}` }
    }

    const signal = new AbortController().signal
    const env: DoctorEnv = { ...deps.env, exec, live: false, signal }
    let steps

    try {
      steps = await impl(env)
    } catch (error) {
      return { ...empty, ...meta, ok: false, error: redact(error instanceof Error ? error.message : String(error)) }
    }

    const plan = steps.map(s => redact(describeStep(s)))

    // Opening a page acts on the owner's screen: an agent may show the plan, never apply it.
    if (!dryRun && actor === 'agent' && steps.some(s => s.kind === 'open')) {
      return {
        ...empty,
        ...meta,
        plan,
        ok: false,
        refused: 'risk',
        error: `${fixId} opens a page on the owner's screen: tell the owner, or they apply it in Settings › Diagnostics`
      }
    }

    if (dryRun || steps.length === 0) {
      return { ...empty, ...meta, ok: true, plan }
    }

    const outcome = await applySteps(env, fixId, steps, path.join(deps.dataDir, 'backups'))
    const after = await Promise.all(owners.map(c => runCheck(pack, c, false, actor)))

    return {
      ok: !outcome.error,
      fixId,
      dryRun,
      plan,
      applied: steps.some(s => !isPassive(s)),
      backupDir: outcome.backupDir ? redact(outcome.backupDir) : null,
      ...meta,
      after,
      ...(outcome.error ? { error: redact(outcome.error) } : {})
    }
  }

  function list() {
    return { packs: deps.catalogue.packs, errors: deps.catalogue.errors }
  }

  function lastReport(): DoctorReport | null {
    if (last) {
      return last
    }

    try {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(deps.dataDir, 'last-report.json'), 'utf8'))

      return isReportShape(value) ? value : null
    } catch {
      return null
    }
  }

  return { list, run, fix, lastReport }
}

export type Doctor = ReturnType<typeof createDoctor>

// ── the agent door: `acp doctor list|run|fix|report` (app-level verb on the agent socket) ──────────────────────────

let activeDoctor: Doctor | null = null

export function setActiveDoctor(doctor: Doctor | null): void {
  activeDoctor = doctor
}

const DOOR_FLAGS = new Set(['--json', '--dry-run', '--apply'])
const DOOR_USAGE = 'usage: acp doctor list|run [pack…]|fix <fix-id> [--dry-run|--apply]|report [--json]'

const LIVE_OWNER_ONLY =
  'live probes contact the internet: only the owner turns them on (Settings › Diagnostics › Live network probes)'

type DoorCommand =
  | { kind: 'list' | 'report'; json: boolean }
  | { kind: 'run'; packs: string[]; live: boolean; json: boolean }
  | { kind: 'fix'; fixId: string; apply: boolean; json: boolean }
  | { kind: 'error'; error: string }

/** Pure: allow-listed argv → a door command. Anything outside the list is refused, never passed through. */
export function parseDoctorArgv(argv: readonly unknown[], catalogue: Catalogue): DoorCommand {
  if (argv.length > 12 || !argv.every(a => typeof a === 'string' && a.length <= 80)) {
    return { kind: 'error', error: DOOR_USAGE }
  }

  const args = argv as string[]
  const [verb, ...rest] = args
  const flags = rest.filter(a => a.startsWith('-'))
  const words = rest.filter(a => !a.startsWith('-'))
  const json = flags.includes('--json')

  if (flags.includes('--live')) {
    return { kind: 'error', error: LIVE_OWNER_ONLY }
  }

  if (flags.some(f => !DOOR_FLAGS.has(f))) {
    return { kind: 'error', error: `unknown flag ${flags.find(f => !DOOR_FLAGS.has(f))} — ${DOOR_USAGE}` }
  }

  if ((verb === 'list' || verb === 'report') && words.length === 0 && flags.every(f => f === '--json')) {
    return { kind: verb, json }
  }

  if (verb === 'run' && flags.every(f => f === '--json')) {
    const known = new Set(catalogue.packs.map(p => p.id))
    const unknown = words.find(w => !known.has(w))

    return unknown
      ? { kind: 'error', error: `unknown pack ${unknown}` }
      : { kind: 'run', packs: words, live: false, json }
  }

  if (verb === 'fix' && words.length === 1 && !(flags.includes('--apply') && flags.includes('--dry-run'))) {
    return findFix(catalogue, words[0])
      ? { kind: 'fix', fixId: words[0], apply: flags.includes('--apply'), json }
      : { kind: 'error', error: `unknown fix ${words[0]}` }
  }

  return { kind: 'error', error: DOOR_USAGE }
}

function reportText(report: DoctorReport | null): string {
  return report ? `${report.lines.join('\n')}\n` : 'no report yet — run `acp doctor run`\n'
}

/** The `doctor` verb of the agent socket (already authenticated). Exit 0 = nothing failed, 1 = failures/refused, 64 = usage. */
export async function doctorDoorCommand(
  _slug: string,
  argv: readonly unknown[]
): Promise<{ code: number; stdout: string; stderr?: string }> {
  const doctor = activeDoctor

  if (!doctor) {
    return { code: 1, stdout: '', stderr: 'acp: icloneOS is starting — try again\n' }
  }

  const command = parseDoctorArgv(argv, { packs: doctor.list().packs, errors: [] })

  if (command.kind === 'error') {
    return { code: 64, stdout: '', stderr: `acp: ${command.error}\n` }
  }

  if (command.kind === 'list') {
    const packs = doctor.list().packs.map(p => ({
      id: p.id,
      title: p.title,
      checks: p.checks.map(c => ({ id: c.id, title: c.title, fix: c.fix ?? null })),
      fixes: p.fixes.map(f => ({ id: f.id, title: f.title, risk: f.risk, consent: f.consent }))
    }))

    const text = packs.map(p => `${p.id} — ${p.title}: ${p.checks.map(c => c.id).join(', ')}`).join('\n')

    return { code: 0, stdout: command.json ? `${JSON.stringify({ packs })}\n` : `${text}\n` }
  }

  if (command.kind === 'report') {
    const report = doctor.lastReport()

    return { code: report ? 0 : 1, stdout: command.json ? `${JSON.stringify(report)}\n` : reportText(report) }
  }

  if (command.kind === 'run') {
    const report = await doctor.run({ packs: command.packs, live: command.live, actor: 'agent' })

    return {
      code: report.status === 'fail' ? 1 : 0,
      stdout: command.json ? `${JSON.stringify(report)}\n` : reportText(report)
    }
  }

  if (command.kind !== 'fix') {
    return { code: 64, stdout: '', stderr: `acp: ${DOOR_USAGE}\n` }
  }

  // Agents apply low-risk fixes only; medium/high go to the owner (Settings › Diagnostics).
  const result = await doctor.fix(command.fixId, { dryRun: !command.apply, actor: 'agent' })

  const text = [
    `${result.ok ? '✓' : '✗'} ${result.fixId}${result.dryRun ? ' (dry run)' : ''}${result.error ? ` — ${result.error}` : ''}`,
    ...result.plan.map(p => `  · ${p}`),
    result.plan.length === 0 && result.ok ? '  nothing to do' : '',
    result.backupDir ? `  backup: ${result.backupDir}` : ''
  ].filter(Boolean)

  return { code: result.ok ? 0 : 1, stdout: command.json ? `${JSON.stringify(result)}\n` : `${text.join('\n')}\n` }
}
