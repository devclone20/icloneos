/**
 * V3-J — the on-disk home of payments: `userData/payments/` (0700) with the user's settings, the STOP file, the
 * ledger, the sealed keys and the mandates. This module owns the paths and the two small files; the ledger and the
 * mandates own theirs. Settings are read on every decision (never cached): the pane writes the file, the next payment
 * sees it. A STOP file is the hard stop's durable half — it survives a crash, a downgrade and a settings file the
 * agent could somehow rewrite — and only the owner's gesture removes it.
 */
import fs from 'node:fs'
import path from 'node:path'

import { writeFileAtomicSync } from '../lib/atomic-write'

import type { PaymentLedger } from './ledger'
import {
  allowlistProblem,
  DEFAULTS,
  normalizeSettings,
  type PaymentSettings,
  type SettingsDiff,
  unavailableChoice,
  widens
} from './limits'

const PAYMENTS_DIR = 'payments'
const SETTINGS_FILE = 'settings.json'
const STOP_FILE = 'STOP'
const LEDGER_FILE = 'ledger.jsonl'
const KEYS_DIR = 'keys'
const MANDATES_DIR = 'mandates'

export interface PaymentPaths {
  root: string
  settings: string
  stop: string
  ledger: string
  keys: string
  mandates: string
}

export function paymentPaths(userDataDir: string): PaymentPaths {
  const root = path.join(userDataDir, PAYMENTS_DIR)

  return {
    root,
    settings: path.join(root, SETTINGS_FILE),
    stop: path.join(root, STOP_FILE),
    ledger: path.join(root, LEDGER_FILE),
    keys: path.join(root, KEYS_DIR),
    mandates: path.join(root, MANDATES_DIR)
  }
}

/** The user's settings, normalized; a missing or unreadable file is the defaults. Never throws. */
export function readSettings(paths: PaymentPaths): PaymentSettings {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(paths.settings, 'utf8')))
  } catch {
    return { ...DEFAULTS, payees: [], origins: [] }
  }
}

/** Writes a normalized copy (what was asked for, minus anything malformed) and returns it. */
export function writeSettings(paths: PaymentPaths, settings: unknown): PaymentSettings {
  const normalized = normalizeSettings(settings)

  writeFileAtomicSync(paths.settings, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })

  return normalized
}

/** The ledger note of a settings change: each axis old → new (lists as counts; addresses live in the settings file). */
function describeChanges(diff: SettingsDiff): string {
  return diff.changes
    .map(change => {
      const mark = change.widens ? ' (widens)' : ''

      return change.added || change.removed
        ? `${change.axis} +${change.added?.length ?? 0} -${change.removed?.length ?? 0}${mark}`
        : `${change.axis} ${String(change.from)}→${String(change.to)}${mark}`
    })
    .join('; ')
}

type SettingsChange =
  | { ok: true; settings: PaymentSettings; diff: SettingsDiff }
  | { ok: false; code: 'allowlist' | 'ledger' | 'settings_moved' | 'unavailable'; reason: string }

/** Reason of a compare-and-set miss: the stored settings are no longer the ones the sheet showed. */
const SETTINGS_MOVED = 'the settings changed while the sheet was open: nothing applied, review them again'

/**
 * The one writer the pane uses (D1–D6 are the user's settings): normalize, diff against what is stored, write, and
 * put a `setting` row in the ledger naming each axis old → new. The caller has already passed the door for a
 * widening diff (floor 5, `widens(shown, next).widens`); here a widening change is written to the ledger FIRST and not
 * applied when the ledger cannot take it, while a lowering is applied first and never blocked by the ledger.
 *
 * Compare-and-set (merge round, builder r3 item 3): `shown` is the settings the door sheet diffed against. When what is
 * stored differs from it on ANY axis, nothing is applied — otherwise a stale form would silently undo a change made
 * while the sheet was open (re-raising a cap someone just lowered), a widening no sheet ever showed.
 */
export function changeSettings(
  paths: PaymentPaths,
  ledger: PaymentLedger,
  shown: PaymentSettings,
  next: unknown
): SettingsChange {
  // A choice this build cannot honour is refused as asked, before normalization would quietly turn it into another.
  const unavailable = unavailableChoice(next)

  if (unavailable) {
    return { ok: false, code: 'unavailable', reason: unavailable }
  }

  // The backstop of the settings door's own check (fix Jm1): never store a list it would have to cut or clean.
  const listProblem = allowlistProblem(next)

  if (listProblem) {
    return { ok: false, code: 'allowlist', reason: listProblem }
  }

  const prev = readSettings(paths)

  if (widens(normalizeSettings(shown), prev).changes.length > 0) {
    return { ok: false, code: 'settings_moved', reason: SETTINGS_MOVED }
  }

  const normalized = normalizeSettings(next)
  const diff = widens(prev, normalized)

  if (diff.changes.length === 0) {
    return { ok: true, settings: prev, diff }
  }

  const row = { kind: 'setting' as const, note: describeChanges(diff) }
  // The stop is edge-triggered (client.ts): flipping it here is also a `stop` row, the same as `setStop`.
  const stopFlip = diff.changes.some(change => change.axis === 'stop')
  const stopRow = { kind: 'stop' as const, note: `${normalized.stop ? 'on' : 'off'} (setting)` }

  if (diff.widens) {
    // The stop row first: one that lands without its setting row only refuses what is in flight (conservative).
    if ((stopFlip && !ledger.append(stopRow)) || !ledger.append(row)) {
      return { ok: false, code: 'ledger', reason: 'ledger write failed: a widening change is not applied unrecorded' }
    }

    return { ok: true, settings: writeSettings(paths, normalized), diff }
  }

  const settings = writeSettings(paths, normalized)

  ledger.append(row)

  if (stopFlip) {
    ledger.append(stopRow)
  }

  return { ok: true, settings, diff }
}

export function isStopped(paths: PaymentPaths): boolean {
  try {
    return fs.statSync(paths.stop).isFile()
  } catch {
    return false
  }
}

/**
 * Flips the STOP file and writes a `stop` row, both at the payments ledger's instant. On: anyone may set it (the
 * agent's `x402-pay stop`); the file goes down first and the row never blocks it. Off: the owner's gesture only — the
 * caller proves it — and the row goes down first: a ledger that cannot record the release keeps the stop (false).
 * Every release is a `stop` row, so a payment in flight across a stop is refused by the edge even if its `on` row was
 * lost (client.ts: STOP is edge-triggered).
 */
export function setStop(paths: PaymentPaths, on: boolean, ledger: PaymentLedger): boolean {
  let at: Date | undefined

  try {
    at = ledger.now()
  } catch {
    at = undefined
  }

  const append = (note: string): boolean => {
    try {
      return ledger.append({ kind: 'stop', note }, at) !== null
    } catch {
      return false
    }
  }

  if (on) {
    writeFileAtomicSync(paths.stop, `${(at ?? new Date()).toISOString()}\n`, { mode: 0o600, dirMode: 0o700 })
    append('on')

    return true
  }

  if (!append('off')) {
    return false
  }

  fs.rmSync(paths.stop, { force: true })

  return true
}
