/**
 * First-launch consent: the policy acceptance and the device-permission intents (`<userData>/consent.json`).
 *
 * Main owns the record; the renderer only asks through `iclone:consent:*`. A permission switch records an
 * INTENT — nothing here ever asks macOS for anything. Undecided (absent key, or "Skip for now") means the
 * system prompt decides when a feature needs it (policy §9); only an explicit OFF declines. Web sessions are stricter:
 * a page gets a permission only when its switch is explicitly ON (decideWebPermission).
 */
import { existsSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'

import {
  isIsoDateTime,
  SETUP_SECTIONS,
  type SetupChoice,
  type SetupDecisions,
  setupDecisions
} from '../src/iclone-shared/setup-decisions'
import { compareVersions } from '../src/iclone-shared/version'

import { readJsonValidated } from './iclone-acp-store'
import type { IpcSenderEventLike } from './ipc-sender-guard'
import { writeFileAtomicSync } from './lib/atomic-write'
import { BUNDLED_POLICY } from './policy-version.generated'

export const CONSENT_FILE = 'consent.json'
export const POLICY_HTML = 'icloneos-privacy.html'

/** What the agent may do on this Mac (honoured by the agent runtime through `ICLONE_CONSENT_<KEY>`). */
export const CONSENT_CAPABILITY_KEYS = [
  'terminal',
  'fileWriting',
  'webBrowsing',
  'automation',
  'screen',
  'clipboard',
  'installSoftware',
  'scheduledTasks',
  'sendMessages',
  'spendTrade'
] as const

/** What the app itself uses (system prompt only when a feature needs it). */
export const CONSENT_DEVICE_KEYS = ['microphone', 'notifications', 'keychain'] as const

/** Every switch, capabilities first (the order the sheet shows). */
export const CONSENT_PERMISSION_KEYS = [
  'terminal',
  'fileWriting',
  'webBrowsing',
  'automation',
  'screen',
  'clipboard',
  'installSoftware',
  'scheduledTasks',
  'sendMessages',
  'spendTrade',
  'microphone',
  'notifications',
  'keychain'
] as const

export type ConsentPermissionKey = (typeof CONSENT_PERMISSION_KEYS)[number]
type ConsentPermissions = Partial<Record<ConsentPermissionKey, boolean>>

export interface ConsentRecord {
  schema: 1
  policyVersion: string
  policyEffective: string
  acceptedAt: string
  permissions: ConsentPermissions
  permissionsDecidedAt: string | null
  skipped: boolean
  aiProviderConsent: { accepted: boolean; at: string } | null
  /** V3-ON (ruling 44): the first-launch Set up step, per section. Absent = never decided (shown once). */
  setup?: SetupDecisions
  /** V3-ON r2 M1: when the app made its one Screen Recording capture attempt (absent = never). */
  screenCaptureAttemptedAt?: string
}

/** V3-ON — the Set up decisions' one validator, shared with the window (r2 minor 4). */
export { SETUP_SECTIONS, setupDecisions, type SetupSection } from '../src/iclone-shared/setup-decisions'

/** `required` = never accepted (both steps); `update` = accepted an older policy (step 1 only); `ok` = nothing to show. */
type ConsentState = 'ok' | 'required' | 'update'

interface PolicyBlock {
  id?: string
  kind: 'heading' | 'item' | 'meta' | 'paragraph' | 'row' | 'title'
  text: string
}

export const SCREEN_DECLINED_NOTE =
  'Window titles are off: Screen recording is switched off in icloneOS Settings › Privacy.'

/** ISO-8601 date-time as `toISOString()` writes it (the shared rule, src/iclone-shared/setup-decisions.ts). */
export const isIso = isIsoDateTime

function isPermissions(value: unknown): value is ConsentPermissions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  // Unknown keys (a newer build's permissions) are ignored so its record survives a downgrade; known keys must be booleans.
  return CONSENT_PERMISSION_KEYS.every(key => {
    const on = Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined

    return on === undefined || typeof on === 'boolean'
  })
}

