/**
 * iclone os — the agent's door to the bundled ACP CLI: an app-owned unix
 * socket instead of an interpreter on disk (P7 decision 8b/8c).
 *
 * The iNFT's Hermes agent used to `exec` this Electron binary as Node with
 * ELECTRON_RUN_AS_NODE — which made the signed app a general-purpose
 * interpreter that could read the ACP keychain items with no prompt. Now the
 * agent's `acp` wrapper is a thin client of `<userData>/run/acp.sock` and THIS
 * module decides what runs:
 *
 *   - who: the socket lives in a 0700 dir and is 0600 (macOS checks socket
 *     file permissions on connect, so only this uid gets in); every request
 *     carries the per-launch token from `acp.token` (0600), so a client that
 *     outlived an app launch is refused;
 *   - where: the iNFT is resolved here, against the app's own registry — a
 *     client never names a config dir;
 *   - what: AGENT_COMMANDS is an allowlist of (command, subcommand) pairs;
 *     `card issue` (live card numbers) is refused in every position;
 *   - what comes back: card answers leave only as JSON stripped of card
 *     secrets, and every line is scrubbed of bearer tokens, JWTs and private
 *     keys before it is written to the socket.
 *
 * Honest limit: a same-uid process can connect and run the allowlisted
 * commands — exactly the agent's capability — never read raw secrets.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { redactSecrets } from '../src/iclone-shared/redact'

import { redactCardOutput } from './iclone-acp-output'
import { consentAllows } from './iclone-consent'
import { consentDoorCommand } from './iclone-consent-door'
import { doctorDoorCommand } from './iclone-doctor'
import { economyRefusal } from './iclone-ownership-gate'
import { activePermissions } from './iclone-permissions/ipc'
import { permVerb } from './iclone-permissions/socket-verb'
import { writeFileAtomicSync } from './lib/atomic-write'

const REQUEST_MAX_BYTES = 256 * 1024
const REQUEST_WAIT_MS = 10_000
const ARGV_MAX = 64
const ARG_MAX_CHARS = 16_384
// macOS sun_path is 104 bytes including the terminator.
const SUN_PATH_MAX = 103

/** Every command the agent may run, by root. `null` = the root takes no
 *  subcommand; a list = one of these must follow the root. Mirrors the
 *  pinned CLI's command tree (scripts/acp-cli-version.mjs). */
export const AGENT_COMMANDS: Readonly<Record<string, readonly string[] | null>> = {
  agent: [
    'create',
    'list',
    'use',
    'add-signer',
    'signer-status',
    'signer-policy',
    'set-signer-policy',
    'generate-signer-key',
    'link',
    'whoami',
    'update',
    'quote-tokens',
    'tokenize',
    'register-erc8004',
    'migrate'
  ],
  browse: null,
  card: ['signup', 'signup-poll', 'whoami', 'profile', 'payment-method', 'limit', 'list', 'get'],
  chain: ['list'],
  client: ['create-job', 'create-custom-job', 'fund', 'complete', 'reject', 'review'],
  compute: ['status', 'top-up'],
  configure: ['start', 'complete'],
  email: [
    'whoami',
    'provision',
    'inbox',
    'compose',
    'search',
    'thread',
    'reply',
    'extract-otp',
    'extract-links',
    'attachment'
  ],
  events: ['listen', 'drain'],
  job: ['list', 'history', 'watch'],
  message: ['send'],
  offering: ['list', 'create', 'update', 'delete'],
  policy: ['create', 'list', 'show', 'global', 'edit', 'delete'],
  // Provider side of a job (the CLI's own root — pricing and delivery; R15a found it missing).
  provider: ['set-budget', 'set-budget-with-fund-request', 'submit'],
  resource: ['list', 'create', 'update', 'delete'],
  skill: ['path', 'print', 'check'],
  subscription: ['list', 'create', 'update', 'delete'],
  trade: ['stock-list', 'hl-status', 'withdraw-from-hl', 'hl-cancel', 'hl-orders', 'hl-set-tpsl'],
  wallet: ['address', 'sign-message', 'sign-typed-data', 'send-transaction', 'balance', 'topup']
}

