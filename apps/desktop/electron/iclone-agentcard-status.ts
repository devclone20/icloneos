/**
 * iclone os — the owner's own AgentCard account (the `agentcard` CLI), read-only, as one of three states, or
 * none (unknown) when the CLI's answers do not say.
 *
 * The second AgentCard path next to the iNFT's `acp card`: a separate account, signed in from a terminal.
 * The Bank names its state in one sentence, so the owner knows which of the two needs him.
 *
 * Read-only by construction: only `whoami`, `identity --json --no-open` and a bare `limit` run (each a GET;
 * `--no-open` keeps the browser shut, a bare `limit` never sets one). stdin is closed, so nothing can prompt;
 * the CLI's self-update is skipped. The answers are mapped here and dropped: no e-mail, token or identity URL
 * (it carries the session token) leaves this module, is logged, or is kept.
 *
 * The map follows what CLI 0.4.0 really prints (dist/src/commands/{whoami,identity,limit}.js, lib/api.js):
 * - a 401 on any call exits 1 with "Session expired"; no stored token prints "Not logged in";
 * - `whoami` swallows every other failure (403, 5xx, network) into "Failed to verify session", exit 0;
 * - `identity --json` prints `status: null` on any failure, never the reason;
 * - a bare `limit` failure prints only the server's own `error`/`message`, never the HTTP status.
 * No answer names a blocked account, so none is guessed: a refusal reads as unknown, and the Bank shows only
 * the two-paths sentence it already has.
 */
import { execFile } from 'node:child_process'
import { accessSync, chmodSync, constants as fsConstants, lstatSync, mkdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ensureLoginShellPath } from './shell-path'

export type AgentcardAccountState = 'kyc-required' | 'ready' | 'signed-out'

/** One CLI run, as the probe sees it. `code` null = it never ran or was killed (missing CLI, timeout). */
export interface AgentcardAnswer {
  code: number | null
  stdout: string
  stderr: string
  /** No `agentcard` on the resolved PATH: the CLI never ran, and this answer is not kept (K66). */
  missing?: boolean
}

export interface AgentcardAnswers {
  whoami: AgentcardAnswer
  identity?: AgentcardAnswer
  limit?: AgentcardAnswer
}

export type AgentcardRun = (args: readonly string[]) => Promise<AgentcardAnswer>

const WHOAMI = ['whoami'] as const
const IDENTITY = ['identity', '--json', '--no-open'] as const
const LIMIT = ['limit'] as const

const RUN_TIMEOUT_MS = 15_000
const OUTPUT_CAP = 64 * 1024
const CACHE_MS = 5 * 60_000

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

const SIGNED_OUT = /not logged in|session expired/i
const SIGNED_IN = /human email:/i
const KYC_DONE = new Set(['verified', 'exempt'])
/** Submitted and under review: nothing for the owner to do, so "needs KYC" would mislead — unknown. */
const KYC_IN_REVIEW = 'processing'

function text(answer: AgentcardAnswer | undefined): string {
  return answer ? `${answer.stdout}\n${answer.stderr}`.replace(ANSI, '') : ''
}

type Kyc = 'done' | 'required' | 'unknown'

/** `identity --json` prints `{ ok, url, status }`; only `status` is read — `url` carries the session token. */
function kycOf(answer: AgentcardAnswer | undefined): Kyc {
  if (!answer || answer.code !== 0) {
    return 'unknown'
  }

  const start = answer.stdout.indexOf('{')
  let status: unknown

  try {
    status = start < 0 ? undefined : (JSON.parse(answer.stdout.slice(start)) as { status?: unknown }).status
  } catch {
    return 'unknown'
  }

  if (!status || typeof status !== 'object') {
    return 'unknown'
  }

  const { identityVerificationStatus: verification, identityVerificationRequired: required } = status as Record<
    string,
    unknown
  >

  if ((typeof verification === 'string' && KYC_DONE.has(verification)) || required === false) {
    return 'done'
  }

  // As the CLI itself judges it: anything else (requires_input, canceled, not started) still needs KYC.
  return verification === KYC_IN_REVIEW ? 'unknown' : 'required'
}

/**
 * The account's state from the CLI's own answers, or null (unknown) when they do not say: no CLI, a timeout,
 * a refused or failed read. Signed out outranks KYC, and KYC outranks every failed read, so a KYC-pending
 * account whose `limit` is refused still reads as needing KYC. "ready" needs all three reads to say so.
 */
export function agentcardStateFrom(answers: AgentcardAnswers): AgentcardAccountState | null {
  const all = [answers.whoami, answers.identity, answers.limit]

  if (all.some(answer => SIGNED_OUT.test(text(answer)))) {
    return 'signed-out'
  }

  const kyc = kycOf(answers.identity)

  if (kyc === 'required') {
    return 'kyc-required'
  }

  const signedIn = answers.whoami.code === 0 && SIGNED_IN.test(text(answers.whoami))
  const limitRead = answers.limit?.code === 0

  return signedIn && kyc === 'done' && limitRead ? 'ready' : null
}

/** Runs the three reads (the last two only for a session `whoami` did not already rule out) and maps them. */
export async function probeAgentcardAccount(run: AgentcardRun): Promise<AgentcardAccountState | null> {
  const whoami = await run(WHOAMI)

  if (whoami.code === null || SIGNED_OUT.test(text(whoami))) {
    return agentcardStateFrom({ whoami })
  }

  const [identity, limit] = await Promise.all([run(IDENTITY), run(LIMIT)])

  return agentcardStateFrom({ whoami, identity, limit })
}

