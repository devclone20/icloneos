/**
 * The pane bus in main: the broker singleton, its Unix-socket transport (no
 * TCP listener — the socket sits in a 0700 directory and is itself 0600), the
 * hooks the PTY host calls when a pane's shell starts and ends, and the IPC the
 * renderer reads pane state and signals through.
 *
 * Identity is minted here at spawn and handed to the shell through its
 * environment (ICLONE_PANE_ID / _NAME / _TOKEN / _SOCK) — only to a local,
 * non-tmux shell (pane-env.ts says why). The token never appears in argv, in a
 * log line or in a reply.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { app, type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'

import { createPaneProbe, type ProbeInput } from '../iclone-pane-remote/probe'
import { forgetRemoteSession, readRemoteRegistry, rememberRemoteSession } from '../iclone-pane-remote/registry'
import {
  isTmuxSessionName,
  localTmuxAttachArgs,
  parseTmuxList,
  remoteTmuxCommand,
  tmuxEndArgs,
  tmuxListArgs,
  tmuxSessionFor
} from '../iclone-pane-remote/tmux-cmd'

import { type BusLogEntry, createPaneBroker, type PaneBroker, type PaneSummary, type SignalSource } from './broker'
import { isPaneName } from './envelope'
import { type PreparedPane, TMUX_REMOTE_OFF } from './pane-env'
import { checkEnv, readSpawnSpec } from './spec'

const TRANSPORT_CAP_BYTES = 64 * 1024
/** Requests one pane may hold open at once (long-polls included); the 9th is refused. */
const OPEN_PER_PANE = 8
/** Authenticated requests open across every pane. */
const OPEN_TOTAL = 64
/** Sockets main accepts on the bus at all, authenticated or not: the fd ceiling. */
const CONNECTIONS_MAX = 128
/** Headers and body must arrive within this; a socket that has not shown a pane token by then is closed. */
const REQUEST_TIMEOUT_MS = 10_000
/**
 * Sockets connected but not yet authenticated. Beyond this a new one is closed at
 * once, so half-open sockets can never take the slots an authenticated pane needs
 * (OPEN_TOTAL + this stays under CONNECTIONS_MAX).
 */
const PENDING_MAX = 32
/** How often Node checks headersTimeout/requestTimeout; its default (30 s) tripled the stated bound. */
const TIMEOUT_CHECK_MS = 1_000

/**
 * tmux over ssh runs a command on whatever host the connection points at; it
 * stays off until it is proven on a lab host (G4 remote). No host name is
 * exempt: `~/.ssh/config` applies, so `localhost`, `127.0.0.1` or `::1` can be
 * an alias, a forwarded port or a ProxyJump to a remote machine.
 */
const REMOTE_TMUX_ENABLED = false

const LOG_ROTATE_BYTES = 8 * 1024 * 1024
const PANE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const CHANGE_CHANNEL = 'iclone:pane-bus:change'
const RENDERER_SIGNALS: readonly SignalSource[] = ['bell', 'osc9', 'osc777']

const isRendererSignal = (value: unknown): value is SignalSource => RENDERER_SIGNALS.some(source => source === value)

/** What the renderer may ask for when it starts a pane's shell. */
interface PaneStartRequest {
  id: string
  name: string
  group?: string
  role?: string
  spawnId?: string
  env: Record<string, string>
  cmd?: string
  /** New tmux session (slug), or re-attach to a named one. */
  tmux?: { attach?: string; slug?: string }
}

/**
 * Where the pane's process runs: this Mac, or an ssh connection's host.
 * `remote` comes from the connection kind and is the only thing the guards read:
 * `scope` is a free-form key (a Hermes profile may be named `local`).
 */
interface PaneTarget {
  remote: boolean
  scope: string
  host: null | string
}

export interface TerminalPaneHooks {
  /** Throws when the pane must not start at all (remote tmux while it is off). */
  prepare: (raw: unknown, target: PaneTarget) => null | PreparedPane
  started: (paneId: string, pid: number) => void
  exited: (paneId: string, exit: { code: null | number; signal: null | number | string }) => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const optionalString = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value) ? value : undefined

