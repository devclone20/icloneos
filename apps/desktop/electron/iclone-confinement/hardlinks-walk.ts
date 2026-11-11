/**
 * v0.0.7 CF1 — the F7 guard's tree: its directory records and the asynchronous walk that makes them (section 1), the
 * fold that summarises them (section 2), the RESIDENT tree model a check updates without a full scan (section 3,
 * CF7), the paced synchronous walk of the background refresh (section 4, CF4b) and the worker thread that runs a
 * FULL scan and then keeps the tree (section 5). hardlinks.ts is the guard; hardlinks-walker.ts is main's side of
 * the worker.
 *
 * ONE FILE, pure `node:fs`: no Electron, no addon, no import of the app and no relative import. This file is the
 * worker's entry (bundled as dist/hardlinks-walk-worker.cjs, or run as TypeScript source under Node's type
 * stripping, which resolves no extensionless relative import), and the spawn audit pins it as the only code the
 * worker runs. The worker starts only with `workerData.icloneTask === 'hardlink-walk'` (hardlinks-walker.ts spawns
 * it), so importing this file anywhere else runs nothing.
 *
 * Why resident (CF7, critic rounds B-M1 to B5-M1): every earlier design handed the records to main, and every path
 * that then touched them on main — install, copy, fold, compare, incremental walk — cost the tree (520 000 folders on
 * the owner's project). Now main holds a root's SUMMARY only (`TreeScan`: the linked inodes, the unscannable folders,
 * the counts, one-volume) and sends the worker the dirty folders; the worker answers with a verdict the size of the
 * change. No message between the two is ever the size of the tree.
 *
 * Worker protocol: `progress` {dirs} at most every PROGRESS_EVERY_MS while the count moves, and once more at the end
 * of the walk; then `done` {dirs, scan, oneVolume}; or `error` {message} at any point (the worker is then spent).
 * After `done` the worker answers requests, each by `id`: `apply` {dirty} and `walk` with `answer` {verdict}
 * (`TreeVerdict`), `dump` with `dumped` {entries} (tests and the in-process hand-over of a small tree only: the guard
 * never asks for the records). A request that fails answers `error` for that id alone.
 */
import { type BigIntStats, type Dirent, lstatSync, readdirSync, type Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { isMainThread, type MessagePort, parentPort, workerData } from 'node:worker_threads'

const within = (child: string, parent: string) => child === parent || child.startsWith(`${parent}${path.sep}`)

// ─── 1. Records and the asynchronous walk ───────────────────────────────────────────────────────────────────────
// A record is one directory as it was last listed (`DirRecord`). `fillRecord` is the single rule both walks (this
// asynchronous one and the synchronous background one, section 4) apply, so their records are the same record for
// record.

export const errnoOf = (error: unknown): string => String((error as NodeJS.ErrnoException | null)?.code ?? '')

/** One name of a multiply-linked regular file, as its directory was last listed. */
export interface FileName {
  name: string
  dev: number
  ino: number
  nlink: number
  ctimeMs: number
}

/**
 * One directory as it was last listed. Its entries are a function of its identity and its mtime and ctime: an
 * entry cannot be added, removed, renamed or replaced without moving the ctime, which no user call can set back
 * (`utimes` moves it too). So while those match, the listing below is the directory's listing now.
 */
export interface DirRecord {
  dev: bigint
  ino: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  /** The subdirectories to walk, in listing order (cut where a child could not be stat-ed, T1'). */
  subdirs: string[]
  files: number
  links: FileName[]
  /** The listing failed (T1), or a child's link count could not be read (T1'). */
  unscannable: boolean
}

/** A directory whose own `lstat` failed (not ENOENT): it hides whatever it holds. */
export const UNSTATABLE = 'unstatable'

export type TreeRecords = Map<string, DirRecord | typeof UNSTATABLE>

/** How many directories one walk has in flight, and how many children of one directory are stat-ed at once: bounded,
 *  so the walk never floods the thread pool other I/O of main shares, and no turn of main's loop runs long. */
export const WALK_DIRS_IN_FLIGHT = 8
const WALK_STATS_IN_FLIGHT = 32

/** Runs `task` over `initial` and everything it returns, at most `inFlight` at a time; rejects with the first failure. */
export function drain<T>(
  initial: readonly T[],
  inFlight: number,
  task: (item: T) => Promise<readonly T[]>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const queue = [...initial]
    let active = 0
    let failed = false

    const pump = (): void => {
      if (failed) {
        return
      }

      if (queue.length === 0 && active === 0) {
        resolve()

        return
      }

      while (active < inFlight && queue.length > 0) {
        active += 1
        task(queue.pop() as T).then(
          more => {
            active -= 1

            for (const item of more) {
              queue.push(item)
            }

            pump()
          },
          (error: unknown) => {
            failed = true
            reject(error)
          }
        )
      }
    }

    pump()
  })
}