/** Roots that also run with no subcommand (`acp configure`, `acp browse …`, `acp trade --swap …`:
 *  the CLI's trade root takes its operations as flags). */
const BARE_ROOTS = new Set(['browse', 'configure', 'trade'])

/** Commands that move value or create a payable obligation. The agent operates, the owner spends:
 *  these run only when the owner allowed Spend/trade (R10 consent key `spendTrade`) — otherwise the
 *  socket refuses and tells the agent to ask through the consent door. */
const VALUE_MOVING = new Set([
  'trade',
  'client fund',
  'client create-job',
  'client create-custom-job',
  'compute top-up',
  'provider set-budget-with-fund-request',
  'wallet send-transaction',
  'wallet topup'
])

/** Read-only trade subcommands (never gated). */
const TRADE_READS = new Set(['stock-list', 'hl-status', 'hl-orders'])

/** A subcommand whose name says money moves (transfer, fund, pay, hire, top-up), whatever its root. */
const MONEY_SUB = /transfer|fund|pay|hire|top-?up/i

/** An option that moves money on an otherwise ordinary verb — `provider submit --transfer-amount 500` pays out of the
 *  iNFT wallet (V3-I critic r1, finding 2). With or without `=value`. */
const MONEY_FLAG = /^--(transfer|fund|pay|hire|top-?up|value|amount-to-send)([-=]|$)/i

/** Options that take no value: a `--dry-run` right after one of these is a flag, not that option's value. */
const BOOLEAN_FLAGS = new Set(['--json', '--yes', '-y', '--force', '--quiet', '-q', '--verbose', '-v'])

/**
 * `--dry-run` counts only when it cannot be anything else: the LAST token, written exactly so, and not the value of
 * the option before it (`--memo --dry-run` may send `--dry-run` as the memo). Anywhere else, or in doubt, the money
 * check runs (V3-I critic r1, finding 2). `--` is refused before this is reached.
 */
function isDryRun(args: readonly string[]): boolean {
  if (args.at(-1) !== '--dry-run') {
    return false
  }

  const before = args.at(-2) ?? ''

  return !before.startsWith('-') || before.includes('=') || BOOLEAN_FLAGS.has(before)
}

function movesValue(root: string, sub: string | undefined, args: readonly string[]): boolean {
  if (root === 'trade') {
    return !(sub !== undefined && TRADE_READS.has(sub) && !args.some(arg => MONEY_FLAG.test(arg))) && !isDryRun(args)
  }

  const moving =
    VALUE_MOVING.has(`${root} ${sub ?? ''}`) ||
    (sub !== undefined && MONEY_SUB.test(sub)) ||
    args.some(arg => MONEY_FLAG.test(arg))

  return moving && !isDryRun(args)
}

const GLOBAL_ONLY = new Set(['--version', '-V', '--help', '-h', 'help'])
/** Long-lived readers: they stream until the agent stops them. */
const STREAMING = new Set(['events listen', 'job watch'])

type AgentPolicy =
  | { ok: true; argv: string[]; redactCard: boolean; streaming: boolean; valueMoving: boolean }
  | { ok: false; error: string }

function refuse(error: string): AgentPolicy {
  return { ok: false, error }
}

