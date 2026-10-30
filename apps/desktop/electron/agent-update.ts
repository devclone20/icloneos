/**
 * U1 — the user-run agent update (door `agent-latest`, Settings › Updates › Agent). Electron-free core: main wires the
 * deps (electron/main/agent-update.ts), the renderer reaches it only through `hermes:agent-update:*`.
 *
 * - The check is one click = one `git ls-remote` of the official NousResearch URL, run from the temp dir with the
 *   read-only env — never a fetch into the runtime checkout — plus two read-only GitHub compare reads, all under one
 *   8 s budget — the compat verdict of that tip is the last step of the same click, in `compat`. The tip of `main` is
 *   "latest": it is what `hermes update` installs. A version string names the newest stable release the tip CARRIES
 *   (`versionBasis`), never a release the tip merely is ahead of. Nothing here runs at boot, on a timer, on focus or
 *   on resume.
 * - The apply accepts only the sha of the last check plus a single-use gesture token minted by a real input event.
 * - A runtime the user chose is recorded (runtime-choice.json) so a curated Repair never downgrades it to the pin.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isRecord } from '../src/iclone-shared/guards'
import {
  AGENT_UPDATE_DOOR_OPEN,
  type IcloneAgentApplyError,
  type IcloneAgentCompat,
  type IcloneAgentGesture,
  type IcloneAgentInstalled,
  type IcloneAgentLastUpdate,
  type IcloneAgentUpdateCheck,
  type IcloneCodeIdentity,
  type IcloneReceiptOutcome,
  type IcloneRuntimeChoice
} from '../src/iclone-shared/update-status'

import { parseLatestReleaseTag } from './agent-update-tags'
import { readJsonFileSync } from './lib/fs-json'
import { type RunGitResult } from './lib/git'
import { BUNDLED_RUNTIME_PIN } from './update-policy'
import { OFFICIAL_REPO_HTTPS_URL } from './update-remote'

export const AGENT_LAST_CHECK_FILE = 'agent-update-last-check.json'
/** Lives next to the last check: the last containment the API PROVED, so one rate-limited read cannot blank a row. */
export const AGENT_CONTAINS_PROOF_FILE = 'agent-update-contains.json'
export const RUNTIME_CHOICE_FILE = 'runtime-choice.json'
export const AGENT_NET_TIMEOUT_MS = 8000
const AGENT_GESTURE_TTL_MS = 60_000
export const AGENT_UPDATE_LOG_TAG = '[iclone-agent-update]'

const FULL_SHA = /^[0-9a-f]{40}$/
const MAIN_REF = 'refs/heads/main'
const RELEASE_TAGS = 'refs/tags/v*'
/** Upstream's STABLE_TAG_RE (hermes_cli/update_channel.py): CalVer (`v2026.9.24`) and canary tags are not versions. */
const STABLE_TAG = /^v(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const OFFICIAL_COMPARE_API = 'https://api.github.com/repos/NousResearch/hermes-agent/compare'

/** The one network read of the check: argv for `git` (run from a temp cwd, never inside the runtime). */
export function lsRemoteArgv(): string[] {
  return [
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'protocol.fd.allow=never',
    'ls-remote',
    '--',
    OFFICIAL_REPO_HTTPS_URL,
    MAIN_REF,
    RELEASE_TAGS
  ]
}

/** A temp cwd outside every repository, so git cannot discover (or lazy-fetch into) a checkout. */
export function lsRemoteCwd(tmp = os.tmpdir()): { cwd: string; env: NodeJS.ProcessEnv } {
  const cwd = fs.realpathSync(tmp)

  return {
    cwd,
    env: { GIT_CEILING_DIRECTORIES: path.dirname(cwd), GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' }
  }
}

function versionKey(name: string): number[] {
  return name.slice(1).split('.').map(Number)
}

function newerVersion(a: string, b: string): number {
  const [x, y] = [versionKey(a), versionKey(b)]

  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? 0) - (x[i] ?? 0)

    if (d !== 0) {
      return d
    }
  }

  return 0
}

/**
 * `main` tip + newest `v*` release tag + newest stable `vX.Y.Z` tag from one ls-remote (annotated tags peeled through
 * `^{}`). The stable tag is the version source: the runtime's own banner reports the newest stable tag merged into HEAD
 * (hermes_cli/version_info.py), since pyproject.toml says 0.0.0 and `__version__` is read from install-stamp.json.
 */