/** `lstat` of each path, `WALK_STATS_IN_FLIGHT` at a time: the stat, or the error it threw. */
export async function lstatEach(paths: readonly string[]): Promise<Array<Stats | { error: unknown }>> {
  const out: Array<Stats | { error: unknown }> = []

  for (let at = 0; at < paths.length; at += WALK_STATS_IN_FLIGHT) {
    out.push(
      ...(await Promise.all(
        paths.slice(at, at + WALK_STATS_IN_FLIGHT).map(file => lstat(file).catch((error: unknown) => ({ error })))
      ))
    )
  }

  return out
}

/**
 * One directory listed now. Symlinks are never followed: Seatbelt resolves a symlink to its target and judges that,
 * so they are not this module's concern. Null: it vanished between its `lstat` and its listing (nothing is hidden).
 */
export async function listDirectory(dir: string, stat: BigIntStats): Promise<DirRecord | null> {
  const record = emptyRecord(stat)
  let entries: Dirent[]

  try {
    // `readdir` (scandir) returns the names sorted, the order the T1' cut below is defined on.
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    // Gone since its parent was listed: nothing is hidden there. Anything else hides what it holds (T1).
    if (errnoOf(error) === 'ENOENT') {
      return null
    }

    record.unscannable = true

    return record
  }

  const regular = entries.filter(entry => !entry.isDirectory() && entry.isFile())
  const stats = new Map<string, Stats | { error: unknown }>()

  const results = await lstatEach(regular.map(entry => path.join(dir, entry.name)))

  regular.forEach((entry, index) => stats.set(entry.name, results[index]))

  return fillRecord(record, dir, entries, name => stats.get(name) as Stats | { error: unknown })
}

export const emptyRecord = (stat: BigIntStats): DirRecord => ({
  dev: stat.dev,
  ino: stat.ino,
  mtimeNs: stat.mtimeNs,
  ctimeNs: stat.ctimeNs,
  subdirs: [],
  files: 0,
  links: [],
  unscannable: false
})

/** The listing's subdirectories, file count and multiply-linked files into `record`; `statOf` gives a regular file's
 *  `lstat` (or its error) by name, in listing order. The one rule both walks (async and the worker's sync) apply. */
export function fillRecord(
  record: DirRecord,
  dir: string,
  entries: readonly Dirent[],
  statOf: (name: string) => Stats | { error: unknown }
): DirRecord {
  for (const entry of entries) {
    if (entry.isDirectory()) {
      record.subdirs.push(path.join(dir, entry.name))

      continue
    }

    record.files += 1

    if (!entry.isFile()) {
      continue
    }

    const result = statOf(entry.name)

    if ('error' in result) {
      // Gone between readdir and lstat: nothing is there. Anything else (EACCES on a `chmod 400` directory, EPERM,
      // ELOOP, EIO…) hides this child's link count, and so the whole directory (T1'): refused. Its subdirectories
      // listed before it report themselves (they cannot be listed either), so the answer to an unchanged tree is
      // this same refusal.
      if (errnoOf(result.error) !== 'ENOENT') {
        record.unscannable = true

        break
      }

      continue
    }

    if (result.nlink > 1) {
      record.links.push({
        name: entry.name,
        dev: result.dev,
        ino: result.ino,
        nlink: result.nlink,
        ctimeMs: result.ctimeMs
      })
    }
  }

  return record
}

