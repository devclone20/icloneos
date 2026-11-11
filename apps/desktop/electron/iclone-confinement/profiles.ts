/**
 * V3-G §1 — the five activity classes as data. A profile names what a confined command may read, write and reach;
 * anything it does not name is refused (the SBPL starts from `(deny default)`, sbpl.ts). The per-spawn facts that
 * only the spawner knows (the project root, the scratch dir, whether the permission mode grants the network or
 * project writes) are SBPL parameters, so one generated file serves every session and is never hand-edited.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

import { ACTIVITY_CLASSES, type ActivityClass } from '../../src/iclone-shared/confinement'
import { protectedPaths, secretPaths } from '../iclone-permissions/classify-policy'

import { diskFold } from './disk-name'
import { memberMarkFile } from './members'

export interface ConfinementPaths {
  home: string
  hermesHome: string
  userDataDir: string
  hermesRoot: string | null
  /** Where the profiles live (main's, never writable from inside). */
  profilesDir: string
  /** Parent of every per-session scratch dir; outside userData so the app's own state can be denied whole. */
  scratchRoot: string
  /** One empty token file per confined run (members.ts): readable by its own sandbox only, written by main only. */
  membersDir: string
  /** xcrun's lookup cache (`$DARWIN_USER_TEMP_DIR/xcrun_db`), read-only: without it every /usr/bin/git spawns
   *  xcodebuild and fails to write a new cache. Never writable (round 1's write allowance was a hole, F3). */
  xcrunCache?: string | null
}

/** The SBPL parameters a spawner passes with `-D`. Absent ⇒ the rule that reads it does not match (fail closed). */
const PROFILE_PARAMS = ['PROJECT_ROOT', 'SCRATCH', 'OUTPUT_DIR', 'NET', 'WRITE_PROJECT', 'PROJECT_GIT', 'MEMBER'] as const
export type ProfileParam = (typeof PROFILE_PARAMS)[number]

export interface ProfileSpec {
  cls: ActivityClass
  network: 'grant' | 'never'
  /** Subpaths readable (and executable) in every class: the OS, the toolchains. */
  systemReads: string[]
  /** Single files readable (locale, Xcode selection): never a directory listing. */
  readLiterals: string[]
  /** Extra subpaths this class reads (build: the package caches). */
  extraReads: string[]
  /** Extra subpaths this class writes (build: the package caches). */
  extraWrites: string[]
  /** Parameter roots: read, written always, written only when WRITE_PROJECT=1. */
  paramReads: ProfileParam[]
  paramWrites: ProfileParam[]
  projectWrites: boolean
  /** Never readable nor writable, whatever the class and the mode: secrets and the app's own state. */
  denied: string[]
  /** The same, as anchored path globs (`*` within one segment). */
  deniedGlobs: string[]
  /** Never writable (V3-F floor 2/7), even inside the project. */
  protectedWrites: string[]
  /** Mach services every class may reach (user lookup, logging, temp dir): no credential service is here. */
  mach: string[]
  /** Mach services only a granted network opens (DNS, certificate trust). */
  netMach: string[]
  /** The file every iclone sandbox may read and no other sandbox does (members.ts): "this process is ours". */
  memberMark: string
}

/** Every Mach service that reaches a credential store. Denied last, so no allow above can open one. */
export const KEYCHAIN_SERVICES = [
  'com.apple.SecurityServer',
  'com.apple.securityd',
  'com.apple.securityd.xpc',
  'com.apple.security.agent',
  'com.apple.security.keychain-circle-notification',
  'com.apple.secd',
  'com.apple.ctkd.token-client'
] as const

/**
 * Binaries that reach past the sandbox through another process: launchd (start or stop services), Apple Events
 * (drive other apps), LaunchServices (open an app outside), the keychain CLI, privilege. Measured on macOS 27:
 * `launchctl kickstart` ran from inside a deny-default profile, so these are refused by name as well. The TCC tool
 * is not listed: it needs `com.apple.tccd`, which the default deny already refuses (seatbelt.live.test.ts proves it).
 */
export const NEVER_EXEC = [
  '/bin/launchctl',
  '/usr/bin/osascript',
  '/usr/bin/open',
  '/usr/bin/security',
  '/usr/bin/sudo',
  '/usr/bin/su',
  '/usr/bin/login',
  '/usr/sbin/screencapture',
  '/usr/sbin/sysadminctl',
  '/usr/bin/dscl',
  '/usr/bin/shortcuts'
] as const

export const BASE_MACH = [
  'com.apple.bsd.dirhelper',
  'com.apple.logd',
  'com.apple.system.logger',
  'com.apple.system.notification_center',
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.opendirectoryd.membership'
]