export function isConsentRecord(value: unknown): value is ConsentRecord {
  if (!value || typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>
  const ai = record.aiProviderConsent as Record<string, unknown> | null | undefined

  return (
    record.schema === 1 &&
    typeof record.policyVersion === 'string' &&
    /^\d+(\.\d+)*$/.test(record.policyVersion) &&
    typeof record.policyEffective === 'string' &&
    isIso(record.acceptedAt) &&
    isPermissions(record.permissions) &&
    (record.permissionsDecidedAt === null || isIso(record.permissionsDecidedAt)) &&
    typeof record.skipped === 'boolean' &&
    (ai === null || (!!ai && typeof ai === 'object' && typeof ai.accepted === 'boolean' && isIso(ai.at)))
  )
}

export function consentState(
  record: ConsentRecord | null,
  bundledVersion: string = BUNDLED_POLICY.version
): ConsentState {
  if (!record) {
    return 'required'
  }

  return compareVersions(record.policyVersion, bundledVersion) < 0 ? 'update' : 'ok'
}

/**
 * Only an explicit OFF declines; undecided keys leave the decision to the system prompt.
 * @public used by RESUME/run/gates/R10/extra/2026-10-17_r4_web_undecided.mjs
 */
export function permissionAllowed(record: ConsentRecord | null, key: ConsentPermissionKey): boolean {
  return record?.permissions[key] !== false
}

/** True when a media permission request/check asks for the microphone (audio) — the one capture the app makes. */
export function mediaWantsAudio(permission: string, details?: unknown): boolean {
  if (permission === 'audioCapture') {
    return true
  }

  if (permission !== 'media') {
    return false
  }

  // Requests carry `mediaTypes`, checks a single `mediaType`; none / empty / 'unknown' is audio by construction here.
  const media = typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {}

  const types: unknown[] = Array.isArray(media.mediaTypes)
    ? media.mediaTypes
    : typeof media.mediaType === 'string' && media.mediaType !== 'unknown'
      ? [media.mediaType]
      : []

  return types.length === 0 || types.includes('audio')
}

/** Session-handler decision: the microphone switch OFF refuses audio before macOS is ever asked. */
export function mediaDeclinedByConsent(microphoneAllowed: boolean, permission: string, details?: unknown): boolean {
  return !microphoneAllowed && mediaWantsAudio(permission, details)
}

/** FX-4: where the consent record lives, for the agent runtime's microphone gate (plugins/iclone-consent/micgate.py). */
export const CONSENT_RECORD_ENV = 'ICLONE_CONSENT_RECORD'

const envName = (key: ConsentPermissionKey) => `ICLONE_CONSENT_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`

/**
 * `ICLONE_CONSENT_<KEY>` for every permission, for the agent runtime and its skills to honour: `1` on, `0` off, `ask` =
 * undecided (the agent asks through `acp consent request` before using it).
 */
export function consentEnvFor(record: ConsentRecord | null): Record<string, string> {
  const env: Record<string, string> = {}

  for (const key of CONSENT_PERMISSION_KEYS) {
    const on = record?.permissions[key]

    env[envName(key)] = on === true ? '1' : on === false ? '0' : 'ask'
  }

  return env
}

function sanitizePermissions(input: unknown): ConsentPermissions {
  const out: ConsentPermissions = {}

  if (!input || typeof input !== 'object') {
    return out
  }

  for (const key of CONSENT_PERMISSION_KEYS) {
    const on = (input as Record<string, unknown>)[key]

    if (typeof on === 'boolean') {
      out[key] = on
    }
  }

  return out
}

type ConsentResult = { ok: true; record: ConsentRecord } | { ok: false; error: string }

export function createConsentStore(file: string, now: () => Date = () => new Date()) {
  let cached: ConsentRecord | null | undefined

  const write = (record: ConsentRecord): ConsentResult => {
    writeFileAtomicSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    cached = record

    return { ok: true, record }
  }

  const read = (): ConsentRecord | null => {
    if (cached !== undefined) {
      return cached
    }

    const record = readJsonValidated(file, isConsentRecord)

    if (!record && existsSync(file)) {
      // Invalid = never accepted: keep the bad bytes for diagnosis and ask again.
      try {
        renameSync(file, `${file}.bad`)
      } catch {
        // Unreadable AND unrenamable: the sheet still shows, which is the safe side.
      }
    }

    cached = record

    return record
  }

  const update = (change: (record: ConsentRecord) => ConsentRecord): ConsentResult => {
    const record = read()

    return record ? write(change(record)) : { ok: false, error: 'The policy has not been accepted yet.' }
  }

  return {
    read,
    state: () => consentState(read()),
    allows: (key: ConsentPermissionKey) => permissionAllowed(read(), key),
    // FX-4: the record's path too, so Hermes' own microphone capture follows the switch live (plugins/iclone-consent
    // reads it on every open and pops it at import: no child of Hermes inherits it).
    env: () => ({ ...consentEnvFor(read()), [CONSENT_RECORD_ENV]: file }),
    // `aiProvider` is accepted for the renderer's shape but never read: the required box includes the disclosure.
    accept(input: { aiProvider?: unknown; version?: unknown }): ConsentResult {
      if (input?.version !== BUNDLED_POLICY.version) {
        return { ok: false, error: `Only the bundled policy v${BUNDLED_POLICY.version} can be accepted.` }
      }

      const previous = read()
      const at = now().toISOString()

      return write({
        schema: 1,
        policyVersion: BUNDLED_POLICY.version,
        policyEffective: BUNDLED_POLICY.effective,
        acceptedAt: at,
        // A re-acceptance after a policy update keeps every saved switch.
        permissions: previous?.permissions ?? {},
        permissionsDecidedAt: previous?.permissionsDecidedAt ?? null,
        skipped: previous?.skipped ?? false,
        // The one required box includes sending to the provider the user connects (policy §5), so accepting records it.
        aiProviderConsent: { accepted: true, at },
        // V3-ON: a re-acceptance keeps the Set up decisions too (the user is never asked them again for a new policy).
        ...(previous && Object.keys(setupDecisions(previous)).length > 0 ? { setup: setupDecisions(previous) } : {}),
        ...(previous && isIso(previous.screenCaptureAttemptedAt)
          ? { screenCaptureAttemptedAt: previous.screenCaptureAttemptedAt }
          : {})
      })
    },
    setPermissions(raw: unknown): ConsentResult {
      const input = (raw ?? {}) as { permissions?: unknown; skipped?: unknown }
      const skipped = input.skipped === true

      return update(record => ({
        ...record,
        permissions: skipped ? {} : sanitizePermissions(input?.permissions),
        permissionsDecidedAt: skipped ? null : now().toISOString(),
        skipped
      }))
    },
    /**
     * V3-ON — "Done" / "Skip" / "Skip all" on the Set up step: `{ sections: { packages: 'done', system: 'skipped' } }`.
     * Only the named sections change; every other decision is kept. Nothing else in the record moves.
     */
    setSetup(raw: unknown): ConsentResult {
      const sections = (raw as { sections?: unknown } | null)?.sections

      if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
        return { ok: false, error: 'Nothing to record.' }
      }

      const chosen = SETUP_SECTIONS.filter(section => {
        const value = Object.hasOwn(sections, section) ? (sections as Record<string, unknown>)[section] : undefined

        return value === 'done' || value === 'skipped'
      })

      if (chosen.length === 0) {
        return { ok: false, error: 'Nothing to record.' }
      }

      const at = now().toISOString()

      // r2 M2: Set up is optional — a write that fails (disk full, read-only userData) is an answer, never a throw.
      try {
        return update(record => {
          const next = { ...setupDecisions(record) }

          for (const section of chosen) {
            next[section] = { state: (sections as Record<string, SetupChoice>)[section], at }
          }

          return { ...record, setup: next }
        })
      } catch (error) {
        return {
          ok: false,
          error: `Your Set up choices could not be saved: ${String((error as Error)?.message ?? error)}`
        }
      }
    },
    /** r2 M1: has this install made its one Screen Recording capture attempt? */
    screenCaptureAttempted(): boolean {
      return isIso(read()?.screenCaptureAttemptedAt)
    },
    /** r2 M1: record the attempt once (a later call keeps the first time). No record yet: nothing to write. */
    markScreenCaptureAttempt(): ConsentResult {
      return update(record =>
        isIso(record.screenCaptureAttemptedAt) ? record : { ...record, screenCaptureAttemptedAt: now().toISOString() }
      )
    },
    setAiProvider(input: { accepted?: unknown }): ConsentResult {
      return update(record => ({
        ...record,
        aiProviderConsent: { accepted: input?.accepted === true, at: now().toISOString() }
      }))
    },
    /** "Allow always" from the consent door: the one key ON, every other saved choice kept. */
    allowAlways(key: ConsentPermissionKey): ConsentResult {
      return update(record => ({
        ...record,
        permissions: { ...record.permissions, [key]: true },
        permissionsDecidedAt: record.permissionsDecidedAt ?? now().toISOString(),
        skipped: false
      }))
    },
    /** Mirrors a setting whose single source lives elsewhere (Keychain = the gateway encryption toggle). */
    note(key: ConsentPermissionKey, on: boolean): void {
      const record = read()

      if (record && record.permissionsDecidedAt !== null && record.permissions[key] !== on) {
        write({ ...record, permissions: { ...record.permissions, [key]: on } })
      }
    },
    reset(): void {
      cached = undefined
    }
  }
}

