/**
 * The Hermes runtime's own Seatbelt profile. Main starts the runtime as `sandbox-exec -p <text> -D … python …`; every
 * interpreter child inherits it (Seatbelt cannot be left from inside, nor nested: `sandbox_apply` in a sandboxed
 * process fails with exit 71). Confined commands are therefore started by the launcher, outside this sandbox; the
 * runtime only reaches the launcher's socket.
 *
 * Same discipline as the agent profiles (sbpl.ts): `(deny default)` first, each allow named for what the measured
 * boot needed (scripts/runtime-profile-measure.ts reproduces the measurement), then the never list LAST so no allow above can lift it. Per-spawn paths
 * are parameters: an absent parameter matches nothing, so a spawner that forgets one gets less, never more. The
 * never list is embedded as literals, so it holds whatever parameters are passed.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { protectedPaths, secretPaths } from '../iclone-permissions/classify-policy'
import { DEV_PLUGIN_OVERLAY_DIR, MANAGED_RUNTIME_DIR } from '../iclone-runtime-location'

import {
  acceptableProjectRoot,
  BASE_MACH,
  BROWSER_PROFILES,
  type ConfinementPaths,
  HOME_SECRETS,
  insideFolder,
  KEYCHAIN_SERVICES,
  NET_MACH,
  NEVER_EXEC,
  realOrSelf
} from './profiles'
import { ANCESTORS_FN, debuggerDenials, globalNames, globToSbplRegex, literals, processInfoLines, SILENT_DENY_LINES, str, subpaths, sysctlAllowLine } from './sbpl'

export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec'

/** The parameters main passes with `-D`. Every one is optional: absent ⇒ its allow matches nothing. */
export const RUNTIME_PARAMS = [
  'HERMES_HOME',
  'HOME_DIR',
  'RUNTIME_ROOT',
  'VENV_ROOT',
  'PYTHON_HOME',
  'PYTHON_EXE',
  'PLUGINS_DIR',
  'RUN_DIR',
  'READY_DIR',
  'LAUNCHER_SOCKET',
  'PROFILES_DIR',
  'MEMBERS_DIR',
  'SCRATCH_ROOT',
  'TMP',
  'CACHE',
  'PROJECT',
  'WEB_DIST',
  'PERM_DIR',
  'PERM_SOCKET',
  'PAY_SOCKET',
  'POLICY_FILE',
  'PYCACHE',
  'REFUSALS_DIR',
  'HARDLINK_ACKS'
] as const

export type RuntimeParam = (typeof RUNTIME_PARAMS)[number]

/** The facts only the spawner knows, beyond the confinement paths. Real paths are resolved here. */
export interface RuntimeFacts {
  /** HOME in the runtime's env, when it is not the confinement's home. */
  homeDir?: string | null
  /** The Hermes source tree the backend runs from. */
  runtimeRoot: string
  /** The venv whose site-packages are on PYTHONPATH. */
  venvRoot: string
  /** The interpreter main execs (a venv symlink is resolved to the binary the kernel sees). */
  python: string
  /** The interpreter's own prefix (`sys.base_prefix`), when it lies outside the venv. */
  pythonHome: string
  /** The plugin folder Hermes discovers its bundled plugins in when it is not `<runtimeRoot>/plugins`: the app-owned
   *  overlay of an unmanaged dev runtime (`HERMES_BUNDLED_PLUGINS`, iclone-runtime-location.ts). Read-only. */
  pluginsDir?: string | null
  /** The cwd main spawns Hermes in (context files). Refused when it is the home, an ancestor, or a denied dir. */
  project: string | null
  webDist: string | null
  /** A runtime-only temp dir, set as TMPDIR in the spawn env: never the whole per-user temp dir. */
  tmpDir: string
  /** The per-user cache dir (`DARWIN_USER_CACHE_DIR`) or a runtime-only one. */
  cacheDir: string | null
  /** Main's permission socket folder (`<userData>/run`): the socket and the spawn's own tokens live there. */
  permDir?: string | null
  permSocket?: string | null
  /** Main's pay socket in the same folder (the window's backend only: a pool backend carries no pay env). */
  paySocket?: string | null
  policyFile?: string | null
  /** The spawn's bytecode prefix, when the runtime runs without shipped bytecode. */
  pycacheDir?: string | null
}

/** What the interpreter and the frameworks it links read at boot (measured). Read-only, never a home folder. */
const SYSTEM_READS = [
  '/usr/lib',
  // ctypes.util.find_library walks dyld's fallback path.
  '/usr/local/lib',
  // dyld resolves the OS cryptex (shared cache) at every exec.
  '/System/Volumes/Preboot/Cryptexes',
  '/usr/share',
  '/System/Library',
  '/System/Cryptexes',
  '/private/etc',
  '/private/var/db/timezone',
  '/private/var/db/dyld',
  '/dev'
]

const MACH = [...BASE_MACH, ...NET_MACH]

/** The shell the confinement plugin names for every confined command: a stat here (is it a file), never an exec,
 *  since the launcher runs it outside this sandbox. Without the stat no terminal command can be formed. */
const SHELL_STAT = ['/bin/bash']

