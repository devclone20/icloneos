/**
 * The runtime's own update check and the apply gate (PLAN R front R1, §6 amendments; U1 2026-10-19).
 *
 * Order in main (after ensureRuntime resolves the runtime, before the backend spawns):
 *   ensureCuratedRuntimeConfig → spawn. Nothing moves the runtime at boot: the boot alignment dialog is gone (U1), a
 *   runtime ahead of the pin is the user's own choice, and only a click in Settings › Updates moves it.
 * Developer policy never writes the owner's config.yaml.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { readJsonFileSync } from './lib/fs-json'
import { type RuntimePinInfo, UPDATE_POLICY_LOG_TAG, type UpdatePolicy } from './update-policy'

/** The SYNC reader under its pre-P0p name, kept for L1's electron/main/updates.ts + updates-ipc.ts (they import it
 *  from here); lib/fs-json's own `readJsonFile` is the async one. Goes when those import readJsonFileSync directly. */
export { readJsonFileSync as readJsonFile } from './lib/fs-json'

export const RUNTIME_ALIGN_FILE = 'runtime-align.json'
export const CURATED_CONFIG_MARKER_FILE = 'curated-runtime-config.json'
const CURATED_CONFIG_TIMEOUT_MS = 10_000

export interface RuntimeAlignRecord {
  answer: 'align' | 'later'
  at: string
  error?: string
  head: string
  pinSha: string
  result?: 'aligned' | 'failed'
}

type AlignAction = 'aligned' | 'already-aligned' | 'failed' | 'later' | 'skipped'

interface AlignOutcome {
  action: AlignAction
  message?: string
  reason?: string
}

function writeJsonFile(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

/** The HERMES_HOME a backend spawned with `--profile <name>` reads (`default` is the root home). */
export function profileHermesHome(rootHome: string, profile: null | string | undefined): string {
  return profile && profile !== 'default' ? path.join(rootHome, 'profiles', profile) : rootHome
}

interface ConfigMarker {
  [hermesHome: string]: { at: string; sha: string }
}

/**
 * Curated only: turns Hermes's own update check off (`hermes config set updates.check false`) once per HERMES_HOME
 * the backend reads (the root home and every `--profile` home: the CLI runs with the same `--profile` flag) and runtime sha (an alignment re-runs it: install.sh's config stage may rewrite defaults). Fails open: a missing
 * CLI or a slow Python only costs one passive cached check; the next boot retries.
 */
export async function ensureCuratedRuntimeConfig(deps: {
  exists?: (file: string) => boolean
  hermesBin: string
  hermesHome: string
  log: (line: string) => void
  markerFile: string
  now?: () => Date
  policy: UpdatePolicy
  profile?: null | string
  run: (
    cmd: string,
    args: string[],
    opts: { env: NodeJS.ProcessEnv; timeoutMs: number }
  ) => Promise<{ code: null | number }>
  /**
   * V3-RT K-RT15 / critic m4: run the CLI as the environment's Python on the verified runtime (`-s -P
   * --check-hash-based-pycs always -m hermes_cli.main`), with the env sealed by `sealEnv` and no bytecode written. The
   * caller runs the integrity check first. Without it the console script `hermesBin` runs (a dev checkout).
   */
  sealed?: { python: string; sealEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv }
  runtimeSha: null | string
  timeoutMs?: number
}): Promise<{ ran: boolean; reason?: string }> {
  if (deps.policy !== 'curated') {
    return { ran: false, reason: 'developer-policy' }
  }

  const sha = deps.runtimeSha ?? 'unknown'
  const home = profileHermesHome(deps.hermesHome, deps.profile)
  const marker = readJsonFileSync<ConfigMarker>(deps.markerFile) ?? {}

  if (marker[home]?.sha === sha) {
    return { ran: false, reason: 'marker' }
  }

  if (!(deps.exists ?? fs.existsSync)(deps.hermesBin)) {
    deps.log(`${UPDATE_POLICY_LOG_TAG} hermes CLI missing at ${deps.hermesBin}; runtime update check left as is`)

    return { ran: false, reason: 'no-cli' }
  }

  const cliArgs = [...(deps.profile ? ['--profile', deps.profile] : []), 'config', 'set', 'updates.check', 'false']

  const [cmd, args, env] = deps.sealed
    ? [
        deps.sealed.python,
        ['-s', '-P', '--check-hash-based-pycs', 'always', '-m', 'hermes_cli.main', ...cliArgs],
        { ...deps.sealed.sealEnv({ ...process.env, HERMES_HOME: deps.hermesHome }), PYTHONDONTWRITEBYTECODE: '1' }
      ]
    : [deps.hermesBin, cliArgs, { ...process.env, HERMES_HOME: deps.hermesHome }]

  const result = await deps
    .run(cmd, args, { env, timeoutMs: deps.timeoutMs ?? CURATED_CONFIG_TIMEOUT_MS })
    .catch(() => ({ code: null }))

  if (result.code !== 0) {
    deps.log(
      `${UPDATE_POLICY_LOG_TAG} hermes config set updates.check false failed for ${home} (code ${result.code}); retry next boot`
    )

    return { ran: false, reason: 'cli-failed' }
  }

  // Re-read: two profile homes may finish concurrently; each writes only its own key.
  const latest = readJsonFileSync<ConfigMarker>(deps.markerFile) ?? {}
  latest[home] = { sha, at: (deps.now ?? (() => new Date()))().toISOString() }
  writeJsonFile(deps.markerFile, latest)
  deps.log(`${UPDATE_POLICY_LOG_TAG} Hermes's own update check is off (updates.check false) for ${home}`)

  return { ran: true }
}

export interface HealthCommitCheck {
  commit: null | string
  head: null | string
  /** HEAD vs the bundled pin, only when the align record says the owner aligned (or tried to). */
  pin?: 'match' | 'mismatch'
  state: 'match' | 'mismatch' | 'unknown'
}

const COMMIT_RE = /^[0-9a-f]{7,40}$/

/** Two abbreviated commits name the same object only when both carry at least 7 hex digits and one prefixes the other. */
export function sameCommit(a: null | string | undefined, b: null | string | undefined): boolean {
  const x = typeof a === 'string' ? a.trim().toLowerCase() : ''
  const y = typeof b === 'string' ? b.trim().toLowerCase() : ''

  return COMMIT_RE.test(x) && COMMIT_RE.test(y) && (x.startsWith(y) || y.startsWith(x))
}

/**
 * Amendment order step 4: after the first curated spawn, the commit the backend reports (`/api/health.commit`) must be
 * the runtime HEAD the app aligned. One log line either way; a mismatch is surfaced in the local update status.
 */
export async function checkRuntimeHealthCommit(deps: {
  align?: null | RuntimeAlignRecord
  fetchCommit: () => Promise<null | string>
  head: null | string
  log: (line: string) => void
  pinSha?: string
}): Promise<HealthCommitCheck> {
  const tag = '[iclone-runtime-pin]'
  const head = deps.head && COMMIT_RE.test(deps.head.trim().toLowerCase()) ? deps.head.trim().toLowerCase() : null

  const commit = await deps.fetchCommit().then(
    value => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null),
    () => null
  )

  const decided = deps.align?.result === 'aligned' || deps.align?.result === 'failed'
  // An unreadable HEAD is not evidence that the runtime left the pin: the pin verdict stays unset.
  const pin = decided && deps.pinSha && head ? (sameCommit(head, deps.pinSha) ? 'match' : 'mismatch') : undefined

  const pinNote =
    pin === undefined
      ? decided && deps.pinSha
        ? '; bundled pin check skipped (runtime HEAD unreadable)'
        : ''
      : pin === 'match'
        ? `; runtime HEAD == bundled pin ${deps.pinSha!.slice(0, 12)}`
        : `; runtime HEAD ${head!.slice(0, 12)} is NOT the bundled pin ${deps.pinSha!.slice(0, 12)} (align ${deps.align?.result})`

  if (!commit || !head || !COMMIT_RE.test(commit)) {
    deps.log(
      `${tag} health commit check: unknown (backend ${commit ?? 'n/a'}, runtime HEAD ${head ?? 'n/a'})${pinNote}`
    )

    return { commit, head, ...(pin ? { pin } : {}), state: 'unknown' }
  }

  const match = sameCommit(commit, head)

  deps.log(
    (match
      ? `${tag} health commit ${commit.slice(0, 12)} == runtime HEAD`
      : `${tag} health commit MISMATCH: backend reports ${commit.slice(0, 12)}, runtime HEAD is ${head.slice(0, 12)}`) +
      pinNote
  )

  return { commit, head, ...(pin ? { pin } : {}), state: match ? 'match' : 'mismatch' }
}

