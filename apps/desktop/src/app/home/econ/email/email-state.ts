/**
 * Email — the owner's own marks on this iNFT's mailbox: read and unread,
 * Archive, Trash and Delete forever.
 *
 * The ACP CLI can do none of these (1.0.38 has no mark-read, delete, archive
 * or move, and the service's `archive` / `trash` folders answer HTTP 500), so
 * every mark is iclone os's own, kept on this computer, one state per iNFT.
 * The mail service never changes, and the app says so.
 *
 * Everything but the two storage helpers at the end is pure: rows and state
 * in, rows and a NEW state out — or the very same state when nothing changed,
 * so React skips the render and nothing is written.
 *
 * Read marks — local wins, and a mark exists only while it disagrees with the
 * service. Marking read a message the service calls unread stores the mark,
 * and later pages that still say unread keep showing it read (the same for
 * unread over read). Marking one the service already agrees with stores
 * nothing and drops any older mark — so a message the owner left unread while
 * the service also said unread follows the service once someone (the agent)
 * reads it: that read is newer than the owner's last touch.
 *
 * Places — a message is in the mailbox, archived, trashed (Trash wins over
 * Archive, and Restore returns it to where it was) or purged: deleted
 * forever, shown nowhere until the owner brings it back. The service still
 * holds every purged message, so the folders count what they hide
 * (`purgedRows`) and Recover returns those to the mailbox; a `recovered`
 * mark newer than the purge is what keeps an older copy from purging it
 * again.
 *
 * Bounded — past MAIL_STATE_MAX entries the oldest go first: read marks, then
 * archive and trash marks. Purged ids go only when they alone pass the cap, so
 * mail deleted forever does not come back on a refresh.
 *
 * On disk, twice: localStorage `iclone.email.state.<slug>` (the fast copy the
 * first paint reads) and the main process's `<userData>/inft/<slug>/
 * email-state.json` (the copy a cache clear or profile reset cannot touch):
 *   { v: 1, w: writtenAt, read: { [id]: [read, at] }, archived: { [id]: at },
 *     trashed: { [id]: at }, purged: { [id]: at }, recovered?: { [id]: at } }
 * Every open unions the two (`mergeMailStates`) and writes the union back to
 * whichever copy lacked something, so a mail deleted forever stays deleted.
 */
import { readJson, writeKey } from '@/lib/storage'

import { ICLONE_STORAGE } from '../../lib/storage-keys'
import { asRecord } from '../cli'

// ── types ───────────────────────────────────────────────────────────────────

export type MailFolder = 'archive' | 'inbox' | 'sent' | 'spam' | 'trash' | 'unread'
export type MailPlace = 'archive' | 'mailbox' | 'purged' | 'trash'
/** What a move does: `inbox` takes a message out of Archive, `restore` out of
 *  Trash, `recover` out of deleted forever (back to the mailbox). */
export type MailMove = 'archive' | 'inbox' | 'purge' | 'recover' | 'restore' | 'trash'

/** What the state reads of a row — every `MailMessage` is one. */
export interface MarkableRow {
  id: string
  direction: 'inbound' | 'outbound'
  isRead: boolean
  /** Epoch ms; 0 when undated. */
  at: number
}

interface ReadMark {
  read: boolean
  /** Epoch ms the owner set it — what the bound evicts by. */
  at: number
}

export interface MailState {
  readonly read: ReadonlyMap<string, ReadMark>
  /** id → epoch ms, for the three below. */
  readonly archived: ReadonlyMap<string, number>
  readonly trashed: ReadonlyMap<string, number>
  readonly purged: ReadonlyMap<string, number>
  /** Purged ids the owner brought back: a tombstone over the purge. */
  readonly recovered: ReadonlyMap<string, number>
}