export const sameDirectory = (record: DirRecord, stat: BigIntStats) =>
  record.dev === stat.dev &&
  record.ino === stat.ino &&
  record.mtimeNs === stat.mtimeNs &&
  record.ctimeNs === stat.ctimeNs

/**
 * One walk of the tree, asynchronous (the file system calls run in the thread pool). A full scan runs it inside the
 * walk worker (below), so main's thread only receives the records; an incremental walk (`previous` given) runs where
 * it is called. Every directory is `lstat`-ed; a directory whose identity, mtime and ctime match `previous` keeps its listing
 * (and the link counts read with it), every other one is listed and its regular files stat-ed again. With no
 * `previous` every directory is listed: the full scan.
 */
export async function walkTree(
  root: string,
  previous: TreeRecords | null,
  onDir?: () => void
): Promise<{ records: TreeRecords; listed: number }> {
  const records: TreeRecords = new Map()
  let listed = 0

  await drain([root], WALK_DIRS_IN_FLIGHT, async dir => {
    onDir?.()

    let stat: BigIntStats

    try {
      stat = await lstat(dir, { bigint: true })
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') {
        records.set(dir, UNSTATABLE)
      }

      return []
    }

    const before = previous?.get(dir)
    let record: DirRecord | null

    if (before && before !== UNSTATABLE && sameDirectory(before, stat)) {
      record = before
    } else {
      listed += 1
      record = await listDirectory(dir, stat)
    }

    if (!record) {
      return []
    }

    records.set(dir, record)

    return record.subdirs
  })

  return { records, listed }
}

// ─── 2. The fold: records → scan ─────────────────────────────────────────────────────────────────────────────────
// INCREMENTAL (CF7): the fold takes each record in and out as it changes (`add`, `remove`), so the scan after a
// change costs the change, never the tree; `scan()` then costs the multiply-linked inodes alone. `scanOf` is the same
// fold over a whole Map in one pass, for the in-process holder of a small tree and for tests: the property test
// (hardlinks.tree.test.ts) holds the incremental fold equal to it after random change sets.

export interface LinkedInode {
  dev: number
  ino: number
  nlink: number
  /** The names found inside the root, sorted. */
  paths: string[]
  /** r6: the same names as identities — `<dev>:<ino>` of the folder holding the name, `/`, the name — so one name
   *  reached by two spellings (a nested root, a firmlink alias) is one name. */
  names: string[]
  /** The inode's ctime as last stat-ed (a new name moves it): what tells a link made before a run's exit (T3). */
  ctimeMs: number
}

export interface TreeScan {
  files: number
  /** Directories walked. */
  dirs: number
  /** Inodes with at least one name outside the root. */
  linked: LinkedInode[]
  /** Directories inside the root that could not be listed (not vanished: refused, looping, broken). */
  unscannable: string[]
}

export const inodeKey = (inode: Pick<LinkedInode, 'dev' | 'ino'>): string => `${inode.dev}:${inode.ino}`

/** One name of a multiply-linked inode as a record carries it: its link count and ctime as read with that name. */
interface HeldName {
  nlink: number
  ctimeMs: number
  identity: string
}

interface HeldInode {
  dev: number
  ino: number
  /** By the name's full path (two names of one inode in one folder are two paths). */
  names: Map<string, HeldName>
}

/** The scan and the device set of a set of directory records, kept current as records come and go. */
export class TreeScanFold {
  private readonly byInode = new Map<string, HeldInode>()
  private readonly unscannable = new Set<string>()
  /** Records per device: a device leaves the set with its last record. */
  private readonly devices = new Map<bigint, number>()
  private files = 0
  private dirs = 0

