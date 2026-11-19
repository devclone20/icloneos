/**
 * The window rect — one fixed rect for every Dock window and Settings: the
 * iNFT backdrop's own frame (`.ihome__stage--live` reads the same
 * `--ic-frame-*` tokens in home.css), or the whole app when expanded. There is
 * no mouse resize and no stored per-window rect (owner, contract D §6/§10):
 * the rect is a pure function of the tokens, the expanded flag and — since
 * v0.0.9 F6 — the pane slot (pane-layout.ts): with two panes side by side each
 * one takes its part of the frame, and the divider between them is the only
 * thing the mouse resizes. Also the one writer of the Message window's
 * `--iwin-*` vars.
 */
import type { CSSProperties } from 'react'

import { FRAME_VAR, type WindowFrame } from '../window-frame'

import type { PaneSlot } from './pane-layout'

type WindowRect = WindowFrame

type Side = keyof WindowRect

const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left']

/** Where a pane sits inside the frame: its slot, and the frame's inner width the slot's px are measured against. */
export interface PaneGeometry {
  slot: PaneSlot
  area: number
}

/** The outer rect as a CSS length per side, falling back to the frame until published. */
export function outerInset(side: Side): string {
  return `var(--iwin-outer-${side}, var(${FRAME_VAR[side]}))`
}

/** One side of the base rect: the backdrop's frame token, or the app's edge when expanded (the Dock's lane included —
 *  the Dock tucks away while a window is expanded, dock.tsx). A pane on one side moves its inner edge in by the
 *  other side's share of the frame (px from pane-layout.ts). */
function frameInset(side: Side, expanded: boolean, geometry?: PaneGeometry): string {
  if (expanded) {
    return '0px'
  }

  const base = `var(${FRAME_VAR[side]})`
  const slot = geometry?.slot

  if (!geometry || !slot || (slot.place !== 'left' && slot.place !== 'right')) {
    return base
  }

  if (side === 'left' && slot.left > 0) {
    return `calc(${base} + ${slot.left}px)`
  }

  const rest = Math.round(geometry.area) - slot.left - slot.width

  if (side === 'right' && rest > 0) {
    return `calc(${base} + ${rest}px)`
  }

  return base
}

function frameRadius(expanded: boolean): string {
  return expanded ? '0px' : `var(${FRAME_VAR.radius})`
}

/** A 'self' window's root box: the same rect, as CSS, as the iNFT backdrop's card (or its pane's part of it). */
export function windowRectStyle(expanded: boolean, geometry?: PaneGeometry): CSSProperties {
  return {
    top: frameInset('top', expanded, geometry),
    right: frameInset('right', expanded, geometry),
    bottom: frameInset('bottom', expanded, geometry),
    left: frameInset('left', expanded, geometry),
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
export function publishShellRect(expanded: boolean, geometry?: PaneGeometry): void {
  const root = document.documentElement

  for (const side of SIDES) {
    root.style.setProperty(`--iwin-outer-${side}`, frameInset(side, expanded, geometry))
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
