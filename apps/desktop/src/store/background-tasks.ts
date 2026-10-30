/**
 * V3-A — the ONE registry of background work (RESUME/contracts/V3A_background_tasks.md §2.1).
 *
 * Five places already knew about background work (shell processes, sub-agents, cron runs, desktop actions, iT
 * panes) and none of them knew about the others. Each is adapted into a `TaskSource`; this module folds their
 * snapshots into `$backgroundTasks`, a computed list. Nothing here counts: the badge is a fold of the list, so it
 * cannot drift from what the panel shows.
 *
 * The only memory the registry keeps is the died/stopped ledger, because the sources forget finished work (the
 * composer stack self-clears a failed process after 12 s): a task that was `running` and then exited non-zero, was
 * killed by a signal or vanished — without the owner pressing Stop in the panel — is recorded as `died`, unseen,
 * and persisted until the owner opens or dismisses it. That is the "died and nobody noticed" state the panel exists
 * for.
 */
import { atom, computed } from 'nanostores'

import { ICLONE_STORAGE } from '@/app/home/lib/storage-keys'
import { errorMessage } from '@/iclone-shared/errors'
import { readJson, writeJson } from '@/lib/storage'

export type TaskKind = 'agent' | 'shell' | 'cron' | 'pane' | 'action'
export type TaskState = 'running' | 'waiting' | 'done' | 'failed' | 'died' | 'stopped'

/** Why a running task ended without dying: the owner stopped it, a rewind dropped it, or its session ended. */
export type TaskEndReason = 'owner' | 'rewind' | 'session'

export interface BgTask {
  id: `${string}:${string}`
  source: string
  kind: TaskKind
  title: string
  state: TaskState
  sessionId?: string
  /** null = unknown, never faked. */
  startedAt: number | null
  lastLine: string | null
  lastLineAt: number | null
  exit?: { code?: number; signal?: string }
  stop: 'real' | 'none'
  seen: boolean
  /** Set only on a remembered `stopped` task, when the registry knows why it ended. */
  endedBy?: TaskEndReason
  /**
   * A stop asked OUTSIDE the panel (the composer stack's X, a rewind) that its source has not confirmed: `pending`
   * while the job may still be dying, `failed` once it outlived the stop, `unconfirmed` when no reading could be
   * taken for `STOP_UNCONFIRMED_MS`. The panel's own presses live in `$stopAttempts` and win over this.
   */
  externalStop?: StopAttempt['phase']
}

export interface StopResult {
  ok: boolean
  effect: 'killed' | 'interrupted' | 'unsupported'
  detail?: string
}

export interface TaskSource {
  id: string
  subscribe(cb: () => void): () => void
  snapshot(): BgTask[]
  stop(nativeId: string): Promise<StopResult>
  /**
   * Asked when one of this source's running tasks VANISHES: a known, non-fatal reason makes it `stopped` with that
   * reason instead of `died`. Optional; a source without it reports every vanish as a death.
   */
  endReason?(nativeId: string): TaskEndReason | null
  /**
   * Takes a fresh reading of the task now. Resolves true once the snapshot reflects a reading sent no earlier than
   * this call, false when none could be taken. The Stop verdict asks for it: a source whose replies can lag judges
   * "Did not stop" only on a reading sent after the window, never on one that left before the kill took effect.
   * Optional; a synchronous source's snapshot is always current.
   */
  reread?(nativeId: string): Promise<boolean>
}

/** One source's last reading. `error` names a source that failed to read; the others keep rendering. */
interface SourceSlot {
  order: number
  tasks: readonly BgTask[]
  error: string | null
}

/** A task the registry remembers after its source forgot it: died (unseen until opened) or stopped by the owner. */
interface LedgerEntry {
  task: BgTask
  at: number
}

/**
 * Panel-side state of one Stop press: pending until a reading decides it, `failed` when it did not take,
 * `unconfirmed` when no reading could be taken in `STOP_UNCONFIRMED_MS` (a reading that lands later still decides).
 */
