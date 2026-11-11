/**
 * Where "Replace with a copy" may never read from while the runtime is confined. The never list is the runtime profile's
 * own: the copy must not hand the agent what its sandbox refuses it. The writable roots are the folders a confined
 * runtime or its commands fill: a path inside one is not what the owner was shown by the time it is read.
 * A project folder is writable too but stays allowed: the agent could only copy its own text from there, into a home it
 * can already write, and a folder there flipped to a link is refused at the open (readPlainFileNoLinks).
 */
import path from 'node:path'

import type { HomeSettingsCopyGuard } from './home-settings-files'
import { BROWSER_PROFILES, buildAllProfileSpecs, type ConfinementPaths, HOME_SECRETS, realOrSelf } from './iclone-confinement/profiles'
import { runtimeTmpFolder } from './iclone-confinement/runtime-profile'
import { protectedPaths, secretPaths } from './iclone-permissions/classify-policy'

const realPattern = (item: string) =>
  item.includes('*') ? path.join(realOrSelf(path.dirname(item)), path.basename(item)) : realOrSelf(item)

export function homeSettingsCopyGuard(paths: ConfinementPaths): HomeSettingsCopyGuard {
  const policy = {
    hermesHome: paths.hermesHome,
    hermesRoot: paths.hermesRoot,
    home: paths.home,
    userDataDir: paths.userDataDir
  }

  // The same sources as runtimeNever, which resolves a name inside the agent's home first. Those names are the very links
  // being judged: following one would guard its target, whatever it is. The home itself is in runtimeWritable below.
  const outsideHome = (item: string) => !item.startsWith(path.join(paths.hermesHome, path.sep))

  return {
    neverCopied: [
      ...[...HOME_SECRETS, ...BROWSER_PROFILES].map(rel => path.join(paths.home, rel)),
      '/Library/Keychains',
      ...secretPaths(policy),
      ...protectedPaths(policy)
    ]
      .filter(outsideHome)
      .map(realPattern),
    runtimeWritable: [
      paths.hermesHome,
      paths.userDataDir,
      paths.profilesDir,
      paths.membersDir,
      paths.scratchRoot,
      runtimeTmpFolder(paths.scratchRoot),
      ...buildAllProfileSpecs(paths).flatMap(spec => spec.extraWrites)
    ].map(realOrSelf)
  }
}
