/**
 * V3-F §1 — main's half of classification: the facts only main knows. Which paths are the policy itself (never
 * writable by the agent, floor 2/7), which are secrets (never readable for egress, floor 4), and how the consent
 * switches read as ceilings. The per-tool classifier lives in the Hermes plugin, which sees the call's arguments.
 */
import { existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { diskFold } from '../iclone-confinement/disk-name'
import { CONSENT_CAPABILITY_KEYS, type ConsentRecord } from '../iclone-consent'

import { type Ceiling, CREDENTIAL_READ_FLOOR } from './modes'

export interface PolicyPathsInput {
  userDataDir: string
  hermesHome: string
  home: string
  /** The Hermes checkout the backend runs from: its gate code is the confinement (floor 7). */
  hermesRoot: string | null
}

/**
 * Never-acceptable writes (floors 2 + 7): the permission authority (mode, grants, policy, audit, keys), the consent
 * record, the payments store (V3-J), the agent socket, Hermes' approval config and secrets file, every Hermes plugin (a plugin is code inside the
 * gate's process) and the WHOLE Hermes checkout the gate runs in — every `tools/*.py`, `tui_gateway/`, the parser
 * floor 3 relies on, every bundled plugin and the venv under it (critic r2 M3). Code there changes by an update, never
 * by the agent. The plugin adds its spool and stats folders and the interpreter prefix / site-packages it runs from.
 */
export function protectedPaths(input: PolicyPathsInput): string[] {
  return [
    path.join(input.userDataDir, 'permissions'),
    path.join(input.userDataDir, 'consent.json'),
    path.join(input.userDataDir, 'run'),
    // V3-G's confinement profiles and state (floor 7: the agent never edits its own sandbox).
    path.join(input.userDataDir, 'confinement'),
    // V3-J's payments: the ledger and its head, the STOP file, the settings, the sealed keys and the mandates. A
    // writer there could re-chain the ledger to free a day's cap, delete STOP or widen its own allowlist (floor 2).
    path.join(input.userDataDir, 'payments'),
    path.join(input.hermesHome, 'config.yaml'),
    path.join(input.hermesHome, '.env'),
    path.join(input.hermesHome, 'plugins'),
    path.join(input.hermesHome, 'iclone-perm-spool'),
    path.join(input.hermesHome, 'iclone-perm-stats'),
    // K98: V3-I's work state (ledger, interim audit chain and its MAC key) and V3-G's run-membership tokens. Deleting
    // the first gives a fresh green chain; forging the second puts a process outside the sandbox's own accounting.
    path.join(input.userDataDir, 'acp-work'),
    confinementMembersDir(input.home),
    ...(input.hermesRoot ? [input.hermesRoot] : [])
  ]
}

/**
 * Never-acceptable reads for egress (floor 4). `*` matches within one path segment. V3-J (fix JM2): the payments keys
 * (the sealed pocket and owner-mandate keys, the agents' cnf keys), the signed mandates and every spawn's pay-socket
 * token. The ledger, settings and STOP stay readable (they hold no secret; writes to all of payments are floor 2).
 */
export function secretPaths(input: PolicyPathsInput): string[] {
  return [
    path.join(input.home, '.ssh', 'id_*'),
    path.join(input.hermesHome, 'auth.json'),
    path.join(input.hermesHome, '.env'),
    path.join(input.home, 'Library', 'Keychains'),
    path.join(input.userDataDir, 'run', 'acp.token'),
    path.join(input.userDataDir, 'run', 'pay-*.token'),
    path.join(input.userDataDir, 'payments', 'keys'),
    path.join(input.userDataDir, 'payments', 'mandates')
  ]
}

// G25: equal to agent/file_safety.py (HOME_CREDENTIAL_DIRS + HOME_ASK_DIRS, the one-name files + HOME_ASK_FILES); a test compares them.
const HOME_CREDENTIAL_DIRS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.azure',
  '.config/gh',
  '.config/gcloud',
  'Library/Keychains',
  '.local/share/keyrings',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Google/Chrome Canary',
  'Library/Application Support/Chromium',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Microsoft Edge',
  'Library/Application Support/Arc',
  'Library/Application Support/Vivaldi',
  'Library/Application Support/com.operasoftware.Opera',
  'Library/Application Support/Firefox',
  'Library/Safari',
  'Library/Cookies',
  '.mozilla',
  '.config/google-chrome',
  '.config/chromium',
  '.config/fish',
  '.config/git',
  'Library/LaunchAgents'
]

