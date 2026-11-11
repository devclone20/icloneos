/**
 * V3-G F7 — hard links into a project. Seatbelt judges a path, not an inode: a file inside the project that is a
 * second name for an inode outside it (planted by any unconfined writer, or left by `git clone --local` or a package
 * store) is read and written through the project's own rules. The profile refuses to make one (`deny file-link`,
 * sbpl.ts); this module finds the ones that already exist, before a confined run starts, and confinement refuses to
 * start for that root until each is removed or the owner allows it.
 *
 * A link only matters when one of its names lies outside the root: an inode whose every name was seen inside the
 * project (`st_nlink` == names found) is the project's own. The full scan stats every file, so its answer is cached
 * per root behind a cheap fingerprint: every directory's inode, mtime and ctime. Planting a name anywhere in the
 * tree changes its directory's ctime, which no user call can set back (`utimes` moves it too), so a planted link
 * always misses the cache. A name made OUTSIDE for an inside inode moves no inside mtime; the cache is bounded by age
 * for it, and the data it shares came from the project anyway.
 *
 * v0.0.7 V-1: none of it runs synchronously on main's thread (a 123 GB project held the thread 5 s per command). The
 * walk is asynchronous and bounded in flight; the fingerprint is one `lstat` per directory, and a directory whose
 * fingerprint is unchanged keeps its listing, so a changed tree lists only the directories that changed. That answer
 * stands only when it finds exactly the linked inodes the last one did; a new or vanished link, or a folder that
 * cannot be listed, is decided by the full scan, as before. A start waits for the check at most
 * `HARDLINK_CHECK_DEADLINE_MS` and is refused past it (fail closed); the walk goes on and the next start reads it.
 * v0.0.7 CF1: every FULL scan (the first, and the background refresh) runs in a worker thread (hardlinks-walker.ts,
 * hardlinks-walk.ts): main's loop was ~96 % busy for a scan's whole length folding 300 000 `lstat` callbacks. A
 * worker that fails rejects the scan (the start is refused, never ok). No step of a check calls a synchronous
 * function (realpath included: under disk contention one held main for a second).
 * v0.0.7 item 4: while the root's FIRST full scan is still reaching new folders (within 5 s), the start waits up to
 * `HARDLINK_FIRST_SCAN_DEADLINE_MS` (120 s) instead; a stalled or longer scan is refused as before.
 *
 * v0.0.7 V-1b: where that walk costs more than proving delivery (a tree of hundreds of thousands of folders), a
 * macOS FSEvents stream per root says which directories changed (hardlinks-fsevents.ts, over our own addon: a
 * stream FSEvents did not take throws, v0.0.7 FSEV). The stream is registered with fseventsd before the walk it
 * covers begins, so every change the walk could miss is an event the stream gets; any loss flag
 * (MustScanSubDirs, dropped, ids wrapped, root changed, mount), a path outside the root, a stream error or too many
 * dirty folders voids it, and the next check walks as above. A check then waits for the barrier (a canary written
 * after the check began, delivered on the root's OWN stream: every earlier change to the root has been delivered;
 * a stream that died without a signal never delivers it, and the root is walked), re-lists only the dirty directories (a folder whose identity changed is walked whole),
 * and that answer stands under the same rule as the walk's: no unscannable folder and exactly the same linked
 * inodes, else the walk and the full scan decide. No dirty folder and a healthy stream: the cached answer, with no
 * directory walked. A root on another kind of volume (only a local APFS or HFS+ mount, judged by the filesystem's
 * type NAME, reports every change), or spanning two devices, is always walked; so is every root while the addon
 * cannot load (not macOS, or a load error).
 *
 * The barrier rests on two properties of FSEvents, measured (FSEV_handoff.md) and not only assumed: ids follow the
 * order the kernel queued the changes, and one stream delivers its events in id order (checked: a stream whose ids
 * go back is voided). The 0.14 s barrier limit of V-1b is gone.
 *
 * TWO SCAN MODES, TWO ROLES (CF5, critic B3-M1; lead decision 10 Nov 19:10Z). The rule every full scan obeys:
 *   - a BACKGROUND refresh is slow and cheap (the worker's paced synchronous walk in hardlinks-walk.ts:
 *     one call at a time and a rest after each slice, about a quarter of a core while it runs), and it runs only
 *     while no command is waiting on it;
 *   - a scan a COMMAND needs (the first scan of a root, a root with no healthy stream, a cached answer past the age
 *     bound: after a Mac sleep or a long idle the clock jumps and the scheduled refresh has not run) is always full
 *     speed (the worker's parallel walk). If a background refresh of that root is already running, it is PROMOTED:
 *     the paced worker is aborted at once (it rests in steps of at most 50 ms) and a full-speed walk replaces it.
 *     A command never waits on the throttled walk.
 * So a check after the bound costs one fast scan (~5 s on the owner's 520k-folder tree; the paced one took 47 s and
 * the 30 s start deadline refused it), and the idle CPU is the background refresh's alone.
 *
 * THE TREE LIVES IN THE WORKER (CF7, critic rounds B-M1, B4-M1, B5-M1: each pass found a new cost the size of the
 * tree on main's thread — the walk, the install, the copy for a dirty re-list, the fold over the copy — because the
 * records were main's). Main holds, per root, only a SUMMARY (hardlinks-walk.ts TreeScan: the linked inodes, the
 * unscannable folders, the counts, one-volume) behind a `TreeResident` handle (hardlinks-walker.ts). The worker that
 * walked a root keeps its records and answers two updates with a verdict the size of the change: `apply` (the dirty
 * folders the stream named, re-listed: V-1b) and `walk` (every folder stat-ed there: V-1). The invariants:
 *   I1  no path of this guard is O(folders) on main: a cached check, a dirty check, a post-exit (T3) check, an
 *       acknowledgement, a page of a group, a refresh's install and a first scan's install each cost main O(dirty
 *       folders) or O(linked inodes), never O(tree). The records never cross to main (the guard never calls
 *       `dump`; hardlinks.async.test.ts proves it structurally; the PERF.main.paths gate measures it on 520 000
 *       folders). A tree of at most IN_PROCESS_MAX_DIRS folders is held in process instead: bounded, so O(1).
 *   I2  a resident's summary is always its last STANDING answer (hardlinks-walk.ts TreeState): an update that does not stand
 *       (a new or vanished link, an unscannable folder, a folder it cannot place) changes nothing, and a full scan
 *       decides, replacing the resident whole. Never a partial tree: a scan is a resident only after its `done`;
 *       aborted, failed or exited before that, it rejects.
 *   I3  a dead tree never answers an UPDATE: `apply` and `walk` reject, the root's answer is dropped (counted and
 *       said through `onTreeDropped`, A3-m2) and a full scan decides, or the start is refused. A check that finds
 *       nothing dirty behind a proven barrier still answers from the last standing summary (A3-m1): that summary is
 *       the last full scan plus every standing update, and the barrier proves nothing moved since, the same
 *       semantics as v0.0.6's cached records; the first dirty folder then goes to the full scan.
 *   I6  (round 2, B6-M1) an in-process tree walks at most IN_PROCESS_MAX_DIRS folders in any update: past that it
 *       stops (`TreeOutgrown`), is dropped like a dead tree, and the root's next scan runs in a worker, which keeps
 *       it. PERF.main.grow holds main's stalls < 50 ms while a 300-folder root grows past 100 000.
 *   I7  (round 2, B6-m3, B6-n1; M3) memory and idleness are bounded. A worker tree costs ~650 B per folder plus
 *       ~10 MB for its thread (PERF.mem.bytes_per_dir; ~340 MB for the owner's 520 101 folders); together they hold
 *       at most residentDirsBudgetFor(os.totalmem()) folder-equivalents (1/16 of the Mac's memory, 300 000..1 500 000).
 *       Past it the least recently CHECKED roots are released whole (`releaseRoot`: tree, stream, refresh timer,
 *       running refresh); a root with a check in flight is released when its queue settles, never under it. A root
 *       not checked for IDLE_RELEASE_MS (a prewarm counts, the pane's re-measure does not) is released the same way,
 *       at its refresh tick or at any other root's check (walked roots too). A released root answers nothing: its
 *       next check scans at full speed inside the start's deadline, else the start is refused (the dead-tree path of
 *       I3); the pane's re-measure (`recheckBlocked`) never scans it back. Declared: the root being scanned is never
 *       released for it (peak = budget + that tree), and one root whose walk worker passes WALK_WORKER_HEAP_MB
 *       (hardlinks-walker.ts, 4 096 MB: ~6M folders) kills only that worker: its check rejects and the start is
 *       refused, the app runs on (PERF.mem holds the rest on three 520 000-folder roots).
 *   I4  the incremental summary equals the full fold of the same records (hardlinks.tree.test.ts, random change
 *       sets over many seeds): `apply` and `walk` give the answer a full scan of the same tree would.
 *   I5  everything A2 holds still holds: the age bound is re-checked after any wait, from the START of the walk
 *       whose resident answers; the tap is made before the walk and is dirty at install; an older scan never
 *       replaces a newer resident; a waited-on refresh has a stall bound; a command never waits on the paced walk;
 *       T3 counts the exit's whole millisecond against the ctimes the resident reports.
 *
 * DECLARED LIMIT (age bound, adaptive, CF4 B2-m3): the bound exists only for names made OUTSIDE the root for an inside
 * inode (no inside directory and no stream event moves for them). On a stream-backed root the background refresh
 * runs every interval = max(4 min, 10 x the last background scan's length), start to start; the bound is
 * max(5 min, interval + 2 x that length), so the scheduled scan completes inside it and a check normally never needs
 * a scan of its own. Before a root's first background scan completes, its length is estimated as 12 x its last full
 * scan. The bound is capped at 30 min (and the interval shrinks to keep 2 scan lengths inside it), and the interval
 * never falls below 3 x the scan length (CF5, B3-n4): at least 2 scan lengths of idle between two background
 * refreshes, so on a tree over ~8x the owner's they never run back to back. Past that point (a background scan over
 * 6 min) the bound gives way instead: a check past it runs its own full-speed scan inside the start's deadline (or is
 * refused, fail closed, and the next start reads the scan). PERF.idle.cpu measures the refresh on the 300 000-file
 * fixture and projects it linearly per folder to the owner's 520 101 folders: ~3 % of one core averaged over its
 * interval (target < 5 %); PERF.after_sleep.check moves the guard's clock past the bound and holds the answer
 * < 10 s. A check past the interval starts the background refresh at once (and does not wait for it). A walked root
 * (no stream) has no background scan: its bound follows the same rule from its own last full scan. The cached answer
 * is the last completed scan's result with every folder named since its start left dirty. `prewarm` starts a root's
 * first scan (full speed) and stream when its Hermes is spawned.
 *
 * Fail closed (r3 T1): a directory inside the root that cannot be listed hides whatever it holds, while a process
 * needs only `x` to traverse it. Unlistable is not unreadable: such a root is refused ("cannot scan") until the owner
 * fixes the permissions. The same for a directory that lists but whose children cannot be stat-ed (r4 T1': `r` and
 * no `x`, `chmod 400`/`600`): the names are seen, the link counts are not, and a confined writer can give `x` back
 * (`file-write-mode` is inside the project's `file-write*`) and read through the link. Only ENOENT — a name that
 * vanished between two steps — is nothing to scan; every other error on a directory or on one of its children
 * makes that directory unscannable.
 *
 * The gesture (r3 T2) is one per inside directory group: main records every {dev, ino} it scanned under that
 * directory at that moment, bound by a digest to what the pane showed, so an inode planted later asks again.
 *
 * The one auto-pass (r4 T2'') is for the `build` class alone: a link whose every other name resolves, by inode, to a
 * file inside the pnpm store roots (`~/Library/pnpm`, `~/.local/share/pnpm`, `$PNPM_HOME`) is the store's own
 * content and runs without a gesture. Every name must be accounted for (inside the project or inside the store): an
 * inode with a third name elsewhere still asks, so a secret linked both into the project and into the store cannot
 * ride through. The resolve is one walk of the store roots under a budget (1 s); past it, or with any error, nothing
 * is passed and the gesture stands.
 *
 * The owner's acknowledgements are main's record (`userData/confinement/hardlink-acks.json`), signed with ONE key
 * (r3 T5). When Electron's safeStorage is available the key is minted once and kept sealed next to the record, so a
 * record is trusted across restarts only if it verifies under that key; what fails is dropped and audited. Without
 * safeStorage the key lives for this main only: nothing on disk is read back, and an allowance ends with the app.
 * The Hermes plugin gets the key in its spawn env (popped at import) and trusts only a record that verifies.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { type Dirent, readFileSync } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type {
  ActivityClass,
  HardlinkAckFailure,
  HardlinkBlockView,
  HardlinkFirstScanView,
  HardlinkGroupPathsResult,
  HardlinkGroupView
} from '../../src/iclone-shared/confinement'
import { writeFileAtomicSync } from '../lib/atomic-write'
import { registerTeardown } from '../teardown-registry'

import { defaultFsEventsSource, FSE, FSE_LOSS, FSEVENTS_LATENCY_MS, type FsEventsSource } from './hardlinks-fsevents'
import {
  drain,
  errnoOf,
  inodeKey,
  type LinkedInode,
  lstatEach,
  scanOf,
  TreeOutgrown,
  type TreeScan,
  type TreeVerdict,
  WALK_DIRS_IN_FLIGHT,
  type WalkPace,
  walkTree
} from './hardlinks-walk'
import { type TreeResident, walkInWorker } from './hardlinks-walker'
import { insideFolder } from './profiles'

/** Where main keeps the owner's acknowledgements (and the sealed key that signs them), and where the Hermes plugin
 *  says which projects it refused. */