interface StopAttempt {
  phase: 'pending' | 'unconfirmed' | 'failed'
  effect: StopResult['effect']
  detail: string | null
}

const LEDGER_CAP = 50

/** Contract §2.7: a task still running this long after an acknowledged Stop shows "Did not stop". */
export const STOP_VERIFY_MS = 3_000

/** With no reading of the gateway this long after a press, "Stopping…" gives way to a neutral "Can't confirm". */
export const STOP_UNCONFIRMED_MS = 15_000

const ACTIVE: ReadonlySet<TaskState> = new Set(['running', 'waiting'])

export const isActiveTask = (task: BgTask): boolean => ACTIVE.has(task.state)

// ── pure core ──────────────────────────────────────────────────────────────

const VANISH_UNEXPLAINED = (): null => null

const splitTaskId = (id: string): { source: string; native: string } => {
  const at = id.indexOf(':')

  return { source: id.slice(0, at), native: id.slice(at + 1) }
}

const endedBadly = (task: BgTask): boolean =>
  task.state === 'failed' ||
  task.state === 'died' ||
  !!task.exit?.signal ||
  (task.exit?.code !== undefined && task.exit.code !== 0)

/**
 * The transitions one new snapshot of ONE source implies. A task that was `running` and is now gone, failed,
 * non-zero or signalled becomes `died` (unseen) — or `stopped` when the owner asked the panel to stop it, or when it
 * vanished for a reason its source can name (`explainVanish`). A failure still in the snapshot is never explained away.
 */
export function ledgerTransitions(
  prev: readonly BgTask[],
  next: readonly BgTask[],
  ownerStopped: ReadonlySet<string>,
  now: number,
  explainVanish: (id: BgTask['id']) => TaskEndReason | null = VANISH_UNEXPLAINED
): LedgerEntry[] {
  const nextById = new Map(next.map(task => [task.id, task]))
  const out: LedgerEntry[] = []

  for (const before of prev) {
    if (before.state !== 'running') {
      continue
    }

    const after = nextById.get(before.id)

    if (after && !endedBadly(after)) {
      continue
    }

    // A job that vanished with its session is "Session ended" even after an owner stop: losing sight of it is not
    // seeing it exit, and the stop may not have taken (r4 MAJOR-5). A job seen exiting after a stop stays the owner's.
    const vanishedWith = after ? null : explainVanish(before.id)
    const endedBy = vanishedWith === 'session' ? 'session' : ownerStopped.has(before.id) ? 'owner' : vanishedWith
    const base = after ?? before

    out.push({
      at: now,
      task: {
        ...base,
        ...(endedBy ? { endedBy } : {}),
        exit: after?.exit ?? before.exit,
        lastLine: after?.lastLine ?? before.lastLine,
        lastLineAt: after?.lastLineAt ?? before.lastLineAt,
        seen: endedBy !== null,
        state: endedBy ? 'stopped' : 'died',
        stop: 'none'
      }
    })
  }

  return out
}

const STATE_RANK: Record<TaskState, number> = { died: 0, waiting: 1, running: 2, failed: 3, stopped: 4, done: 5 }

const rank = (task: BgTask): number => (task.state === 'died' && task.seen ? 3 : STATE_RANK[task.state])

const SESSION_SCOPED: ReadonlySet<TaskKind> = new Set(['agent', 'pane'])

/**
 * Contract R3: two sources can describe the same worker (a sub-agent, the iT pane that runs it, the permission it
 * is waiting on). Session-scoped tasks with the same `sessionId` fold into ONE row — the first-registered source
 * leads; a `waiting` answer from any of them wins over `running`, and the newest last line wins.
 */
