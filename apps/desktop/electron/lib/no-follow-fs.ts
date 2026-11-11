/**
 * File operations for the unconfined main process on a folder a confined runtime can also write (HERMES_HOME).
 * The runtime can plant a link, a FIFO or a directory at any name in there, and swap one in at any moment, so a plain
 * `fs` call would let it aim main's authority at any file of the user, or hang main on a FIFO.
 *
 * Everything that opens a file goes through one descriptor: `O_NOFOLLOW` (and, on macOS, `O_NOFOLLOW_ANY`, which the
 * kernel applies to every component of the path, closing the swap between a check and the open) with `O_NONBLOCK` (a
 * FIFO never hangs), then `fstat` on that descriptor. Contents, truncation and modes then go through the descriptor.
 *
 * What Node cannot do through a descriptor: `rename`, `unlink` and `mkdir` take a path (no `renameat`). They never
 * follow their last component, and their parents are checked first, so a swap of a parent inside that window can move
 * only a file bearing the fixed name the caller passed, in a folder the runtime chose. It cannot redirect a write.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

/** `<sys/fcntl.h>` on macOS 11+ (every version Electron supports). Node does not export it, and `open(2)` takes it as is. */
const O_NOFOLLOW_ANY_DARWIN = 0x20000000

// The kernel answers EINVAL to both flags together; ANY covers the last component too.
const NEVER_FOLLOW = process.platform === 'darwin' ? O_NOFOLLOW_ANY_DARWIN : (fs.constants.O_NOFOLLOW ?? 0)
const NEVER_HANG = fs.constants.O_NONBLOCK ?? 0

const READ_FLAGS = fs.constants.O_RDONLY | NEVER_FOLLOW | NEVER_HANG
const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | NEVER_FOLLOW | NEVER_HANG
const APPEND_FLAGS = WRITE_FLAGS | fs.constants.O_APPEND
const CREATE_NEW_FLAGS = WRITE_FLAGS | fs.constants.O_EXCL

const PRIVATE_FILE_MODE = 0o600
const COPY_CHUNK_BYTES = 1024 * 1024

/** What `open` answers for a link (`ELOOP`), a reader-less FIFO (`ENXIO`), a directory, a socket, or a file used as a parent. */
const REFUSAL_CODES = new Set(['ELOOP', 'ENXIO', 'EISDIR', 'ENOTDIR', 'EOPNOTSUPP', 'EMLINK'])

/** Arms `hermes_cli/no_follow.py` in a Python process started outside the confinement, on a home the runtime can write. */
export const NO_LINKS_ENV = { HERMES_HOME_NO_LINKS: '1' } as const

/** The way out, for an owner who placed the link: the app never follows one in the agent's home. */
export const REFUSAL_HINT =
  "the app never follows links or special files in the agent's home; replace it with a plain file"

export class RefusedPathError extends Error {
  readonly code = 'ERR_REFUSED_PATH'

  constructor(target: string, why: string, hint: null | string = REFUSAL_HINT) {
    super(hint ? `refused ${target}: ${why} (${hint})` : `refused ${target}: ${why}`)
    this.name = 'RefusedPathError'
  }
}

export const isRefusedPath = (error: unknown): error is RefusedPathError => error instanceof RefusedPathError

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

/** What each refusal is, in the words the user reads in the doctor, the bootstrap log and the desktop log. */
const REFUSAL_WORDS: Record<string, string> = {
  ELOOP: 'a symbolic link',
  ENXIO: 'a pipe with no reader',
  EISDIR: 'a folder',
  ENOTDIR: 'a file or a link where a folder was expected',
  EOPNOTSUPP: 'a socket',
  EMLINK: 'a hard link'
}

const refusalOrSame = (error: unknown, target: string): unknown => {
  const code = errnoOf(error) ?? ''

  return REFUSAL_CODES.has(code)
    ? new RefusedPathError(target, REFUSAL_WORDS[code] ?? `not a plain file (${code})`)
    : error
}