/** The rows a folder can be drawn from. */
export interface MailPools<T> {
  /** The default server list, every page loaded (inbox + outbound). */
  base: readonly T[]
  /** The spam list, when it was read. */
  spam?: readonly T[]
  /** Rows the owner moved from search results that no loaded page holds. */
  adopted?: readonly T[]
}

export const MAIL_STATE_VERSION = 1
const MAIL_STATE_MAX = 5000

const KEY_PREFIX = ICLONE_STORAGE.emailState.key
const ID_MAX = 256

export const EMPTY_MAIL_STATE: MailState = {
  read: new Map(),
  archived: new Map(),
  trashed: new Map(),
  purged: new Map(),
  recovered: new Map()
}

export function mailStateKey(slug: string): string {
  return `${KEY_PREFIX}${slug}`
}

// ── reading ─────────────────────────────────────────────────────────────────

export function placeOf(state: MailState, id: string): MailPlace {
  if (state.purged.has(id)) {
    return 'purged'
  }

  if (state.trashed.has(id)) {
    return 'trash'
  }

  return state.archived.has(id) ? 'archive' : 'mailbox'
}

/** The agent's own mail is never unread. */
export function isUnread(row: Pick<MarkableRow, 'direction' | 'isRead'>): boolean {
  return row.direction === 'inbound' && !row.isRead
}

// One flipped copy per row object: a row keeps its identity across renders,
// so a memoised row renders again only when its read state really moves.
const flipped = new WeakMap<MarkableRow, MarkableRow>()

/** The row as the owner sees it: the service's row, or its read-flipped copy. */
export function withRead<T extends MarkableRow>(state: MailState, row: T): T {
  const mark = state.read.get(row.id)

  if (!mark || mark.read === row.isRead) {
    return row
  }

  const known = flipped.get(row)

  if (known) {
    // Only ever stored below, from this very row: same shape, `isRead` flipped.
    return known as T
  }

  const copy: T = { ...row, isRead: mark.read }

  flipped.set(row, copy)

  return copy
}

export function newestFirst<T extends { at: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.at - a.at)
}

/** Every row once, first sighting wins — a list may repeat what another holds. */
function uniqueRows<T extends MarkableRow>(lists: ReadonlyArray<readonly T[]>): T[] {
  const seen = new Set<string>()
  const rows: T[] = []

  for (const list of lists) {
    for (const row of list) {
      if (!seen.has(row.id)) {
        seen.add(row.id)
        rows.push(row)
      }
    }
  }

  return rows
}

function shownWhere<T extends MarkableRow>(state: MailState, rows: readonly T[], keep: (row: T) => boolean): T[] {
  const shown: T[] = []

  for (const row of rows) {
    const seen = withRead(state, row)

    if (keep(seen)) {
      shown.push(seen)
    }
  }

  return shown
}

const MAILBOX_VIEW: Record<'inbox' | 'sent' | 'unread', (row: MarkableRow) => boolean> = {
  inbox: row => row.direction === 'inbound',
  sent: row => row.direction === 'outbound',
  unread: isUnread
}

/**
 * The rows a folder shows, read marks applied. Inbox / Unread / Sent are views
 * of the default list and Spam its own list — each without what the owner
 * moved out. Archive and Trash gather every list (newest first); archived mail
 * sent to Trash is in Trash only.
 */
export function folderRows<T extends MarkableRow>(state: MailState, pools: MailPools<T>, folder: MailFolder): T[] {
  switch (folder) {
    case 'archive':

    case 'trash':
      return newestFirst(
        shownWhere(state, uniqueRows([pools.base, pools.spam ?? [], pools.adopted ?? []]), row => {
          return placeOf(state, row.id) === folder
        })
      )

    case 'spam':
      return shownWhere(state, pools.spam ?? [], row => placeOf(state, row.id) === 'mailbox')
    default: {
      const view = MAILBOX_VIEW[folder]

      return shownWhere(state, pools.base, row => placeOf(state, row.id) === 'mailbox' && view(row))
    }
  }
}

