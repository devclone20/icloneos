import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * STAGE tester 1 H-1: Settings › Economy › iNFT Book's "Rescan" sat under the window's control column (the opacity
 * slider runs ~200px past the head band into the body's top-right corner) at 1220×779. jsdom lays nothing out, so
 * the mechanism is pinned at the source: the window publishes its clearance into its body, the page head reads it
 * for its end padding and keeps its own 18px everywhere else. The live pixels are the tester's to measure.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const home = path.join(here, '..', '..', 'app', 'home')
const page = fs.readFileSync(path.join(here, 'ic-page.css'), 'utf8')
const win = fs.readFileSync(path.join(home, 'window', 'ic-window.css'), 'utf8')
const tokens = fs.readFileSync(path.join(home, 'ic-tokens.css'), 'utf8')
const book = fs.readFileSync(path.join(here, '..', '..', 'app', 'settings', 'inft-book', 'inft-book.css'), 'utf8')

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`)

  if (start < 0) {
    throw new Error(`no rule ${selector}`)
  }

  return css.slice(start, css.indexOf('}', start))
}

describe('the page head clears an IcWindow control column (H-1)', () => {
  it('the clearance is one token, and the window head keeps the same distance', () => {
    expect(tokens).toMatch(/--ic-win-controls-clear:\s*64px;/)
    expect(rule(win, '.ic-win__head')).toContain('padding-inline: 26px var(--ic-win-controls-clear)')
  })

  it('the window body hands the clearance to the page head, which keeps 18px on its own', () => {
    expect(rule(win, '.ic-win > .ic-win__body')).toContain('--icpg-head-inset-end: var(--ic-win-controls-clear)')
    expect(rule(page, '.icpg__head')).toContain('padding-inline-end: var(--icpg-head-inset-end, 18px)')
  })

  it('the iNFT Book bars right under the head keep the same end clearance', () => {
    expect(rule(book, '.inft-book__bar')).toContain('padding-inline-end: calc(var(--icpg-head-inset-end, 16px) - 16px)')
  })
})
