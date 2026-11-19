import { atom, computed } from 'nanostores'

import { translateNow } from '@/i18n'

/**
 * v0.0.9 F4 — the one notification store (P0_DESIGN_SPECS §F4, P0_NOTIFICATIONS §2).
 *
 * Two lists live here:
 *   - `$notifications`: the toasts on screen (type 1), newest first, at most TOAST_STACK_CAP. A toast pushed past the cap
 *     leaves the stack through the same door as a dismissal (its timer is cleared and its `onDismiss` runs) and is
 *     counted in `$toastOverflow` ("+N in Notifications").
 *   - `$notificationHistory`: the notification centre (type 5), newest first, at most HISTORY_CAP entries. Every toast
 *     lands here and stays after it leaves the screen, after the cap evicts it and after `clearNotifications()`.
 *
 * Timing (gate N5): a timed toast stays `max(4 s, 2 s + 1 s per 15 characters)`, at least 10 s when it carries an action;
 * a caller's `durationMs` can lengthen that or make it sticky (`0`), never shorten it. Errors stay until closed. Hover or
 * focus pauses the countdown (`pauseNotification` / `resumeNotification`).
 */

export type NotificationKind = 'error' | 'warning' | 'info' | 'success'

interface NotificationAction {
  label: string
  onClick: () => void
}

/** Kept on the input for old callers; the stack has one place now (bottom right), so it is ignored. */
type NotificationPlacement = 'default' | 'bottom-right'

export interface AppNotification {
  id: string
  kind: NotificationKind
  /** When set, renders this codicon instead of the default kind icon. */
  icon?: string
  /** A severity ramp colour from the caller (usage bands). Tints the icon and the side bar only — never text (AA). */
  accentColor?: string
  /** Secondary detail line rendered below the message, muted (e.g. "$220.00 cap"). */
  meta?: string
  /** What happened. */
  title?: string
  /** Why, in plain words. */
  message: string
  /** The raw text (an error, a path), copyable in the centre. */
  detail?: string
  /** What to do next, when the caller knows. */
  nextStep?: string
  /** Outlives clearNotifications: for a reason the reconnect's own transcript reload must not wipe. */
  survivesClear?: boolean
  action?: NotificationAction
  onDismiss?: () => void
  createdAt: number
  /** The effective on-screen time in ms after the reading-time rule; 0 = stays until closed. */
  durationMs: number
  placement?: NotificationPlacement
}

export interface NotificationInput {
  id?: string
  kind?: NotificationKind
  icon?: string
  accentColor?: string
  meta?: string
  title?: string
  message: string
  detail?: string
  nextStep?: string
  /** Outlives clearNotifications: for a reason the reconnect's own transcript reload must not wipe. */
  survivesClear?: boolean
  action?: NotificationAction
  onDismiss?: () => void
  /** A floor raise or `0` (sticky). Never shortens the reading time. */
  durationMs?: number
  placement?: NotificationPlacement
}

/** One entry of the notification centre. */
export interface NotificationRecord {
  id: string
  kind: NotificationKind
  title?: string
  message: string
  detail?: string
  meta?: string
  nextStep?: string
  action?: NotificationAction
  createdAt: number
  read: boolean
  /** Where it came from: an in-app toast, a native OS notification mirrored here, or a status banner. */
  source: 'banner' | 'native' | 'toast'
  /** r4d (design r4 F4-1): how many identical plain notices this entry stands for (merged within MERGE_WINDOW_MS). */
  count?: number
}

/** r4d (design r4 F4-1): identical plain info/success notices within this window are one entry, "×N". */
export const MERGE_WINDOW_MS = 10 * 60_000

export const TOAST_STACK_CAP = 3
export const HISTORY_CAP = 200
export const TOAST_MIN_MS = 4_000
export const TOAST_ACTION_MIN_MS = 10_000
/** After a pause, a toast never vanishes the instant the pointer leaves it. */
const RESUME_FLOOR_MS = 1_000