export function parseLsRemote(text: string): {
  mainSha: null | string
  releaseTag: null | string
  stableTag: { name: string; sha: string } | null
} {
  let mainSha: null | string = null
  const tags = new Map<string, { object: string; peeled: string }>()

  for (const line of String(text ?? '').split('\n')) {
    const [sha = '', ref = ''] = line.trim().split('\t')
    const lower = sha.toLowerCase()

    if (!FULL_SHA.test(lower)) {
      continue
    }

    if (ref === MAIN_REF) {
      mainSha = lower
    } else if (ref.startsWith('refs/tags/')) {
      const peeled = ref.endsWith('^{}')
      const name = ref.slice('refs/tags/'.length).replace(/\^\{\}$/, '')
      const entry = tags.get(name) ?? { object: '', peeled: '' }
      tags.set(name, peeled ? { ...entry, peeled: lower } : { ...entry, object: lower })
    }
  }

  // ls-remote has no dates: newest by version, validated by the same parser the developer pane uses.
  const lines = [...tags.entries()]
    .filter(([name]) => /^v\d/.test(name))
    .sort(([a], [b]) => newerVersion(a, b))
    .map(([name, t]) => `${name}\t${t.object}\t${t.peeled}\tls-remote`)

  const [stable] = [...tags.entries()].filter(([name]) => STABLE_TAG.test(name)).sort(([a], [b]) => newerVersion(a, b))

  return {
    mainSha,
    releaseTag: parseLatestReleaseTag(lines.join('\n'))?.name ?? null,
    stableTag: stable ? { name: stable[0], sha: stable[1].peeled || stable[1].object } : null
  }
}

/** GitHub compare of `base...head` → commits on `head` after `base`, plus the tip's committer date and sha. */
interface AgentCompare {
  aheadBy: number
  /** Known only when the page lists every commit up to the tip (see parseCompare). */
  date: null | string
  tipSha: null | string
}

/** The one containment the check may believe without asking GitHub again: this exact tag sha in this exact tip. */
interface AgentContainsProof {
  tagSha: string
  tipSha: string
}

interface AgentCheckDeps {
  /** ONE budget for every network read of the check (ls-remote, compare, version, compat), click to answer. */
  budgetMs?: number
  fetchCompare: (base: string, head: string, signal: AbortSignal) => Promise<AgentCompare | null>
  /** Is `tagSha` merged into `tipSha`? null: unknown. */
  fetchContains: (tagSha: string, tipSha: string, signal: AbortSignal) => Promise<boolean | null>
  lsRemote: (timeoutMs: number) => Promise<Pick<RunGitResult, 'code' | 'stdout' | 'timedOut'>>
  now?: () => Date
  pin: { sha: string; version?: null | string }
  /** The compat verdict of the tip worth updating to — the same click, inside what is left of the budget. */
  previewCompat?: (sha: string) => Promise<IcloneAgentCompat | null>
  readContainsProof?: () => AgentContainsProof | null
  readInstalled: () => Promise<Omit<IcloneAgentInstalled, 'verifiedWithRelease'> | null>
  writeContainsProof?: (proof: AgentContainsProof) => void
  writeLastCheck: (check: IcloneAgentUpdateCheck) => void
}

/** A proof is worth believing only for the pair it was proven for; anything else (or a throwing store) is unknown. */
function provenContains(deps: AgentCheckDeps, tagSha: string, tipSha: string): boolean {
  try {
    const proof = deps.readContainsProof?.()

    return proof?.tagSha === tagSha && proof.tipSha === tipSha
  } catch {
    return false
  }
}

const sameSha = (a: null | string | undefined, b: null | string | undefined) =>
  Boolean(a && b && (a.startsWith(b) || b.startsWith(a)))

/**
 * The user's "Check for updates" click. Never throws: offline and refusals are values for the pane.
 * ls-remote, the compare and the version read start together under one budget; a read that has not answered by then
 * is null, and only a failed ls-remote is "offline". The compat verdict of the tip is the last step of the same
 * click, inside what is left of that budget, and is returned in `compat` — there is no second door for it.
 */
