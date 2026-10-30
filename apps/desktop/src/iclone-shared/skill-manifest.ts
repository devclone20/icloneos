/**
 * V3-B — the manifest a ported owner skill carries (`iclone/skills/<name>/manifest.json`, written by
 * scripts/port-owner-skills.mjs) and the pure evaluation of its `requires` against a host.
 *
 * Shared by the main process (which evaluates on the real host and attaches the result to the skills catalog) and the
 * renderer (which only formats). No I/O here: the host is handed in as predicates, so a test can be the host.
 */

const SKILL_MANIFEST_SCHEMA = 1

/** V3-F action classes (contracts/V3F_permission_modes.md §1): what a skill's steps reach for. */
const SKILL_ACTION_CLASSES = ['R', 'Wp', 'Wo', 'X', 'N', '$', 'M', 'S', 'I', 'D'] as const

type SkillActionClass = (typeof SKILL_ACTION_CLASSES)[number]

interface SkillRequires {
  /** `macos` | `linux` | `windows`; [] = any. */
  os: string[]
  /** Executables that must be on PATH, by name. */
  bins: string[]
  /** MCP servers the skill drives, by name (a host cannot verify these without the agent's config: reported as needed). */
  mcp: string[]
  /**
   * Folders or apps that must exist (`~/…` = the user's home). A list inside the list is ONE need met by any of its
   * places (a script's fallback: the engine's new place or its old one).
   */
  paths: (string | string[])[]
}

/** Where a third-party skill comes from (lead ruling F1): its true author is never "the owner". */
interface SkillUpstream {
  name: string
  url?: string
  license_file?: string
  /** The upstream copyright lines, verbatim from its licence text. */
  copyright?: string[]
}

/** A name the scrub would otherwise question, kept by the owner's recorded decision. */
interface SkillWaiver {
  kept: string
  reason: string
}

export interface SkillManifest {
  schema: number
  name: string
  /** The port version (bumped on every re-port); the source's own version, when it has one, is `source.version`. */
  version: string
  author?: string
  license?: string
  upstream?: SkillUpstream
  source: { library: string; path: string; version?: string | null; sha256: string; ported_at: string }
  /** Source files left out of the port on purpose (a private reference), names only. */
  excluded?: string[]
  waivers?: SkillWaiver[]
  requires: SkillRequires
  touches: SkillActionClass[]
  scrubbed: true
}

const OWNER_WORD = 'the owner'

type SkillManifestResult = { ok: true; manifest: SkillManifest } | { ok: false; problems: string[] }

const SEMVER = /^\d+\.\d+\.\d+$/
const SHA256 = /^[0-9a-f]{64}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0)

/** `requires.paths`: names, or a list of two or more alternative names. */
const pathList = (value: unknown): value is (string | string[])[] =>
  Array.isArray(value) &&
  value.every(item =>
    Array.isArray(item) ? item.length >= 2 && stringList(item) : typeof item === 'string' && item.trim().length > 0
  )

