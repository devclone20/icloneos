/**
 * V3-J — the `pay` verb of the agent socket: the one way an agent reaches payments (contract §1.1). The socket that
 * carries it authenticates the session token first (like V3-F's `perm` verb) and hands this module the profile slug
 * the token belongs to: the agent never names itself, so argv carries no agent and a caller cannot spend another
 * agent's per-agent-day cap.
 *
 * The verb is the trust boundary, so it keeps its own backstop (merge round, builder r3 item 2): `pay()` does not
 * reject since r3, but whatever it does — reject, hang up with something that is not a result — the verb answers
 * `refused internal` and records it through V3-F's audit (`recordPayment`, src `payment`). Every refusal the verb
 * makes itself (usage, not ready) is audited too; the client audits its own.
 *
 * Verbs (the `x402-pay` skill's client speaks exactly these, completion round):
 *   pay <url> [--mandate <jti>] [--max <usdc>]   one payment; `--max` is the agent's own cap for this call
 *   send <payee> <usdc> [--mandate <jti>]        p2p: one transfer to an allowlisted payee, under a mandate
 *   stop                                         the hard stop, one way: ON (only the owner's gesture clears it)
 *   status                                       this agent's view: ready, stop, caps, today, its own mandates
 * Exit 0 = paid / passthrough / stopped / status, 1 = refused / failed / pending, 64 = usage, 3 = payments not started.
 */
import type { PaymentAuditEntry, PaymentAuditSink, PayResult, X402Client } from './client'
import { microsOfDecimal } from './mandates'

/**
 * The payment functions, as V3-F2's per-function levels will name them. V3-F2 SEAM (not wired this round: V3-F2 is
 * not merged): when it lands, the spend door and the audit entry carry `fn` from this table. `settings` and `revoke`
 * are the owner's (Settings › Economy › Payments) and never reachable from the agent socket.
 */
type PaymentFunction = 'pay' | 'revoke' | 'send' | 'settings' | 'status' | 'stop'

interface VerbResult {
  code: number
  stdout: string
  stderr?: string
}

export interface PaymentsVerbDeps {
  /** Null while payments are starting (or disabled: no sealing, R2). */
  client: X402Client | null
  audit: PaymentAuditSink | null
  /** Sets STOP (on only) and writes its `stop` row; false when it could not be set. */
  stop: (() => boolean) | null
  /** This agent's own view (no key, no signature, no raw mandate), or null while payments are not started. */
  status?: ((agent: string) => object) | null
}

const USAGE =
  'usage: pay <url> [--mandate <jti>] [--max <usdc>] | send <payee> <usdc> [--mandate <jti>] | stop | status'

const ARG_MAX = 8 * 1024

/** The socket serves only the agent's functions; the owner's are null here by construction. */
const SOCKET_FUNCTIONS: Readonly<Record<PaymentFunction, 'pay' | 'send' | 'status' | 'stop' | null>> = {
  pay: 'pay',
  send: 'send',
  stop: 'stop',
  status: 'status',
  settings: null,
  revoke: null
}

const isFunction = (value: unknown): value is PaymentFunction =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(SOCKET_FUNCTIONS, value)

const RESULT_KINDS: readonly string[] = ['passthrough', 'refused', 'paid', 'pending', 'failed']

const isPayResult = (value: unknown): value is PayResult =>
  typeof value === 'object' && value !== null && RESULT_KINDS.includes((value as { kind?: unknown }).kind as string)

const answer = (code: number, value: object): VerbResult => ({ code, stdout: `${JSON.stringify(value)}\n` })

interface ParsedPay {
  url: string
  mandate: string | null
  maxMicros?: number
}

