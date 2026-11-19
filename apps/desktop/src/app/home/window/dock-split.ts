/**
 * v0.0.9 F6 · owner addition (18 Nov): split the window by dragging a Dock icon onto it (PLANO_V009.md «F6 ·
 * Acrescento do dono»).
 *
 * With a pane open, the owner drags another Dock icon over the app window. While the pointer moves, the window shows
 * the split it would make — the two halves, and the side the new pane takes, the side the pointer is on. Dropping
 * opens the two panes side by side (half and half for a pair never resized, else where the owner left that pair's
 * divider). Dropping outside the frame, or Esc, cancels and changes nothing.
 *
 * Still at most two: with two open, the drop takes the place of the pane on the side it lands on, and the preview
 * says so. Any two Dock panes pair, Message and Settings included (v0.0.9 r2: Settings opens as a pane beside the
 * Message window instead of replacing its route — pane-layout.ts `$settingsBesideMessage`). Below 758 pt of usable
 * width the pair is two tabs (pane-layout.ts), and the preview says that instead of drawing halves.
 *
 * This file is the rules (`planDrop`, all pure) and the drag's one store (`$dockDrag`). The Dock (dock.tsx) drives
 * the pointer; the preview (dock-split-preview.tsx) only draws what `$dockDrop` says.
 */
import { atom, computed } from 'nanostores'

import { f6PaneNames, f6Split } from '@/i18n/en/v009-f6'

import { clearFramedOpening, openFramed, retractWindow } from './expanded'
import type { IcWindowId } from './ic-window'
import { announcePanes } from './pane-announce'
import {
  $paneArea,
  $panes,
  canArrange,
  clearPendingPlacement,
  moveRegisteredPane,
  PANE_DIVIDER_PX,
  PANE_SPLIT_MIN_PX,
  type PaneSide,
  type PaneState,
  type PaneWidths,
  type PendingPlacement,
  setPendingPlacement,
  splitWidths,
  storedPairRatio
} from './pane-layout'