export async function checkAgentLatest(deps: AgentCheckDeps): Promise<IcloneAgentUpdateCheck> {
  const budgetMs = deps.budgetMs ?? AGENT_NET_TIMEOUT_MS
  const budget = new AbortController()
  const timer = setTimeout(() => budget.abort(), budgetMs)

  const expired = new Promise<null>(resolve => budget.signal.addEventListener('abort', () => resolve(null)))

  const within = <T>(work: () => Promise<T>): Promise<null | T> =>
    Promise.race([
      Promise.resolve()
        .then(work)
        .catch(() => null),
      expired
    ])

  try {
    return await runCheck(deps, budgetMs, budget.signal, within)
  } finally {
    clearTimeout(timer)
    budget.abort()
  }
}

async function runCheck(
  deps: AgentCheckDeps,
  budgetMs: number,
  signal: AbortSignal,
  within: <T>(work: () => Promise<T>) => Promise<null | T>
): Promise<IcloneAgentUpdateCheck> {
  const now = deps.now ?? (() => new Date())
  const local = await within(deps.readInstalled)

  const installed: IcloneAgentInstalled = {
    branch: local?.branch ?? null,
    date: local?.date ?? null,
    dirty: local?.dirty ?? null,
    sha: local?.sha ?? null,
    version: local?.version ?? null,
    verifiedWithRelease: sameSha(local?.sha, deps.pin.sha)
  }

  // RUNTIME_PIN carries no version: it is known only when HEAD is the pin.
  const verified = {
    sha: deps.pin.sha,
    version: deps.pin.version ?? (installed.verifiedWithRelease ? installed.version : null)
  }

  const done = async (partial: Pick<IcloneAgentUpdateCheck, 'error' | 'latest'>): Promise<IcloneAgentUpdateCheck> => {
    // A tip that differs from HEAD but is 0 commits ahead of it (HEAD ahead of the tip) is nothing to update to.
    const updateAvailable = Boolean(
      partial.latest &&
      installed.sha &&
      !sameSha(partial.latest.sha, installed.sha) &&
      partial.latest.commitsNewer !== 0
    )

    const target = updateAvailable ? partial.latest?.sha : null
    const preview = deps.previewCompat

    const check: IcloneAgentUpdateCheck = {
      ...partial,
      checkedAt: now().toISOString(),
      compat: target && preview ? await within(() => preview(target)) : null,
      installed,
      updateAvailable,
      verified
    }

    try {
      deps.writeLastCheck(check)
    } catch {
      // the pane still gets the answer; only "checked N min ago" across restarts is lost
    }

    return check
  }

  if (!local?.sha) {
    return done({ error: signal.aborted ? 'unavailable' : 'no-runtime', latest: null })
  }

  const head = local.sha
  // `main`, not the ls-remote sha: the compare must not wait for ls-remote. A push in between is caught below.
  const compare = within(() => deps.fetchCompare(head, 'main', signal))

  const listed = within(() => deps.lsRemote(budgetMs)).then(remote =>
    remote && !remote.timedOut && remote.code === 0 ? parseLsRemote(remote.stdout) : null
  )

  const tagVersion = listed.then(async tip => {
    const tag = tip?.stableTag
    const mainSha = tip?.mainSha

    if (!mainSha || !tag) {
      return null
    }

    const version = tag.name.slice(1)

    // The tip IS the release: the only case where the version may be read as the release itself.
    if (tag.sha === mainSha) {
      return { basis: 'exact' as const, version }
    }

    const merged = await within(() => deps.fetchContains(tag.sha, mainSha, signal))

    if (merged === true) {
      try {
        deps.writeContainsProof?.({ tagSha: tag.sha, tipSha: mainSha })
      } catch {
        // the row is still right now; only the next rate-limited check loses the shortcut
      }
    }

    // The tip carries the release plus every commit pushed after it — "0.22.2+", never "0.22.2". A read that could
    // not answer (rate limit, abort) falls back to the containment already PROVED for this exact pair, never to a
    // guess: a `false` verdict (the tag is not in this tip) keeps the version out of the answer.
    return merged === true || (merged === null && provenContains(deps, tag.sha, mainSha))
      ? { basis: 'newer' as const, version }
      : null
  })

  const tip = await listed

  if (!tip) {
    return done({ error: 'offline', latest: null })
  }

  if (!tip.mainSha) {
    return done({ error: 'unavailable', latest: null })
  }

  const upToDate = sameSha(tip.mainSha, head)
  const [counted, tagged] = await Promise.all([compare, tagVersion])
  const sameTip = counted && (counted.tipSha === null || counted.tipSha === tip.mainSha) ? counted : null
  const ahead = upToDate ? { aheadBy: 0, date: local.date } : sameTip
  const version = (upToDate ? local.version : null) ?? tagged?.version ?? null

  // Plain only when THIS string is the release the tip is; the installed `__version__` of an up-to-date tip is
  // itself "newest stable tag merged into HEAD", so it too is a floor and is rendered with the `+`.
  const basis = tagged?.basis === 'exact' && tagged.version === version ? 'exact' : 'newer'

  return done({
    error: null,
    latest: {
      commitsNewer: ahead?.aheadBy ?? null,
      date: ahead?.date ?? null,
      releaseTag: tip.releaseTag,
      sha: tip.mainSha,
      version,
      ...(version === null ? {} : { versionBasis: basis })
    }
  })
}

