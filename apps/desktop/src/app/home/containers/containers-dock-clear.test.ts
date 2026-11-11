import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/** F45c: an expanded Containers window fills the app, and the Dock comes back over it. Its page keeps clear of the rail. */
const read = (file: string) => readFileSync(path.join(import.meta.dirname, file), 'utf8')

function dockRightEdge(): number {
  const css = read('../dock.css')
  const rail = /\n\.dock \{([^}]*)\}/.exec(css)?.[1] ?? ''
  const px = (re: RegExp) => Number(re.exec(rail)?.[1])
  const item = Number(/\.dock__item \{[^}]*?width: (\d+)px/.exec(css)?.[1])

  // left + border + padding on both sides + the 44px column
  return px(/left: (\d+)px/) + 2 + 2 * px(/padding: (\d+)px/) + item
}

describe('the expanded Containers page clears the Dock', () => {
  it('reads a real Dock edge', () => {
    expect(dockRightEdge()).toBe(78)
  })

  it('keeps its body at least as far from the start edge as the Dock reaches', () => {
    const css = read('containers.css')
    const rule = /\.iecon\[data-kind='containers'\]\[data-expanded\] \.iecon__body \{([^}]*)\}/.exec(css)?.[1] ?? ''
    const clear = Number(/--icont-dock-clear: (\d+)px/.exec(rule)?.[1])

    expect(rule).toContain('padding-inline-start: var(--icont-dock-clear)')
    expect(clear).toBeGreaterThanOrEqual(dockRightEdge())
  })

  it('F45d: at the smallest windows the lane is kept only while the Dock is out', () => {
    expect(read('containers.css')).toMatch(
      /@media \(max-width: 860px\)[^}]*:root:not\(:has\(\.dock\[data-revealed\], \.dock :focus-visible\)\)[^{]*\{\s*padding-inline-start: 0;/
    )
  })
})