const HOME_CREDENTIAL_FILES = [
  '.netrc',
  '.pgpass',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.zshenv',
  '.zprofile',
  '.zshrc',
  '.zlogin',
  '.zlogout',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.kshrc',
  '.cshrc',
  '.tcshrc',
  '.gitconfig'
]

export const CREDENTIAL_WRITE_FLOOR = 'secrets: writing a file your shell, git or launchd runs, or a key'

const realHome = (home: string): string => {
  try {
    return realpathSync(home)
  } catch {
    return home
  }
}

/**
 * G24: a grant keys on the class alone, so it must not open the file tools' credential list (agent/file_safety.py) with
 * no sheet where the Seatbelt is off. Main judges this itself: the floor on the call is the runtime's own word. A name is
 * judged as the home's disk reads it (`diskFold`). `target` joins a patch's files with ", ", so a split can only ask more, never less.
 */
export function credentialWriteFloor(tool: string, target: string, home: string): string | null {
  if (tool !== 'write_file' && tool !== 'patch') {
    return null
  }

  return target.split(', ').some(part => onCredentialList(part, home)) ? CREDENTIAL_WRITE_FLOOR : null
}

/**
 * G28: with the Seatbelt on the kernel and the one-file route stand before these files. With it off this floor is all there
 * is, for a file on the list and for the folder a search starts in. Mirror of classify.py _credential_read_needs_an_ask.
 */
export function credentialReadFloor(tool: string, target: string, home: string, seatbeltOff: () => boolean): string | null {
  return (tool === 'read_file' || tool === 'search_files') && seatbeltOff() && onCredentialList(target, home)
    ? CREDENTIAL_READ_FLOOR
    : null
}

/** G102: the file a link names, as the runtime's is_home_credential_path reads it (realpath where the target, or its folder, exists). */
const realTarget = (target: string): string => {
  try {
    return realpathSync(target)
  } catch {
    try {
      return path.join(realpathSync(path.dirname(target)), path.basename(target))
    } catch {
      return target
    }
  }
}

const onCredentialList = (target: string, home: string): boolean =>
  [target, realTarget(target)].some(spelling => onCredentialListAsWritten(spelling, home))

const onCredentialListAsWritten = (target: string, home: string): boolean => {
  const file = diskFold(target).replace(/(.)\/+$/, '$1')

  const under = (base: string, name: string) => path.join(base, diskFold(name))

  return [home, realHome(home)].map(diskFold).some(
    base =>
      HOME_CREDENTIAL_FILES.some(name => file === under(base, name)) ||
      HOME_CREDENTIAL_DIRS.some(name => file === under(base, name) || file.startsWith(under(base, name) + path.sep))
  )
}

/** Each capability switch as a ceiling: ON lets the mode decide, OFF refuses, absent is undecided. */
export function ceilingsFrom(record: ConsentRecord | null): Record<string, Ceiling> {
  return Object.fromEntries(
    CONSENT_CAPABILITY_KEYS.map(key => {
      const on = record?.permissions[key]

      return [key, on === true ? 'on' : on === false ? 'off' : 'undecided']
    })
  )
}

const insideOrAt = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)

/** K-RT9: where the walk stops — the home folder and HERMES_HOME (the plugin also stops at its runtime root). */
function walkCeilings(): string[] {
  const home = os.homedir()
  const out: string[] = []

  for (const raw of [home, process.env.HERMES_HOME || path.join(home, '.hermes')]) {
    try {
      out.push(realpathSync(raw))
    } catch {
      out.push(path.resolve(raw))
    }
  }

  return out
}

/**
 * §1 "Project": the realpath of the git root above `dir`, else `dir` itself — the plugin's `project_root`, same rule.
 * K-RT9: the walk never reaches the home folder (a home under version control must not make every folder in it one
 * project) and never goes above HERMES_HOME.
 */
export function projectRootOf(dir: string, ceilings: readonly string[] = walkCeilings()): string | null {
  let here: string

  try {
    here = realpathSync(dir)
  } catch {
    return null
  }

  const home = ceilings[0]
  const bounds = ceilings.filter(ceiling => insideOrAt(here, ceiling))

  for (let at = here; ; at = path.dirname(at)) {
    const above = bounds.some(bound => at !== bound && insideOrAt(bound, at))

    if (above || (at !== here && at === home && insideOrAt(here, home))) {
      return here
    }

    if (existsSync(path.join(at, '.git'))) {
      return at
    }

    if (path.dirname(at) === at) {
      return here
    }
  }
}

/** V3-G's run-membership tokens: outside userData (the confined profiles deny userData whole), owned by main only. */
export function confinementMembersDir(home: string): string {
  return path.join(home, 'Library', 'Caches', 'iclone-os-confinement', 'members')
}
