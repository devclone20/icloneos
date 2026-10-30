/**
 * V3-B — the host side of a ported skill's `manifest.json`: read it from the bundle, evaluate `requires` against THIS
 * machine (names only: is `ffmpeg` on PATH, does `$RIDERVOICE_HOME` exist, which OS), and attach the result to the
 * skills catalog the renderer already reads (`iclone:skills-catalog`). Nothing here reads the owner's library or the
 * agent's config: an MCP requirement is reported as needed because the host cannot verify it.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import {
  parseSkillManifest,
  portAttribution,
  type SkillHost,
  type SkillManifest,
  type SkillPortInfo,
  unmetRequires
} from '../src/iclone-shared/skill-manifest'

import { POSIX_SANE_PATH_ENTRIES } from './backend-env'
import { hostOs, type SkillCatalog, type SkillCatalogEntry } from './iclone-skills-catalog'

const MANIFEST_FILE = 'manifest.json'

/** A catalog row plus the port facts when the folder carries a valid manifest. */
interface PortedSkillCatalogEntry extends SkillCatalogEntry {
  port?: SkillPortInfo
  /** Set when a manifest.json exists but fails the schema: the row stays, the problem is named. */
  manifestProblem?: string
}

export interface PortedSkillCatalog extends SkillCatalog {
  skills: PortedSkillCatalogEntry[]
}

/** `manifest.json` of one skill folder: null when absent, `{ problems }` when invalid. */
export function readSkillManifest(skillDir: string): { manifest: SkillManifest } | { problems: string[] } | null {
  let text: string

  try {
    text = readFileSync(path.join(skillDir, MANIFEST_FILE), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    return code === 'ENOENT' ? null : { problems: [`${MANIFEST_FILE} unreadable (${code})`] }
  }

  let raw: unknown

  try {
    raw = JSON.parse(text)
  } catch {
    return { problems: [`${MANIFEST_FILE} is not JSON`] }
  }

  const result = parseSkillManifest(raw, path.basename(skillDir))

  return result.ok ? { manifest: result.manifest } : { problems: result.problems }
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)

    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** The PATH the agent's shell sees: the process PATH plus the sane POSIX entries (a GUI launch on macOS lacks Homebrew). */
export function hostPathEntries(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string[] {
  const delimiter = platform === 'win32' ? ';' : ':'
  const own = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  const sane = platform === 'win32' ? [] : [...POSIX_SANE_PATH_ENTRIES]

  return [...new Set([...own, ...sane])]
}

/**
 * A `requires.paths` place as a path of this host: `~` / `~/…` under the home folder, and (K140 r2) a named place
 * `$NAME` / `$NAME/…` — a folder of the owner's machine a ported skill names by variable — under the value the host
 * gives NAME. An unset, empty or relative variable is no place (null): the skill then lists it as a need.
 */
export function expandPlace(target: string, { home, env }: { home: string; env: NodeJS.ProcessEnv }): string | null {
  if (target === '~') {
    return home
  }

  if (target.startsWith('~/')) {
    return path.join(home, target.slice(2))
  }

  const named = /^\$([A-Za-z_][A-Za-z0-9_]*)(\/.*)?$/.exec(target)

  if (named) {
    const value = env[named[1]]

    return value && path.isAbsolute(value) ? path.join(value, named[2] ?? '') : null
  }

  return target
}

/** The real host, as the pure evaluator sees it. `mcp` stays null: the host cannot verify an MCP server by itself. */
export function realSkillHost(
  options: {
    env?: NodeJS.ProcessEnv
    platform?: string
    home?: string
  } = {}
): SkillHost {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const entries = hostPathEntries(options.env ?? process.env, platform)
  const binCache = new Map<string, boolean>()

  return {
    os: hostOs(platform),
    hasBin: name => {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        return false
      }

      const cached = binCache.get(name)

      if (cached !== undefined) {
        return cached
      }

      const found = entries.some(dir => executable(path.join(dir, name)))

      binCache.set(name, found)

      return found
    },
    hasPath: target => {
      const expanded = expandPlace(target, { home, env: options.env ?? process.env })

      return expanded !== null && path.isAbsolute(expanded) && existsSync(expanded)
    },
    mcp: null
  }
}

/** The catalog with `port` (or `manifestProblem`) on every row whose bundle folder carries a manifest. */
export function attachSkillRequirements(
  catalog: SkillCatalog,
  sourceDir: string,
  host: SkillHost = realSkillHost()
): PortedSkillCatalog {
  const skills = catalog.skills.map((entry): PortedSkillCatalogEntry => {
    const read = readSkillManifest(path.join(sourceDir, entry.name))

    if (!read) {
      return entry
    }

    if ('problems' in read) {
      return { ...entry, manifestProblem: read.problems.join('; ') }
    }

    const { manifest } = read
    const attribution = portAttribution(manifest)

    return {
      ...entry,
      port: {
        version: manifest.version,
        portedAt: manifest.source.ported_at,
        requires: manifest.requires,
        touches: manifest.touches,
        needs: unmetRequires(manifest.requires, host),
        ...(attribution ? { attribution } : {})
      }
    }
  })

  return { ...catalog, skills }
}
