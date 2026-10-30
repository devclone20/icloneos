/**
 * V3-B — the words a popover row carries beyond its description: the advertised alias of a command
 * (`/compress · also /compact`), the library tag of a ported skill (`· from your library`) and what this machine
 * lacks for it (`· needs ffmpeg, MCP davinci-resolve`). Pure: the icloneOS catalog and the copy are handed in.
 */
import type { SlashTranslations } from '@/i18n/types/slash'
import { formatNeeds, type SkillNeed } from '@/iclone-shared/skill-manifest'
import { desktopSlashAlsoKnownAs } from '@/lib/desktop-slash-fence'

/** The part of the icloneOS skills catalog (`iclone:skills-catalog`) the popover reads. */
interface PortedSkillRow {
  name: string
  port?: { needs: readonly SkillNeed[] }
}

type PortedSkillMap = ReadonlyMap<string, { needs: readonly SkillNeed[] }>

/** `/name → port facts` for every catalog row that is a port; empty for a missing or older catalog. */
export function portedSkillMap(catalog: { skills?: readonly PortedSkillRow[] } | null | undefined): PortedSkillMap {
  const map = new Map<string, { needs: readonly SkillNeed[] }>()

  for (const row of catalog?.skills ?? []) {
    if (row.port) {
      map.set(`/${row.name}`.toLowerCase(), { needs: row.port.needs })
    }
  }

  return map
}

/** The row's meta with the V3-B words appended; unchanged when there is nothing to say. */
export function decorateSlashMeta(
  command: string,
  meta: string,
  options: { copy: SlashTranslations; ported: PortedSkillMap; group: string }
): string {
  const parts = [meta]

  if (options.group === 'Skills') {
    const port = options.ported.get(command.toLowerCase())

    if (port) {
      parts.push(options.copy.fromLibrary)

      if (port.needs.length) {
        parts.push(options.copy.needs(formatNeeds(port.needs)))
      }
    }
  } else {
    const also = desktopSlashAlsoKnownAs(command)

    if (also.length) {
      parts.push(options.copy.alsoKnownAs(also.join(', ')))
    }
  }

  return parts.filter(Boolean).join(' · ')
}