/**
 * The folders of HERMES_HOME the runtime never writes, whatever else it may there: `plugins/` (code run at the next
 * boot), and PM's own records in a non-packaged layout, `installs/` (each install's `facts.json`, which names the venv
 * main's helpers run, and the venv generations under it) and `tools/` (PM's Python store, the interpreter itself).
 * Main runs the interpreter these name outside every sandbox (the membership probe, the launcher), so a runtime that
 * could rewrite them would choose what main runs unconfined. In a packaged layout the same records live inside the
 * runtime root, which is never written either.
 */
export const HERMES_HOME_NEVER_WRITTEN = ['plugins', 'installs', 'tools'] as const

export const runtimeRunDir = (userDataDir: string) => path.join(userDataDir, 'confinement', 'run')
export const runtimeMarkFile = (membersDir: string) => path.join(membersDir, '.runtime')
export const launcherSocketFile = (userDataDir: string) => path.join(runtimeRunDir(userDataDir), 'launcher.sock')
/** The launcher's ledger (`runs.jsonl` for starts and ends, `refused.jsonl` for the requests it refused): a folder of
 *  its own under userData, outside every hole this profile opens, so the runtime can neither read nor rewrite the
 *  record of what ran (the run dir, which it may write, holds only the socket, its temp files and the plugin's own
 *  refusals). */
export const launcherLedgerDir = (userDataDir: string) => path.join(userDataDir, 'confinement', 'ledger')
/** `sun_path` on macOS holds 104 bytes with its terminator: a unix socket path is at most 103 characters. */
export const UNIX_SOCKET_PATH_MAX = 103
/** The longest socket name Python's own libraries make inside TMPDIR: multiprocessing's listener,
 *  `<TMPDIR>/pymp-XXXXXXXX/listener-XXXXXXXX`. */
export const PYTHON_SOCKET_SUFFIX_MAX = '/pymp-xxxxxxxx/listener-xxxxxxxx'.length
/** The runtime-only temp folder, beside the scratch root (`~/Library/Caches/iclone-os-confinement/tmp`): a socket
 *  made in it fits the kernel's cap, which `<userData>/confinement/run/tmp` under `~/Library/Application Support/
 *  iclone os` does not (runtime-profile.test.ts measures both). The agent profiles open only the scratch itself. */
export const runtimeTmpFolder = (scratchRoot: string) => path.join(path.dirname(scratchRoot), 'tmp')

const names = (items: readonly RuntimeParam[]) => `'(${items.map(name => `"${name}"`).join(' ')})`
const subs = (items: readonly RuntimeParam[]) => `(iclone-subpaths ${names(items)})`
const lits = (items: readonly RuntimeParam[]) => `(iclone-literals ${names(items)})`

// Seatbelt rejects a filter built on an absent parameter, so each parameter rule is built in the profile from the
// parameters actually passed, and dropped when none is: absent ⇒ no allow, never a broken or wider profile.
const ruleAny = (verb: 'allow' | 'deny', ops: string, filters: string, tail = '') =>
  `(let ((f ${filters})) (if (pair? f) (${verb} ${ops} (apply require-any f)${tail})))`

const allowAny = (ops: string, filters: string) => ruleAny('allow', ops, filters)

/** The parameters that name the interpreter's own folders: the venv and the Python it was made from. Read-only
 *  wherever they lie (inside HERMES_HOME in a non-packaged layout, which the runtime otherwise writes): main runs
 *  that interpreter outside every sandbox, so the runtime may never rewrite it. */
const INTERPRETER_PARAMS: RuntimeParam[] = ['VENV_ROOT', 'PYTHON_HOME']

const PARAM_FNS = `(define (iclone-collect names make)
  (let loop ((n names) (acc '()))
    (if (null? n) (reverse acc)
      (let ((v (param (car n))))
        (loop (cdr n) (if (string? v) (cons (make v) acc) acc))))))
(define (iclone-subpaths names) (iclone-collect names (lambda (v) (subpath v))))
(define (iclone-literals names) (iclone-collect names (lambda (v) (literal v))))
(define (iclone-sockets names) (iclone-collect names (lambda (v) (remote unix-socket (path-literal v)))))
(define (iclone-holes filters) (let loop ((f filters) (acc '())) (if (null? f) acc (loop (cdr f) (cons (require-not (car f)) acc)))))`

const TAG = '(with message "iclone-runtime")'
const unique = (items: string[]) => [...new Set(items)]

const READ_PARAMS: RuntimeParam[] = ['RUNTIME_ROOT', 'VENV_ROOT', 'PYTHON_HOME', 'PLUGINS_DIR', 'PROFILES_DIR', 'PROJECT', 'WEB_DIST']
const WRITE_PARAMS: RuntimeParam[] = ['HERMES_HOME', 'RUN_DIR', 'READY_DIR', 'SCRATCH_ROOT', 'TMP', 'CACHE', 'PYCACHE', 'REFUSALS_DIR']
/**
 * The userData policy, in one place. The app's state is denied whole; these parameters, the same map the `-D` list is
 * built from, are its only holes (an absent parameter is no hole, and a hole whose folder lies outside userData takes
 * nothing away from the deny). Everything else in userData stays denied: the confinement ledger and settings, the
 * permission chain, the browser profiles, other runtimes' folders.
 */