/** The frame on screen, in viewport px (the pane probe's box). */
export interface FrameRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** How far a press travels before it is a drag, not a click (the macOS Dock's own slop is about this). */
export const DOCK_DRAG_SLOP_PX = 6

export type DropPlan =
  /** Off the frame (or nothing to change): a release here cancels. `open`: over the frame, but the pane is already
   *  open with nowhere to move (the preview says so instead of staying silent). */
  | { readonly kind: 'outside'; readonly reason?: 'open' }
  /** The pane is already open: it moves to that side. */
  | { readonly kind: 'move'; readonly incoming: string; readonly side: PaneSide; readonly widths: PaneWidths }
  /** Two panes side by side; `replaced` is the one that makes room (two were open), or null. */
  | {
      readonly kind: 'split'
      readonly incoming: string
      readonly keep: string
      readonly replaced: null | string
      readonly side: PaneSide
      readonly widths: PaneWidths
    }
  /** Too narrow for two side by side: the pair becomes two tabs, the newcomer shown. */
  | { readonly kind: 'tab'; readonly incoming: string; readonly keep: string; readonly replaced: null | string }

const OUTSIDE: DropPlan = { kind: 'outside' }
const ALREADY_OPEN: DropPlan = { kind: 'outside', reason: 'open' }

function insideFrame(frame: FrameRect, x: number, y: number): boolean {
  return (
    frame.width > 0 &&
    frame.height > 0 &&
    x >= frame.left &&
    x <= frame.left + frame.width &&
    y >= frame.top &&
    y <= frame.top + frame.height
  )
}

/** The panes' widths once `left` and `right` sit side by side: that pair's remembered divider, else half and half. */
function pairWidths(area: number, left: string, right: string): PaneWidths {
  return splitWidths(area, storedPairRatio(left, right))
}

/**
 * What a release at (x, y) would do. `area` is the frame's inner width (pane-layout's `$paneArea`; the frame's own
 * width until measured). The side is the half the pointer is on — with two panes side by side, the pane under it.
 */
export function planDrop(
  state: PaneState,
  area: number,
  frame: FrameRect,
  incoming: string,
  x: number,
  y: number
): DropPlan {
  const { open } = state
  const width = area > 0 ? area : frame.width

  if (open.length === 0 || !insideFrame(frame, x, y)) {
    return OUTSIDE
  }

  const local = x - frame.left
  const wide = canArrange(width)
  const seam = open.length === 2 && wide ? splitWidths(width, state.ratio).left + PANE_DIVIDER_PX / 2 : width / 2
  const pointerSide: PaneSide = local < seam ? 'left' : 'right'

  if (open.includes(incoming)) {
    // Dropping a pane that is already open moves it — only when there is another one to trade sides with.
    if (open.length < 2 || !wide || open[pointerSide === 'left' ? 0 : 1] === incoming) {
      return ALREADY_OPEN
    }

    // A swap keeps the divider where it is on screen (pane-layout `movePane` mirrors the ratio): the same widths here.
    return { kind: 'move', incoming, side: pointerSide, widths: splitWidths(width, 1 - state.ratio) }
  }

  // Folded into tabs only the focused pane is on screen: that one is what a drop replaces, whatever half it lands on.
  const shown = state.focused !== null && open.includes(state.focused) ? state.focused : open[open.length - 1]
  const folded = !wide && open.length === 2
  const side: PaneSide = pointerSide
  const replaced = open.length === 2 ? (folded ? shown : open[side === 'left' ? 0 : 1]) : null
  const keep = open.find(id => id !== replaced) as string

  if (!wide) {
    return { kind: 'tab', incoming, keep, replaced }
  }

  const [left, right] = side === 'left' ? [incoming, keep] : [keep, incoming]

  return { kind: 'split', incoming, keep, replaced, side, widths: pairWidths(width, left, right) }
}

/** The placement the store applies when the dropped pane registers (pane-layout.ts `registerPane`). */
export function placementOf(plan: DropPlan): null | PendingPlacement {
  switch (plan.kind) {
    case 'split':
      return {
        id: plan.incoming,
        open: plan.side === 'left' ? [plan.incoming, plan.keep] : [plan.keep, plan.incoming],
        replaced: plan.replaced
      }
    case 'tab': {
      // Tabs keep the screen order the panes had; the newcomer takes the place of the one it replaces, else the end.
      const open = $panes.get().open

      const order =
        plan.replaced !== null ? open.map(id => (id === plan.replaced ? plan.incoming : id)) : [...open, plan.incoming]

      return { id: plan.incoming, open: order, replaced: plan.replaced }
    }

    default:
      return null
  }
}

// ── the drag ─────────────────────────────────────────────────────────────────

export interface DockDrag {
  /** The pane the dragged icon opens (an IcWindow id). */
  readonly pane: string
  readonly x: number
  readonly y: number
  readonly frame: FrameRect
  /** The viewport the frame was read in: a change mid-drag (display, zoom) reads it again. */
  readonly viewport: string
}

const viewportKey = (): string => `${window.innerWidth}x${window.innerHeight}`

export const $dockDrag = atom<DockDrag | null>(null)

/** What the drag would do right now; null while nothing is dragged. */
export const $dockDrop = computed([$dockDrag, $panes, $paneArea], (drag, panes, area) =>
  drag === null ? null : planDrop(panes, area, drag.frame, drag.pane, drag.x, drag.y)
)

/**
 * A drag needs a pane open to split against, and somewhere for this pane to go: with none open, or when the only pane
 * open is this one (or it is open and the pair cannot trade sides), a Dock icon is only pressed — a click with a few
 * pixels of trackpad jitter still toggles it.
 */
export function canStartDockDrag(pane: string): boolean {
  const { open } = $panes.get()

  if (open.length === 0) {
    return false
  }

  return !open.includes(pane) || (open.length === 2 && canArrange($paneArea.get()))
}

/** The frame on screen, read once at the start of a drag from the pane layer's probe. */
export function readFrameRect(): FrameRect {
  const probe = document.querySelector('.ic-pane-probe')
  const box = probe?.getBoundingClientRect()

  return box
    ? { left: box.left, top: box.top, width: box.width, height: box.height }
    : { left: 0, top: 0, width: 0, height: 0 }
}

let stopEscape: (() => void) | null = null

/**
 * v0.0.9 r4d (eng r4-m3): the Esc that cancels a drag is a key press, so a pane root the POINTER focused before the drag
 * would turn :focus-visible and draw its keyboard ring — it read as a lingering drop target (critic-r4 04-light). The
 * root is not focused again (no .focus() after a cancel); it is marked quiet for this one key instead, and the mark goes
 * on its blur or on the next key (a real keyboard move shows the ring as it should).
 */
export function quietPaneRootRing(doc: Document = document): void {
  const active = doc.activeElement

  if (!(active instanceof HTMLElement) || !active.matches('.ic-win[data-ic-window]')) {
    return
  }

  active.dataset.icFocusQuiet = ''

  const view = doc.defaultView ?? window

  const clear = () => {
    delete active.dataset.icFocusQuiet
    active.removeEventListener('blur', clear)
    view.removeEventListener('keydown', onNextKey, true)
  }

  // The Esc keydown that set the mark is still being dispatched: listen from the next task on.
  const onNextKey = () => clear()

  active.addEventListener('blur', clear)
  setTimeout(() => view.addEventListener('keydown', onNextKey, true), 0)
}

function listenForEscape(): void {
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') {
      return
    }

    // Esc is the drag's: the home's Escape router (which would close a window) never sees it.
    event.preventDefault()
    event.stopImmediatePropagation()
    quietPaneRootRing()
    cancelDockDrag()
  }

  const onBlur = () => cancelDockDrag()

  window.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', onBlur)

  stopEscape = () => {
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', onBlur)
  }
}

