/**
 * v0.0.9 W1b — the HERMES_HOME of the profile the agent actually runs as, for the repair kit.
 *
 * The backend is spawned with the root HERMES_HOME plus `--profile <slug>` (start-hermes.ts `spawnProfile`), and a
 * `--profile` run reads `<root>/profiles/<slug>` (update-runtime-align.ts `profileHermesHome`). The kit must look where
 * THAT agent keeps its install state — never assume `~/.hermes`, never assume the root profile. Same two functions the
 * spawn uses, so the kit and the spawn cannot disagree. Pure apart from reading the sticky `active_profile` file the
 * way Hermes reads it (never written).
 */
import { spawnProfile } from '../iclone-x402/spawn-profile'
import { profileHermesHome } from '../update-runtime-align'

export function activeProfileHermesHome(
  rootHermesHome: string,
  desktopProfile: null | string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
): string {
  const runsAs = spawnProfile(desktopProfile, { hermesHome: rootHermesHome, ...options })

  return profileHermesHome(rootHermesHome, runsAs.slug)
}
