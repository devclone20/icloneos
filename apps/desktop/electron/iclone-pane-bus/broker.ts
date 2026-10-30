/**
 * The pane bus broker. It lives in MAIN so a renderer reload loses nothing and
 * every count is measurable in one place. Identity comes only from the token
 * (resolved by the transport before `run` is called); the broker stamps
 * `from`, so a pane can never speak as another.
 *
 * Pull model (owner decision O1, the contract default): the broker never types
 * into a pty. A reader fetches with `recv`; an `ask` long-polls for its reply.
 */
import { randomBytes } from 'node:crypto'

import { checkBody, type Envelope, type EnvelopeKind, isMessageId, isPaneName } from './envelope'
import { Mailbox } from './mailbox'
import { createPaneTokens, type PaneTokens } from './token'

const ASK_DEFAULT_TIMEOUT_S = 60
const ASK_MAX_TIMEOUT_S = 600
const RECV_MAX_WAIT_S = 600
const DEFAULT_TTL_S = 600
const RECV_DEFAULT_MAX = 100
const DEAD_RECORDS_KEPT = 256
const SIGNAL_TEXT_MAX = 200
const RESULT_TEXT_MAX = 8 * 1024
const PENDING_ASKS_PER_PANE = 32

type PaneState = 'dead' | 'exited' | 'idle' | 'needs-input' | 'running'

export type SignalSource = 'attention' | 'bell' | 'osc777' | 'osc9'

interface PaneSignal {
  text: string
  at: number
  source: SignalSource
}

interface PaneRegistration {
  paneId: string
  name: string
  group?: string
  role?: string
  spawnId?: string
}

export interface PaneSummary {
  paneId: string
  name: string
  group: null | string
  role: null | string
  spawnId: null | string
  state: PaneState
  pid: null | number
  unread: number
  signal: null | PaneSignal
  result: null | string
  exit: null | { code: null | number; signal: null | number | string }
  /** False for a pane with no bus identity (a tmux pane in this release). */
  bus: boolean
}

interface BusStats {
  sent: number
  delivered: number
  duplicates: number
  deadLetters: number
  expired: number
  refusedFull: number
  forged: number
  asks: number
  replies: number
  askTimeouts: number
}

interface BusReply {
  status: 200 | 400 | 403 | 404 | 408 | 409 | 429
  text: string
}

export type BusLogEntry = Record<string, boolean | null | number | string>

interface PendingAsk {
  asker: string
  target: string
  finish: (reply: BusReply) => void
}

interface PaneRecord {
  paneId: string
  name: string
  group: null | string
  role: null | string
  spawnId: null | string
  state: PaneState
  pid: null | number
  signal: null | PaneSignal
  result: null | string
  exit: PaneSummary['exit']
  mailbox: Mailbox
  bus: boolean
  /** Next seq this pane stamps per receiver. */
  seqTo: Map<string, number>
}

class BusError extends Error {}

interface BrokerOptions {
  log?: (entry: BusLogEntry) => void
  now?: () => number
  onChange?: (pane: PaneSummary) => void
  tokens?: PaneTokens
}

interface ParsedArgs {
  flags: Map<string, string>
  switches: Set<string>
  text: string
}

const VALUE_FLAGS = new Set(['--to', '--timeout', '--wait', '--max', '--corr', '--id', '--ttl', '--from'])
const SWITCHES = new Set(['--json', '--result'])

function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string>()
  const switches = new Set<string>()
  const rest: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i]

    if (VALUE_FLAGS.has(word)) {
      flags.set(word, argv[i + 1] ?? '')
      i += 1
    } else if (SWITCHES.has(word)) {
      switches.add(word)
    } else {
      rest.push(word)
    }
  }

  return { flags, switches, text: rest.join(' ') }
}

function seconds(raw: string | undefined, fallback: number, max: number): number {
  const value = raw === undefined ? fallback : Number(raw)

  return Number.isFinite(value) && value >= 0 ? Math.min(value, max) : fallback
}

