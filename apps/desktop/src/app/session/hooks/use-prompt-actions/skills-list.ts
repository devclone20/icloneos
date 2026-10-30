/**
 * V3-B — the `/skills` output: every skill the agent can open, grouped, one line each. The icloneOS bundle (the
 * catalog the main process derives, with the port facts of the owner's skills) comes first; the rest is what the
 * backend lists, by origin. A ported skill the host cannot run says what it lacks; one the agent has not loaded yet
 * says so (Hermes reads skills when its backend starts — R4). Pure text, no React.
 */
import type { SlashTranslations } from '@/i18n/types/slash'
import { formatNeeds, type SkillNeed } from '@/iclone-shared/skill-manifest'
import type { CommandsCatalogLike } from '@/lib/desktop-slash-commands'
import { isDesktopSlashExtensionCommand } from '@/lib/desktop-slash-commands'

interface SkillsListCatalogRow {
  name: string
  whenToOpen: string
  problem?: string
  port?: { needs: readonly SkillNeed[]; attribution?: { author: string; license: string } }
  /** A manifest.json beside the skill that fails the schema (F8: named, never silent). */
  manifestProblem?: string
}

interface SkillsListInput {
  /** The backend's `commands.catalog` (skills ride in `pairs` + `skills`). */
  catalog: CommandsCatalogLike
  /** The icloneOS bundle catalog from `iclone:skills-catalog`; null when the bridge is absent (web shim). */
  iclone: { skills: readonly SkillsListCatalogRow[] } | null
  copy: SlashTranslations
}

interface Line {
  command: string
  text: string
}

const PAD = 22

function line(command: string, text: string): Line {
  return { command, text }
}

function section(title: string, lines: readonly Line[]): string[] {
  if (!lines.length) {
    return []
  }

  return [`${title}:`, ...lines.map(({ command, text }) => `${command.padEnd(PAD)} ${text}`.trimEnd()), '']
}

/** The grouped list, ready for the transcript. */
export function renderSkillsList({ catalog, iclone, copy }: SkillsListInput): string {
  const backendMeta = new Map<string, string>()

  for (const [command, meta] of catalog.pairs ?? []) {
    if (isDesktopSlashExtensionCommand(command)) {
      backendMeta.set(command.toLowerCase(), meta)
    }
  }

  const ported: Line[] = []
  const bundle: Line[] = []
  const seen = new Set<string>()
  let unavailable = 0

  for (const row of [...(iclone?.skills ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
    const command = `/${row.name}`
    const loaded = backendMeta.has(command.toLowerCase())
    const notes: string[] = []

    seen.add(command.toLowerCase())

    if (row.port?.attribution) {
      notes.push(copy.by(row.port.attribution.author, row.port.attribution.license))
    }

    if (row.port?.needs.length) {
      unavailable += 1
      notes.push(copy.needs(formatNeeds(row.port.needs)))
    }

    if (row.manifestProblem) {
      notes.push(copy.manifestProblem(row.manifestProblem))
    }

    if (!loaded) {
      notes.push(copy.skillsRestartNote)
    }

    const text = [row.problem ? row.name : row.whenToOpen, ...notes].filter(Boolean).join(' · ')

    ;(row.port ? ported : bundle).push(line(command, text))
  }

  const byOrigin: Record<'local' | 'bundled' | 'hub' | 'other', Line[]> = { local: [], bundled: [], hub: [], other: [] }

  for (const [command, meta] of [...backendMeta].sort(([a], [b]) => a.localeCompare(b))) {
    if (seen.has(command)) {
      continue
    }

    const origin = catalog.skills?.[command]?.origin

    byOrigin[origin === 'local' || origin === 'bundled' || origin === 'hub' ? origin : 'other'].push(
      line(command, meta)
    )
  }

  const total = ported.length + bundle.length + Object.values(byOrigin).reduce((sum, rows) => sum + rows.length, 0)

  if (!total) {
    return copy.skillsEmpty
  }

  const body = [
    ...section(copy.groupPorted, ported),
    ...section(copy.groupIclone, bundle),
    ...section(copy.groupLearned, byOrigin.local),
    ...section(copy.groupUpstream, byOrigin.bundled),
    ...section(copy.groupHub, byOrigin.hub),
    ...section(copy.groupOther, byOrigin.other)
  ]

  const tail = [copy.skillsFooter(total), unavailable ? copy.skillsUnavailable(unavailable) : ''].filter(Boolean)

  return [`${copy.skillsTitle}`, '', ...body, ...tail].join('\n').trimEnd()
}