export const USERDATA_HOLES = {
  /** The runtime's code, venv and interpreter prefix, read-only: a packaged app installs them under
   *  `<userData>/hermes-runtime/<sha>`. The interpreter links inside them get their metadata literal (interpreterLinks).
   *  The plugin overlay of an unmanaged dev runtime (`<userData>/hermes-dev-plugins/plugins`) is code too: Hermes
   *  discovers its plugins there, and its links point into the runtime root, which is already a read hole. */
  code: ['RUNTIME_ROOT', 'VENV_ROOT', 'PYTHON_HOME', 'PLUGINS_DIR'],
  /** The runtime's own state, read and write: a fresh-install run puts HERMES_HOME at `<userData>/hermes-home`. */
  ownState: ['HERMES_HOME'],
  /** The layer's own folders the runtime reads: run, ready, profiles, main's permission socket, bytecode, refusals. */
  layerReads: ['RUN_DIR', 'READY_DIR', 'PROFILES_DIR', 'PERM_DIR', 'PYCACHE', 'REFUSALS_DIR'],
  layerFiles: ['POLICY_FILE', 'HARDLINK_ACKS'],
  /** Of those, the ones it writes. */
  layerWrites: ['RUN_DIR', 'READY_DIR', 'PYCACHE', 'REFUSALS_DIR']
} as const satisfies Record<string, readonly RuntimeParam[]>

/** The two userData denials, from USERDATA_HOLES: read but for every hole, write but for the state and layer writes. */
function userDataDenials(userDataDir: string): string[] {
  const readHoles = [...USERDATA_HOLES.code, ...USERDATA_HOLES.ownState, ...USERDATA_HOLES.layerReads]
  const writeHoles = [...USERDATA_HOLES.ownState, ...USERDATA_HOLES.layerWrites]
  const within = `(subpath ${str(userDataDir)})`

  return [
    `(deny file-read* (apply require-all (cons ${within} (iclone-holes (append ${subs(readHoles)} ${lits(USERDATA_HOLES.layerFiles)})))) ${TAG})`,
    `(deny file-write* (apply require-all (cons ${within} (iclone-holes ${subs(writeHoles)}))) ${TAG})`
  ]
}

/** The app's own state folders inside userData that a runtime folder may never hold nor lie in, besides userData. */
function appStateFolders(paths: ConfinementPaths): string[] {
  const policy = { userDataDir: paths.userDataDir, hermesHome: paths.hermesHome, home: paths.home, hermesRoot: paths.hermesRoot }

  return unique([
    // The top-level folders and files the policy protects (permissions, consent, run, confinement, payments, work).
    ...protectedPaths(policy).filter(item => path.dirname(item) === paths.userDataDir),
    path.join(paths.userDataDir, 'backend-ready'),
    paths.profilesDir,
    paths.membersDir
  ])
}

/** HERMES_HOME's one place inside userData: where a fresh install puts the runtime's own state. */
const USERDATA_HERMES_HOME = 'hermes-home'

/**
 * The only placements a runtime folder may have INSIDE userData, by parameter: HERMES_HOME exactly at
 * `<userData>/hermes-home`; the code holes (the runtime root, its venv, its interpreter prefix, its plugin folder) in
 * one managed runtime's folder `<userData>/hermes-runtime/<sha>`, and the plugin overlay of a dev runtime at
 * `<userData>/hermes-dev-plugins/plugins`. Everything else in userData (another runtime's folder, a browser partition,
 * the app's own state) is not a runtime's folder, whatever it is called.
 */
function allowedInsideUserData(name: RuntimeParam, relative: string): boolean {
  const segments = relative.split(path.sep)
  const inManagedRuntime = segments.length >= 2 && segments[0] === MANAGED_RUNTIME_DIR && segments[1] !== ''

  if (name === 'HERMES_HOME') {
    return relative === USERDATA_HERMES_HOME
  }

  if (name === 'PLUGINS_DIR') {
    return inManagedRuntime || relative === path.join(DEV_PLUGIN_OVERLAY_DIR, 'plugins')
  }

  return inManagedRuntime
}

/**
 * Refuses a runtime folder (HERMES_HOME, the runtime root, the venv, the interpreter prefix) whose hole would open more
 * than that folder: one that is or holds userData, one inside userData anywhere but the place that parameter may
 * have there (`allowedInsideUserData`), or one that overlaps one of the app's own folders (the confinement ledger, its
 * settings, the run dir, the profiles, the run tokens, the permission chain). Throws a sentence naming both paths;
 * main shows it and does not start the runtime.
 */
