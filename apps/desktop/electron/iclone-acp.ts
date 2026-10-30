/**
 * iclone os — Virtuals Protocol ACP CLI bridge (per-iNFT isolation).
 *
 * One iNFT = one agent = one wallet/email/card/Hyperliquid account. Every
 * iNFT gets its own ACP_CONFIG_DIR under userData/inft/<slug>/acp, so CLI
 * state (auth, active agent, provisioned services) can never bleed between
 * agents.
 *
 * THE BOUNDARY. The renderer — and every desktop plugin, which runs with the
 * renderer's authority — reaches the CLI only through `runAcp`, and `runAcp`
 * admits only the commands in RULES (iclone-acp-argv.ts): exact (root, subcommand) pairs,
 * each with its own allowed flags and value validators. Commander accepts
 * global options anywhere, so `card --json issue` used to slip past a check
 * on `args[1]`; here no flag may appear before the subcommand, and the
 * subcommand must be listed. Nothing that moves value, signs, or issues a
 * card is listed: those are the agent's own job, done in its terminal with
 * the owner in the loop. Every `card` answer is parsed and stripped of card
 * numbers before it crosses IPC — a spend-request carries PAN and CVV.
 *
 * ONE PROCESS PER iNFT. Parallel CLI processes against one config dir corrupt
 * its state files, so calls queue per slug and run in sequence — a second
 * caller waits instead of being told "busy".
 *
 * THE TOOLS (REL-6, ruling 26). The app ships no CLI: the owner installs it at
 * first use from the npm registry (electron/iclone-acp-tools/), into
 * userData/acp-cli/<lock-sha256>/. Every spawn below goes through
 * `spawnGate`, which verifies that tree first; absent, changed or from another
 * pin, the call is refused with the reason, and nothing ever falls back to an
 * `acp` found on this machine (only a dev run honours ICLONE_ACP_BIN).
 *
 * THE LAUNCH. The installed CLI runs in a utility process of this app
 * (Electron's own Node; the RunAsNode fuse is off), through `launch.cjs`
 * (scripts/acp-launch.cjs): commander drops the script path from argv on
 * Electron unless `process.defaultApp` is set, which is how every dock app
 * once failed inside the installed app while `--version` still answered. So
 * the first use runs a real command (`chain list --json`) through the exact
 * launch path and nothing runs until it passes; a failure reaches the
 * renderer as one clear reason instead of a commander line per window.
 *
 * THE AGENT. The iNFT's Hermes agent reaches the same runtime only through
 * the app-owned socket in iclone-acp-ipc.ts (policy, routing, redaction).
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { app, ipcMain, utilityProcess } from 'electron'

import { parsePin, runtimeClosure, targetName } from '../src/iclone-shared/acp-pin'
import type { AcpToolsInstallResult } from '../src/iclone-shared/acp-tools'
import { sleep } from '../src/iclone-shared/async'
import { errorMessage } from '../src/iclone-shared/errors'
import { asRecord } from '../src/iclone-shared/guards'
import { slugForInft } from '../src/iclone-shared/inft-slug'

import { isAcpRead, ruleFor, validateArgv } from './iclone-acp-argv'
import {
  CARD_BLOCKED_TTL_MS,
  CARD_TTL_MS,
  cardProbeDue,
  type CardState,
  cardStateFrom,
  nextCardFields,
  probeDue,
  sameCardAgent
} from './iclone-acp-card'
import { ACP_SESSION_EXPIRED_RE, createExpiryGate } from './iclone-acp-expiry'
import { type AgentRunSink, type InftResolution, startAcpSocketServer, streamingSlugs } from './iclone-acp-ipc'
import { type AcpCallClass, createAcpLanes } from './iclone-acp-lanes'
import { envelopeError, firstString, parseJsonLoose, redactCardOutput } from './iclone-acp-output'
import {
  adoptCardSignupHold,
  cardDueSince,
  cardSignupHeldUntil,
  type CardSignupHold,
  cardSignupHold,
  forgetCardSignup,
  isCardSignup,
  persistCardHoldsUnder,
  settleCardDue,
  SIGNUP_ANSWER_CAP,
  withCardSignupSlot
} from './iclone-acp-signup'
import {
  deleteInftKv,
  DETACH_KEPT,
  isPersistedStatus,
  type KvResult,
  mergeInftRegistry,
  parseInftRegistry,
  readInftKv,
  readJsonValidated,
  removeInftDirs,
  writeFileAtomic,
  writeInftKv
} from './iclone-acp-store'
import { createAcpTools, problemText, sameTree } from './iclone-acp-tools/installer'
import { type AcpTools } from './iclone-acp-tools/installer'
import { type InstallAuditSink, registerAcpToolsIpc, requestInstall } from './iclone-acp-tools/ipc'
import type { KeySealer } from './iclone-acp-tools/manifest'
import { type NativeAddons, nativeAddonsFor } from './iclone-acp-tools/native'
import { registryFetch } from './iclone-acp-tools/net'
import { fileRecordStore } from './iclone-acp-tools/record'
import { type AcpWatch, initAcpWatch, type WatchChild, type WatchStart } from './iclone-acp-watch'
import { agentcardStatus } from './iclone-agentcard-status'
import { guardedHandler } from './iclone-consent'
import { emailStateCall } from './iclone-email-state'
import { economyRefusal } from './iclone-ownership-gate'
import { sealTelemetryEnv } from './iclone-telemetry-seal'
import type { IpcSenderEventLike } from './ipc-sender-guard'
import { writeFileAtomicSync } from './lib/atomic-write'

export { slugForInft }
export { validateArgv } from './iclone-acp-argv'

// The CLI's cold start is 15–21 s on this class of machine (measured); a
// minimum below that reads a healthy call as a failure.
const RUN_TIMEOUT_MS = 60_000
const RUN_TIMEOUT_MIN_MS = 30_000
const RUN_TIMEOUT_MAX_MS = 180_000
// `browse --top-k 48` alone is 550 KB (each agent carries up to 40 offerings
// with their JSON schemas); 100 is 1 MB. The old 512 KB cap cut the answer
// mid-JSON and every "Show more" failed with "the CLI returned no JSON".
const OUTPUT_CAP = 8 * 1024 * 1024
// A failed self-test is retried, but not on every call.
const HEALTH_RETRY_MS = 30_000

export interface AcpRunResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  error?: string
}

export { parseJsonLoose, redactCardOutput } from './iclone-acp-output'

export interface InftAcpStatus {
  cli: boolean
  version?: string
  /** Why `cli` is false: missing, or it failed a real command in the self-test. */
  cliError?: string
  /** The signer's policy as the CLI names it ("No Policy (no approval required)", …). */
  signerPolicy?: string
  /** A signer is armed for this agent (job actions, trades and sends can sign). */
  signerReady?: boolean
  authenticated: boolean
  agentId?: string
  agentName?: string
  walletAddress?: string
  solanaAddress?: string
  email?: string
  /** The card is signed in and usable (`card whoami` answered without error). */
  cardReady: boolean
  cardState?: CardState
  /** When `card whoami` last ANSWERED (the 10-min TTL runs from here). */
  cardCheckedAt?: number
  /** The pending signup's state id and e-mail from the service's REAUTH answer — the wizard's resume source. */
  cardReauthState?: string
  cardReauthEmail?: string
  /** `nextStep.hint` of a 200 `verified:false`. */
  cardHint?: string
  cardHttpStatus?: number
  /** The last card probe could not run: the card fields are the last answer (or absent). */
  cardStale?: boolean
  /** A card was seen ready on this agent; carried through a waiting link, a block and non-answers, cleared only by
   *  the card service's authoritative "not set up". */
  cardKnown?: boolean
  /** When the card was last seen ready (absent for a legacy status that carried only `cardReady`). */
  cardKnownAt?: number
  /** Main's hold after a signup answered 403/429 (from the wizard or the agent): no signup before this. */
  cardHeldUntil?: number
  /** When `email whoami` / `signer-policy` last answered (same TTL as the card). */
  emailCheckedAt?: number
  signerCheckedAt?: number
  /** The last email / signer probe could not answer: the field is the previous answer. */
  emailStale?: boolean
  signerStale?: boolean
  /** The one bit the collections badge reads: signed in + agent bound. */
  configured: boolean
  checkedAt: number
  slug: string
  /** True when a probe could not run and this is the last persisted answer. */
  stale?: boolean
  /** The iNFT's Virtuals (ACP) session expired: `agent whoami` answered "not authenticated". Everything else is the
   *  last known answer (configured, agent, wallet, card) — the owner signs in again; nothing was removed. */
  sessionExpired?: boolean
}

// ── CLI resolution — the verified install, run with Electron's own Node ────