  add(dir: string, record: DirRecord | typeof UNSTATABLE): void {
    this.dirs += 1

    if (record === UNSTATABLE) {
      this.unscannable.add(dir)

      return
    }

    this.devices.set(record.dev, (this.devices.get(record.dev) ?? 0) + 1)

    if (record.unscannable) {
      this.unscannable.add(dir)
    }

    this.files += record.files

    for (const link of record.links) {
      const key = inodeKey(link)
      const inode = this.byInode.get(key) ?? { dev: link.dev, ino: link.ino, names: new Map<string, HeldName>() }

      inode.names.set(path.join(dir, link.name), {
        nlink: link.nlink,
        ctimeMs: link.ctimeMs,
        identity: `${record.dev}:${record.ino}/${link.name}`
      })
      this.byInode.set(key, inode)
    }
  }

  /** The exact reverse of `add(dir, record)`. */
  remove(dir: string, record: DirRecord | typeof UNSTATABLE): void {
    this.dirs -= 1

    if (record === UNSTATABLE) {
      this.unscannable.delete(dir)

      return
    }

    const onDevice = (this.devices.get(record.dev) ?? 0) - 1

    if (onDevice > 0) {
      this.devices.set(record.dev, onDevice)
    } else {
      this.devices.delete(record.dev)
    }

    this.unscannable.delete(dir)
    this.files -= record.files

    for (const link of record.links) {
      const key = inodeKey(link)
      const inode = this.byInode.get(key)

      if (!inode) {
        continue
      }

      inode.names.delete(path.join(dir, link.name))

      if (inode.names.size === 0) {
        this.byInode.delete(key)
      }
    }
  }

  scan(): TreeScan {
    const linked: LinkedInode[] = []

    for (const inode of this.byInode.values()) {
      let nlink = 0
      let ctimeMs = 0
      const paths: string[] = []
      const names: string[] = []

      for (const [file, held] of inode.names) {
        // Names read at different times may disagree on the count: the larger one never hides a name.
        nlink = Math.max(nlink, held.nlink)
        ctimeMs = Math.max(ctimeMs, held.ctimeMs)
        paths.push(file)
        names.push(held.identity)
      }

      if (paths.length < nlink) {
        linked.push({ dev: inode.dev, ino: inode.ino, nlink, paths: paths.sort(), names: names.sort(), ctimeMs })
      }
    }

    linked.sort((a, b) => (a.paths[0] < b.paths[0] ? -1 : 1))

    return { files: this.files, dirs: this.dirs, linked, unscannable: [...this.unscannable].sort() }
  }

  /** The tree is on one device: a mount inside it is a volume whose changes the root's stream may never report. */
  oneVolume(top: DirRecord | typeof UNSTATABLE | undefined): boolean {
    return top !== undefined && top !== UNSTATABLE && this.devices.size === 1 && this.devices.has(top.dev)
  }
}

/** The fold of every record of `records`, in one pass. */
export function foldOf(records: TreeRecords): TreeScanFold {
  const fold = new TreeScanFold()

  for (const [dir, record] of records) {
    fold.add(dir, record)
  }

  return fold
}

/** The scan a set of directory records makes: the link groups by inode, the unscannable directories. */
export function scanOf(records: TreeRecords): TreeScan {
  return foldOf(records).scan()
}

export function oneVolume(root: string, records: TreeRecords): boolean {
  return foldOf(records).oneVolume(records.get(root))
}

/** The same linked set, member for member: the rule under which an incremental answer stands (hardlinks.ts header). */
export const sameLinked = (a: readonly LinkedInode[], b: readonly LinkedInode[]): boolean =>
  a.length === b.length &&
  a.every(
    (inode, index) =>
      inodeKey(inode) === inodeKey(b[index]) &&
      inode.nlink === b[index].nlink &&
      inode.paths.join('\0') === b[index].paths.join('\0') &&
      inode.names.join('\0') === b[index].names.join('\0')
  )

