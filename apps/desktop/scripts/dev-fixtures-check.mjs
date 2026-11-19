// v0.0.9 r4d (eng r4-m2): the dev/test fixture art (apps/desktop/fixtures/inft-art, electron/fixture-wallet.ts) never
// ships. package.json build.files keeps it out by construction; this is the check on the PACKED app itself, run by
// after-pack.mjs before signing: no `fixtures/` entry inside app.asar, and none anywhere in Resources (an
// extraResources / extraFiles entry, root or per platform, would land there).
import fs from 'node:fs'
import path from 'node:path'

import asar from '@electron/asar'

/** The packed-app paths (posix, relative) that are dev fixtures: a top-level `fixtures/` folder or the art folder. */
export function isDevFixturePath(rel) {
  const parts = rel.split(/[\\/]+/).filter(Boolean)

  return parts[0] === 'fixtures' || parts.some((part, i) => part === 'fixtures' && parts[i + 1] === 'inft-art')
}

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    const rel = path.relative(base, full).split(path.sep).join('/')

    if (entry.isDirectory()) {
      return [rel, ...walk(full, base)]
    }

    return [rel]
  })
}

/** Problems (strings) for a packed Resources folder: fixture paths in app.asar's listing or in the folder itself. */
export function packedDevFixtureLeaks(resourcesDir) {
  const problems = []
  const archive = path.join(resourcesDir, 'app.asar')

  if (fs.existsSync(archive)) {
    let listing

    try {
      listing = asar.listPackage(archive, { isPack: false })
    } catch (error) {
      problems.push(`app.asar could not be listed (${error instanceof Error ? error.message : String(error)})`)
      listing = []
    }

    for (const entry of listing) {
      const rel = entry.replace(/^[\\/]+/, '')

      if (isDevFixturePath(rel)) {
        problems.push(`app.asar carries a dev fixture: ${rel}`)
      }
    }
  }

  for (const rel of walk(resourcesDir)) {
    if (rel !== 'app.asar' && !rel.startsWith('app.asar.unpacked/') && isDevFixturePath(rel)) {
      problems.push(`Resources carries a dev fixture: ${rel}`)
    }

    if (rel.startsWith('app.asar.unpacked/') && isDevFixturePath(rel.slice('app.asar.unpacked/'.length))) {
      problems.push(`app.asar.unpacked carries a dev fixture: ${rel}`)
    }
  }

  return problems
}
