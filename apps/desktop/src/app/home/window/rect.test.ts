import { beforeEach, describe, expect, it } from 'vitest'

import { outerInset, publishBodyRect, publishShellRect, readInsets, windowRectStyle } from './rect'

const SIDES = ['top', 'right', 'bottom', 'left'] as const

function rootVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name)
}

beforeEach(() => {
  document.documentElement.removeAttribute('style')
})

describe('publishShellRect', () => {
  it('publishes the backdrop frame tokens as the outer rect, on the frame radius', () => {
    publishShellRect(false)

    for (const side of SIDES) {
      expect(rootVar(`--iwin-outer-${side}`)).toBe(`var(--ic-frame-${side})`)
    }

    expect(rootVar('--iwin-radius')).toBe('var(--ic-frame-radius)')
  })

  it('goes full-bleed and square when expanded — the Dock lane included', () => {
    publishShellRect(true)

    for (const side of SIDES) {
      // Owner decision 2026-10-18: the whole app, the Dock's lane included; the Dock tucks away (dock-autohide.ts).
      expect(rootVar(`--iwin-outer-${side}`)).toBe('0px')
    }

    expect(rootVar('--iwin-radius')).toBe('0px')
  })

  it('returns to the frame on retract (no rect is remembered)', () => {
    publishShellRect(true)
    publishShellRect(false)

    expect(rootVar('--iwin-outer-left')).toBe('var(--ic-frame-left)')
    expect(rootVar('--iwin-radius')).toBe('var(--ic-frame-radius)')
  })

  it('never writes the body clip (that is the measured body)', () => {
    publishShellRect(false)

    for (const side of SIDES) {
      expect(rootVar(`--iwin-${side}`)).toBe('')
    }
  })
})

describe('windowRectStyle', () => {
  it("is the iNFT backdrop's frame: the same four tokens and radius", () => {
    expect(windowRectStyle(false)).toEqual({
      top: 'var(--ic-frame-top)',
      right: 'var(--ic-frame-right)',
      bottom: 'var(--ic-frame-bottom)',
      left: 'var(--ic-frame-left)',
      borderRadius: 'var(--ic-frame-radius)'
    })
  })

  it('fills the app, square, when expanded', () => {
    expect(windowRectStyle(true)).toEqual({ top: '0px', right: '0px', bottom: '0px', left: '0px', borderRadius: '0px' })
  })
})

describe('publishBodyRect', () => {
  it("publishes the measured body insets as the shells' clip", () => {
    const body = document.createElement('div')

    Object.assign(body.style, { position: 'fixed', top: '92px', right: '72px', bottom: '40px', left: '96px' })
    document.body.append(body)
    publishBodyRect(readInsets(body))
    body.remove()

    expect(rootVar('--iwin-top')).toBe('92px')
    expect(rootVar('--iwin-right')).toBe('72px')
    expect(rootVar('--iwin-bottom')).toBe('40px')
    expect(rootVar('--iwin-left')).toBe('96px')
  })
})

describe('outerInset', () => {
  it('reads the published outer rect and falls back to the frame', () => {
    expect(outerInset('top')).toBe('var(--iwin-outer-top, var(--ic-frame-top))')
    expect(outerInset('left')).toBe('var(--iwin-outer-left, var(--ic-frame-left))')
  })
})