export function hardlinkFiles(userDataDir: string): { acks: string; key: string; report: string } {
  return {
    acks: path.join(userDataDir, 'confinement', 'hardlink-acks.json'),
    key: path.join(userDataDir, 'confinement', 'hardlink-key.sealed'),
    report: path.join(userDataDir, 'confinement', 'run', 'hardlinks.json')
  }
}

/** How many paths the refusal sentence names. */
const HARDLINK_PATHS_SHOWN = 3
/** CF4 (B2-n4): how many file names one group carries to the pane, which lists three and shows the rest on "Show
 *  all" (the owner's known group holds 538). Bounded, so a state read stays small. */
export const HARDLINK_GROUP_PATHS_SENT = 1_000
/** A cached answer is re-measured at least this often, even when no inside directory moved. */
const CACHE_MAX_AGE_MS = 5 * 60_000
/** T2'': the store walk that may auto-pass a `build` run must finish within this, else the gesture stands. */
const STORE_BUDGET_MS = 1_000
/** The only class whose links into the pnpm store run without a gesture. */
const STORE_AUTO_PASS_CLASS: ActivityClass = 'build'

const within = (child: string, parent: string) => child === parent || child.startsWith(`${parent}${path.sep}`)
/** One empty set for every `blockOf` with no store pass, so the memo keys on it. */
const EMPTY_PASS: ReadonlySet<string> = new Set()

/** The full scan of `root` in this process, for tests: every directory listed, every regular file stat-ed. */
export async function scanTree(root: string): Promise<TreeScan> {
  return scanOf((await walkTree(root, null)).records)
}

/** The pnpm store roots a `build` run may be linked into (T2''): the two pnpm homes under `home`, and `$PNPM_HOME`
 *  when absolute. `/` and any ancestor of `home` are never a store, and (r5 MINOR-2) neither is a root inside one
 *  of `denied` or holding one: `$PNPM_HOME=~/.ssh`, `~/.hermes`, `~/Library` (the keychains) or the app's own data
 *  name no store. Whether a root has the store's shape and is real is judged where it is walked (`resolveInStore`). */
export function pnpmStoreRoots(pnpmHome: string | undefined, home: string, denied: readonly string[] = []): string[] {
  const candidates = [path.join(home, 'Library', 'pnpm'), path.join(home, '.local', 'share', 'pnpm')]

  if (pnpmHome && path.isAbsolute(pnpmHome)) {
    candidates.push(path.resolve(pnpmHome))
  }

  // The denied list is in real paths (profiles.ts); a candidate is compared by real path and by folder identity (r6,
  // INFO-1: an alias of a denied folder is that folder) and kept as named, so a symlinked candidate is dropped here
  // when it points into a denied folder and refused at the walk otherwise.
  return [...new Set(candidates)].filter(
    root =>
      root !== path.sep &&
      !insideFolder(home, root) &&
      !denied.some(dir => insideFolder(root, dir) || insideFolder(dir, root))
  )
}

const STORE_VERSION_DIR = /^v\d+$/

/**
 * r5 MINOR-2: the pnpm store's own layout — `<root>/store/v<N>` present as a real directory under a real `store`, or
 * the root itself named `…/store/v<N>` (a `store-dir` pointed elsewhere). A directory without it (`~/.ssh`, `/tmp`,
 * an empty folder) is no store, whatever `$PNPM_HOME` says. Not a boundary on its own: `realStoreRoot` is.
 */
export async function storeShaped(root: string): Promise<boolean> {
  if (/\/store\/v\d+$/.test(root)) {
    return true
  }

  try {
    const store = path.join(root, 'store')

    return (
      (await lstat(store)).isDirectory() &&
      (await readdir(store, { withFileTypes: true })).some(
        entry => entry.isDirectory() && STORE_VERSION_DIR.test(entry.name)
      )
    )
  } catch {
    return false
  }
}

export interface StoreResolve {
  /** The inodes (`dev:ino`) whose every name outside the project was found inside the store roots. */
  passed: Set<string>
  files: number
  ms: number
  timedOut: boolean
}

/**
 * r5 MAJOR-1'': a store root the walk may use is a real directory (`lstat`, so a symlink is never one) whose real
 * path is itself (so nothing above it is a symlink either). A root that is, or lies under, a symlink is whatever it
 * points at — `~/.hermes` after one `ln -s` — and not the store: ignored, and the gesture stands. Checked here, where
 * the root is walked, for every caller (main's own roots and the ones the spec hands the plugin alike).
 */
export async function realStoreRoot(root: string): Promise<boolean> {
  try {
    return (await lstat(root)).isDirectory() && (await realpath(root)) === root
  } catch {
    return false
  }
}

/** r6: the roots one resolve walks — real, store-shaped, each once; a root inside another walked root is dropped (its
 *  folders are reached from the outer one). */
async function storeWalkRoots(roots: readonly string[]): Promise<string[]> {
  const unique = [...new Set(roots)]
  const checks = await Promise.all(unique.map(async root => (await realStoreRoot(root)) && (await storeShaped(root))))
  const valid = unique.filter((_root, index) => checks[index])

  return valid.filter(root => !valid.some(other => other !== root && within(root, other)))
}

/**
 * One walk of the store roots, stat-ing every regular file, intersected with `wanted` (T2''). r6 (MAJOR-1‴): an inode
 * passes only when the SET of its names — the project's names united with the names found in the store, each a
 * folder identity plus a name — has exactly `st_nlink` members. Names are never counted twice: a folder is walked at
 * most once by its `dev:ino` (nested roots, a project that is or holds the store, an alias), and a name already seen
 * in the project is the same member when the store walk meets it. Every member lies inside the project or a store
 * root by construction (nothing else is walked), so `size === nlink` is "every name is accounted for".
 *
 * A store directory that cannot be read resolves nothing (fail closed by construction); past `budgetMs` nothing is
 * passed at all. Only a real root with the store's layout is walked (`realStoreRoot`, `storeShaped`), and a symlinked
 * directory under it is never entered: `readdir`'s entry types come from the link itself, so a symlink is not a
 * directory to this walk. A folder whose identity changed while it was listed (swapped for a symlink, INFO-2) gives
 * no names.
 */
export async function resolveInStore(
  roots: readonly string[],
  wanted: readonly LinkedInode[],
  budgetMs = STORE_BUDGET_MS
): Promise<StoreResolve> {
  const started = performance.now()
  const names = new Map(wanted.map(inode => [inodeKey(inode), new Set(inode.names)]))
  const visited = new Set<string>()
  let files = 0
  let timedOut = false
  const overBudget = () => (timedOut ||= performance.now() - started > budgetMs)

  for (const root of await storeWalkRoots(roots)) {
    if (overBudget()) {
      break
    }

    await drain([root], WALK_DIRS_IN_FLIGHT, async dir => {
      if (overBudget()) {
        return []
      }

      let entries: Dirent[]
      let folder: string

      try {
        const before = await lstat(dir, { bigint: true })

        folder = `${before.dev}:${before.ino}`

        if (!before.isDirectory() || visited.has(folder)) {
          return []
        }

        visited.add(folder)
        entries = await readdir(dir, { withFileTypes: true })

        const after = await lstat(dir, { bigint: true })

        if (!after.isDirectory() || `${after.dev}:${after.ino}` !== folder) {
          return []
        }
      } catch {
        return []
      }

      const regular = entries.filter(entry => !entry.isDirectory() && entry.isFile())

      files += regular.length

      if (overBudget()) {
        return []
      }

      const stats = await lstatEach(regular.map(entry => path.join(dir, entry.name)))

      regular.forEach((entry, index) => {
        const stat = stats[index]

        // An error is a name gone between readdir and lstat: it resolves nothing.
        if (!('error' in stat)) {
          names.get(inodeKey(stat))?.add(`${folder}/${entry.name}`)
        }
      })

      return entries.filter(entry => entry.isDirectory()).map(entry => path.join(dir, entry.name))
    })
  }

  const passed = new Set<string>()

  // A walk that finished past the budget is past the budget: the ticket's bound is on the whole resolve.
  if (!overBudget()) {
    for (const inode of wanted) {
      if (names.get(inodeKey(inode))?.size === inode.nlink) {
        passed.add(inodeKey(inode))
      }
    }
  }

  return { passed, files, ms: performance.now() - started, timedOut }
}