/** The reading time for a piece of text: max(4 s, 2 s + 1 s per 15 characters). */
export function readingTimeMs(text: string): number {
  return Math.max(TOAST_MIN_MS, Math.ceil(2_000 + (1_000 * text.length) / 15))
}

/** The on-screen time a toast gets (0 = until closed). Pure; the gate N5 tests read it. */
export function toastDurationMs(input: {
  action?: unknown
  durationMs?: number
  kind: NotificationKind
  message: string
  meta?: string
  title?: string
}): number {
  if (input.kind === 'error' || input.durationMs === 0) {
    return 0
  }

  const text = [input.title, input.message, input.meta].filter(Boolean).join(' ')
  const floor = Math.max(readingTimeMs(text), input.action ? TOAST_ACTION_MIN_MS : 0)

  return Math.max(floor, input.durationMs ?? 0)
}

interface ToastTimer {
  handle: number | undefined
  deadline: number
  remaining: number
  paused: boolean
}

let notificationCounter = 0
const timers = new Map<string, ToastTimer>()
// Toasts the pointer or the focus is on right now (pause without a resume yet), timed or not: a same-id update
// replaces the entry under a pointer that never left, so no new mouseenter tells the new countdown to wait.
const held = new Set<string>()

/**
 * v0.0.9 r4d (eng r4-M1, r4-m1): toasts an open centre PARKED, by id. Opening the centre takes the toasts off the
 * screen (their entries are already in the centre) and a notification raised while it is open goes there only; neither
 * is a dismissal. A parked toast keeps its `onDismiss` and runs it at most once, and only on a real end:
 *   - the caller dismisses it (`dismissNotification`, e.g. a confirm that settled);
 *   - its entry leaves the centre (removed, cleared, aged out of HISTORY_CAP) without its action having been used;
 *   - a reconnect clears it (`clearNotifications`), unless it `survivesClear`.
 * Closing the centre puts the sticky ones (`durationMs` 0 or `survivesClear`) back on screen; the timed ones stay
 * parked as entry-bound (their reading time is over, their callback still owed).
 */
const parked = new Map<string, AppNotification>()
/** Parked ids whose action was used from the centre: their entry may leave without an `onDismiss`. */
const actionUsed = new Set<string>()

// r5 (eng r5-m1): sticky = no timer of its own (durationMs 0). `survivesClear` is about a reconnect's clear, not about
// how long a toast stays: a timed native info/success (survivesClear, default duration) restored after a close came
// back with no timer and never left the screen. Timed ones stay parked as entry-bound.
const isSticky = (item: AppNotification) => item.durationMs === 0

/** A parked toast ends: it leaves the map first (so its callback can run only once), then the callback runs if owed. */
function endParked(id: string, runDismiss: boolean) {
  const item = parked.get(id)

  if (!item) {
    return
  }

  parked.delete(id)

  const used = actionUsed.delete(id)

  if (runDismiss && !used) {
    item.onDismiss?.()
  }
}

/** Entries that left the centre: a parked toast among them ends (its callback runs unless its action was used). */
function entriesGone(ids: Iterable<string>) {
  for (const id of ids) {
    endParked(id, true)
  }
}

/** The centre's own action button: marks the use (a parked toast then owes no dismissal), then runs the action. */
export function runNotificationAction(id: string) {
  const entry = $notificationHistory.get().find(record => record.id === id)

  if (!entry?.action) {
    return
  }

  if (parked.has(id)) {
    actionUsed.add(id)
  }

  entry.action.onClick()
}

/** Test seam. */
export function parkedNotificationIds(): string[] {
  return [...parked.keys()]
}