/** Pure: may the agent run this argv, and how is its answer handled. */
export function agentPolicy(argv: unknown): AgentPolicy {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > ARGV_MAX) {
    return refuse('usage: acp [--inft <token|slug>] <command> [subcommand] [options]')
  }

  if (!argv.every(arg => typeof arg === 'string' && arg.length <= ARG_MAX_CHARS && !arg.includes('\0'))) {
    return refuse('every argument must be a string without NUL')
  }

  const args = argv as string[]
  const [root, sub] = args

  // `--` hands everything after it to the CLI unparsed: a money flag or a fake `--dry-run` could hide there.
  if (args.includes('--')) {
    return refuse("'--' is not accepted in an agent command: pass each option as itself")
  }

  if (args.length === 1 && GLOBAL_ONLY.has(root)) {
    return { ok: true, argv: args, redactCard: false, streaming: false, valueMoving: false }
  }

  if (!Object.hasOwn(AGENT_COMMANDS, root)) {
    return refuse(`'${root.slice(0, 40)}' is not a command the agent may run`)
  }

  if (root === 'card' && args.includes('issue')) {
    return refuse(
      "'card issue' prints live card numbers and is refused here (owner rule) — the owner runs it in their own terminal"
    )
  }

  const subs = AGENT_COMMANDS[root]
  const helpOnly = args.length === 2 && (sub === '--help' || sub === '-h')
  const bare = BARE_ROOTS.has(root) && (sub === undefined || sub.startsWith('-'))

  if (subs && !helpOnly && !bare && !subs.includes(sub ?? '')) {
    return refuse(`'${root} ${(sub ?? '').slice(0, 40)}' is not a command the agent may run`)
  }

  if (root === 'card') {
    // Card answers leave only as redacted JSON.
    return {
      ok: true,
      argv: args.includes('--json') ? args : [...args, '--json'],
      redactCard: !helpOnly,
      streaming: false,
      valueMoving: false
    }
  }

  return {
    ok: true,
    argv: args,
    redactCard: false,
    streaming: STREAMING.has(`${root} ${sub ?? ''}`),
    valueMoving: !helpOnly && movesValue(root, sub, args)
  }
}

export { redactSecrets }

/** Line-buffered redaction for a stream: a secret split across two chunks is
 *  still whole when it is scrubbed. */
export function lineRedactor(write: (text: string) => void): { push(chunk: string): void; end(): void } {
  let pending = ''

  return {
    push(chunk) {
      pending += chunk
      const cut = pending.lastIndexOf('\n')

      // The buffer is cut BEFORE write: a throwing writer never re-sends or loses the next line.
      if (cut >= 0) {
        const head = pending.slice(0, cut + 1)

        pending = pending.slice(cut + 1)
        write(redactSecrets(head))
      }

      // A runaway line without a newline is flushed in bounded pieces.
      if (pending.length > 64 * 1024) {
        const head = pending

        pending = ''
        write(redactSecrets(head))
      }
    },
    end() {
      if (pending) {
        const head = pending

        pending = ''
        write(redactSecrets(head))
      }
    }
  }
}

interface AgentRequest {
  token: string
  inft: string | null
  argv: unknown
}

/** Pure: one request line → a request, or null for anything malformed. */
export function parseAgentRequest(line: string): AgentRequest | null {
  try {
    const value: unknown = JSON.parse(line)

    if (!value || typeof value !== 'object') {
      return null
    }

    const { v, token, inft, argv } = value as Record<string, unknown>

    if (v !== 1 || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
      return null
    }

    if (inft !== null && inft !== undefined && (typeof inft !== 'string' || inft.length > 200)) {
      return null
    }

    return { token, inft: typeof inft === 'string' && inft.trim() ? inft.trim() : null, argv }
  } catch {
    return null
  }
}

function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(given)

  return a.length === b.length && timingSafeEqual(a, b)
}

// ── the server ──────────────────────────────────────────────────────────────

export type InftResolution = { ok: true; slug: string } | { ok: false; error: string }

export interface AgentRunSink {
  stdout(text: string): void
  stderr(text: string): void
  signal: AbortSignal
}

interface AcpSocketDeps {
  /** `<userData>/run` */
  dir: string
  resolveInft(key: string | null): InftResolution
  /** K29 (V3-I critic r2 n4): may the agent start a streaming reader (`events listen`, `job watch`) for this iNFT? Main's
   *  WORK supervisor is the only authority over listeners for an iNFT it holds, and none run while signed out. */
  admitStreaming(slug: string): boolean
  /** Runs one allowlisted argv for one iNFT; resolves with the exit code. */
  run(
    slug: string,
    argv: string[],
    streaming: boolean,
    sink: AgentRunSink
  ): Promise<{ code: number | null; error?: string }>
  log(line: string): void
}

interface AcpSocketServer {
  socketPath: string
  close(): void
}

type Frame = { t: 'o' | 'e'; d: string } | { t: 'x'; c: number }