interface CacheEntry {
  /** The root's tree, as its worker holds it (or in process, a small one): its summary is the answer. */
  tree: TreeResident
  /** When every file of the tree was last stat-ed (the full scan): the age bound for names made outside. */
  fullAt: number
  /** T2'': the store-resolved inodes of this scan, once a `build` check asked; null until then. */
  store: Set<string> | null
  /** V-1b: the stream that has seen every change since the walk behind `tree` began; null: none has. */
  watch: RootWatch | null
}

/** V-1b: one root's FSEvents stream. */
interface RootWatch {
  root: string
  /** The root's real path: the spelling FSEvents reports. */
  realRoot: string
  /** The directories events named since the last walk or relist took the set (`root`-relative spelling). */
  dirty: Set<string>
  /** False once anything voids the stream (lost events, an outside path, an error, too many dirty folders). */
  healthy: boolean
  /** When the stream was registered: a walk begun after this is covered by it. */
  sinceAt: number
  /** The dirty sets of background full scans running on this stream (each gets every event from its start). */
  taps: Set<Set<string>>
  stop: () => void
  /** The started stream (its own barrier); null until `watch` resolved. */
  stream: Awaited<ReturnType<FsEventsSource['watch']>> | null
}

/** A refresh's life (test seam): `started`, `promoted` (a command needed the running background scan: it was
 *  aborted and a full-speed one took its place), `installed` (its result is the cached answer). */
export type RefreshPhase = 'installed' | 'promoted' | 'released' | 'started'

/** How one check measured its root (test seam). */
export type HardlinkMeasure = 'events-cached' | 'events' | 'walk-cached' | 'walk' | 'full'

/** Past this many dirty folders a relist costs about what a walk does: the stream is voided and the walk decides. */
const MAX_DIRTY_DIRS = 20_000
/** Streams kept at once (least recently checked stopped first; its root is walked until watched again). */
const MAX_WATCHED_ROOTS = 16
/** CF7: trees kept at once (a resident worker each past IN_PROCESS_MAX_DIRS folders, ~10 MB + 650 B per folder: I7);
 *  the least recently checked root is released first (`releaseRoot`) and scanned again when next checked. */
const MAX_CACHED_ROOTS = 32
/** I7: what one resident folder costs in its worker (PERF.mem.bytes_per_dir holds it < 800 B on 520 000 folders). */
export const RESIDENT_BYTES_PER_DIR = 650
/** I7: one worker thread's own cost (~10 MB: its isolate), counted in folders at RESIDENT_BYTES_PER_DIR. */
export const WORKER_BASE_DIRS = 16_000
/** I7: the folders all worker trees may hold together: 1/16 of the Mac's memory, between 300 000 (~200 MB) and
 *  1 500 000 (~1 GB). Past it the least recently checked roots are released (`releaseRoot`). */
export const residentDirsBudgetFor = (totalBytes: number): number =>
  Math.max(300_000, Math.min(1_500_000, Math.floor(totalBytes / 16 / RESIDENT_BYTES_PER_DIR)))
/** I7: a root not checked for this long is released at its next refresh tick (tree, stream, timer): no idle refresh
 *  for a project nobody is running in; the next check scans it at full speed, as after a sleep. */
const IDLE_RELEASE_MS = 30 * 60_000

/** A3-m2: why a root's tree was dropped and is being scanned again. */
export interface TreeDropped {
  root: string
  why: 'dead' | 'outgrown'
  detail: string
  /** Drops of this root in this guard's life. */
  count: number
}
/** CF4 (B2-m3): a stream-backed root's background full scans start at least this far apart (start to start). */
const REFRESH_MIN_MS = 4 * 60_000
/** ... and at least this many times the last background scan's length apart, so the refresh costs an idle app at most
 *  about 1/10 of the share of a core it takes while it runs (hardlinks-walk.ts, the background walk and BACKGROUND_REST_RATIO: ~1/4). */
const REFRESH_PER_SCAN = 10
/** The age bound covers the interval plus this many scan lengths: the next background scan completes inside it. */
const BOUND_SCANS = 2
/** Before a root's first background scan has completed, its length is estimated as the last full scan's times this
 *  (the paced walk is slower; PERF.idle.cpu measures the real ratio on the fixture and holds it below this). */
export const BACKGROUND_SLOWDOWN = 12
/** CF5 (B3-n4): between the end of one background scan and the start of the next, at least this many scan lengths of
 *  idle, however long the scan (the interval never falls below 3 x scan): never back to back. */
const IDLE_GAP_SCANS = 2
/** INFO L1-5: however slow the scan (a project's contents set it), the bound never stretches past this. */
const BOUND_CEILING_MS = 30 * 60_000

/**
 * CF4 (B2-m3): a stream-backed root's refresh cadence from the length of its background scan (`scanMs`). interval =
 * max(4 min, 10 x scan), never so long that the bound cannot hold it, and never below 3 x scan (2 scans of idle
 * between two); bound = max(5 min, interval + 2 x scan), at most 30 min. The scheduled scan therefore completes
 * before the cached answer ages out, unless one scan takes more than twice the last, or a scan is longer than 6 min
 * (the bound is at its ceiling): then a check past the bound runs its own full-speed scan (header, TWO SCAN MODES).
 */
export function refreshCadence(scanMs: number): { intervalMs: number; boundMs: number } {
  const scan = Math.max(0, scanMs)

  const intervalMs = Math.max(
    IDLE_GAP_SCANS * scan + scan,
    Math.min(Math.max(REFRESH_MIN_MS, REFRESH_PER_SCAN * scan), Math.max(0, BOUND_CEILING_MS - BOUND_SCANS * scan))
  )

  return {
    intervalMs,
    boundMs: Math.min(BOUND_CEILING_MS, Math.max(CACHE_MAX_AGE_MS, intervalMs + BOUND_SCANS * scan))
  }
}

/** A2-m2: a refresh a check waits on that reaches no new folder for this long is aborted and the check refused (the
 *  first scan's stall rule, HARDLINK_FIRST_SCAN_STALL_MS), so a hung worker never holds a root's checks until quit. */
const REFRESH_STALL_MS = 5_000

/** A waited-on refresh stopped by its stall bound (A2-m2). */
class RefreshStalled extends Error {}

/** The walk cost assumed per folder before one is measured (V-1, 30 000 folders: ~110 ms). */
const WALK_MS_PER_DIR = 0.004

interface HardlinkAck {
  root: string
  path: string
  dev: number
  ino: number
  at: string
}

export type HardlinkCheck =
  | { ok: true; cached: boolean; files: number; dirs: number; ms: number; passed: number }
  | {
      ok: false
      cached: boolean
      block: HardlinkBlockView
      ms: number
      /** T3, when asked after a run's exit: the part of `block` that existed by then (null: none of it did). */
      appeared?: HardlinkBlockView | null
    }

export type HardlinkAckResult =
  | { ok: true; dir: string; count: number; acks: HardlinkAck[] }
  | { ok: false; reason: Exclude<HardlinkAckFailure, 'no-gesture'> }

interface SignedAcks {
  v: 2
  body: string
  sig: string
}

const sign = (key: Buffer, body: string) => createHmac('sha256', key).update(body).digest('hex')

const isAck = (ack: unknown): ack is HardlinkAck =>
  typeof ack === 'object' &&
  ack !== null &&
  typeof (ack as HardlinkAck).root === 'string' &&
  typeof (ack as HardlinkAck).path === 'string' &&
  Number.isInteger((ack as HardlinkAck).dev) &&
  Number.isInteger((ack as HardlinkAck).ino) &&
  typeof (ack as HardlinkAck).at === 'string'

/** Why a signed file on disk was not trusted: said in the audit row, never acted on. */
export type SignedFileRejection = 'malformed' | 'signature' | 'unreadable' | 'unsigned'

/**
 * A file main wrote as `{v, body, sig}`: its body, only if the signature verifies under `key` (T5, T7). A missing
 * file is an empty body (nothing to trust); anything else that does not verify is rejected with the reason.
 */
export function readSignedFile(file: string, key: Buffer): { body: string } | { rejected: SignedFileRejection } {
  let raw: string

  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return errnoOf(error) === 'ENOENT' ? { body: '' } : { rejected: 'unreadable' }
  }

  try {
    const signed = JSON.parse(raw) as Partial<SignedAcks>

    if (typeof signed.body !== 'string' || typeof signed.sig !== 'string') {
      return { rejected: 'unsigned' }
    }

    const expected = Buffer.from(sign(key, signed.body), 'hex')
    const given = Buffer.from(signed.sig, 'hex')

    if (given.length !== expected.length || !given.equals(expected)) {
      return { rejected: 'signature' }
    }

    return { body: signed.body }
  } catch {
    return { rejected: 'malformed' }
  }
}

/** The envelope `readSignedFile` opens, for `body`, under `key`. */
export function signedFile(key: Buffer, body: string): string {
  return `${JSON.stringify({ v: 2, body, sig: sign(key, body) } satisfies SignedAcks)}\n`
}

/** The record on disk, only if its signature verifies under `key` (T5: dropped and audited otherwise). */
function readVerifiedAcks(file: string, key: Buffer): { acks: HardlinkAck[] } | { rejected: SignedFileRejection } {
  const read = readSignedFile(file, key)

  if ('rejected' in read) {
    return read
  }

  if (read.body === '') {
    return { acks: [] }
  }

  try {
    const body = JSON.parse(read.body) as { acks?: unknown }

    return { acks: Array.isArray(body.acks) ? body.acks.filter(isAck) : [] }
  } catch {
    return { rejected: 'malformed' }
  }
}

/** The real path of `file` without following its last component (a symlink is judged as itself). Asynchronous (CF1,
 *  critic B-m1): under disk contention one `realpathSync` held main's loop for a second. */
async function realParentJoin(file: string): Promise<string | null> {
  try {
    return path.join(await realpath(path.dirname(file)), path.basename(file))
  } catch {
    return null
  }
}

const digestOf = (inodes: readonly LinkedInode[]): string =>
  createHash('sha256').update(inodes.map(inodeKey).sort().join('\n')).digest('hex').slice(0, 16)