export function assertRuntimeFolderPlacement(paths: ConfinementPaths, name: RuntimeParam, folder: string): void {
  const value = realOrSelf(folder)
  const userDataDir = realOrSelf(paths.userDataDir)

  if (insideFolder(userDataDir, value)) {
    throw new Error(`${name} (${value}) is or holds the app's own data folder (${userDataDir}); it must be a folder of its own`)
  }

  for (const state of appStateFolders(paths)) {
    if (insideFolder(value, state) || insideFolder(state, value)) {
      throw new Error(`${name} (${value}) overlaps the app's own ${realOrSelf(state)}, which the agent runtime may never reach`)
    }
  }

  if (insideFolder(value, userDataDir) && !allowedInsideUserData(name, path.relative(userDataDir, value))) {
    throw new Error(
      `${name} (${value}) lies inside the app's own data folder (${userDataDir}) where no runtime folder may be; only ${
        name === 'HERMES_HOME' ? `${userDataDir}/${USERDATA_HERMES_HOME}` : `a runtime's own folder under ${userDataDir}/${MANAGED_RUNTIME_DIR}`
      } is allowed there`
    )
  }
}

export interface RuntimeNever {
  /** Never read nor written. */
  denied: string[]
  deniedGlobs: string[]
  /** The app's state: denied whole except the parameter holes above. */
  userDataDir: string
  /** Never written (the runtime's own code, main's files). */
  protectedWrites: string[]
  /** The agent mark and the decoy: a runtime process must never pass for a confined command (members.ts). */
  marks: string[]
  /** The one mark the runtime may read. */
  runtimeMark: string
  /** The real home, for the CoreFoundation locale files read at boot. */
  home: string
}

/**
 * The never list: the agent profiles' secrets and keychains, the browser profiles, the app's userData, minus what the
 * runtime itself owns (HERMES_HOME holds its own provider keys; reading them is its job).
 */
export function runtimeNever(paths: ConfinementPaths): RuntimeNever {
  assertRuntimeFolderPlacement(paths, 'HERMES_HOME', paths.hermesHome)

  const home = realOrSelf(paths.home)
  const hermesHome = realOrSelf(paths.hermesHome)
  const userDataDir = realOrSelf(paths.userDataDir)
  const policy = { userDataDir: paths.userDataDir, hermesHome: paths.hermesHome, home, hermesRoot: paths.hermesRoot }
  const secrets = secretPaths(policy)
  const ownedByRuntime = (item: string) => insideFolder(item, hermesHome) || insideFolder(item, userDataDir)

  return {
    denied: unique([
      ...HOME_SECRETS.map(rel => path.join(home, rel)),
      ...BROWSER_PROFILES.map(rel => path.join(home, rel)),
      '/Library/Keychains',
      ...secrets.filter(item => !item.includes('*') && !ownedByRuntime(item)).map(realOrSelf)
    ]),
    deniedGlobs: secrets.filter(item => item.includes('*') && !ownedByRuntime(item)),
    userDataDir,
    // Never written: the runtime's own code and the plugins folder (a plugin is code run at the next boot, so an
    // in-process tool must not plant one), the agent profiles. Its own state in HERMES_HOME (config, keys, the gate's
    // spool), the run tokens it creates and userData's holes stay writable; the rest of userData is denied below.
    protectedWrites: unique(
      [
        // Judged by HERMES_HOME first: inside userData its plugins folder is still never written.
        ...protectedPaths(policy).filter(item =>
          insideFolder(item, hermesHome)
            ? insideFolder(item, path.join(hermesHome, 'plugins'))
            : !insideFolder(item, userDataDir) && !insideFolder(item, realOrSelf(paths.membersDir))
        ),
        ...HERMES_HOME_NEVER_WRITTEN.map(name => path.join(hermesHome, name)),
        paths.profilesDir,
        ...(paths.hermesRoot ? [paths.hermesRoot] : [])
      ].map(realOrSelf)
    ),
    marks: [path.join(paths.membersDir, '.member'), path.join(paths.membersDir, '.decoy')].map(realOrSelf),
    runtimeMark: realOrSelf(runtimeMarkFile(paths.membersDir)),
    home
  }
}

export interface RuntimeProfile {
  text: string
  sha256: string
  view: { reads: string[]; writes: string[]; denied: string[] }
}

export interface RuntimeProfileExtra {
  /** Extra exec paths measured for a feature (each must be absolute and is listed in the view). */
  exec?: readonly string[]
  /** The symlinks the interpreter is reached through (`interpreterLinks`): each one a metadata literal, nothing wider. */
  links?: readonly string[]
}

/** The most links one interpreter path may go through: the kernel itself gives up at 32 per lookup, and a chain near
 *  that is a loop or a layout nobody meant. */
export const INTERPRETER_LINK_HOPS_MAX = 40

/**
 * Every symlink the kernel follows from `target` to its real path, in the order it meets them: the folder links in
 * the middle (a venv reached through a linked folder, uv's minor-version alias of a managed Python) as well as the
 * file links at the end, each once. Exec of a path goes through each of them, and following a link is a metadata
 * read of the link itself (measured: `file-read-metadata` on the link, nothing on its folder, and never
 * `file-read-data`). Throws, naming the path, when the chain loops, runs past the cap or ends nowhere: a spawn whose
 * interpreter cannot be explained is refused, never let through on a guess.
 */
export function symlinkChain(target: string): string[] {
  if (!path.isAbsolute(target)) {
    throw new Error(`the interpreter path is not absolute: ${JSON.stringify(target)}`)
  }

  const links: string[] = []
  const states = new Set<string>()
  let resolved = '/'
  let pending = target.split('/').filter(Boolean)
  let hops = 0

  while (pending.length > 0) {
    const name = pending.shift() as string

    if (name === '.') {
      continue
    }

    if (name === '..') {
      resolved = path.dirname(resolved)

      continue
    }

    const candidate = path.join(resolved, name)
    let stat

    try {
      stat = lstatSync(candidate)
    } catch {
      throw new Error(`${target} is not reachable: ${candidate} does not exist`)
    }

    if (!stat.isSymbolicLink()) {
      resolved = candidate

      continue
    }

    // The same link with the same path still to walk is the same place again: a loop, however long its cycle.
    const state = `${candidate}\u0000${pending.join('/')}`

    if (states.has(state)) {
      throw new Error(`${target} is not reachable: the link ${candidate} loops`)
    }

    if (++hops > INTERPRETER_LINK_HOPS_MAX) {
      throw new Error(`${target} is not reachable: more than ${INTERPRETER_LINK_HOPS_MAX} links on the way`)
    }

    states.add(state)

    if (!links.includes(candidate)) {
      links.push(candidate)
    }

    const linkTarget = readlinkSync(candidate)

    if (path.isAbsolute(linkTarget)) {
      resolved = '/'
    }

    pending = [...linkTarget.split('/').filter(Boolean), ...pending]
  }

  return links
}

/**
 * The links one spawn needs, from the interpreter main names and the command it execs (the same path, or the venv's
 * own `bin/python` beside the real folder): each once, in the order met. A link inside a folder the never list
 * denies is refused by name, since no allow above the never list could let the kernel follow it. Inside userData a
 * link is accepted only within one of the runtime's code holes (USERDATA_HOLES.code, from `facts`: a packaged app's
 * venv link under `<userData>/hermes-runtime/<sha>`); anywhere else in userData it is refused.
 */
export function interpreterLinks(paths: ConfinementPaths, targets: readonly string[], facts?: RuntimeFacts): string[] {
  const never = runtimeNever(paths)
  const links = unique(targets.flatMap(symlinkChain))
  const values = facts ? runtimeParamValues(paths, facts) : {}

  const codeHoles = USERDATA_HOLES.code
    .map(name => values[name])
    .filter((value): value is string => Boolean(value))

  for (const link of links) {
    // The link's own place (its folder is already real): what it points at is judged by the parameters, not here.
    const folder = path.dirname(link)
    const opened = codeHoles.some(hole => insideFolder(folder, hole))

    const denied = [...never.denied, ...(opened ? [] : [never.userDataDir])].find(item => insideFolder(folder, item))

    if (denied) {
      throw new Error(`the interpreter is reached through ${link}, a link inside ${denied}, which the runtime may never read`)
    }

    str(link)
  }

  return links
}

export function renderRuntimeSbpl(never: RuntimeNever, extra: RuntimeProfileExtra = {}): string {
  const lines = [
    '(version 1)',
    '; iclone os runtime profile · generated by electron/iclone-confinement/runtime-profile.ts — never hand-edited',
    `(deny default ${TAG})`,
    ANCESTORS_FN,
    PARAM_FNS,
    // Hermes forks interpreter children (tool workers, the stub that carries each confined command to the launcher).
    '(allow process-fork)',
    // The interpreter only, by its real path: the runtime, its `subprocess.run([sys.executable, …])` children and the
    // stub. Never sandbox-exec, never a shell: confined commands go through the launcher.
    allowAny('process-exec', `(append ${lits(['PYTHON_EXE'])} (list ${literals(extra.exec ?? [])}))`),
    // Stop its own workers (killpg on a tool timeout); nothing outside this sandbox.
    '(allow signal (target same-sandbox))',
    // CPython's os.cpu_count, platform and the hash seed; asyncio's loop setup. fx32p: every other name is refused and
    // reported: measured under the live rows, boot and daily work report nine lines over four processes, not a flood.
    `(deny sysctl-read ${TAG})`,
    sysctlAllowLine(),
    // R31: both halves of the kernel route to another process's command line and environment (sbpl.ts).
    ...processInfoLines(TAG),
    '(allow system-info)',
    // libnotify, which every process that links libSystem opens.
    '(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))',
    // User lookup (pwd), logging, the per-user temp dir, DNS and certificate trust for the model providers.
    `(allow mach-lookup ${globalNames(MACH)})`,
    // The interpreter's libraries, zoneinfo, certificates (/private/etc/ssl), locale.
    `(allow file-read* ${subpaths(SYSTEM_READS)} (literal "/") (literal "/Library/Preferences/.GlobalPreferences.plist"))`,
    // realpath() and os.getcwd() stat every parent of the paths below, and only stat them: no directory listing.
    `(allow file-read-metadata ${literals(['/private', '/private/var', '/Users', '/Library', '/var', '/etc', '/tmp', '/usr', '/usr/local', '/System/Volumes/Data'])})`,
    allowAny('file-read-metadata', lits(['HOME_DIR'])),
    `(allow file-read-metadata ${literals(SHELL_STAT)})`,
    // The links the interpreter is reached through (a venv's `bin/python`, a linked folder on its way, uv's
    // minor-version alias of a managed Python): the kernel follows a link by reading its metadata, so each is a
    // literal here and nothing else — not its folder, not what it points at. None ⇒ no line (an unfiltered allow
    // would be every file's metadata).
    ...(extra.links && extra.links.length > 0 ? [`(allow file-read-metadata ${literals(extra.links)})`] : []),
    // CoreFoundation's locale and text encoding (urllib's proxy lookup and platform load it): no secret lives here.
    `(allow file-read* ${literals([path.join(never.home, '.CFUserTextEncoding'), ...['.GlobalPreferences.plist', '.GlobalPreferences_m.plist'].map(name => path.join(never.home, 'Library/Preferences', name))])} ${globToSbplRegex(path.join(never.home, 'Library/Preferences/ByHost/.GlobalPreferences.*.plist'))})`,
    ...[...READ_PARAMS, ...WRITE_PARAMS, 'MEMBERS_DIR' as const, 'PERM_DIR' as const].map(
      name => `(allow file-read-metadata (apply require-any (cons (literal "/") (iclone-ancestors (param "${name}")))))`
    ),
    // Code and data the runtime reads: its source tree, venv, interpreter prefix, the agent profiles it hands the
    // launcher, the project's context files, the web build it serves.
    allowAny('file-read*', subs(READ_PARAMS)),
    allowAny('file-read* file-write*', subs(WRITE_PARAMS)),
    // Main's permission socket folder: the socket, its token and the spawn's pay token (the gate plugin reads them).
    allowAny('file-read*', `(append ${subs(['PERM_DIR'])} ${lits(['POLICY_FILE', 'HARDLINK_ACKS'])})`),
    // Run tokens: the plugin creates them and never reads one (a reader would pass for a member of that run), and never
    // removes one: the token is the run's identity with the kernel, so main's sweepTokens is the only remover. Making a
    // file needs file-write-create alone (measured, fx28): an open for writing of one already there is refused.
    allowAny('file-read-data file-read-metadata', `(cons (literal ${str(never.runtimeMark)}) ${lits(['MEMBERS_DIR'])})`),
    allowAny('file-write-create', subs(['MEMBERS_DIR'])),
    '(allow file-write-data file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))',
    // Model providers, MCP over HTTP, and the app's own localhost server.
    '(allow network-outbound (remote ip "*:*"))',
    '(allow network-bind network-inbound (local ip "localhost:*"))',
    // DNS, the launcher (confined commands), main's permission socket and its pay socket: the only unix sockets.
    allowAny('network-outbound', `(cons (remote unix-socket (path-literal "/private/var/run/mDNSResponder")) (iclone-sockets ${names(['LAUNCHER_SOCKET', 'PERM_SOCKET', 'PAY_SOCKET'])}))`),
    '; never, whatever the parameters',
    `(deny file-read* file-write* ${subpaths(never.denied)} ${never.deniedGlobs.map(globToSbplRegex).join(' ')} ${TAG})`,
    // The app's state, whole, but for USERDATA_HOLES (the rules below still deny the runtime's code and its plugins
    // folder for writes, and every mark).
    ...userDataDenials(never.userDataDir),
    `(deny file-write* ${subpaths(never.protectedWrites)} (literal ${str(never.runtimeMark)}) ${TAG})`,
    // The venv and the Python home of this spawn, after the HERMES_HOME allow (last match wins): the interpreter main
    // runs unconfined is never the runtime's to rewrite, in whatever layout it lies.
    ruleAny('deny', 'file-write*', subs(INTERPRETER_PARAMS), ` ${TAG}`),
    `(deny file-read* file-write* ${literals(never.marks)} ${TAG})`,
    `(deny mach-lookup ${globalNames(KEYCHAIN_SERVICES)} ${TAG})`,
    `(deny process-exec (literal "${SANDBOX_EXEC_PATH}") ${literals(NEVER_EXEC)} ${TAG})`,
    `(deny file-link ${TAG})`,
    ...debuggerDenials(),
    // The OS logging probes: refused as before, unreported (profiles.ts SILENT_DENY_*).
    ...SILENT_DENY_LINES
  ]

  return `${lines.join('\n')}\n`
}

export function generateRuntimeProfile(paths: ConfinementPaths, extra: RuntimeProfileExtra = {}): RuntimeProfile {
  for (const item of extra.exec ?? []) {
    if (!path.isAbsolute(item) || realOrSelf(item) === realOrSelf(SANDBOX_EXEC_PATH)) {
      throw new Error(`confinement: refusing a runtime exec allowance: ${JSON.stringify(item)}`)
    }
  }

  for (const item of extra.links ?? []) {
    if (!path.isAbsolute(item) || item === '/' || path.normalize(item) !== item) {
      throw new Error(`confinement: refusing a runtime link allowance: ${JSON.stringify(item)}`)
    }
  }

  const never = runtimeNever(paths)
  const text = renderRuntimeSbpl(never, extra)

  return {
    text,
    sha256: createHash('sha256').update(text).digest('hex'),
    view: {
      reads: ['runtime', 'venv', 'interpreter', 'plugin overlay', 'profiles', 'project (context files)', 'web build', ...SYSTEM_READS],
      writes: ['hermes home', 'confinement run dir', 'scratch', 'runtime temp', 'run tokens (create only)'],
      denied: [...never.denied, ...never.deniedGlobs, `${never.userDataDir} (except the runtime's own folders and the run dir)`, ...never.marks]
    }
  }
}

