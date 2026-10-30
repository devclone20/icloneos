/**
 * iCLONE OS — JSON files for the main process. Reads never throw (a missing,
 * oversized, non-regular, unparsable or wrongly shaped file reads as null);
 * writes go through the atomic writer.
 */
import fs from 'node:fs'

import { type AtomicWriteOptions, writeFileAtomic, writeFileAtomicSync } from './atomic-write'

interface ReadJsonOptions<T> {
  /** Files larger than this are refused without being read. */
  maxBytes?: number | undefined
  /**
   * Shape check; a parsed value that fails it reads as null. Without it the
   * result is unchecked: keep `T` as `unknown` unless the caller validates.
   */
  validate?: ((value: unknown) => value is T) | undefined
}

interface WriteJsonOptions extends AtomicWriteOptions {
  /** JSON.stringify indentation (default 2; 0 = compact). */
  space?: number | undefined
  /** End the file with a newline (default true). */
  trailingNewline?: boolean | undefined
}

// O_NONBLOCK: opening a FIFO planted at the path must not hang the main process.
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)

function accept<T>(text: string, validate: ReadJsonOptions<T>['validate']): T | null {
  const value: unknown = JSON.parse(text)

  if (validate) {
    return validate(value) ? value : null
  }

  // Unchecked by the caller's choice (no validator): the documented `T = unknown` contract.
  return value as T
}

function tooBig(stats: fs.Stats, maxBytes: number | undefined): boolean {
  return !stats.isFile() || (maxBytes !== undefined && stats.size > maxBytes)
}

export function readJsonFileSync<T = unknown>(file: string, options: ReadJsonOptions<T> = {}): T | null {
  let fd: number | undefined

  try {
    fd = fs.openSync(file, READ_FLAGS)

    if (tooBig(fs.fstatSync(fd), options.maxBytes)) {
      return null
    }

    return accept(fs.readFileSync(fd, 'utf8'), options.validate)
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd)
    }
  }
}

export async function readJsonFile<T = unknown>(file: string, options: ReadJsonOptions<T> = {}): Promise<T | null> {
  let handle: fs.promises.FileHandle | undefined

  try {
    handle = await fs.promises.open(file, READ_FLAGS)

    if (tooBig(await handle.stat(), options.maxBytes)) {
      return null
    }

    return accept(await handle.readFile('utf8'), options.validate)
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

function serialise(value: unknown, options: WriteJsonOptions): string {
  const text: string | undefined = JSON.stringify(value, null, options.space ?? 2)

  if (text === undefined) {
    throw new TypeError('writeJsonAtomic: the value has no JSON form')
  }

  return options.trailingNewline === false ? text : `${text}\n`
}

export function writeJsonAtomicSync(file: string, value: unknown, options: WriteJsonOptions = {}): void {
  writeFileAtomicSync(file, serialise(value, options), options)
}

export async function writeJsonAtomic(file: string, value: unknown, options: WriteJsonOptions = {}): Promise<void> {
  await writeFileAtomic(file, serialise(value, options), options)
}