/** Search results, read marks applied: archived mail is still found (that is
 *  what Archive is for); trashed and purged mail is not. */
export function searchRows<T extends MarkableRow>(state: MailState, rows: readonly T[]): T[] {
  return shownWhere(state, rows, row => {
    const place = placeOf(state, row.id)

    return place === 'mailbox' || place === 'archive'
  })
}

/** Archived (or trashed) ids no loaded list holds — mail on older pages, or
 *  gone from the service. Zero means the folder shows all it has. */
export function unloadedCount<T extends MarkableRow>(
  state: MailState,
  pools: MailPools<T>,
  place: 'archive' | 'trash'
): number {
  const loaded = new Set(uniqueRows([pools.base, pools.spam ?? [], pools.adopted ?? []]).map(row => row.id))
  const marks = place === 'trash' ? state.trashed : state.archived
  let missing = 0

  for (const id of marks.keys()) {
    if (!loaded.has(id) && placeOf(state, id) === place) {
      missing += 1
    }
  }

  return missing
}

/**
 * Loaded rows this folder would show were they not deleted forever — the
 * service still sends them, so an empty folder is not "nothing arrived".
 * Trash counts every purged row (Delete forever is offered only there);
 * Archive counts none: an archive mark goes with the purge.
 */
export function purgedRows<T extends MarkableRow>(state: MailState, pools: MailPools<T>, folder: MailFolder): T[] {
  if (state.purged.size === 0 || folder === 'archive') {
    return []
  }

  const gone = (row: T) => state.purged.has(row.id)

  switch (folder) {
    case 'trash':
      return uniqueRows([pools.base, pools.spam ?? [], pools.adopted ?? []]).filter(gone)

    case 'spam':
      return (pools.spam ?? []).filter(gone)
    default: {
      const view = MAILBOX_VIEW[folder]

      return pools.base.filter(row => gone(row) && view(withRead(state, row)))
    }
  }
}

// ── changes ─────────────────────────────────────────────────────────────────

/**
 * Read or unread, by the owner. `rows` are the SERVICE's rows (their `isRead`
 * is what the service said): a mark is stored only where it disagrees, and
 * dropped where the service already agrees. Purged ids are left alone.
 */
export function setRead(
  state: MailState,
  rows: ReadonlyArray<Pick<MarkableRow, 'id' | 'isRead'>>,
  read: boolean,
  at: number
): MailState {
  let next: Map<string, ReadMark> | null = null

  for (const row of rows) {
    if (state.purged.has(row.id)) {
      continue
    }

    const mark = state.read.get(row.id)

    if (row.isRead === read) {
      if (mark) {
        next ??= new Map(state.read)
        next.delete(row.id)
      }
    } else if (mark?.read !== read) {
      next ??= new Map(state.read)
      next.set(row.id, { read, at })
    }
  }

  return next ? boundMailState({ ...state, read: next }) : state
}

type Marks = 'archived' | 'trashed'

function addMarks(state: MailState, key: Marks, ids: readonly string[], at: number): MailState {
  let next: Map<string, number> | null = null

  for (const id of ids) {
    if (!state[key].has(id) && !state.purged.has(id)) {
      next ??= new Map(state[key])
      next.set(id, at)
    }
  }

  return next ? boundMailState({ ...state, [key]: next }) : state
}

function dropMarks(state: MailState, key: Marks, ids: readonly string[]): MailState {
  if (!ids.some(id => state[key].has(id))) {
    return state
  }

  const next = new Map(state[key])

  ids.forEach(id => next.delete(id))

  return { ...state, [key]: next }
}