/**
 * The parameter values of one spawn, after the safety filter. Every value is a real absolute path the generator would
 * also accept as a literal; a value that is not (or a project the confinement refuses) is left out, so its allow
 * matches nothing. One map feeds both the `-D` list and the roots main names to the launcher, so they cannot drift.
 */
export function runtimeParamValues(paths: ConfinementPaths, facts: RuntimeFacts): Partial<Record<RuntimeParam, string>> {
  const userDataDir = realOrSelf(paths.userDataDir)
  const never = runtimeNever(paths)

  const inUserData = (value: string | null | undefined) =>
    value && insideFolder(value, userDataDir) ? realOrSelf(value) : null

  const project =
    facts.project &&
    acceptableProjectRoot(facts.project, { denied: [...never.denied, userDataDir] }, paths.home)
      ? realOrSelf(facts.project)
      : null

  const values: Record<RuntimeParam, string | null> = {
    HERMES_HOME: realOrSelf(paths.hermesHome),
    // The HOME the runtime runs with: stat only (Path.home().exists()), never listed nor read.
    HOME_DIR: realOrSelf(facts.homeDir ?? paths.home),
    RUNTIME_ROOT: realOrSelf(facts.runtimeRoot),
    VENV_ROOT: realOrSelf(facts.venvRoot),
    PYTHON_HOME: realOrSelf(facts.pythonHome),
    PYTHON_EXE: realOrSelf(facts.python),
    PLUGINS_DIR: facts.pluginsDir ? realOrSelf(facts.pluginsDir) : null,
    RUN_DIR: realOrSelf(runtimeRunDir(paths.userDataDir)),
    // The backend publishes its port in an atomic ready file here (web_server_lifecycle.py).
    READY_DIR: realOrSelf(path.join(paths.userDataDir, 'backend-ready')),
    LAUNCHER_SOCKET: realOrSelf(launcherSocketFile(paths.userDataDir)),
    PROFILES_DIR: realOrSelf(paths.profilesDir),
    MEMBERS_DIR: realOrSelf(paths.membersDir),
    SCRATCH_ROOT: realOrSelf(paths.scratchRoot),
    TMP: realOrSelf(facts.tmpDir),
    CACHE: facts.cacheDir ? realOrSelf(facts.cacheDir) : null,
    PROJECT: project,
    WEB_DIST: facts.webDist ? realOrSelf(facts.webDist) : null,
    PERM_DIR: inUserData(facts.permDir),
    PERM_SOCKET: inUserData(facts.permSocket),
    PAY_SOCKET: inUserData(facts.paySocket),
    POLICY_FILE: inUserData(facts.policyFile),
    PYCACHE: inUserData(facts.pycacheDir),
    REFUSALS_DIR: realOrSelf(path.join(paths.userDataDir, 'confinement', 'refusals')),
    HARDLINK_ACKS: realOrSelf(path.join(paths.userDataDir, 'confinement', 'hardlink-acks.json'))
  }

  // A runtime folder that is a userData hole must be a folder of its own (assertRuntimeFolderPlacement).
  for (const name of USERDATA_HOLES.code) {
    const value = values[name]

    if (value) {
      assertRuntimeFolderPlacement(paths, name, value)
    }
  }

  // A writable or readable root may never be (or contain) a denied path, the home or `/`.
  const home = realOrSelf(paths.home)
  const out: Partial<Record<RuntimeParam, string>> = {}

  for (const name of RUNTIME_PARAMS) {
    const value = values[name]

    if (!value || !path.isAbsolute(value) || value === '/') {
      continue
    }

    str(value)

    // HOME_DIR is a stat-only literal: the home itself is fine there, and nowhere else.
    if (name === 'HOME_DIR') {
      out[name] = value

      continue
    }

    if (value === home) {
      continue
    }

    if (never.denied.some(denied => insideFolder(denied, value) || insideFolder(value, denied))) {
      continue
    }

    out[name] = value
  }

  return out
}