/** Schema check of one manifest.json (parsed). Every problem is named; a valid manifest comes back typed. */
export function parseSkillManifest(raw: unknown, expectedName?: string): SkillManifestResult {
  const problems: string[] = []

  if (!isRecord(raw)) {
    return { ok: false, problems: ['manifest is not an object'] }
  }

  if (raw.schema !== SKILL_MANIFEST_SCHEMA) {
    problems.push(`schema ${String(raw.schema)} ≠ ${SKILL_MANIFEST_SCHEMA}`)
  }

  if (typeof raw.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.name)) {
    problems.push('name missing or not a skill name')
  } else if (expectedName && raw.name !== expectedName) {
    problems.push(`name "${raw.name}" differs from the folder "${expectedName}"`)
  }

  if (typeof raw.version !== 'string' || !SEMVER.test(raw.version)) {
    problems.push('version is not MAJOR.MINOR.PATCH')
  }

  const source = raw.source

  if (!isRecord(source)) {
    problems.push('source missing')
  } else {
    if (typeof source.library !== 'string' || !source.library) {
      problems.push('source.library missing')
    }

    if (typeof source.path !== 'string' || !source.path) {
      problems.push('source.path missing')
    }

    if (typeof source.sha256 !== 'string' || !SHA256.test(source.sha256)) {
      problems.push('source.sha256 is not sha256 hex')
    }

    if (typeof source.ported_at !== 'string' || Number.isNaN(Date.parse(source.ported_at))) {
      problems.push('source.ported_at is not a date')
    }

    if (source.version !== undefined && source.version !== null && typeof source.version !== 'string') {
      problems.push('source.version is not a string')
    }
  }

  if (raw.author !== undefined && (typeof raw.author !== 'string' || !raw.author.trim())) {
    problems.push('author is not a name')
  }

  if (raw.license !== undefined && (typeof raw.license !== 'string' || !raw.license.trim())) {
    problems.push('license is not a name')
  }

  if (raw.excluded !== undefined && !stringList(raw.excluded)) {
    problems.push('excluded is not a list of paths')
  }

  // A third-party skill (one that names an upstream) must carry its true author and a licence; the owner's name
  // on someone else's work is the defect the ruling closes, so the schema itself refuses it.
  if (raw.upstream !== undefined) {
    if (!isRecord(raw.upstream) || typeof raw.upstream.name !== 'string' || !raw.upstream.name.trim()) {
      problems.push('upstream names no source')
    }

    if (typeof raw.author !== 'string' || !raw.author.trim() || raw.author.trim().startsWith(OWNER_WORD)) {
      problems.push('a third-party skill must name its true author (never the owner)')
    }

    if (typeof raw.license !== 'string' || !raw.license.trim()) {
      problems.push('a third-party skill must name its licence')
    }

    if (isRecord(raw.upstream) && raw.upstream.copyright !== undefined) {
      const lines = raw.upstream.copyright

      if (!Array.isArray(lines) || !lines.every(line => typeof line === 'string' && line.trim().length > 0)) {
        problems.push('upstream.copyright is not a list of lines')
      }
    }
  }

  if (
    raw.waivers !== undefined &&
    !(
      Array.isArray(raw.waivers) &&
      raw.waivers.every(
        waiver =>
          isRecord(waiver) &&
          typeof waiver.kept === 'string' &&
          waiver.kept.trim().length > 0 &&
          typeof waiver.reason === 'string' &&
          waiver.reason.trim().length > 0
      )
    )
  ) {
    problems.push('waivers is not a list of { kept, reason }')
  }

  const requires = raw.requires

  if (!isRecord(requires)) {
    problems.push('requires missing')
  } else {
    for (const key of ['os', 'bins', 'mcp'] as const) {
      if (!stringList(requires[key])) {
        problems.push(`requires.${key} is not a list of names`)
      }
    }

    if (!pathList(requires.paths)) {
      problems.push('requires.paths is not a list of places (or of two or more alternative places)')
    }
  }

  if (
    !Array.isArray(raw.touches) ||
    !raw.touches.every(cls => (SKILL_ACTION_CLASSES as readonly unknown[]).includes(cls))
  ) {
    problems.push(`touches must be a list of ${SKILL_ACTION_CLASSES.join('|')}`)
  }

  if (raw.scrubbed !== true) {
    problems.push('scrubbed is not true')
  }

  return problems.length ? { ok: false, problems } : { ok: true, manifest: raw as unknown as SkillManifest }
}

/** What a host can answer about itself. `mcp` null = cannot tell (every MCP requirement is then reported). */
export interface SkillHost {
  os: string
  hasBin: (name: string) => boolean
  hasPath: (path: string) => boolean
  mcp: ReadonlySet<string> | null
}

export interface SkillNeed {
  kind: 'os' | 'bin' | 'mcp' | 'path'
  name: string
}

/** The unmet requirements on this host, in manifest order. Empty = the skill can run here. */
export function unmetRequires(requires: SkillRequires, host: SkillHost): SkillNeed[] {
  const needs: SkillNeed[] = []

  if (requires.os.length && !requires.os.includes(host.os)) {
    needs.push({ kind: 'os', name: requires.os.join('/') })
  }

  for (const bin of requires.bins) {
    if (!host.hasBin(bin)) {
      needs.push({ kind: 'bin', name: bin })
    }
  }

  for (const server of requires.mcp) {
    if (!host.mcp || !host.mcp.has(server)) {
      needs.push({ kind: 'mcp', name: server })
    }
  }

  for (const p of requires.paths) {
    const places = Array.isArray(p) ? p : [p]

    if (!places.some(place => host.hasPath(place))) {
      needs.push({ kind: 'path', name: places.join(' or ') })
    }
  }

  return needs
}

/** `needs ffmpeg, MCP davinci-resolve, $RIDERVOICE_HOME` — one short clause, names only. */
export function formatNeeds(needs: readonly SkillNeed[]): string {
  return needs
    .map(need => (need.kind === 'mcp' ? `MCP ${need.name}` : need.kind === 'os' ? `${need.name} only` : need.name))
    .join(', ')
}

/** The port facts the catalog carries for a ported skill (attached by the main process at read time). */
export interface SkillPortInfo {
  version: string
  portedAt: string
  requires: SkillRequires
  touches: SkillActionClass[]
  /** Unmet on this host, names only; [] = runs here. */
  needs: SkillNeed[]
  /** Third-party work: who wrote it and under what licence (absent for the owner's own skills). */
  attribution?: { author: string; license: string; upstream: string }
}

/** `by Rodrigo Lopes (MIT)` for a third-party port; null for the owner's own skill. */
export function portAttribution(manifest: SkillManifest): SkillPortInfo['attribution'] | undefined {
  if (!manifest.upstream || !manifest.author || !manifest.license) {
    return undefined
  }

  return { author: manifest.author, license: manifest.license, upstream: manifest.upstream.name }
}