// ─── 3. The resident tree: the model a check updates ─────────────────────────────────────────────────────────────
// Invariant (the guard's answers rest on it): the committed records and `scan` are always the last STANDING answer.
// An update is prepared beside the records (an overlay), judged, and committed only when it stands; otherwise it is
// reverted whole, so neither a failed re-list nor a changed link set ever leaves a half-applied tree behind. The
// standing rule is the V-1 rule of hardlinks.ts: no unscannable folder and exactly the linked inodes of the last
// answer (`sameLinked`); anything else is decided by a full scan, which replaces this tree.
//
// `applyDirty` (V-1b): the folders FSEvents named, shallowest first. A dirty folder with the same identity, mtime and
// ctime keeps its listing (an entry cannot be added, removed, renamed or replaced without moving the ctime); one
// that changed is listed again, its vanished subfolders dropped and every subfolder it lists checked by identity (a
// new one, or one replaced by another folder of the same name, is walked whole). A folder whose identity changed is
// walked whole. A folder the events name that this tree cannot place (not under the root, not listed by any parent,
// unstatable) cannot be vouched for: `placed: false`, and the caller walks the whole tree.
// `walkIncremental` (V-1): every directory `lstat`-ed, the changed ones listed again; `cached` when nothing moved.
//
// Costs, in N = folders of the tree and D = dirty folders: `applyDirty` O(D + what the changed folders list),
// `walkIncremental` O(N) stats (in the worker for a tree past IN_PROCESS_MAX_DIRS folders), `scan()` the
// multiply-linked inodes. A dropped subtree costs its own size: the records are reachable from the root through
// `subdirs` alone (every insertion comes from a listing chain), so a subtree is dropped by following them, never by
// scanning the Map.

/** What the guard learns from an update, beside the records it never sees. */
export type TreeVerdict =
  /** The events named a folder this tree cannot place: the whole tree must be walked. */
  | { placed: false }
  /** Applied and judged, but it does not stand (a new or vanished link, an unscannable folder): the records are as
   *  they were; a full scan decides. */
  | { placed: true; stands: false }
  | {
      placed: true
      stands: true
      /** Nothing moved: the answer is the previous one. */
      cached: boolean
      files: number
      dirs: number
      oneVolume: boolean
      /** The linked inodes whose ctime moved (by index into the unchanged linked list), for T3. */
      ctimes: Array<[number, number]>
    }

type Overlay = Map<string, DirRecord | typeof UNSTATABLE | null>

/** CF7 round 2 (B6-M1): an in-process tree that grew past its bound while an update walked it. The update stops at
 *  once (the caller drops the tree and a worker scans the root), so main never walks more than the bound. */
export class TreeOutgrown extends Error {
  constructor(maxDirs: number) {
    super(`the tree outgrew ${maxDirs} folders`)
  }
}

export class TreeState {
  readonly root: string
  /** Folders this tree may hold while an update walks it (an in-process tree: hardlinks-walker.ts); unbounded in
   *  the worker. */
  readonly maxDirs: number
  private records: TreeRecords
  private fold: TreeScanFold
  private last: TreeScan

  // No parameter property: Node's strip-only TypeScript (the worker's source form) does not take one.
  constructor(root: string, records: TreeRecords, maxDirs = Number.POSITIVE_INFINITY) {
    this.root = root
    this.maxDirs = maxDirs
    this.records = records
    this.fold = foldOf(records)
    this.last = this.fold.scan()
  }

  /** The last standing answer. */
  scan(): TreeScan {
    return this.last
  }

  oneVolume(): boolean {
    return this.fold.oneVolume(this.records.get(this.root))
  }

  /** How many folders the tree holds. */
  size(): number {
    return this.records.size
  }

  /** The records themselves (tests and the in-process hand-over only; the guard never asks). */
  dump(): TreeRecords {
    return new Map(this.records)
  }

  /** A folder-count guard for one update's walks: past `maxDirs` folders reached, the update is abandoned. */
  private budget(): () => void {
    let reached = this.records.size

    return () => {
      reached += 1

      if (reached > this.maxDirs) {
        throw new TreeOutgrown(this.maxDirs)
      }
    }
  }