/** How the CLI is started. The installed CLI is a `.js` entry run by this very
 *  Electron binary as Node, through the launcher (scripts/acp-launch.cjs: on
 *  Electron, commander drops the script path from argv unless
 *  `process.defaultApp` is set). A binary is a dev run's ICLONE_ACP_BIN. */
type AcpRuntime =
  | { isBinary: true; entry: string }
  | {
      isBinary: false
      entry: string
      launcher: string
      nodeModules: string
      pkg: string
      /** The verified tree (userData/acp-cli/<lock>) and its manifest digest: the launcher confines the CLI to it. */
      treeDir: string
      treeSha256: string
    }

/** REL-6: the app-owned installer (set by initIcloneAcp; null before, and in unit tests that never init). */
let tools: AcpTools | null = null

/** A dev run may point at a system `acp`; a packaged app never does (no unverified CLI ever runs there). */
function devOverride(): AcpRuntime | null {
  const override = process.env.ICLONE_ACP_BIN

  return !app.isPackaged && override && existsSync(override) ? { isBinary: true, entry: override } : null
}

/**
 * Ruling 33: this build's own native add-ons for `target` (Resources/acp-native/<target>, Team-signed by release:mac).
 * A packaged macOS app must have them (the hardened runtime refuses npm's ad-hoc-signed copies); a dev run uses the
 * staged ones when `npm run build` made them, else keeps npm's.
 */
function nativeAddons(target: string): NativeAddons {
  return nativeAddonsFor({
    packaged: app.isPackaged,
    platform: process.platform,
    target,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    exists: existsSync
  })
}

/** Where this build's pin and launcher are: Resources/acp-pin when packaged, the repo files in a dev run. */
function pinPaths(): { pinDir: string; launcher: string } {
  return app.isPackaged
    ? {
        pinDir: path.join(process.resourcesPath, 'acp-pin'),
        launcher: path.join(process.resourcesPath, 'acp-pin', 'launch.cjs')
      }
    : {
        pinDir: path.join(app.getAppPath(), 'acp-cli-lock'),
        launcher: path.join(app.getAppPath(), 'scripts', 'acp-launch.cjs')
      }
}

function linuxLibc(): 'glibc' | 'musl' | null {
  if (process.platform !== 'linux') {
    return null
  }

  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header

  return header?.glibcVersionRuntime ? 'glibc' : 'musl'
}

/** Why no ACP path may run right now, without touching the tree (the spawn gate does that); null = go on. */
async function toolsBlock(): Promise<string | null> {
  if (devOverride()) {
    return null
  }

  if (!tools) {
    return problemText('unavailable', 'installer-down')
  }

  if (tools.view().state === 'checking') {
    await tools.refresh()
  }

  return tools.problem()
}

/** The runtime to spawn, verified NOW (stat of every file since the last full check, else a full check). */
async function verifiedRuntime(): Promise<{ ok: true; rt: AcpRuntime } | { ok: false; error: string }> {
  const override = devOverride()

  if (override) {
    return { ok: true, rt: override }
  }

  if (!tools) {
    return { ok: false, error: problemText('unavailable', 'installer-down') }
  }

  const answer = await tools.runtime()

  if (!answer.ok) {
    return { ok: false, error: answer.error }
  }

  const { entry, launcher, nodeModules, pkg, dir, treeSha256 } = answer.rt

  return { ok: true, rt: { isBinary: false, entry, launcher, nodeModules, pkg, treeDir: dir, treeSha256 } }
}

/** Every spawn: refused unless the tree `rt` names is the verified one, this instant. */
async function spawnGate(rt: AcpRuntime): Promise<string | null> {
  if (rt.isBinary === true) {
    return devOverride() ? null : problemText('unverified', 'system-acp')
  }

  const now = await verifiedRuntime()

  return now.ok ? (!now.rt.isBinary && sameTree(now.rt, rt) ? null : problemText('unverified', 'moved')) : now.error
}

/** How one CLI run starts. A bundled CLI runs in a utility process of this
 *  app — Electron's own Node with no RunAsNode — through the launcher, which
 *  sees a node-shaped argv `[helper, launch.cjs, acp.js, …args]` (measured
 *  on Electron 40). A system `acp` (dev only) is spawned directly. */
type AcpLaunch =
  { kind: 'utility'; modulePath: string; args: string[] } | { kind: 'spawn'; command: string; args: string[] }

/** The one launch shape, mirrored by scripts/acp-selftest.mjs for staging. */
export function launchArgv(rt: AcpRuntime, args: string[]): AcpLaunch {
  return rt.isBinary === true
    ? { kind: 'spawn', command: rt.entry, args }
    : { kind: 'utility', modulePath: rt.launcher, args: [rt.entry, ...args] }
}

/** The child sees only what it needs. The CLI reads ACP_ACCESS_TOKEN,
 *  ACP_SERVER_URL and PRIVY_APP_ID from the environment, and it loads a
 *  `.env` from its working directory — so it gets a bare environment, a
 *  scratch cwd of its own, and a dotenv path that does not exist. */
function childEnv(rt: AcpRuntime, configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: os.homedir(),
    PATH: `${process.env.PATH ?? '/usr/bin:/bin'}:/opt/homebrew/bin:/usr/local/bin`,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: os.tmpdir(),
    USER: process.env.USER ?? os.userInfo().username,
    ACP_CONFIG_DIR: configDir,
    DOTENV_CONFIG_PATH: path.join(os.tmpdir(), 'iclone-acp', 'no-dotenv'),
    // dotenv 17 prints tips to stdout, in front of the JSON we parse.
    DOTENV_CONFIG_QUIET: 'true'
  }

  // REL-6 round 2 (critic M1): no NODE_PATH. The launcher confines every require and import to the verified tree
  // and checks each file it loads against that tree's manifest (scripts/acp-launch.cjs).
  if (rt.isBinary === false) {
    env.ICLONE_ACP_TREE = rt.treeDir
    env.ICLONE_ACP_TREE_SHA256 = rt.treeSha256
  }

  return env
}

function scratchCwd(slug: string): string {
  const dir = path.join(os.tmpdir(), 'iclone-acp', slug)

  mkdirSync(dir, { recursive: true, mode: 0o700 })

  // Nothing the CLI could auto-load may live here.
  for (const name of ['.env', '.env.local']) {
    rmSync(path.join(dir, name), { force: true })
  }

  return dir
}

interface Collected {
  code: number | null
  stdout: string
  stderr: string
  error?: string
}

/**
 * Why a command took forever. On macOS the sign-in token lives in the login
 * keychain under an ACL that names the app's code identity — the first read
 * by a new identity (a dev build, or the first Developer ID release) pops a
 * "wants to use your confidential information" dialog and the CLI waits on
 * it silently. The dialog is the answer, not a network problem: say so.
 */
export function timeoutReason(timeoutMs: number, keychainPrompt: boolean): string {
  const base = `timed out after ${Math.round(timeoutMs / 1000)}s`

  return keychainPrompt
    ? `${base} — macOS is asking permission for iclone os to read this iNFT's keychain items (the ACP sign-in token): click "Always Allow" in that dialog, then retry`
    : base
}

/** True while macOS has a keychain permission dialog on screen. */
function keychainPromptShowing(): boolean {
  if (process.platform !== 'darwin') {
    return false
  }

  try {
    return (
      execFileSync('/usr/bin/pgrep', ['-x', 'SecurityAgent'], { encoding: 'utf8', timeout: 2000 }).trim().length > 0
    )
  } catch {
    return false
  }
}

function ended(stream: NodeJS.ReadableStream | null): Promise<void> {
  return stream
    ? new Promise(resolve => stream.once('end', () => resolve()).once('close', () => resolve()))
    : Promise.resolve()
}

interface CliProcess {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  kill(): void
  /** Settles once: the exit code, or why it never ran. */
  done: Promise<{ code: number | null; error?: string }>
}

/**
 * REL-6 round 2: what the launcher tells main over the utility process's port — a module it refused because it
 * resolved outside the verified tree, or a file that changed after the check — goes to the tools' audit.
 */
function hearLauncher(child: { on(event: 'message', listener: (message: unknown) => void): unknown }) {
  child.on('message', message => {
    const report = message as { iclone?: unknown; type?: unknown; what?: unknown } | null

    if (
      report?.iclone === 'acp-launch' &&
      (report.type === 'escape' || report.type === 'integrity') &&
      typeof report.what === 'string'
    ) {
      tools?.launcherReport({ type: report.type, what: report.what.slice(0, 300) })
    }
  })
}