/** Deleted forever: every other mark for the id goes with it. */
function purge(state: MailState, ids: readonly string[], at: number): MailState {
  const fresh = ids.filter(id => !state.purged.has(id))

  if (fresh.length === 0) {
    return state
  }

  const read = new Map(state.read)
  const archived = new Map(state.archived)
  const trashed = new Map(state.trashed)
  const purged = new Map(state.purged)
  const recovered = new Map(state.recovered)

  for (const id of fresh) {
    read.delete(id)
    archived.delete(id)
    trashed.delete(id)
    recovered.delete(id)
    purged.set(id, at)
  }

  return boundMailState({ read, archived, trashed, purged, recovered })
}

/** Back from deleted forever, into the mailbox the service still fills. */
function recover(state: MailState, ids: readonly string[], at: number): MailState {
  const back = ids.filter(id => state.purged.has(id))

  if (back.length === 0) {
    return state
  }

  const purged = new Map(state.purged)
  const recovered = new Map(state.recovered)

  for (const id of back) {
    purged.delete(id)
    recovered.set(id, at)
  }

  return boundMailState({ ...state, purged, recovered })
}

const MOVES: Record<MailMove, (state: MailState, ids: readonly string[], at: number) => MailState> = {
  archive: (state, ids, at) => addMarks(state, 'archived', ids, at),
  inbox: (state, ids) => dropMarks(state, 'archived', ids),
  purge,
  recover,
  restore: (state, ids) => dropMarks(state, 'trashed', ids),
  trash: (state, ids, at) => addMarks(state, 'trashed', ids, at)
}

export function moveMail(state: MailState, move: MailMove, ids: readonly string[], at: number): MailState {
  return MOVES[move](state, ids, at)
}

/** Every trashed message, deleted forever — loaded or not. */
export function emptyTrash(state: MailState, at: number): MailState {
  return purge(state, [...state.trashed.keys()], at)
}

function revertEntries<V>(now: ReadonlyMap<string, V>, then: ReadonlyMap<string, V>, ids: readonly string[]) {
  let next: Map<string, V> | null = null

  for (const id of ids) {
    const was = then.get(id)

    if (now.get(id) === was) {
      continue
    }

    next ??= new Map(now)

    if (was === undefined) {
      next.delete(id)
    } else {
      next.set(id, was)
    }
  }

  return next ?? now
}

/** Undo: these ids go back to what `before` held for them; every other mark
 *  made since (a message opened meanwhile) stays. */
export function revertMarks(state: MailState, before: MailState, ids: readonly string[]): MailState {
  const next: MailState = {
    read: revertEntries(state.read, before.read, ids),
    archived: revertEntries(state.archived, before.archived, ids),
    trashed: revertEntries(state.trashed, before.trashed, ids),
    purged: revertEntries(state.purged, before.purged, ids),
    recovered: revertEntries(state.recovered, before.recovered, ids)
  }

  const same =
    next.read === state.read &&
    next.archived === state.archived &&
    next.trashed === state.trashed &&
    next.purged === state.purged &&
    next.recovered === state.recovered

  return same ? state : boundMailState(next)
}

// ── the bound ───────────────────────────────────────────────────────────────

interface Evictable {
  at: number
  drop: () => void
}

/** Drops the oldest `excess` entries of a tier; what is left to drop after it. */
function evict(tier: Evictable[], excess: number): number {
  tier
    .sort((a, b) => a.at - b.at)
    .slice(0, excess)
    .forEach(entry => entry.drop())

  return Math.max(0, excess - tier.length)
}

function entriesOf<V>(map: Map<string, V>, at: (value: V) => number): Evictable[] {
  return [...map].map(([id, value]) => ({ at: at(value), drop: () => map.delete(id) }))
}

/** At most `max` entries in all: read marks go first, then archive, trash and
 *  recovered marks, purged ids last — oldest first within each tier. */
