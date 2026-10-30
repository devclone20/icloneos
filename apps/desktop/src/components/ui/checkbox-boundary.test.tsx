import { readFileSync } from 'node:fs'
import path from 'node:path'

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Checkbox } from '@/components/ui/checkbox'
import { contrastRatio, mix } from '@/themes/color'
import { BUILTIN_THEME_LIST } from '@/themes/presets'

afterEach(cleanup)

const styles = readFileSync(path.join(__dirname, '../../styles.css'), 'utf8')

// U3-02: the unchecked box is the only thing that shows a checkbox is there, so its edge needs 3:1 against
// every surface it can sit on (WCAG 1.4.11). jsdom resolves no custom properties, so the share of the
// foreground is read from the class (an inline color-mix, or the named token it points at in styles.css)
// and composited over each preset surface the way color-mix paints it.
function foregroundShare(className = ''): number {
  const inline = className.match(/(?:^| )border-\[color-mix\(in_srgb,var\(--ui-base\)_(\d+)%,transparent\)\](?: |$)/)

  if (inline) {
    return Number(inline[1])
  }

  const token = className.match(/(?:^| )border-\((--[a-z0-9-]+)\)(?: |$)/)?.[1]

  const value =
    token && styles.match(new RegExp(`${token}:\\s*color-mix\\(in srgb, var\\(--ui-base\\) (\\d+)%, transparent\\)`))

  return value ? Number(value[1]) : Number.NaN
}

function uncheckedBox() {
  const { container } = render(<Checkbox checked={false} />)

  return container.querySelector<HTMLElement>('[data-slot="checkbox"]')
}

describe('Checkbox boundary (U3-02)', () => {
  it('draws the unchecked edge from the foreground, not the input-field token', () => {
    const box = uncheckedBox()

    expect(box?.classList.contains('border-input')).toBe(false)
    expect(foregroundShare(box?.className)).toBeGreaterThan(0)
  })

  it('clears 3:1 on every built-in surface', () => {
    const share = foregroundShare(uncheckedBox()?.className)

    expect(share).toBeGreaterThan(0)

    const ratios = BUILTIN_THEME_LIST.flatMap(theme =>
      [theme.colors.background, theme.colors.card, theme.colors.popover].map(surface => ({
        ratio: contrastRatio(mix(surface, theme.colors.foreground, share / 100), surface),
        surface,
        theme: theme.name
      }))
    )

    expect(ratios.filter(entry => entry.ratio < 3)).toEqual([])
  })

  it('keeps the checked fill', () => {
    const { container } = render(<Checkbox checked />)
    const box = container.querySelector<HTMLElement>('[data-slot="checkbox"]')

    expect(box?.className).toContain('data-[state=checked]:border-primary')
    expect(box?.className).toContain('data-[state=checked]:bg-primary')
  })
})