/** Start one CLI run (see AcpLaunch). Needs the app to be ready. */
function startCli(rt: AcpRuntime, args: string[], cwd: string, env: NodeJS.ProcessEnv): CliProcess {
  console.info(`[iclone-acp] spawn ${path.basename(cwd)} ${args[0] ?? '-'} ${args[1] ?? '-'}`)
  const launch = launchArgv(rt, args)

  if (launch.kind === 'utility') {
    const child = utilityProcess.fork(launch.modulePath, launch.args, {
      serviceName: 'iclone-acp',
      stdio: 'pipe',
      cwd,
      env
    })

    hearLauncher(child)

    return {
      stdout: child.stdout,
      stderr: child.stderr,
      kill: () => void child.kill(),
      done: new Promise(resolve => {
        // 'exit' can beat the last stdout chunk; wait for both pipes (bounded).
        const drained = Promise.all([child.stdout, child.stderr].map(ended))

        child.once('exit', code => void Promise.race([drained, sleep(2000)]).then(() => resolve({ code })))
        child.once('error', (type: string, location: string) =>
          resolve({ code: null, error: `${type} at ${location}` })
        )
      })
    }
  }

  const child = spawn(launch.command, launch.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })

  return {
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => void child.kill('SIGKILL'),
    done: new Promise(resolve => {
      child.once('error', error => resolve({ code: null, error: error.message }))
      child.once('close', code => resolve({ code }))
    })
  }
}

/** Run the CLI and collect its output, capped and decoded as UTF-8 (a
 *  per-chunk `toString` would split multibyte characters). */
async function spawnCollect(
  rt: AcpRuntime,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<Collected> {
  let stdout = ''
  let stderr = ''
  let child: CliProcess

  const blocked = await spawnGate(rt)

  if (blocked) {
    return { code: null, stdout, stderr, error: blocked }
  }

  try {
    child = startCli(rt, args, cwd, env)
  } catch (error) {
    return { code: null, stdout, stderr, error: error instanceof Error ? error.message : String(error) }
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    if (stdout.length < OUTPUT_CAP) {
      stdout += chunk
    }
  })
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < OUTPUT_CAP) {
      stderr += chunk
    }
  })

  let timer: NodeJS.Timeout | undefined

  const timedOut = new Promise<{ code: null; error: string }>(resolve => {
    timer = setTimeout(() => {
      child.kill()
      resolve({ code: null, error: timeoutReason(timeoutMs, keychainPromptShowing()) })
    }, timeoutMs)
  })

  const result = await Promise.race([child.done, timedOut])

  clearTimeout(timer)

  return { ...result, stdout: stdout.slice(0, OUTPUT_CAP), stderr: stderr.slice(0, OUTPUT_CAP) }
}

function inftRoot(slug: string): string {
  return path.join(app.getPath('userData'), 'inft', slug)
}

function configDirFor(slug: string): string {
  const dir = path.join(inftRoot(slug), 'acp')

  mkdirSync(dir, { recursive: true })

  return dir
}

// ── the per-iNFT lanes ──────────────────────────────────────────────────────

// The renderer's per-iNFT lanes in src/app/home/econ/cli.ts sit on top of these.
const lanes = createAcpLanes()
const expiry = createExpiryGate()

/** Only a FAILED call can carry the verdict: a successful read that merely mentions
 *  the words (an ordinary notification e-mail) is an answer, not an expiry. */
export function sessionExpired(result: AcpRunResult): boolean {
  return !result.ok && ACP_SESSION_EXPIRED_RE.test(`${result.stdout}\n${result.stderr}\n${result.error ?? ''}`)
}

function refusal(error: string): AcpRunResult {
  return { ok: false, code: null, stdout: '', stderr: '', error }
}

/** An expiry answer the gate could not confirm (another read succeeded in between): a transient
 *  failure the renderer retries ("busy"), never "Sign in again". */
function unconfirmedExpiry(result: AcpRunResult): AcpRunResult {
  return { ...refusal('busy: the Virtuals session was refreshing during this read'), code: result.code }
}

/** `background`: main's own probes — a read then yields to the renderer's reads. */
async function runAcp(
  inftId: string,
  argv: unknown,
  timeoutMs?: number,
  priority: 'background' | 'read' = 'read'
): Promise<AcpRunResult> {
  const args = validateArgv(argv)

  if (!args) {
    return refusal('command not allowed')
  }

  const cleanId = String(inftId ?? '').trim()

  if (!cleanId) {
    return refusal('no iNFT given')
  }

  const refused = economyRefusal(slugForInft(cleanId), args)

  if (refused) {
    return refusal(refused)
  }

  const health = await ensureRuntime()

  if (health.ok === false) {
    return refusal(health.error)
  }

  const rt = health.rt
  const slug = slugForInft(cleanId)
  const timeout = Math.min(Math.max(Number(timeoutMs) || RUN_TIMEOUT_MS, RUN_TIMEOUT_MIN_MS), RUN_TIMEOUT_MAX_MS)
  const rule = ruleFor(args)

  const once = (cls: AcpCallClass) => () =>
    lanes
      .run(slug, cls, async (): Promise<AcpRunResult> => {
        const configDir = configDirFor(slug)
        const result = await spawnCollect(rt, args, scratchCwd(slug), childEnv(rt, configDir), timeout)
        const ok = result.code === 0 && !result.error

        if (rule?.redact) {
          const redacted = redactCardOutput(result.stdout)

          return {
            ok: ok && !redacted.error,
            code: result.code,
            stdout: redacted.stdout,
            stderr: result.stderr,
            error: result.error ?? redacted.error
          }
        }

        return { ok, code: result.code, stdout: result.stdout, stderr: result.stderr, error: result.error }
      })
      .catch(error => refusal(errorMessage(error)))

  // A write that succeeded (the sign-in wizard among them) ends any run of expiry answers.
  const settle = (result: AcpRunResult): AcpRunResult => {
    if (result.ok) {
      expiry.settled(slug)
    }

    return result
  }

  // A read's expiry answer is confirmed by one retry that runs alone (after any refresh in flight).
  const call = isAcpRead(args)
    ? () => expiry.confirm(slug, once(priority), once('exclusive'), sessionExpired, unconfirmedExpiry)
    : () => once('exclusive')().then(settle)

  return withCardSignupSlot(slug, args, call, refusal)
}

// ── the runtime self-test ───────────────────────────────────────────────────

type RuntimeHealth = { ok: true; rt: AcpRuntime; version?: string } | { ok: false; error: string }

let healthy: RuntimeHealth | null = null
let failed: { at: number; result: RuntimeHealth } | null = null
let pending: Promise<RuntimeHealth> | null = null

function firstLine(text: string): string | undefined {
  return text.trim().split('\n')[0]?.trim().slice(0, 240) || undefined
}

/** A bundled CLI's version is in its package.json — no process needed. */
async function runtimeVersion(rt: AcpRuntime, cwd: string): Promise<string | undefined> {
  if (rt.isBinary === false) {
    try {
      const version: unknown = (JSON.parse(readFileSync(rt.pkg, 'utf8')) as Record<string, unknown>).version

      return typeof version === 'string' ? version : undefined
    } catch {
      return undefined
    }
  }

  const result = await spawnCollect(rt, ['--version'], cwd, childEnv(rt, cwd), RUN_TIMEOUT_MIN_MS)

  return result.code === 0 ? firstLine(result.stdout) : undefined
}

/** `chain list --json` through the exact launch path: the subcommand must
 *  parse, the module graph must load and JSON must come out — static, offline,
 *  no sign-in, and never an iNFT's config dir. `--version` proves none of
 *  that: commander answers global options before it parses commands, so the
 *  bundle that failed every command still printed 1.0.38. */
async function selfTest(): Promise<RuntimeHealth> {
  const verified = await verifiedRuntime()

  if (!verified.ok) {
    return verified
  }

  const rt = verified.rt

  const dir = path.join(os.tmpdir(), 'iclone-acp', 'selftest')

  mkdirSync(dir, { recursive: true, mode: 0o700 })

  const result = await spawnCollect(rt, ['chain', 'list', '--json'], dir, childEnv(rt, dir), RUN_TIMEOUT_MIN_MS)
  const chains = asRecord(parseJsonLoose(result.stdout))?.chains

  if (result.error || result.code !== 0 || !Array.isArray(chains) || chains.length === 0) {
    const detail = result.error ?? firstLine(result.stderr) ?? firstLine(result.stdout) ?? `exit ${result.code}`

    return { ok: false, error: `the acp CLI is not usable: ${detail}` }
  }

  return { ok: true, rt, version: await runtimeVersion(rt, dir) }
}

/** Once per process on success (the bundle cannot change under a running
 *  app); a failure is kept for HEALTH_RETRY_MS so a transient error neither
 *  sticks for the session nor costs a process per call. Concurrent callers
 *  share one run. */