interface LinkGroup {
  view: HardlinkGroupView
  members: LinkedInode[]
}

/**
 * The open inodes by inside directory (T2): one group per top-level entry of the root (files directly in the root
 * form their own), each deepened while every member lies under the same child. A pnpm store of 500 links under
 * `node_modules/.pnpm/<pkg>/…` is one group at `node_modules/.pnpm`; one more under `src` is its own.
 */
function groupLinks(root: string, open: readonly LinkedInode[]): LinkGroup[] {
  const byTop = new Map<string, LinkedInode[]>()

  for (const inode of open) {
    const segments = path.relative(root, inode.paths[0]).split(path.sep)
    const top = segments.length > 1 ? segments[0] : ''

    const bucket = byTop.get(top)

    if (bucket) {
      bucket.push(inode)
    } else {
      byTop.set(top, [inode])
    }
  }

  return [...byTop.entries()]
    .map(([top, members]) => {
      let dir = top ? path.join(root, top) : root

      for (;;) {
        const next = new Set(
          members.map(member => {
            const rest = path.relative(dir, member.paths[0]).split(path.sep)

            return rest.length > 1 ? rest[0] : ''
          })
        )

        if (next.size !== 1 || next.has('')) {
          break
        }

        dir = path.join(dir, [...next][0])
      }

      return {
        members,
        view: {
          dir,
          paths: members.slice(0, HARDLINK_GROUP_PATHS_SENT).map(member => member.paths[0]),
          count: members.length,
          digest: digestOf(members)
        }
      }
    })
    .sort((a, b) => (a.view.dir < b.view.dir ? -1 : 1))
}

/** Electron's `safeStorage`, when the owner's keychain policy allows it (main.ts); absent in tests and when off. */
export interface SealedKeyStore {
  seal(key: Buffer): string
  open(sealed: string): Buffer
}

/** What main refused to trust on disk (index.ts writes each one as a refusal-class row). */
export interface HardlinkAuditEvent {
  kind: 'acks-rejected' | 'key-rejected' | 'key-unsealable' | 'settings-rejected'
  file: string
  detail: string
}

/** The one key of this main. `persistent`: it is sealed on disk, so a record signed with it outlives this main;
 *  otherwise it is this session's and nothing on disk is read back. */
export interface SealedKey {
  key: Buffer
  persistent: boolean
}

interface SealedKeyDeps {
  /** The sealed signing key on disk (`hardlink-key.sealed`). */
  keyFile: string
  /** Seals and opens the key. Absent: the key lives for this main only. */
  keyStore?: SealedKeyStore | null
  onAudit?: (event: HardlinkAuditEvent) => void
}

interface HardlinkGuardDeps extends Omit<SealedKeyDeps, 'keyFile'> {
  /** Main's record of the owner's acknowledgements, re-signed with the key at every write. */
  ackFile: string
  /** Defaults to `hardlink-key.sealed` next to the record. */
  keyFile?: string
  /** A key already booted by the caller (index.ts shares it with the settings file, T7); else booted here. */
  sealedKey?: SealedKey
  now?: () => Date
  /** T2'': the pnpm store roots a `build` run may be linked into without a gesture (`pnpmStoreRoots`). Empty: no
   *  auto-pass at all. */
  storeRoots?: readonly string[]
  /** T2'': the store walk's budget; past it the gesture stands. */
  storeBudgetMs?: number
  /** Test seam: counts full scans. */
  onFullScan?: (root: string) => void
  /** Test seam: every store resolve, with its outcome. */
  onStoreResolve?: (root: string, result: StoreResolve) => void
  /** V-1b: FSEvents (undefined: this process's own source; null: never, every root is walked as in V-1). */
  fsEvents?: FsEventsSource | null
  /** V-1b: `cost` (default) uses the stream only where the walk costs more than the barrier; `always`, every root. */
  fsEventsChoice?: 'always' | 'cost'
  /** Test seam: how each check measured its root. */
  onMeasure?: (root: string, how: HardlinkMeasure) => void
  /** A3-m2: a resident tree was dropped (it died, or an in-process tree outgrew its bound); the root is rescanned. */
  onTreeDropped?: (event: TreeDropped) => void
  /** I7 test seams: the total folder-equivalents worker trees may hold, and how long a root may go unchecked. */
  residentDirsBudget?: number
  idleReleaseMs?: number
  /** I7: a root's tree, stream and refresh were released (over the budget, or idle); its next check scans it. */
  onRootReleased?: (root: string, why: 'budget' | 'idle') => void
  /** Test seam: a background full scan of a stream-backed root started, or its result became the cached answer. */
  onRefresh?: (root: string, phase: RefreshPhase) => void
  /** Test seam: awaited before a refresh's full scan walks, with its pace (holds a "slow" scan open). */
  onRefreshWalk?: (root: string, pace: WalkPace) => Promise<void>
  /** Monotonic ms for a first scan's progress (`firstScanProgress`); defaults to performance.now. */
  clock?: () => number
  /** A2-m2 test seam: how long a refresh a check waits on may reach no new folder before the check is refused. */
  refreshStallMs?: number
  /** CF1 test seam: how a full scan walks (default: `walkInWorker`, off main's thread, which keeps the tree). */
  walkFull?: (
    root: string,
    options: { onProgress?: (dirs: number) => void; signal: AbortSignal; pace?: WalkPace }
  ) => Promise<TreeResident>
}

/** The one key of this main: unsealed from disk, minted and sealed, or (no store) minted for this session. */
export function bootSealedKey(deps: SealedKeyDeps): SealedKey {
  const { keyFile } = deps
  const store = deps.keyStore

  if (!store) {
    return { key: randomBytes(32), persistent: false }
  }

  try {
    const key = store.open(readFileSync(keyFile, 'utf8').trim())

    if (key.length === 32) {
      return { key, persistent: true }
    }

    deps.onAudit?.({ kind: 'key-rejected', file: keyFile, detail: `unsealed to ${key.length} bytes` })
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') {
      deps.onAudit?.({ kind: 'key-rejected', file: keyFile, detail: error instanceof Error ? error.message : 'x' })
    }
  }

  const key = randomBytes(32)

  try {
    writeFileAtomicSync(keyFile, `${store.seal(key)}\n`, { mode: 0o600, dirMode: 0o700 })

    return { key, persistent: true }
  } catch (error) {
    deps.onAudit?.({ kind: 'key-unsealable', file: keyFile, detail: error instanceof Error ? error.message : 'x' })

    return { key, persistent: false }
  }
}

/** Every guard not yet closed. Quit closes them: their per-root FSEvents streams, background-scan timers and walk
 *  workers. */
const liveGuards = new Set<{
  close: () => void
  firstScan: () => HardlinkFirstScanView | null
  groupPaths: (root: string, dir: string, digest: string, offset: number) => HardlinkGroupPathsResult
}>()

registerTeardown('hardlink guards', () => {
  ;[...liveGuards].forEach(guard => guard.close())
})

/** CF4 (B2-M1): told when any guard's first scan starts, reaches more folders, or ends (ok or not). */
const firstScanListeners = new Set<() => void>()

/** CF4 (B2-M1): `listener` runs at every first-scan start, progress and end in any guard (main throttles it into the
 *  confinement change notice, ipc.ts). Returns the unsubscribe. */
export function onFirstScanChange(listener: () => void): () => void {
  firstScanListeners.add(listener)

  return () => firstScanListeners.delete(listener)
}

const firstScanChanged = () => {
  for (const listener of firstScanListeners) {
    try {
      listener()
    } catch {
      // a listener's failure is its own: the scan and the other listeners go on
    }
  }
}

/** CF1: the first scan running now in any live guard (the most recently started), for the confinement state; null
 *  when none is. Reads only the guards' own progress: no file system call. */
/** CF5 (B3-n2): a page of a refused group's file names from whichever live guard refused it (ipc.ts), else `changed`. */
export function hardlinkGroupPaths(
  root: string,
  dir: string,
  digest: string,
  offset: number
): HardlinkGroupPathsResult {
  for (const guard of liveGuards) {
    const page = guard.groupPaths(root, dir, digest, offset)

    if (page.ok) {
      return page
    }
  }

  return { ok: false, reason: 'changed' }
}

export function activeFirstScan(): HardlinkFirstScanView | null {
  let latest: HardlinkFirstScanView | null = null

  for (const guard of liveGuards) {
    const scan = guard.firstScan()

    if (scan && (!latest || scan.startedAt >= latest.startedAt)) {
      latest = scan
    }
  }

  return latest
}