/** The `-D` list for one spawn, in parameter order. */
export function runtimeProfileParams(paths: ConfinementPaths, facts: RuntimeFacts): string[] {
  const values = runtimeParamValues(paths, facts)

  return RUNTIME_PARAMS.flatMap(name => (values[name] ? ['-D', `${name}=${values[name]}`] : []))
}

/** The runtime's temp (a browser's own folder, a transcription's work folder) and its package cache. */
const GRANT_PARAMS: RuntimeParam[] = ['TMP', 'CACHE']

/** The caches under HERMES_HOME the media tools write (tools/tts_tool.py get_hermes_dir). */
const MEDIA_CACHES = ['cache/audio', 'audio_cache'] as const

/** The folders the runtime profile reads and writes, as resolved for one spawn. */
export interface RuntimeRoots {
  reads: string[]
  writes: string[]
  /** What a program's widening may be given to write, besides the run's own scratch and output: the runtime's temp and
   *  the audio caches its media tools write (fx26a). Never the whole of HERMES_HOME. */
  grants: string[]
}

/**
 * The runtime profile's own read roots and write roots, from the same values its parameters are built from: what the
 * launcher is told at start, so a widened helper profile can grant a confined command no path the runtime itself does
 * not hold. The app's own state is never a root (the runtime's holes in userData are its own, not a command's).
 */
