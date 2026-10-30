/**
 * A row's hotkey, as our own key caps. `comboTokens` is the app's single
 * source for splitting a binding into display tokens (`mod+shift+n` →
 * ⌘ ⇧ N on macOS), so a palette hint can never disagree with the keybind
 * panel.
 */

import { comboTokens } from '@/lib/keybinds/combo'

export function PaletteKeys({ combo, dim }: { combo: string; dim?: boolean }) {
  const keys = comboTokens(combo)

  return (
    <span aria-label={keys.join(' ')} className="icp-keys" data-dim={dim ? '' : undefined}>
      {keys.map((key, index) => (
        <kbd className="icp-key" key={`${key}-${index}`}>
          {key}
        </kbd>
      ))}
    </span>
  )
}
