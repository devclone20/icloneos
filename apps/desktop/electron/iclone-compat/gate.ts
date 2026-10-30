// The update gate (contract decision 8), enforced in main inside `hermes:updates:apply`, never in the UI. GREEN passes.
// Anything else needs a fresh owner ack for that exact verdict: RED held 3 s with every finding named, UNKNOWN held
// 1.5 s, AMBER accepted. Each override writes one `audit.jsonl` line and consumes the ack. The agent path (request
// files) may only ever pass on GREEN. A missing or stale verdict is UNKNOWN, never GREEN.
// The ack is minted in main's memory, never read from disk: any local process (the agent has a shell) can write a file.
// Main times the hold itself, between `beginOwnerHold` and `mintOwnerAck`, and binds it to the verdict id and a nonce.
// The verdict is held the same way: only main's producer (`publishGateVerdict`) sets it; `pending.json` is the renderer's
// copy and is never read here. A verdict counts only for the rev `hermes update` will install (`bindInstallTarget`),
// which main resolves again right before apply (`refreshInstallTarget`).
import { randomBytes, timingSafeEqual } from 'node:crypto'

import { appendLine, storeRoot, writeStoreJson } from './store'

type GateLevel = 'GREEN' | 'AMBER' | 'RED' | 'UNKNOWN'
type GateActor = 'owner' | 'agent'

export const HOLD_MS: Record<GateLevel, number> = { GREEN: 0, AMBER: 0, RED: 3000, UNKNOWN: 1500 }
const MAX_VERDICT_AGE_MS = 10 * 60_000
const MAX_ACK_AGE_MS = 2 * 60_000
// A resolved install target older than this (main's clock, not the caller's) is no answer: the remote may have moved.
export const MAX_TARGET_AGE_MS = 5 * 60_000
export const NO_VERDICT = 'none'
/**
 * The gate's last refusal of the owner, so Settings can say it after a restart. It is history, never cleared by a pass:
 * a pass is not an install (the apply can still stop after the gate), and the pane shows it only for the same target.
 */
export const LAST_REFUSAL_FILE = 'last-refusal.json'

/** @public The record `LAST_REFUSAL_FILE` holds (read back by the compat status IPC). */
export interface GateRefusalRecord {
  v: 1
  at: string
  level: GateLevel
  reason: string
  verdictId: string
  /** The rev the refused update would have installed (main's install target; else the verdict's); null = unknown. */
  target: null | string
}

export interface GateVerdict {
  id?: string
  level?: string
  computedAt?: string
  cards?: { root?: string; level?: string; names?: string[] }[]
  runtime?: { to?: string }
}

interface OwnerAck {
  verdictId: string
  by: string
  heldMs: number
  names?: string[]
  at: string
}

interface GateDecision {
  allow: boolean
  level: GateLevel
  verdictId: string
  override: boolean
  reason: string
  required: string[]
}

const LEVELS = new Set<GateLevel>(['GREEN', 'AMBER', 'RED', 'UNKNOWN'])
const TARGET_PREFIX = /^[0-9a-f]{7,40}$/
const FULL_SHA = /^[0-9a-f]{40}$/

// True when the verdict was computed for `installTarget` (a full sha); the verdict may carry an abbreviated one.
export function targetMatches(verdict: GateVerdict | null, installTarget: string | null): boolean {
  const to = String(verdict?.runtime?.to ?? '')

  return !!installTarget && FULL_SHA.test(installTarget) && TARGET_PREFIX.test(to) && installTarget.startsWith(to)
}

function effectiveLevel(verdict: GateVerdict | null, now: number): GateLevel {
  if (!verdict || !LEVELS.has(verdict.level as GateLevel)) {
    return 'UNKNOWN'
  }

  const at = Date.parse(verdict.computedAt ?? '')

  return Number.isFinite(at) && now - at <= MAX_VERDICT_AGE_MS ? (verdict.level as GateLevel) : 'UNKNOWN'
}

// The names an owner must see before overriding: every name on every card at the verdict's level.
function requiredNames(verdict: GateVerdict | null, level: GateLevel): string[] {
  if (level !== 'RED') {
    return []
  }

  return [...new Set((verdict?.cards ?? []).filter(c => c.level === 'RED').flatMap(c => c.names ?? []))].sort()
}

export function decideGate(opts: {
  verdict: GateVerdict | null
  ack: OwnerAck | null
  actor: GateActor
  now: number
  // When given, a verdict for any other rev is UNKNOWN: it says nothing about what the update installs.
  installTarget?: string | null
}): GateDecision {
  const fresh = effectiveLevel(opts.verdict, opts.now)
  const unbound = opts.installTarget !== undefined && !targetMatches(opts.verdict, opts.installTarget)
  const level = unbound ? 'UNKNOWN' : fresh
  const verdictId = opts.verdict?.id ?? NO_VERDICT
  const required = requiredNames(opts.verdict, level)
  const base = { level, verdictId, required, override: false }

  if (level === 'GREEN') {
    return { ...base, allow: true, reason: 'green' }
  }

  if (opts.actor !== 'owner') {
    return { ...base, allow: false, reason: 'agent-non-green' }
  }

  const ack = opts.ack

  if (!ack || ack.by !== 'owner' || ack.verdictId !== verdictId) {
    return { ...base, allow: false, reason: unbound && fresh !== 'UNKNOWN' ? 'target-unbound' : 'owner-ack-required' }
  }

  const ackAt = Date.parse(ack.at)

  if (!Number.isFinite(ackAt) || opts.now - ackAt > MAX_ACK_AGE_MS || ackAt - opts.now > 5000) {
    return { ...base, allow: false, reason: 'ack-expired' }
  }

  if (!(ack.heldMs >= HOLD_MS[level])) {
    return { ...base, allow: false, reason: 'hold-too-short' }
  }

  const named = new Set(ack.names ?? [])

  if (required.some(n => !named.has(n))) {
    return { ...base, allow: false, reason: 'findings-not-named' }
  }

  return { ...base, allow: true, override: true, reason: 'owner-override' }
}

