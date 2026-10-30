/**
 * iCLONE OS — crash-safe file replacement for the main process: write a
 * private temp file next to the target (exclusive create, so a planted file or
 * symlink is never followed), fsync it, rename it over the target, then fsync
 * the directory. Readers see the old file or the new one, never a torn write.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Mode of a file this module creates when the caller names none and no previous file exists. */
export const DEFAULT_FILE_MODE = 0o600

/** Mode of parent directories this module creates (existing directories are never touched). */
export const DEFAULT_DIR_MODE = 0o700

export interface AtomicWriteOptions {
  /**
   * The final file mode, applied with chmod so the umask can neither widen nor narrow it.
   * Default: the mode of the regular file being replaced, else `DEFAULT_FILE_MODE`.
   */
  mode?: number | undefined
  /** Mode for parent directories created by this call. Default `DEFAULT_DIR_MODE`. */
  dirMode?: number | undefined
  /**
   * Test seam: runs once the temp file is complete, just before the rename. A throw stands for a crash at that point:
   * the temp file stays behind for the caller's leftover sweep (`isAtomicTempName`).
   */
  beforeRename?: ((temp: string, file: string) => void) | undefined
}

const TEMP_NAME = /^\..+\.\d+\.[0-9a-f]{12}\.tmp$/

function tempPathFor(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
}

/** True for the basename of a temp file this module writes: a write in flight, or one a crash left behind. */
export function isAtomicTempName(name: string): boolean {
  return TEMP_NAME.test(name)
}

// One step of a write; a failure removes the temp file so no partial file outlives the call.
function removingTempOnError(tmp: string, step: () => void): void {
  try {
    step()
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

async function removingTempOnErrorAsync(tmp: string, step: () => Promise<void>): Promise<void> {
  try {
    await step()
  } catch (error) {
    await fs.promises.rm(tmp, { force: true })
    throw error
  }
}

function modeFromStats(stats: fs.Stats | undefined): number | undefined {
  return stats?.isFile() ? stats.mode & 0o777 : undefined
}

function lstatOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file)
  } catch {
    return undefined
  }
}

async function lstatOrUndefinedAsync(file: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(file)
  } catch {
    return undefined
  }
}

// Durability of the rename itself; best effort (Windows cannot open a directory for fsync).
function fsyncDirSync(dir: string): void {
  let fd: number | undefined

  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // The file content is already durable; only the directory entry may lag.
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd)
    }
  }
}

async function fsyncDir(dir: string): Promise<void> {
  try {
    const handle = await fs.promises.open(dir, 'r')

    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Same contract as fsyncDirSync.
  }
}

/** Replaces `file` with `data` atomically (sync). Creates missing parent directories. */
export function writeFileAtomicSync(file: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const dir = path.dirname(file)

  fs.mkdirSync(dir, { mode: options.dirMode ?? DEFAULT_DIR_MODE, recursive: true })

  const mode = options.mode ?? modeFromStats(lstatOrUndefined(file)) ?? DEFAULT_FILE_MODE
  const tmp = tempPathFor(file)
  // Opened outside the cleanup scope: if the exclusive create fails, the path is not ours to remove.
  const fd = fs.openSync(tmp, 'wx', mode)

  removingTempOnError(tmp, () => {
    try {
      fs.writeFileSync(fd, data)
      fs.fchmodSync(fd, mode)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  })
  options.beforeRename?.(tmp, file)
  removingTempOnError(tmp, () => fs.renameSync(tmp, file))
  fsyncDirSync(dir)
}

/** The asynchronous write path of `writeFileAtomic` and `writeStreamAtomic`: `fill` writes the temp file's content. */
async function replaceFileAtomic(
  file: string,
  options: AtomicWriteOptions,
  fill: (handle: fs.promises.FileHandle) => Promise<void>
): Promise<void> {
  const dir = path.dirname(file)
  await fs.promises.mkdir(dir, { mode: options.dirMode ?? DEFAULT_DIR_MODE, recursive: true })
  const mode = options.mode ?? modeFromStats(await lstatOrUndefinedAsync(file)) ?? DEFAULT_FILE_MODE
  const tmp = tempPathFor(file)
  const handle = await fs.promises.open(tmp, 'wx', mode)

  await removingTempOnErrorAsync(tmp, async () => {
    try {
      await fill(handle)
      await handle.chmod(mode)
      await handle.sync()
    } finally {
      await handle.close()
    }
  })
  options.beforeRename?.(tmp, file)
  await removingTempOnErrorAsync(tmp, () => fs.promises.rename(tmp, file))
  await fsyncDir(dir)
}

/** Replaces `file` with `data` atomically. Creates missing parent directories. */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<void> {
  await replaceFileAtomic(file, options, async handle => {
    await handle.writeFile(data)
  })
}

/**
 * `writeFileAtomic` for a stream: `source` is piped into the temp file, and the target appears whole or not at all.
 * A read or write error removes the temp file and rejects with that error. `source` must have no other consumer: it
 * is read only once the temp file is open, so a `'data'` listener attached earlier takes chunks that never reach the
 * file. To observe the bytes (a hash, progress), pass an async generator that yields each chunk it sees.
 */
export async function writeStreamAtomic(
  file: string,
  source: AsyncIterable<Uint8Array | string> | NodeJS.ReadableStream,
  options: AtomicWriteOptions = {}
): Promise<void> {
  await replaceFileAtomic(file, options, async handle => {
    // Awaiting each write is the backpressure; a source error surfaces from the loop. Unlike write(), writeFile()
    // never stops short of the whole chunk.
    for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
      await handle.writeFile(chunk)
    }
  })
}

/**
 * Moves the finished directory `staged` into place at `target` (one filesystem). The current tree is renamed aside
 * first and renamed back if the second rename fails, so a failure in this call never leaves `target` missing.
 * Returns the kept previous tree, or null when there was none or it was not kept.
 */
export function replaceDirAtomicSync(
  staged: string,
  target: string,
  options: {
    /**
     * Where the replaced tree is moved and kept (for a later rollback); whatever is already there is removed first.
     * Default: `<target>.old-<pid>`, removed once the new tree is in place.
     */
    keepPrevious?: string | undefined
  } = {}
): null | string {
  const previous = options.keepPrevious ?? `${target}.old-${process.pid}`
  const replacing = fs.existsSync(target)

  if (replacing) {
    fs.rmSync(previous, { force: true, recursive: true })
    fs.renameSync(target, previous)
  }

  try {
    fs.renameSync(staged, target)
  } catch (error) {
    if (replacing) {
      try {
        fs.renameSync(previous, target)
      } catch {
        // `previous` still holds the tree; the caller's leftover recovery owns it from here.
      }
    }

    throw error
  }

  fsyncDirSync(path.dirname(target))

  if (!replacing) {
    return null
  }

  if (options.keepPrevious === undefined) {
    fs.rmSync(previous, { force: true, recursive: true })

    return null
  }

  return previous
}
