import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// Read from disk: the ui project stubs CSS imports (even `?raw`) to ''.
const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const homeCss = read('./home.css')
const itCss = read('./it-terminal.css')
const sideCss = read('./msg-sidebar.css')

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const at = flat.indexOf(`${selector} {`)

  expect(at, selector).toBeGreaterThanOrEqual(0)

  return flat.slice(flat.indexOf('{', at) + 1, flat.indexOf('}', at))
}

describe('iT hit-testing (the one surface)', () => {
  it('the Message iT controls keep the Message pointer gate', () => {
    const body = rule(homeCss, ['.ihome .itwin__rail', '.ihome .itwin__div', '.ihome .itwin__pane-close'].join(',\n'))

    expect(body).toMatch(/pointer-events:\s*var\(--iclone-msg-pe, auto\);/)
    expect(rule(homeCss, '.ihome .itwin')).toMatch(/pointer-events:\s*none;/)
  })

  it('the whole-view crash card takes its own clicks, so Retry is reachable', () => {
    expect(rule(itCss, ".ihome .itwin[role='alert']")).toMatch(/pointer-events:\s*auto;/)
  })

  it('a pane crash card fills its pane', () => {
    expect(rule(itCss, '.itwin__crash')).toMatch(/flex:\s*1;/)
  })

  it('no iT window rules are left', () => {
    expect(itCss + homeCss).not.toMatch(/ic-win--it|data-scope='window'|data-it-scope|it-window-\d/)
  })
})

/**
 * OWNER DECISION 2026-10-19 (RESUME/contracts/M1_message_head_band.md): the 'iclone os' head band is in
 * BOTH Message views. The band was chat-only because a fixed band over a terminal that starts at the
 * window's top edge covers the shell's first lines — so the band could only move into iT together with
 * this: the terminal's top is the MEASURED body rect (window/rect.ts publishBodyRect = the window's top
 * edge + the head band), never an offset of its own.
 */
describe('iT starts at the head band, not at the window top edge', () => {
  it('.itwin follows the published body rect', () => {
    expect(rule(itCss, '.itwin')).toMatch(
      /top: var\(--iwin-top, calc\(var\(--ic-frame-top\) \+ var\(--ic-win-head-h\)\)\);/
    )
    // The old 44px was the removed header-tab strip's height, typed in by hand: the band's height is
    // --ic-win-head-h and grows with the text scale, so any hand-typed offset covers a shell line.
    expect(itCss).not.toMatch(/\+ 44px\)/)
  })

  it('the Message-scoped rule that wins the cascade reads the same published rect, band-safe fallback and all', () => {
    // This rule beats it-terminal.css, so its FALLBACK is the one that decides where the terminal sits
    // before the body rect is published: a bare `--ic-frame-top` there put the first shell lines under
    // the band (r1 critic). Both rules now fall back through the band's own height.
    expect(rule(homeCss, ".ihome .itwin[data-scope='message']")).toMatch(
      /top: var\(--iwin-top, calc\(var\(--ic-frame-top\) \+ var\(--ic-win-head-h\)\)\);/
    )
    // Every surface clipped into the window body falls back through the band: the terminal, the chat
    // clip and the sidebar. One band-unsafe fallback is one surface that paints over the shell.
    expect(homeCss + sideCss).not.toMatch(/top: var\(--iwin-top, var\(--ic-frame-top\)\);/)
    expect(
      (homeCss + sideCss).match(/top: var\(--iwin-top, calc\(var\(--ic-frame-top\) \+ var\(--ic-win-head-h\)\)\);/g) ??
        []
    ).toHaveLength(3)
  })

  it('leaves the window top-right corner to the band, so no plate shows through', () => {
    // The band's bottom edge is square; a radius here cut a notch out of the terminal under it and the
    // plate showed in the gap (measured, r1 2026-10-19). Bottom-right still follows the window frame.
    expect(rule(homeCss, ".ihome .itwin[data-scope='message']")).toMatch(
      /border-radius: 0 0 var\(--iwin-radius, var\(--ic-frame-radius\)\) 0;/
    )
  })
})
