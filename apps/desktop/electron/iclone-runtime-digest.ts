/**
 * L4-01: the runtime's files read and hashed without ever holding the main thread. Every filesystem call is async
 * (libuv's threadpool), a file is hashed in bounded chunks, at most `DIGEST_CONCURRENCY` files are in flight, and every
 * file costs at least one await, so the event loop turns between files.
 *
 * The digest cache (one per process, `runtimeDigests`) keeps, per absolute path, the sha256 last computed for a regular
 * file and the stamp it had while it was read: dev, ino, size, mode, mtime and ctime in nanoseconds. A later check that
 * lstat()s the same stamp takes the digest without reading the bytes; any other stamp reads them again. Why that is
 * sound against a process of the user (not root):
 * - writing, truncating, chmod, link, rename-over and utimes()/futimens() all set ctime to the kernel's clock "now";
 *   utimes can put mtime/atime back, never ctime, and no API lets an unprivileged process choose ctime. So a changed
 *   file shows a ctime later than the recorded one; a replacing file has another inode and its own ctime.
 * - forging ctime needs root (a system clock set back to the exact nanosecond, or raw block-device writes), and root can
 *   change the runtime after any check anyway.
 * Where the stamp can lie, nothing is cached and the file is hashed every time ("any doubt, re-hash"):
 * - a volume whose timestamps are coarse (both mtime and ctime on a whole second: HFS+, FAT, some network shares);
 * - a file changed within `RACY_WINDOW_NS` of the read (a write in the same timestamp tick could keep the stamp: the
 *   "racy git" problem), or whose stamp moved while it was read;
 * - a stamp that cannot be read at all (the check then refuses or re-reads; it never assumes).
 * The cache lives only in this process's memory: nothing on disk vouches for a file.
 *
 * Bound (measured on APFS, macOS 27): bytes written through a shared writable mmap() move neither mtime nor ctime while
 * the mapping lives; ctime moves when it is unmapped or its file closed, so a process that tampered and exited is
 * caught. Only a process still running and holding that mapping could keep a changed file under its old stamp, and
 * such a process could equally write between any check and the spawn that follows it (a race every check-then-spawn
 * has, re-hashing included). The check stands against a runtime changed at rest, as it did before the cache.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Files (or directories) in flight at once: enough to keep the threadpool and the SSD busy, few enough to stay fair. */
export const DIGEST_CONCURRENCY = 16

/** Bytes hashed per turn of the event loop (a 256 KiB SHA-256 update is ~0.1 ms). */
const CHUNK_BYTES = 256 * 1024

/** A file changed this close to its read is never trusted by stamp (covers timestamp ticks up to FAT's 2 s). */
const RACY_WINDOW_NS = 2_000_000_000n
const SECOND_NS = 1_000_000_000n

export const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

interface Verified {
  digest: string
  stamp: string
}

/** sha256 digests of regular files, each valid only while the file keeps the stamp it had when it was read. */
export class DigestCache {
  readonly #entries = new Map<string, Verified>()
  /** Files whose bytes were read and hashed (not taken from the cache) since this cache was made. */
  hashedFiles = 0

  clear(): void {
    this.#entries.clear()
  }

  lookup(file: string, stamp: string): null | string {
    const known = this.#entries.get(file)

    return known && known.stamp === stamp ? known.digest : null
  }

  remember(file: string, stamp: null | string, digest: string): void {
    if (stamp) {
      this.#entries.set(file, { digest, stamp })
    } else {
      this.#entries.delete(file)
    }
  }
}

/** The process's digests of the runtime it spawns (kept across spawns: that is the point). */
export const runtimeDigests = new DigestCache()

const exactStamp = (st: fs.BigIntStats): string =>
  `${st.dev}:${st.ino}:${st.size}:${st.mode}:${st.mtimeNs}:${st.ctimeNs}`

/** The stamp a digest may be cached under, or null when this file's timestamps cannot vouch for its bytes. */
function trustedStamp(st: fs.BigIntStats, readStartedNs: bigint): null | string {
  const coarse = st.mtimeNs % SECOND_NS === 0n && st.ctimeNs % SECOND_NS === 0n
  const racy = st.ctimeNs >= readStartedNs - RACY_WINDOW_NS || st.mtimeNs >= readStartedNs - RACY_WINDOW_NS

  return coarse || racy ? null : exactStamp(st)
}

/** lstat with nanosecond times; null when there is nothing (or nothing readable) at `file`. */
export async function lstatEntry(file: string): Promise<fs.BigIntStats | null> {
  try {
    return await fs.promises.lstat(file, { bigint: true })
  } catch {
    return null
  }
}

/** The sha256 of a link's target text (links are compared as links, never followed). */
export async function linkDigest(file: string): Promise<string> {
  return sha256Hex(await fs.promises.readlink(file))
}

/**
 * The sha256 of the regular file `file` whose lstat is `st`: from `cache` when the stamp is unchanged, else read in
 * chunks through a descriptor opened without following links. Throws when the file is not the one `st` describes, or
 * changed while it was read: the caller counts it as changed (fail closed).
 */
export async function fileDigest(file: string, st: fs.BigIntStats, cache: DigestCache | null): Promise<string> {
  const stamp = exactStamp(st)
  const cached = cache?.lookup(file, stamp)

  if (cached) {
    return cached
  }

  const readStartedNs = BigInt(Date.now()) * 1_000_000n
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)

  try {
    const before = await handle.stat({ bigint: true })

    if (exactStamp(before) !== stamp) {
      throw new Error(`${path.basename(file)} changed while it was checked`)
    }

    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Number(before.size < BigInt(CHUNK_BYTES) ? before.size : BigInt(CHUNK_BYTES)) + 1)

    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)

      if (bytesRead === 0) {
        break
      }

      hash.update(buffer.subarray(0, bytesRead))
    }

    const after = await handle.stat({ bigint: true })

    if (exactStamp(after) !== stamp) {
      throw new Error(`${path.basename(file)} changed while it was checked`)
    }

    const digest = hash.digest('hex')

    if (cache) {
      cache.hashedFiles += 1
      cache.remember(file, trustedStamp(after, readStartedNs), digest)
    }

    return digest
  } finally {
    await handle.close()
  }
}

/**
 * Runs `work` on every item, at most `limit` at a time. Every item runs even when one fails; the first failure is
 * thrown once all have settled (so nothing keeps touching the tree after the caller moved on).
 */
export async function forEachBounded<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
  limit = DIGEST_CONCURRENCY
): Promise<void> {
  let next = 0
  let failure: { error: unknown } | null = null

  const worker = async () => {
    while (next < items.length) {
      const item = items[next] as T
      next += 1

      try {
        await work(item)
      } catch (error) {
        failure ??= { error }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))

  if (failure) {
    throw (failure as { error: unknown }).error
  }
}

/**
 * Every file and link below `dir` (relative, posix separators, unsorted); directories are walked a level at a time,
 * links are never followed, an unreadable folder is skipped (as the synchronous walks did). `skip` prunes a path.
 */
export async function listTree(dir: string, skip: (rel: string) => boolean = () => false): Promise<string[]> {
  const out: string[] = []
  let level = ['']

  while (level.length > 0) {
    const below: string[] = []

    await forEachBounded(level, async rel => {
      let entries: fs.Dirent[]

      try {
        entries = await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        const child = rel ? `${rel}/${entry.name}` : entry.name

        if (skip(child)) {
          continue
        }

        if (entry.isDirectory()) {
          below.push(child)
        } else {
          out.push(child)
        }
      }
    })

    level = below
  }

  return out
}
