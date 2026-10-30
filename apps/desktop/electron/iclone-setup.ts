/**
 * V3-ON (ruling 44) — the first-launch setup step: what main does for the renderer's "Set up" screen.
 *
 * Three things only, each behind a seam a test can stub:
 *   - the macOS system permissions the app itself uses (ON-1): live status, and ONE fixed action per item — ask macOS
 *     where it lets an app ask (microphone), make the one capture attempt that registers the app where it does not
 *     (screen recording), show the first notification (the only way macOS asks for notifications), or open the exact
 *     Privacy pane. The renderer names an item; main picks the action and the URL. An item already granted is never
 *     asked again (no re-ask, ON-4), and a Privacy switch the user turned OFF is never overridden here.
 *   - (the optional packages' state is V3-RT-B's own API, read by the renderer: src/components/setup/agent-runtime.ts)
 *   - nothing else: the decisions (done / skipped per section) live in consent.json (iclone-consent.ts `setSetup`), and
 *     the agent's levels go through the V3-F setters the Settings pane already uses.
 */
import type { ConsentPermissionKey } from './iclone-consent'
import { type ConsentSenderGuard, guardedHandler } from './iclone-consent'

/** The TCC items the app itself uses and can do something about (ON-1 table, "On screen = YES"). */
export const SETUP_SYSTEM_ITEMS = ['microphone', 'screen', 'notifications'] as const
export type SetupSystemItem = (typeof SETUP_SYSTEM_ITEMS)[number]

/**
 * What macOS says, plus `declined` (the user's own Privacy switch is OFF), `unknown` (no API reads it) and `notSetUp`
 * (screen recording before the app ever made a capture attempt: macOS reports `denied` for that too, r2 M1).
 */
export type SetupSystemStatus =
  'declined' | 'denied' | 'granted' | 'notDetermined' | 'notSetUp' | 'restricted' | 'unknown'

/** The one thing the row's button does: ask macOS, open the pane, or nothing (granted, restricted, declined). */
export type SetupSystemAction = 'none' | 'openSettings' | 'request'

export interface SetupSystemRow {
  id: SetupSystemItem
  status: SetupSystemStatus
  action: SetupSystemAction
  /** Screen recording: macOS applies a new grant only after the app restarts. */
  restartToApply?: true
}

const PRIVACY = 'x-apple.systempreferences:com.apple.preference.security?Privacy'

/** Fixed here: the renderer can never choose what opens. */
export const SETUP_PANES: Readonly<Record<SetupSystemItem, string>> = {
  microphone: `${PRIVACY}_Microphone`,
  screen: `${PRIVACY}_ScreenCapture`,
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications'
}

/** The Privacy switch (consent.json) that governs each item: OFF means the app never asks macOS for it. */
const CONSENT_KEY: Readonly<Record<SetupSystemItem, ConsentPermissionKey>> = {
  microphone: 'microphone',
  screen: 'screen',
  notifications: 'notifications'
}

export interface SetupSystemSeam {
  platform: NodeJS.Platform
  /** `systemPreferences.getMediaAccessStatus` */
  mediaStatus: (kind: 'microphone' | 'screen') => string
  /** The app's microphone request (window-ipc.ts requestMicrophoneAccess, the voice-input site). */
  askMicrophone: () => Promise<boolean>
  /** One capture attempt that registers the app under Screen Recording and lets macOS ask (0-px thumbnails). */
  attemptScreenCapture: () => Promise<void>
  /**
   * r2 M1 — whether this install ever made that capture attempt (consent.json `screenCaptureAttemptedAt`). On macOS
   * `getMediaAccessStatus('screen')` is a boolean preflight: it answers only `granted` or `denied`, never
   * `not-determined`, so `denied` alone cannot tell "never asked" (the app is not even in the pane's list) from "refused".
   */
  screenAttempted: () => boolean
  /** Records the attempt (before it is made, so a capture that throws still counts). */
  markScreenAttempted: () => void
  /** Shows one notification (the first one is what makes macOS ask). False when notifications are unsupported. */
  showNotification: (title: string, body: string) => boolean
  openExternal: (url: string) => Promise<void> | void
  consentAllows: (key: ConsentPermissionKey) => boolean
}

const MAC_STATUS: Readonly<Record<string, SetupSystemStatus>> = {
  granted: 'granted',
  denied: 'denied',
  restricted: 'restricted',
  'not-determined': 'notDetermined'
}

/** Per main run: an item whose request was already made answers "open the pane" next (never a second request). */
export interface SetupAttempts {
  has: (item: SetupSystemItem) => boolean
  add: (item: SetupSystemItem) => void
}

export const createSetupAttempts = (): SetupAttempts => {
  const made = new Set<SetupSystemItem>()

  return { has: item => made.has(item), add: item => void made.add(item) }
}

