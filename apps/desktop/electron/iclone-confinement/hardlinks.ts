/**
 * V3-G F7 — hard links into a project. Seatbelt judges a path, not an inode: a file inside the project that is a
 * second name for an inode outside it (planted by any unconfined writer, or left by `git clone --local` or a package
 * store) is read and written through the project's own rules. The profile refuses to make one (`deny file-link`,
 * sbpl.ts); this module finds the ones that already exist, before a confined run starts, and confinement refuses to
 * start for that root until each is removed or the owner allows it.
 *
 * A link only matters when one of its names lies outside the root: an inode whose every name was seen inside the
 * project (`st_nlink` == names found) is the project's own. The full scan stats every file, so its answer is cached
 * per root behind a cheap fingerprint: every directory's inode, mtime and ctime plus the file count. Planting a name
 * anywhere in the tree changes its directory's ctime, which no user call can set back (`utimes` moves it too), so a
 * planted link always misses the cache. A name made OUTSIDE for an inside inode moves no inside mtime; the cache is
 * bounded by age for it, and the data it shares came from the project anyway.
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
import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

import type {
  ActivityClass,
  HardlinkAckFailure,
  HardlinkBlockView,
  HardlinkGroupView
} from '../../src/iclone-shared/confinement'
import { writeFileAtomicSync } from '../lib/atomic-write'

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
/** A cached answer is re-measured at least this often, even when no inside directory moved. */
const CACHE_MAX_AGE_MS = 5 * 60_000
/** T2'': the store walk that may auto-pass a `build` run must finish within this, else the gesture stands. */
const STORE_BUDGET_MS = 1_000
/** The only class whose links into the pnpm store run without a gesture. */
const STORE_AUTO_PASS_CLASS: ActivityClass = 'build'

interface LinkedInode {
  dev: number
  ino: number
  nlink: number
  /** The names found inside the root, sorted. */
  paths: string[]
  /** r6: the same names as identities — `<dev>:<ino>` of the folder holding the name, `/`, the name — so one name
   *  reached by two spellings (a nested root, a firmlink alias) is one name. */
  names: string[]
}

interface TreeScan {
  fingerprint: string
  files: number
  /** Inodes with at least one name outside the root. */
  linked: LinkedInode[]
  /** Directories inside the root that could not be listed (not vanished: refused, looping, broken). */
  unscannable: string[]
}

const within = (child: string, parent: string) => child === parent || child.startsWith(`${parent}${path.sep}`)

const errnoOf = (error: unknown): string => String((error as NodeJS.ErrnoException | null)?.code ?? '')

/**
 * One walk of the tree. Directories are always stat-ed (they make the fingerprint); regular files only when
 * `statFiles`, which is what makes the full scan the expensive one. Symlinks are never followed: Seatbelt resolves a
 * symlink to its target and judges that, so they are not this module's concern.
 */
function walk(root: string, statFiles: boolean): TreeScan {
  const fingerprint: string[] = []
  const byInode = new Map<string, LinkedInode>()
  const unscannable: string[] = []
  const stack = [root]
  let files = 0

  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: Dirent[]
    let folder: string

    try {
      const stat = lstatSync(dir, { bigint: true })

      fingerprint.push(`${path.relative(root, dir)}\0${stat.ino}\0${stat.mtimeNs}\0${stat.ctimeNs}`)
      folder = `${stat.dev}:${stat.ino}`
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      // Gone since its parent was listed: nothing is hidden there. Anything else hides what it holds (T1).
      if (errnoOf(error) !== 'ENOENT') {
        fingerprint.push(`${path.relative(root, dir)}\0unscannable`)
        unscannable.push(dir)
      }

      continue
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        stack.push(full)

        continue
      }

      files += 1

      if (!statFiles || !entry.isFile()) {
        continue
      }

      try {
        const stat = lstatSync(full)

        if (stat.nlink > 1) {
          const key = inodeKey(stat)
          const inode = byInode.get(key) ?? { dev: stat.dev, ino: stat.ino, nlink: stat.nlink, paths: [], names: [] }

          inode.paths.push(full)
          inode.names.push(`${folder}/${entry.name}`)
          byInode.set(key, inode)
        }
      } catch (error) {
        // Gone between readdir and lstat: nothing is there. Anything else (EACCES on a `chmod 400` directory, EPERM,
        // ELOOP, EIO…) hides this child's link count, and so the whole directory (T1'): refused. Its subdirectories
        // stay on the stack and report themselves (they cannot be listed either), in this walk and the fingerprint
        // one alike, so the cached answer to an unchanged tree is this same refusal.
        if (errnoOf(error) !== 'ENOENT') {
          unscannable.push(dir)

          break
        }
      }
    }
  }

  fingerprint.sort()
  fingerprint.push(`files\0${files}`)

  const linked = [...byInode.values()]
    .filter(inode => inode.paths.length < inode.nlink)
    .map(inode => ({ ...inode, paths: inode.paths.sort() }))
    .sort((a, b) => (a.paths[0] < b.paths[0] ? -1 : 1))

  return { fingerprint: fingerprint.join('\n'), files, linked, unscannable: unscannable.sort() }
}