/** `<url> [--mandate <jti>] [--max <usdc>]`, each flag at most once; anything else is usage. */
function parsePay(args: readonly unknown[]): ParsedPay | null {
  const [url, ...rest] = args

  if (typeof url !== 'string' || url.length === 0 || url.length > ARG_MAX || url.startsWith('--')) {
    return null
  }

  const parsed: ParsedPay = { url, mandate: null }
  const seen = new Set<string>()

  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]
    const value = rest[i + 1]

    if ((flag !== '--mandate' && flag !== '--max') || seen.has(flag) || typeof value !== 'string') {
      return null
    }

    seen.add(flag)

    if (flag === '--mandate') {
      parsed.mandate = value
    } else {
      const micros = microsOfDecimal(value)

      if (micros === null) {
        return null
      }

      parsed.maxMicros = micros
    }
  }

  return parsed
}

interface ParsedSend {
  payTo: string
  micros: number
  mandate: string | null
}

/** `<payee> <usdc> [--mandate <jti>]`; the payee and the amount are checked by the client (refused, audited). */
function parseSend(args: readonly unknown[]): ParsedSend | null {
  const [payTo, amount, flag, value, ...rest] = args

  if (typeof payTo !== 'string' || payTo.length === 0 || payTo.length > 64 || payTo.startsWith('--')) {
    return null
  }

  const micros = microsOfDecimal(amount)

  if (micros === null || rest.length > 0) {
    return null
  }

  if (flag === undefined) {
    return { payTo, micros, mandate: null }
  }

  return flag === '--mandate' && typeof value === 'string' ? { payTo, micros, mandate: value } : null
}

export async function paymentsVerb(
  deps: PaymentsVerbDeps,
  slug: string | null,
  argv: readonly unknown[]
): Promise<VerbResult> {
  const agent = typeof slug === 'string' ? slug : ''

  const audit = (entry: PaymentAuditEntry): void => {
    try {
      deps.audit?.record(entry)
    } catch {
      // the sink's own failure is not the request's
    }
  }

  const refused = (code: number, reason: string, detail: string): VerbResult => {
    audit({ kind: 'refuse', reason, agent })

    return { ...answer(code, { kind: 'refused', reason, detail }), ...(code === 64 ? { stderr: `${USAGE}\n` } : {}) }
  }

  const [verb, ...args] = Array.isArray(argv) ? argv : []
  const fn = isFunction(verb) ? SOCKET_FUNCTIONS[verb] : null

  if (!fn) {
    return refused(64, 'usage', 'not a payments verb')
  }

  if (fn === 'stop') {
    if (args.length > 0) {
      return refused(64, 'usage', 'stop takes no arguments')
    }

    if (!deps.stop) {
      return refused(3, 'not_ready', 'payments are not started')
    }

    let set = false

    try {
      set = deps.stop() === true
    } catch {
      set = false
    }

    if (!set) {
      return refused(1, 'internal', 'the stop could not be set')
    }

    audit({ kind: 'use', reason: 'stop on', agent })

    return answer(0, { kind: 'stopped' })
  }

  if (fn === 'status') {
    if (args.length > 0) {
      return refused(64, 'usage', 'status takes no arguments')
    }

    let view: object | null = null

    try {
      view = deps.status ? deps.status(agent) : null
    } catch {
      view = null
    }

    return view ? answer(0, { kind: 'status', ...view }) : refused(3, 'not_ready', 'payments are not started')
  }

  const pay = fn === 'pay' ? parsePay(args) : null
  const send = fn === 'send' ? parseSend(args) : null

  if (!pay && !send) {
    return refused(64, 'usage', USAGE)
  }

  if (!deps.client) {
    return refused(3, 'not_ready', 'payments are not started')
  }

  // The trust boundary keeps its own catch: a rejection, or anything that is not a result, is refused and audited.
  let result: unknown

  try {
    result = pay ? await deps.client.pay({ ...pay, agent }) : await deps.client.send({ ...(send as ParsedSend), agent })
  } catch {
    result = null
  }

  if (!isPayResult(result)) {
    return refused(1, 'internal', 'internal error')
  }

  return answer(result.kind === 'paid' || result.kind === 'passthrough' ? 0 : 1, result)
}