export function runtimeRoots(paths: ConfinementPaths, facts: RuntimeFacts): RuntimeRoots {
  const values = runtimeParamValues(paths, facts)

  const pick = (names: readonly RuntimeParam[]) =>
    names.map(name => values[name]).filter((value): value is string => Boolean(value))

  return {
    reads: pick(READ_PARAMS),
    writes: pick(WRITE_PARAMS.filter(name => !(USERDATA_HOLES.layerWrites as readonly RuntimeParam[]).includes(name))),
    grants: [
      ...pick(GRANT_PARAMS),
      ...MEDIA_CACHES.flatMap(name => (values.HERMES_HOME ? [path.join(values.HERMES_HOME, name)] : []))
    ]
  }
}

export function runtimeSandboxArgv(
  profile: Pick<RuntimeProfile, 'text'>,
  params: readonly string[],
  command: string,
  args: readonly string[]
): string[] {
  return [SANDBOX_EXEC_PATH, '-p', profile.text, ...params, command, ...args]
}

/**
 * The folders the runtime profile lets the runtime write, judged from the confinement paths alone (what main knows
 * before any spawn) plus the per-spawn facts when there are any: HERMES_HOME, the run and ready folders, the scratch
 * root and the runtime temp folder beside it, the run tokens, the refusals, and the spawn's cache and bytecode
 * folders. The write-denied subfolders inside them (`protectedWrites`) are judged separately by the caller.
 */
