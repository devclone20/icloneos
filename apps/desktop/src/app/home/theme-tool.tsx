/**
 * iclone os — the theme cycle as a NATIVE titlebar tool.
 *
 * Owner rule: the theme control sits IN the top-right titlebar row, same size
 * and grammar as its siblings, icon-only (no label text — the click teaches
 * itself). Registered as a `titleBar.tools.right` data contribution so
 * TitlebarControls renders it exactly like the built-in icons.
 *
 * The cycle is imperative (outside React): home/lib/persist.ts writes the
 * persisted skin selection the way src/themes/context.tsx reads it and wakes
 * the ThemeProvider.
 */
import { Contrast } from 'lucide-react'

import { registry } from '@/contrib/registry'

import { applySkin, storedSkin } from './lib/persist'
import { ICLONE_SKIN_CYCLE, ICLONE_SKIN_MODE } from './lib/skins'
import { $toolsCopy } from './tools-copy'

function cycleIcloneSkin() {
  try {
    const applied = document.documentElement.dataset.hermesTheme ?? storedSkin() ?? ICLONE_SKIN_CYCLE[0]
    const index = ICLONE_SKIN_CYCLE.indexOf(applied as (typeof ICLONE_SKIN_CYCLE)[number])
    const next = ICLONE_SKIN_CYCLE[(index + 1) % ICLONE_SKIN_CYCLE.length]

    applySkin(next, ICLONE_SKIN_MODE[next])
  } catch (error) {
    console.warn('[iclone] theme cycle failed:', error)
  }
}

let registered = false

/** The label in the display language — the three skins named in the cycle's order (lib/skins.ts). */
const themeLabel = (): string => {
  const copy = $toolsCopy.get()

  return copy.themeCycle(copy.themeNatural, copy.themeDark, copy.themeLight)
}

const publish = () =>
  registry.register({
    id: 'iclone-theme-cycle',
    area: 'titleBar.tools.right',
    data: {
      id: 'iclone-theme-cycle',
      label: themeLabel(),
      icon: <Contrast size={16} strokeWidth={1.7} />,
      onSelect: cycleIcloneSkin
    }
  })

/** Idempotent — wiring imports this module once per window. */
export function registerIcloneThemeTool() {
  if (registered) {
    return
  }

  registered = true
  publish()
  // The display language changed: same tool, new words.
  $toolsCopy.listen(publish)
}