/** Runs a short CLI with a hard cap; a timeout or a spawn error resolves `{ code: null }` (never throws). */
export function spawnCapped(
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number },
  spawnFn: typeof spawn = spawn
): Promise<{ code: null | number }> {
  return new Promise(resolve => {
    let settled = false

    const done = (code: null | number) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ code })
      }
    }

    const child = spawnFn(cmd, args, { env: opts.env, stdio: 'ignore' })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      done(null)
    }, opts.timeoutMs)

    child.on('error', () => done(null))
    child.on('exit', code => done(code))
  })
}

type UpdateApplyGate<R> = { door: 'agent-latest' | 'pinned' | 'raw'; refusal: null } | { door: null; refusal: R }

/**
 * The gate in front of every runtime apply. Curated (POSIX): the only door is the bundled pin, and a bundled pin equal to
 * the contract lock's verified rev carries its compat verdict by construction — so nothing re-resolves the install
 * target (`git ls-remote` of the moving ref) and the verdict never depends on the upstream tip; one audit line records
 * the apply. Developer (and Windows, which R1 leaves unpinned): refresh the target, then the compat gate decides.
 */
export async function gateUpdateApply<R>(deps: {
  audit: (entry: Record<string, unknown>) => void
  compatGate: () => null | R
  /** `agent-latest` = Settings › Updates › Agent (any policy); omitted = the policy's own door. */
  door?: 'agent-latest'
  isWindows: boolean
  now?: () => Date
  pin: RuntimePinInfo
  policy: UpdatePolicy
  refreshTarget: () => Promise<unknown>
}): Promise<UpdateApplyGate<R>> {
  const at = (deps.now ?? (() => new Date()))().toISOString()

  // U1: the user-run agent update never takes the pin short-circuit — the compat gate decides at the TARGET tip,
  // RED/UNKNOWN keep their owner hold (the existing ack flow).
  if (deps.door === 'agent-latest') {
    await deps.refreshTarget()
    const refusal = deps.compatGate()
    deps.audit({ door: 'agent-latest', held: Boolean(refusal), by: 'owner', at })

    return refusal ? { door: null, refusal } : { door: 'agent-latest', refusal: null }
  }

  if (deps.policy === 'curated' && !deps.isWindows) {
    deps.audit({
      door: 'curated-apply',
      to: deps.pin.sha,
      verdict: deps.pin.verified,
      by: 'owner',
      at: (deps.now ?? (() => new Date()))().toISOString()
    })

    return { door: 'pinned', refusal: null }
  }

  await deps.refreshTarget()
  const refusal = deps.compatGate()

  return refusal ? { door: null, refusal } : { door: 'raw', refusal: null }
}
