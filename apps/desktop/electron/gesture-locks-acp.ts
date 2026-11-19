/**
 * F1-S (v0.0.9) — main's half of the owner-click lock on the window's ACP writes that move value or publish for the
 * owner: `agent register-erc8004` (signs an on-chain transaction) and the Market catalogue writes (`offering
 * create|update|delete`, `resource create`). Before v0.0.9 these had only the argv allowlist.
 *
 * Two steps, so the lock does not depend on how long the renderer's per-iNFT lane holds the write:
 *
 * 1. `confirm` — `iclone:acp-owner-confirm`, sent by the preload synchronously inside the click handler of the marked
 *    control (`data-acp-register-confirm` / `data-acp-market-confirm`) with that lock's `gesture`. Main checks the V3-F
 *    rule (activation + the preload's trusted confirm on that control + real input to this window within the window,
 *    `gestureOk`) and remembers ONE admission for this sender, this iNFT and this exact validated argv.
 * 2. `admit` — on `iclone:acp-run`, an owner-locked argv runs only by consuming that admission. Anything else (a
 *    script's call, the agent driving the page, a synthetic `el.click()`, a second run of the same argv, a different
 *    argv) is refused and audited `gesture:false`.
 *
 * Every decision is audited (`use · gesture:true` when a write is admitted, `refuse · gesture:false` otherwise). No
 * audit sink, or a sink that cannot record (returns null/undefined): every owner-locked write is refused — the same
 * safe default as the ACP tools' install.
 */
import { type AcpOwnerLock, commandOf, ownerLockOf, validateArgv } from './iclone-acp-argv'

/** One audit entry for an owner-locked write; the sink returns the record, or null when it could not write one. */
export type AcpWriteAuditSink = (entry: {
  kind: 'refuse' | 'use'
  reason: string
  gesture: boolean
  /** The command words (`offering create`), never a flag value. */
  command: string
  lock: AcpOwnerLock
}) => unknown

export interface AcpOwnerWritesDeps {
  /** Main's gesture verdict for this IPC sender and payload (V3-F `permissionGestureOk`). */
  gestureOk: (event: unknown, input: unknown) => boolean
  audit?: AcpWriteAuditSink
  now?: () => number
  /** How long one confirm stays usable (the write may wait in the iNFT's lane behind reads). */
  ttlMs?: number
}

export type AcpOwnerConfirmResult = { ok: true } | { ok: false; error: string }

/** A confirm is good for five minutes: longer than any read the write can queue behind (≤ 180 s), single use. */
export const ACP_OWNER_CONFIRM_TTL_MS = 300_000
const MAX_PENDING_PER_SENDER = 8

export const ACP_WRITE_REFUSED = {
  gesture: '[acp-write:gesture] this write needs your own click on its button',
  audit: '[acp-write:audit] the audit is not available, so nothing that needs your click can run',
  invalid: '[acp-write:invalid] not a write that takes an owner confirm'
} as const

const field = (input: unknown, key: string): unknown =>
  input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined

/** The sender's identity: its webContents id. Without one, every call shares one bucket (tests, a fake event). */
function senderKey(event: unknown): string {
  const id = (event as { sender?: { id?: unknown } } | null)?.sender?.id

  return typeof id === 'number' ? `wc:${id}` : 'wc:?'
}

function admissionKey(event: unknown, inftId: string, args: readonly string[]): string {
  return `${senderKey(event)}\n${inftId}\n${JSON.stringify(args)}`
}

export function createAcpOwnerWrites(deps: AcpOwnerWritesDeps) {
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? ACP_OWNER_CONFIRM_TTL_MS
  /** admission key → expiry; insertion order = age (oldest first). */
  const pending = new Map<string, number>()

  const record = (entry: Parameters<AcpWriteAuditSink>[0]): boolean => {
    try {
      const written = deps.audit?.(entry)

      return written !== null && written !== undefined && written !== false
    } catch {
      return false
    }
  }

  const sweep = (at: number) => {
    for (const [key, expires] of pending) {
      if (expires <= at) {
        pending.delete(key)
      }
    }
  }

  /** Keeps at most MAX_PENDING_PER_SENDER admissions per sender: the oldest goes first. */
  const cap = (sender: string) => {
    const mine = [...pending.keys()].filter(key => key.startsWith(`${sender}\n`))

    for (const key of mine.slice(0, Math.max(0, mine.length - MAX_PENDING_PER_SENDER))) {
      pending.delete(key)
    }
  }

  return {
    /** `iclone:acp-owner-confirm` — `{ inftId, argv, lock, gesture }` from the preload, inside the owner's click. */
    confirm(event: unknown, input: unknown): AcpOwnerConfirmResult {
      const inftId = String(field(input, 'inftId') ?? '').trim()
      const args = validateArgv(field(input, 'argv'))
      const lock = args ? ownerLockOf(args) : null
      const command = args ? (commandOf(args) ?? '') : ''

      // The preload names the lock it took the confirm from; it must be the one this argv needs, or a click on one
      // control could open another's write.
      if (!inftId || !args || !lock || field(input, 'lock') !== lock) {
        return { ok: false, error: ACP_WRITE_REFUSED.invalid }
      }

      if (!deps.audit) {
        return { ok: false, error: ACP_WRITE_REFUSED.audit }
      }

      if (deps.gestureOk(event, input) !== true) {
        record({
          kind: 'refuse',
          reason: `${command}: confirm without the owner's click`,
          gesture: false,
          command,
          lock
        })

        return { ok: false, error: ACP_WRITE_REFUSED.gesture }
      }

      const at = now()

      sweep(at)
      pending.delete(admissionKey(event, inftId, args))
      pending.set(admissionKey(event, inftId, args), at + ttlMs)
      cap(senderKey(event))

      return { ok: true }
    },

    /**
     * Before `iclone:acp-run` spawns anything: null = run it (not owner-locked, or the matching admission was consumed
     * and audited); a string = the refusal to return instead. An argv the allowlist refuses is left to runAcp.
     */
    admit(event: unknown, inftIdInput: unknown, argv: unknown): null | string {
      const args = validateArgv(argv)
      const lock = args ? ownerLockOf(args) : null

      if (!args || !lock) {
        return null
      }

      const command = commandOf(args) ?? ''
      const inftId = String(inftIdInput ?? '').trim()
      const key = admissionKey(event, inftId, args)
      const at = now()

      sweep(at)

      const expires = pending.get(key)

      // Single use: whatever happens next, this admission is spent.
      pending.delete(key)

      if (!deps.audit) {
        return ACP_WRITE_REFUSED.audit
      }

      if (expires === undefined || expires <= at) {
        record({ kind: 'refuse', reason: `${command}: no owner confirm for this write`, gesture: false, command, lock })

        return ACP_WRITE_REFUSED.gesture
      }

      if (!record({ kind: 'use', reason: `${command}: on the owner's click`, gesture: true, command, lock })) {
        return ACP_WRITE_REFUSED.audit
      }

      return null
    },

    /** Test seam: how many admissions are waiting. */
    pendingCount(): number {
      sweep(now())

      return pending.size
    }
  }
}

export type AcpOwnerWrites = ReturnType<typeof createAcpOwnerWrites>