  async applyDirty(dirty: readonly string[]): Promise<TreeVerdict> {
    const over: Overlay = new Map()
    const walked: string[] = []
    const onDir = this.budget()
    const depth = (dir: string) => dir.split(path.sep).length
    const order = [...new Set(dirty)].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1))

    if (order.some(dir => !within(dir, this.root))) {
      return { placed: false }
    }

    const get = (dir: string) => (over.has(dir) ? (over.get(dir) ?? undefined) : this.records.get(dir))

    const drop = (top: string) => {
      const stack = [top]

      for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
        const record = get(dir)

        if (record === undefined) {
          continue
        }

        over.set(dir, null)

        if (record !== UNSTATABLE) {
          for (const sub of record.subdirs) {
            stack.push(sub)
          }
        }
      }
    }

    const walkWhole = async (dir: string) => {
      drop(dir)
      walked.push(dir)

      for (const [key, record] of (await walkTree(dir, null, onDir)).records) {
        over.set(key, record)
      }
    }

    for (const dir of order) {
      if (walked.some(done => within(dir, done))) {
        continue
      }

      let stat: BigIntStats

      try {
        stat = await lstat(dir, { bigint: true })
      } catch (error) {
        if (errnoOf(error) !== 'ENOENT') {
          return { placed: false }
        }

        drop(dir)

        continue
      }

      const before = get(dir)

      if (!stat.isDirectory()) {
        // A file's name, or a folder replaced by a file: the parent's listing (its ctime moved) says what it is.
        if (before) {
          drop(dir)
        }

        continue
      }

      if (!before) {
        // Only a folder some parent lists is part of the tree; one no relist above placed cannot be vouched for.
        return { placed: false }
      }

      if (before === UNSTATABLE || before.dev !== stat.dev || before.ino !== stat.ino) {
        await walkWhole(dir)

        continue
      }

      if (sameDirectory(before, stat)) {
        continue
      }

      const record = await listDirectory(dir, stat)

      if (!record) {
        drop(dir)

        continue
      }

      over.set(dir, record)

      const listedNow = new Set(record.subdirs)

      for (const gone of before.subdirs.filter(sub => !listedNow.has(sub))) {
        drop(gone)
      }

      for (const sub of record.subdirs) {
        const known = get(sub)

        if (!known || known === UNSTATABLE) {
          await walkWhole(sub)

          continue
        }

        try {
          const now = await lstat(sub, { bigint: true })

          if (now.dev !== known.dev || now.ino !== known.ino) {
            await walkWhole(sub)
          }
        } catch {
          await walkWhole(sub)
        }
      }
    }

    return this.commit(over)
  }

  async walkIncremental(): Promise<TreeVerdict> {
    let reached = 0

    const { records, listed } = await walkTree(this.root, this.records, () => {
      reached += 1

      if (reached > this.maxDirs) {
        throw new TreeOutgrown(this.maxDirs)
      }
    })

    const cached =
      listed === 0 &&
      records.size === this.records.size &&
      [...records].every(([dir, record]) => this.records.get(dir) === record)

    if (cached) {
      return this.standing(true)
    }

    const fold = foldOf(records)
    const scan = fold.scan()

    if (scan.unscannable.length > 0 || !sameLinked(scan.linked, this.last.linked)) {
      return { placed: true, stands: false }
    }

    this.records = records
    this.fold = fold

    return this.adopt(scan)
  }

  /** The overlay into the records and the fold; reverted whole when the result does not stand. */
  private commit(over: Overlay): TreeVerdict {
    if (over.size === 0) {
      return this.standing(true)
    }

    const previous = new Map<string, DirRecord | typeof UNSTATABLE | undefined>()

    for (const [dir, record] of over) {
      const before = this.records.get(dir)

      previous.set(dir, before)

      if (before !== undefined) {
        this.fold.remove(dir, before)
        this.records.delete(dir)
      }

      if (record !== null) {
        this.fold.add(dir, record)
        this.records.set(dir, record)
      }
    }

    const scan = this.fold.scan()

    if (scan.unscannable.length === 0 && sameLinked(scan.linked, this.last.linked)) {
      return this.adopt(scan)
    }

    for (const [dir, before] of previous) {
      const now = this.records.get(dir)

      if (now !== undefined) {
        this.fold.remove(dir, now)
        this.records.delete(dir)
      }

      if (before !== undefined) {
        this.fold.add(dir, before)
        this.records.set(dir, before)
      }
    }

    return { placed: true, stands: false }
  }

  /** `scan` (the same linked set as `last`) becomes the answer; the ctimes that moved are reported. */
  private adopt(scan: TreeScan): TreeVerdict {
    const ctimes: Array<[number, number]> = []

    scan.linked.forEach((inode, index) => {
      if (inode.ctimeMs !== this.last.linked[index].ctimeMs) {
        ctimes.push([index, inode.ctimeMs])
      }
    })

    this.last = scan

    return {
      placed: true,
      stands: true,
      cached: false,
      files: scan.files,
      dirs: scan.dirs,
      oneVolume: this.oneVolume(),
      ctimes
    }
  }

  private standing(cached: boolean): TreeVerdict {
    return {
      placed: true,
      stands: true,
      cached,
      files: this.last.files,
      dirs: this.last.dirs,
      oneVolume: this.oneVolume(),
      ctimes: []
    }
  }
}

