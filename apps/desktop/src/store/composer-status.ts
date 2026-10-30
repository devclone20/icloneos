import { JsonRpcGatewayError } from '@hermes/shared'
import { atom, computed } from 'nanostores'

import { resumeStoredRuntimeSession } from '@/app/session/hooks/use-prompt-actions/utils'
import { translateNow } from '@/i18n'
import { errorMessage } from '@/iclone-shared/errors'
import { noteSessionLost } from '@/lib/provider-block'
import { stableArray } from '@/lib/stable-array'
import type { TodoItem, TodoStatus } from '@/lib/todos'

import { $gateway } from './gateway'
import { $goalsBySession, type GoalStatus } from './goals'
import { dispatchNativeNotification } from './native-notifications'
import { notifyError } from './notifications'
import { $sessions, lineageAliases } from './session'
import { $sessionStates, storedSessionIdForRuntimeId } from './session-states'
import { $subagentsBySession, type SubagentProgress } from './subagents'
import { $todosBySession } from './todos'

/** Composer status stack feed — merged todos, subagents, background per session. */
type StatusItemState = 'done' | 'failed' | 'running'
type StatusItemType = 'background' | 'goal' | 'subagent' | 'todo'

export interface ComposerStatusItem {
  /** background: non-zero exit shown inline when failed. */
  exitCode?: number
  /** subagent: active tool label shown on the right. */
  currentTool?: string
  /** goal: active | paused | waiting | done. */
  goalStatus?: GoalStatus
  id: string
  /** background process: captured stdout/stderr tail for the inline viewer. */
  output?: string
  /** subagent: its own stored session id — row click opens that session window
   *  (livestreamed by the gateway's child-session mirror). */
  sessionId?: string
  state: StatusItemState
  title: string
  /** todo: the full four-state status driving the row's checkmark glyph. */
  todoStatus?: TodoStatus
  type: StatusItemType
}

// Writable source for background work, synced from the gateway's process
// registry (`terminal(background=true)` spawns) via `process.list`.
export const $backgroundStatusBySession = atom<Record<string, ComposerStatusItem[]>>({})

// Stored session ids that have at least one RUNNING background process. The
// sidebar row reads this for a hollow dot — distinct from the filled dot of an
// active LLM turn — so the user can tell at a glance "this session has
// something chugging along in the background" even when the turn is idle.
//
// $backgroundStatusBySession is keyed by RUNTIME session id (gateway events
// and process.list both speak that); the sidebar row knows only the STORED id.
// $sessionStates bridges the two: runtime id → state.storedSessionId, then
// lineageAliases covers whichever tip of that conversation a surface holds.
// Perf: recomputes on every $sessionStates change (message deltas, tens/sec),
// but the background-running set rarely moves. `stableArray` keeps the prior
// reference when unchanged so rows reading this don't re-render per token.
let backgroundRunningIds: readonly string[] = []
export const $backgroundRunningSessionIds = computed(
  [$backgroundStatusBySession, $sessionStates, $sessions],
  (bg, states, sessions) => {
    const ids = new Set<string>()

    for (const [runtimeId, items] of Object.entries(bg)) {
      if (!items.some(i => i.state === 'running')) {
        continue
      }

      // Same fresh-chat fallback as the working/attention projections: before a
      // conversation is persisted its runtime id is the id surfaces key on.
      for (const alias of lineageAliases(states[runtimeId]?.storedSessionId ?? runtimeId, sessions)) {
        ids.add(alias)
      }
    }

    return (backgroundRunningIds = stableArray(backgroundRunningIds, [...ids]))
  }
)

// Rows the user X-ed away. The registry keeps finished processes around for a
// while, so without this every refresh would resurrect a dismissed row.
// The value says why the row left: the background-tasks panel reads it so a
// running job the owner X-ed, or a rewind dropped, never reads as "died". It
// stands even when the kill outlived its window ("Did not stop"): the owner
// asked, so whenever that job ends, the end is theirs.
type BackgroundDismissal = 'owner' | 'rewind'
const dismissedBySession = new Map<string, Map<string, BackgroundDismissal>>()

