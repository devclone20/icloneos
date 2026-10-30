/**
 * V3-J fix m-r3-2 — the profile a Hermes spawn RUNS AS, so its pay token is minted for that profile and no other.
 *
 * With no desktop profile set (the default) the app used to spawn Hermes without `--profile` and mint the token for
 * `default`, while Hermes itself followed its sticky `<root>/active_profile` file: a spawn that really ran an
 * unprotected profile (folder or config.yaml outside the Hermes home) still got a live pay env. Now main resolves the
 * profile exactly as Hermes would — read only, the file is never written — then PINS it with `--profile <slug>` (so
 * Hermes cannot re-read a file that changed in between) and mints for that slug, where the pay socket's unprotected
 * refusal applies. A sticky value Hermes would refuse (bad name, missing folder) is not guessed at: no flag, no token,
 * and Hermes fails exactly as it always did.
 *
 * Mirrors the runtime pin's own code (read, never imported):
 *   - `hermes_cli/main.py _apply_profile_override`: step 1.5 (a profile-shaped HERMES_HOME runs as itself), step 2
 *     (`HERMES_S6_SUPERVISED_CHILD` skips the file; `get_default_hermes_root()/active_profile`, `exists()`, UTF-8,
 *     `strip()`, empty or `default` ⇒ no override), step 3 (`resolve_profile_env`);
 *   - `hermes_constants.get_default_hermes_root` / `_get_platform_default_hermes_home`;
 *   - `hermes_cli/profiles.py normalize_profile_name`, `validate_profile_name` (`_PROFILE_ID_RE`, `_RESERVED_NAMES`),
 *     `resolve_profile_env` (the root is HERMES_HOME's own spelling; the folder must be a directory, links followed).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** What one spawn passes to Hermes and whom its pay token is for (null: no token). */
interface SpawnProfile {
  /** Prepended to the backend argv: `['--profile', slug]`, or nothing. */
  args: string[]
  /** The profile Hermes runs as; null when it cannot be known from here (the spawn then gets no pay env). */
  slug: null | string
  /** How the slug was decided, for the log (no path, no secret). */
  why: string
}

interface SpawnProfileEnv {
  /** The HERMES_HOME the child is given (main's `HERMES_HOME`). */
  hermesHome: string
  /** The rest of the child's environment (HOME, LOCALAPPDATA, HERMES_S6_SUPERVISED_CHILD). Default `process.env`. */
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

// `hermes_cli/profiles.py` `_PROFILE_ID_RE` and `_RESERVED_NAMES` (`default` is the root's alias, handled first).
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const RESERVED = new Set(['hermes', 'default', 'test', 'tmp', 'root', 'sudo'])
// Python's `str.strip()` with no argument: the characters `str.isspace()` is true for (JS `trim()` differs: it also
// drops U+FEFF and keeps U+001C–U+001F and U+0085).
const PY_SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const PY_STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, 'g')
const ACTIVE_FILE_MAX = 64 * 1024

/** `Path.resolve()` (non-strict): links resolved as far as the path exists, the rest joined as written. */
function resolveLoose(file: string): string {
  const absolute = path.resolve(file)
  let head = absolute
  const tail: string[] = []

  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail)
    } catch {
      const parent = path.dirname(head)

      if (parent === head) {
        return absolute
      }

      tail.unshift(path.basename(head))
      head = parent
    }
  }
}

function isInside(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner)

  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const isProfileShaped = (home: string): boolean => path.basename(path.dirname(home)) === 'profiles'

/** `_get_platform_default_hermes_home()`: `%LOCALAPPDATA%\hermes` on Windows, `~/.hermes` elsewhere. */
function platformHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const userHome = env.HOME || os.homedir()

  if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim()

    return path.join(local || path.join(env.USERPROFILE || userHome, 'AppData', 'Local'), 'hermes')
  }

  return path.join(userHome, '.hermes')
}

/** `get_default_hermes_root()` for this HERMES_HOME: where Hermes looks for `active_profile`. */
function defaultRoot(hermesHome: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const native = platformHome(env, platform)

  if (isInside(resolveLoose(native), resolveLoose(hermesHome))) {
    return native
  }

  return isProfileShaped(hermesHome) ? path.dirname(path.dirname(hermesHome)) : hermesHome
}

/** The sticky file's text as Hermes reads it, or null when Hermes would skip it (missing, unreadable, not UTF-8). */
function readActiveProfile(file: string): null | string {
  let fd: number

  try {
    // `Path.exists()` follows links; a directory or a FIFO is not a file Hermes can read text from.
    if (!fs.statSync(file).isFile()) {
      return null
    }

    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
  } catch {
    return null
  }

  try {
    const buffer = Buffer.alloc(ACTIVE_FILE_MAX + 1)
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0)

    // A file this large holds no profile name we accept: treated like an empty file, so `default` is PINNED (Hermes
    // never reads the file either, whatever a strip of all of it would leave).
    if (length > ACTIVE_FILE_MAX) {
      return ''
    }

    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length))
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

const isDirectory = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * The profile a Hermes spawn runs as, and the argv that pins it. A desktop profile (`readActiveDesktopProfile()`, already
 * validated) is passed as it always was. With none, the sticky file decides, read the way Hermes reads it.
 */
export function spawnProfile(desktopProfile: null | string, options: SpawnProfileEnv): SpawnProfile {
  if (desktopProfile) {
    return { args: ['--profile', desktopProfile], slug: desktopProfile, why: 'desktop profile' }
  }

  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const { hermesHome } = options

  // Step 1.5: a HERMES_HOME that is itself `<root>/profiles/<name>` runs as that folder and never reads the file; the
  // seed treats that folder as the root config (`default`). No flag: `--profile default` would re-root it.
  if (isProfileShaped(hermesHome)) {
    return { args: [], slug: 'default', why: 'HERMES_HOME is a profile folder' }
  }

  const pinDefault: SpawnProfile = { args: ['--profile', 'default'], slug: 'default', why: 'no active profile' }

  // Step 2's exception: a supervised s6 child never follows the sticky file.
  if (env.HERMES_S6_SUPERVISED_CHILD) {
    return { ...pinDefault, why: 'supervised child' }
  }

  const text = readActiveProfile(path.join(defaultRoot(hermesHome, env, platform), 'active_profile'))

  if (text === null) {
    return pinDefault
  }

  const name = text.replace(PY_STRIP, '')

  if (name === '' || name === 'default') {
    return pinDefault
  }

  // Step 3: `resolve_profile_env` → `normalize_profile_name`, `validate_profile_name`, then the folder must exist.
  const canon = name.toLowerCase() === 'default' ? 'default' : name.toLowerCase()

  if (canon === 'default') {
    return { ...pinDefault, why: 'active profile is default' }
  }

  if (!PROFILE_ID_RE.test(canon) || RESERVED.has(canon)) {
    return { args: [], slug: null, why: 'active profile name Hermes refuses' }
  }

  if (!isDirectory(path.join(hermesHome, 'profiles', canon))) {
    return { args: [], slug: null, why: 'active profile has no folder' }
  }

  return { args: ['--profile', canon], slug: canon, why: 'active profile' }
}