function mergeSessionScoped(tasks: readonly BgTask[]): BgTask[] {
  const lead = new Map<string, number>()
  const out: BgTask[] = []

  for (const task of tasks) {
    const key = task.sessionId && SESSION_SCOPED.has(task.kind) ? task.sessionId : null
    const at = key === null ? undefined : lead.get(key)

    if (at === undefined) {
      if (key !== null) {
        lead.set(key, out.length)
      }

      out.push(task)

      continue
    }

    const first = out[at]!
    const newer = (task.lastLineAt ?? -1) > (first.lastLineAt ?? -1)

    out[at] = {
      ...first,
      kind: first.kind === 'pane' ? task.kind : first.kind,
      lastLine: newer ? task.lastLine : first.lastLine,
      lastLineAt: newer ? task.lastLineAt : first.lastLineAt,
      state: task.state === 'waiting' && first.state === 'running' ? 'waiting' : first.state
    }
  }

  return out
}

/** The fold: live snapshots (in registration order) with the ledger laid over them, deduped and ordered. */
export function foldTasks(snapshots: readonly (readonly BgTask[])[], ledger: readonly LedgerEntry[]): BgTask[] {
  const remembered = new Map(ledger.map(entry => [entry.task.id, entry.task]))
  const live = snapshots.flat().filter(task => !remembered.has(task.id))
  const merged = mergeSessionScoped([...live, ...remembered.values()])

  return merged
    .map((task, index) => ({ index, task }))
    .sort((a, b) => {
      const byRank = rank(a.task) - rank(b.task)

      if (byRank !== 0) {
        return byRank
      }

      const byStart = (b.task.startedAt ?? -Infinity) - (a.task.startedAt ?? -Infinity)

      return Number.isNaN(byStart) || byStart === 0 ? a.index - b.index : byStart
    })
    .map(entry => entry.task)
}

interface TaskBadge {
  /** running + waiting — what the button's number says. */
  active: number
  /** died and not yet seen — the button's separate mark. */
  diedUnseen: number
}

export function badgeOf(tasks: readonly BgTask[]): TaskBadge {
  let active = 0
  let diedUnseen = 0

  for (const task of tasks) {
    if (isActiveTask(task)) {
      active += 1
    } else if (task.state === 'died' && !task.seen) {
      diedUnseen += 1
    }
  }

  return { active, diedUnseen }
}

// ── the ledger (one localStorage key, contract §2.4) ────────────────────────

const LEDGER_KEY = ICLONE_STORAGE.backgroundTasksLedger.key

const END_REASONS: ReadonlySet<unknown> = new Set<TaskEndReason>(['owner', 'rewind', 'session'])

const isLedgerEntry = (value: unknown): value is LedgerEntry => {
  const entry = value as Partial<LedgerEntry> | null
  const task = entry?.task as Partial<BgTask> | undefined

  return (
    typeof entry?.at === 'number' &&
    typeof task?.id === 'string' &&
    task.id.includes(':') &&
    typeof task.title === 'string' &&
    (task.state === 'died' || task.state === 'stopped') &&
    typeof task.seen === 'boolean' &&
    (task.endedBy === undefined || END_REASONS.has(task.endedBy))
  )
}

function loadLedger(): LedgerEntry[] {
  const raw = readJson<unknown>(LEDGER_KEY)

  return Array.isArray(raw) ? raw.filter(isLedgerEntry).slice(-LEDGER_CAP) : []
}

/** Keeps the newest `LEDGER_CAP`, dropping already-seen entries before unseen ones. */
function capLedger(entries: readonly LedgerEntry[]): LedgerEntry[] {
  if (entries.length <= LEDGER_CAP) {
    return [...entries]
  }

  let excess = entries.length - LEDGER_CAP

  const dropSeen = entries.filter(entry => {
    if (excess > 0 && entry.task.seen) {
      excess -= 1

      return false
    }

    return true
  })

  return dropSeen.slice(-LEDGER_CAP)
}

const $ledger = atom<LedgerEntry[]>(loadLedger())

