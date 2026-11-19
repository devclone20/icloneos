/**
 * v0.0.9 r4b (critic-r4 03-message-settings-5050-dark): the split divider's hint rendered as the app-wide `Tip`, an
 * inverted light chip in Arial that reads as a browser tooltip in the dark skin. It is the house IcTip now, painted on
 * our roles in both skins. Red on 4ba1f24493: pane-layer.tsx wrapped the divider in `Tip` from components/ui/tooltip.
 */
import { describe, expect, it } from 'vitest'

import { read } from '@/test/token-contrast'

describe('the divider hint is the house tip', () => {
  const layer = read('app/home/window/pane-layer.tsx')

  it('pane-layer wraps the divider in IcTip, never the inverted app Tip', () => {
    expect(layer).toMatch(/<IcTip label=\{f6Panes\.dividerHint\} side="top">/)
    expect(layer).not.toContain("from '@/components/ui/tooltip'")
  })

  it('IcTip paints on tokens only: surface, hairline and ink, no inverted foreground/background, no Arial', () => {
    const system = read('components/ic/ic-system.tsx')
    const at = system.indexOf('export function IcTip(')
    const body = system.slice(at, system.indexOf('\n}\n', at))

    expect(body).toContain('bg-(--ic-surface)')
    expect(body).toContain('border-(--ic-border-subtle)')
    expect(body).toContain('text-(--ic-text-1)')
    expect(body).not.toMatch(/bg-foreground|text-background|Arial/)
  })
})