/**
 * The GitHub compare payload → AgentCompare. The API lists at most 250 commits per page, so the last listed commit is
 * the tip only when the list holds all `ahead_by` of them; otherwise the tip's date and sha stay unknown (null).
 */
export function parseCompare(payload: unknown): AgentCompare | null {
  if (!isRecord(payload) || !Number.isInteger(payload.ahead_by) || (payload.ahead_by as number) < 0) {
    return null
  }

  const aheadBy = payload.ahead_by as number
  const commits = Array.isArray(payload.commits) ? payload.commits : []

  const last = (aheadBy > 0 && commits.length === aheadBy ? commits[aheadBy - 1] : null) as {
    commit?: { committer?: { date?: unknown } }
    sha?: unknown
  } | null

  const date = last?.commit?.committer?.date
  const sha = typeof last?.sha === 'string' ? last.sha.toLowerCase() : ''

  return { aheadBy, date: typeof date === 'string' ? date : null, tipSha: FULL_SHA.test(sha) ? sha : null }
}

/** GitHub compare `status` of `tag...tip`: the tag is merged into the tip when the tip is ahead of it or is it. */
export function parseContains(payload: unknown): boolean | null {
  const status = isRecord(payload) ? payload.status : null

  if (status === 'ahead' || status === 'identical') {
    return true
  }

  return status === 'behind' || status === 'diverged' ? false : null
}

/** The official repo's compare API; `head` is a full sha or `main`. One commit per page when only the counts matter. */
export function agentCompareUrl(base: string, head: string, opts: { onePage?: boolean } = {}): null | string {
  if (!FULL_SHA.test(base) || !(FULL_SHA.test(head) || head === 'main')) {
    return null
  }

  return `${OFFICIAL_COMPARE_API}/${base}...${head}${opts.onePage ? '?per_page=1' : ''}`
}

// ── The gesture: a single-use nonce minted only by a real input event, held in main ────────────

export function createGestureStore(opts: { now?: () => number; random?: () => string; ttlMs?: number } = {}) {
  const now = opts.now ?? Date.now
  const ttl = opts.ttlMs ?? AGENT_GESTURE_TTL_MS

  const random = opts.random ?? (() => randomBytes(32).toString('base64url'))

  let held: IcloneAgentGesture | null = null

  return {
    mint(): IcloneAgentGesture {
      held = { expiresAt: now() + ttl, token: random() }

      return held
    },
    /** True once per minted token, inside its lifetime. A wrong token burns the held one too. */
    consume(token: unknown): boolean {
      const current = held
      held = null

      return Boolean(current && typeof token === 'string' && token === current.token && now() <= current.expiresAt)
    }
  }
}

/** Main mints a token only when all three hold: the renderer saw user activation, the preload saw a trusted event ON
 *  the confirm control (agent-update-confirm.ts), and the browser process delivered real input to that window within
 *  `windowMs`. A payload that is not exactly `true` for both flags is a refusal. */
export function gestureAllowed(input: {
  lastInputAt: number
  now: number
  payload: unknown
  windowMs: number
}): boolean {
  const flags = input.payload && typeof input.payload === 'object' ? (input.payload as Record<string, unknown>) : {}

  return flags.activation === true && flags.confirm === true && input.now - input.lastInputAt <= input.windowMs
}