// The live region hears the plan only when it changes (kind / side / replaced), never per pointer move.
let lastSaid = ''

function sayPlan(plan: DropPlan | null): void {
  const drag = $dockDrag.get()
  const words = plan === null || drag === null ? '' : planWords(plan, drag.pane)

  if (words !== lastSaid) {
    lastSaid = words
    announcePanes(words)
  }
}

export function beginDockDrag(pane: string, x: number, y: number, frame: FrameRect = readFrameRect()): void {
  stopEscape?.()
  lastSaid = ''
  $dockDrag.set({ pane, x, y, frame, viewport: viewportKey() })
  listenForEscape()
  sayPlan($dockDrop.get())
}

export function moveDockDrag(x: number, y: number): void {
  const drag = $dockDrag.get()

  if (drag === null) {
    return
  }

  // The window changed size or zoom under the drag: the frame moved with it (the `--ic-frame-*` breakpoints).
  const viewport = viewportKey()
  const frame = viewport === drag.viewport ? drag.frame : readFrameRect()

  if (drag.x !== x || drag.y !== y || frame !== drag.frame) {
    $dockDrag.set({ ...drag, x, y, frame, viewport })
    sayPlan($dockDrop.get())
  }
}

/** Stop the drag. `say`: tell the live region it was cancelled (Esc, a release off the frame, the window losing
 *  focus) — never after a drop, which says what it did. */
export function cancelDockDrag({ say = true }: { say?: boolean } = {}): void {
  const wasDragging = $dockDrag.get() !== null

  stopEscape?.()
  stopEscape = null
  $dockDrag.set(null)
  lastSaid = ''

  if (wasDragging && say) {
    announcePanes(f6Split.cancelled)
  }
}

export function isDockDragging(): boolean {
  return $dockDrag.get() !== null
}

