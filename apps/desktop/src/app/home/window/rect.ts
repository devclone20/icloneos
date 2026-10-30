/**
 * The window rect — one fixed rect for every Dock window and Settings: the
 * iNFT backdrop's own frame (`.ihome__stage--live` reads the same
 * `--ic-frame-*` tokens in home.css), or the whole app when expanded. There is
 * no mouse resize and no stored per-window rect (owner, contract D §6/§10):
 * the rect is a pure function of the tokens and the expanded flag. Also the
 * one writer of the Message window's `--iwin-*` vars.
 */
import type { CSSProperties } from 'react'

import { FRAME_VAR, type WindowFrame } from '../window-frame'

type WindowRect = WindowFrame

type Side = keyof WindowRect

const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left']

/** The outer rect as a CSS length per side, falling back to the frame until published. */
export function outerInset(side: Side): string {
  return `var(--iwin-outer-${side}, var(${FRAME_VAR[side]}))`
}

/** One side of the base rect: the backdrop's frame token, or the app's edge when expanded (the Dock's lane included —
 *  the Dock tucks away while a window is expanded, dock.tsx). */
function frameInset(side: Side, expanded: boolean): string {
  return expanded ? '0px' : `var(${FRAME_VAR[side]})`
}

function frameRadius(expanded: boolean): string {
  return expanded ? '0px' : `var(${FRAME_VAR.radius})`
}

/** A 'self' window's root box: the same rect, as CSS, as the iNFT backdrop's card. */
export function windowRectStyle(expanded: boolean): CSSProperties {
  return {
    top: frameInset('top', expanded),
    right: frameInset('right', expanded),
    bottom: frameInset('bottom', expanded),
    left: frameInset('left', expanded),
    borderRadius: frameRadius(expanded)
  }
}

/**
 * The 'under-shell' window (Message) is drawn by shells that are not ours to
 * render (the chat surface, the iT host, the base-layer plate); they are
 * positioned by `--iwin-*` vars on <html>. This writes the OUTER rect (the
 * window). The body vars come from the measured `.ic-win__body`
 * (publishBodyRect), never from arithmetic on the outer rect.
 */
export function publishShellRect(expanded: boolean): void {
  const root = document.documentElement

  for (const side of SIDES) {
    root.style.setProperty(`--iwin-outer-${side}`, frameInset(side, expanded))
  }

  root.style.setProperty('--iwin-radius', frameRadius(expanded))
}

/**
 * A fixed element's box as the layout engine resolved its insets. Read in CSS
 * px, not from getBoundingClientRect: at a fractional zoom the client rect is
 * snapped to device pixels, and a clip published from it drifted off the
 * frame's edges by a sub-pixel seam.
 */
export function readInsets(element: Element): WindowRect {
  const style = getComputedStyle(element)
  const px = (value: string) => Number.parseFloat(value) || 0

  return { top: px(style.top), right: px(style.right), bottom: px(style.bottom), left: px(style.left) }
}

/** The measured body → the shells' clip (`--iwin-top|right|bottom|left`). */
export function publishBodyRect(body: WindowRect): void {
  const root = document.documentElement

  for (const side of SIDES) {
    root.style.setProperty(`--iwin-${side}`, `${body[side]}px`)
  }
}