type AgentApplyRefusal = { error: IcloneAgentApplyError; message: string; ok: false }

/** Every refusal the apply door makes before anything touches the runtime. Pure: main supplies the facts. */
export function validateAgentApply(input: {
  appUpdatePending: boolean
  gestureOk: boolean
  lastCheck: IcloneAgentUpdateCheck | null
  platform: NodeJS.Platform
  request: unknown
  updaterRunning: boolean
}): AgentApplyRefusal | { ok: true; targetSha: string } {
  const refuse = (error: IcloneAgentApplyError, message: string): AgentApplyRefusal => ({ error, message, ok: false })
  const req = input.request && typeof input.request === 'object' ? (input.request as Record<string, unknown>) : {}
  const targetSha = typeof req.targetSha === 'string' ? req.targetSha.toLowerCase() : ''

  if (!input.gestureOk) {
    return refuse('gesture', 'The update starts only from your own click on Update.')
  }

  if (input.platform === 'win32') {
    return refuse('unsupported-platform', 'On Windows, update the agent from a terminal with `hermes update --backup`.')
  }

  if (input.appUpdatePending) {
    return refuse('app-update-pending', 'An iclone os update is waiting to install. Restart to finish it first.')
  }

  if (input.updaterRunning) {
    return refuse('updater-running', 'An update is already running.')
  }

  const latest = input.lastCheck?.latest

  if (!input.lastCheck || !latest) {
    return refuse('no-check', 'Check for updates first.')
  }

  if (!FULL_SHA.test(targetSha) || targetSha !== latest.sha) {
    return refuse('stale-check', 'The checked version changed. Check for updates again.')
  }

  if (!input.lastCheck.updateAvailable) {
    return refuse('stale-check', 'The agent is already at the latest version.')
  }

  return { ok: true, targetSha }
}

// ── Repair never downgrades a runtime the user chose ──────────────────────────────────────────

export function readRuntimeChoice(file: string): IcloneRuntimeChoice | null {
  const value = readJsonFileSync<Partial<IcloneRuntimeChoice>>(file)

  return value?.door === 'agent-latest' &&
    typeof value.sha === 'string' &&
    FULL_SHA.test(value.sha) &&
    typeof value.at === 'string'
    ? {
        at: value.at,
        door: 'agent-latest',
        sha: value.sha,
        version: typeof value.version === 'string' ? value.version : null
      }
    : null
}

/** The commit a curated install/Repair checks out: the user's chosen runtime while HEAD still is it, else the pin. */
export function repairCommit(input: {
  choice: IcloneRuntimeChoice | null
  head: null | string
  pinSha: string
}): string {
  const { choice, head } = input

  return choice && head && sameSha(head.toLowerCase(), choice.sha) ? choice.sha : input.pinSha
}

// ── Receipts: update_receipts/latest.json (or the newest update_*.json) + the hand-off result ─────────

const OUTCOMES: readonly IcloneReceiptOutcome[] = ['failed', 'partial', 'running', 'success', 'unknown']

function identity(value: unknown): IcloneCodeIdentity {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    sha: typeof v.sha === 'string' && FULL_SHA.test(v.sha) ? v.sha : null,
    version: typeof v.version === 'string' ? v.version : null
  }
}

const RECEIPT_MAX_BYTES = 4 * 1024 * 1024

function readReceipt(file: string): null | Record<string, unknown> {
  const value = readJsonFileSync<Record<string, unknown>>(file, { maxBytes: RECEIPT_MAX_BYTES })

  return value && typeof value === 'object' && (value.pre_update || value.post_update) ? value : null
}