/** The renderer is trusted but its payload is still checked: names, env, sizes. */
function parseStartRequest(raw: unknown): null | PaneStartRequest {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !PANE_ID_RE.test(raw.id)) {
    return null
  }

  const fallbackName = `p-${
    raw.id
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 8) || 'pane'
  }`

  const name = typeof raw.name === 'string' && isPaneName(raw.name) ? raw.name : fallbackName
  const group = typeof raw.group === 'string' && isPaneName(raw.group) ? raw.group : undefined
  const errors: string[] = []
  const env = raw.env === undefined ? {} : (checkEnv(raw.env, 'env', errors) ?? {})
  const cmd = typeof raw.cmd === 'string' && raw.cmd.length <= 4096 && !raw.cmd.includes('\0') ? raw.cmd : undefined
  const tmuxRaw = isRecord(raw.tmux) ? raw.tmux : null

  const attach =
    tmuxRaw && typeof tmuxRaw.attach === 'string' && isTmuxSessionName(tmuxRaw.attach) ? tmuxRaw.attach : undefined

  const slug = tmuxRaw ? (optionalString(tmuxRaw.slug, 32) ?? 'it') : undefined

  return {
    id: raw.id,
    name,
    group,
    role: optionalString(raw.role, 64),
    spawnId: optionalString(raw.spawnId, 64),
    env: errors.length ? {} : env,
    cmd,
    ...(tmuxRaw ? { tmux: attach ? { attach } : { slug } } : {})
  }
}

function stateDir(): string {
  return path.join(os.homedir(), '.iclone-os')
}

function openLog(file: string): (entry: BusLogEntry) => void {
  try {
    if (fs.statSync(file).size > LOG_ROTATE_BYTES) {
      fs.renameSync(file, `${file}.1`)
    }
  } catch {
    // No log yet.
  }

  const stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 })

  stream.on('error', error => console.warn('[iclone] pane bus log failed:', error))

  return entry => {
    stream.write(`${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`)
  }
}

let logSink: (entry: BusLogEntry) => void = () => {}

let notifyChange: (pane: PaneSummary) => void = () => {}
let socketPath: null | string = null
let registryFile: null | string = null

const broker: PaneBroker = createPaneBroker({
  log: entry => logSink(entry),
  onChange: pane => notifyChange(pane)
})

function reply(res: http.ServerResponse, status: number, text: string): void {
  if (!res.headersSent && !res.writableEnded) {
    res
      .writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) })
      .end(text)
  }
}

/** The transport: POST /bus, `Authorization: Pane <token>`, body `{"argv":[…]}`. */
export function createBusServer(bus: PaneBroker, log: (entry: BusLogEntry) => void = () => {}): http.Server {
  const openByPane = new Map<string, number>()
  let openTotal = 0
  // Our own timer per unauthenticated socket: Node's request timeouts are only checked periodically.
  const pending = new Map<net.Socket, NodeJS.Timeout>()

  const settle = (socket: net.Socket) => {
    clearTimeout(pending.get(socket))
    pending.delete(socket)
  }

  const options = {
    connectionsCheckingInterval: TIMEOUT_CHECK_MS,
    headersTimeout: REQUEST_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS
  }

  const server = http.createServer(options, (req, res) => {
    if (req.method !== 'POST' || req.url !== '/bus') {
      reply(res, 404, '')

      return
    }

    const header = String(req.headers.authorization ?? '')
    const paneId = header.startsWith('Pane ') ? bus.authenticate(header.slice(5).trim()) : null

    if (!paneId) {
      log({ verb: 'refused-token', scheme: header.split(' ')[0] || 'none' })
      reply(res, 401, 'it bus: this token is not a pane on the bus')

      return
    }

    settle(req.socket)

    const open = openByPane.get(paneId) ?? 0

    if (open >= OPEN_PER_PANE || openTotal >= OPEN_TOTAL) {
      log({ verb: 'refused-busy', paneId, open, openTotal })
      reply(
        res,
        429,
        open >= OPEN_PER_PANE
          ? `it bus: this pane already has ${OPEN_PER_PANE} open requests; finish one first`
          : 'it bus: too many open requests on the bus; try again'
      )

      return
    }

    openByPane.set(paneId, open + 1)
    openTotal += 1

    // The client leaving ends its wait in the broker too: no orphan long-poll outlives its socket.
    const left = new AbortController()

    res.once('close', () => {
      const now = (openByPane.get(paneId) ?? 1) - 1

      if (now > 0) {
        openByPane.set(paneId, now)
      } else {
        openByPane.delete(paneId)
      }

      openTotal -= 1
      left.abort()
    })

    const chunks: Buffer[] = []
    let size = 0

    req.on('data', (chunk: Buffer) => {
      size += chunk.length

      if (size > TRANSPORT_CAP_BYTES) {
        reply(res, 400, 'it bus: request too large')
        req.destroy()

        return
      }

      chunks.push(chunk)
    })
    req.on('end', () => {
      let argv: string[]

      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))

        argv = isRecord(parsed) && Array.isArray(parsed.argv) ? parsed.argv.map(String).slice(0, 64) : []
      } catch {
        reply(res, 400, 'it bus: bad request')

        return
      }

      void Promise.resolve(bus.run(paneId, argv, left.signal)).then(answer => reply(res, answer.status, answer.text))
    })
  })

  server.on('connection', (socket: net.Socket) => {
    if (pending.size >= PENDING_MAX) {
      socket.destroy()

      return
    }

    pending.set(
      socket,
      setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS)
    )
    socket.once('close', () => settle(socket))
  })

  server.maxConnections = CONNECTIONS_MAX
  // The ANSWER may take up to 600 s (an ask long-polls): requestTimeout bounds
  // only the request, socket inactivity is not timed.
  server.timeout = 0

  return server
}