/** A dir only this uid can enter; refuses a symlink or someone else's dir. */
function ownedPrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)

  if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error(`refusing ${dir}: not a directory owned by this user`)
  }

  chmodSync(dir, 0o700)
}

function clearStaleSocket(file: string): void {
  try {
    if (!lstatSync(file).isSocket()) {
      throw new Error(`refusing ${file}: exists and is not a socket`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }

    throw error
  }

  rmSync(file, { force: true })
}

/** Slugs with a streaming reader running — the agent door's and the app's job watcher
 *  (iclone-acp-watch.ts) share it, so a slug never has two listeners. */
export const streamingSlugs = new Set<string>()

export async function startAcpSocketServer(deps: AcpSocketDeps): Promise<AcpSocketServer> {
  const socketPath = path.join(deps.dir, 'acp.sock')
  const tokenPath = path.join(deps.dir, 'acp.token')

  if (Buffer.byteLength(socketPath) > SUN_PATH_MAX) {
    throw new Error(`socket path is longer than ${SUN_PATH_MAX} bytes: ${socketPath}`)
  }

  ownedPrivateDir(deps.dir)
  clearStaleSocket(socketPath)

  const token = randomBytes(32).toString('hex')

  const serve = (socket: net.Socket) => {
    let buffered = ''
    let started = false
    const abort = new AbortController()

    const send = (frame: Frame) => {
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify(frame)}\n`)
      }
    }

    const fail = (message: string, code: number) => {
      send({ t: 'e', d: `acp: ${message}\n` })
      send({ t: 'x', c: code })
      socket.end()
    }

    const waitTimer = setTimeout(() => fail('no request', 64), REQUEST_WAIT_MS)

    socket.setEncoding('utf8')
    socket.on('error', () => abort.abort())
    socket.on('close', () => {
      clearTimeout(waitTimer)
      abort.abort()
    })
    socket.on('data', (chunk: string) => {
      if (started) {
        return
      }

      buffered += chunk

      if (buffered.length > REQUEST_MAX_BYTES) {
        started = true
        clearTimeout(waitTimer)
        fail('request too large', 64)

        return
      }

      const newline = buffered.indexOf('\n')

      if (newline < 0) {
        return
      }

      started = true
      clearTimeout(waitTimer)
      void handle(buffered.slice(0, newline))
    })

    const handle = async (line: string) => {
      const request = parseAgentRequest(line)

      if (!request) {
        return fail('malformed request — reinstall iclone os to refresh ~/.iclone-os/bin/acp', 64)
      }

      if (!tokenMatches(token, request.token)) {
        return fail('stale session — iclone os was restarted; run the command again', 3)
      }

      // App-level verb: the consent door answers it in main and it never reaches the Virtuals CLI.
      if (Array.isArray(request.argv) && request.argv[0] === 'consent') {
        const asker = deps.resolveInft(request.inft)

        if (asker.ok === false) {
          return fail(asker.error, 2)
        }

        deps.log(`[iclone-acp-ipc] consent ${asker.slug} ${String(request.argv[1] ?? '')}`)

        const door = await consentDoorCommand(asker.slug, request.argv.slice(1), abort.signal)

        if (door.stdout) {
          send({ t: 'o', d: door.stdout })
        }

        if (door.stderr) {
          send({ t: 'e', d: door.stderr })
        }

        send({ t: 'x', c: door.code })
        socket.end()

        return
      }

      // App-level verb (V3-F): the iclone-permissions Hermes plugin's signed decisions and asks. The iNFT is
      // context, not a gate: a call with no iNFT on stage is still decided and audited.
      if (Array.isArray(request.argv) && request.argv[0] === 'perm') {
        const asker = deps.resolveInft(request.inft)

        const door = await permVerb(
          activePermissions(),
          asker.ok ? asker.slug : null,
          request.argv.slice(1),
          abort.signal
        )

        if (door.stdout) {
          send({ t: 'o', d: door.stdout })
        }

        if (door.stderr) {
          send({ t: 'e', d: door.stderr })
        }

        send({ t: 'x', c: door.code })
        socket.end()

        return
      }

      // App-level verb: `acp doctor …` runs the local diagnostics in main (allow-listed argv, low-risk fixes only).
      if (Array.isArray(request.argv) && request.argv[0] === 'doctor') {
        const asker = deps.resolveInft(request.inft)

        if (asker.ok === false) {
          return fail(asker.error, 2)
        }

        deps.log(`[iclone-acp-ipc] doctor ${asker.slug} ${String(request.argv[1] ?? '')}`)

        const door = await doctorDoorCommand(asker.slug, request.argv.slice(1))

        if (door.stdout) {
          send({ t: 'o', d: door.stdout })
        }

        if (door.stderr) {
          send({ t: 'e', d: door.stderr })
        }

        send({ t: 'x', c: door.code })
        socket.end()

        return
      }

      const policy = agentPolicy(request.argv)

      if (policy.ok === false) {
        return fail(policy.error, 3)
      }

      const inft = deps.resolveInft(request.inft)

      if (inft.ok === false) {
        return fail(inft.error, 2)
      }

      const refused = economyRefusal(inft.slug, policy.argv)

      if (refused) {
        return fail(refused, 3)
      }

      // The agent operates, the owner spends (economyos law + R10 consent key spendTrade): a value-moving
      // command runs only after the owner allowed Spend/trade; otherwise the agent is told how to ask.
      if (policy.valueMoving && !consentAllows('spendTrade')) {
        return fail(
          `'${policy.argv.slice(0, 2).join(' ')}' moves value and the owner has not allowed Spend/trade — ask first: ` +
            'acp consent request spendTrade --reason "<what the task needs it for>" (or end the command with --dry-run)',
          77
        )
      }

      if (policy.streaming && deps.admitStreaming(inft.slug) !== true) {
        return fail(
          `'${policy.argv.slice(0, 2).join(' ')}' is not started for ${inft.slug}: the WORK tab holds this iNFT's ` +
            'listener (or the owner is signed out), so its events reach you through WORK',
          75
        )
      }

      if (policy.streaming && streamingSlugs.has(inft.slug)) {
        return fail(`a ${policy.argv.slice(0, 2).join(' ')} is already running for ${inft.slug}`, 75)
      }

      deps.log(`[iclone-acp-ipc] run ${inft.slug} ${policy.argv.slice(0, 2).join(' ')}`)

      const out = lineRedactor(d => send({ t: 'o', d }))
      const err = lineRedactor(d => send({ t: 'e', d }))
      let cardJson = ''

      if (policy.streaming) {
        streamingSlugs.add(inft.slug)
      }

      try {
        const result = await deps.run(inft.slug, policy.argv, policy.streaming, {
          stdout: text => (policy.redactCard ? (cardJson += text) : out.push(text)),
          stderr: text => err.push(text),
          signal: abort.signal
        })

        let code = result.code ?? 1

        if (policy.redactCard) {
          const redacted = redactCardOutput(cardJson)

          out.push(`${redactSecrets(redacted.stdout)}\n`)

          if (redacted.error && code === 0) {
            err.push(`acp: ${redacted.error}\n`)
            code = 1
          }
        }

        out.end()

        if (result.error) {
          err.push(`acp: ${result.error}\n`)
        }

        err.end()
        send({ t: 'x', c: result.error && code === 0 ? 1 : code })
      } catch (error) {
        err.end()
        send({ t: 'e', d: `acp: ${redactSecrets(error instanceof Error ? error.message : String(error))}\n` })
        send({ t: 'x', c: 1 })
      } finally {
        if (policy.streaming) {
          streamingSlugs.delete(inft.slug)
        }

        socket.end()
      }
    }
  }

  const server = net.createServer(serve)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })

  chmodSync(socketPath, 0o600)

  writeFileAtomicSync(tokenPath, `${token}\n`, { mode: 0o600 })
  deps.log(`[iclone-acp-ipc] listening ${socketPath}`)

  return {
    socketPath,
    close() {
      server.close()
      rmSync(socketPath, { force: true })
      rmSync(tokenPath, { force: true })
    }
  }
}
