/**
 * iCLONE OS — the write half of an append-only, hash-chained JSONL ledger (iclone-x402 payments, iclone-acp-work).
 *
 * A row lands as ONE write(2) of a whole line to an O_APPEND descriptor opened without following a symlink. A kill
 * leaves the file without the line or with all of it: the kernel does not cut a regular-file write short on a signal.
 * A short write (a full disk) or a failed fsync is rolled back with ftruncate to the size the line started at, so the
 * caller's "refused" is never contradicted by a row on disk.
 *
 * Durability is the caller's choice per row. `durable: true` fsyncs the file before returning (one F_FULLFSYNC on
 * macOS: the row is on stable storage when the caller acts on it). `durable: false` returns with the row in the page
 * cache, visible to every reader at once, and hands the file to `ledgerSync`, which fsyncs it off the main thread on
 * the next turn of the loop (and synchronously on every way out of the app, through the teardown registry). A process
 * kill loses nothing either way; only a power cut inside that window can lose a non-durable row.
 *
 * `stampOf` is the identity a verified read is cached by: device, inode, size, mtime and ctime of each file. Any write
 * by anyone moves at least the ctime, so a stamp that still matches means the bytes that were verified are the bytes
 * on disk; a stamp that moved means a full re-verify.
 */
import fs from 'node:fs'
import path from 'node:path'

import { registerTeardown } from '../teardown-registry'

import { DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, syncFileAndDir } from './atomic-write'

const statLine = (stat: fs.Stats): string => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`

/** The cache key of a set of files: one `dev:ino:size:mtime:ctime` per file, `-` for a missing one. */
export function stampOf(files: readonly string[]): string {
  return files
    .map(file => {
      try {
        return statLine(fs.statSync(file))
      } catch {
        return '-'
      }
    })
    .join('|')
}

/** `stampOf` through the thread pool. */
export async function stampOfAsync(files: readonly string[]): Promise<string> {
  const lines = await Promise.all(
    files.map(async file => {
      try {
        return statLine(await fs.promises.stat(file))
      } catch {
        return '-'
      }
    })
  )

  return lines.join('|')
}

/** The first file of a `stampOf` stamp as an append expects it: its inode and size (null inode: it did not exist). */
export function expectationOf(stamp: string): AppendExpectation {
  const first = stamp.split('|')[0] ?? '-'

  if (first === '-') {
    return { ino: null, size: 0 }
  }

  const [, ino, size] = first.split(':')

  return { ino: Number(ino), size: Number(size) }
}

/** What the caller verified the file to be. A file that is not that any more is not appended to. */
export interface AppendExpectation {
  /** Null: the file did not exist (or was empty) when it was verified. */
  ino: number | null
  size: number
}

export interface AppendLineOptions {
  durable: boolean
  mode?: number
  dirMode?: number
  /** Refuse (throw `AppendMismatchError`, nothing written) unless the open file is still what the caller verified. */
  expect?: AppendExpectation
  /** Test seam: runs right before the write. A throw stands for a kill there: nothing of the line is on disk. */
  beforeAppend?: (file: string) => void
}

export class AppendMismatchError extends Error {
  override name = 'AppendMismatchError'
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
const APPEND_FLAGS = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW

/** Appends `line` (a whole row ending in `\n`) to `file`. Returns the file's size before and after. */
export function appendLineSync(file: string, line: string, options: AppendLineOptions): { before: number; after: number } {
  fs.mkdirSync(path.dirname(file), { mode: options.dirMode ?? DEFAULT_DIR_MODE, recursive: true })

  const mode = options.mode ?? DEFAULT_FILE_MODE
  const fd = fs.openSync(file, APPEND_FLAGS, mode)
  const bytes = Buffer.from(line, 'utf8')
  let before = 0
  let created = false

  try {
    const stat = fs.fstatSync(fd)

    if (!stat.isFile()) {
      throw new AppendMismatchError('not a regular file')
    }

    before = stat.size
    created = stat.size === 0

    const expected = options.expect

    if (expected && (stat.size !== expected.size || (expected.ino !== null && stat.ino !== expected.ino))) {
      throw new AppendMismatchError('the file moved since it was verified')
    }

    options.beforeAppend?.(file)

    try {
      let written = 0

      while (written < bytes.length) {
        written += fs.writeSync(fd, bytes, written, bytes.length - written)
      }

      if (created) {
        fs.fchmodSync(fd, mode)
      }

      if (options.durable) {
        fs.fsyncSync(fd)
      }
    } catch (error) {
      try {
        fs.ftruncateSync(fd, before)
      } catch {
        // The torn row is what the reader's chain check then reports.
      }

      throw error
    }
  } finally {
    fs.closeSync(fd)
  }

  // A new file's directory entry: durable now when the row must be, otherwise with the deferred flush.
  if (created && options.durable) {
    fsyncDirSync(path.dirname(file))
  }

  if (!options.durable) {
    ledgerSync.mark(file)
  }

  return { before, after: before + bytes.length }
}

function fsyncDirSync(dir: string): void {
  let fd: number | undefined

  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // Windows cannot open a directory; the file content is already durable.
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd)
    }
  }
}

function fsyncFileSync(file: string): void {
  let fd: number | undefined

  try {
    fd = fs.openSync(file, 'r')
    fs.fsyncSync(fd)
  } catch {
    // Gone or unreadable: nothing of ours left to flush.
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd)
    }
  }

  fsyncDirSync(path.dirname(file))
}

export interface DeferredSync {
  /** Queues `file` (and its directory) for an fsync off the main thread, in the order files were first marked. */
  mark: (file: string) => void
  /** Resolves once every file marked before the call is on stable storage (failures are swallowed, as best effort). */
  flush: () => Promise<void>
  /** Flushes what is still queued or in flight, synchronously: the app's way out cannot wait for a promise. */
  flushSync: () => void
  pending: () => number
}

export function createDeferredSync(sync: (file: string) => Promise<void> = syncFileAndDir): DeferredSync {
  let queued: string[] = []
  let inFlight: string[] = []
  let running: Promise<void> | null = null

  const drain = async (): Promise<void> => {
    while (queued.length) {
      inFlight = queued
      queued = []

      for (const file of inFlight) {
        try {
          await sync(file)
        } catch {
          // Best effort, like the directory fsync of an atomic write: the row is already visible and kill-safe.
        }
      }

      inFlight = []
    }
  }

  const start = (): void => {
    running = new Promise<void>(resolve => setImmediate(resolve))
      .then(drain)
      .finally(() => {
        running = null

        if (queued.length) {
          start()
        }
      })
  }

  return {
    mark(file) {
      if (!queued.includes(file)) {
        queued.push(file)
      }

      if (!running) {
        start()
      }
    },
    async flush() {
      while (running) {
        await running
      }
    },
    flushSync() {
      const files = [...new Set([...inFlight, ...queued])]

      queued = []

      for (const file of files) {
        fsyncFileSync(file)
      }
    },
    pending: () => queued.length + inFlight.length
  }
}

/** The one deferred flusher of the ledgers. */
export const ledgerSync = createDeferredSync()

registerTeardown('ledger deferred fsync', () => ledgerSync.flushSync())