/** The socket's directory must be a real directory of ours: never a planted symlink or someone else's. */
function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  const stat = fs.lstatSync(dir)

  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`pane bus: ${dir} is not a private directory of this user`)
  }

  fs.chmodSync(dir, 0o700)
}

/** Listen on a Unix socket in a private directory; resolves once the socket is 0600. */
export async function listenOnSocket(server: http.Server, file: string): Promise<void> {
  privateDir(path.dirname(file))
  fs.rmSync(file, { force: true })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(file, () => {
      fs.chmodSync(file, 0o600)
      server.off('error', reject)
      resolve()
    })
  })
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Sockets left by app runs that crashed: `bus-<pid>.sock` whose pid is gone. */
export function sweepStaleSockets(dir: string): number {
  let swept = 0

  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const pid = Number(/^bus-(\d+)\.sock$/.exec(entry)?.[1] ?? NaN)

    if (Number.isInteger(pid) && pid !== process.pid && !pidAlive(pid)) {
      fs.rmSync(path.join(dir, entry), { force: true })
      swept += 1
    }
  }

  return swept
}

interface PaneHooksDeps {
  bus: PaneBroker
  socketPath: () => null | string
  registryFile: () => null | string
  log: (entry: BusLogEntry) => void
  remoteTmuxEnabled?: boolean
}

export function createPaneHooks({
  bus,
  socketPath,
  registryFile,
  log,
  remoteTmuxEnabled = REMOTE_TMUX_ENABLED
}: PaneHooksDeps): TerminalPaneHooks {
  function tmuxPlan(request: PaneStartRequest, target: PaneTarget): PreparedPane['tmux'] {
    if (!request.tmux) {
      return null
    }

    const session = request.tmux.attach ?? tmuxSessionFor(request.tmux.slug ?? 'it', request.id)
    const registry = registryFile()

    if (registry && !request.tmux.attach) {
      rememberRemoteSession(registry, request.id, { scope: target.scope, session, createdAt: Date.now() })
    }

    return {
      session,
      localArgs: localTmuxAttachArgs(session),
      remoteCommand: target.remote ? remoteTmuxCommand(session) : null
    }
  }

  return {
    prepare(raw, target) {
      const request = parseStartRequest(raw)

      if (!request) {
        return null
      }

      // Before anything exists: no bus record, no registry line, no ssh argv.
      if (request.tmux && target.remote && !remoteTmuxEnabled) {
        log({ verb: 'tmux-remote-refused', scope: target.scope })

        throw new Error(`${TMUX_REMOTE_OFF}: tmux over ssh is off until it is proven on a lab host`)
      }

      const sock = socketPath()
      const onBus = !target.remote && !request.tmux && sock !== null

      const registration = {
        paneId: request.id,
        name: request.name,
        group: request.group,
        role: request.role,
        spawnId: request.spawnId
      }

      let identity: PreparedPane['identity'] = null

      try {
        if (onBus) {
          identity = {
            ICLONE_PANE_ID: request.id,
            ICLONE_PANE_NAME: request.name,
            ICLONE_PANE_TOKEN: bus.register(registration),
            ICLONE_PANE_SOCK: sock,
            ...(request.group ? { ICLONE_PANE_GROUP: request.group } : {}),
            ...(request.role ? { ICLONE_PANE_ROLE: request.role } : {})
          }
        } else {
          bus.registerOffBus(registration)
        }
      } catch (error) {
        log({ verb: 'register-refused', reason: error instanceof Error ? error.message : 'unknown' })
      }

      return {
        paneId: request.id,
        env: request.env,
        identity,
        initialInput: request.cmd ? `${request.cmd}\r` : null,
        tmux: tmuxPlan(request, target)
      }
    },
    started: (paneId, pid) => bus.attachPid(paneId, pid),
    exited: (paneId, exit) => bus.exited(paneId, exit)
  }
}