export function createHardlinkGuard(deps: HardlinkGuardDeps) {
  const keyFile = deps.keyFile ?? path.join(path.dirname(deps.ackFile), 'hardlink-key.sealed')
  const { key, persistent } = deps.sealedKey ?? bootSealedKey({ ...deps, keyFile })
  const now = deps.now ?? (() => new Date())
  const storeRoots = deps.storeRoots ?? []
  const storeBudgetMs = deps.storeBudgetMs ?? STORE_BUDGET_MS
  const cache = new Map<string, CacheEntry>()
  const blocked = new Map<string, HardlinkBlockView>()
  /** CF5 (B3-n2): the groups behind each `blocked` view, with every member, so the pane can page past the first
   *  `HARDLINK_GROUP_PATHS_SENT` names of a group without a new scan. */
  const blockedGroups = new Map<string, LinkGroup[]>()
  let acks: HardlinkAck[] = []

  if (persistent) {
    const read = readVerifiedAcks(deps.ackFile, key)

    if ('acks' in read) {
      acks = read.acks
    } else {
      deps.onAudit?.({ kind: 'acks-rejected', file: deps.ackFile, detail: read.rejected })
    }
  }

  const persist = () => {
    writeFileAtomicSync(deps.ackFile, signedFile(key, JSON.stringify({ acks })), { mode: 0o600, dirMode: 0o700 })
  }

  // Written at every start: what verified (or, session-only, nothing), signed with this start's key, so the plugin
  // of every Hermes this main spawns can verify it and a record left by anyone else is never read as ours.
  persist()

  const ackKey = (root: string, inode: Pick<LinkedInode, 'dev' | 'ino'>) => `${root}\0${inodeKey(inode)}`
  let ackKeys = new Set(acks.map(ack => ackKey(ack.root, ack)))

  const acknowledged = (root: string, inode: Pick<LinkedInode, 'dev' | 'ino'>) => ackKeys.has(ackKey(root, inode))

  /** The root's cached answer, most recently used last; past MAX_CACHED_ROOTS the oldest tree is released. */
  const entryOf = (root: string): CacheEntry | undefined => {
    const entry = cache.get(root)

    if (entry) {
      cache.delete(root)
      cache.set(root, entry)
    }

    return entry
  }

  const dropEntry = (root: string, entry: CacheEntry | undefined = cache.get(root)) => {
    if (entry && cache.get(root) === entry) {
      cache.delete(root)
    }

    entry?.tree.release()
  }

  const setEntry = (root: string, entry: CacheEntry) => {
    const previous = cache.get(root)

    if (previous && previous !== entry && previous.tree !== entry.tree) {
      previous.tree.release()
    }

    cache.delete(root)
    cache.set(root, entry)
    enforceBudget()
  }

  /** I7: a tree's share of the budget (an in-process tree is bounded and costs no thread: none). */
  const residentCost = (entry: CacheEntry) => (entry.tree.inProcess ? 0 : WORKER_BASE_DIRS + entry.tree.scan.dirs)

  /** I7: past MAX_CACHED_ROOTS trees or the budget, the least recently CHECKED roots are released whole, in that
   *  order. A root with a check in flight (its queue busy, the one being set included) is never released under it:
   *  the release stops there and resumes when that queue settles (`serial`), so a newer root never goes in its place.
   *  Peak: the budget plus the trees of the roots in flight. */
  const enforceBudget = () => {
    let total = 0

    for (const entry of cache.values()) {
      total += residentCost(entry)
    }

    const victims = [...cache.keys()].sort((a, b) => (lastCheckedAt.get(a) ?? 0) - (lastCheckedAt.get(b) ?? 0))

    for (const root of victims) {
      if ((cache.size <= MAX_CACHED_ROOTS && total <= residentDirsBudget) || queues.has(root)) {
        break
      }

      const entry = cache.get(root)

      if (entry) {
        total -= residentCost(entry)
        releaseRoot(root, 'budget')
      }
    }
  }

  /** I7: when each root was last checked (epoch ms of the guard's clock). */
  const lastCheckedAt = new Map<string, number>()
  /** I7 (F-5): roots released and not checked since: the pane's re-measure leaves them released. */
  const releasedRoots = new Set<string>()

  const clock = deps.clock ?? (() => performance.now())
  /** A root's FIRST full scan while it runs (no completed scan yet): when it last reached a directory, how many it
   *  reached, and when it began (epoch ms, for the state view). */
  const firstScans = new Map<string, { at: number; dirs: number; startedAt: number }>()
  /** Stops every walk worker of this guard at `close`. */
  const walks = new AbortController()
  const walkFull = deps.walkFull ?? ((root, options) => walkInWorker(root, options))
  const refreshStallMs = deps.refreshStallMs ?? REFRESH_STALL_MS
  const residentDirsBudget = deps.residentDirsBudget ?? residentDirsBudgetFor(os.totalmem())
  const idleReleaseMs = deps.idleReleaseMs ?? IDLE_RELEASE_MS
  const treeDrops = new Map<string, number>()

  const fullScan = async (root: string, at: number): Promise<CacheEntry> => {
    const progress = lastScanMs.has(root) || cache.has(root) ? null : { at: clock(), dirs: 0, startedAt: at }

    if (progress) {
      firstScans.set(root, progress)
      firstScanChanged()
    }

    try {
      deps.onFullScan?.(root)

      const tree = await walkFull(root, {
        signal: walks.signal,
        onProgress: progress
          ? dirs => {
              progress.at = clock()
              progress.dirs = dirs
              firstScanChanged()
            }
          : undefined
      })

      return { tree, fullAt: at, store: null, watch: null }
    } finally {
      if (progress && firstScans.get(root) === progress) {
        firstScans.delete(root)
        firstScanChanged()
      }
    }
  }

  const source = deps.fsEvents === undefined ? defaultFsEventsSource() : deps.fsEvents
  const choice = deps.fsEventsChoice ?? 'cost'
  const watches = new Map<string, RootWatch>()
  const walkMs = new Map<string, number>()
  let barrierMs = 2 * FSEVENTS_LATENCY_MS

  const forget = (watch: RootWatch) => {
    watch.healthy = false
    watch.dirty.clear()
    watch.taps.clear()
    watch.stop()

    if (watches.get(watch.root) === watch) {
      watches.delete(watch.root)
    }
  }

  const onEvent = (watch: RootWatch) => (eventPath: string, flags: number) => {
    if (!watch.healthy) {
      return
    }

    if (flags & FSE_LOSS) {
      forget(watch)

      return
    }

    if (flags & FSE.HistoryDone) {
      return
    }

    const inside =
      eventPath === watch.realRoot
        ? watch.root
        : eventPath.startsWith(`${watch.realRoot}${path.sep}`)
          ? path.join(watch.root, eventPath.slice(watch.realRoot.length + 1))
          : null

    if (!inside) {
      forget(watch)

      return
    }

    const named = [inside === watch.root ? inside : path.dirname(inside)]

    // A folder's own event (or one whose kind is not said) names it too: its listing may be what changed.
    if (flags & FSE.ItemIsDir || !(flags & FSE.ItemIsFile)) {
      named.push(inside)
    }

    for (const set of [watch.dirty, ...watch.taps]) {
      named.forEach(dir => set.add(dir))

      if (set.size > MAX_DIRTY_DIRS) {
        forget(watch)

        return
      }
    }
  }

  /** The root's healthy stream, started if there is none; null when the root cannot be watched. */
  const ensureWatch = async (root: string): Promise<RootWatch | null> => {
    if (!source || closed) {
      return null
    }

    const current = watches.get(root)

    if (current?.healthy) {
      watches.delete(root)
      watches.set(root, current)

      return current
    }

    try {
      if (!(await source.trustedVolume(root))) {
        return null
      }

      const realRoot = await realpath(root)

      const watch: RootWatch = {
        root,
        realRoot,
        dirty: new Set(),
        healthy: true,
        sinceAt: 0,
        taps: new Set(),
        stop: () => undefined,
        stream: null
      }

      // The addon registers the stream before `watch` resolves (FSEventStreamStart returned true) and throws when it
      // did not: from then on, every change fseventsd hears is delivered or flagged as lost.
      const stream = await source.watch(realRoot, onEvent(watch), () => forget(watch))

      watch.stream = stream
      watch.stop = stream.stop
      watch.sinceAt = performance.now()

      if (!watch.healthy) {
        stream.stop()

        return null
      }

      watches.set(root, watch)

      for (const [oldest, old] of watches) {
        if (watches.size <= MAX_WATCHED_ROOTS) {
          break
        }

        watches.delete(oldest)
        forget(old)
      }

      return watch
    } catch {
      return null
    }
  }

  const walkCost = (root: string, entry: CacheEntry) => walkMs.get(root) ?? entry.tree.scan.dirs * WALK_MS_PER_DIR

  const preferEvents = (root: string, entry: CacheEntry | null) =>
    choice === 'always' || (entry !== null ? walkCost(root, entry) : (walkMs.get(root) ?? 0)) > barrierMs

  /** The stream, if it covers a walk begun at `walkStarted` over `tree` (still healthy, began before, one volume). */
  const covering = (watch: RootWatch | null, walkStarted: number, tree: TreeResident) =>
    watch && watch.healthy && watch.sinceAt <= walkStarted && tree.oneVolume ? watch : null

  /** The verdict only if it stands (typed: the counts, one-volume and ctimes are then present). */
  const standing = (verdict: TreeVerdict | null): Extract<TreeVerdict, { stands: true }> | null =>
    verdict !== null && verdict.placed && verdict.stands ? verdict : null

  /** An update's verdict from the resident, or null when the tree cannot answer (it died or outgrew: I3, I6). */
  const updated = async (
    root: string,
    entry: CacheEntry,
    run: () => Promise<TreeVerdict>
  ): Promise<TreeVerdict | null> => {
    try {
      return await run()
    } catch (error) {
      const count = (treeDrops.get(root) ?? 0) + 1

      treeDrops.set(root, count)
      dropEntry(root, entry)
      deps.onTreeDropped?.({
        root,
        why: error instanceof TreeOutgrown ? 'outgrown' : 'dead',
        detail: error instanceof Error ? error.message : String(error),
        count
      })

      return null
    }
  }

  /**
   * V-1b: the tree from the stream. Waits for the barrier, takes the dirty set, and re-lists only those folders; the
   * answer stands only under the walk's rule (no unscannable folder, the same linked inodes, one volume). Null: the
   * stream cannot answer (barrier failed, stream voided, a folder it cannot place, a changed link set), and the
   * walk decides, with the full scan behind it.
   */
  const measureByEvents = async (
    root: string,
    hit: CacheEntry,
    watch: RootWatch
  ): Promise<{ entry: CacheEntry; cached: boolean } | null> => {
    let barrier: { id: number; ms: number }

    try {
      if (!watch.stream) {
        return null
      }

      barrier = await watch.stream.barrier()
    } catch {
      // A stream that cannot prove delivery is not trusted again: the root is walked, and the next check restarts it.
      forget(watch)

      return null
    }

    barrierMs = (barrierMs + barrier.ms) / 2

    // I7: a tree released while the barrier was awaited answers nothing. The cache test is defense in depth, unreachable
    // today (A4-m2, MA4-4 equivalent): every path that drops or replaces this root's entry either forgets the watch too
    // (releaseRoot, close) or runs inside the root's queue (install, prewarm, enforceBudget and the idle sweep skip a
    // queued root), so the watch tests already refuse. Kept so a future path outside the queue still fails closed.
    if (!watch.healthy || watches.get(root) !== watch || cache.get(root) !== hit) {
      return null
    }

    const dirty = watch.dirty

    watch.dirty = new Set()

    if (dirty.size === 0) {
      deps.onMeasure?.(root, 'events-cached')

      return { entry: hit, cached: true }
    }

    // I1: the dirty folders go to the tree's worker; what comes back is the size of the change.
    const verdict = standing(await updated(root, hit, () => hit.tree.apply([...dirty])))

    // A3-m5: both tests are load-bearing and typed: a verdict that stands, and a tree still on one volume.
    if (verdict === null || !verdict.oneVolume || !watch.healthy) {
      return null
    }

    if (!verdict.cached) {
      hit.store = null
    }

    deps.onMeasure?.(root, 'events')

    return { entry: hit, cached: false }
  }

  /**
   * The tree as it is now. A cache hit is every directory unchanged (identity, mtime, ctime): the same answer as
   * before, as the fingerprint gave it. Otherwise only the changed directories are listed again, and that answer is
   * kept only when it reads no unscannable directory and exactly the linked inodes of the last answer; anything else
   * (a new link, a vanished one, a folder that cannot be listed) is decided by a full scan, so every refusal and
   * every new pass comes from the same walk as before. Past `CACHE_MAX_AGE_MS` since the last full scan, a full
   * scan (names made outside move no inside directory).
   */
  interface Refresh {
    /** now() when the walk began: the `fullAt` of what it answers. */
    started: number
    watch: RootWatch
    /** Every folder the stream named since the walk began: dirty for the answer it makes. */
    tap: Set<string>
    walk: Promise<TreeResident>
    done: boolean
    /** `background`: the paced walk nobody waits on; `fast`: a command needs it (header, TWO SCAN MODES). */
    pace: WalkPace
    /** Aborts this refresh's worker alone (a promotion, a stall), beside the guard's `walks` (close). */
    stop: AbortController
    /** clock() when its walk last reached a folder (or began): a check waiting on it refuses past the stall bound. */
    progressAt: number
  }

  /** INFO L1-7: `realParentJoin` kept while the root's stream is healthy (its WatchRoot flag voids the stream when
   *  any folder on the path to the root moves), so a warm check resolves no path; otherwise resolved again. */
  const resolvedRoots = new Map<string, string>()

  const knownRoot = (projectRoot: string): string | null => {
    const known = resolvedRoots.get(projectRoot)

    return known !== undefined && watches.get(known)?.healthy ? known : null
  }

  const rootOf = async (projectRoot: string): Promise<string> => {
    const root = (await realParentJoin(projectRoot)) ?? projectRoot

    resolvedRoots.delete(projectRoot)
    resolvedRoots.set(projectRoot, root)

    for (const oldest of resolvedRoots.keys()) {
      if (resolvedRoots.size <= 4 * MAX_WATCHED_ROOTS) {
        break
      }

      resolvedRoots.delete(oldest)
    }

    return root
  }

  /**
   * CF1: a check enters its root's queue in CALL order and at once (T3 depends on both: a post-exit check must not
   * overtake the next pre-check, nor start later than the exit's own turn), while no path is resolved synchronously.
   * A root seen before enters under its last resolution: with a healthy stream that is proven (WatchRoot), otherwise
   * it is resolved again in parallel with the measure, and a changed answer (a folder on the path moved) is measured
   * again under the new root. A root never seen waits for its first resolution; those run one after another, so
   * call order holds there too.
   */
  let resolving: Promise<void> = Promise.resolve()
  let resolvingCount = 0

  const enter = <T>(projectRoot: string, run: (root: string) => Promise<T>): Promise<T> => {
    const cached = resolvedRoots.get(projectRoot)

    if (cached !== undefined && resolvingCount === 0) {
      if (knownRoot(projectRoot) !== null) {
        return serial(cached, () => run(cached))
      }

      const recheck = rootOf(projectRoot)

      return serial(cached, async () => {
        const result = await run(cached)
        const now = await recheck

        return now === cached ? result : serial(now, () => run(now))
      })
    }

    resolvingCount += 1

    const entered = resolving
      .then(() => rootOf(projectRoot))
      .then(root => {
        resolvingCount -= 1

        return { result: serial(root, () => run(root)) }
      })

    resolving = entered.then(
      () => undefined,
      () => undefined
    )

    return entered.then(({ result }) => result)
  }

  const refreshes = new Map<string, Refresh>()
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastScanMs = new Map<string, number>()
  let closed = false

  /** CF4: the length of each stream-backed root's last completed background (paced) scan. */
  const refreshMs = new Map<string, number>()

  /** The scan length the cadence follows: the last background scan, else an estimate from the last full scan (a
   *  walked root has no background scan: its own full scan). */
  const cadenceScanMs = (root: string) =>
    refreshMs.get(root) ?? (lastScanMs.get(root) ?? 0) * (watches.has(root) ? BACKGROUND_SLOWDOWN : 1)

  /** The root's age bound (header, refreshCadence). */
  const boundFor = (root: string) => refreshCadence(cadenceScanMs(root)).boundMs

  /** Within the bound at `at`, counted from the start of the walk (`fullAt`). A2-m5: a wall clock stepped back (a
   *  negative age) is stale too, never fresh for longer. */
  const young = (root: string, entry: CacheEntry, at: number) =>
    at - entry.fullAt >= 0 && at - entry.fullAt < boundFor(root)

  /** How long after a background scan began the next one begins. */
  const intervalFor = (root: string) => refreshCadence(cadenceScanMs(root)).intervalMs

  /** A full scan of `root` began `ms` ago and completed: the bound follows it, and a stream-backed root's next
   *  background scan is scheduled one interval after this one began. */
  const afterFullScan = (root: string, ms: number, watched: boolean, background = false) => {
    lastScanMs.set(root, ms)

    if (background) {
      refreshMs.set(root, ms)
    }

    if (watched) {
      scheduleRefresh(root, Math.max(0, intervalFor(root) - ms))
    }
  }

  /** A completed background scan becomes the cached answer: only on the stream it started on, still healthy, and
   *  with every folder the stream named since its start left dirty (the next check re-lists them). */
  const install = (root: string, refresh: Refresh, tree: TreeResident): CacheEntry | null => {
    if (refresh.done) {
      return null
    }

    refresh.done = true
    refresh.watch.taps.delete(refresh.tap)

    if (refreshes.get(root) === refresh) {
      refreshes.delete(root)
    }

    const { watch } = refresh
    // A2-m1: a scan that began after this one (a check's own full scan meanwhile) knows more: never replaced by it.
    const newer = (cache.get(root)?.fullAt ?? Number.NEGATIVE_INFINITY) > refresh.started

    if (newer || !watch.healthy || watches.get(root) !== watch || !tree.oneVolume) {
      tree.release()

      return null
    }

    refresh.tap.forEach(dir => watch.dirty.add(dir))

    const entry: CacheEntry = { tree, fullAt: refresh.started, store: null, watch }

    setEntry(root, entry)
    deps.onRefresh?.(root, 'installed')
    afterFullScan(root, now().getTime() - refresh.started, true, refresh.pace === 'background')

    return entry
  }

  /**
   * The refresh of a stream-backed root at `pace` (the running one, if any); null without a healthy stream. A command
   * (`fast`) never takes a running `background` scan: it is promoted, i.e. aborted and replaced by a full-speed walk
   * (header, TWO SCAN MODES). A `background` request takes whatever runs.
   */
  const startRefresh = (root: string, pace: WalkPace = 'background'): Refresh | null => {
    const running = refreshes.get(root)

    if (running && (pace === 'background' || running.pace === 'fast')) {
      return running
    }

    const watch = watches.get(root)

    if (closed || !watch?.healthy) {
      return null
    }

    if (running) {
      running.done = true
      running.watch.taps.delete(running.tap)
      running.stop.abort()
      refreshes.delete(root)
      deps.onRefresh?.(root, 'promoted')
    }

    const tap = new Set<string>()
    const stop = new AbortController()

    watch.taps.add(tap)

    const refresh: Refresh = {
      started: now().getTime(),
      watch,
      tap,
      walk: (deps.onRefreshWalk?.(root, pace) ?? Promise.resolve()).then(() => {
        refresh.progressAt = clock()

        return walkFull(root, {
          signal: AbortSignal.any([walks.signal, stop.signal]),
          pace,
          onProgress: () => {
            refresh.progressAt = clock()
          }
        })
      }),
      done: false,
      pace,
      stop,
      progressAt: clock()
    }

    refreshes.set(root, refresh)

    if (!running) {
      deps.onRefresh?.(root, 'started')
    }

    refresh.walk.then(
      tree => void serial(root, async () => install(root, refresh, tree)),
      () => {
        refresh.done = true
        watch.taps.delete(tap)

        if (refreshes.get(root) === refresh) {
          refreshes.delete(root)
        }
      }
    )

    return refresh
  }

  /** The next background scan of `root`, `delayMs` from now (never keeps the process alive). */
  const scheduleRefresh = (root: string, delayMs: number) => {
    clearTimeout(refreshTimers.get(root))

    if (closed) {
      return
    }

    const timer = setTimeout(() => {
      refreshTimers.delete(root)
      void serial(root, async () => {
        if (idleAt(root, now().getTime())) {
          releaseRoot(root, 'idle')
        } else {
          startRefresh(root)
        }
      })
    }, delayMs)

    timer.unref?.()
    refreshTimers.set(root, timer)
  }

  /** I7 (F-1): a root's tree, stream, refresh timer and running refresh all go, so nothing scans it back in; its next
   *  check scans at full speed inside the start's deadline, else the start is refused (I3), never an answer from it. */
  const releaseRoot = (root: string, why: 'budget' | 'idle') => {
    const refresh = refreshes.get(root)

    if (refresh) {
      refresh.done = true
      refresh.watch.taps.delete(refresh.tap)
      refresh.stop.abort()
      refreshes.delete(root)
    }

    clearTimeout(refreshTimers.get(root))
    refreshTimers.delete(root)

    const watch = watches.get(root)

    if (watch) {
      forget(watch)
    }

    dropEntry(root)
    lastCheckedAt.delete(root)
    releasedRoots.add(root)
    deps.onRefresh?.(root, 'released')
    deps.onRootReleased?.(root, why)
  }

  /** I7: unchecked for IDLE_RELEASE_MS, never checked, or the clock stepped back (released: the cheap direction). */
  const idleAt = (root: string, at: number) => {
    const last = lastCheckedAt.get(root)

    return last === undefined || at < last || at - last >= idleReleaseMs
  }

  const streamBacked = (root: string, entry: CacheEntry | null | undefined): entry is CacheEntry =>
    Boolean(entry?.watch && entry.watch.healthy && watches.get(root) === entry.watch)

  /**
   * A stream-backed root past the age bound (the refresh fell behind, never ran, or the Mac slept): a full-speed scan
   * answers, promoting a running background one (header, TWO SCAN MODES). That wait is inside the start's deadline,
   * and the answer is never the stale scan.
   */
  const refreshed = async (root: string): Promise<CacheEntry | null> => {
    const refresh = startRefresh(root, 'fast')

    if (!refresh) {
      return null
    }

    let tree: TreeResident

    try {
      tree = await stallBounded(refresh)
    } catch (error) {
      // A2-m2: a hung worker refuses this check (and frees the root's queue); any other failure: the walk decides.
      if (error instanceof RefreshStalled) {
        throw error
      }

      return null
    }

    const entry = install(root, refresh, tree) ?? cache.get(root) ?? null

    // A2-M1: the answer must be within the bound when it is given, counted from the START of the walk it comes from
    // (`fullAt`): a scan the Mac slept through, or one that began too long ago, is stale and the walk decides.
    return entry && young(root, entry, now().getTime()) && streamBacked(root, entry) ? entry : null
  }

  /** A2-m2: the refresh a check waits on, refused once its walk reaches no new folder for `refreshStallMs`. */
  const stallBounded = (refresh: Refresh): Promise<TreeResident> =>
    new Promise<TreeResident>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined

      // One short timer at a time (no interval: nothing outlives the wait), each looking at the walk's last progress.
      const look = () => {
        if (clock() - refresh.progressAt > refreshStallMs) {
          refresh.stop.abort()
          reject(new RefreshStalled(`the scan reached no new folder for ${Math.round(refreshStallMs / 1000)} s`))

          return
        }

        timer = setTimeout(look, Math.max(10, Math.min(1_000, refreshStallMs / 4)))
        timer.unref?.()
      }

      look()
      refresh.walk.then(
        tree => {
          clearTimeout(timer)
          resolve(tree)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        }
      )
    })

  const measure = async (root: string, use = true): Promise<{ entry: CacheEntry; cached: boolean }> => {
    const at = now().getTime()

    if (use) {
      lastCheckedAt.set(root, at)
      releasedRoots.delete(root)
    }

    // I7 (F-7): every other idle root goes now (walked ones too: they have no refresh tick); O(roots).
    for (const other of [...cache.keys()]) {
      if (other !== root && !queues.has(other) && idleAt(other, at)) {
        releaseRoot(other, 'idle')
      }
    }

    const hit = entryOf(root)
    let fresh = hit && young(root, hit, at) ? hit : null

    if (hit && !fresh && streamBacked(root, hit)) {
      fresh = await refreshed(root)
    } else if (fresh && streamBacked(root, fresh) && at - fresh.fullAt >= intervalFor(root)) {
      startRefresh(root)
    }

    const covered = fresh?.watch

    if (fresh && covered && covered.healthy && watches.get(root) === covered && preferEvents(root, fresh)) {
      const answer = await measureByEvents(root, fresh, covered)

      if (answer) {
        return answer
      }
    }

    // I7: a tree released while this check waited answers nothing; the full scan decides. Reached today when the events
    // path dropped the tree it was handed (`updated` failed: outgrown or dead): without it the dropped tree is walked
    // again and counted dropped twice (A4-m2, MA4-5: hardlinks-fsevents.barrier.test.ts).
    if (fresh && cache.get(root) !== fresh) {
      fresh = null
    }

    // V-1b: the stream (when this root is worth one) starts before the walk it is to cover; what it saw until now is
    // in that walk.
    const watch = preferEvents(root, fresh) ? await ensureWatch(root) : null
    const walkStarted = performance.now()
    let entry: CacheEntry | null = null

    watch?.dirty.clear()

    if (fresh) {
      // I1: every folder is stat-ed where the tree lives; main learns the verdict.
      const verdict = standing(await updated(root, fresh, () => fresh.tree.walk()))

      walkMs.set(root, performance.now() - walkStarted)

      if (verdict !== null) {
        fresh.watch = covering(watch, walkStarted, fresh.tree)

        if (verdict.cached) {
          deps.onMeasure?.(root, 'walk-cached')

          return { entry: fresh, cached: true }
        }

        fresh.store = null
        entry = fresh
        deps.onMeasure?.(root, 'walk')
      }
    }

    if (!entry) {
      const began = now().getTime()

      // A2-M1: its age counts from the start of its own walk (a refresh may have been waited on before it).
      entry = await fullScan(root, now().getTime())
      entry.watch = covering(watch, walkStarted, entry.tree)
      deps.onMeasure?.(root, 'full')
      setEntry(root, entry)
      afterFullScan(root, now().getTime() - began, entry.watch !== null)
    }

    setEntry(root, entry)

    return { entry, cached: false }
  }

  /** Stops every FSEvents stream, background scan timer and walk worker of this guard (each root is walked until
   *  watched anew). */
  const close = (): void => {
    closed = true
    liveGuards.delete(live)
    walks.abort()
    refreshTimers.forEach(timer => clearTimeout(timer))
    refreshTimers.clear()
    ;[...watches.values()].forEach(forget)
    ;[...cache.entries()].forEach(([root, entry]) => dropEntry(root, entry))
  }

  /** CF1: this guard's first scan running now (the most recently started), for `activeFirstScan`. */
  const firstScan = (): HardlinkFirstScanView | null => {
    let latest: [string, { dirs: number; startedAt: number }] | null = null

    for (const entry of firstScans) {
      if (!latest || entry[1].startedAt >= latest[1].startedAt) {
        latest = entry
      }
    }

    return latest ? { root: latest[0], dirs: latest[1].dirs, startedAt: latest[1].startedAt } : null
  }

  /**
   * CF5 (B3-n2): `limit` file names of the refused group `dir` of `root` from `offset`, as the last check that
   * refused it found them (no scan). `digest` must be the group's: a group that changed since the pane read it is
   * `changed` (the pane reads the state again). Display only: allowing still goes through `acknowledgeGroup`.
   */
  const groupPaths = (
    projectRoot: string,
    dir: string,
    digest: string,
    offset: number,
    limit = HARDLINK_GROUP_PATHS_SENT
  ): HardlinkGroupPathsResult => {
    const root = resolvedRoots.get(projectRoot) ?? projectRoot
    const group = blockedGroups.get(root)?.find(item => item.view.dir === dir)

    if (!group || group.view.digest !== digest) {
      return { ok: false, reason: 'changed' }
    }

    const from = Math.max(0, Math.floor(offset))
    const size = Math.max(1, Math.min(HARDLINK_GROUP_PATHS_SENT, Math.floor(limit)))

    return {
      ok: true,
      count: group.members.length,
      offset: from,
      paths: group.members.slice(from, from + size).map(member => member.paths[0])
    }
  }

  const live = { close, firstScan, groupPaths }

  liveGuards.add(live)

  // One measure of a root at a time: a second check waits for the first and then reads the cache it left.
  const queues = new Map<string, Promise<unknown>>()

  const serial = <T>(root: string, run: () => Promise<T>): Promise<T> => {
    const next = (queues.get(root) ?? Promise.resolve()).then(run, run)

    const settled = next.then(
      () => undefined,
      () => undefined
    )

    queues.set(root, settled)
    void settled.then(() => {
      if (queues.get(root) === settled) {
        queues.delete(root)
        // I7: a root skipped by the budget while its check ran is released now, if still over.
        enforceBudget()
      }
    })

    return next
  }

  // T2'': the store-resolved inodes of one measured tree (`build` only), computed once per scan and kept with it.
  const storePassed = async (
    root: string,
    entry: CacheEntry,
    cls: ActivityClass | undefined
  ): Promise<ReadonlySet<string>> => {
    if (cls !== STORE_AUTO_PASS_CLASS || storeRoots.length === 0) {
      return EMPTY_PASS
    }

    if (!entry.store) {
      const open = entry.tree.scan.linked.filter(inode => !acknowledged(root, inode))
      const result = await resolveInStore(storeRoots, open, storeBudgetMs)

      deps.onStoreResolve?.(root, result)
      entry.store = result.passed
    }

    return entry.store
  }

  /** B6-m1: the groups of one linked set are computed once per (linked set, acknowledgements, store pass) and kept
   *  by the set's identity: a refused root's every check and T3 read them, not rebuild them. */
  const blockMemo = new WeakMap<
    readonly LinkedInode[],
    {
      ackGeneration: number
      passed: ReadonlySet<string>
      result: { block: HardlinkBlockView | null; groups: LinkGroup[] }
    }
  >()

  let ackGeneration = 0

  const blockOf = (
    root: string,
    scan: TreeScan,
    passed: ReadonlySet<string> = EMPTY_PASS
  ): { block: HardlinkBlockView | null; groups: LinkGroup[] } => {
    const memo = blockMemo.get(scan.linked)

    if (memo && memo.ackGeneration === ackGeneration && memo.passed === passed) {
      return memo.result
    }

    const result = blockOfNow(root, scan, passed)

    blockMemo.set(scan.linked, { ackGeneration, passed, result })

    return result
  }

  const blockOfNow = (
    root: string,
    scan: TreeScan,
    passed: ReadonlySet<string>
  ): { block: HardlinkBlockView | null; groups: LinkGroup[] } => {
    if (scan.unscannable.length > 0) {
      return {
        groups: [],
        block: {
          root,
          kind: 'cannot-scan',
          paths: scan.unscannable.slice(0, HARDLINK_PATHS_SHOWN),
          count: scan.unscannable.length,
          groups: []
        }
      }
    }

    const open = scan.linked.filter(inode => !acknowledged(root, inode) && !passed.has(inodeKey(inode)))

    if (open.length === 0) {
      return { block: null, groups: [] }
    }

    const groups = groupLinks(root, open)

    return {
      groups,
      block: {
        root,
        kind: 'hard-links',
        paths: open.slice(0, HARDLINK_PATHS_SHOWN).map(inode => inode.paths[0]),
        count: open.length,
        groups: groups.map(group => group.view)
      }
    }
  }

  /** `exitedAtMs` (T3, after a run): a refusal also says which of its links existed by then (through the exit's millisecond). A link
   *  whose inode ctime is later was made, or touched, after the exit and is not that run's to answer for; the refusal
   *  itself is whole. OPEN (L1-2): a write, chmod or `utimes` on the outside file after the exit also moves the ctime
   *  and hides the attribution (never the refusal); the live suite encodes this rule, a stricter one is the lead's. */
  const checkRoot = (
    projectRoot: string,
    cls: ActivityClass | undefined,
    exitedAtMs: number | undefined
  ): Promise<HardlinkCheck> => {
    const started = performance.now()

    return enter(projectRoot, root => checkIn(root, cls, exitedAtMs, started, true))
  }

  /** One check inside the root's queue; `use` false: the pane's re-measure, which is not a use (I7, F-5). */
  const checkIn = async (
    root: string,
    cls: ActivityClass | undefined,
    exitedAtMs: number | undefined,
    started: number,
    use: boolean
  ): Promise<HardlinkCheck> => {
    const { entry, cached } = await measure(root, use)
    const { scan } = entry.tree
    const passed = await storePassed(root, entry, cls)
    const { block, groups } = blockOf(root, scan, passed)
    const ms = performance.now() - started

    if (!block) {
      blocked.delete(root)
      blockedGroups.delete(root)

      return { ok: true, cached, files: scan.files, dirs: scan.dirs, ms, passed: passed.size }
    }

    blocked.set(root, block)
    blockedGroups.set(root, groups)

    if (exitedAtMs === undefined) {
      return { ok: false, cached, block, ms }
    }

    // L1-2 (ms rounding): exitedAt is Date.now(), whole ms, and a ctime has a fraction: the exit's whole ms counts.
    const exitEnd = Math.floor(exitedAtMs) + 1
    const existed = scan.linked.filter(inode => inode.ctimeMs < exitEnd)

    // B6-m1: when every link predates the exit (the usual T3), the refusal IS the attribution: the memoised groups
    // answer, and the filtered set is grouped only when some link is later than the exit.
    const appeared =
      existed.length === scan.linked.length ? block : blockOf(root, { ...scan, linked: existed }, passed).block

    return { ok: false, cached, block, ms, appeared }
  }

  return {
    keyHex: (): string => key.toString('hex'),
    /** True when the record outlives this main (the key is sealed in safeStorage); false: allowances end with it. */
    persistent: (): boolean => persistent,
    /** Before a confined run in `root`: refuses while an inode with a name outside it is not acknowledged, or while
     *  a directory inside it cannot be listed. `cls` is the run's class: `build` alone may pass a link whose other
     *  names all resolve into the pnpm store (T2''); without a class, only the owner's gesture counts. */
    check(projectRoot: string, cls?: ActivityClass, exitedAtMs?: number): Promise<HardlinkCheck> {
      return checkRoot(projectRoot, cls, exitedAtMs)
    },
    /** I7 (F-5): the pane's re-measure of a refused root (index.ts). Not a use, so it never keeps a root from going
     *  idle, and a released root stays released until a start or the gesture checks it. Never throws. */
    recheckBlocked(projectRoot: string): Promise<void> {
      const started = performance.now()

      return enter(projectRoot, async root => {
        if (cache.has(root) || !releasedRoots.has(root)) {
          await checkIn(root, undefined, undefined, started, false)
        }
      }).catch(() => undefined)
    },
    /** The roots a confined run was refused in, as main last measured them (index.ts re-measures the stale ones). */
    blocked: (): HardlinkBlockView[] => [...blocked.values()],
    groupPaths,
    /**
     * The owner's gesture-gated answer (ipc.ts checks the gesture): every hard-linked file under `dir` of `root`, as
     * main scans it now, may run confined. `digest` must match that set exactly: a link planted since the pane showed
     * the group is a new question (`changed`), as is any inode that appears later.
     */
    async acknowledgeGroup(projectRoot: string, dir: string, digest: string): Promise<HardlinkAckResult> {
      const root = path.isAbsolute(projectRoot) ? await realParentJoin(projectRoot) : null
      const target = path.isAbsolute(dir) ? await realParentJoin(dir) : null

      if (!root || !target || typeof digest !== 'string') {
        return { ok: false, reason: 'invalid' }
      }

      if (!within(target, root)) {
        return { ok: false, reason: 'not-in-project' }
      }

      const { scan } = (await serial(root, () => measure(root))).entry.tree
      const { block, groups } = blockOf(root, scan)
      const group = groups.find(item => item.view.dir === target)

      if (!block || block.kind !== 'hard-links') {
        return { ok: false, reason: 'nothing-to-allow' }
      }

      if (!group) {
        return { ok: false, reason: 'nothing-to-allow' }
      }

      if (group.view.digest !== digest) {
        return { ok: false, reason: 'changed' }
      }

      const at = now().toISOString()

      const fresh = group.members.map((member): HardlinkAck => ({
        root,
        path: member.paths[0],
        dev: member.dev,
        ino: member.ino,
        at
      }))

      const covered = new Set(fresh.map(inodeKey))

      acks = [...acks.filter(item => !(item.root === root && covered.has(inodeKey(item)))), ...fresh]
      ackKeys = new Set(acks.map(ack => ackKey(ack.root, ack)))
      ackGeneration += 1
      persist()

      // What the pane shows now, from the scan just made: cleared when nothing else is open (no class, no store pass).
      const left = blockOf(root, scan).block

      if (!left) {
        blocked.delete(root)
        blockedGroups.delete(root)
      } else if (blocked.has(root)) {
        blocked.set(root, left)
        blockedGroups.set(root, blockOf(root, scan).groups)
      }

      return { ok: true, dir: target, count: fresh.length, acks: fresh }
    },
    acks: (): readonly HardlinkAck[] => acks,
    /**
     * V-1b: the root is known (its Hermes is starting): its first full scan and its stream start now, in the
     * background, so the first command reads a finished scan instead of waiting for it. Never refuses or throws.
     */
    prewarm(projectRoot: string): Promise<void> {
      return enter(projectRoot, async root => {
        const at = now().getTime()
        const hit = cache.get(root)

        // I7 (F-4): a prewarm is a use (the first command may come later than the first refresh tick).
        lastCheckedAt.set(root, at)
        releasedRoots.delete(root)

        if (hit && at - hit.fullAt < boundFor(root)) {
          return
        }

        const watch = await ensureWatch(root)
        const walkStarted = performance.now()

        watch?.dirty.clear()

        const entry = await fullScan(root, at)

        entry.watch = covering(watch, walkStarted, entry.tree)
        setEntry(root, entry)
        afterFullScan(root, now().getTime() - at, entry.watch !== null)
      }).catch(() => undefined)
    },
    /**
     * Item 4 (v0.0.7): when the root's FIRST full scan (none completed yet) last reached a directory, in `clock` ms;
     * null when no first scan of that root is running. `checkBeforeStart` keeps waiting past its deadline while this
     * advances.
     */
    firstScanProgress(projectRoot: string): number | null {
      return firstScans.get(resolvedRoots.get(projectRoot) ?? projectRoot)?.at ?? null
    },
    /** CF1: this guard's first scan running now, or null (`activeFirstScan` reads every live guard's). */
    firstScan,
    /** Stops every FSEvents stream and background scan timer of this guard (each root is walked until watched anew). */
    close
  }
}

