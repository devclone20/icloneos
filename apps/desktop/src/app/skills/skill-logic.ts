/**
 * Capabilities — the page's pure logic, with no React and no design in it.
 *
 * Everything here was lifted VERBATIM out of the old `index.tsx` when the page
 * was rebuilt on our own primitives (E3 decision #8): the filters, the sort
 * order and the frontmatter reader are the behaviour users already rely on, so
 * they move unchanged and keep their own tests. The only thing that could not
 * come across as-is is the row subtitle, which used to return JSX built from an
 * upstream `Badge`: it is split here into the DATA the subtitle shows
 * (`skillSubtitleParts`) and left for the view to draw with `IcPagePill`.
 */
import { isDesktopToolsetVisible } from '@/lib/desktop-toolsets'
import { normalize } from '@/lib/text'
import type { SkillInfo, ToolsetInfo } from '@/types/hermes'

import { asText, includesQuery, prettyName, toolNames, toolsetDisplayLabel } from '../settings/helpers'

export const usageOf = (skill: SkillInfo): number => (typeof skill.usage === 'number' ? skill.usage : 0)

export const categoryFor = (skill: SkillInfo): string => asText(skill.category) || 'general'

/** Row subtitle: the pretty category, plus the badge a non-default origin earns. */
export function skillSubtitleParts(skill: SkillInfo): { badge: 'agent' | 'hub' | null; category: string } {
  const provenance = skill.provenance

  return {
    badge: provenance === 'agent' ? 'agent' : provenance === 'hub' ? 'hub' : null,
    category: prettyName(categoryFor(skill))
  }
}

export function filteredSkills(skills: SkillInfo[], query: string, desc: boolean): SkillInfo[] {
  const q = normalize(query)
  const sign = desc ? 1 : -1

  return skills
    .filter(
      skill =>
        !q || includesQuery(skill.name, q) || includesQuery(skill.description, q) || includesQuery(skill.category, q)
    )
    .sort((a, b) => sign * (usageOf(b) - usageOf(a)) || asText(a.name).localeCompare(asText(b.name)))
}

export const toolsetCalls = (toolset: ToolsetInfo, toolCalls: Record<string, number>): number =>
  toolNames(toolset).reduce((sum, name) => sum + (toolCalls[name] ?? 0), 0)

export function filteredToolsets(
  toolsets: ToolsetInfo[],
  query: string,
  toolCalls: Record<string, number>,
  desc: boolean
): ToolsetInfo[] {
  const q = normalize(query)
  const sign = desc ? 1 : -1

  return toolsets
    .filter(toolset => {
      if (!isDesktopToolsetVisible(toolset.name)) {
        return false
      }

      if (!q) {
        return true
      }

      return (
        includesQuery(toolset.name, q) ||
        includesQuery(toolsetDisplayLabel(toolset), q) ||
        includesQuery(toolset.description, q) ||
        toolNames(toolset).some(name => includesQuery(name, q))
      )
    })
    .sort(
      (a, b) =>
        sign * (toolsetCalls(b, toolCalls) - toolsetCalls(a, toolCalls)) ||
        toolsetDisplayLabel(a).localeCompare(toolsetDisplayLabel(b))
    )
}

export const visibleToolsetCount = (toolsets: ToolsetInfo[]) =>
  toolsets.filter(ts => isDesktopToolsetVisible(ts.name)).length

/**
 * Frontmatter parse for display: the YAML block between the leading `---`
 * fences, flattened to top-level `key: value` rows (nested blocks render as
 * their raw indented text). Display-only — never fed back to the backend.
 */
export function parseFrontmatter(content: string): { body: string; meta: [string, string][] } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)

  if (!match) {
    return { body: content, meta: [] }
  }

  const meta: [string, string][] = []
  let currentKey: null | string = null
  let block: string[] = []

  const flush = () => {
    if (currentKey !== null) {
      meta.push([currentKey, block.join('\n').trim()])
    }

    currentKey = null
    block = []
  }

  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s?(.*)$/.exec(line)

    if (kv) {
      flush()
      currentKey = kv[1]
      block = kv[2] ? [kv[2]] : []
    } else if (currentKey !== null) {
      block.push(line.replace(/^ {2}/, ''))
    }
  }

  flush()

  return { body: content.slice(match[0].length), meta }
}