const pinnedRoots = new Map<string, string>()

function realPathOfRoot(absolute: string): string {
  try {
    return fs.realpathSync(absolute)
  } catch {
    const parent = path.dirname(absolute)

    return parent === absolute ? absolute : path.join(realPathOfRoot(parent), path.basename(absolute))
  }
}

/**
 * The real path of `root`, resolved once. A runtime that may write inside its home may also be able to replace the
 * home's own name, so a later `realpath` would trust its answer; from the pin on, a replaced root is a link in the path
 * and is refused. Call it before the first spawn of a runtime that can write there.
 */
export function pinRoot(root: string): string {
  const absolute = path.resolve(root)
  const known = pinnedRoots.get(absolute)

  if (known !== undefined) {
    return known
  }

  const real = realPathOfRoot(absolute)

  pinnedRoots.set(absolute, real)

  return real
}

function relativeInside(root: string, target: string): string {
  const absolute = path.resolve(target)

  for (const base of [path.resolve(root), pinRoot(root)]) {
    const relative = path.relative(base, absolute)

    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative
    }
  }

  throw new RefusedPathError(target, `outside ${root}`, null)
}

function assertRealFolder(folder: string, target: string): 'absent' | 'folder' {
  let stat: fs.Stats

  try {
    stat = fs.lstatSync(folder)
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') {
      return 'absent'
    }

    throw refusalOrSame(error, target)
  }

  if (!stat.isDirectory()) {
    throw new RefusedPathError(target, `${folder} is a link or not a folder`)
  }

  return 'folder'
}

/** `target`'s path under the pinned root, once every folder down to it is a real folder. */
export function resolveInRoot(root: string, target: string): string {
  const parts = relativeInside(root, target).split(path.sep)
  let folder = pinRoot(root)

  for (const part of ['', ...parts.slice(0, -1)]) {
    folder = path.join(folder, part)

    if (assertRealFolder(folder, target) === 'absent') {
      break
    }
  }

  return path.join(pinRoot(root), ...parts)
}

function assertPlainFile(stat: fs.Stats, target: string): void {
  if (!stat.isFile()) {
    throw new RefusedPathError(target, 'not a regular file (a pipe, a socket, a device or a folder)')
  }

  // The profile denies the runtime `file-link`, so a second name here is not one of ours: it may be any file of the user.
  if (stat.nlink > 1) {
    throw new RefusedPathError(target, 'a hard link')
  }
}

function openChecked(resolved: string, flags: number, mode: number, target: string): number {
  let fd: number

  try {
    fd = fs.openSync(resolved, flags, mode)
  } catch (error) {
    throw refusalOrSame(error, target)
  }

  try {
    assertPlainFile(fs.fstatSync(fd), target)
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }

  return fd
}