export function boundMailState(state: MailState, max = MAIL_STATE_MAX): MailState {
  const total = entryCount(state)

  if (total <= max) {
    return state
  }

  const read = new Map(state.read)
  const archived = new Map(state.archived)
  const trashed = new Map(state.trashed)
  const purged = new Map(state.purged)
  const recovered = new Map(state.recovered)
  const byTime = (at: number) => at

  let excess = evict(
    entriesOf(read, mark => mark.at),
    total - max
  )

  excess = evict(
    [...entriesOf(archived, byTime), ...entriesOf(trashed, byTime), ...entriesOf(recovered, byTime)],
    excess
  )
  evict(entriesOf(purged, byTime), excess)

  return { read, archived, trashed, purged, recovered }
}

function entryCount(state: MailState): number {
  return state.read.size + state.archived.size + state.trashed.size + state.purged.size + state.recovered.size
}

/** A purge and a recovery of one id: the later word wins, and only it is kept. */
function settlePurges(
  purged: ReadonlyMap<string, number>,
  recovered: ReadonlyMap<string, number>
): { purged: Map<string, number>; recovered: Map<string, number> } {
  const outPurged = new Map(purged)
  const outRecovered = new Map(recovered)

  for (const [id, at] of recovered) {
    const purgedAt = purged.get(id)

    if (purgedAt === undefined) {
      continue
    }

    if (at >= purgedAt) {
      outPurged.delete(id)
    } else {
      outRecovered.delete(id)
    }
  }

  return { purged: outPurged, recovered: outRecovered }
}

// ── storage ─────────────────────────────────────────────────────────────────

function validId(id: string): boolean {
  return id.length > 0 && id.length <= ID_MAX
}

function validAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function storedTimes(value: unknown, purged?: ReadonlyMap<string, number>): Map<string, number> {
  const times = new Map<string, number>()

  for (const [id, at] of Object.entries(asRecord(value) ?? {})) {
    if (validId(id) && validAt(at) && !purged?.has(id)) {
      times.set(id, at)
    }
  }

  return times
}

/** A stored state back into memory — storage is outside the app, so only
 *  well-formed entries get in; anything else (another version) is empty. */
export function parseMailState(raw: unknown): MailState {
  const root = asRecord(raw)

  if (!root || root.v !== MAIL_STATE_VERSION) {
    return EMPTY_MAIL_STATE
  }

  const { purged, recovered } = settlePurges(storedTimes(root.purged), storedTimes(root.recovered))
  const read = new Map<string, ReadMark>()

  for (const [id, value] of Object.entries(asRecord(root.read) ?? {})) {
    if (validId(id) && !purged.has(id) && Array.isArray(value) && typeof value[0] === 'boolean' && validAt(value[1])) {
      read.set(id, { read: value[0], at: value[1] })
    }
  }

  return boundMailState({
    read,
    archived: storedTimes(root.archived, purged),
    trashed: storedTimes(root.trashed, purged),
    purged,
    recovered
  })
}

/** The stored shape; `writtenAt` (epoch ms) stamps the copy for `mergeMailStates`. */
export function mailStateRecord(state: MailState, writtenAt?: number): Record<string, unknown> {
  return {
    v: MAIL_STATE_VERSION,
    ...(writtenAt === undefined ? {} : { w: writtenAt }),
    read: Object.fromEntries([...state.read].map(([id, mark]) => [id, [mark.read, mark.at]])),
    archived: Object.fromEntries(state.archived),
    trashed: Object.fromEntries(state.trashed),
    purged: Object.fromEntries(state.purged),
    ...(state.recovered.size === 0 ? {} : { recovered: Object.fromEntries(state.recovered) })
  }
}

export function serializeMailState(state: MailState, writtenAt?: number): string {
  return JSON.stringify(mailStateRecord(state, writtenAt))
}

/** Same marks, whatever the copy's stamp. */
export function sameMailState(a: MailState, b: MailState): boolean {
  return a === b || serializeMailState(a) === serializeMailState(b)
}

/** A stored copy with the time it was written (null: an unstamped, older copy). */
interface StampedMailState {
  state: MailState
  writtenAt: null | number
}