const fingerprintTree = (root: string): { fingerprint: string } => walk(root, false)
export const scanTree = (root: string): TreeScan => walk(root, true)

const inodeKey = (inode: Pick<LinkedInode, 'dev' | 'ino'>) => `${inode.dev}:${inode.ino}`

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
export function storeShaped(root: string): boolean {
  if (/\/store\/v\d+$/.test(root)) {
    return true
  }

  try {
    const store = path.join(root, 'store')

    return (
      lstatSync(store).isDirectory() &&
      readdirSync(store, { withFileTypes: true }).some(
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
export function realStoreRoot(root: string): boolean {
  try {
    return lstatSync(root).isDirectory() && realpathSync(root) === root
  } catch {
    return false
  }
}

/** r6: the roots one resolve walks — real, store-shaped, each once; a root inside another walked root is dropped (its
 *  folders are reached from the outer one). */
function storeWalkRoots(roots: readonly string[]): string[] {
  const valid = [...new Set(roots)].filter(root => realStoreRoot(root) && storeShaped(root))

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
export function resolveInStore(
  roots: readonly string[],
  wanted: readonly LinkedInode[],
  budgetMs = STORE_BUDGET_MS
): StoreResolve {
  const started = performance.now()
  const names = new Map(wanted.map(inode => [inodeKey(inode), new Set(inode.names)]))
  const visited = new Set<string>()
  let files = 0
  let timedOut = false

  walk: for (const root of storeWalkRoots(roots)) {
    const stack = [root]

    while (stack.length > 0) {
      const dir = stack.pop() as string
      let entries: Dirent[]
      let folder: string

      try {
        const before = lstatSync(dir, { bigint: true })

        folder = `${before.dev}:${before.ino}`

        if (!before.isDirectory() || visited.has(folder)) {
          continue
        }

        visited.add(folder)
        entries = readdirSync(dir, { withFileTypes: true })

        const after = lstatSync(dir, { bigint: true })

        if (!after.isDirectory() || `${after.dev}:${after.ino}` !== folder) {
          continue
        }
      } catch {
        continue
      }

      for (const entry of entries) {
        const full = path.join(dir, entry.name)

        if (entry.isDirectory()) {
          stack.push(full)

          continue
        }

        if (!entry.isFile()) {
          continue
        }

        files += 1

        if ((files & 255) === 0 && performance.now() - started > budgetMs) {
          timedOut = true

          break walk
        }

        try {
          names.get(inodeKey(lstatSync(full)))?.add(`${folder}/${entry.name}`)
        } catch {
          // gone between readdir and lstat: it resolves nothing
        }
      }
    }
  }

  const passed = new Set<string>()

  // A walk that finished past the budget is past the budget: the ticket's bound is on the whole resolve.
  timedOut ||= performance.now() - started > budgetMs

  if (!timedOut) {
    for (const inode of wanted) {
      if (names.get(inodeKey(inode))?.size === inode.nlink) {
        passed.add(inodeKey(inode))
      }
    }
  }

  return { passed, files, ms: performance.now() - started, timedOut }
}

interface CacheEntry {
  fingerprint: string
  at: number
  scan: TreeScan
  /** T2'': the store-resolved inodes of this scan, once a `build` check asked; null until then. */
  store: Set<string> | null
}

interface HardlinkAck {
  root: string
  path: string
  dev: number
  ino: number
  at: string
}

type HardlinkCheck =
  | { ok: true; cached: boolean; files: number; ms: number; passed: number }
  | { ok: false; cached: boolean; block: HardlinkBlockView; ms: number }

type HardlinkAckResult =
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

/** The real path of `file` without following its last component (a symlink is judged as itself). */
function realParentJoin(file: string): string | null {
  try {
    return path.join(realpathSync(path.dirname(file)), path.basename(file))
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

    byTop.set(top, [...(byTop.get(top) ?? []), inode])
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
          paths: members.slice(0, HARDLINK_PATHS_SHOWN).map(member => member.paths[0]),
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

export function createHardlinkGuard(deps: HardlinkGuardDeps) {
  const keyFile = deps.keyFile ?? path.join(path.dirname(deps.ackFile), 'hardlink-key.sealed')
  const { key, persistent } = deps.sealedKey ?? bootSealedKey({ ...deps, keyFile })
  const now = deps.now ?? (() => new Date())
  const storeRoots = deps.storeRoots ?? []
  const storeBudgetMs = deps.storeBudgetMs ?? STORE_BUDGET_MS
  const cache = new Map<string, CacheEntry>()
  const blocked = new Map<string, HardlinkBlockView>()
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

  const acknowledged = (root: string, inode: Pick<LinkedInode, 'dev' | 'ino'>) =>
    acks.some(ack => ack.root === root && ack.dev === inode.dev && ack.ino === inode.ino)

  const measure = (root: string): { entry: CacheEntry; cached: boolean } => {
    const at = now().getTime()
    const hit = cache.get(root)

    if (hit && at - hit.at < CACHE_MAX_AGE_MS && fingerprintTree(root).fingerprint === hit.fingerprint) {
      return { entry: hit, cached: true }
    }

    deps.onFullScan?.(root)

    const scan = scanTree(root)
    const entry: CacheEntry = { fingerprint: scan.fingerprint, at, scan, store: null }

    cache.set(root, entry)

    return { entry, cached: false }
  }

  // T2'': the store-resolved inodes of one measured tree (`build` only), computed once per scan and kept with it.
  const storePassed = (root: string, entry: CacheEntry, cls: ActivityClass | undefined): Set<string> => {
    if (cls !== STORE_AUTO_PASS_CLASS || storeRoots.length === 0) {
      return new Set()
    }

    if (!entry.store) {
      const open = entry.scan.linked.filter(inode => !acknowledged(root, inode))
      const result = resolveInStore(storeRoots, open, storeBudgetMs)

      deps.onStoreResolve?.(root, result)
      entry.store = result.passed
    }

    return entry.store
  }

  const blockOf = (
    root: string,
    scan: TreeScan,
    passed: ReadonlySet<string> = new Set()
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

  return {
    keyHex: (): string => key.toString('hex'),
    /** True when the record outlives this main (the key is sealed in safeStorage); false: allowances end with it. */
    persistent: (): boolean => persistent,
    /** Before a confined run in `root`: refuses while an inode with a name outside it is not acknowledged, or while
     *  a directory inside it cannot be listed. `cls` is the run's class: `build` alone may pass a link whose other
     *  names all resolve into the pnpm store (T2''); without a class, only the owner's gesture counts. */
    check(projectRoot: string, cls?: ActivityClass): HardlinkCheck {
      const started = performance.now()
      const root = realParentJoin(projectRoot) ?? projectRoot
      const { entry, cached } = measure(root)
      const { scan } = entry
      const passed = storePassed(root, entry, cls)
      const { block } = blockOf(root, scan, passed)
      const ms = performance.now() - started

      if (!block) {
        blocked.delete(root)

        return { ok: true, cached, files: scan.files, ms, passed: passed.size }
      }

      blocked.set(root, block)

      return { ok: false, cached, block, ms }
    },
    /** The roots a confined run was refused in, as main last measured them (index.ts re-measures the stale ones). */
    blocked: (): HardlinkBlockView[] => [...blocked.values()],
    /**
     * The owner's gesture-gated answer (ipc.ts checks the gesture): every hard-linked file under `dir` of `root`, as
     * main scans it now, may run confined. `digest` must match that set exactly: a link planted since the pane showed
     * the group is a new question (`changed`), as is any inode that appears later.
     */
    acknowledgeGroup(projectRoot: string, dir: string, digest: string): HardlinkAckResult {
      const root = path.isAbsolute(projectRoot) ? realParentJoin(projectRoot) : null
      const target = path.isAbsolute(dir) ? realParentJoin(dir) : null

      if (!root || !target || typeof digest !== 'string') {
        return { ok: false, reason: 'invalid' }
      }

      if (!within(target, root)) {
        return { ok: false, reason: 'not-in-project' }
      }

      const { scan } = measure(root).entry
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
      persist()

      return { ok: true, dir: target, count: fresh.length, acks: fresh }
    },
    acks: (): readonly HardlinkAck[] => acks
  }
}

export type HardlinkGuard = ReturnType<typeof createHardlinkGuard>

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
