/**
 * Where iclone os's unix sockets live (v0.0.9; owner spec, a security boundary): the launcher, perm, pay, acp, pane.
 *
 * A unix socket path must fit macOS's sun_path (104 bytes with its NUL). Under userData it did not for a long enough
 * userData (the e2e sandbox: 139 bytes): the socket never existed, the agent was never offered `terminal`, and the
 * call became a silent unknown tool. The socket now lives in a short directory of its own:
 *   1. the per-user temp dir ($TMPDIR, /var/folders/…/T, private to the user), canonical (realpath), `ic-<hash>`;
 *   2. only if that is still too long, /tmp/<uid>-<hash>.
 * The directory is never trusted: lstat (a symlink is refused, never followed), owned by this uid, mode exactly 0700,
 * or the launcher does not start and says why. Nothing here chmods or reuses another user's directory, and a stale
 * socket is removed only when it is ours.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** sun_path is 104 bytes on macOS, NUL included. */
export const MAX_SOCKET_PATH_BYTES = 103

/** The socket families that may live in the private folder; anything else is refused. */
export const SOCKET_NAMES = ['launcher', 'perm', 'pay', 'acp', 'pane'] as const

export type SocketName = (typeof SOCKET_NAMES)[number]

export interface SocketPlace {
  tmpdir: string
  uid: number
}

const defaultPlace = (): SocketPlace => ({
  tmpdir: (() => {
    try {
      return fs.realpathSync(os.tmpdir())
    } catch {
      return os.tmpdir()
    }
  })(),
  uid: typeof process.getuid === 'function' ? process.getuid() : 0
})

const fits = (file: string) => Buffer.byteLength(file, 'utf8') <= MAX_SOCKET_PATH_BYTES

/**
 * The `name` socket for this userData (`<name>.sock`): deterministic (a sandbox profile names it), short, never under
 * userData. Every family of one userData shares its private folder. A name off SOCKET_NAMES is refused.
 */
export function socketPath(userDataDir: string, name: SocketName, place: SocketPlace = defaultPlace()): string {
  if (!(SOCKET_NAMES as readonly string[]).includes(name)) {
    throw new SocketFolderError(`No socket named "${String(name)}" may live in the private socket folder.`)
  }

  const file = `${name}.sock`
  const hash = createHash('sha256').update(path.resolve(userDataDir)).digest('hex').slice(0, 10)
  const perUser = path.join(place.tmpdir, `ic-${hash}`, file)

  return fits(perUser) ? perUser : path.join('/tmp', `${place.uid}-${hash}`, file)
}

/** How to recover from a refused folder, as data: remove that folder, or point this environment variable elsewhere. */
export interface SocketRemedy {
  removeFolder: string
  env: 'TMPDIR'
}

export class SocketFolderError extends Error {
  override name = 'SocketFolderError'

  constructor(
    message: string,
    readonly remedy: SocketRemedy | null = null
  ) {
    super(message)
  }
}

/** What prepareSocket reads of one path: node's fs.Stats satisfies it, and so does a test's plain object. */
export interface SocketEntry {
  isDirectory(): boolean
  isSymbolicLink(): boolean
  isSocket(): boolean
  mode: number
  uid: number
}

/** The file calls prepareSocket makes; node's fs satisfies it. */
export interface SocketFs {
  lstatSync(file: string): SocketEntry
  mkdirSync(dir: string, options: { mode: number }): unknown
  unlinkSync(file: string): void
}

/**
 * Make the socket's folder safe to listen in, before anything binds there. Throws SocketFolderError (shown as the
 * agent's start failure) instead of letting the tool go missing in silence.
 */
export function prepareSocket(file: string, uid = defaultPlace().uid, io: SocketFs = fs): void {
  // The allow-list holds here too: only a known family's socket is ever prepared, whatever built the path.
  const base = path.basename(file)

  if (!SOCKET_NAMES.some(name => base === `${name}.sock`)) {
    throw new SocketFolderError(`No socket named "${base}" may live in the private socket folder.`)
  }

  if (!fits(file)) {
    throw new SocketFolderError(
      `The socket cannot start: its path is ${Buffer.byteLength(file)} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte limit (${file}).`
    )
  }

  const dir = path.dirname(file)

  try {
    io.mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new SocketFolderError(`The socket folder ${dir} cannot be created: ${(error as Error).message}`)
    }
  }

  const stat = io.lstatSync(dir)

  // The /tmp fallback's name is predictable, so another user can pre-create it: say how to recover, never chmod or
  // reuse a folder that is not ours.
  const refuse = (why: string) =>
    new SocketFolderError(
      `iclone os refuses the socket folder ${dir}: ${why}. To recover, remove that folder (rm -rf '${dir}') if it is ` +
        'not yours to keep, or set TMPDIR to a private short folder of your own, then restart iclone os.',
      { removeFolder: dir, env: 'TMPDIR' }
    )

  if (stat.isSymbolicLink()) {
    throw refuse('it is a symbolic link')
  }

  if (!stat.isDirectory()) {
    throw refuse('it is not a folder')
  }

  if (stat.uid !== uid) {
    throw refuse(`it belongs to another user (uid ${stat.uid})`)
  }

  if ((stat.mode & 0o777) !== 0o700) {
    throw refuse(`its mode is ${(stat.mode & 0o777).toString(8)}, not 700`)
  }

  let existing: SocketEntry | null = null

  try {
    existing = io.lstatSync(file)
  } catch {
    existing = null
  }

  if (existing) {
    if (existing.uid !== uid || !existing.isSocket()) {
      throw refuse('a file that is not this user\'s socket sits where the socket goes')
    }

    io.unlinkSync(file)
  }
}