/** @public — read by the R3d harness probes (RESUME/run/gates/R3d/extra). */
export function parseStampedMailState(raw: unknown): StampedMailState {
  const stamp = asRecord(raw)?.w

  return { state: parseMailState(raw), writtenAt: validAt(stamp) ? stamp : null }
}

function unionTimes(
  newer: ReadonlyMap<string, number>,
  older: ReadonlyMap<string, number>,
  keep: (at: number) => boolean
): Map<string, number> {
  const out = new Map(newer)

  for (const [id, at] of older) {
    if (!out.has(id) && keep(at)) {
      out.set(id, at)
    }
  }

  return out
}

/**
 * Two copies of one iNFT's marks into one. Deleted forever is a union, always
 * — no copy can bring a purged mail back but the owner's own Recover, a mark
 * newer than the purge (the later of the two wins) — and a purged id drops
 * every other mark. Archive, Trash and read marks are a union too, except that when both
 * copies are stamped a mark only the OLDER copy holds, set before the newer
 * copy was written, is one the owner since took back (Restore, Move to Inbox,
 * mark unread) and stays gone. Trash over Archive is `placeOf`'s rule.
 */
export function mergeMailStates(a: StampedMailState, b: StampedMailState): MailState {
  const stamped = a.writtenAt !== null && b.writtenAt !== null
  const [newer, older] = stamped && (b.writtenAt ?? 0) > (a.writtenAt ?? 0) ? [b, a] : [a, b]
  const cutoff = stamped ? (newer.writtenAt ?? 0) : Number.NEGATIVE_INFINITY
  const keep = (at: number) => at > cutoff

  const latest = (x: ReadonlyMap<string, number>, y: ReadonlyMap<string, number>) => {
    const out = new Map(x)

    for (const [id, at] of y) {
      out.set(id, Math.max(at, out.get(id) ?? at))
    }

    return out
  }

  const { purged, recovered } = settlePurges(
    latest(a.state.purged, b.state.purged),
    latest(a.state.recovered, b.state.recovered)
  )

  const notPurged = <V>(map: Map<string, V>) => new Map([...map].filter(([id]) => !purged.has(id)))
  const read = new Map(newer.state.read)

  for (const [id, mark] of older.state.read) {
    const held = read.get(id)

    if (held ? mark.at > held.at : keep(mark.at)) {
      read.set(id, mark)
    }
  }

  const merged: MailState = {
    read: notPurged(read),
    archived: notPurged(unionTimes(newer.state.archived, older.state.archived, keep)),
    trashed: notPurged(unionTimes(newer.state.trashed, older.state.trashed, keep)),
    purged,
    recovered
  }

  return sameMailState(merged, a.state) ? a.state : boundMailState(merged)
}

function isEmpty(state: MailState): boolean {
  return entryCount(state) === 0
}

/** Absent, unreadable or malformed state parses as empty. */
export function readMailState(slug: string): MailState {
  return parseMailState(readJson<unknown>(mailStateKey(slug)))
}

/** The localStorage copy with its stamp — what an open merges the file into. */
export function readStampedMailState(slug: string): StampedMailState {
  return parseStampedMailState(readJson<unknown>(mailStateKey(slug)))
}

function emailStateBridge() {
  return typeof window === 'undefined' ? undefined : window.hermesDesktop?.icloneAcp?.emailState
}

/** Writes to the file go one after another per iNFT, in commit order. */
const fileWrites = new Map<string, Promise<unknown>>()

function saveMailStateFile(slug: string, state: MailState, writtenAt: number): void {
  const bridge = emailStateBridge()

  if (!bridge) {
    return
  }

  const record = mailStateRecord(state, writtenAt)
  const next = (fileWrites.get(slug) ?? Promise.resolve()).then(() => bridge.save(slug, record)).catch(() => undefined)

  fileWrites.set(slug, next)
  void next.then(() => fileWrites.get(slug) === next && fileWrites.delete(slug))
}

