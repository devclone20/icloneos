/**
 * V3-J — the agent's pay socket (contract §1.1): its own unix socket, `<userData>/run/pay.sock`, separate from the
 * acp socket, carrying exactly one verb (`verb.ts`: `pay`, `send`, `status`, `stop`). Who is asking is decided HERE,
 * never by the request:
 *
 *   - the socket lives in a 0700 dir and is 0600 (macOS checks socket permissions on connect: only this uid gets in);
 *   - every Hermes spawn gets its own token (`paySpawn(slug)`, like `iclone-acp-ipc`'s per-launch token, but one per
 *     spawn and bound to that spawn's profile slug). The token goes into its own file, `<run>/pay-<spawn id>.token`
 *     (fix Jm2: one file per spawn, named by a fresh 16-hex spawn id, created exclusively 0600 in the 0700 run dir),
 *     whose PATH is in the child's env (`ICLONE_PAY_TOKEN_FILE`): the secret is never in env, argv or a log. It dies
 *     with the child (exit ⇒ revoked, file removed) and with the server; files a crash left behind are swept at start;
 *   - who may read those files: this uid only (0700 dir, 0600 file). Every confined profile denies the whole of
 *     userData and, by name, `run/pay-*.token` (V3-F `secretPaths`, floor 4, which also refuses the read to the
 *     agent's file and shell tools). A shell the agent runs OUTSIDE confinement is the same uid and could read another
 *     spawn's file: that is the V3-G boundary (confinement is what separates agents on one uid), not this module's;
 *   - the slug the verb sees is the one the token was minted for. A request cannot name an agent, so a caller holding
 *     one agent's token can spend at most that agent's per-agent-day cap (J11);
 *   - a token is bound to the FOLDER its profile runs in (fix m-r4-1): main mints only for a profile the latest seed
 *     pass verified (`bindProfile`), records that folder's identity (`dev:ino`) and hands it to the child as
 *     `ICLONE_PAY_HOME`. Every request names the folder its caller runs in (the `x402-pay` client sends its
 *     HERMES_HOME's identity); a token used from another profile's folder (an env Hermes copied into a process of
 *     another profile) or whose folder is no longer the verified one is refused (77) and audited. Hermes drops an
 *     inherited pay env itself too (`hermes_cli/iclone_pay_env.py`); this check does not depend on it;
 *   - tokens are looked up by their SHA-256, so the comparison never runs over the secret itself.
 *
 * Every refusal the socket makes before the verb (malformed, unknown token, busy) is audited through V3-F
 * (`recordPayment`, src `payment`); the verb audits its own. A per-token in-flight bound keeps one caller from queueing
 * the owner's door sheet without end.
 *
 * Wire: one JSON line `{"v":1,"token":"<64 hex>","home":"<dev:ino>","argv":[…]}` → frames `{"t":"o"|"e","d":…}` …
 * `{"t":"x","c":<code>}`.
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import type { PaymentAuditSink } from './client'
import { paymentsVerb, type PaymentsVerbDeps } from './verb'

const SOCKET_NAME = 'pay.sock'
const REQUEST_MAX_BYTES = 16 * 1024
const REQUEST_WAIT_MS = 10_000
const ARGV_MAX = 8
const INFLIGHT_PER_TOKEN = 4
const CONNECTIONS_MAX = 64
// macOS sun_path is 104 bytes including the terminator.
const SUN_PATH_MAX = 103
const TOKEN_RE = /^[0-9a-f]{64}$/
// `st_dev:st_ino` of a folder, as Node and Python both print them (decimal).
const HOME_RE = /^[0-9]{1,24}:[0-9]{1,24}$/
const TOKEN_FILE_RE = /^pay-[0-9a-f]{16}\.token$/

/** The one file of one spawn's token: `pay-<spawn id>.token` in the run dir (`secretPaths` names `run/pay-*.token`). */
export const payTokenFile = (dir: string, spawnId: string): string => path.join(dir, `pay-${spawnId}.token`)

/** Token files a previous run left behind (a crash never revoked them): dead secrets, removed at start. */
function sweepTokenFiles(dir: string): number {
  let swept = 0

  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name)

    if (TOKEN_FILE_RE.test(name) && lstatSync(file).isFile()) {
      rmSync(file, { force: true })
      swept += 1
    }
  }

  return swept
}

type Frame = { t: 'o' | 'e'; d: string } | { t: 'x'; c: number }