export type HardlinkGuard = ReturnType<typeof createHardlinkGuard>

/** How long a confined start waits for its hard-link check before it is refused (fail closed: the walk goes on in
 *  the background, and the next start in that root reads what it found). */
export const HARDLINK_CHECK_DEADLINE_MS = 30_000
/** Item 4 (v0.0.7): while the root's FIRST full scan is advancing, the start waits up to this instead (the owner's
 *  project took 36.6 s to scan once). */
export const HARDLINK_FIRST_SCAN_DEADLINE_MS = 120_000
/** A first scan that reached no new directory for this long is not advancing: the start is refused as before. */
export const HARDLINK_FIRST_SCAN_STALL_MS = 5_000
/** How often the extended wait looks at the scan's progress. */
const FIRST_SCAN_POLL_MS = 1_000

/** A check that did not answer: past the deadline, or failed outright. Either way the start is refused. */
export interface HardlinkUnanswered {
  ok: false
  unanswered: 'timeout' | 'error'
  detail: string
}

/** The guard as a start waits on it. `firstScanProgress` is optional so a bare `check` (tests, other callers) keeps
 *  the plain deadline; the app's guard has it. */
export type HardlinkStartGuard = Pick<HardlinkGuard, 'check'> & Partial<Pick<HardlinkGuard, 'firstScanProgress'>>