export function runtimeWritableFolders(paths: ConfinementPaths, facts?: Partial<RuntimeFacts> | null): string[] {
  return unique(
    [
      paths.hermesHome,
      runtimeRunDir(paths.userDataDir),
      path.join(paths.userDataDir, 'backend-ready'),
      path.join(paths.userDataDir, 'confinement', 'refusals'),
      paths.scratchRoot,
      runtimeTmpFolder(paths.scratchRoot),
      paths.membersDir,
      facts?.tmpDir,
      facts?.cacheDir,
      facts?.pycacheDir
    ]
      .filter((item): item is string => Boolean(item))
      .map(realOrSelf)
  )
}

export type InterpreterTrust =
  | { trusted: true; path: string; real: string }
  | { trusted: false; path: string; reason: string }

/**
 * Whether main may run `candidate` OUTSIDE every sandbox (the membership probe, the launcher, the prefix and plugin
 * probes of a spawn). Trusted when the binary it resolves to, and every link on the way, lies where the runtime
 * profile never writes: the runtime root, PM's records and Python store, anywhere outside the runtime's write roots.
 * Refused, with the folder named, when any of them lies in a folder the runtime can write (HERMES_HOME outside those
 * records, the scratch, the temp folders, the run dir): an interpreter the confined runtime could replace would run
 * its code with the user's rights, so it is never run, whatever else main was told about it.
 */
export function judgeHelperInterpreter(
  paths: ConfinementPaths,
  candidate: string,
  facts?: Partial<RuntimeFacts> | null
): InterpreterTrust {
  if (!path.isAbsolute(candidate)) {
    return { trusted: false, path: candidate, reason: `${candidate} is not an absolute path` }
  }

  let real: string
  let links: string[]

  try {
    real = realpathSync(candidate)
    links = symlinkChain(candidate)
  } catch (error) {
    return { trusted: false, path: candidate, reason: `${candidate} cannot be resolved (${(error as Error).message})` }
  }

  let stat

  try {
    stat = lstatSync(real)
  } catch {
    return { trusted: false, path: candidate, reason: `${real} does not exist` }
  }

  if (!stat.isFile()) {
    return { trusted: false, path: candidate, reason: `${real} is not a file` }
  }

  let neverWritten: string[]

  try {
    neverWritten = runtimeNever(paths).protectedWrites
  } catch (error) {
    return { trusted: false, path: candidate, reason: (error as Error).message }
  }

  const writable = runtimeWritableFolders(paths, facts)
  const protectedFolder = (item: string) => neverWritten.some(folder => insideFolder(item, folder))

  const writableFolder = (item: string) =>
    protectedFolder(item) ? null : (writable.find(folder => insideFolder(item, folder)) ?? null)

  for (const link of links) {
    const folder = writableFolder(path.dirname(link))

    if (folder) {
      return {
        trusted: false,
        path: candidate,
        reason: `${candidate} is reached through ${link}, a link inside ${folder}, which the agent runtime can write`
      }
    }
  }

  const folder = writableFolder(real)

  if (folder) {
    return { trusted: false, path: candidate, reason: `${real} lies in ${folder}, which the agent runtime can write` }
  }

  return { trusted: true, path: candidate, real }
}