interface PaySocketDeps {
  /** `<userData>/run`: created 0700 if missing; refused if it is a symlink or another user's. */
  dir: string
  /** The verb's dependencies, read per request (null client while payments are starting or disabled). */
  verb: () => PaymentsVerbDeps
  audit: PaymentAuditSink | null
  log: (line: string) => void
  /** After every request the verb answered (the pane re-reads its state). */
  onSettled?: () => void
  /** The folder a spawn of this profile slug runs in (`dev:ino`, as the latest seed pass verified it), or why that
   *  profile may not pay (fix m-r2-2 / m-r4-1 / m-r4-2: anything the seed could not verify). Asked at every mint and
   *  every request. */
  bindProfile: (slug: string) => ProfileBinding
}

/** A profile's verified folder, or why it cannot pay. */
export type ProfileBinding = { home: string } | { refused: string }

interface SpawnToken {
  /** This spawn's id: its token file is `pay-<spawnId>.token`. */
  spawnId: string
  /** The env the child needs: the socket, the token FILE (never the token) and the folder it was minted for. */
  env: Record<string, string>
  /** Revoke when the child exits. */
  attach: (child: { once(event: 'exit', listener: () => void): unknown }) => void
  revoke: () => void
}

export interface PaySocketServer {
  socketPath: string
  /** One token for one Hermes spawn of `slug`. */
  mint: (slug: string) => SpawnToken
  /** Live tokens (for the gates: a dead spawn leaves none). */
  liveTokens: () => number
  close: () => void
}

interface Entry {
  slug: string
  /** The folder this token was minted for (`dev:ino`). */
  home: string
  file: string
  inflight: number
}

const digest = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

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

/** Pure: one request line → `{token, home, argv}`, or null for anything malformed. The request never carries an agent;
 *  `home` is the identity of the folder the caller runs in (absent: an older client, refused as unbound). */
export function parsePayRequest(line: string): { token: string; home: null | string; argv: string[] } | null {
  try {
    const value: unknown = JSON.parse(line)

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }

    const { v, token, home, argv } = value as Record<string, unknown>

    if (v !== 1 || typeof token !== 'string' || !TOKEN_RE.test(token)) {
      return null
    }

    if (home !== undefined && (typeof home !== 'string' || !HOME_RE.test(home))) {
      return null
    }

    if (!Array.isArray(argv) || argv.length === 0 || argv.length > ARGV_MAX) {
      return null
    }

    if (!argv.every(arg => typeof arg === 'string')) {
      return null
    }

    return { token, home: typeof home === 'string' ? home : null, argv: argv as string[] }
  } catch {
    return null
  }
}