export interface CheckBeforeStartTimings {
  firstScanDeadlineMs?: number
  stallMs?: number
  pollMs?: number
  /** The same monotonic clock as the guard's `clock` dep. */
  now?: () => number
}

/**
 * The check a confined start waits for: what it answered, or why it did not. Never past `deadlineMs`, except while
 * the root's FIRST full scan is advancing (it reached a directory within `stallMs`): then up to `firstScanDeadlineMs`
 * from the start of the wait. A scan that stalls, or that outlasts the longer bound, is refused as at the deadline.
 * Only timers wait here; the walk itself stays off the main thread.
 */
export function checkBeforeStart(
  guard: HardlinkStartGuard,
  root: string,
  cls: ActivityClass | undefined,
  deadlineMs = HARDLINK_CHECK_DEADLINE_MS,
  timings: CheckBeforeStartTimings = {}
): Promise<HardlinkCheck | HardlinkUnanswered> {
  const now = timings.now ?? (() => performance.now())
  const firstScanDeadlineMs = Math.max(deadlineMs, timings.firstScanDeadlineMs ?? HARDLINK_FIRST_SCAN_DEADLINE_MS)
  const stallMs = timings.stallMs ?? HARDLINK_FIRST_SCAN_STALL_MS
  const pollMs = timings.pollMs ?? FIRST_SCAN_POLL_MS
  const began = now()

  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const refuse = (detail: string) => resolve({ ok: false, unanswered: 'timeout', detail })

    const waitOrRefuse = () => {
      const at = now()
      const progress = guard.firstScanProgress?.(root) ?? null
      const advancing = progress !== null && at - progress <= stallMs
      const left = firstScanDeadlineMs - (at - began)

      if (advancing && left > 0) {
        timer = setTimeout(waitOrRefuse, Math.min(pollMs, left))

        return
      }

      if (progress === null || at - began < deadlineMs) {
        refuse(`no answer within ${Math.round(deadlineMs / 1000)} s`)
      } else if (!advancing) {
        refuse(`the first scan reached no new folder for ${Math.round(stallMs / 1000)} s`)
      } else {
        refuse(`the first scan did not finish within ${Math.round(firstScanDeadlineMs / 1000)} s`)
      }
    }

    timer = setTimeout(waitOrRefuse, deadlineMs)

    guard.check(root, cls).then(
      result => {
        clearTimeout(timer)
        resolve(result)
      },
      (error: unknown) => {
        clearTimeout(timer)
        resolve({ ok: false, unanswered: 'error', detail: error instanceof Error ? error.message : String(error) })
      }
    )
  })
}

