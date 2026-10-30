import { formatNeeds, type SkillPortInfo } from '@/iclone-shared/skill-manifest'
import { formatAgo, HOUR_MS } from '@/iclone-shared/time'
import type { SkillInfo } from '@/types/hermes'

/** Mirror of electron/iclone-skills-catalog.ts `SkillCatalog` (derived from the bundled SKILL.md files at read time). */
interface SkillCatalogEntry {
  name: string
  version: string
  description: string
  whenToOpen: string
  tags: string[]
  relatedSkills: string[]
  /** Frontmatter `platforms`, lowercase; [] or missing = every OS. */
  platforms?: string[]
  /** Set when the SKILL.md frontmatter could not be read (the folder is still synced and taught). */
  problem?: string
  /** V3-B: a skill ported from the owner's library — its manifest facts, `needs` evaluated on this host. */
  port?: SkillPortInfo
  /** V3-B: a manifest.json that fails the schema (the row stays; the problem is named). */
  manifestProblem?: string
}

export interface SkillCatalog {
  schema: number
  category: string
  count: number
  skills: SkillCatalogEntry[]
  /** The OS the app runs on (`macos` | `linux` | `windows`). */
  host?: string
}

const OS_ALIAS: Record<string, string> = { darwin: 'macos', win32: 'windows' }
const OS_LABELS: Record<string, string> = { macos: 'macOS', linux: 'Linux', windows: 'Windows' }

export function osLabel(os: string): string {
  return OS_LABELS[OS_ALIAS[os] ?? os] ?? os
}

/** Hermes' platform rule (skill_matches_platform): a skill whose `platforms` exclude the host never reaches its agents. */
export function hiddenOnHost(entry: SkillCatalogEntry, host: string | undefined): boolean {
  const platforms = entry.platforms ?? []

  return Boolean(host) && platforms.length > 0 && !platforms.some(item => (OS_ALIAS[item] ?? item) === host)
}

type SkillGroupId = 'iclone' | 'upstream' | 'learned' | 'hub'

const SKILL_GROUPS: readonly SkillGroupId[] = ['iclone', 'upstream', 'learned', 'hub']

/** Skills the app's own runtime instructions name: off, they break every iNFT's playbook. */
export const RUNTIME_SKILLS: readonly string[] = ['economyos', 'consent']

interface SkillRow {
  name: string
  group: SkillGroupId
  /** The when-to-open cue (catalog) or the description (everything else). */
  line: string
  enabled: boolean
  /** False for a bundled skill the agent's tree does not hold yet (before the first sync). */
  taught: boolean
  version?: string
  /** Catalog `related_skills`: the skills this one points agents to. */
  relatedSkills?: string[]
  /** Set when Hermes hides this bundled skill on the host OS: a Re-sync can never teach it here. */
  hiddenOn?: { host: string; only: string[] }
  /** The parser message when the bundled SKILL.md frontmatter could not be read. */
  problem?: string
  /** V3-B: port facts of a skill from the owner's library; `needs` names what this host lacks ([] = runs here). */
  port?: SkillPortInfo
  /** V3-B: the manifest.json beside this bundled skill fails the schema (the row stays; the problem is named). */
  manifestProblem?: string
}

type SkillGroups = Record<SkillGroupId, SkillRow[]>

/** A row whose frontmatter is unreadable has no cue: it reads "<name> · Frontmatter unreadable — <message>". */
const lineOf = (entry: SkillCatalogEntry) => (entry.problem ? entry.name : entry.whenToOpen)

/** Provenance is the app's own truth for its skills: the backend labels them "learned" (they are neither
 *  bundled with Hermes nor installed from the hub), so the catalog decides first. */
export function groupSkills(installed: readonly SkillInfo[], catalog: SkillCatalog | null): SkillGroups {
  const groups: SkillGroups = { iclone: [], upstream: [], learned: [], hub: [] }
  const ours = new Map((catalog?.skills ?? []).map(entry => [entry.name, entry]))
  const seen = new Set<string>()

  for (const skill of installed) {
    const entry = ours.get(skill.name)

    if (entry) {
      seen.add(skill.name)
      groups.iclone.push({
        name: skill.name,
        group: 'iclone',
        line: lineOf(entry),
        enabled: skill.enabled,
        taught: true,
        version: entry.version,
        relatedSkills: entry.relatedSkills,
        ...(entry.problem ? { problem: entry.problem } : {}),
        ...(entry.port ? { port: entry.port } : {}),
        ...(entry.manifestProblem ? { manifestProblem: entry.manifestProblem } : {})
      })

      continue
    }

    const group: SkillGroupId =
      skill.provenance === 'hub' ? 'hub' : skill.provenance === 'bundled' ? 'upstream' : 'learned'

    groups[group].push({ name: skill.name, group, line: skill.description, enabled: skill.enabled, taught: true })
  }

  for (const entry of ours.values()) {
    if (!seen.has(entry.name)) {
      const host = catalog?.host

      groups.iclone.push({
        name: entry.name,
        group: 'iclone',
        line: lineOf(entry),
        enabled: false,
        taught: false,
        version: entry.version,
        relatedSkills: entry.relatedSkills,
        ...(entry.problem ? { problem: entry.problem } : {}),
        ...(entry.port ? { port: entry.port } : {}),
        ...(entry.manifestProblem ? { manifestProblem: entry.manifestProblem } : {}),
        ...(host && hiddenOnHost(entry, host) ? { hiddenOn: { host, only: entry.platforms ?? [] } } : {})
      })
    }
  }

  for (const id of SKILL_GROUPS) {
    groups[id].sort((a, b) => a.name.localeCompare(b.name))
  }

  return groups
}

