/**
 * V3-J wiring harness: the module as MAIN assembles it (`registerPayments`: the pay socket, the six guarded channels,
 * the doors on a fake consent sheet) in a throwaway profile, with the fake OS sealer, the loopback stub facilitator
 * and the iNFT's resource server on 127.0.0.1. Nothing here reaches the owner's wallet, Privy, AgentCard, `~/.hermes`,
 * x402.org or any network beyond loopback.
 */
import fs from 'node:fs'
import type http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import type { DoorPermission, PermissionDoorOutcome } from '../iclone-consent-door'

import type { PaymentAuditEntry } from './client'
import { createFacilitator } from './facilitator'
import { EARN_WALLET, fakeSealer } from './harness.test-helpers'
import { createLedger } from './ledger'
import { DEFAULTS, type PaymentSettings } from './limits'
import { createX402Server, type X402Server } from './server'
import { writeSettings } from './store'
import { type ResourceHost, startResourceHost, startStubFacilitator, type StubFacilitator } from './stub'

import { registerPayments } from './index'

type Handler = (event: unknown, ...args: unknown[]) => unknown

interface DoorCall {
  slug: string
  permission: DoorPermission
  reason: string
}

export interface Wired {
  dir: string
  socketDir: string
  host: ResourceHost
  stub: StubFacilitator
  registered: ReturnType<typeof registerPayments>
  audit: PaymentAuditEntry[]
  /** Main's log lines (its own words, which never reach the window). */
  logs: string[]
  doorCalls: DoorCall[]
  /** What the fake sheet answers (a function may also hang or throw). */
  door: { answer: PermissionDoorOutcome | (() => Promise<PermissionDoorOutcome>) }
  /** The fake click lock: what main's gesture verdict says for the next channel call. */
  gesture: { ok: boolean }
  /** Calls a registered channel as the app's own renderer (trusted) or a stranger. */
  invoke: (channel: string, input?: unknown, trusted?: boolean) => Promise<unknown>
  channels: () => string[]
  url: (route?: string) => string
  /** Mints a spawn token for `slug` (its profile folder made when missing, then a seed pass, as before a spawn) and
   *  returns the token text and the child's env, with the HERMES_HOME that profile runs in. */
  token: (slug: string) => Promise<{ token: string; env: Record<string, string> }>
  issue: (agent: string, budget?: string) => string
  settle: (settings: Partial<PaymentSettings>) => void
  close: () => Promise<void>
}

interface WiredOptions {
  priceMicros?: number
  sealer?: 'fake' | 'none'
  settings?: Partial<PaymentSettings>
  doorTimeoutMs?: number
  /** The ledger's clock (every decision reads it). */
  now?: () => Date
  /** A throwaway HERMES_HOME (the payment skills shipped disabled are seeded into its config.yaml). */
  hermesHome?: string
  /** The active Hermes root whose `cli-config.yaml.example` a missing root config is created from (fix m-r2-1). */
  hermesRoot?: string
  /** Answers some requests in the resource server's place (a v1 402, a redirect) — the earn server and its origin. */
  hijack?: (
    server: X402Server,
    origin: () => string
  ) => (request: http.IncomingMessage, response: http.ServerResponse) => boolean
}

/** The folder each minted token was bound to (`ICLONE_PAY_HOME`): `askSocket` names it, as the x402-pay client does. */
const HOMES = new Map<string, string>()