// ─── 4. The paced synchronous walk, and 5. the worker ───────────────────────────────────────────────────────────

/**
 * CF4 (B2-m3): how hard a walk runs. `fast` (the first scan, which a command may wait for): the async walk of
 * hardlinks-records.ts, its calls in parallel (a cold tree is latency bound). `background` (the periodic refresh of a
 * stream-backed root, which nothing waits for): `walkTreeSync` in the worker, one call at a time, resting
 * `BACKGROUND_REST_RATIO` times each `BACKGROUND_SLICE_MS` slice of walking, so about a quarter of one core while it
 * runs.
 */
export type WalkPace = 'background' | 'fast'

export const BACKGROUND_REST_RATIO = 3
const BACKGROUND_SLICE_MS = 250

/** The task marker a walk worker is started with (hardlinks-walker.ts). */
export const WALK_TASK = 'hardlink-walk'

/** One folder's record as a dump carries it. */
export type RecordEntry = [string, DirRecord | typeof UNSTATABLE]

/** What a walk worker posts to main. */
export type WalkMessage =
  | { type: 'progress'; dirs: number }
  | { type: 'done'; dirs: number; scan: TreeScan; oneVolume: boolean }
  | { type: 'answer'; id: number; verdict: TreeVerdict }
  | { type: 'dumped'; id: number; entries: RecordEntry[] }
  | { type: 'error'; id?: number; message: string }

/** What main asks a resident worker. */
export type WalkRequest = { type: 'apply'; id: number; dirty: string[] } | { type: 'walk' | 'dump'; id: number }

/** A progress message at most this often: main's stall clock (5 s) needs no more, and 30 000 messages would cost main
 *  what the worker saves it. */
export const PROGRESS_EVERY_MS = 100

/** CF4b: a blocking rest of `ms` for the worker's synchronous walk, in steps of at most `REST_STEP_MS` so a
 *  `terminate()` (abort, quit) never waits on a long one. */
const REST_STEP_MS = 50
const restCell = new Int32Array(new SharedArrayBuffer(4))

function restSync(ms: number): void {
  for (let left = ms; left > 0; left -= REST_STEP_MS) {
    Atomics.wait(restCell, 0, 0, Math.min(left, REST_STEP_MS))
  }
}

/**
 * CF4b (B2-m3): the background refresh's full scan as the walk worker runs it: the same records as
 * `walkTree(root, null)` (the same `fillRecord` rule, the same ENOENT / unstatable / unscannable outcomes), but with
 * synchronous `lstat` and `readdir`.
 * An async call crosses to the thread pool and back: two thread wake-ups per file, which is most of the CPU the
 * async walk spends (measured in PERF.idle.cpu). The worker is a thread of its own, so blocking it holds nothing up;
 * main never calls this, and the worker serves no request before its walk is done. One call at a time is slower on a
 * cold tree, so the first scan (which a command may wait for) stays the parallel `walkTree`. It rests
 * `BACKGROUND_REST_RATIO` times each `BACKGROUND_SLICE_MS` slice.
 */