/** Why a background row left the stack while the registry still reports it, or null if it was not dismissed. */
export function backgroundDismissalOf(sid: string, id: string): BackgroundDismissal | null {
  return dismissedBySession.get(sid)?.get(id) ?? null
}

// Finished tasks self-clear so the stack only ever holds running work. Success
// goes quick; failure lingers longer so its exit code stays readable (the output
// also lives in the transcript). A manual X still drops either at once.
const SUCCESS_LINGER_MS = 4_000
const FAILURE_LINGER_MS = 12_000
const autoClearTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>()

function scheduleAutoDismiss(sid: string, id: string, delayMs: number) {
  let timers = autoClearTimers.get(sid)

  if (timers?.has(id)) {
    return
  }

  if (!timers) {
    timers = new Map()
    autoClearTimers.set(sid, timers)
  }

  timers.set(
    id,
    setTimeout(() => {
      autoClearTimers.get(sid)?.delete(id)
      dismissBackgroundProcess(sid, id)
    }, delayMs)
  )
}

function cancelAutoDismiss(sid: string, id: string) {
  const timers = autoClearTimers.get(sid)

  if (!timers) {
    return
  }

  const timer = timers.get(id)

  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
}

function cancelAllAutoDismiss(sid: string) {
  const timers = autoClearTimers.get(sid)

  if (!timers) {
    return
  }

  for (const timer of timers.values()) {
    clearTimeout(timer)
  }

  autoClearTimers.delete(sid)
}

const subToItem = (s: SubagentProgress): ComposerStatusItem => ({
  currentTool: s.currentTool,
  id: s.id,
  sessionId: s.sessionId,
  state: 'running',
  title: s.goal,
  type: 'subagent'
})

const todoToItem = (t: TodoItem): ComposerStatusItem => ({
  id: `todo:${t.id}`,
  state: t.status === 'in_progress' ? 'running' : 'done',
  title: t.content,
  todoStatus: t.status,
  type: 'todo'
})

const goalToItem = (goal: { detail?: string; status: GoalStatus; title: string }): ComposerStatusItem => ({
  currentTool: goal.detail,
  goalStatus: goal.status,
  id: 'goal:standing',
  state: goal.status === 'active' || goal.status === 'waiting' ? 'running' : 'done',
  title: goal.title,
  type: 'goal'
})

// The single thing the stack reads: a typed, merged item list per session.
//
// Identity contract: this computed's inputs churn constantly during a turn (a
// subagent tick, a 5s background poll, a todo update — in ANY session), but
// the merged output for most sessions is unchanged. Rebuilding fresh arrays
// and item objects every time handed every mounted composer stack a new
// reference per recompute — cross-session churn × open tiles. Stabilize both
// levels: an unchanged session keeps its previous array (and item objects),
// and a fully-unchanged map keeps its previous reference so `computed` skips
// the notify entirely ("preserve reference identity on no-ops").
const sameStatusItem = (a: ComposerStatusItem, b: ComposerStatusItem) =>
  a.id === b.id &&
  a.type === b.type &&
  a.state === b.state &&
  a.title === b.title &&
  a.output === b.output &&
  a.exitCode === b.exitCode &&
  a.currentTool === b.currentTool &&
  a.goalStatus === b.goalStatus &&
  a.todoStatus === b.todoStatus &&
  a.sessionId === b.sessionId

const stabilizeItems = (prev: ComposerStatusItem[] | undefined, next: ComposerStatusItem[]): ComposerStatusItem[] => {
  if (!prev) {
    return next
  }

  const merged = next.map((item, i) => (prev[i] && sameStatusItem(prev[i], item) ? prev[i] : item))

  return merged.length === prev.length && merged.every((item, i) => item === prev[i]) ? prev : merged
}