/** Best-effort, both copies: when localStorage is full or unavailable the
 *  file still holds the marks (and memory, for this session). An empty state
 *  is kept as a stamped empty copy in both, never a removed key: an older
 *  copy (a file save that failed) can then never bring a taken-back mark back. */
export function writeMailState(slug: string, state: MailState, now = Date.now()): void {
  writeKey(mailStateKey(slug), serializeMailState(state, now))
  saveMailStateFile(slug, state, now)
}

/**
 * The file copy, merged into `current` (what the window shows, built from
 * localStorage). Resolves to the merged state, or `current` itself when the
 * file adds nothing. A missing or corrupt file (and an unequal one) is
 * rewritten from the merge; without the bridge (tests, the web) nothing
 * happens.
 */
export async function reconcileMailStateFile(slug: string, current: MailState): Promise<MailState> {
  const bridge = emailStateBridge()

  if (!bridge) {
    return current
  }

  const answer = await bridge.load(slug).catch(() => null)

  if (!answer?.ok) {
    return current
  }

  const local: StampedMailState = { ...readStampedMailState(slug), state: current }
  const file = answer.value ? parseStampedMailState(answer.value) : null
  const merged = file ? mergeMailStates(local, file) : current

  if (!file || !sameMailState(merged, file.state)) {
    saveMailStateFile(slug, merged, Date.now())
  }

  return merged
}

/**
 * Both copies of one iNFT's marks brought level outside the Email window (the
 * dock's warm-up): the file gets what only localStorage holds, and
 * localStorage gets back what only the file holds (a cleared cache).
 * localStorage is read AFTER the file answers, so a mark committed meanwhile
 * is merged, never overwritten. Resolves to the merged marks, or null when
 * the file cannot be read (tests, the web, a failed bridge).
 */
export async function mirrorMailStateFile(slug: string): Promise<MailState | null> {
  const bridge = emailStateBridge()

  if (!bridge) {
    return null
  }

  const answer = await bridge.load(slug).catch(() => null)

  if (!answer?.ok) {
    return null
  }

  const local = readStampedMailState(slug)
  const file = answer.value ? parseStampedMailState(answer.value) : null
  const merged = file ? mergeMailStates(local, file) : local.state
  const now = Date.now()

  if (file ? !sameMailState(merged, local.state) : false) {
    writeKey(mailStateKey(slug), serializeMailState(merged, now))
  }

  if (file ? !sameMailState(merged, file.state) : !isEmpty(merged)) {
    saveMailStateFile(slug, merged, now)
  }

  return merged
}

/** Every iNFT whose marks localStorage holds (the slug is the key's suffix). */
function storedMailSlugs(): string[] {
  const slugs: string[] = []

  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)

      if (key?.startsWith(KEY_PREFIX) && key.length > KEY_PREFIX.length) {
        slugs.push(key.slice(KEY_PREFIX.length))
      }
    }
  } catch {
    // Storage unavailable: the file copies are all there is.
  }

  return slugs
}

let mirroredAll: null | Promise<void> = null

/** Once per session, at the dock's warm-up: every iNFT's localStorage marks
 *  reach its file, not only the iNFTs whose Email was opened, so a later
 *  cache clear loses no tombstone. A pass where any iNFT's file could not be
 *  read is forgotten, so the next warm-up tries again. */
export function mirrorAllMailStateFiles(): Promise<void> {
  if (mirroredAll) {
    return mirroredAll
  }

  const pass: Promise<void> = Promise.all(
    storedMailSlugs().map(slug =>
      mirrorMailStateFile(slug).then(
        merged => merged !== null,
        () => false
      )
    )
  ).then(done => {
    if (!done.every(Boolean) && mirroredAll === pass) {
      mirroredAll = null
    }
  })

  mirroredAll = pass

  return pass
}

/** Tests: the next warm-up mirrors every iNFT again. */
export function resetMailStateMirror(): void {
  mirroredAll = null
}