function backupZipFrom(receipt: Record<string, unknown>, home: string, startedMs: number): null | string {
  const steps = Array.isArray(receipt.steps) ? receipt.steps : []

  for (const step of steps) {
    const s = step && typeof step === 'object' ? (step as Record<string, unknown>) : {}
    const detail = typeof s.detail === 'string' ? s.detail : ''
    const zip = s.name === 'pre_update_backup' ? detail.match(/(\/\S+\.zip)\b/)?.[1] : undefined

    if (zip) {
      return zip
    }
  }

  // Older receipts name only a snapshot id: the newest pre-update zip written during this run.
  const dir = path.join(home, 'backups')

  try {
    const zips = fs
      .readdirSync(dir)
      .filter(name => name.startsWith('pre-update') && name.endsWith('.zip'))
      .map(name => ({ file: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .filter(z => Number.isFinite(startedMs) && z.mtime >= startedMs - 60_000)
      .sort((a, b) => b.mtime - a.mtime)

    return zips[0]?.file ?? null
  } catch {
    return null
  }
}

/** The last update the pane shows as a receipt card. `home` = HERMES_HOME. */
export function readLastAgentUpdate(home: string): IcloneAgentLastUpdate | null {
  const dir = path.join(home, 'logs', 'update_receipts')
  let receipt = readReceipt(path.join(dir, 'latest.json'))

  if (!receipt) {
    try {
      const newest = fs
        .readdirSync(dir)
        .filter(name => /^update_.*\.json$/.test(name))
        .sort()
        .pop()

      receipt = newest ? readReceipt(path.join(dir, newest)) : null
    } catch {
      receipt = null
    }
  }

  if (!receipt) {
    return null
  }

  const startedAt = typeof receipt.started_at === 'string' ? receipt.started_at : null
  const finishedAt = typeof receipt.finished_at === 'string' ? receipt.finished_at : null
  const at = finishedAt ?? startedAt

  if (!at) {
    return null
  }

  const startedMs = startedAt ? Date.parse(startedAt) : NaN
  const finishedMs = finishedAt ? Date.parse(finishedAt) : NaN

  const outcome = OUTCOMES.includes(receipt.outcome as IcloneReceiptOutcome)
    ? (receipt.outcome as IcloneReceiptOutcome)
    : 'unknown'

  return {
    at,
    backupZip: backupZipFrom(receipt, home, startedMs),
    durationMs: Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : null,
    from: identity(receipt.pre_update),
    outcome,
    to: identity(receipt.post_update)
  }
}

// ── A full backup before every agent update ───────────────────────────────────────────────────

/** `updates.pre_update_backup` as config.yaml states it (two-space nested key), or null when unset/unreadable. */
export function readPreUpdateBackupMode(configYaml: null | string): null | string {
  const block = configYaml?.match(/^updates:\s*\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? ''
  const value = block.match(/^[ \t]+pre_update_backup:\s*['"]?([A-Za-z]+)['"]?\s*(?:#.*)?$/m)?.[1]

  return value ? value.toLowerCase() : null
}

export async function ensureFullPreUpdateBackup(deps: {
  hermesBin: string
  hermesHome: string
  log: (line: string) => void
  readConfig: (file: string) => null | string
  run: (
    cmd: string,
    args: string[],
    opts: { env: NodeJS.ProcessEnv; timeoutMs: number }
  ) => Promise<{ code: null | number }>
}): Promise<{ changed: boolean; previous: null | string }> {
  const previous = readPreUpdateBackupMode(deps.readConfig(path.join(deps.hermesHome, 'config.yaml')))

  if (previous === 'full' || previous === 'true') {
    return { changed: false, previous }
  }

  const result = await deps
    .run(deps.hermesBin, ['config', 'set', 'updates.pre_update_backup', 'full'], {
      env: { ...process.env, HERMES_HOME: deps.hermesHome },
      timeoutMs: 20_000
    })
    .catch(() => ({ code: null }))

  deps.log(
    `${AGENT_UPDATE_LOG_TAG} updates.pre_update_backup ${previous ?? '(default quick)'} → full: ${result.code === 0 ? 'set' : `not set (code ${result.code}); --backup still forces it`}`
  )

  return { changed: result.code === 0, previous }
}

/**
 * K-RT3 (V3-RT): the upstream door (Settings › Updates › Agent → NousResearch main) is closed while the bundled runtime is
 * built from this repository (RUNTIME_PIN source "repo"): the upstream tip has no iclone core, so the gate would fail
 * closed and the agent would be read-only. Main refuses the check and the apply whatever the renderer shows; the
 * renderer's AGENT_UPDATE_DOOR_OPEN must agree (agent-update.door.test.ts).
 */
export function agentUpdateDoorOpen(pin: { source?: string } = BUNDLED_RUNTIME_PIN): boolean {
  return AGENT_UPDATE_DOOR_OPEN && pin.source !== 'repo'
}