export const NET_MACH = [
  'com.apple.dnssd.service',
  'com.apple.mDNSResponder',
  'com.apple.SystemConfiguration.configd',
  'com.apple.SystemConfiguration.DNSConfiguration',
  'com.apple.networkd',
  'com.apple.trustd',
  'com.apple.trustd.agent'
]

/**
 * The OS's own logging probes, refused without a report. While a log stream is attached (main's refusal stream always
 * is), libtrace asks diagnosticd from every process whether a live stream wants its messages, and reads diagnosticd's
 * filter under /Library/Preferences/Logging. Nothing allows either, so they stay refused; but reported, they landed on
 * every confined bash — a plain `sleep` included — and the rows that mean something drowned in them (51 of 58 in one
 * hour of the app). `(with no-report)` keeps the denial and withholds the kernel's log line: these two names, nothing
 * wider, never an allow.
 */
export const SILENT_DENY_MACH = ['com.apple.diagnosticd'] as const
export const SILENT_DENY_READS = ['/Library/Preferences/Logging'] as const

const SYSTEM_READS = [
  '/bin',
  '/sbin',
  '/usr',
  '/System',
  '/Library/Apple',
  '/Library/Developer',
  '/Library/Frameworks',
  '/Applications/Xcode.app',
  '/opt/homebrew',
  '/private/etc',
  '/private/var/db/dyld',
  '/private/var/db/timezone',
  '/private/var/select',
  '/dev'
]

/** Toolchains people install under their home. Binaries only: no config dir that could hold a token. */
const HOME_TOOLCHAINS = [
  '.local/bin',
  '.nvm/versions',
  '.volta/tools',
  '.bun/bin',
  '.cargo/bin',
  '.rustup/toolchains',
  '.pyenv/versions',
  '.deno/bin'
]

/**
 * fx7 (A-M1, project-root rule): what the user's own shell or tools later RUN — a binary folder on PATH, a shell
 * startup file, git's own config (aliases and hooksPath run commands), a launch agent. No class writes there in any
 * mode, and no project is rooted at, inside or around one. Toolchain folders are binaries on PATH too.
 */
export const EXEC_ON_BEHALF_SYSTEM = ['/opt/homebrew', '/opt/local', '/usr/local'] as const
export const EXEC_ON_BEHALF_HOME = [
  'bin',
  '.local/bin',
  'Library/LaunchAgents',
  '.zshenv',
  '.zprofile',
  '.zshrc',
  '.zlogin',
  '.zlogout',
  '.zsh',
  '.oh-my-zsh',
  '.bash_profile',
  '.bash_login',
  '.bashrc',
  '.bash_logout',
  '.profile',
  '.config/fish',
  '.gitconfig',
  '.config/git',
  ...HOME_TOOLCHAINS
] as const

export function execOnBehalfWrites(home: string): string[] {
  return [...EXEC_ON_BEHALF_SYSTEM, ...EXEC_ON_BEHALF_HOME.map(rel => path.join(home, rel))]
}

/**
 * fx10: what names a program git runs, in the repository the project already was. `.git` itself goes with them, since
 * replacing it (a new folder, or a `.git` file pointing at a new gitdir) replaces them all. `commondir` redirects both
 * config and hooks; `worktrees` holds each linked checkout's `commondir` and `config.worktree`.
 *
 * Only the project's root repository: a nested one sits under a folder the command can rename, so no path rule holds
 * it, and git init and git clone must write a new repository's config many times (live rows: git-config.live.test.ts).
 */
export const PROJECT_GIT_FILES = ['', '/config', '/config.worktree', '/commondir'] as const
export const PROJECT_GIT_FOLDERS = ['/hooks', '/worktrees'] as const

export type ProjectGitState = 'locked' | 'unborn'

/**
 * `unborn` lifts the rule for one run: the project has no `.git` of its own yet, so git init can write one. A scratch
 * folder standing in for a project is nobody's repository. Anything unsure is `locked`.
 */
export function projectGitState(project: string, scratch: string): ProjectGitState {
  if (project === scratch) {
    return 'unborn'
  }

  try {
    lstatSync(path.join(project, '.git'))

    return 'locked'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unborn' : 'locked'
  }
}

/** Package caches the build class may read and fill. Never the rc files next to them (tokens live there). */
const HOME_CACHES = [
  '.npm/_cacache',
  '.cache',
  'Library/Caches/pip',
  'Library/Caches/pnpm',
  'Library/Caches/Yarn',
  '.cargo/registry',
  '.cargo/git',
  'go/pkg/mod',
  '.gradle/caches',
  '.m2/repository',
  '.bun/install/cache'
]

