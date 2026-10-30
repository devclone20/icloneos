// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { aimHint, hintReach, hintSide } from './hint'

// jsdom lays nothing out, so every box here is stated explicitly — the rule
// under test is arithmetic on rects, and these are the rects lab 2 measures:
// a 640 px list scroller with 20 px controls in it.
const REACH = 24

function scroller(buttonTop: number): HTMLButtonElement {
  const clip = document.createElement('div')
  clip.style.overflowY = 'auto'
  clip.getBoundingClientRect = () => new DOMRect(0, 100, 300, 640)

  const button = document.createElement('button')
  button.className = 'icsk__iconbtn'
  button.getBoundingClientRect = () => new DOMRect(0, buttonTop, 20, 20)
  clip.append(button)
  document.body.append(clip)

  return button
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('an icon hint is aimed at the room the control has', () => {
  it('draws below while the scroller has room there', () => {
    expect(hintSide(scroller(300))).toBe('down')
  })

  it('flips above for a control at the bottom edge of the scroller', () => {
    // Bottom 733 against the clipper's 740: 7 px of room, less than the reach.
    expect(hintSide(scroller(713))).toBe('up')
  })

  it('stays below when neither side fits, instead of moving the clip', () => {
    const tight = document.createElement('div')
    tight.style.overflowY = 'auto'
    tight.getBoundingClientRect = () => new DOMRect(0, 100, 300, 30)

    const button = document.createElement('button')
    button.getBoundingClientRect = () => new DOMRect(0, 105, 20, 20)
    tight.append(button)
    document.body.append(tight)

    expect(hintSide(button)).toBe('down')
  })

  it('draws below when nothing clips the control', () => {
    const loose = document.createElement('button')
    loose.getBoundingClientRect = () => new DOMRect(0, 713, 20, 20)
    document.body.append(loose)

    expect(hintSide(loose)).toBe('down')
  })

  it('falls back to a sane reach when the CSS property is absent', () => {
    expect(hintReach(scroller(300))).toBe(REACH)
  })

  it('writes the side onto the control, which is what the CSS reads', () => {
    const button = scroller(713)
    aimHint({ currentTarget: button })

    expect(button.getAttribute('data-ic-hint')).toBe('up')

    const roomy = scroller(300)
    aimHint({ currentTarget: roomy })

    expect(roomy.getAttribute('data-ic-hint')).toBe('down')
  })
})