/**
 * The release. Returns the plan it carried out (`outside` = cancelled, nothing changed). A move is done here; every
 * other plan leaves its placement for the pane's registration, then asks the caller to open the window.
 */
export function endDockDrag(x: number, y: number): DropPlan {
  const drag = $dockDrag.get()

  if (drag === null) {
    return OUTSIDE
  }

  const plan = planDrop($panes.get(), $paneArea.get(), drag.frame, drag.pane, x, y)

  cancelDockDrag({ say: plan.kind === 'outside' })

  return applyDrop(plan)
}

/**
 * Carry a plan out — the pointer's drop and the keyboard's split menu (dock-split-menu.tsx) share it. A move is done
 * here; every other plan leaves its placement for the pane's registration, and the caller opens the window.
 */
export function applyDrop(plan: DropPlan): DropPlan {
  if (plan.kind === 'outside') {
    return plan
  }

  if (plan.kind === 'move') {
    moveRegisteredPane(plan.incoming, plan.side)
    announcePanes(f6Split.moved(nameOf(plan.incoming), plan.side))

    return plan
  }

  // Side by side means framed: the pane that stays comes back from Fill, the newcomer opens at its usual size.
  if (plan.kind === 'split' || plan.kind === 'tab') {
    retractWindow(plan.keep)
  }

  openFramed(plan.incoming)
  setPendingPlacement(placementOf(plan))
  announcePanes(doneWords(plan))

  return plan
}

/** A drop that could not open its window (the lazy chunk failed): nothing left waiting for it. */
export function abandonDrop(plan: DropPlan): void {
  if (plan.kind !== 'outside' && plan.kind !== 'move') {
    clearPendingPlacement(plan.incoming)
    clearFramedOpening(plan.incoming)
  }
}

/**
 * The plan for opening `incoming` on one side without a pointer (the keyboard split menu): the same rules as a drop
 * on that half of the frame.
 */
export function planSide(state: PaneState, area: number, incoming: string, side: PaneSide): DropPlan {
  const width = area > 0 ? area : PANE_SPLIT_MIN_PX
  const frame: FrameRect = { left: 0, top: 0, width, height: 1 }

  return planDrop(state, width, frame, incoming, side === 'left' ? 0 : width, 0)
}

// ── the words ────────────────────────────────────────────────────────────────

const nameOf = (id: string): string => f6PaneNames[id as IcWindowId] ?? id

/** What the preview shows on the whole frame (no halves), or ''. */
export function wholeWords(plan: DropPlan, dragged: string): string {
  switch (plan.kind) {
    case 'tab':
      return plan.replaced === null
        ? f6Split.asTab(nameOf(plan.incoming), nameOf(plan.keep))
        : f6Split.replaces(nameOf(plan.incoming), nameOf(plan.replaced))

    case 'outside':
      return plan.reason === 'open' ? f6Split.alreadyOpen(nameOf(dragged)) : ''

    default:
      return ''
  }
}

/** The incoming half's words. */
export function incomingWords(plan: Extract<DropPlan, { kind: 'move' | 'split' }>): string {
  if (plan.kind === 'move') {
    return f6Split.moves(nameOf(plan.incoming))
  }

  return plan.replaced === null
    ? f6Split.opensHere(nameOf(plan.incoming))
    : f6Split.replaces(nameOf(plan.incoming), nameOf(plan.replaced))
}

/** What the live region says while hovering: the side and what happens there. */
function planWords(plan: DropPlan, dragged: string): string {
  if (plan.kind === 'split' || plan.kind === 'move') {
    return `${f6Split.side(plan.side)}: ${incomingWords(plan)}`
  }

  return wholeWords(plan, dragged)
}

function doneWords(plan: Exclude<DropPlan, { kind: 'move' | 'outside' }>): string {
  if (plan.replaced !== null) {
    return f6Split.replaces(nameOf(plan.incoming), nameOf(plan.replaced))
  }

  return f6Split.opened(nameOf(plan.incoming), nameOf(plan.keep))
}