let prevStatusItems: Record<string, ComposerStatusItem[]> = {}

export const $statusItemsBySession = computed(
  [$goalsBySession, $subagentsBySession, $backgroundStatusBySession, $todosBySession],
  (goals, subs, background, todos) => {
    const out: Record<string, ComposerStatusItem[]> = {}

    const push = (sid: string, items: ComposerStatusItem[]) => {
      if (items.length > 0) {
        out[sid] = out[sid] ? [...out[sid], ...items] : items
      }
    }

    for (const [sid, list] of Object.entries(todos)) {
      push(sid, list.map(todoToItem))
    }

    for (const [sid, goal] of Object.entries(goals)) {
      push(sid, [goalToItem(goal)])
    }

    for (const [sid, list] of Object.entries(subs)) {
      push(sid, list.filter(s => s.status === 'running' || s.status === 'queued').map(subToItem))
    }

    for (const [sid, list] of Object.entries(background)) {
      push(sid, list)
    }

    let unchanged = Object.keys(prevStatusItems).length === Object.keys(out).length

    for (const sid of Object.keys(out)) {
      out[sid] = stabilizeItems(prevStatusItems[sid], out[sid]!)
      unchanged &&= out[sid] === prevStatusItems[sid]
    }

    return (prevStatusItems = unchanged ? prevStatusItems : out)
  }
)

// Fixed render order for the groups in the stack (top → bottom, above queue).
const TYPE_ORDER: readonly StatusItemType[] = ['goal', 'todo', 'subagent', 'background']

export interface StatusGroup {
  items: ComposerStatusItem[]
  type: StatusItemType
}

export function groupStatusItems(items: readonly ComposerStatusItem[]): StatusGroup[] {
  const byType = new Map<StatusItemType, ComposerStatusItem[]>()

  for (const item of items) {
    const list = byType.get(item.type)

    if (list) {
      list.push(item)
    } else {
      byType.set(item.type, [item])
    }
  }

  return TYPE_ORDER.filter(type => byType.has(type)).map(type => ({ items: byType.get(type)!, type }))
}

const writeBackground = (sid: string, items: ComposerStatusItem[]) => {
  const current = $backgroundStatusBySession.get()
  const next = { ...current }

  if (items.length > 0) {
    next[sid] = items
  } else {
    delete next[sid]
  }

  $backgroundStatusBySession.set(next)
}

// `tui_gateway` process.list entry (tools/process_registry.list_sessions + output_tail).
interface GatewayProcessEntry {
  command?: string
  exit_code?: number
  output_tail?: string
  session_id?: string
  status?: string
}

const toBackgroundItem = (proc: GatewayProcessEntry): ComposerStatusItem => {
  const exited = proc.status === 'exited'
  const exitCode = typeof proc.exit_code === 'number' ? proc.exit_code : undefined

  return {
    exitCode,
    id: proc.session_id ?? '',
    output: proc.output_tail || undefined,
    state: exited ? (exitCode ? 'failed' : 'done') : 'running',
    title: (proc.command ?? '').split('\n')[0]!.trim() || 'background process',
    type: 'background'
  }
}

const sameItem = (a: ComposerStatusItem, b: ComposerStatusItem) =>
  a.state === b.state && a.title === b.title && a.output === b.output && a.exitCode === b.exitCode

/** Same window as the panel's own Stop verdict (contract V3A §2.7). */
const STOP_CONFIRM_MS = 3_000

/** Same as the panel's: no reading this long after the X, and "Stopping…" reads "Can't confirm". */
const STOP_UNCONFIRMED_MS = 15_000

/** A row that left the stack while its process was still running (X after the
 *  kill's ACK, or a rewind): followed until the registry confirms the process
 *  exited, so the background-tasks panel can say "Stopping…" and, when the
 *  process outlives the kill, "Did not stop" — never "Stopped" on intent. */