export type ConsentStore = ReturnType<typeof createConsentStore>

const ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  middot: '·',
  nbsp: ' ',
  quot: '"',
  rsaquo: '›'
}

export function decodePolicyText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith('#')) {
        const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)

        return Number.isFinite(code) ? String.fromCodePoint(code) : whole
      }

      return ENTITIES[name.toLowerCase()] ?? whole
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The bundled policy as plain-text blocks for the offline reader. Text only — the renderer never receives
 * markup, so nothing from the file can execute or style itself in the app.
 */
export function policyBlocks(html: string): PolicyBlock[] {
  const blocks: PolicyBlock[] = []

  for (const match of html.matchAll(/<(h1|h2|p|li|tr)(\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
    const [, tag, attrs = '', inner] = match
    const id = /\bid="(pp-[a-z]+)"/.exec(attrs)?.[1]

    const text =
      tag === 'tr'
        ? [...inner.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(cell => decodePolicyText(cell[1])).join(' — ')
        : decodePolicyText(inner)

    if (!text) {
      continue
    }

    const kind: PolicyBlock['kind'] =
      tag === 'h1'
        ? 'title'
        : tag === 'h2'
          ? 'heading'
          : tag === 'li'
            ? 'item'
            : tag === 'tr'
              ? 'row'
              : /class="p-meta"/.test(attrs)
                ? 'meta'
                : 'paragraph'

    blocks.push(id ? { id, kind, text } : { kind, text })
  }

  return blocks
}

/** Packaged: `<resources>/legal`; dev: the repo's `iclone/legal` (both produced by scripts/sync-legal.mjs). */
export function bundledLegalDir(options: { appPath: string; packaged: boolean; resourcesPath: string }): string {
  return options.packaged
    ? path.join(options.resourcesPath, 'legal')
    : path.resolve(options.appPath, '..', '..', 'iclone', 'legal')
}

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

/** The P7 seam (createAppSenderGuard): only the app's own renderer may use the consent channels. */
export type ConsentSenderGuard = (event: IpcSenderEventLike, channel: string) => boolean

/**
 * `ipcMain.handle` that answers null to any sender the guard refuses. The guard is required: a caller that has none
 * gets every call refused, never every call allowed (L9 — fail closed).
 */
export function guardedHandler(ipcMain: IpcMainLike, isTrustedSender: ConsentSenderGuard | undefined): IpcMainLike {
  return {
    handle: (channel, listener) =>
      ipcMain.handle(channel, (event, ...args) =>
        typeof isTrustedSender === 'function' && isTrustedSender(event as IpcSenderEventLike, channel) === true
          ? listener(event, ...args)
          : null
      )
  }
}

type PermissionsChangedListener = (changed: ConsentPermissionKey[]) => void

const permissionsChangedListeners = new Set<PermissionsChangedListener>()

/** Called with the keys whose switch the user changed (Settings › Privacy or the first-launch step). */
export function onConsentPermissionsChanged(listener: PermissionsChangedListener): () => void {
  permissionsChangedListeners.add(listener)

  return () => permissionsChangedListeners.delete(listener)
}

function changedKeys(before: ConsentPermissions, after: ConsentPermissions): ConsentPermissionKey[] {
  return CONSENT_PERMISSION_KEYS.filter(key => before[key] !== after[key])
}

interface ConsentDeps {
  ipcMain: IpcMainLike
  isTrustedSender: ConsentSenderGuard
  keychainEncrypted: () => boolean
  legalDir: string
  openExternal: (url: string) => Promise<void> | void
  quit: () => void
  userDataDir: string
}

let active: ConsentStore | null = null

/** Main-process gate. Before registration nothing is decided, so nothing is declined. */
export function consentAllows(key: ConsentPermissionKey): boolean {
  return active ? active.allows(key) : true
}

export function consentEnv(): Record<string, string> {
  return active ? active.env() : {}
}

export function noteConsentPermission(key: ConsentPermissionKey, on: boolean): void {
  try {
    active?.note(key, on)
  } catch {
    // A mirror write must never break the setting it mirrors.
  }
}

type PermissionRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: unknown
) => void

type PermissionCheckHandler = (webContents: unknown, permission: string, origin: string, details: unknown) => boolean

export interface PermissionSessionLike {
  setPermissionCheckHandler(handler: PermissionCheckHandler | null): void
  setPermissionRequestHandler(handler: PermissionRequestHandler | null): void
}

/** Web permissions a page may get, each tied to the consent switch that allows it. */
const WEB_PERMISSION_KEYS: Record<string, ConsentPermissionKey> = {
  'clipboard-read': 'clipboard',
  'clipboard-sanitized-write': 'clipboard',
  'display-capture': 'screen',
  notifications: 'notifications'
}

/** The stored switches, or null before the policy is accepted (and before registration). */
function consentPermissions(): ConsentPermissions | null {
  return active?.read()?.permissions ?? null
}

/**
 * Deny by default for a page in a web session: a mapped permission is granted only when its switch is explicitly ON
 * (undecided and no record are a No — Electron shows no system prompt for these). Audio ↔ Microphone, notifications ↔
 * Notifications, clipboard ↔ Clipboard, display capture ↔ Screen recording, fullscreen always; video (camera),
 * geolocation, MIDI, USB, HID, serial, Bluetooth, idle detection, pointer lock and every other permission are refused
 * (policy §9: no camera, location or contacts).
 */
export function decideWebPermission(
  permission: string,
  details: unknown,
  permissions: ConsentPermissions | null = consentPermissions()
): boolean {
  if (permission === 'fullscreen') {
    return true
  }

  const on = (key: ConsentPermissionKey) =>
    !!permissions && Object.hasOwn(permissions, key) && permissions[key] === true

  if (permission === 'media' || permission === 'audioCapture') {
    return mediaWantsAudio(permission, details) && !mediaWantsVideo(details) && on('microphone')
  }

  const key = Object.hasOwn(WEB_PERMISSION_KEYS, permission) ? WEB_PERMISSION_KEYS[permission] : undefined

  return key ? on(key) : false
}

function mediaWantsVideo(details: unknown): boolean {
  const media = typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {}

  return (Array.isArray(media.mediaTypes) && media.mediaTypes.includes('video')) || media.mediaType === 'video'
}

/** Handlers for a session that hosts web pages (preview webview, OAuth login, embeds): {@link decideWebPermission}. */
export function installConsentPermissionHandlers(sess: PermissionSessionLike): void {
  // Deny by default, stricter than consentAllows (undecided allows there): a page needs the switch explicitly ON, and
  // video (camera), geolocation and every unmapped permission are refused by decideWebPermission.
  sess.setPermissionRequestHandler((_webContents, permission, callback, details) =>
    callback(decideWebPermission(permission, details, consentPermissions()))
  )
  sess.setPermissionCheckHandler((_webContents, permission, _origin, details) =>
    decideWebPermission(permission, details, consentPermissions())
  )
}

interface SessionEventsLike {
  on(event: 'session-created', listener: (sess: PermissionSessionLike) => void): unknown
}

/**
 * Every session Electron creates gets the consent handlers. Owners that set their own afterwards keep theirs: the default
 * session (installMediaPermissions) and Privy (deny-all).
 */
export function gateWebSessionsByConsent(app: SessionEventsLike): void {
  app.on('session-created', sess => installConsentPermissionHandlers(sess))
}

/** A window-below answer with the titles withheld because the user switched Screen recording off. */
export function withScreenDeclined<T>(result: T): T {
  if (result && typeof result === 'object' && !('error' in result)) {
    return { ...result, note: SCREEN_DECLINED_NOTE }
  }

  return result
}

/** A permissions save with `keychain` replaced by the real encryption state; Skip and malformed input pass through. */
export function withRealKeychain(input: unknown, keychainEncrypted: boolean): unknown {
  if (!input || typeof input !== 'object') {
    return input
  }

  const { permissions, skipped } = input as { permissions?: unknown; skipped?: unknown }

  if (skipped === true || !permissions || typeof permissions !== 'object') {
    return input
  }

  return { ...input, permissions: { ...permissions, keychain: keychainEncrypted } }
}

export function registerIcloneConsent(deps: ConsentDeps): ConsentStore {
  const store = createConsentStore(path.join(deps.userDataDir, CONSENT_FILE))
  const { short, permissions, permissionsIntro, ...meta } = BUNDLED_POLICY

  const ipcMain = guardedHandler(deps.ipcMain, deps.isTrustedSender)

  active = store

  ipcMain.handle('iclone:consent:get', () => ({
    state: store.state(),
    record: store.read(),
    bundled: { ...meta, short, permissions, permissionsIntro },
    keychainEncrypted: deps.keychainEncrypted()
  }))

  ipcMain.handle('iclone:consent:policy-text', () => {
    try {
      return policyBlocks(readFileSync(path.join(deps.legalDir, POLICY_HTML), 'utf8'))
    } catch {
      return null
    }
  })

  ipcMain.handle('iclone:consent:accept', (_event, input) => store.accept(input))
  // Keychain is recorded as the real encryption state (Settings › Gateway is its single source), never as a wish.
  ipcMain.handle('iclone:consent:permissions', (_event, input) => {
    const before = store.read()?.permissions ?? {}
    const result = store.setPermissions(withRealKeychain(input, deps.keychainEncrypted()))
    const changed = result.ok ? changedKeys(before, result.record.permissions) : []

    if (changed.length > 0) {
      for (const listener of permissionsChangedListeners) {
        listener(changed)
      }
    }

    return result
  })
  ipcMain.handle('iclone:consent:ai-provider', (_event, input) => store.setAiProvider(input))
  // V3-ON: the Set up step's per-section decisions (the same record: no second store).
  ipcMain.handle('iclone:consent:setup', (_event, input) => store.setSetup(input))
  // The URL is fixed here; the renderer cannot choose what opens.
  ipcMain.handle('iclone:consent:open-policy', async () => {
    await deps.openExternal(BUNDLED_POLICY.url)

    return true
  })
  ipcMain.handle('iclone:consent:quit', () => {
    deps.quit()

    return true
  })

  return store
}

/** Test seam: forget the registered store. */
export function resetConsentForTests(): void {
  active = null
}