async function ensureRuntime(force = false): Promise<RuntimeHealth> {
  const blocked = await toolsBlock()

  if (blocked) {
    return { ok: false, error: blocked }
  }

  return ensureSelfTested(force)
}

function ensureSelfTested(force: boolean): Promise<RuntimeHealth> {
  if (healthy && !force) {
    return Promise.resolve(healthy)
  }

  if (pending) {
    return pending
  }

  if (!force && failed && Date.now() - failed.at < HEALTH_RETRY_MS) {
    return Promise.resolve(failed.result)
  }

  pending = selfTest()
    .then(result => {
      if (result.ok) {
        healthy = result
        failed = null
      } else {
        failed = { at: Date.now(), result }
      }

      return result
    })
    .finally(() => {
      pending = null
    })

  return pending
}

/** What crosses IPC for the check: the verdict, never the runtime's paths. */
async function checkRuntime(force = false): Promise<{ ok: boolean; version?: string; error?: string }> {
  const health = await ensureRuntime(force)

  return health.ok === true ? { ok: true, version: health.version } : { ok: false, error: health.error }
}

// ── status ──────────────────────────────────────────────────────────────────

interface AcpInstallResult {
  /** REL-6: the tools installer's coded answer, when the install itself was refused or failed. */
  tools?: AcpToolsInstallResult
  ok: boolean
  version?: string
  latest?: string
  updateAvailable?: boolean
  error?: string
}

/** REL-6: the wizard's "Install" is the tools installer's own (a gesture, the V3-F audit), then the self-test. */
async function installAcp(gesture: boolean): Promise<AcpInstallResult> {
  if (!tools) {
    return { ok: false, error: problemText('unavailable', 'installer-down') }
  }

  const installed = await requestInstall({ tools, audit: installAudit }, gesture)

  if (!installed.ok) {
    // The coded result travels with it: the wizard shows its own words for it (critic m4).
    return {
      ok: false,
      error: `[acp-tools-install:${installed.error === 'failed' ? installed.reason : installed.error}]`,
      tools: installed
    }
  }

  const probe = await checkRuntime(true)

  return probe.ok ? { ok: true, version: probe.version } : { ok: false, error: probe.error }
}

/** The pin is fixed per build: an "update" is a newer app. This re-checks the installed tree. */
async function checkAcpUpdate(): Promise<AcpInstallResult> {
  const probe = await checkRuntime(true)

  return { ok: probe.ok, version: probe.version, updateAvailable: false, error: probe.error }
}

function readPersistedStatus(slug: string): InftAcpStatus | null {
  return readJsonValidated(
    path.join(inftRoot(slug), 'status.json'),
    isPersistedStatus
  ) as unknown as InftAcpStatus | null
}

const CARD_FIELDS = [
  'cardState',
  'cardReady',
  'cardCheckedAt',
  'cardReauthState',
  'cardReauthEmail',
  'cardHint',
  'cardHttpStatus',
  'cardKnown',
  'cardKnownAt'
] as const

function copyCardFields(target: InftAcpStatus, source: InftAcpStatus | null): void {
  for (const key of CARD_FIELDS) {
    delete target[key as keyof InftAcpStatus]
  }

  target.cardReady = false

  if (source) {
    Object.assign(
      target,
      Object.fromEntries(CARD_FIELDS.filter(key => source[key] !== undefined).map(key => [key, source[key]]))
    )
  }
}

/** The hold a persisted status reported, while it runs: a second record of main's hold, so a lost
 *  hold record can never let the pre-signup card stamp's TTL end before the service's block. */
function persistedCardHold(last: InftAcpStatus | null, now: number): CardSignupHold | undefined {
  const until = last?.cardHeldUntil

  if (typeof until !== 'number' || !Number.isFinite(until) || until <= now || until - now > CARD_BLOCKED_TTL_MS) {
    return undefined
  }

  const rateLimited = last?.cardState !== 'blocked'

  return { until, rateLimited, ...(rateLimited ? {} : { httpStatus: last?.cardHttpStatus ?? 403 }) }
}

/** Inside a signup's hold the card fields predate its answer: a 403 IS the answer (blocked);
 *  a 429 says nothing about the card, so the carried fields are stale. */
function reportCardHold(status: InftAcpStatus, hold: CardSignupHold | undefined): void {
  if (hold) {
    status.cardHeldUntil = hold.until
  }

  if (hold && !hold.rateLimited) {
    status.cardState = 'blocked'
    status.cardReady = false
    status.cardHttpStatus = hold.httpStatus ?? 403
  } else {
    status.cardStale = true
  }
}

interface StatusOptions {
  /** The manual re-probe: every probe runs. */
  force?: boolean
  /** A card step finished: `card whoami` runs even inside its TTL. */
  card?: boolean
  /** An agent step finished (signer, email): both re-run inside their TTL. */
  agent?: boolean
  /** Main's own: the last signup answered 403/429 and its hold is running — no `card whoami` at all. */
  cardHeld?: boolean
}

function statusOptions(raw: unknown): StatusOptions {
  const record = asRecord(raw)

  return { force: record?.force === true, card: record?.card === true, agent: record?.agent === true }
}

/**
 * The probes of an authenticated agent, each behind its TTL: `email whoami`,
 * `card whoami` and `signer-policy` (agent whoami stays live — the caller ran it).
 * Fills `status` in place from fresh answers or from `last`.
 */
export async function probeAgentFacets(
  run: (argv: string[]) => Promise<AcpRunResult>,
  status: InftAcpStatus,
  last: InftAcpStatus | null,
  opts: StatusOptions = {}
): Promise<void> {
  const now = Date.now()
  // Another agent behind the same iNFT invalidates every cached probe.
  const sameAgent = Boolean(last?.authenticated) && last?.agentId === status.agentId
  const agentDue = (at: unknown) => Boolean(opts.force || opts.agent || !sameAgent || probeDue(at, now, CARD_TTL_MS))

  // A non-answer (timeout, 5xx, any error JSON but "none") carries the last answer unstamped, so the
  // next read retries it and a blank is never cached for the TTL.
  if (agentDue(last?.emailCheckedAt)) {
    const answer = facetAnswer(await run(['email', 'whoami', '--json']), NO_EMAIL)

    if (answer) {
      status.email = firstString(answer.json, ['emailAddress', 'email', 'address'])
      status.emailCheckedAt = Date.now()
    } else {
      status.email = last?.email
      status.emailStale = true
    }
  } else {
    status.email = last?.email
    status.emailCheckedAt = last?.emailCheckedAt
    status.emailStale = last?.emailStale
  }

  const live = opts.cardHeld ? cardSignupHold(status.slug, now) : undefined
  const carried = sameAgent ? persistedCardHold(last, now) : undefined
  const hold = carried && carried.until > (live?.until ?? 0) ? carried : live

  if (carried) {
    adoptCardSignupHold(status.slug, carried, now)
  }

  // An expired session re-signed in is the same agent (agentId kept); only another agent's card is not this one's.
  const cardLast = sameCardAgent(last, status.agentId)

  if (opts.cardHeld || hold) {
    // The service said stay away; another agent's cached card says nothing about this one.
    copyCardFields(status, cardLast)
    reportCardHold(status, hold)
  } else if (cardProbeDue(last, now, CARD_TTL_MS, { ...opts, force: opts.force || !sameAgent })) {
    // Stamped at the START: a read that began before a signup must never count as newer than it.
    const startedAt = Date.now()
    const probe = cardStateFrom(await run(['card', 'whoami', '--json']))

    // Not an answer: never persist a guess (a false 'none' invites a new signup). A known card stays known
    // through a lapsed AgentCard sign-in; only the authoritative 'none' forgets it.
    Object.assign(status, nextCardFields(cardLast, probe, startedAt))
  } else {
    copyCardFields(status, last)
  }

  if (agentDue(last?.signerCheckedAt)) {
    // `signer-policy` answers only when a signer exists; NO_SIGNER otherwise.
    const answer = facetAnswer(await run(['agent', 'signer-policy', '--json']), NO_SIGNER)

    if (answer) {
      status.signerReady = Boolean(firstString(answer.json, ['signerId']))
      status.signerPolicy = status.signerReady ? firstString(answer.json, ['policy']) : undefined
      status.signerCheckedAt = Date.now()
    } else {
      status.signerReady = last?.signerReady === true
      status.signerPolicy = last?.signerPolicy
      status.signerStale = true
    }
  } else {
    status.signerReady = last?.signerReady === true
    status.signerPolicy = last?.signerPolicy
    status.signerCheckedAt = last?.signerCheckedAt
    status.signerStale = last?.signerStale
  }
}

const NO_EMAIL = /\b(NOT_PROVISIONED|NO_EMAIL)\b|not provisioned|no (agent )?e-?mail/i
const NO_SIGNER = /\bNO_SIGNER\b|no signer/i