export interface BackgroundStopWatch {
  /** The registry's latest reading of the process. */
  item: ComposerStatusItem
  since: number
  failed: boolean
  /** No reading decided it within STOP_UNCONFIRMED_MS; a later reading still does. */
  unconfirmed: boolean
}

export const $backgroundStopWatch = atom<Readonly<Record<string, Readonly<Record<string, BackgroundStopWatch>>>>>({})

function writeStopWatch(sid: string, watches: Readonly<Record<string, BackgroundStopWatch>>) {
  const { [sid]: _old, ...rest } = $backgroundStopWatch.get()

  $backgroundStopWatch.set(Object.keys(watches).length > 0 ? { ...rest, [sid]: watches } : rest)
}

function watchStop(sid: string, item: ComposerStatusItem) {
  const since = Date.now()

  writeStopWatch(sid, {
    ...$backgroundStopWatch.get()[sid],
    [item.id]: { failed: false, item, since, unconfirmed: false }
  })
  setTimeout(() => void refreshBackgroundProcesses(sid), STOP_CONFIRM_MS)
  setTimeout(() => markStopUnconfirmed(sid, item.id, since), STOP_UNCONFIRMED_MS)
}

/** The kill behind a dismissal failed outright (a rewind's kill rejected). */
function markStopFailed(sid: string, id: string) {
  const watch = $backgroundStopWatch.get()[sid]?.[id]

  if (!watch || watch.failed) {
    return
  }

  writeStopWatch(sid, { ...$backgroundStopWatch.get()[sid], [id]: { ...watch, failed: true } })
}

/** Still undecided STOP_UNCONFIRMED_MS after this watch began: no reading reached it (gateway slow, gone or down). */
function markStopUnconfirmed(sid: string, id: string, since: number) {
  const watch = $backgroundStopWatch.get()[sid]?.[id]

  if (!watch || watch.since !== since || watch.failed || watch.unconfirmed) {
    return
  }

  writeStopWatch(sid, { ...$backgroundStopWatch.get()[sid], [id]: { ...watch, unconfirmed: true } })
}

/**
 * Follows every watched stop of this session against one registry snapshot.
 * Runs BEFORE the dismissal garbage collection: a process that is gone from
 * the registry leaves the watch while its dismissal reason is still readable.
 *
 * `sentAt` is when the snapshot was REQUESTED, not when it landed: on a slow
 * gateway a reading sent before the kill took effect can arrive after the
 * window, and it proves nothing about the kill. Only a reading sent
 * STOP_CONFIRM_MS or more after the stop may call it "did not stop".
 */
function followStopWatches(sid: string, procs: GatewayProcessEntry[], sentAt: number) {
  const watches = $backgroundStopWatch.get()[sid]

  if (!watches) {
    return
  }

  const reported = new Map(procs.filter(proc => proc.session_id).map(proc => [proc.session_id!, proc]))
  const next: Record<string, BackgroundStopWatch> = {}
  let changed = false

  for (const [id, watch] of Object.entries(watches)) {
    const proc = reported.get(id)
    const item = proc ? toBackgroundItem(proc) : null

    // Gone or exited ends the watch, a failed stop's too: its dismissal still names the owner's ask.
    if (!item || item.state !== 'running') {
      changed = true

      continue
    }

    const failed = watch.failed || sentAt - watch.since >= STOP_CONFIRM_MS
    const kept = failed === watch.failed && sameItem(watch.item, item) ? watch : { ...watch, failed, item }

    changed ||= kept !== watch
    next[id] = kept
  }

  if (changed) {
    writeStopWatch(sid, next)
  }
}

/**
 * Layout-stable sync of the registry snapshot into the store: existing rows
 * keep their position (status flips happen in place, never reorder), new
 * processes append, dismissed ids stay gone, and unchanged rows keep their
 * object identity so memoised rows skip re-rendering.
 */