/**
 * K66: what the CLI's process sees — a bare environment, never the app's own. A third-party CLI gets HOME (its
 * session file), PATH (its `node`), LANG, TMPDIR and USER, plus the four switches that keep it quiet; no app
 * secret, token or endpoint from `process.env` reaches it.
 */
function agentcardEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: base.HOME || os.homedir(),
    PATH: base.PATH || '/usr/bin:/bin',
    LANG: base.LANG || 'en_US.UTF-8',
    TMPDIR: base.TMPDIR || os.tmpdir(),
    AGENTCARD_SKIP_UPDATE: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: '1'
  }

  if (base.USER) {
    env.USER = base.USER
  }

  return env
}

/** The first executable `name` on `searchPath` (absolute entries only), or null. Never a relative or cwd lookup. */
export function resolveOnPath(name: string, searchPath: string | undefined): null | string {
  for (const dir of (searchPath ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) {
      continue
    }

    const candidate = path.join(dir, name)

    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, fsConstants.X_OK)

        return candidate
      }
    } catch {
      // Not here, or not executable: the next entry.
    }
  }

  return null
}

/**
 * A working directory of its own, so no `.env` of the app's cwd (or any other) is ever loaded by the CLI. n2 (V3-K
 * critic r1): the name is fixed, so an existing entry is checked before use: a real directory (not a symlink) owned by
 * this user, closed to others (0700, tightened if it was wider). Anything else is refused, never followed.
 */
export function agentcardScratchCwd(root: string = os.tmpdir()): string {
  const dir = path.join(root, 'iclone-agentcard')

  mkdirSync(dir, { recursive: true, mode: 0o700 })

  const entry = lstatSync(dir)

  if (!entry.isDirectory() || (typeof process.getuid === 'function' && entry.uid !== process.getuid())) {
    throw new Error(`refusing ${dir}: not a directory owned by this user`)
  }

  if ((entry.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700)
  }

  for (const name of ['.env', '.env.local']) {
    rmSync(path.join(dir, name), { force: true })
  }

  return dir
}

interface AgentcardRunDeps {
  /** Resolves the login-shell PATH into `process.env` first (single-flight, never rejects). */
  ensurePath?: () => Promise<unknown>
  /** Read after `ensurePath`: the PATH the binary is looked up on and the child's environment is built from. */
  env?: () => NodeJS.ProcessEnv
  cwd?: () => string
  execFileFn?: typeof execFile
}

/** The real CLI: an absolute binary, a bare environment, a scratch cwd; never interactive, never a browser,
 *  never a self-update, never a colour code. */
export function createAgentcardRun({
  ensurePath = ensureLoginShellPath,
  env = () => process.env,
  cwd = agentcardScratchCwd,
  execFileFn = execFile
}: AgentcardRunDeps = {}): AgentcardRun {
  return async args => {
    await ensurePath()

    const base = env()
    const binary = resolveOnPath('agentcard', base.PATH)

    if (!binary) {
      return { code: null, stdout: '', stderr: '', missing: true }
    }

    let workdir: string

    try {
      workdir = cwd()
    } catch {
      return { code: null, stdout: '', stderr: '' }
    }

    return new Promise(resolve => {
      const child = execFileFn(
        binary,
        [...args],
        {
          cwd: workdir,
          encoding: 'utf8',
          timeout: RUN_TIMEOUT_MS,
          maxBuffer: OUTPUT_CAP,
          windowsHide: true,
          env: agentcardEnv(base)
        },
        (error, stdout, stderr) => {
          // A non-zero exit carries its number; a timeout kill or a spawn failure never ran to an answer.
          const code = !error ? 0 : typeof error.code === 'number' && !error.killed ? error.code : null

          resolve({ code, stdout: String(stdout), stderr: String(stderr) })
        }
      )

      child.stdin?.end()
    })
  }
}

export const runAgentcard: AgentcardRun = createAgentcardRun()

export interface AgentcardStatus {
  state: AgentcardAccountState | null
  checkedAt: number
}

let cached: AgentcardStatus | null = null
let inFlight: Promise<AgentcardStatus> | null = null

/**
 * One probe at a time, its answer kept five minutes: opening the Bank again does not re-run the CLI. A probe
 * that found no CLI is not kept (K45/K66): installing it shows up on the next open, not five minutes later.
 */
export function agentcardStatus(
  run: AgentcardRun = runAgentcard,
  now: () => number = () => Date.now()
): Promise<AgentcardStatus> {
  if (cached && now() - cached.checkedAt < CACHE_MS) {
    return Promise.resolve(cached)
  }

  inFlight ??= (async () => {
    let missing = false

    const observed: AgentcardRun = async args => {
      const answer = await run(args)

      missing ||= answer.missing === true

      return answer
    }

    const state = await probeAgentcardAccount(observed).catch(() => null)
    const status: AgentcardStatus = { state, checkedAt: now() }

    cached = missing ? null : status

    return status
  })().finally(() => {
    inFlight = null
  })

  return inFlight
}

/** Tests only: forget the kept answer. */
export function resetAgentcardStatus(): void {
  cached = null
  inFlight = null
}