/**
 * A facet probe's real answer: clean JSON, or the error that IS the answer ("no email", "no signer").
 * Anything else (could not run, 5xx, other error text) is null — not an answer.
 */
function facetAnswer(result: AcpRunResult, none: RegExp): { json: Record<string, unknown> | null } | null {
  const json = asRecord(parseJsonLoose(result.stdout))
  const problem = envelopeError(json) ?? (result.ok ? undefined : (result.error ?? result.stderr))

  if (!problem) {
    return json ? { json } : null
  }

  return none.test(problem) && !/HTTP 5\d\d|timed? ?out/i.test(problem) ? { json: null } : null
}

/**
 * Composite non-secret status: whoami probes only, persisted per iNFT so the
 * collections badges answer instantly on the next boot. A probe that could
 * not RUN (timeout, spawn failure, queue full) is not an answer — the last
 * persisted status comes back marked stale, and nothing is overwritten.
 */
async function readStatus(inftId: string, opts: StatusOptions = {}): Promise<InftAcpStatus> {
  const slug = slugForInft(String(inftId ?? ''))
  const health = await ensureRuntime()

  const status: InftAcpStatus = {
    cli: health.ok,
    authenticated: false,
    cardReady: false,
    configured: false,
    checkedAt: Date.now(),
    slug
  }

  if (health.ok === true) {
    status.version = health.version
  } else {
    // Not an answer about this iNFT — keep what was last known, flagged.
    const last = readPersistedStatus(slug)

    return { ...(last ?? status), cli: false, cliError: health.error, stale: true }
  }

  const agent = await runAcp(inftId, ['agent', 'whoami', '--json'], undefined, 'background')

  if (agent.error) {
    const last = readPersistedStatus(slug)

    return last ? { ...last, stale: true } : { ...status, stale: true }
  }

  const agentJson = asRecord(parseJsonLoose(agent.stdout))
  const agentFailure = envelopeError(agentJson) ?? (agent.ok ? undefined : `${agent.stderr}\n${agent.stdout}`)

  // `agent whoami` gave NO answer about this iNFT (exit != 0 with a 5xx / network / 429 text, or no agent JSON at all):
  // keep the last configured status marked stale — exactly like a spawn error — and never write it as unconfigured.
  // (Agents, wallet and card do not vanish because the service was busy; a false 'not configured' would erase the
  // sticky card fact and send the owner back through Setup.)
  const answeredNothing = !agent.ok && !agentJson?.id && !agentJson?.agentId && !agentJson?.agent_id

  if (answeredNothing && agentFailure !== undefined && !ACP_SESSION_EXPIRED_RE.test(agentFailure)) {
    const last = readPersistedStatus(slug)

    if (last?.configured) {
      return { ...last, cli: true, version: health.version, stale: true, checkedAt: Date.now() }
    }
  }

  if (agentFailure !== undefined && ACP_SESSION_EXPIRED_RE.test(agentFailure)) {
    // An expired Virtuals session is NOT an answer that the agent, its wallet or its card are gone. A status written
    // as "unconfigured" here would send the owner back through Setup (and the Bank to a false "No card yet" that
    // invites a KYC-blocked re-signup). Keep the last known configured status, flagged, and let the renderer ask
    // for a sign-in.
    const last = readPersistedStatus(slug)

    if (last?.configured) {
      const kept: InftAcpStatus = {
        ...last,
        cli: true,
        version: health.version,
        authenticated: false,
        sessionExpired: true,
        stale: true,
        checkedAt: Date.now()
      }

      try {
        writeFileAtomic(path.join(inftRoot(slug), 'status.json'), JSON.stringify(kept, null, 2))
      } catch {
        // Cache only.
      }

      return kept
    }
  }

  if (agent.ok && agentJson && !envelopeError(agentJson)) {
    status.authenticated = true
    status.agentId = firstString(agentJson, ['id', 'agentId', 'agent_id'])
    status.agentName = firstString(agentJson, ['name', 'agentName'])
    status.walletAddress = firstString(agentJson, ['walletAddress'])
    status.solanaAddress = firstString(agentJson, ['solWalletAddress', 'solanaAddress'])
  }

  if (status.authenticated) {
    if (!status.walletAddress) {
      const wallet = await runAcp(inftId, ['wallet', 'address', '--json'], undefined, 'background')

      status.walletAddress =
        firstString(asRecord(parseJsonLoose(wallet.stdout)), ['address']) ??
        wallet.stdout.match(/0x[0-9a-fA-F]{40}/)?.[0]
    }

    // After a signup the cached card answer predates it: the next read asks the service again —
    // unless the signup itself answered 403/429: inside that hold nothing reads the card, and the
    // due mark survives it (cardDueSince is undefined until the hold ends).
    const cardHeld = cardSignupHeldUntil(slug) !== undefined
    const signupEnded = cardDueSince(slug)

    await probeAgentFacets(
      argv => runAcp(inftId, argv, undefined, 'background'),
      status,
      readPersistedStatus(slug),
      cardHeld ? { ...opts, card: false, cardHeld } : signupEnded === undefined ? opts : { ...opts, card: true }
    )

    if (!status.cardStale) {
      settleCardDue(slug, status.cardCheckedAt)
    }
  }

  status.configured = status.authenticated && Boolean(status.agentId)

  try {
    writeFileAtomic(path.join(inftRoot(slug), 'status.json'), JSON.stringify(status, null, 2))
  } catch {
    // Cache only — live probes still answer.
  }

  writeInftRegistry()

  return status
}

function readConfigMap(): Record<string, InftAcpStatus> {
  const map: Record<string, InftAcpStatus> = {}
  const root = path.join(app.getPath('userData'), 'inft')

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue
      }

      const status = readPersistedStatus(entry.name)

      if (status) {
        map[entry.name] = status
      }
    }
  } catch {
    // No inft root yet.
  }

  return map
}

// ── the agent's own `acp` ───────────────────────────────────────────────────
//
// The iNFT's Hermes agent runs commands in a plain local shell (the primary
// backend's environment: no ACP_CONFIG_DIR, `~/.local/bin/acp` = the owner's
// personal config). So the app installs `~/.iclone-os/bin/acp`, a client of
// the app's socket that runs ONE iNFT's commands against that iNFT's isolated
// config and the app's own bundled CLI — the same runtime, env, scratch cwd
// and queue the bridge above uses. The `economyos` skill teaches the agent to
// call it as `acp --inft <token|slug> …`; `~/.iclone-os/inft.tsv` lists the
// iNFTs for the agent to read, and the app resolves the key itself.

function icloneDir(): string {
  return path.join(os.homedir(), '.iclone-os')
}

interface InftRegistryRow {
  token: string
  slug: string
  configDir: string
  name: string
  profile: string
}

/** `robinhood-0x4dfb…-6` → the row the wrapper matches on (token, slug, profile, name). */
export function registryRowFor(slug: string, configDir: string, name?: string): InftRegistryRow | null {
  const match = /^(?:[a-z0-9]+-)?(0x[0-9a-f]{40})-(\d{1,12})$/.exec(slug)

  if (!match) {
    return null
  }

  const [, contract, token] = match

  return {
    token,
    slug,
    configDir,
    name: (name ?? '').replace(/[\t\r\n]/g, ' ').trim() || `#${token}`,
    profile: `inft-${contract.slice(2, 8)}-${token}`
  }
}

export function renderInftRegistry(rows: InftRegistryRow[]): string {
  const lines = ['# token\tslug\tconfigDir\tname\tprofile — written by iclone os; read by ~/.iclone-os/bin/acp']

  for (const row of [...rows].sort((a, b) => Number(a.token) - Number(b.token) || a.slug.localeCompare(b.slug))) {
    lines.push([row.token, row.slug, row.configDir, row.name, row.profile].join('\t'))
  }

  return `${lines.join('\n')}\n`
}

function writeInftRegistry(): void {
  const file = path.join(icloneDir(), 'inft.tsv')

  try {
    let existing = ''

    try {
      existing = readFileSync(file, 'utf8')
    } catch {
      // No registry yet: this instance writes the first one.
    }

    const rows = mergeInftRegistry(parseInftRegistry(existing), currentRegistryRows(), inftsDir(), existsSync)
    writeFileAtomic(file, renderInftRegistry(rows))
  } catch (error) {
    console.warn('[iclone] inft registry write failed:', error)
  }
}

/** The iNFT on the stage, for a wrapper call without `--inft`. */
let stageSlug: string | null = null
/** The market window's job stream (iclone-acp-watch.ts); the stage only ever stops it. */
let acpWatch: AcpWatch | null = null