/** Browser profiles: cookies, saved passwords, sessions, extensions that run later. */
export const BROWSER_PROFILES = [
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Chromium',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Microsoft Edge',
  'Library/Application Support/Arc',
  'Library/Application Support/Vivaldi',
  'Library/Application Support/Firefox',
  'Library/Safari',
  'Library/Containers/com.apple.Safari'
]

/** Secrets under the home, denied whole. `Library/Keychains` is the keychain itself. */
export const HOME_SECRETS = [
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.config/gh',
  '.config/gcloud',
  '.config/op',
  '.netrc',
  '.npmrc',
  '.yarnrc.yml',
  '.pypirc',
  '.git-credentials',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  'Library/Keychains',
  'Library/Application Support/com.apple.TCC',
  'Library/Cookies',
  'Library/Mail',
  'Library/Messages'
]

const CLASS_SHAPE: Record<
  ActivityClass,
  { network: 'grant' | 'never'; projectWrites: boolean; caches: boolean; output: boolean }
> = {
  research: { network: 'grant', projectWrites: false, caches: false, output: false },
  project: { network: 'grant', projectWrites: true, caches: false, output: false },
  build: { network: 'grant', projectWrites: true, caches: true, output: false },
  offline: { network: 'never', projectWrites: true, caches: false, output: false },
  media: { network: 'never', projectWrites: false, caches: false, output: true }
}

/** macOS answers file checks on the real path (`/tmp` is `/private/tmp`): resolve what exists, keep the rest. */
export function realOrSelf(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    const parent = path.dirname(target)

    return parent === target ? target : path.join(realOrSelf(parent), path.basename(target))
  }
}

const within = (child: string, parent: string) => child === parent || child.startsWith(`${parent}${path.sep}`)

/** A folder's identity: `dev:ino` of what `target` names (symlinks followed), or null when nothing is there. */
function folderIdentity(target: string): string | null {
  try {
    const stat = statSync(target, { bigint: true })

    return `${stat.dev}:${stat.ino}`
  } catch {
    return null
  }
}

/**
 * r6 (INFO-1): `child` is `parent` or lies inside it — by real path, or by folder identity, so an alias of the same
 * folder (the firmlink `/System/Volumes/Data/…` form, a case variant on a case-insensitive volume) is the same folder.
 * A path that does not exist is judged by its string alone.
 */
export function insideFolder(child: string, parent: string): boolean {
  const realChild = realOrSelf(child)

  if (within(realChild, realOrSelf(parent))) {
    return true
  }

  const id = folderIdentity(parent)

  if (id === null) {
    return false
  }

  for (let at = realChild; ; at = path.dirname(at)) {
    if (folderIdentity(at) === id) {
      return true
    }

    if (path.dirname(at) === at) {
      return false
    }
  }
}

const unique = (items: string[]) => [...new Set(items)]

export function buildProfileSpec(cls: ActivityClass, paths: ConfinementPaths): ProfileSpec {
  const shape = CLASS_SHAPE[cls]
  const home = realOrSelf(paths.home)
  const inHome = (rel: string) => path.join(home, rel)

  const policyPaths = {
    userDataDir: paths.userDataDir,
    hermesHome: paths.hermesHome,
    home,
    hermesRoot: paths.hermesRoot
  }

  const secretList = secretPaths(policyPaths)

  return {
    cls,
    network: shape.network,
    systemReads: unique([
      ...SYSTEM_READS,
      ...HOME_TOOLCHAINS.map(inHome),
      realOrSelf(path.join(paths.hermesHome, 'node'))
    ]),
    readLiterals: [
      '/Library/Preferences/.GlobalPreferences.plist',
      '/Library/Preferences/com.apple.dt.Xcode.plist',
      inHome('.CFUserTextEncoding'),
      inHome('Library/Preferences/.GlobalPreferences.plist'),
      ...(paths.xcrunCache ? [realOrSelf(paths.xcrunCache)] : [])
    ],
    extraReads: shape.caches ? HOME_CACHES.map(inHome) : [],
    extraWrites: shape.caches ? HOME_CACHES.map(inHome) : [],
    paramReads: ['PROJECT_ROOT', 'SCRATCH', ...(shape.output ? (['OUTPUT_DIR'] as const) : [])],
    paramWrites: ['SCRATCH', ...(shape.output ? (['OUTPUT_DIR'] as const) : [])],
    projectWrites: shape.projectWrites,
    denied: unique([
      ...HOME_SECRETS.map(inHome),
      '/Library/Keychains',
      realOrSelf(paths.userDataDir),
      realOrSelf(path.join(paths.hermesHome, '.env')),
      realOrSelf(path.join(paths.hermesHome, 'auth.json')),
      realOrSelf(path.join(paths.hermesHome, 'config.yaml')),
      realOrSelf(paths.profilesDir),
      ...secretList.filter(item => !item.includes('*')).map(realOrSelf)
    ]),
    deniedGlobs: secretList.filter(item => item.includes('*')),
    // The profiles and the run tokens are main's: no confined command may rewrite what confines it or forge a run.
    // fx7: nor what the user's own shell later runs (execOnBehalfWrites).
    // G21: nor the videos folder: the writer runs outside the Seatbelt and follows a link, so a swapped name would let a command aim it. The folder and what holds it are also refused as project roots.
    protectedWrites: unique(
      [...protectedPaths(policyPaths), paths.profilesDir, paths.membersDir, ...execOnBehalfWrites(paths.home), path.join(paths.home, 'Movies', 'icloneOS Recordings')].map(
        realOrSelf
      )
    ),
    mach: BASE_MACH,
    netMach: NET_MACH,
    memberMark: realOrSelf(memberMarkFile(paths.membersDir))
  }
}

