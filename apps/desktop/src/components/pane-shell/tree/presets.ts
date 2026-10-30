/**
 * Layout presets — the addressable layouts of the `'layouts'` area.
 *
 * A preset is a CONTRIBUTION (`area: 'layouts'`, `data: LayoutNode`) resolved
 * by the backend `apply_layout` tool through `applyDesktopLayoutPreset`. There
 * is no preset UI any more (the picker went with the upstream pane shell), so
 * nothing new is saved here: the app root registers the one layout it seeds,
 * and layouts a previous build persisted are re-registered read-only below so
 * that verb keeps resolving them.
 */

import { registry } from '@/contrib/registry'
import { readJson, writeKey } from '@/lib/storage'

import { isLayoutNode, type LayoutNode } from './model'
import { applyTree } from './store'

export const LAYOUTS_AREA = 'layouts'

// v2: v1 presets predate semantic placement (see store.ts) — retire them.
const USER_KEY = 'hermes.desktop.layoutPresets.v2'

writeKey('hermes.desktop.layoutPresets.v1', null)

interface StoredPreset {
  name: string
  tree: LayoutNode
}

function loadUserPresets(): Record<string, StoredPreset> {
  const parsed = readJson<Record<string, StoredPreset>>(USER_KEY) ?? {}
  const out: Record<string, StoredPreset> = {}

  for (const [id, preset] of Object.entries(parsed)) {
    if (preset && typeof preset.name === 'string' && isLayoutNode(preset.tree)) {
      out[id] = preset
    }
  }

  return out
}

// Re-register what a previous build saved, at module load.
for (const [id, preset] of Object.entries(loadUserPresets())) {
  registry.register({ id, area: LAYOUTS_AREA, source: 'user', title: preset.name, data: preset.tree })
}

/** Apply a preset's tree (deep-cloned so live edits never mutate the preset). */
export function applyLayoutPreset(id: string, tree: LayoutNode) {
  applyTree(structuredClone(tree), id)
}