export async function startPaySocketServer(deps: PaySocketDeps): Promise<PaySocketServer> {
  const socketPath = path.join(deps.dir, SOCKET_NAME)

  if (Buffer.byteLength(socketPath) > SUN_PATH_MAX) {
    throw new Error(`socket path is longer than ${SUN_PATH_MAX} bytes: ${socketPath}`)
  }

  ownedPrivateDir(deps.dir)
  clearStaleSocket(socketPath)

  const swept = sweepTokenFiles(deps.dir)

  if (swept > 0) {
    deps.log(`[iclone-x402] removed ${swept} pay token file(s) a previous run left behind`)
  }

  const tokens = new Map<string, Entry>()

  const audit = (reason: string, agent: string): void => {
    try {
      deps.audit?.record({ kind: 'refuse', reason, agent })
    } catch {
      // the sink's own failure is not the request's
    }
  }

  const revoke = (key: string): void => {
    const entry = tokens.get(key)

    if (entry) {
      tokens.delete(key)
      rmSync(entry.file, { force: true })
    }
  }

  const serve = (socket: net.Socket) => {
    let buffered = ''
    let started = false

    const send = (frame: Frame) => {
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify(frame)}\n`)
      }
    }

    const fail = (message: string, code: number) => {
      send({ t: 'e', d: `pay: ${message}\n` })
      send({ t: 'x', c: code })
      socket.end()
    }

    const waitTimer = setTimeout(() => {
      started = true
      fail('no request', 64)
    }, REQUEST_WAIT_MS)

    socket.setEncoding('utf8')
    socket.on('error', () => undefined)
    socket.on('close', () => clearTimeout(waitTimer))
    socket.on('data', (chunk: string) => {
      if (started) {
        return
      }

      buffered += chunk

      if (buffered.length > REQUEST_MAX_BYTES) {
        started = true
        clearTimeout(waitTimer)
        audit('socket too_large', '')
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
      const request = parsePayRequest(line)

      if (!request) {
        audit('socket malformed', '')

        return fail('malformed request', 64)
      }

      const key = digest(request.token)
      const entry = tokens.get(key)

      if (!entry) {
        audit('socket token', '')

        return fail('this token is not a live agent session', 3)
      }

      const binding = deps.bindProfile(entry.slug)

      if ('refused' in binding) {
        audit('socket unprotected_profile', entry.slug)

        return fail(binding.refused, 77)
      }

      // The folder verified now is still the one this token was minted for (a profile deleted and created again, or
      // swapped, is another profile).
      if (binding.home !== entry.home) {
        audit('socket profile_moved', entry.slug)

        return fail(`profile ${entry.slug} is not the folder this session was started in: it cannot pay`, 77)
      }

      // The caller runs in that folder: a token inherited by a process of another profile is refused (fix m-r4-1).
      if (request.home !== entry.home) {
        audit('socket profile_mismatch', entry.slug)

        return fail(`this token was minted for profile ${entry.slug}, not for the profile this agent runs in`, 77)
      }

      if (entry.inflight >= INFLIGHT_PER_TOKEN) {
        audit('socket busy', entry.slug)

        return fail(`${INFLIGHT_PER_TOKEN} requests already in flight for this agent`, 75)
      }

      entry.inflight += 1
      deps.log(`[iclone-x402] ${entry.slug} ${request.argv[0]}`)

      try {
        const result = await paymentsVerb(deps.verb(), entry.slug, request.argv)

        if (result.stdout) {
          send({ t: 'o', d: result.stdout })
        }

        if (result.stderr) {
          send({ t: 'e', d: result.stderr })
        }

        send({ t: 'x', c: result.code })
      } catch {
        // paymentsVerb never rejects; this is the transport's own backstop.
        audit('socket internal', entry.slug)
        send({ t: 'x', c: 1 })
      } finally {
        entry.inflight -= 1
        socket.end()

        try {
          deps.onSettled?.()
        } catch {
          // a listener's failure is not the request's
        }
      }
    }
  }

  const server = net.createServer(serve)

  server.maxConnections = CONNECTIONS_MAX

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })

  chmodSync(socketPath, 0o600)
  deps.log(`[iclone-x402] listening ${socketPath}`)

  const mint = (slug: string): SpawnToken => {
    const binding = deps.bindProfile(slug)

    // A spawn of a profile the seed could not verify gets no token at all (paySpawn then hands it no pay env).
    if ('refused' in binding) {
      audit('spawn unprotected_profile', slug)
      deps.log(`[iclone-x402] no pay token for profile ${slug}: ${binding.refused}`)

      throw new Error(binding.refused)
    }

    const token = randomBytes(32).toString('hex')
    const key = digest(token)
    const spawnId = randomBytes(8).toString('hex')
    const file = payTokenFile(deps.dir, spawnId)

    // The dir is re-checked (still ours, still 0700) and the file created exclusively: a name planted there, a link
    // or a file, makes this spawn go without a token rather than write the secret through it.
    ownedPrivateDir(deps.dir)
    writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' })
    chmodSync(file, 0o600)
    tokens.set(key, { slug, home: binding.home, file, inflight: 0 })

    return {
      spawnId,
      env: { ICLONE_PAY_SOCKET: socketPath, ICLONE_PAY_TOKEN_FILE: file, ICLONE_PAY_HOME: binding.home },
      attach: child => {
        child.once('exit', () => revoke(key))
      },
      revoke: () => revoke(key)
    }
  }

  return {
    socketPath,
    mint,
    liveTokens: () => tokens.size,
    close() {
      server.close()

      for (const key of [...tokens.keys()]) {
        revoke(key)
      }

      rmSync(socketPath, { force: true })
    }
  }
}

let active: PaySocketServer | null = null

/** main: the running socket, or null to retire it. */
export function setActivePaySocket(server: PaySocketServer | null): void {
  active = server
}

let spawnSeed: (() => void) | null = null

/** main: what runs right before every Hermes spawn (the shipped-disabled skills seeded into each config), or null. */
export function setSpawnSeed(seed: (() => void) | null): void {
  spawnSeed = seed
}

/**
 * What one Hermes spawn of `slug` needs to reach the pay socket. Before payments are up (or when they failed to start)
 * the child gets no pay env at all: the `x402-pay` skill then says payments are not available, nothing more. Either
 * way the spawn seed runs first, so the child never reads a config without the payment skills shipped disabled.
 * `slug` is the profile the child RUNS AS (`spawnProfile`, fix m-r3-2); null when that cannot be known: no token.
 */
export function paySpawn(slug: null | string): Pick<SpawnToken, 'attach' | 'env'> {
  try {
    spawnSeed?.()
  } catch {
    // the seed never throws; this is the spawn's own backstop
  }

  if (!active || slug === null) {
    return { env: {}, attach: () => undefined }
  }

  try {
    const minted = active.mint(slug)

    return { env: minted.env, attach: minted.attach }
  } catch {
    return { env: {}, attach: () => undefined }
  }
}