/** The watcher's child: startCli's launch, env, config dir and scratch cwd, plus what the
 *  watcher needs and CliProcess hides — the pid for the log and a real SIGKILL (a utility
 *  process's kill() is SIGTERM only, and the CLI's async SIGTERM shutdown can hang). */
function startWatchCli(rt: AcpRuntime, slug: string, argv: readonly string[]): WatchChild {
  const cwd = scratchCwd(slug)
  const env = childEnv(rt, configDirFor(slug))
  const launch = launchArgv(rt, [...argv])

  if (launch.kind === 'spawn') {
    // A system binary (dev only): startCli's kill is already SIGKILL.
    return startCli(rt, [...argv], cwd, env)
  }

  console.info(`[iclone-acp] spawn ${path.basename(cwd)} ${argv[0] ?? '-'} ${argv[1] ?? '-'}`)

  const child = utilityProcess.fork(launch.modulePath, launch.args, {
    serviceName: 'iclone-acp-watch',
    stdio: 'pipe',
    cwd,
    env
  })

  hearLauncher(child)

  // child.pid is undefined until 'spawn' and again after 'exit': keep it for the log. A kill()
  // before 'spawn' is a no-op on a utility process (2026-10-16 lab: the listener of a window
  // closed at once lived on), so an early kill is held and sent on 'spawn'.
  let pid: number | null = null
  let early: 'SIGTERM' | 'SIGKILL' | null = null

  const send = (signal: 'SIGTERM' | 'SIGKILL') => {
    if (signal === 'SIGKILL' && child.pid) {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    } else {
      child.kill()
    }
  }

  child.once('spawn', () => {
    pid = child.pid ?? null
    console.info(`[iclone-acp-watch] pid ${pid ?? '?'} for ${path.basename(cwd)}${early ? ` (held ${early})` : ''}`)

    if (early) {
      send(early)
    }
  })

  return {
    stdout: child.stdout,
    stderr: child.stderr,
    get pid() {
      return pid ?? child.pid ?? null
    },
    kill: signal => {
      if (pid === null && !child.pid) {
        early = signal === 'SIGKILL' || early === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'

        return
      }

      send(signal ?? 'SIGTERM')
    },
    done: new Promise(resolve => {
      const drained = Promise.all([child.stdout, child.stderr].map(ended))

      child.once('exit', code => void Promise.race([drained, sleep(2000)]).then(() => resolve({ code })))
      child.once('error', (type: string, location: string) => resolve({ code: null, error: `${type} at ${location}` }))
    })
  }
}

function writeStage(slug: string | null): void {
  const file = path.join(icloneDir(), 'stage')

  stageSlug = slug && /^[a-z0-9-]{1,80}$/.test(slug) ? slug : null
  acpWatch?.stage(stageSlug)

  try {
    if (slug && /^[a-z0-9-]{1,80}$/.test(slug)) {
      writeFileAtomic(file, `${slug}\n`)
    } else {
      rmSync(file, { force: true })
    }
  } catch {
    // Best effort — the agent then has to pass --inft explicitly.
  }
}

// ── per-iNFT kv + detach ────────────────────────────────────────────────────

function inftsDir(): string {
  return path.join(app.getPath('userData'), 'inft')
}

persistCardHoldsUnder(inftsDir)

interface InftDetachResult {
  ok: boolean
  error?: string
  removed: string[]
  kept: string[]
  agentId?: string
}

/** Forget one iNFT's local agent setup: the whole `userData/inft/<slug>` dir
 *  (CLI config, status, notes, signup state) and its scratch dir, then the
 *  registry and the stage. The keychain and the signer store stay. */
async function detachInft(inftId: string): Promise<InftDetachResult> {
  const slug = slugForInft(String(inftId ?? ''))

  if (lanes.size(slug) > 0) {
    return {
      ok: false,
      error: 'a CLI call is running for this iNFT — try again when it finishes',
      removed: [],
      kept: []
    }
  }

  const agentId = readPersistedStatus(slug)?.agentId
  const result = removeInftDirs(inftsDir(), path.join(os.tmpdir(), 'iclone-acp'), slug)

  if (!result.ok) {
    return { ok: false, error: result.error, removed: [], kept: [] }
  }

  forgetCardSignup(slug)

  if (stageSlug === slug) {
    writeStage(null)
  }

  writeInftRegistry()

  return { ok: true, removed: result.removed, kept: DETACH_KEPT, agentId }
}

function kvCall(op: 'get' | 'set' | 'delete', inftId: unknown, key: unknown, value?: unknown): KvResult {
  const slug = slugForInft(String(inftId ?? ''))

  if (op === 'get') {
    return readInftKv(inftsDir(), slug, key)
  }

  return op === 'set' ? writeInftKv(inftsDir(), slug, key, value) : deleteInftKv(inftsDir(), slug, key)
}

// ── the agent's door: the app-owned socket ──────────────────────────────────

const AGENT_TIMEOUT_MS = 10 * 60_000

function currentRegistryRows(): InftRegistryRow[] {
  const rows: InftRegistryRow[] = []
  const statuses = readConfigMap()
  const root = path.join(app.getPath('userData'), 'inft')

  mkdirSync(root, { recursive: true })

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const row = registryRowFor(entry.name, path.join(root, entry.name, 'acp'), statuses[entry.name]?.agentName)

      if (row) {
        rows.push(row)
      }
    }
  }

  return rows
}

/** Pure: `--inft <token|slug|name|profile>` (or the stage) → one iNFT. */
export function resolveInftKey(rows: InftRegistryRow[], key: string | null, stage: string | null): InftResolution {
  const known = () =>
    rows.length ? rows.map(row => `  --inft ${row.token}   ${row.slug}   (${row.name})`).join('\n') : '  (none yet)'

  const wanted = (key ?? stage ?? '').trim().toLowerCase()

  if (!wanted) {
    return { ok: false, error: `which iNFT? no --inft given and none is on the stage. Known:\n${known()}` }
  }

  const matches = rows.filter(row =>
    [row.token, row.slug, row.name, row.profile].some(value => value.toLowerCase() === wanted)
  )

  if (matches.length === 0) {
    return { ok: false, error: `no iNFT matches '${wanted.slice(0, 80)}'. Known:\n${known()}` }
  }

  if (matches.length > 1) {
    return {
      ok: false,
      error: `'${wanted.slice(0, 80)}' matches several iNFTs — pass the full slug:\n${matches.map(row => `  --inft ${row.slug}   (${row.name})`).join('\n')}`
    }
  }

  return { ok: true, slug: matches[0].slug }
}

/** One agent command for one iNFT: the same runtime, env, scratch cwd and
 *  per-iNFT queue as the in-app bridge. Streaming readers (`events listen`,
 *  `job watch`) run beside the queue — they would hold it for hours. */
async function runForAgent(
  slug: string,
  argv: string[],
  streaming: boolean,
  sink: AgentRunSink
): Promise<{ code: number | null; error?: string }> {
  const health = await ensureRuntime()

  if (health.ok === false) {
    return { code: null, error: health.error }
  }

  const rt = health.rt

  // Only a signup keeps its words (bounded): main judges the signup's 403/429 hold on them.
  const keep = isCardSignup(argv)
  const said = { stdout: '', stderr: '' }

  const tee = (key: 'stdout' | 'stderr', chunk: string) => {
    if (keep && said[key].length < SIGNUP_ANSWER_CAP) {
      said[key] += chunk.slice(0, SIGNUP_ANSWER_CAP - said[key].length)
    }
  }

  const job = async () => {
    if (sink.signal.aborted) {
      return { code: null, error: 'the client went away' }
    }

    const blocked = await spawnGate(rt)

    if (blocked) {
      return { code: null, error: blocked }
    }

    const child = startCli(rt, argv, scratchCwd(slug), childEnv(rt, configDirFor(slug)))
    const stop = () => child.kill()
    const timer = streaming ? undefined : setTimeout(stop, AGENT_TIMEOUT_MS)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      tee('stdout', chunk)
      sink.stdout(chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      tee('stderr', chunk)
      sink.stderr(chunk)
    })
    sink.signal.addEventListener('abort', stop, { once: true })

    try {
      return await child.done
    } finally {
      clearTimeout(timer)
      sink.signal.removeEventListener('abort', stop)
    }
  }

  return streaming
    ? job()
    : withCardSignupSlot(
        slug,
        argv,
        () => lanes.run(slug, isAcpRead(argv) ? 'background' : 'exclusive', job),
        reason => ({ code: null, error: reason }),
        result => ({ ok: result.code === 0 && !result.error, code: result.code, ...said, error: result.error })
      )
}

