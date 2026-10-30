/**
 * V3-G §1 — the five activity classes as data. A profile names what a confined command may read, write and reach;
 * anything it does not name is refused (the SBPL starts from `(deny default)`, sbpl.ts). The per-spawn facts that
 * only the spawner knows (the project root, the scratch dir, whether the permission mode grants the network or
 * project writes) are SBPL parameters, so one generated file serves every session and is never hand-edited.
 */
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'

import { ACTIVITY_CLASSES, type ActivityClass } from '../../src/iclone-shared/confinement'
import { protectedPaths, secretPaths } from '../iclone-permissions/classify-policy'

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
const PROFILE_PARAMS = ['PROJECT_ROOT', 'SCRATCH', 'OUTPUT_DIR', 'NET', 'WRITE_PROJECT', 'MEMBER'] as const
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

const BASE_MACH = [
  'com.apple.bsd.dirhelper',
  'com.apple.logd',
  'com.apple.system.logger',
  'com.apple.system.notification_center',
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.opendirectoryd.membership'
]

const NET_MACH = [
  'com.apple.dnssd.service',
  'com.apple.mDNSResponder',
  'com.apple.SystemConfiguration.configd',
  'com.apple.SystemConfiguration.DNSConfiguration',
  'com.apple.networkd',
  'com.apple.trustd',
  'com.apple.trustd.agent'
]

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

/** Secrets under the home, denied whole. `Library/Keychains` is the keychain itself. */
const HOME_SECRETS = [
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
    protectedWrites: unique([...protectedPaths(policyPaths), paths.profilesDir, paths.membersDir].map(realOrSelf)),
    mach: BASE_MACH,
    netMach: NET_MACH,
    memberMark: realOrSelf(memberMarkFile(paths.membersDir))
  }
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
  spec: Pick<ProfileSpec, 'denied'>,
  home: string,
  storeRoots: readonly string[] = []
): boolean {
  if (!path.isAbsolute(root)) {
    return false
  }

  const real = realOrSelf(root)
  const realHome = realOrSelf(home)

  if (real === path.parse(real).root || insideFolder(realHome, real)) {
    return false
  }

  if (insideFolder(real, path.join(realHome, 'Library')) || storeRoots.some(store => insideFolder(real, store))) {
    return false
  }

  return !spec.denied.some(denied => insideFolder(real, denied) || insideFolder(denied, real))
}