function setLedger(next: LedgerEntry[]): void {
  const capped = capLedger(next)

  $ledger.set(capped)
  writeJson(LEDGER_KEY, capped)
}

/** The owner opened the row: it is seen (the button's mark clears), and it stays listed until dismissed. */
export function markTaskSeen(id: string): void {
  const entries = $ledger.get()

  if (entries.some(entry => entry.task.id === id && !entry.task.seen)) {
    setLedger(entries.map(entry => (entry.task.id === id ? { ...entry, task: { ...entry.task, seen: true } } : entry)))
  }
}

export function dismissTask(id: string): void {
  const entries = $ledger.get()

  if (entries.some(entry => entry.task.id === id)) {
    setLedger(entries.filter(entry => entry.task.id !== id))
  }
}

// ── the live registry ──────────────────────────────────────────────────────

const $slots = atom<Readonly<Record<string, SourceSlot>>>({})
const sources = new Map<string, TaskSource>()
/**
 * Every task the owner asked the panel to stop, kept until the task ends, whatever the verdict said meanwhile: a job
 * that outlived the 3 s window and then exits (a graceful shutdown, a slow SIGTERM handler) was ended by that ask, so
 * it reads "Stopped by you", never "Died".
 */
const ownerStopped = new Set<string>()
/** The latest Stop press per task: a verdict belongs to its own press, so a Retry is never judged on the first one's clock. */
const stopPresses = new Map<string, number>()
let pressCount = 0
let registrations = 0

const readSnapshot = (src: TaskSource): { tasks: readonly BgTask[]; error: string | null } => {
  try {
    return { error: null, tasks: src.snapshot() }
  } catch (error) {
    return { error: errorMessage(error), tasks: [] }
  }
}

function refreshSlot(src: TaskSource, order: number): void {
  const prev = $slots.get()[src.id]
  const { error, tasks } = readSnapshot(src)

  // A source that failed to read reports nothing new: its last good tasks are not "gone".
  const kept = error === null ? tasks : (prev?.tasks ?? [])
  const before = $ledger.get()
  let ledger = before

  if (prev && error === null) {
    const explainVanish = (id: BgTask['id']) => src.endReason?.(splitTaskId(id).native) ?? null
    const transitions = ledgerTransitions(prev.tasks, kept, ownerStopped, Date.now(), explainVanish)
    const ended = new Set(transitions.map(entry => entry.task.id))

    ended.forEach(id => ownerStopped.delete(id))
    ledger = [...ledger.filter(entry => !ended.has(entry.task.id)), ...transitions]
  }

  // A remembered end is a reading, not a verdict: a job its source reports active again (a lost session that came
  // back, an id that reappeared) is live, and the ledger must not hide it behind "Session ended" or "Died".
  const revived = new Set(kept.filter(isActiveTask).map(task => task.id))
  ledger = ledger.filter(entry => !revived.has(entry.task.id))

  if (ledger.length !== before.length || ledger.some((entry, index) => entry !== before[index])) {
    setLedger(ledger)
  }

  $slots.set({ ...$slots.get(), [src.id]: { error, order, tasks: kept } })
}

/**
 * V3-D registers the iT `pane` source through this; nothing else crosses fronts. Registering an id twice replaces
 * the first source. The returned function unregisters it — its tasks leave the list without being called dead.
 */
export function registerTaskSource(src: TaskSource): () => void {
  const order = (registrations += 1)

  sources.set(src.id, src)

  const off = src.subscribe(() => {
    if (sources.get(src.id) === src) {
      refreshSlot(src, order)
    }
  })

  refreshSlot(src, order)

  return () => {
    off()

    if (sources.get(src.id) !== src) {
      return
    }

    sources.delete(src.id)

    const { [src.id]: _gone, ...rest } = $slots.get()

    $slots.set(rest)
  }
}

