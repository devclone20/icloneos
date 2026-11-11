/**
 * What a confined probe's outcome proves. An exit code alone cannot say: a killed probe, a failed spawn and a missing
 * target all exit non-zero, and would read as a refusal. Seatbelt answers ENOENT for a denied path that does not exist
 * and EPERM once it does, so only the kernel's own denial, on a target the unconfined control proved, counts.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const KERNEL_DENIAL = 'Operation not permitted'
const THROWAWAY_HOME = /^\/(private\/)?(tmp|var\/folders)\/./

export interface ProbeOutcome {
  code: number | null
  out: string
  pid?: number
}

export type ProbeVerdict = 'refused' | `allowed: ${string}` | `did-not-run: ${string}`

/**
 * `silent` is for the few tools that exit non-zero on a denial and print nothing (pbpaste, nc -U). There the same
 * command succeeding unconfined right before is the only proof the failure is the sandbox's: such a row must have it.
 */
export function probeVerdict(outcome: ProbeOutcome, denial: 'observed' | 'silent' = 'observed'): ProbeVerdict {
  const said = outcome.out.trim().slice(0, 200)

  if (outcome.code === null) {
    return outcome.pid === 0 ? `did-not-run: spawn failed: ${said}` : `did-not-run: killed before it exited: ${said}`
  }

  if (outcome.code === 0) {
    return `allowed: ${said}`
  }

  if (denial === 'silent' || outcome.out.includes(KERNEL_DENIAL)) {
    return 'refused'
  }

  return `did-not-run: exit ${outcome.code} with no kernel denial: ${said}`
}

/** Files read through HOME by the live confinement tests. Comments only: some are config files other tools may parse. */
const HOME_DECOYS = [
  '.aws/credentials',
  '.config/decoy',
  '.docker/decoy',
  '.gitconfig',
  '.gnupg/pubring.kbx',
  '.kube/decoy',
  '.npmrc',
  '.ssh/id_decoy',
  '.zsh_history',
  '.zshrc',
  'Desktop/decoy.txt',
  'Documents/decoy.txt',
  'Downloads/decoy.txt',
  'Library/Keychains/login.keychain-db',
  'Library/LaunchAgents/decoy',
  'Library/Mail/decoy',
  'Library/Messages/decoy'
] as const

/** The HOME of this run, or a throw: the live tests write decoys under it, which must never reach a real home. */
export function requireThrowawayHome(): string {
  const home = realpathSync(os.homedir())

  if (home === realpathSync(os.userInfo().homedir) || !THROWAWAY_HOME.test(home)) {
    throw new Error(`refusing to run the live confinement tests with a real HOME (${home}): run them through iso_env`)
  }

  return home
}

/** Test files in one run share HOME, so a decoy may already be there: it is kept, never rewritten. */
export function plantHomeDecoys(): void {
  const home = requireThrowawayHome()

  for (const decoy of HOME_DECOYS) {
    const file = path.join(home, decoy)

    mkdirSync(path.dirname(file), { recursive: true })

    if (!`${realpathSync(path.dirname(file))}/`.startsWith(`${home}/`)) {
      throw new Error(`refusing to plant ${decoy}: its folder resolves outside ${home}`)
    }

    try {
      writeFileSync(file, `# DECOY-${path.basename(decoy)}\n`, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
  }
}