/**
 * G23, the owner's ruling: the one thing a file tool leaves alone after Allow or in Ignore: what holds the confinement
 * itself and the one-file route's own ledger. Writing there breaks the mechanism in use, so the shell route is the way.
 */
export function appOwnFiles(paths: ConfinementPaths): string[] {
  const policy = { userDataDir: paths.userDataDir, hermesHome: paths.hermesHome, home: paths.home, hermesRoot: paths.hermesRoot }

  return unique(
    [paths.userDataDir, paths.hermesHome, paths.profilesDir, paths.membersDir, paths.scratchRoot, ...protectedPaths(policy)].map(realOrSelf)
  )
}

/** G23: the sheet's extra line: what the agent writes here may run later with the owner's access, or it holds keys. */
export function fileRunsOrHoldsKeys(file: string, spec: Pick<ProfileSpec, 'denied' | 'protectedWrites'>, home: string): boolean {
  const lowered = diskFold(file)
  const realHome = realOrSelf(home)

  return (
    lowered.split(path.sep).includes('.git') ||
    [...spec.protectedWrites, ...spec.denied, ...[...BROWSER_PROFILES, '.pgpass'].map(rel => path.join(realHome, rel))].some(item =>
      within(lowered, diskFold(item))
    )
  )
}

export function buildAllProfileSpecs(paths: ConfinementPaths): ProfileSpec[] {
  return ACTIVITY_CLASSES.map(cls => buildProfileSpec(cls, paths))
}

/**
 * A project root the confinement will accept as writable. `/`, the home itself or any of its ancestors, the app's
 * own state and every denied dir are refused: an agent that `cd`s there must not turn it into its project. r6: nor is
 * a pnpm store root, or a folder inside one — a store is never a project (`storeRoots`, hardlinks.ts). Folders are
 * compared by identity as well as by real path (`insideFolder`), so an alias names the same folder.
 */
export function acceptableProjectRoot(
  root: string,
  spec: Pick<ProfileSpec, 'denied'> & Partial<Pick<ProfileSpec, 'protectedWrites'>>,
  home: string,
  storeRoots: readonly string[] = []
): boolean {
  return projectRootRefusal(root, spec, home, storeRoots) === null
}

/** Which rule refuses `root` as a project, or null: the one rule set, so main's picker can say why (fx32p). */
export function projectRootRefusal(
  root: string,
  spec: Pick<ProfileSpec, 'denied'> & Partial<Pick<ProfileSpec, 'protectedWrites'>>,
  home: string,
  storeRoots: readonly string[] = []
): 'not-absolute' | 'home' | 'library' | 'store' | 'git' | 'shell' | 'denied' | null {
  if (!path.isAbsolute(root)) {
    return 'not-absolute'
  }

  const real = realOrSelf(root)
  const realHome = realOrSelf(home)

  if (real === path.parse(real).root || insideFolder(realHome, real)) {
    return 'home'
  }

  if (insideFolder(real, path.join(realHome, 'Library'))) {
    return 'library'
  }

  if (storeRoots.some(store => insideFolder(real, store))) {
    return 'store'
  }

  // fx7: a `.git` folder (its hooks run on the user's next commit) and the places the user's shell runs from
  // (`protectedWrites`: binary folders on PATH, shell startup files) are never a project, nor inside or around one.
  if (diskFold(real).split(path.sep).includes('.git')) {
    return 'git'
  }

  const around = (item: string) => within(real, item) || within(item, real) || insideFolder(real, item) || insideFolder(item, real)

  if ((spec.protectedWrites ?? []).some(around)) {
    return 'shell'
  }

  return spec.denied.some(denied => insideFolder(real, denied) || insideFolder(denied, real)) ? 'denied' : null
}
