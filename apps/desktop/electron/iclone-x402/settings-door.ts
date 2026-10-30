/**
 * V3-J — the settings door: how a change from Settings › Economy › Payments reaches the store (contract §4, the
 * owner's decision: every cap and switch is the user's, and raising one is itself a spend-class decision).
 *
 *   read what is stored (`shown`) → diff it against the request (`widens(shown, next)`) → a widening asks V3-F's door
 *   with every axis old → new (floor 5; only the boolean `true` of a trusted gesture opens it; no door, a throw or the
 *   deadline is a no) → `changeSettings` against that SAME `shown` (compare-and-set: if anything stored moved while
 *   the sheet was open, nothing is applied) → the ledger's `setting` row → the audit.
 *
 * A lowering needs no sheet and is applied at once — still against `shown`, still recorded. Every outcome is audited
 * through V3-F (`recordPayment`, src `payment`): `use setting <axes>` when applied, `refuse <reason>` otherwise.
 */
import type { PaymentAuditSink } from './client'
import type { PaymentLedger } from './ledger'
import {
  allowlistProblem,
  normalizeSettings,
  type PaymentSettings,
  type SettingsDiff,
  unavailableChoice,
  widens
} from './limits'
import { changeSettings, type PaymentPaths, readSettings } from './store'

/** V3-F's door sheet for a widening change: it shows `changes` (axis, old → new) and answers on a trusted gesture. */
type SettingsSheet = (request: { changes: SettingsDiff['changes']; locale?: unknown }) => Promise<boolean>

interface SettingsDoorDeps {
  paths: PaymentPaths
  ledger: PaymentLedger
  door: SettingsSheet | null
  audit: PaymentAuditSink | null
  /** No answer by then is a no (V3-F's sheet times out at 2 min; this is the backstop). */
  doorTimeoutMs?: number
}

type SettingsRefusal = 'allowlist' | 'door_denied' | 'ledger' | 'no_door' | 'settings_moved' | 'unavailable'

type SettingsOutcome =
  { ok: true; settings: PaymentSettings; diff: SettingsDiff } | { ok: false; reason: SettingsRefusal; detail: string }

interface SettingsDoor {
  /** `locale`: the window's language, for the sheet's labels only (J4-4). */
  change: (next: unknown, locale?: unknown) => Promise<SettingsOutcome>
}

const DOOR_TIMEOUT_MS = 120_000

export function createSettingsDoor(deps: SettingsDoorDeps): SettingsDoor {
  const doorTimeoutMs = deps.doorTimeoutMs ?? DOOR_TIMEOUT_MS

  const audit = (kind: 'refuse' | 'use', reason: string): void => {
    try {
      // The owner's change: no agent.
      deps.audit?.record({ kind, reason, agent: '' })
    } catch {
      // the sink's own failure is not the change's
    }
  }

  const refuse = (reason: SettingsRefusal, detail: string): SettingsOutcome => {
    audit('refuse', `setting ${reason}`)

    return { ok: false, reason, detail }
  }

  const ask = async (door: SettingsSheet, changes: SettingsDiff['changes'], locale: unknown): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const deadline = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), doorTimeoutMs)
      timer.unref?.()
    })

    try {
      return await Promise.race([door({ changes, locale }).then(answer => answer === true), deadline])
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  const change = async (next: unknown, locale?: unknown): Promise<SettingsOutcome> => {
    // Something this build cannot do is refused as asked: no sheet is shown for it, nothing is stored.
    const unavailable = unavailableChoice(next)

    if (unavailable) {
      return refuse('unavailable', unavailable)
    }

    // An allowlist too long, or with an entry that is not an address / origin or is repeated, is refused as asked with
    // the entries named (fix Jm1): no sheet, nothing stored, nothing silently dropped.
    const listProblem = allowlistProblem(next)

    if (listProblem) {
      return refuse('allowlist', listProblem)
    }

    const shown = readSettings(deps.paths)
    const diff = widens(shown, normalizeSettings(next))

    if (diff.widens) {
      if (!deps.door) {
        return refuse('no_door', 'no permission door: a widening change needs the owner’s gesture')
      }

      // What is applied is re-diffed from `next` against `shown` below, never read back from the sheet's list.
      if (!(await ask(deps.door, diff.changes, locale))) {
        return refuse('door_denied', 'the door said no')
      }
    }

    const applied = changeSettings(deps.paths, deps.ledger, shown, next)

    if (!applied.ok) {
      return refuse(applied.code, applied.reason)
    }

    if (applied.diff.changes.length > 0) {
      audit('use', `setting ${applied.diff.changes.map(entry => entry.axis).join(',')}`)
    }

    return applied
  }

  return { change }
}
