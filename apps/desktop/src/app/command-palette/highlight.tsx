/**
 * Emphasis on the words that earned a row its rank — the "why is this row
 * here" affordance. The marking itself is the shared `HighlightMatches`
 * (semantic `<mark>`s, per-term AND semantics, merged ranges); this wrapper
 * only splits the palette's query the way `scoreItem` does and paints in the
 * sheet's own ink.
 *
 * The explicit `text-(--ic-accent-strong)` is not decoration: `cn`'s
 * tailwind-merge drops HighlightMatches' default `text-(--ui-accent)` in
 * favour of it, so the gold never depends on stylesheet order.
 */

import { HighlightMatches } from '@/components/ui/highlight-matches'

export function PaletteHighlight({ search, text }: { search: string; text: string }) {
  return <HighlightMatches className="icp-mark text-(--ic-accent-strong)" query={search.split(/\s+/)} text={text} />
}