export const paneBusTerminalHooks: TerminalPaneHooks = createPaneHooks({
  bus: broker,
  socketPath: () => socketPath,
  registryFile: () => registryFile,
  log: entry => logSink(entry)
})

function runTmux(tmux: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    execFile(tmux, args, { timeout: 3_000 }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: String(error ? stderr || error.message : stdout) })
    )
  })
}

interface InitPaneBusOptions {
  getMainWindow: () => BrowserWindow | null
  isTrustedSender: (event: IpcMainInvokeEvent, channel: string) => boolean
  findOnPath: (command: string) => null | string
}

export function initPaneBus({ getMainWindow, isTrustedSender, findOnPath }: InitPaneBusOptions): void {
  logSink = openLog(path.join(app.getPath('userData'), 'pane-bus.jsonl'))
  registryFile = path.join(app.getPath('userData'), 'pane-remote.json')

  notifyChange = pane => {
    const win = getMainWindow()

    if (win && !win.isDestroyed()) {
      win.webContents.send(CHANGE_CHANNEL, pane)
    }
  }

  const dir = path.join(stateDir(), 'bus')
  const file = path.join(dir, `bus-${process.pid}.sock`)
  const server = createBusServer(broker, entry => logSink(entry))

  server.on('error', error => console.warn('[iclone] pane bus failed:', error))
  // Every failure here (a planted symlink, a file where the dir should be) leaves
  // the app running with no bus: panes open plain, `it bus` says so.
  listenOnSocket(server, file)
    .then(() => {
      socketPath = file
      logSink({ verb: 'listen', swept: sweepStaleSockets(dir) })
    })
    .catch(error => console.warn('[iclone] pane bus could not listen:', error))

  const guard = <R>(channel: string, fallback: R, handler: (...args: unknown[]) => R | Promise<R>) =>
    ipcMain.handle(channel, (event, ...args: unknown[]) =>
      isTrustedSender(event, channel) ? handler(...args) : fallback
    )

  const probe = createPaneProbe()

  guard('iclone:pane-bus:snapshot', [], () => broker.snapshot())
  guard('iclone:pane-bus:stats', null, () => broker.stats())
  guard('iclone:pane-bus:signal', false, (paneId, text, source) =>
    typeof paneId === 'string' && isRendererSignal(source)
      ? broker.setSignal(paneId, String(text ?? ''), source)
      : false
  )
  guard('iclone:pane-bus:clear', false, paneId => {
    if (typeof paneId === 'string') {
      broker.clearAttention(paneId)
    }

    return true
  })
  guard('iclone:pane-bus:plan', { ok: false, errors: ['bad request'] }, file =>
    readSpawnSpec(typeof file === 'string' ? file : '')
  )
  guard('iclone:pane-bus:probe', [], raw => {
    const pids = new Map(broker.snapshot().map(pane => [pane.paneId, pane.pid]))

    const inputs: ProbeInput[] = (Array.isArray(raw) ? raw : [])
      .slice(0, 32)
      .filter(isRecord)
      .filter(item => typeof item.paneId === 'string' && pids.has(item.paneId))
      .map(item => ({
        paneId: String(item.paneId),
        pid: pids.get(String(item.paneId)) ?? null,
        cwd: typeof item.cwd === 'string' && path.isAbsolute(item.cwd) ? item.cwd : null
      }))

    return probe(inputs)
  })
  guard('iclone:pane-bus:tmux-list', { ok: false, sessions: [], panes: {} }, async () => {
    const tmux = findOnPath('tmux')

    if (!tmux) {
      return { ok: false, sessions: [], panes: {} }
    }

    const listed = await runTmux(tmux, tmuxListArgs())

    return {
      ok: true,
      sessions: listed.ok ? parseTmuxList(listed.out) : [],
      panes: registryFile ? readRemoteRegistry(registryFile) : {}
    }
  })
  guard('iclone:pane-bus:tmux-end', false, async session => {
    const tmux = findOnPath('tmux')

    if (!tmux || typeof session !== 'string' || !isTmuxSessionName(session)) {
      return false
    }

    const ended = await runTmux(tmux, tmuxEndArgs(session))

    if (registryFile) {
      forgetRemoteSession(registryFile, session)
    }

    logSink({ verb: 'tmux-end', session, ok: ended.ok })

    return ended.ok
  })

  app.on('will-quit', () => {
    server.close()
    fs.rmSync(file, { force: true })
  })
}