/**
 * The agent's `acp`: a POSIX shim that hands argv to the app's socket through
 * a Python client (the managed Hermes runtime's own Python — nothing new
 * ships, nothing here interprets caller code). Pure so the test can run it
 * against a fake server. `card issue` and every other refusal is decided by
 * the server (iclone-acp-ipc.ts), never by this text.
 */
export function acpWrapperSource(socketPath: string, tokenPath: string): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

  const client = [
    'import json, socket, sys',
    'sock_path, token_path, key = sys.argv[1], sys.argv[2], sys.argv[3]',
    'def bye(message, code):',
    '    sys.stderr.write("acp: " + message + "\\n")',
    '    sys.exit(code)',
    'try:',
    '    with open(token_path) as handle:',
    '        token = handle.read().strip()',
    '    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
    '    conn.connect(sock_path)',
    'except OSError:',
    '    bye("iclone os is not running — open iclone os, then run the command again", 3)',
    'request = {"v": 1, "token": token, "inft": key or None, "argv": sys.argv[4:]}',
    'conn.sendall((json.dumps(request) + "\\n").encode("utf-8"))',
    'code = 1',
    'try:',
    '    for raw in conn.makefile("rb"):',
    '        frame = json.loads(raw)',
    '        if frame["t"] == "o":',
    '            sys.stdout.write(frame["d"])',
    '            sys.stdout.flush()',
    '        elif frame["t"] == "e":',
    '            sys.stderr.write(frame["d"])',
    '            sys.stderr.flush()',
    '        elif frame["t"] == "x":',
    '            code = int(frame["c"])',
    '            break',
    'except KeyboardInterrupt:',
    '    code = 130',
    'sys.exit(code)'
  ].join('\n')

  return `#!/bin/sh
# acp — the Virtuals ACP CLI for ONE iNFT, run by iclone os (installed by iclone os).
#   acp --inft <token|slug|profile> <command…> --json
# Without --inft (or ICLONE_INFT) the iNFT on the stage is used. This is only a
# client: the app runs the command, so iclone os must be open.
KEY="\${ICLONE_INFT:-}"
if [ "$1" = "--inft" ]; then
  KEY="$2"
  shift 2
fi
PY=""
for candidate in "$HOME/.hermes/hermes-agent/venv/bin/python3" "$HOME/.hermes/hermes-agent/.venv/bin/python3" "$(command -v python3 2>/dev/null)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    PY="$candidate"
    break
  fi
done
if [ -z "$PY" ]; then
  echo "acp: no Python found to reach iclone os — reinstall the Hermes runtime from iclone os" >&2
  exit 2
fi
exec "$PY" -c ${q(client)} ${q(socketPath)} ${q(tokenPath)} "$KEY" "$@"
`
}

/** A dev build (the lab, a second `--user-data-dir`) never takes over the
 *  one wrapper every terminal uses — it would point the packaged app's agent
 *  at a dev socket. `ICLONE_INSTALL_WRAPPER=1` opts a dev build in. */
export function shouldInstallAcpWrapper(packaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return packaged || env.ICLONE_INSTALL_WRAPPER === '1'
}

/** The wrapper every terminal runs, written whole (tmp + rename): an `acp` started mid-install never runs a
 *  half-written script, and the mode is 0755 whatever the umask or the file it replaces. */
export function writeAcpWrapper(file: string, source: string): void {
  writeFileAtomicSync(file, source, { mode: 0o755 })
}

function installAcpWrapper(socketPath: string, tokenPath: string): void {
  if (!shouldInstallAcpWrapper(app.isPackaged)) {
    return
  }

  try {
    const bin = path.join(icloneDir(), 'bin')

    mkdirSync(icloneDir(), { recursive: true, mode: 0o700 })
    mkdirSync(bin, { recursive: true })

    const file = path.join(bin, 'acp')

    writeAcpWrapper(file, acpWrapperSource(socketPath, tokenPath))
  } catch (error) {
    console.warn('[iclone] acp wrapper install failed:', error)
  }
}

async function startAgentDoor(): Promise<void> {
  const dir = path.join(app.getPath('userData'), 'run')

  try {
    const server = await startAcpSocketServer({
      dir,
      resolveInft: key => resolveInftKey(currentRegistryRows(), key, stageSlug),
      // K29: the same verdict the market window's listener gets (V3-I's windowMay, set at startup).
      admitStreaming: slug => windowAdmits(slug),
      run: runForAgent,
      log: line => console.info(line)
    })

    app.once('will-quit', () => server.close())
    installAcpWrapper(server.socketPath, path.join(dir, 'acp.token'))
  } catch (error) {
    console.warn('[iclone-acp-ipc] the agent door did not open:', error)
  }
}

// ── the packaged self-test: `--iclone-selftest=acp|pty|all` ─────────────────
//
// Headless proof that the SHIPPED, fused app can still run its two child
// runtimes: the ACP CLI in a utility process (with its keychain binding loaded
// but no keychain call) and node-pty through spawn-helper. Fixed bundled code
// paths only; no window, no lock, a throwaway userData; JSON on stdout and
// exit 0/1. scripts/verify-packaged-acp.mjs drives it.

type SelftestMode = 'acp' | 'pty' | 'all'

function selftestModeFrom(argv: readonly string[]): SelftestMode | null {
  for (const arg of argv) {
    const match = /^--iclone-selftest=(acp|pty|all)$/.exec(arg)

    if (match) {
      return match[1] as SelftestMode
    }
  }

  return null
}

interface CheckResult {
  ok: boolean
  error?: string
  [detail: string]: unknown
}

/**
 * REL-6 (ruling 26): the bundle carries no CLI. The packaged proof is that it carries none (no Resources/acp-cli) and
 * that the pin it installs from at first use parses and is the one it was built with. No CLI command runs here: the
 * throwaway userData of a self-test never has an install.
 */
async function selftestAcp(): Promise<CheckResult> {
  if (app.isPackaged && existsSync(path.join(process.resourcesPath, 'acp-cli'))) {
    return { ok: false, bundled: true, error: 'Resources/acp-cli is in the bundle (REL-6: the app ships only the pin)' }
  }

  const { pinDir, launcher } = pinPaths()

  try {
    const lockText = readFileSync(path.join(pinDir, 'package-lock.json'), 'utf8')
    const pin = parsePin(readFileSync(path.join(pinDir, 'package.json'), 'utf8'), lockText)
    const rows = runtimeClosure(pin, { platform: process.platform, arch: process.arch, libc: linuxLibc() })

    if (!existsSync(launcher)) {
      return { ok: false, bundled: false, error: 'acp-pin/launch.cjs is missing' }
    }

    return {
      ok: true,
      bundled: false,
      version: pin.cliVersion,
      lockSha256: createHash('sha256').update(lockText).digest('hex'),
      packages: rows.length
    }
  } catch (error) {
    return { ok: false, bundled: false, error: `the ACP pin does not parse: ${errorMessage(error)}` }
  }
}

async function selftestPty(): Promise<CheckResult> {
  const pty = await import('node-pty')

  return new Promise<CheckResult>(resolve => {
    let output = ''

    const term = pty.spawn('/bin/echo', ['ok'], {
      name: 'xterm',
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
      env: sealTelemetryEnv({})
    })

    const timer = setTimeout(() => {
      term.kill()
      resolve({ ok: false, error: 'node-pty: no exit within 10s' })
    }, 10_000)

    term.onData(data => {
      output += data
    })
    term.onExit(({ exitCode }) => {
      clearTimeout(timer)
      const ok = exitCode === 0 && output.trim() === 'ok'

      resolve(ok ? { ok } : { ok, error: `node-pty: exit ${exitCode}, output ${JSON.stringify(output.slice(0, 80))}` })
    })
  })
}

async function runSelftest(mode: SelftestMode): Promise<Record<string, unknown>> {
  const guard = async (check: () => Promise<CheckResult>): Promise<CheckResult> => {
    try {
      return await check()
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const acp = mode === 'pty' ? undefined : await guard(selftestAcp)
  const pty = mode === 'acp' ? undefined : await guard(selftestPty)

  return {
    selftest: mode,
    ok: (acp?.ok ?? true) && (pty?.ok ?? true),
    electron: process.versions.electron,
    packaged: app.isPackaged,
    ...(acp ? { acp } : {}),
    ...(pty ? { pty } : {})
  }
}

/** Main-process entry. Returns true when this launch is a self-test: the
 *  caller then skips the lock and the app's own startup. */
export function startIcloneSelftest(argv: readonly string[]): boolean {
  const mode = selftestModeFrom(argv)

  if (!mode) {
    return false
  }

  app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'iclone-selftest-')))
  console.info(`[iclone-selftest] mode=${mode}`)

  void app
    .whenReady()
    .then(() => runSelftest(mode))
    .then(
      result => {
        process.stdout.write(`${JSON.stringify(result)}\n`)
        app.exit(result.ok ? 0 : 1)
      },
      error => {
        process.stdout.write(`${JSON.stringify({ selftest: mode, ok: false, error: String(error) })}\n`)
        app.exit(1)
      }
    )

  return true
}