function statusOf(seam: SetupSystemSeam, item: SetupSystemItem): SetupSystemStatus {
  if (!seam.consentAllows(CONSENT_KEY[item])) {
    return 'declined'
  }

  if (item === 'notifications') {
    return 'unknown'
  }

  let status: SetupSystemStatus

  try {
    status = MAC_STATUS[seam.mediaStatus(item)] ?? 'unknown'
  } catch {
    status = 'unknown'
  }

  // Screen recording: anything but granted / restricted is "not set up" until the one capture attempt was made.
  if (item === 'screen' && status !== 'granted' && status !== 'restricted') {
    return seam.screenAttempted() ? 'denied' : 'notSetUp'
  }

  return status
}

/** Pure: the button for a status. Granted, restricted (managed Mac) and declined (OFF in Privacy) offer nothing. */
export function setupSystemAction(
  item: SetupSystemItem,
  status: SetupSystemStatus,
  attempted: boolean
): SetupSystemAction {
  if (status === 'granted' || status === 'restricted' || status === 'declined') {
    return 'none'
  }

  if (status === 'denied') {
    return 'openSettings'
  }

  // Screen recording never attempted: the one capture attempt that lists the app and lets macOS ask.
  if (status === 'notSetUp') {
    return 'request'
  }

  // notDetermined (or, for notifications, unknown): one request per run, then the pane.
  if (status === 'notDetermined' || (item === 'notifications' && status === 'unknown')) {
    return attempted ? 'openSettings' : 'request'
  }

  // unknown media status: never guess a request.
  return 'openSettings'
}

/** Every row, in display order. Off macOS there is nothing to set up: an empty list hides the section. */
export function setupSystemRows(seam: SetupSystemSeam, attempts: SetupAttempts): SetupSystemRow[] {
  if (seam.platform !== 'darwin') {
    return []
  }

  return SETUP_SYSTEM_ITEMS.map(id => {
    const status = statusOf(seam, id)
    const row: SetupSystemRow = { id, status, action: setupSystemAction(id, status, attempts.has(id)) }

    return id === 'screen' && (status === 'notSetUp' || status === 'denied') ? { ...row, restartToApply: true } : row
  })
}

const isItem = (value: unknown): value is SetupSystemItem =>
  typeof value === 'string' && (SETUP_SYSTEM_ITEMS as readonly string[]).includes(value)

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')

/**
 * The row's one action, decided HERE from the live status (never from the renderer): request, open the fixed pane, or
 * nothing. Returns the rows as they stand afterwards.
 */
export async function actOnSetupSystemItem(
  seam: SetupSystemSeam,
  attempts: SetupAttempts,
  input: unknown
): Promise<SetupSystemRow[]> {
  const raw = (input ?? {}) as { item?: unknown; title?: unknown; body?: unknown }

  if (seam.platform !== 'darwin' || !isItem(raw.item)) {
    return setupSystemRows(seam, attempts)
  }

  const item = raw.item
  const action = setupSystemAction(item, statusOf(seam, item), attempts.has(item))

  try {
    if (action === 'openSettings') {
      await seam.openExternal(SETUP_PANES[item])
    } else if (action === 'request') {
      attempts.add(item)

      if (item === 'microphone') {
        await seam.askMicrophone()
      } else if (item === 'screen') {
        seam.markScreenAttempted()
        await seam.attemptScreenCapture()
      } else {
        seam.showNotification(text(raw.title, 80), text(raw.body, 200))
      }
    }
  } catch {
    // A refused request is a status, not an error: the rows below say where things stand.
  }

  return setupSystemRows(seam, attempts)
}

/**
 * ON-4 — the app's one microphone request (window-ipc.ts requestMicrophoneAccess: voice input and the Set up row).
 * Privacy switch OFF: declined, macOS never asked. Already granted: true without calling macOS (no re-ask after Set
 * up). Not decided yet (Skip): macOS asks, exactly as before V3-ON.
 */
export async function microphoneAccess(deps: {
  consentOn: boolean
  mac: boolean
  status: () => string
  ask: () => Promise<boolean>
}): Promise<boolean> {
  if (!deps.consentOn) {
    return false
  }

  if (!deps.mac) {
    return true
  }

  try {
    if (deps.status() === 'granted') {
      return true
    }
  } catch {
    // An unreadable status asks, as before.
  }

  return deps.ask()
}

// ── IPC ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

interface SetupDeps {
  ipcMain: IpcMainLike
  isTrustedSender: ConsentSenderGuard
  system: SetupSystemSeam
}

/** `iclone:setup:*` — only the app's own renderer (the consent sender guard, fail closed). */
export function registerIcloneSetup(deps: SetupDeps): void {
  const ipcMain = guardedHandler(deps.ipcMain, deps.isTrustedSender)
  const attempts = createSetupAttempts()

  ipcMain.handle('iclone:setup:system', () => setupSystemRows(deps.system, attempts))
  ipcMain.handle('iclone:setup:system-act', (_event, input) => actOnSetupSystemItem(deps.system, attempts, input))
}