export function reconcileBackgroundProcesses(
  sid: string,
  procs: GatewayProcessEntry[],
  sentAt: number = Date.now()
): void {
  const dismissed = dismissedBySession.get(sid)

  followStopWatches(sid, procs, sentAt)

  const fresh = new Map(
    procs
      .filter(proc => proc.session_id && !dismissed?.has(proc.session_id))
      .map(proc => [proc.session_id!, toBackgroundItem(proc)])
  )

  const prev = $backgroundStatusBySession.get()[sid] ?? []

  // running → exited since the last snapshot = a background process just finished.
  const prevState = new Map(prev.map(item => [item.id, item.state]))

  for (const [id, item] of fresh) {
    if (item.state !== 'running' && prevState.get(id) === 'running') {
      dispatchNativeNotification({
        body: item.title,
        kind: 'backgroundDone',
        sessionId: sid,
        title: translateNow(
          item.state === 'failed'
            ? 'notifications.native.backgroundFailedTitle'
            : 'notifications.native.backgroundDoneTitle'
        )
      })
    }
  }

  const kept = prev.flatMap(old => {
    const next = fresh.get(old.id)
    fresh.delete(old.id)

    return next ? [sameItem(old, next) ? old : next] : []
  })

  const next = [...kept, ...fresh.values()]

  // Dismissals only need remembering while the registry still reports the id.
  if (dismissed) {
    const reported = new Set(procs.map(proc => proc.session_id))

    for (const id of dismissed.keys()) {
      if (!reported.has(id)) {
        dismissed.delete(id)
      }
    }
  }

  // Arm the self-clear on every finished task (failures linger longer); cancel
  // it for anything running again or gone from the snapshot.
  const finishedDelay = new Map(
    next
      .filter(item => item.state !== 'running')
      .map(item => [item.id, item.state === 'failed' ? FAILURE_LINGER_MS : SUCCESS_LINGER_MS])
  )

  for (const [id, delay] of finishedDelay) {
    scheduleAutoDismiss(sid, id, delay)
  }

  for (const id of [...(autoClearTimers.get(sid)?.keys() ?? [])]) {
    if (!finishedDelay.has(id)) {
      cancelAutoDismiss(sid, id)
    }
  }

  if (next.length === prev.length && next.every((item, i) => item === prev[i])) {
    return
  }

  writeBackground(sid, next)
}

/** Session ids the gateway has told us are gone. A session-scoped RPC against a
 *  runtime the gateway no longer holds fails 4001 "session not found" — a
 *  TERMINAL condition, not the transient socket loss the catch below assumes.
 *
 *  The status stack re-polls `process.list` every 5s while a running row is on
 *  screen, so treating 4001 as transient meant re-sending the same dead id
 *  forever: one runtime id accumulated 18,614 gateway rejections in a single day
 *  (#94219 fallout). Latch the id here and skip it until something rebinds it. */
const goneSessions = new Set<string>()

/** The gone-latch, readable. A latched session is never polled again, so its rows
 *  stay "running" here forever; the background-tasks panel listens to this to say
 *  those jobs ended with their session instead. */
export const $backgroundGoneSessions = atom<ReadonlySet<string>>(new Set())
const publishGoneSessions = () => $backgroundGoneSessions.set(new Set(goneSessions))

/** A reaped runtime (4001) is resumed ONCE per polled id and the list retried
 *  once against the fresh runtime; later polls go straight to that runtime. A
 *  failed resume or retry latches the id as gone like before. */
const resumedPollTargets = new Map<string, string>()
const resumeAttempted = new Set<string>()

/** Gateway JSON-RPC code for "session not found" (tui_gateway _sess_nowait). */
const GATEWAY_SESSION_NOT_FOUND_CODE = 4001