/** @public Named by inferred types of electron/main exports (declaration emit). */
export interface GateRefusal {
  ok: false
  error: 'compat-gate'
  level: GateLevel
  reason: string
  verdictId: string
  message: string
}

interface OwnerHold {
  verdictId: string
  nonce: string
  startedAt: number
}

let hold: OwnerHold | null = null
let minted: OwnerAck | null = null
let produced: GateVerdict | null = null
let resolveInstallTarget: () => Promise<string | null> | string | null = () => null
let boundTarget: { rev: string | null; at: number } | null = null
let resolving: Promise<string | null> | null = null

// Main's producer hands over the verdict it computed; the gate keeps its own frozen copy.
export function publishGateVerdict(verdict: GateVerdict | null): void {
  produced = verdict ? Object.freeze(structuredClone(verdict)) : null
}

export function gateVerdict(): GateVerdict | null {
  return produced
}

// The rev `hermes update` will install. Resolving it may reach the network, so main resolves it off the hot path
// (`refreshInstallTarget` at every preview and right before apply) and the gate reads the last answer, which expires.
export function bindInstallTarget(resolve: () => Promise<string | null> | string | null): void {
  resolveInstallTarget = resolve
  boundTarget = null
  resolving = null
}

export function refreshInstallTarget(now: () => number = Date.now): Promise<string | null> {
  const resolver = resolveInstallTarget

  resolving ??= (async () => {
    let rev: string | null = null

    try {
      rev = (await resolver()) ?? null
    } catch {
      rev = null
    }

    if (resolver === resolveInstallTarget) {
      boundTarget = { rev, at: now() }
      resolving = null
    }

    return rev
  })()

  return resolving
}

export function installTarget(now: number = Date.now()): string | null {
  return boundTarget && now - boundTarget.at <= MAX_TARGET_AGE_MS ? boundTarget.rev : null
}

// The level the gate would apply now, for the hold the owner has to make.
export function gateLevel(now: number = Date.now()): GateLevel {
  return decideGate({ verdict: produced, ack: null, actor: 'owner', now, installTarget: installTarget() }).level
}

type MintResult = { ok: true; verdictId: string; heldMs: number } | { ok: false; reason: string }

function sameNonce(a: string, b: string): boolean {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))

  return x.length === y.length && timingSafeEqual(x, y)
}

// Starts the owner's hold for one verdict. A new hold replaces any earlier hold and any unspent ack.
export function beginOwnerHold(verdictId: string, now: number = Date.now()): { verdictId: string; nonce: string } {
  hold = { verdictId, nonce: randomBytes(16).toString('hex'), startedAt: now }
  minted = null

  return { verdictId, nonce: hold.nonce }
}

// Ends the hold and mints the single ack the gate will read. heldMs is main's own clock, never the caller's.
export function mintOwnerAck(
  req: { verdictId: string; nonce: string; names?: string[] },
  now: number = Date.now()
): MintResult {
  const h = hold
  hold = null

  if (!h || h.verdictId !== req.verdictId || !sameNonce(h.nonce, req.nonce)) {
    return { ok: false, reason: 'no-hold' }
  }

  const heldMs = now - h.startedAt

  if (heldMs < 0 || heldMs > MAX_ACK_AGE_MS) {
    return { ok: false, reason: 'hold-expired' }
  }

  minted = {
    verdictId: h.verdictId,
    by: 'owner',
    heldMs,
    names: [...(req.names ?? [])],
    at: new Date(now).toISOString()
  }

  return { ok: true, verdictId: h.verdictId, heldMs }
}

export function cancelOwnerHold(): void {
  hold = null
  minted = null
}

// Main's seam: null lets `applyUpdates` run; a refusal is returned to the renderer instead. The minted ack is spent by
// this call whatever the outcome, so a refused attempt needs a new hold.
export function compatGate(userData: string, now: number = Date.now()): GateRefusal | null {
  const root = storeRoot(userData)
  const verdict = produced
  const target = installTarget()
  const ack = minted
  minted = null
  const d = decideGate({ verdict, ack, actor: 'owner', now, installTarget: target })

  if (d.allow && d.override && ack) {
    appendLine(root, 'audit.jsonl', {
      v: 1,
      at: new Date(now).toISOString(),
      by: 'owner',
      verdictId: d.verdictId,
      level: d.level,
      target: verdict?.runtime?.to ?? null,
      heldMs: ack.heldMs,
      names: d.required
    })
  }

  // The record is a convenience for the pane: a disk failure never changes the decision.
  if (!d.allow) {
    try {
      const record: GateRefusalRecord = {
        v: 1,
        at: new Date(now).toISOString(),
        level: d.level,
        reason: d.reason,
        verdictId: d.verdictId,
        target: target ?? verdict?.runtime?.to ?? null
      }

      writeStoreJson(root, LAST_REFUSAL_FILE, record)
    } catch {
      void 0
    }
  }

  if (d.allow) {
    return null
  }

  return {
    ok: false,
    error: 'compat-gate',
    level: d.level,
    reason: d.reason,
    verdictId: d.verdictId,
    message: `Update held by the compatibility gate (${d.level}, ${d.reason}).`
  }
}

export function agentRequestAllowed(verdict: GateVerdict | null, now: number = Date.now()): boolean {
  return decideGate({ verdict, ack: null, actor: 'agent', now }).allow
}