export const $backgroundTasks = computed([$slots, $ledger], (slots, ledger) =>
  foldTasks(
    Object.values(slots)
      .sort((a, b) => a.order - b.order)
      .map(slot => slot.tasks),
    ledger
  )
)

export const $backgroundBadge = computed($backgroundTasks, badgeOf)

/** `null` until the first source reports: the panel's loading state. */
export const $taskSourceErrors = computed($slots, slots =>
  Object.keys(slots).length === 0
    ? null
    : Object.entries(slots)
        .filter(([, slot]) => slot.error !== null)
        .map(([source, slot]) => ({ detail: slot.error ?? '', source }))
)

// ── honest stop (contract §2.7) ─────────────────────────────────────────────

export const $stopAttempts = atom<Readonly<Record<string, StopAttempt>>>({})

const setAttempt = (id: string, attempt: StopAttempt | null) => {
  const { [id]: _old, ...rest } = $stopAttempts.get()

  $stopAttempts.set(attempt ? { ...rest, [id]: attempt } : rest)
}

const stillRunning = (id: string) => $backgroundTasks.get().some(task => task.id === id && task.state === 'running')

/**
 * Asks the task's own source to stop it. The row is NOT marked stopped here: it stays `running` until a snapshot
 * says otherwise, and if a reading sent `STOP_VERIFY_MS` or more after the kill still finds it running, the attempt
 * turns into "Did not stop". With no reading at all for `STOP_UNCONFIRMED_MS` it reads "Can't confirm" instead of
 * "Stopping…" forever. Whenever the job ends, before or after any verdict, the end reads as the owner's.
 */
export async function stopTask(id: string, schedule: (fn: () => void, ms: number) => void = setTimeout): Promise<void> {
  const task = $backgroundTasks.get().find(candidate => candidate.id === id)
  const { native, source } = splitTaskId(id)
  const src = sources.get(source)

  if (!task || task.stop !== 'real' || !src) {
    setAttempt(id, { detail: null, effect: 'unsupported', phase: 'failed' })

    return
  }

  const press = (pressCount += 1)
  const superseded = () => stopPresses.get(id) !== press

  stopPresses.set(id, press)
  ownerStopped.add(id)
  setAttempt(id, { detail: null, effect: 'killed', phase: 'pending' })

  schedule(() => {
    const attempt = $stopAttempts.get()[id]

    if (!superseded() && attempt?.phase === 'pending' && stillRunning(id)) {
      setAttempt(id, { ...attempt, phase: 'unconfirmed' })
    }
  }, STOP_UNCONFIRMED_MS)

  let result: StopResult

  try {
    result = await src.stop(native)
  } catch (error) {
    result = { detail: errorMessage(error), effect: 'killed', ok: false }
  }

  if (!result.ok || result.effect === 'unsupported') {
    setAttempt(id, { detail: result.detail ?? null, effect: result.effect, phase: 'failed' })

    return
  }

  const verify = async () => {
    if (superseded()) {
      return
    }

    const fresh = src.reread ? await src.reread(native) : true

    if (superseded()) {
      return
    }

    // No reading could be taken: nothing is known yet, so ask again rather than guess. It ends when a reading
    // lands or the task leaves the list; each try is one read, slower than the source's own poll.
    if (!fresh && stillRunning(id)) {
      schedule(() => void verify(), STOP_VERIFY_MS)

      return
    }

    stopPresses.delete(id)

    if (!stillRunning(id)) {
      setAttempt(id, null)

      return
    }

    setAttempt(id, { detail: result.detail ?? null, effect: result.effect, phase: 'failed' })
  }

  schedule(() => void verify(), STOP_VERIFY_MS)
}

/** Tests only: the registry is module state. */
export function resetBackgroundTasksForTests(): void {
  sources.clear()
  ownerStopped.clear()
  stopPresses.clear()
  registrations = 0
  $slots.set({})
  $stopAttempts.set({})
  $ledger.set(loadLedger())
}