/** The one English sentence for a start refused because the check did not answer. */
export function hardlinkUnansweredRefusal(root: string, result: HardlinkUnanswered): string {
  return result.unanswered === 'timeout'
    ? `confinement refused to start in ${root}: the hard-link check is still scanning the project (${result.detail}); try again in a moment`
    : `confinement refused to start in ${root}: the hard-link check failed (${result.detail})`
}

/** The one English sentence for logs and stderr (the pane words it from the catalogue). */
export function hardlinkRefusal(block: HardlinkBlockView): string {
  const more = block.count > block.paths.length ? ` and ${block.count - block.paths.length} more` : ''
  const one = block.count === 1

  if (block.kind === 'cannot-scan') {
    return `confinement refused to start in ${block.root}: cannot scan ${block.paths.join(', ')}${more} (${one ? 'a directory' : 'directories'} it cannot list); fix ${one ? 'its' : 'their'} permissions`
  }

  return `confinement refused to start in ${block.root}: ${block.paths.join(', ')}${more} ${one ? 'is a hard link' : 'are hard links'} to a file outside the project; remove ${one ? 'it' : 'them'} or allow ${one ? 'it' : 'them'} in Containers`
}

/** The roots the Hermes plugin refused (`{"blocked": {root: {...}}}`): display only, and only the roots. Main
 *  measures each one itself before the pane offers anything under it. */
export function readHardlinkReportRoots(file: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { blocked?: Record<string, unknown> }

    return Object.keys(raw.blocked ?? {}).filter(root => path.isAbsolute(root))
  } catch {
    return []
  }
}