/** A gone session is unrecoverable for THIS runtime id; a timeout or transport
 *  blip is not. Only the former may stop the poll — misclassifying a transient
 *  failure would silently freeze the status stack on a healthy session.
 *
 *  Match the gateway's 4001 code when the error carries one (JsonRpcGatewayError
 *  from a structured RPC rejection) — a message substring alone could latch on
 *  an unrelated error class that merely mentions "session not found" (e.g. a
 *  wrapped tool/report string). The message fallback survives only for errors
 *  with no numeric code at all, where the frame's structure was lost. */
export function isSessionGoneForBackgroundPolling(error: unknown): boolean {
  if (error instanceof JsonRpcGatewayError && typeof error.code === 'number') {
    return error.code === GATEWAY_SESSION_NOT_FOUND_CODE
  }

  const message = error == null ? '' : errorMessage(error)

  return /session not found/i.test(message)
}

/** Clear the gone-latch. Called with a session id when a fresh runtime binds to
 *  it (so polling resumes), or with no argument to reset everything (tests). */
export function resetBackgroundPollingGuard(sid?: string): void {
  if (sid) {
    goneSessions.delete(sid)
    resumedPollTargets.delete(sid)
    resumeAttempted.delete(sid)
    rebindListSeq.set(sid, listSeq)
    publishGoneSessions()

    return
  }

  goneSessions.clear()
  resumedPollTargets.clear()
  resumeAttempted.clear()
  lastRefreshAt.clear()
  rebindListSeq.clear()
  resetListSeq = listSeq
  publishGoneSessions()
}

/** When `process.list` was last sent for a session, by anyone (a mounted stack,
 *  a tool event, the background-tasks poller), so pollers can share one cadence. */
const lastRefreshAt = new Map<string, number>()

export function lastBackgroundRefreshAt(sid: string): number | undefined {
  return lastRefreshAt.get(sid)
}

/** Every `process.list` is numbered as it is sent, from one counter that is
 *  never reset. Replies can land out of order (two overlapping reads, unequal
 *  latency); one older than the newest reading already applied for its session
 *  is dropped, or a stale "running" would resurrect a stop that was confirmed. */
let listSeq = 0
const appliedListSeq = new Map<string, number>()

/** The last number sent before a rebind of the session (`rebindListSeq`) or a
 *  reset of every session (`resetListSeq`). A "session not found" to a request
 *  sent before it is about the runtime that was replaced, not the one now bound:
 *  it must not latch the rebound session as gone. */
const rebindListSeq = new Map<string, number>()
let resetListSeq = 0

function storedIdForPolledSession(sid: string): null | string {
  return $sessionStates.get()[sid]?.storedSessionId ?? storedSessionIdForRuntimeId(sid)
}

/** Pull the session's live process snapshot from the gateway. */
export async function refreshBackgroundProcesses(sid: string): Promise<void> {
  await readBackgroundProcesses(sid)
}

/**
 * One `process.list` for the session. Resolves true once the store reflects the
 * session as of this call: this reading applied, a newer one already applied,
 * or the session is known gone. False when no reading could be taken (no
 * gateway, a transient failure) — the caller must not judge on the old one.
 */