export const $notifications = atom<AppNotification[]>([])
export const $notificationHistory = atom<NotificationRecord[]>([])
/** Toasts the cap pushed off the stack since the centre was last opened, while the stack stays full ("+N"). */
export const $toastOverflow = atom(0)
export const $notificationCentre = atom<{ focusId: null | string; open: boolean }>({ focusId: null, open: false })
export const $unreadNotifications = computed($notificationHistory, history => history.filter(r => !r.read).length)

function cleanErrorText(value: string) {
  return value.replace(/^Error:\s*/, '').trim()
}

/** True when an error string is a disk-full / ENOSPC / SQLITE_FULL failure. */
export function isDiskFullErrorMessage(message: string): boolean {
  return (
    /no space left on device/i.test(message) ||
    /not enough space/i.test(message) ||
    /database or disk is full/i.test(message) ||
    /\bENOSPC\b/i.test(message) ||
    /disk full/i.test(message) ||
    /full disk/i.test(message)
  )
}

const ERROR_SUMMARIES: { test: (msg: string) => boolean; summarize: (msg: string) => string }[] = [
  {
    // Disk full / ENOSPC — session DB write, backend crash, or any path that
    // bubbles "no space left" / SQLITE_FULL through notifyError, so the user
    // gets a clear "free space" toast instead of a silent send or a raw errno.
    test: isDiskFullErrorMessage,
    summarize: () => translateNow('notifications.errors.diskFull')
  },
  {
    test: msg => /['"]code['"]\s*:\s*['"]gateway_auth_failed['"]/i.test(msg),
    summarize: () => translateNow('notifications.errors.gatewayAuthFailed')
  },
  {
    test: msg => /incorrect api key provided/i.test(msg) || /['"]code['"]\s*:\s*['"]invalid_api_key['"]/i.test(msg),
    summarize: msg => {
      const status = msg.match(/(?:error code|status(?:Code)?)[^\d]*(\d{3})/i)?.[1]

      return status
        ? translateNow('notifications.errors.openaiRejectedApiKeyWithStatus', status)
        : translateNow('notifications.errors.openaiRejectedApiKey')
    }
  },
  {
    test: msg => /neither voice_tools_openai_key nor openai_api_key is set/i.test(msg),
    summarize: () => translateNow('notifications.errors.openaiTtsNeedsKey')
  },
  {
    test: msg => /ELEVENLABS_API_KEY not set/i.test(msg) || /ElevenLabs STT API error \(HTTP 401\)/i.test(msg),
    summarize: msg =>
      /ELEVENLABS_API_KEY not set/i.test(msg)
        ? translateNow('notifications.errors.elevenLabsNeedsKey')
        : translateNow('notifications.errors.elevenLabsRejectedKey')
  },
  {
    test: msg => /method not allowed/i.test(msg),
    summarize: () => translateNow('notifications.errors.methodNotAllowed')
  },
  {
    test: msg => /microphone permission/i.test(msg),
    summarize: () => translateNow('notifications.errors.microphonePermission')
  }
]

// v0.0.9 F4 (C1): the sentence the user needs is never swapped for the generic fallback because it is long. A long
// message is shown whole in the centre; the toast shows three lines and "More".
function summarizeErrorMessage(message: string, fallback: string) {
  const rule = ERROR_SUMMARIES.find(r => r.test(message))

  if (rule) {
    return rule.summarize(message)
  }

  return message || fallback
}

// Exported so flows that surface errors inline (e.g. ConfirmDialog's onConfirm
// rethrow) can reuse the same IPC-unwrapping + summarizing as notifyError.
export function readableError(error: unknown, fallback: string): { message: string; detail?: string } {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback
  const unwrapped = raw.match(/Error invoking remote method '[^']+': Error: (.+)$/)?.[1] ?? raw
  const cleaned = cleanErrorText(unwrapped)
  const detail = cleaned.match(/"detail"\s*:\s*"([^"]+)"/)?.[1] ?? cleaned
  const summary = summarizeErrorMessage(detail, fallback)

  return { message: summary, detail: detail === summary ? undefined : detail }
}

function clearTimer(id: string) {
  const timer = timers.get(id)

  if (timer?.handle !== undefined) {
    window.clearTimeout(timer.handle)
  }

  timers.delete(id)
}

function arm(id: string, ms: number) {
  if (held.has(id)) {
    // Replaced in place while being read: it waits, full time, for the pointer and the focus to leave.
    timers.set(id, { deadline: Date.now() + ms, handle: undefined, paused: true, remaining: ms })

    return
  }

  const timer: ToastTimer = {
    deadline: Date.now() + ms,
    handle: window.setTimeout(() => dismissNotification(id), ms),
    paused: false,
    remaining: ms
  }

  timers.set(id, timer)
}

/** Adds (or replaces, same id) one entry of the centre. Exported for the native mirror and the status banners. */
export function recordNotification(
  input: Omit<NotificationRecord, 'count' | 'createdAt' | 'id' | 'read' | 'source'> & {
    createdAt?: number
    id?: string
    /** A plain notice (info/success, no action, no callback): may merge into an identical recent entry. */
    mergeable?: boolean
    source?: NotificationRecord['source']
  }
): string {
  const id = input.id ?? `${Date.now()}-${notificationCounter++}`
  const centreOpen = $notificationCentre.get().open
  const now = input.createdAt ?? Date.now()

  // r4d (design r4 F4-1): "Replaced Settings — open it again from the Dock" twice in a minute is one entry, ×2.
  if (input.mergeable && (input.kind === 'info' || input.kind === 'success')) {
    const twin = $notificationHistory
      .get()
      .find(
        r =>
          r.id !== id &&
          r.source === 'toast' &&
          !r.action &&
          r.kind === input.kind &&
          r.title === input.title &&
          r.message === input.message &&
          now - r.createdAt <= MERGE_WINDOW_MS
      )

    if (twin) {
      const merged: NotificationRecord = { ...twin, count: (twin.count ?? 1) + 1, createdAt: now, read: centreOpen }

      $notificationHistory.set([merged, ...$notificationHistory.get().filter(r => r.id !== twin.id)])

      return twin.id
    }
  }

  const record: NotificationRecord = {
    action: input.action,
    createdAt: input.createdAt ?? Date.now(),
    detail: input.detail,
    id,
    kind: input.kind,
    message: input.message,
    meta: input.meta,
    nextStep: input.nextStep,
    read: centreOpen,
    source: input.source ?? 'toast',
    title: input.title
  }

  const next = [record, ...$notificationHistory.get().filter(r => r.id !== id)]

  $notificationHistory.set(next.slice(0, HISTORY_CAP))
  // r4d: an entry aged out of the centre is gone; a parked toast behind it ends.
  entriesGone(next.slice(HISTORY_CAP).map(r => r.id))

  return id
}

export function notify(input: NotificationInput): string {
  const kind = input.kind ?? 'info'
  const requestedId = input.id ?? `${Date.now()}-${notificationCounter++}`
  const durationMs = toastDurationMs({ ...input, kind })

  // r5 (eng r5-m2): a plain notice merged into an identical recent entry takes THAT entry's id, so the toast, the
  // entry and anything parked share one id ("open in centre" finds it; nothing is parked against a missing entry).
  const entryId = recordNotification({
    action: input.action,
    detail: input.detail,
    id: requestedId,
    kind,
    // A caller that names its own id dismisses or updates it by that id: never merged under another one.
    mergeable: !input.id && !input.action && !input.onDismiss && !input.detail && !input.nextStep,
    message: input.message,
    meta: input.meta,
    nextStep: input.nextStep,
    source: 'toast',
    title: input.title
  })
  const id = entryId

  const notification: AppNotification = {
    id,
    kind,
    icon: input.icon,
    accentColor: input.accentColor,
    meta: input.meta,
    title: input.title,
    message: input.message,
    detail: input.detail,
    nextStep: input.nextStep,
    survivesClear: input.survivesClear,
    action: input.action,
    onDismiss: input.onDismiss,
    createdAt: Date.now(),
    durationMs,
    placement: input.placement
  }


  // v0.0.9 r4b (critic-r4 06a): while the centre is open the owner is already reading the list; a new notification
  // lands there as an entry and does not ALSO pop a toast over the window (it duplicated the entry). A toast of the same
  // id already on screen is still updated in place, so it never shows stale words.
  if ($notificationCentre.get().open && !$notifications.get().some(item => item.id === id)) {
    // r4d (r4-m1): parked, not dropped — its onDismiss stays owed until a real end. Same id = one (no callback).
    parked.set(id, notification)
    actionUsed.delete(id)

    return id
  }

  // A newer toast of a parked id replaces it (same id = one), with no callback.
  parked.delete(id)
  actionUsed.delete(id)

  clearTimer(id)

  const next = [notification, ...$notifications.get().filter(item => item.id !== id)]
  const evicted = next.slice(TOAST_STACK_CAP)

  for (const item of evicted) {
    clearTimer(item.id)
    held.delete(item.id)
  }

  $notifications.set(next.slice(0, TOAST_STACK_CAP))

  if (evicted.length > 0) {
    $toastOverflow.set($toastOverflow.get() + evicted.length)
  }

  // v0.0.9 F4 (X2): eviction is a dismissal — the callbacks that clear the caller's own state run.
  for (const item of evicted) {
    item.onDismiss?.()
  }

  if (durationMs > 0) {
    arm(id, durationMs)
  }

  return id
}

export function notifyError(error: unknown, fallback: string): string {
  const readable = readableError(error, fallback)

  return notify({
    kind: 'error',
    title: fallback,
    message: readable.message,
    detail: readable.detail
  })
}

/** Hover or focus on a toast: the countdown stops where it is. */
export function pauseNotification(id: string) {
  held.add(id)

  const timer = timers.get(id)

  if (!timer || timer.paused) {
    return
  }

  if (timer.handle !== undefined) {
    window.clearTimeout(timer.handle)
  }

  timer.handle = undefined
  timer.remaining = Math.max(0, timer.deadline - Date.now())
  timer.paused = true
}

/** The pointer and the focus left the toast: the countdown carries on (never less than a second). */
export function resumeNotification(id: string) {
  held.delete(id)

  const timer = timers.get(id)

  if (!timer || !timer.paused) {
    return
  }

  const ms = Math.max(RESUME_FLOOR_MS, timer.remaining)

  timer.paused = false
  timer.deadline = Date.now() + ms
  timer.handle = window.setTimeout(() => dismissNotification(id), ms)
}

// v0.0.9 critic m4 / design 7: "+N in Notifications" is true only while the stack is full. Once a toast leaves and the
// stack has room again, the hint is gone (the centre's unread count on the bell keeps pointing at what was pushed off),
// so the chip never shows a stale count beside one or two toasts.
function settleOverflow() {
  if ($notifications.get().length < TOAST_STACK_CAP) {
    $toastOverflow.set(0)
  }
}

export function dismissNotification(id: string) {
  if (parked.has(id)) {
    // r4d: the caller ended a parked toast (a confirm settled): a real dismissal, its callback runs once.
    endParked(id, true)

    return
  }

  clearTimer(id)
  held.delete(id)
  const dismissed = $notifications.get().find(item => item.id === id)
  $notifications.set($notifications.get().filter(item => item.id !== id))
  settleOverflow()
  dismissed?.onDismiss?.()
}

/** Clears the toasts on screen (a reconnect). The centre keeps every entry (X3). */
export function clearNotifications() {
  const all = $notifications.get()
  const cleared = all.filter(item => !item.survivesClear)

  for (const item of cleared) {
    clearTimer(item.id)
    held.delete(item.id)
  }

  $notifications.set(all.filter(item => item.survivesClear))
  settleOverflow()

  for (const item of cleared) {
    item.onDismiss?.()
  }

  // r4d: a parked toast the reconnect would have cleared from the screen is cleared too (survivesClear ones stay).
  for (const [id, item] of [...parked]) {
    if (!item.survivesClear) {
      endParked(id, true)
    }
  }
}

/** Opens the centre; with an id, that entry is the one shown open and scrolled to. Everything becomes read. */
export function openNotificationCentre(focusId: null | string = null) {
  $notificationCentre.set({ focusId, open: true })
  $toastOverflow.set(0)
  markAllNotificationsRead()
  absorbToasts()
}

/**
 * v0.0.9 r4c (critic-r4 06a): opening the centre takes the toasts on screen away — every toast is already an entry there
 * (N7), so the same words showed twice. They leave with their usual short exit (notifications.tsx plays `data-leaving`)
 * and their entries stay. r4d (eng r4-M1): that is a PARK, never a dismissal: no `onDismiss` runs (a pending confirm
 * stays answerable from its entry, an update prompt is not snoozed), and closing the centre brings the sticky ones back.
 */
function absorbToasts() {
  const absorbed = $notifications.get()

  if (absorbed.length === 0) {
    return
  }

  for (const item of absorbed) {
    clearTimer(item.id)
    held.delete(item.id)
    parked.set(item.id, item)
    actionUsed.delete(item.id)
  }

  $notifications.set([])
  settleOverflow()
}

/** r4d: on close, the parked sticky toasts whose entry is still in the centre (and whose action was not used) return. */
function restoreStickyToasts() {
  const inCentre = new Set($notificationHistory.get().map(record => record.id))
  const back: AppNotification[] = []

  for (const [id, item] of [...parked]) {
    // r5: a toast whose entry was already removed from the centre while it was on screen has no entry to wait in, so it
    // comes back too (else it would stay parked for ever and its callback would never run); a timed one gets its
    // timer back below.
    if ((isSticky(item) || !inCentre.has(id)) && !actionUsed.has(id)) {
      parked.delete(id)
      back.push(item)
    }
  }

  if (back.length === 0) {
    return
  }

  const next = [...back, ...$notifications.get().filter(item => !back.some(b => b.id === item.id))]
  const evicted = next.slice(TOAST_STACK_CAP)

  for (const item of evicted) {
    clearTimer(item.id)
    held.delete(item.id)
  }

  $notifications.set(next.slice(0, TOAST_STACK_CAP))

  if (evicted.length > 0) {
    $toastOverflow.set($toastOverflow.get() + evicted.length)
  }

  // r5 (eng r5-m1): a restored toast that has a duration runs it again — it never stays on screen for ever.
  for (const item of next.slice(0, TOAST_STACK_CAP)) {
    if (back.includes(item) && item.durationMs > 0) {
      arm(item.id, item.durationMs)
    }
  }

  // The stack cap is still a dismissal (X2).
  for (const item of evicted) {
    item.onDismiss?.()
  }
}

export function closeNotificationCentre() {
  const wasOpen = $notificationCentre.get().open

  $notificationCentre.set({ focusId: null, open: false })

  if (wasOpen) {
    restoreStickyToasts()
  }
}

export function toggleNotificationCentre() {
  if ($notificationCentre.get().open) {
    closeNotificationCentre()
  } else {
    openNotificationCentre()
  }
}

export function markAllNotificationsRead() {
  const history = $notificationHistory.get()

  if (history.some(r => !r.read)) {
    $notificationHistory.set(history.map(r => (r.read ? r : { ...r, read: true })))
  }
}

export function removeNotificationRecord(id: string) {
  $notificationHistory.set($notificationHistory.get().filter(r => r.id !== id))
  entriesGone([id])
}

export function clearNotificationHistory() {
  const gone = $notificationHistory.get().map(r => r.id)

  $notificationHistory.set([])
  entriesGone(gone)
}
