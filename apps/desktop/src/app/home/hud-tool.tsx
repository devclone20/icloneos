/**
 * iclone os — HUD mode as a frame tool.
 *
 * Owner rule: the HUD button sits at the top right with the other
 * frame tools and works. Same contract as the wallet / theme / browser tools: a
 * core `titleBar.tools.right` contribution that FrameTools reads by id. The
 * window lifecycle (open, close, the main-window broadcast that keeps
 * `$hudActive` true to the child) stays in `@/store/hud`; this module only
 * publishes the button's state.
 */
import { useEffect } from 'react'

import { hudTargetSessionId } from '@/app/hud/handoff'
import { registry } from '@/contrib/registry'
import { translateNow, useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { formatCombo } from '@/lib/keybinds/combo'
import { $hudActive, canUseHud, toggleHud } from '@/store/hud'
import { $bindings, bindingsFor } from '@/store/keybinds'

import { IcMessage } from './iclone-icons'

export const HUD_TOOL_ID = 'iclone-hud'

const HUD_ACTION_ID = 'view.toggleHud'

/** Same call as the `view.toggleHud` keybind: the HUD opens on the chat the
 *  user is looking at, and a second press brings the main window back. */
function onHudToolSelect() {
  triggerHaptic('open')
  toggleHud(hudTargetSessionId())
}

/** The label plus the live `view.toggleHud` combo (e.g. "HUD mode (⌘⇧H)"),
 *  the hint the old titlebar tooltip carried; bare label when unbound. */
function hudToolTitle(label: string): string {
  const combo = bindingsFor(HUD_ACTION_ID)[0]

  return combo ? `${label} (${formatCombo(combo)})` : label
}

let dispose: (() => void) | null = null
// The display-language label handed in by useIcloneHudTool. The i18n provider sets
// the runtime locale in its own effect, which runs after its children's, so a
// translateNow() from a child effect still reads the previous language.
let localeLabel: null | string = null

function publish() {
  const label = localeLabel ?? translateNow('titlebar.enterHud')

  dispose?.()
  dispose = registry.register({
    id: HUD_TOOL_ID,
    area: 'titleBar.tools.right',
    order: 4,
    data: {
      active: $hudActive.get(),
      // Outside the desktop shell there is no HUD window to open.
      hidden: !canUseHud(),
      icon: <IcMessage size={16} strokeWidth={1.7} />,
      id: HUD_TOOL_ID,
      label,
      onSelect: onHudToolSelect,
      title: hudToolTitle(label)
    }
  })
}

let registered = false

/** Idempotent — useIcloneHudTool calls it on every label change. */
export function registerIcloneHudTool() {
  if (registered) {
    return
  }

  registered = true
  $hudActive.subscribe(publish)
  $bindings.listen(publish)
}

/** Re-publish with the label of the display language now in force. */
function refreshIcloneHudTool(label: string) {
  localeLabel = label

  if (registered) {
    publish()
  }
}

/** FrameTools' entry point: registers the tool, and re-labels it whenever the
 *  display language changes (the tool otherwise re-publishes only on its own
 *  state: HUD up/down, a rebind). */
export function useIcloneHudTool() {
  const label = useI18n().t.titlebar.enterHud

  useEffect(() => {
    registerIcloneHudTool()
    refreshIcloneHudTool(label)
  }, [label])
}