export async function readBackgroundProcesses(sid: string): Promise<boolean> {
  const gateway = $gateway.get()

  if (!sid || !gateway) {
    return false
  }

  if (goneSessions.has(sid)) {
    return true
  }

  const list = (liveId: string) =>
    gateway.request<{ processes?: GatewayProcessEntry[] }>('process.list', { session_id: liveId })

  const sentAt = Date.now()
  const seq = (listSeq += 1)

  lastRefreshAt.set(sid, sentAt)

  const superseded = () => seq < (appliedListSeq.get(sid) ?? 0)
  const sentBeforeRebind = () => seq <= Math.max(resetListSeq, rebindListSeq.get(sid) ?? 0)

  const apply = (procs: GatewayProcessEntry[]) => {
    if (!superseded()) {
      appliedListSeq.set(sid, seq)
      reconcileBackgroundProcesses(sid, procs, sentAt)
    }

    return true
  }

  try {
    const result = await list(resumedPollTargets.get(sid) ?? sid)

    return apply(result?.processes ?? [])
  } catch (error) {
    // A newer reading already landed: this failure says nothing about now.
    if (superseded()) {
      return true
    }

    // Sent to the runtime a rebind replaced: no reading of the session as bound now.
    if (sentBeforeRebind()) {
      return false
    }

    // Transient socket loss — the next trigger (event or poll) retries.
    if (!isSessionGoneForBackgroundPolling(error)) {
      return false
    }

    const storedId = resumeAttempted.has(sid) ? null : storedIdForPolledSession(sid)

    if (storedId) {
      resumeAttempted.add(sid)

      try {
        const liveId = await resumeStoredRuntimeSession(storedId, {
          requestGateway: <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) =>
            gateway.request<T>(method, params, timeoutMs)
        })

        if (liveId) {
          const result = await list(liveId)

          resumedPollTargets.set(sid, liveId)

          return apply(result?.processes ?? [])
        }
      } catch {
        // Fall through: the resume or the retry failed — the runtime is lost.
      }

      noteSessionLost()
    }

    // A gone session never comes back under this runtime id: stop polling it,
    // or the 5s timer hammers the gateway with 4001s for the window's lifetime.
    goneSessions.add(sid)
    publishGoneSessions()

    return true
  }
}

/** X on a finished row: drop it now and keep it dropped across refreshes. */
export function dismissBackgroundProcess(sid: string, id: string) {
  cancelAutoDismiss(sid, id)

  const dismissed = dismissedBySession.get(sid) ?? new Map<string, BackgroundDismissal>()
  dismissed.set(id, 'owner')
  dismissedBySession.set(sid, dismissed)

  const list = $backgroundStatusBySession.get()[sid] ?? []
  const leaving = list.find(item => item.id === id)

  if (leaving?.state === 'running') {
    watchStop(sid, leaving)
  }

  writeBackground(
    sid,
    list.filter(item => item.id !== id)
  )
}

/** X on a running row: kill the process for real, THEN drop the row. Only drop
 *  on a confirmed kill — dismissing unconditionally (the old behavior) hid the
 *  row while the process lived on, stranding rogue tasks. On failure the row
 *  stays so the user can retry / see it didn't die. */
export async function stopBackgroundProcess(sid: string, id: string): Promise<void> {
  try {
    await $gateway.get()?.request('process.kill', { process_id: id, session_id: sid })
    dismissBackgroundProcess(sid, id)
  } catch (err) {
    // A refused kill is still the owner's ask (lead ruling, r4 minor-11): record it, then say plainly it did not take.
    dismissBackgroundProcess(sid, id)
    markStopFailed(sid, id)
    notifyError(err, 'Could not stop the process')
  }
}

/**
 * Rewind cleanup: a restore/edit discards the turns that spawned these
 * processes, so they belong to an abandoned timeline. Kill the live ones and
 * drop every row. Ids are marked dismissed so an in-flight `process.list` poll
 * (kill is async) can't resurrect them; reconcile garbage-collects those once
 * the registry stops reporting them.
 */
export function resetSessionBackground(sid: string) {
  if (!sid) {
    return
  }

  cancelAllAutoDismiss(sid)

  const gateway = $gateway.get()
  const list = $backgroundStatusBySession.get()[sid] ?? []
  const dismissed = dismissedBySession.get(sid) ?? new Map<string, BackgroundDismissal>()

  dismissedBySession.set(sid, dismissed)

  for (const item of list) {
    dismissed.set(item.id, 'rewind')

    if (item.state === 'running') {
      watchStop(sid, item)

      if (gateway) {
        void gateway
          .request('process.kill', { process_id: item.id, session_id: sid })
          .catch(() => markStopFailed(sid, item.id))
      } else {
        markStopFailed(sid, item.id)
      }
    }
  }

  writeBackground(sid, [])
}