export function walkTreeSync(root: string, onDir?: () => void): TreeRecords {
  const records: TreeRecords = new Map()
  const stack = [root]
  let sliceStart = performance.now()

  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    const busy = performance.now() - sliceStart

    if (busy >= BACKGROUND_SLICE_MS) {
      restSync(busy * BACKGROUND_REST_RATIO)
      sliceStart = performance.now()
    }

    onDir?.()

    let stat: BigIntStats

    try {
      stat = lstatSync(dir, { bigint: true })
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') {
        records.set(dir, UNSTATABLE)
      }

      continue
    }

    const record = emptyRecord(stat)
    let entries: Dirent[] | null = null

    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') {
        continue
      }

      record.unscannable = true
    }

    if (entries) {
      fillRecord(record, dir, entries, name => {
        try {
          return lstatSync(path.join(dir, name))
        } catch (error) {
          return { error }
        }
      })
    }

    records.set(dir, record)

    // One push per folder: a spread of a folder's subfolders would hit the argument limit on a very wide one.
    for (const subdir of record.subdirs) {
      stack.push(subdir)
    }
  }

  return records
}

/** One full scan of `root` inside this worker (`fast`: `walkTree`; `background`: `walkTreeSync`): progress while it
 *  walks, then the tree it keeps (its summary posted as `done`), or null after posting the error. */
export async function runWalk(
  root: string,
  post: (message: WalkMessage) => void,
  pace: WalkPace = 'fast'
): Promise<TreeState | null> {
  let dirs = 0
  let posted = 0
  let postedAt = performance.now()

  const progress = (force: boolean) => {
    const at = performance.now()

    if (dirs !== posted && (force || at - postedAt >= PROGRESS_EVERY_MS)) {
      posted = dirs
      postedAt = at
      post({ type: 'progress', dirs })
    }
  }

  const onDir = () => {
    dirs += 1
    progress(false)
  }

  try {
    const records = pace === 'background' ? walkTreeSync(root, onDir) : (await walkTree(root, null, onDir)).records

    progress(true)

    const tree = new TreeState(root, records)

    post({ type: 'done', dirs: tree.size(), scan: tree.scan(), oneVolume: tree.oneVolume() })

    return tree
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })

    return null
  }
}

/** One request against the resident tree, answered by id; a failure answers `error` for that id alone. */
export async function serveRequest(
  tree: TreeState,
  request: WalkRequest,
  post: (message: WalkMessage) => void
): Promise<void> {
  try {
    if (request.type === 'dump') {
      post({ type: 'dumped', id: request.id, entries: [...tree.dump()] })
    } else if (request.type === 'apply') {
      post({ type: 'answer', id: request.id, verdict: await tree.applyDirty(request.dirty) })
    } else {
      post({ type: 'answer', id: request.id, verdict: await tree.walkIncremental() })
    }
  } catch (error) {
    post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) })
  }
}

const walkRequest = (data: unknown): { root: string; pace: WalkPace } | null => {
  const fields = data && typeof data === 'object' ? (data as Record<string, unknown>) : null

  return fields?.icloneTask === WALK_TASK && typeof fields.root === 'string' && path.isAbsolute(fields.root)
    ? { root: fields.root, pace: fields.pace === 'background' ? 'background' : 'fast' }
    : null
}

const isRequest = (message: unknown): message is WalkRequest => {
  const fields = message && typeof message === 'object' ? (message as Record<string, unknown>) : null

  return (
    fields !== null &&
    Number.isSafeInteger(fields.id) &&
    (fields.type === 'walk' ||
      fields.type === 'dump' ||
      (fields.type === 'apply' && Array.isArray(fields.dirty) && fields.dirty.every(dir => typeof dir === 'string')))
  )
}

const request = isMainThread ? null : walkRequest(workerData)

if (request && parentPort) {
  const port: MessagePort = parentPort
  const post = (message: WalkMessage) => port.postMessage(message)

  void runWalk(request.root, post, request.pace).then(tree => {
    if (!tree) {
      return
    }

    // Requests are served one after another, in arrival order: an answer never interleaves with another update.
    let queue: Promise<void> = Promise.resolve()

    port.on('message', (message: unknown) => {
      if (isRequest(message)) {
        queue = queue.then(() => serveRequest(tree, message, post))
      }
    })
  })
}
