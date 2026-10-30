/**
 * V3-B — two small, data-driven readings of the desktop slash table that need no new spec rows.
 *
 * 1. The fence. `commands.catalog` lists every registry command in a CATEGORY (skills and quick commands ride along
 *    uncategorised) and maps every alias to its canonical name (`canon`). A categorised command the desktop has no
 *    spec for is a backend built-in with no desktop surface (the runtime's terminal-only verbs: its petdex, its
 *    palette, …): it is never offered, never completed and never sent to the slash worker. The names are read from
 *    the backend at run time, so the app carries none of them, and a verb the runtime adds tomorrow is fenced the
 *    day it appears.
 * 2. Advertised aliases. An alias stays hidden from the popover (no duplicate rows), but a few are worth a word on
 *    the canonical row — `/compress · also /compact`. The list here is checked against the spec's real aliases, so a
 *    retired alias can never be advertised.
 */
import { type CommandsCatalogLike, resolveDesktopCommand } from './desktop-slash-commands'

interface CatalogWithCanon extends CommandsCatalogLike {
  /** `alias → canonical`, lower-cased keys, from the gateway (absent on older backends). */
  canon?: Record<string, string>
}

const lower = (command: string) => command.trim().toLowerCase()

/** The categorised backend commands (and their aliases) the desktop has no spec for. */
export function fencedBackendCommands(catalog: CommandsCatalogLike | null | undefined): ReadonlySet<string> {
  const fenced = new Set<string>()

  if (!catalog?.categories?.length) {
    return fenced
  }

  for (const section of catalog.categories) {
    for (const [command] of section.pairs) {
      if (!resolveDesktopCommand(command)) {
        fenced.add(lower(command))
      }
    }
  }

  const canon = (catalog as CatalogWithCanon).canon

  if (canon) {
    for (const [alias, canonical] of Object.entries(canon)) {
      if (fenced.has(lower(canonical)) && !resolveDesktopCommand(alias)) {
        fenced.add(lower(alias))
      }
    }
  }

  return fenced
}

/** True when `command` (name or alias) is a backend built-in with no desktop surface, per the given catalog. */
export function isFencedBackendCommand(command: string, catalog: CommandsCatalogLike | null | undefined): boolean {
  const name = lower(command)

  return fencedBackendCommands(catalog).has(name.startsWith('/') ? name : `/${name}`)
}

/** Aliases worth a word on the popover row. Only real aliases of the spec are ever shown. */
const ADVERTISED_ALIASES: Readonly<Record<string, readonly string[]>> = {
  '/compress': ['/compact']
}

export function desktopSlashAlsoKnownAs(command: string): string[] {
  const spec = resolveDesktopCommand(command)

  if (!spec) {
    return []
  }

  const real = new Set(spec.aliases ?? [])

  return (ADVERTISED_ALIASES[spec.name] ?? []).filter(alias => real.has(alias))
}