export function filterGroups(groups: SkillGroups, query: string): SkillGroups {
  const q = query.trim().toLowerCase()

  if (!q) {
    return groups
  }

  const keep = (rows: SkillRow[]) =>
    rows.filter(row => row.name.toLowerCase().includes(q) || row.line.toLowerCase().includes(q))

  return {
    iclone: keep(groups.iclone),
    upstream: keep(groups.upstream),
    learned: keep(groups.learned),
    hub: keep(groups.hub)
  }
}

/** True when turning `name` off needs the owner's explicit confirmation. */
export function warnsOnDisable(name: string): boolean {
  return RUNTIME_SKILLS.includes(name)
}

/** Strip the leading frontmatter block: the sheet shows the playbook, the meta row shows version + the live byte size. */
export function skillBody(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trimStart()
}

type OffWarning = { kind: 'runtime' } | { kind: 'untaught' } | { kind: 'related'; neededBy: string[] }

/** Skills that are ALREADY off yet still named — by the runtime instructions (economyos, consent) or as a
 *  related skill of an enabled skill — so the pane warns standing, not only at the moment of turning one off.
 *  A runtime-named skill missing from the agents' tree (sync failed or never ran) warns too: the runtime block
 *  names it either way. */
export function offWarnings(groups: SkillGroups): Map<string, OffWarning> {
  const rows = SKILL_GROUPS.flatMap(id => groups[id])
  const neededBy = new Map<string, string[]>()
  const out = new Map<string, OffWarning>()

  for (const row of rows) {
    if (row.enabled) {
      for (const target of row.relatedSkills ?? []) {
        neededBy.set(target, [...(neededBy.get(target) ?? []), row.name])
      }
    }
  }

  for (const row of rows) {
    if (row.hiddenOn) {
      continue
    }

    if (!row.taught && RUNTIME_SKILLS.includes(row.name)) {
      out.set(row.name, { kind: 'untaught' })
    } else if (row.taught && !row.enabled && RUNTIME_SKILLS.includes(row.name)) {
      out.set(row.name, { kind: 'runtime' })
    } else if (row.taught && !row.enabled && neededBy.has(row.name)) {
      out.set(row.name, { kind: 'related', neededBy: neededBy.get(row.name) ?? [] })
    }
  }

  return out
}

/** V3-B: the ported skills this host cannot run, as "name (what it lacks)" — for the standing subtitle line. */
export function needsLines(groups: SkillGroups): string[] {
  return groups.iclone
    .filter(row => row.port && row.port.needs.length > 0)
    .map(row => `${row.name} (${formatNeeds(row.port?.needs ?? [])})`)
}

/** V3-B (F8): the bundled skills whose manifest.json is invalid, as "name (problem)" — standing, never silent. */
export function manifestProblemLines(groups: SkillGroups): string[] {
  return groups.iclone.filter(row => row.manifestProblem).map(row => `${row.name} (${row.manifestProblem})`)
}

interface RowNoteCopy {
  needs: (names: string) => string
  manifestProblem: (message: string) => string
  by: (author: string, license: string) => string
}

/**
 * V3-B: what the Skills row itself says about a bundled skill — the port's attribution, what this host lacks, an
 * invalid manifest — so the facts sit on the row the user reads, not only in a page-level line.
 */
export function rowNotes(groups: SkillGroups, copy: RowNoteCopy): Map<string, string> {
  const notes = new Map<string, string>()

  for (const row of groups.iclone) {
    const parts = [
      row.port?.attribution ? copy.by(row.port.attribution.author, row.port.attribution.license) : '',
      row.port?.needs.length ? copy.needs(formatNeeds(row.port.needs)) : '',
      row.manifestProblem ? copy.manifestProblem(row.manifestProblem) : ''
    ].filter(Boolean)

    if (parts.length) {
      notes.set(row.name, parts.join(' · '))
    }
  }

  return notes
}

interface LastSyncCopy {
  neverSynced: string
  justNow: string
  lastSync: (when: string) => string
  minutesAgo: (n: number) => string
  hoursAgo: (n: number) => string
}

/** "Last sync 5 min ago" for the skills header; ages of a day or more stay in hours. */
export function lastSyncLabel(ms: number | undefined, copy: LastSyncCopy, now = Date.now()): string {
  if (!ms) {
    return copy.neverSynced
  }

  return copy.lastSync(
    formatAgo(
      ms,
      {
        now: copy.justNow,
        minutes: copy.minutesAgo,
        hours: copy.hoursAgo,
        days: () => copy.hoursAgo(Math.floor((now - ms) / HOUR_MS))
      },
      { nowMs: now }
    )
  )
}