function withFile<T>(root: string, target: string, flags: number, mode: number, act: (fd: number) => T): T {
  const fd = openChecked(resolveInRoot(root, target), flags, mode, target)

  try {
    return act(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function readFileInRoot(root: string, target: string): Buffer {
  return withFile(root, target, READ_FLAGS, 0, fd => fs.readFileSync(fd))
}

/** The first `length` bytes, fewer when the file is shorter. */
/**
 * The bytes of a file outside any root, for a path already fully resolved, read once through one descriptor. On macOS
 * the kernel refuses a link at ANY component (a folder on the way flipped to a link since the path was resolved). Node
 * has no `openat`, and this flag is what walking the path with no follow would give, without the gaps. Elsewhere only
 * the last component is guarded: runtime confinement exists only on macOS, so nothing there flips the path.
 * `changed` is a path that no longer leads to a file as resolved. The cap holds if the file grows after the fstat.
 */
export function readPlainFileNoLinks(
  absolute: string,
  capBytes: number
): 'changed' | 'hard-link' | 'not-plain' | 'too-large' | 'unreadable' | Buffer {
  let fd: number

  try {
    fd = fs.openSync(absolute, READ_FLAGS)
  } catch (error) {
    const code = errnoOf(error) ?? ''

    return code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR'
      ? 'changed'
      : REFUSAL_CODES.has(code)
        ? 'not-plain'
        : 'unreadable'
  }

  try {
    const stat = fs.fstatSync(fd)

    if (!stat.isFile()) {
      return 'not-plain'
    }

    // A second name may be any file of the user, whatever the name the owner was shown.
    if (stat.nlink > 1) {
      return 'hard-link'
    }

    if (stat.size > capBytes) {
      return 'too-large'
    }

    const buffer = Buffer.alloc(capBytes + 1)
    let length = 0

    for (let got = 1; got > 0 && length < buffer.length; length += got) {
      got = fs.readSync(fd, buffer, length, buffer.length - length, null)
    }

    return length > capBytes ? 'too-large' : buffer.subarray(0, length)
  } catch {
    return 'unreadable'
  } finally {
    fs.closeSync(fd)
  }
}

export function readHeaderInRoot(root: string, target: string, length: number): Buffer {
  return withFile(root, target, READ_FLAGS, 0, fd => {
    const header = Buffer.alloc(length)

    return header.subarray(0, fs.readSync(fd, header, 0, length, 0))
  })
}

/** Lists a folder that is a real folder all the way down from the root. Names only: each file is then opened on its own. */
export function readdirInRoot(root: string, folder: string): fs.Dirent[] {
  const resolved = resolveInRoot(root, path.join(folder, '_'))

  if (assertRealFolder(path.dirname(resolved), folder) === 'absent') {
    return []
  }

  return fs.readdirSync(path.dirname(resolved), { withFileTypes: true })
}

export function appendFileInRoot(root: string, target: string, data: string, mode = PRIVATE_FILE_MODE): void {
  withFile(root, target, APPEND_FLAGS, mode, fd => fs.writeSync(fd, data))
}

export async function appendFileInRootAsync(
  root: string,
  target: string,
  data: string,
  mode = PRIVATE_FILE_MODE
): Promise<void> {
  const resolved = resolveInRoot(root, target)
  let handle: fs.promises.FileHandle

  try {
    handle = await fs.promises.open(resolved, APPEND_FLAGS, mode)
  } catch (error) {
    throw refusalOrSame(error, target)
  }

  try {
    assertPlainFile(await handle.stat(), target)
    await handle.appendFile(data)
  } finally {
    await handle.close()
  }
}

/** Truncates through the descriptor, after the checks: a refused target is never emptied. */
export function writeFileInRoot(root: string, target: string, data: string, mode = PRIVATE_FILE_MODE): void {
  withFile(root, target, WRITE_FLAGS, mode, fd => {
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, data)
  })
}

/** Temp beside the target, written through its own descriptor, then renamed: a link at `target` is replaced, never followed. */
export function replaceFileInRoot(
  root: string,
  target: string,
  data: string | Uint8Array,
  mode = PRIVATE_FILE_MODE
): void {
  const folder = path.dirname(target)

  if (path.resolve(folder) !== path.resolve(root)) {
    mkdirsInRoot(root, folder)
  }

  const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`

  withFile(root, temp, CREATE_NEW_FLAGS, mode, fd => {
    fs.writeFileSync(fd, data)
    fs.fchmodSync(fd, mode)
    fs.fsyncSync(fd)
  })

  try {
    renameInRoot(root, temp, target)
  } catch (error) {
    unlinkInRoot(root, temp)
    throw error
  }
}

/** Creates `target` when absent and answers a descriptor for appending; the caller owns and closes it. */
export function openAppendFdInRoot(root: string, target: string, mode = PRIVATE_FILE_MODE): number {
  return openChecked(resolveInRoot(root, target), APPEND_FLAGS, mode, target)
}

/** Where a copy lands: a new name only, under the pinned root when `to` lies in it, else under `to`'s real folder. */
function destinationOf(root: string, to: string): string {
  try {
    return resolveInRoot(root, to)
  } catch (error) {
    if (isRefusedPath(error) && error.message.endsWith(`outside ${root}`)) {
      return path.join(fs.realpathSync(path.dirname(to)), path.basename(to))
    }

    throw error
  }
}

/** Copies the plain file `from`, inside `root`, to the new name `to`; the source's bytes never come through a link. */
export function copyFileFromRoot(root: string, from: string, to: string): void {
  withFile(root, from, READ_FLAGS, 0, source => {
    const destination = openChecked(destinationOf(root, to), CREATE_NEW_FLAGS, PRIVATE_FILE_MODE, to)

    try {
      const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES)

      for (let read = fs.readSync(source, chunk); read > 0; read = fs.readSync(source, chunk)) {
        fs.writeSync(destination, chunk, 0, read)
      }
    } finally {
      fs.closeSync(destination)
    }
  })
}

export async function copyFileFromRootAsync(root: string, from: string, to: string): Promise<void> {
  const source = openChecked(resolveInRoot(root, from), READ_FLAGS, 0, from)
  let destination: number

  try {
    destination = openChecked(destinationOf(root, to), CREATE_NEW_FLAGS, PRIVATE_FILE_MODE, to)
  } catch (error) {
    fs.closeSync(source)
    throw error
  }

  // Both streams own and close their descriptor.
  await pipeline(fs.createReadStream('', { fd: source }), fs.createWriteStream('', { fd: destination }))
}

export function chmodFileInRoot(root: string, target: string, mode: number): void {
  withFile(root, target, READ_FLAGS, 0, fd => fs.fchmodSync(fd, mode))
}

/** chmod of a folder through its descriptor: `fs.chmod` would follow a link swapped in after any check. */
export function chmodFolderInRoot(root: string, target: string, mode: number): void {
  const resolved = resolveInRoot(root, target)
  let fd: number

  try {
    fd = fs.openSync(resolved, READ_FLAGS | fs.constants.O_DIRECTORY)
  } catch (error) {
    throw refusalOrSame(error, target)
  }

  try {
    fs.fchmodSync(fd, mode)
  } finally {
    fs.closeSync(fd)
  }
}

/** `null` when absent. Never follows: a link answers as a link. */
export function lstatInRoot(root: string, target: string): fs.Stats | null {
  try {
    return fs.lstatSync(resolveInRoot(root, target))
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') {
      return null
    }

    throw error
  }
}

/** The absent name is not an error: the file is gone either way. */
export function unlinkInRoot(root: string, target: string): void {
  try {
    fs.unlinkSync(resolveInRoot(root, target))
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') {
      throw error
    }
  }
}

export function renameInRoot(root: string, from: string, to: string): void {
  fs.renameSync(resolveInRoot(root, from), resolveInRoot(root, to))
}

/** Replaces the name itself, never what a link there points at. */
export function symlinkInRoot(root: string, linkTarget: string, link: string): void {
  unlinkInRoot(root, link)
  fs.symlinkSync(linkTarget, resolveInRoot(root, link))
}

/** `mkdir -p` that creates real folders only, and refuses a link or a file on the way, dangling or not. */
export function mkdirsInRoot(root: string, folder: string, mode = 0o700): void {
  const parts = relativeInside(root, folder).split(path.sep)
  let current = pinRoot(root)

  fs.mkdirSync(current, { recursive: true })

  for (const part of ['', ...parts]) {
    current = path.join(current, part)

    if (assertRealFolder(current, folder) === 'absent') {
      try {
        fs.mkdirSync(current, { mode })
      } catch (error) {
        // EEXIST here is a name that appeared after the check, a dangling link included: judged again, not trusted.
        if (errnoOf(error) !== 'EEXIST' || assertRealFolder(current, folder) !== 'folder') {
          throw refusalOrSame(error, folder)
        }
      }
    }
  }
}