export async function makeWired(options: WiredOptions = {}): Promise<Wired> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v3jw-'))
  // Main always has a Hermes home: a token is minted only for a profile the seed verified there (fix m-r4-1).
  const hermesHome = options.hermesHome ?? path.join(base, 'hh')
  const dir = path.join(base, 'ud')
  const socketDir = path.join(base, 'run')
  const stub = await startStubFacilitator('ok')
  const facilitator = createFacilitator({ urls: { 'eip155:84532': stub.url }, fetch, timeoutMs: 2_000 })
  const price = options.priceMicros ?? 100_000

  const server = createX402Server({
    network: 'eip155:84532',
    payTo: EARN_WALLET,
    facilitator,
    ledger: createLedger({ file: path.join(base, 'earn', 'ledger.jsonl') }),
    priceOf: url => (new URL(url).pathname.startsWith('/paid') ? price : null),
    serve: async url => ({ body: `paid content of ${new URL(url).pathname}`, mimeType: 'text/plain' })
  })

  const origin = { value: '' }
  const hijack = options.hijack?.(server, () => origin.value)
  const host = await startResourceHost(server, hijack)

  origin.value = host.origin
  const handlers = new Map<string, Handler>()
  const audit: PaymentAuditEntry[] = []
  const doorCalls: DoorCall[] = []
  const logs: string[] = []
  const door: Wired['door'] = { answer: 'once' }
  const gesture = { ok: true }

  const registered = registerPayments({
    ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener as Handler) },
    isTrustedSender: event => (event as { trusted?: boolean } | null)?.trusted === true,
    userDataDir: dir,
    socketDir,
    sealer: options.sealer === 'none' ? null : fakeSealer(),
    door: {
      askPermission: async (slug, permission, _key, reason) => {
        doorCalls.push({ slug, permission, reason })

        return typeof door.answer === 'function' ? door.answer() : door.answer
      }
    },
    mode: () => 'manual',
    audit: entry => audit.push(entry),
    gestureOk: () => gesture.ok,
    broadcast: () => undefined,
    log: line => logs.push(line),
    doorTimeoutMs: options.doorTimeoutMs,
    now: options.now,
    facilitatorUrls: { 'eip155:84532': stub.url },
    hermesHome,
    hermesRoot: options.hermesRoot
  })

  const started = await registered.socket

  const settle = (settings: Partial<PaymentSettings>) => {
    writeSettings(registered.payments.paths, {
      ...DEFAULTS,
      payees: [EARN_WALLET],
      origins: [host.origin],
      ...options.settings,
      ...settings
    })
  }

  settle({})

  return {
    dir,
    socketDir,
    host,
    stub,
    registered,
    audit,
    doorCalls,
    logs,
    door,
    gesture,
    invoke: async (channel, input, trusted = true) => {
      const handler = handlers.get(channel)

      if (!handler) {
        throw new Error(`no handler ${channel}`)
      }

      return handler({ trusted }, input)
    },
    channels: () => [...handlers.keys()],
    url: (route = '/paid/one') => `${host.origin}${route}`,
    token: async slug => {
      if (!started) {
        throw new Error('pay socket did not start')
      }

      const folder = slug === 'default' ? hermesHome : path.join(hermesHome, 'profiles', slug)

      // A profile Hermes would run: its folder, made when nothing is there (a link a test planted is left as it is).
      try {
        fs.lstatSync(folder)
      } catch {
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
      }

      registered.seed()

      const minted = started.mint(slug)
      const token = fs.readFileSync(minted.env.ICLONE_PAY_TOKEN_FILE, 'utf8').trim()

      HOMES.set(token, minted.env.ICLONE_PAY_HOME)

      return { token, env: { ...minted.env, HERMES_HOME: folder } }
    },
    issue: (agent, budget = '100.00') => {
      const result = registered.payments.mandatesStore.issue({
        agent,
        ttlSeconds: 3600,
        constraints: [
          { type: 'payment.budget', amount: budget, currency: 'USDC' },
          { type: 'payment.amount_range', min: '0.000001', max: '50.00', currency: 'USDC' },
          { type: 'payment.allowed_payees', payees: [EARN_WALLET] }
        ]
      })

      if (!result.ok) {
        throw new Error(`issue failed: ${result.reason}`)
      }

      return result.record.jti
    },
    settle,
    close: async () => {
      registered.close()
      await host.close()
      await stub.close()
      fs.rmSync(base, { recursive: true, force: true })
    }
  }
}

interface SocketAnswer {
  code: number | null
  stdout: string
  stderr: string
}

/** One request on the pay socket, as the agent's `x402-pay` client would send it: from the folder the token was minted
 *  for (`home`, default: the one `token()` recorded). */
export function askSocket(
  socketPath: string,
  token: string,
  argv: unknown[],
  home: string | undefined = HOMES.get(token)
): Promise<SocketAnswer> {
  return askSocketRaw(socketPath, `${JSON.stringify({ v: 1, token, home, argv })}\n`)
}

function askSocketRaw(socketPath: string, line: string): Promise<SocketAnswer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    let buffered = ''

    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('data', chunk => (buffered += chunk))
    socket.on('close', () => {
      const answer: SocketAnswer = { code: null, stdout: '', stderr: '' }

      for (const raw of buffered.split('\n').filter(Boolean)) {
        const frame = JSON.parse(raw) as { t: string; d?: string; c?: number }

        if (frame.t === 'o') {
          answer.stdout += frame.d ?? ''
        } else if (frame.t === 'e') {
          answer.stderr += frame.d ?? ''
        } else if (frame.t === 'x') {
          answer.code = frame.c ?? null
        }
      }

      resolve(answer)
    })
    socket.write(line)
  })
}