let initialized = false

/** The P7 seam (createAppSenderGuard in main.ts): which IPC senders are the app's own renderer. */
export type AcpSenderGuard = (event: IpcSenderEventLike, channel: string) => boolean

export interface IcloneAcpDeps {
  /** Required: every iclone:acp-* / inft-kv / email-state channel reaches the CLI, the wallet or the agent's files. */
  isTrustedSender: AcpSenderGuard
  /** REL-6: main's gesture verdict for an IPC sender and payload (V3-F `permissionGestureOk`). Absent = no gesture. */
  gestureOk?: (event: unknown, input: unknown) => boolean
  /** REL-6: the OS sealing for the installed tree's manifest key (safeStorage). Absent: nothing installs or runs.
   *  V3-FX M1: a function is read on every check, so the owner's Keychain setting takes effect live. */
  sealer?: KeySealer | null | (() => KeySealer | null)
  /** FX-2: why there is no sealer (the Keychain setting off, or an OS that cannot seal); live when a function. */
  noSealReason?: 'keychain-off' | 'unsealable' | (() => 'keychain-off' | 'unsealable')
  /** REL-6: V3-F's audit for the install (class I) and the tree's refusals. Absent = the install is refused. */
  audit?: InstallAuditSink
  /** REL-6: every tools state change, to the app windows (`iclone:acp-tools:changed`). */
  broadcastTools?: (view: unknown) => void
  /** REL-6: opens a fixed local file (the notices); the renderer never names a path. */
  openFile?: (file: string) => Promise<unknown>
}

/** V3-F's audit for the tools (set by initIcloneAcp). No audit: every install is refused (requestInstall). */
let installAudit: InstallAuditSink = () => null

/** A watch child start, refused with the reason and as terminal when the tools are what is missing. */
async function startVerifiedWatch(slug: string, argv: readonly string[]): Promise<WatchStart> {
  const health = await ensureRuntime()

  if (health.ok === false) {
    return { error: health.error, terminal: tools?.problem() != null }
  }

  const blocked = await spawnGate(health.rt)

  return blocked ? { error: blocked, terminal: true } : startWatchCli(health.rt, slug, argv)
}

/** V3-FX M1: the owner's Keychain setting changed — check the tools again (their state and words follow it). */
export function refreshAcpToolsSealing(): void {
  void tools?.refresh()
}

/** REL-6: why the ACP tools cannot run right now (no disk access), or null. WORK refuses "online" on it. */
export function acpToolsProblem(): string | null {
  return devOverride() ? null : (tools?.problem() ?? problemText('unavailable', 'installer-down'))
}

export function initIcloneAcp(deps: IcloneAcpDeps) {
  if (initialized) {
    return
  }

  initialized = true
  installAudit = deps.audit ?? (() => null)

  const { pinDir, launcher } = pinPaths()

  const target = { platform: process.platform, arch: process.arch, libc: linuxLibc() }

  const sealer = deps.sealer
  const noSeal = deps.noSealReason

  tools = createAcpTools({
    root: path.join(app.getPath('userData'), 'acp-cli'),
    pinDir,
    launcher,
    target,
    fetch: registryFetch,
    // V3-FX M1: read on every check and install, so a Keychain toggle takes effect without a restart.
    get sealer() {
      return typeof sealer === 'function' ? sealer() : (sealer ?? null)
    },
    get noSealReason() {
      return typeof noSeal === 'function' ? noSeal() : noSeal
    },
    // The record of the install lives in V3-F's protected state, not beside the tree (lead ruling on critic m7).
    record: fileRecordStore(path.join(app.getPath('userData'), 'permissions', 'acp-tools-install.json')),
    native: nativeAddons(targetName(target)),
    audit: entry => installAudit({ ...entry, kind: entry.kind === 'use' ? 'use' : 'refuse', gesture: false }),
    log: line => console.info(line),
    onChange: view => {
      // Any change of the tools (installed, removed, changed under us) re-earns the self-test.
      healthy = null
      failed = null
      deps.broadcastTools?.(view)
    }
  })
  void tools.refresh()
  // Same check as the terminal and consent IPC: a sender the guard refuses (a <webview> guest, a subframe, a window
  // on a remote page, a destroyed or unknown webContents) gets null and never reaches the handler. No guard = refuse.
  const isTrustedSender: AcpSenderGuard = deps?.isTrustedSender ?? (() => false)
  const ipc = guardedHandler(ipcMain, isTrustedSender)

  ipc.handle('iclone:acp-check', () => checkRuntime())
  // The owner's own AgentCard account (`agentcard` CLI): a state only, never its output.
  ipc.handle('iclone:agentcard-status', () => agentcardStatus())
  ipc.handle('iclone:acp-run', (_event, inftId: string, argv: unknown, timeoutMs?: number) =>
    runAcp(String(inftId ?? ''), argv, timeoutMs)
  )
  ipc.handle('iclone:acp-status', (_event, inftId: string, opts: unknown) =>
    readStatus(String(inftId ?? ''), statusOptions(opts))
  )
  ipc.handle('iclone:inft-kv-get', (_event, inftId: unknown, key: unknown) => kvCall('get', inftId, key))
  ipc.handle('iclone:inft-kv-set', (_event, inftId: unknown, key: unknown, value: unknown) =>
    kvCall('set', inftId, key, value)
  )
  ipc.handle('iclone:inft-kv-delete', (_event, inftId: unknown, key: unknown) => kvCall('delete', inftId, key))
  ipc.handle('iclone:email-state', (_event, op: unknown, slug: unknown, value?: unknown) =>
    emailStateCall(inftsDir(), op, slug, value)
  )
  ipc.handle('iclone:acp-detach', (_event, inftId: unknown) => detachInft(String(inftId ?? '')))
  ipc.handle('iclone:acp-config-map', () => readConfigMap())
  ipc.handle('iclone:acp-install', (event, input) => installAcp(deps.gestureOk?.(event, input) === true))
  ipc.handle('iclone:acp-update-check', () => checkAcpUpdate())
  ipc.handle('iclone:acp-stage', (_event, slug: unknown) => writeStage(typeof slug === 'string' ? slug : null))
  registerAcpToolsIpc({
    ipcMain,
    isTrustedSender,
    tools,
    gestureOk: (event, input) => deps.gestureOk?.(event, input) === true,
    audit: entry => installAudit(entry),
    openFile: file => deps.openFile?.(file) ?? Promise.resolve(false),
    appNotices: app.isPackaged
      ? path.join(process.resourcesPath, 'THIRD_PARTY_NOTICES.md')
      : path.resolve(app.getAppPath(), '..', '..', 'THIRD_PARTY_NOTICES.md')
  })
  acpWatch = initAcpWatch({
    isTrustedSender,
    start: startVerifiedWatch,
    streaming: streamingSlugs,
    keychainPromptShowing,
    log: line => console.info(line),
    admit: slug => windowAdmits(slug)
  })

  // The agent's own door to the same CLI — a fresh socket, token and wrapper
  // every launch, so the wrapper always reaches THIS install.
  writeInftRegistry()
  writeStage(null)
  void startAgentDoor()
}

/** V3-I — main's WORK supervisor decides whether the market window may listen for an iNFT (set once at startup). */
let windowAdmits: (slug: string) => boolean = () => true

/** V3-I seam — the WORK supervisor (electron/iclone-acp-work/): its listener spawns exactly like the market window's,
 *  its reads go through the window's own allowlist, lanes and expiry gate, and it alone says whether the window's
 *  listener may run for a slug. */
export const acpWorkCli = {
  listen: (slug: string, argv: readonly string[]): Promise<WatchStart> => startVerifiedWatch(slug, argv),
  /** REL-6: the tools are absent or unverified (WORK refuses "online" and names it in its fixes). */
  toolsProblem: acpToolsProblem,
  read: (slug: string, argv: string[]): Promise<AcpRunResult> => runAcp(slug, argv, undefined, 'background'),
  /** The window's listener lets go of the slug: a live child, one starting, or one waiting out its backoff. */
  yieldWindowWatch: (slug: string): void => {
    if (acpWatch?.watching() === slug) {
      acpWatch.stop('the WORK supervisor holds this iNFT')
    }
  },
  /** Sign-out or a wallet switch: the window's listener stops, whatever it holds. */
  stopWindowWatch: (why: string): void => acpWatch?.stop(why),
  setWindowAdmission: (admits: (slug: string) => boolean): void => {
    windowAdmits = admits
  },
  keychainPromptShowing
}