const ok = (text: string): BusReply => ({ status: 200, text })
const fail = (status: BusReply['status'], text: string): BusReply => ({ status, text: `it bus: ${text}` })

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

export function createPaneBroker({
  log = () => {},
  now = Date.now,
  onChange = () => {},
  tokens = createPaneTokens()
}: BrokerOptions = {}) {
  const panes = new Map<string, PaneRecord>()
  const pendingAsks = new Map<string, PendingAsk>()

  const stats: BusStats = {
    sent: 0,
    delivered: 0,
    duplicates: 0,
    deadLetters: 0,
    expired: 0,
    refusedFull: 0,
    forged: 0,
    asks: 0,
    replies: 0,
    askTimeouts: 0
  }

  const summary = (pane: PaneRecord): PaneSummary => ({
    paneId: pane.paneId,
    name: pane.name,
    group: pane.group,
    role: pane.role,
    spawnId: pane.spawnId,
    state: pane.state,
    pid: pane.pid,
    unread: pane.mailbox.size,
    signal: pane.signal,
    result: pane.result,
    exit: pane.exit,
    bus: pane.bus
  })

  const alive = (pane: PaneRecord) => pane.state !== 'dead' && pane.state !== 'exited'

  const byName = (name: string) => {
    let found: PaneRecord | undefined

    for (const pane of panes.values()) {
      // A live holder wins over a dead record of the same name.
      if (pane.name === name && (!found || alive(pane))) {
        found = pane
      }
    }

    return found
  }

  const changed = (pane: PaneRecord) => onChange(summary(pane))

  const pruneDead = () => {
    const dead = [...panes.values()].filter(pane => !alive(pane))

    for (const pane of dead.slice(0, Math.max(0, dead.length - DEAD_RECORDS_KEPT))) {
      panes.delete(pane.paneId)
    }
  }

  const nextSeq = (from: PaneRecord, to: string) => {
    const seq = (from.seqTo.get(to) ?? 0) + 1

    from.seqTo.set(to, seq)

    return seq
  }

  /** A pane on the bus: its token is returned, and is its only identity. */
  function register(registration: PaneRegistration): string {
    add(registration, true)

    return tokens.mint(registration.paneId)
  }

  /**
   * A pane the bus knows (state, attention, the sidebar line) but that holds no
   * identity: nothing can be sent as it, and nothing is queued for it.
   */
  function registerOffBus(registration: PaneRegistration): void {
    add(registration, false)
    tokens.revoke(registration.paneId)
  }

  function add(registration: PaneRegistration, bus: boolean): void {
    const { paneId, name } = registration

    if (!isPaneName(name)) {
      throw new BusError(`pane name "${name}" must match ^[a-z0-9][a-z0-9_-]{0,31}$`)
    }

    if (registration.group !== undefined && !isPaneName(registration.group)) {
      throw new BusError(`group "${registration.group}" must match ^[a-z0-9][a-z0-9_-]{0,31}$`)
    }

    const holder = byName(name)

    if (holder && holder.paneId !== paneId && alive(holder)) {
      throw new BusError(`a live pane is already called "${name}"`)
    }

    if (holder && !alive(holder) && holder.paneId !== paneId) {
      panes.delete(holder.paneId)
    }

    const pane: PaneRecord = {
      paneId,
      name,
      group: registration.group ?? null,
      role: registration.role ? oneLine(registration.role, 64) : null,
      spawnId: registration.spawnId ?? null,
      state: 'running',
      pid: null,
      signal: null,
      result: null,
      exit: null,
      mailbox: panes.get(paneId)?.mailbox ?? new Mailbox(),
      bus,
      seqTo: new Map()
    }

    panes.set(paneId, pane)
    log({ verb: 'register', pane: name, group: pane.group, bus })
    changed(pane)
  }

  function attachPid(paneId: string, pid: number): void {
    const pane = panes.get(paneId)

    if (pane) {
      pane.pid = pid
    }
  }

  /** The shell ended. A signal (kill -9 from outside) is `dead`; an exit code is `exited`. */
  function exited(paneId: string, exit: { code: null | number; signal: null | number | string }): void {
    const pane = panes.get(paneId)

    if (!pane || !alive(pane)) {
      return
    }

    tokens.revoke(paneId)
    pane.state = exit.signal ? 'dead' : 'exited'
    pane.exit = exit

    const unread = pane.mailbox.drain()

    stats.deadLetters += unread.length

    for (const [corr, pending] of pendingAsks) {
      if (pending.target === paneId) {
        pendingAsks.delete(corr)
        pending.finish(fail(409, `pane "${pane.name}" ${pane.state} before it answered`))
      } else if (pending.asker === paneId) {
        pendingAsks.delete(corr)
        pending.finish(fail(409, 'the asking pane is gone'))
      }
    }

    log({ verb: 'exit', pane: pane.name, state: pane.state, deadLetters: unread.length })
    changed(pane)
    pruneDead()
  }

  function setSignal(paneId: string, text: string, source: SignalSource): boolean {
    const pane = panes.get(paneId)

    if (!pane || !alive(pane)) {
      return false
    }

    // Any program can print OSC 9/777, so its words are never shown as the app's own.
    const shown = source === 'osc9' || source === 'osc777' ? `[${source}] ${text}` : text

    pane.signal = { text: oneLine(shown, SIGNAL_TEXT_MAX), at: now(), source }
    pane.state = 'needs-input'
    changed(pane)

    return true
  }

  /** The owner looked at the pane: it no longer needs input, but the last signal stays for the sidebar. */
  function clearAttention(paneId: string): void {
    const pane = panes.get(paneId)

    if (pane?.state === 'needs-input') {
      pane.state = 'running'
      changed(pane)
    }
  }

  function deliver(from: PaneRecord, target: PaneRecord, kind: EnvelopeKind, body: string, extra: Partial<Envelope>) {
    const envelope: Envelope = {
      v: 1,
      id: extra.id ?? randomBytes(9).toString('base64url'),
      seq: nextSeq(from, target.paneId),
      from: from.name,
      to: target.name,
      ...(extra.group ? { group: extra.group } : {}),
      kind,
      ...(extra.corr ? { corr: extra.corr } : {}),
      ts: now(),
      ttl: extra.ttl ?? DEFAULT_TTL_S,
      body
    }

    const result = target.mailbox.push(envelope)

    if (result === 'queued') {
      stats.sent += 1
    } else if (result === 'duplicate') {
      stats.duplicates += 1
      // A retry that was already queued must not consume a seq number.
      from.seqTo.set(target.paneId, envelope.seq - 1)
    } else {
      stats.refusedFull += 1
      from.seqTo.set(target.paneId, envelope.seq - 1)
    }

    log({ verb: kind, from: from.name, to: target.name, id: envelope.id, bytes: Buffer.byteLength(body), result })

    return { envelope, result }
  }

  function resolveTargets(from: PaneRecord, raw: string): PaneRecord[] | BusReply {
    if (!raw) {
      return fail(400, 'say who: --to <name> or --to @<group>')
    }

    if (raw.startsWith('@')) {
      const group = raw.slice(1)

      const members = [...panes.values()].filter(
        pane => pane.group === group && alive(pane) && pane.bus && pane !== from
      )

      return members.length ? members : fail(404, `no live pane in group "${group}"`)
    }

    const target = byName(raw)

    if (!target) {
      return fail(404, `no pane called "${raw}"`)
    }

    if (!alive(target)) {
      stats.deadLetters += 1
      log({ verb: 'dead-letter', from: from.name, to: raw })

      return fail(409, `pane "${raw}" is ${target.state}; the message was not delivered`)
    }

    if (!target.bus) {
      return fail(409, `pane "${raw}" runs in tmux and has no bus in this release; the message was not delivered`)
    }

    return [target]
  }

  function sendLike(from: PaneRecord, args: ParsedArgs, kind: 'msg'): BusReply {
    const checked = checkBody(args.text)

    if (!checked.ok) {
      return fail(400, checked.error)
    }

    const id = args.flags.get('--id')

    if (id !== undefined && !isMessageId(id)) {
      return fail(400, '--id must be 8-64 characters of A-Z a-z 0-9 _ -')
    }

    const to = args.flags.get('--to') ?? ''
    const targets = resolveTargets(from, to)

    if (!Array.isArray(targets)) {
      return targets
    }

    // All or nothing: every member must take it (count AND bytes) before the first is given it.
    const draft: Envelope = {
      v: 1,
      id: id ?? '',
      seq: 0,
      from: from.name,
      to: '',
      kind,
      ts: 0,
      ttl: 0,
      body: args.text
    }

    const full = targets.filter(target => !target.mailbox.accepts({ ...draft, to: target.name }))

    if (full.length) {
      stats.refusedFull += full.length

      return fail(409, `mailbox full: ${full.map(target => target.name).join(', ')} (nothing was sent)`)
    }

    const ttl = seconds(args.flags.get('--ttl'), DEFAULT_TTL_S, 86_400)
    const group = to.startsWith('@') ? to.slice(1) : undefined
    let sharedId = id
    const results: string[] = []

    for (const target of targets) {
      const { envelope, result } = deliver(from, target, kind, args.text, { id: sharedId, group, ttl })

      sharedId = envelope.id

      if (result === 'full') {
        return fail(409, `mailbox of "${target.name}" is full`)
      }

      results.push(`${result === 'duplicate' ? 'duplicate' : 'sent'} ${envelope.id} → ${target.name} #${envelope.seq}`)
    }

    return ok(results.join('\n'))
  }

  function ask(from: PaneRecord, args: ParsedArgs, left?: AbortSignal): Promise<BusReply> | BusReply {
    const to = args.flags.get('--to') ?? ''

    if (to.startsWith('@')) {
      return fail(400, 'ask one pane at a time (--to <name>)')
    }

    const checked = checkBody(args.text)

    if (!checked.ok) {
      return fail(400, checked.error)
    }

    const targets = resolveTargets(from, to)

    if (!Array.isArray(targets)) {
      return targets
    }

    const [target] = targets
    let open = 0

    for (const pending of pendingAsks.values()) {
      open += pending.asker === from.paneId ? 1 : 0
    }

    if (open >= PENDING_ASKS_PER_PANE) {
      return fail(429, `${open} questions are already open from "${from.name}"; wait for one first`)
    }

    const timeoutS = seconds(args.flags.get('--timeout'), ASK_DEFAULT_TIMEOUT_S, ASK_MAX_TIMEOUT_S)
    const { envelope, result } = deliver(from, target, 'ask', args.text, { ttl: Math.ceil(timeoutS) })

    if (result !== 'queued') {
      return fail(409, `mailbox of "${target.name}" is full`)
    }

    stats.asks += 1
    const corr = envelope.id

    return new Promise<BusReply>(resolve => {
      const abandon = () => {
        clearTimeout(timer)
        pendingAsks.delete(corr)
        log({ verb: 'ask-abandoned', from: from.name, to: target.name, id: corr })
        resolve(fail(408, 'the asking client left'))
      }

      const timer = setTimeout(() => {
        left?.removeEventListener('abort', abandon)
        pendingAsks.delete(corr)
        stats.askTimeouts += 1
        log({ verb: 'ask-timeout', from: from.name, to: target.name, id: corr })
        resolve(fail(408, `no answer from "${target.name}" in ${timeoutS} s (question ${corr})`))
      }, timeoutS * 1000)

      pendingAsks.set(corr, {
        asker: from.paneId,
        target: target.paneId,
        finish: reply => {
          clearTimeout(timer)
          left?.removeEventListener('abort', abandon)
          resolve(reply)
        }
      })

      if (left?.aborted) {
        abandon()
      } else {
        left?.addEventListener('abort', abandon, { once: true })
      }
    })
  }

  function reply(from: PaneRecord, args: ParsedArgs): BusReply {
    if (args.switches.has('--result')) {
      from.result = args.text.slice(0, RESULT_TEXT_MAX)
      log({ verb: 'result', from: from.name, bytes: Buffer.byteLength(from.result) })
      changed(from)

      return ok('result recorded')
    }

    const checked = checkBody(args.text)

    if (!checked.ok) {
      return fail(400, checked.error)
    }

    const corr = args.flags.get('--corr') ?? ''
    const pending = pendingAsks.get(corr)

    if (!pending || pending.target !== from.paneId) {
      return fail(404, `no open question ${corr || '(missing --corr)'} for "${from.name}"`)
    }

    pendingAsks.delete(corr)
    stats.replies += 1
    stats.delivered += 1
    log({ verb: 'reply', from: from.name, corr, bytes: Buffer.byteLength(args.text) })
    pending.finish(ok(args.text))

    return ok(`answered ${corr}`)
  }

  async function recv(from: PaneRecord, args: ParsedArgs, left?: AbortSignal): Promise<BusReply> {
    const waitS = seconds(args.flags.get('--wait'), 0, RECV_MAX_WAIT_S)
    const max = Math.max(1, Math.min(1_000, Number(args.flags.get('--max') ?? RECV_DEFAULT_MAX) || RECV_DEFAULT_MAX))

    await from.mailbox.waitForMail(waitS * 1000, left)

    // Nobody is listening any more: leave the mail queued for the next read.
    if (left?.aborted) {
      return fail(408, 'the reading client left')
    }

    const messages = from.mailbox.take(max, now(), () => {
      stats.expired += 1
    })

    stats.delivered += messages.length

    if (messages.length) {
      log({ verb: 'recv', pane: from.name, count: messages.length })
    }

    if (args.switches.has('--json')) {
      return ok(messages.map(message => JSON.stringify(message)).join('\n'))
    }

    return ok(
      messages
        .map(
          message =>
            `${message.from}\t${message.kind}\t${message.id}\t${message.seq}\t${message.body.replace(/\n/g, '\\n')}`
        )
        .join('\n')
    )
  }

  function who(args: ParsedArgs): BusReply {
    const list = [...panes.values()].map(summary)

    if (args.switches.has('--json')) {
      return ok(JSON.stringify(list))
    }

    return ok(
      list
        .map(pane =>
          [
            pane.name,
            pane.state,
            pane.group ? `@${pane.group}` : '-',
            pane.role ?? '-',
            pane.bus ? `${pane.unread} unread` : 'no bus (tmux)'
          ].join('\t')
        )
        .join('\n')
    )
  }

  /** One bus verb, already authenticated as `paneId`. `left` fires when the client hangs up. */
  function run(paneId: string, argv: readonly string[], left?: AbortSignal): Promise<BusReply> | BusReply {
    const from = panes.get(paneId)

    if (!from || !alive(from) || !from.bus) {
      return fail(403, 'this pane is not on the bus')
    }

    const [verb = 'help', ...rest] = argv
    const args = parseArgs(rest)
    const claimed = args.flags.get('--from')

    if (claimed !== undefined && claimed !== from.name) {
      stats.forged += 1
      log({ verb: 'forged', pane: from.name, claimed })

      return fail(403, `this pane is "${from.name}"; it cannot speak as "${claimed}"`)
    }

    switch (verb) {
      case 'who':
        return who(args)

      case 'send':
        return sendLike(from, args, 'msg')

      case 'ask':
        return ask(from, args, left)

      case 'reply':
        return reply(from, args)

      case 'recv':
        return recv(from, args, left)

      case 'attention':
        setSignal(paneId, args.text || 'needs input', 'attention')
        log({ verb: 'attention', pane: from.name })

        return ok('attention raised')

      case 'whoami':
        return ok(from.name)

      default:
        return fail(400, `unknown verb "${verb}" (who · whoami · send · ask · recv · reply · attention)`)
    }
  }

  return {
    register,
    registerOffBus,
    attachPid,
    exited,
    setSignal,
    clearAttention,
    run,
    authenticate: (token: string) => tokens.verify(token),
    snapshot: (): PaneSummary[] => [...panes.values()].map(summary),
    stats: (): BusStats => ({ ...stats })
  }
}

export type PaneBroker = ReturnType<typeof createPaneBroker>
