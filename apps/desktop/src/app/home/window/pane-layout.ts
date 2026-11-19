/**
 * v0.0.9 F6 — the home's panes: at most two Dock windows side by side (P0_DESIGN_SPECS.md «F6 · Janelas e painéis»).
 *
 * The rules, all pure and all here (the store below only holds them):
 * - at most 2 panes; a 3rd one takes the place of the pane WITHOUT focus (D4) and says so in a toast;
 * - each pane is ≥ 375 pt; the divider between them is an 8 px hit target, so two panes need 2 × 375 + 8 = 758 pt of
 *   usable width (the frame's inner width). Below that the pair folds into tabs on the focused pane (D1), and it
 *   unfolds by itself as soon as the width is back;
 * - a filled (expanded) pane covers the app, so the other one folds into a tab too;
 * - 50/50 by default; the divider's ratio is clamped so neither side drops under 375; a double-click resets it;
 * - one pane alone fills the frame, or — after Move left/right — rests on that half (≥ 375) and leaves the rest to home;
 * - there is never a top/bottom split.
 *
 * Every length is in CSS px (= macOS points at zoom 1). `area` is the frame's inner width (window/pane-layer.tsx
 * measures it from the same `--ic-frame-*` tokens the windows are drawn with).
 */
import { atom, computed } from 'nanostores'

import { f6PaneNames, f6Split } from '@/i18n/en/v009-f6'
import { readJson, writeJson } from '@/lib/storage'

import { ICLONE_STORAGE } from '../lib/storage-keys'

import { $expandedWindows, clearFramedOpening } from './expanded'
import type { IcWindowId } from './ic-window'
import { announcePanes } from './pane-announce'

export const PANE_MIN_PX = 375
export const PANE_DIVIDER_PX = 8
/** 2 × 375 + 8: the narrowest usable width that holds two panes side by side. */
export const PANE_SPLIT_MIN_PX = PANE_MIN_PX * 2 + PANE_DIVIDER_PX
export const DEFAULT_PANE_RATIO = 0.5
/** One arrow-key step of the divider. */
export const PANE_DIVIDER_STEP_PX = 16

export type PaneSide = 'left' | 'right'
/** Where a pane that is alone sits: the whole frame, or one half of it. */
export type SoloPlace = 'full' | PaneSide

export interface PaneState {
  /** Open panes in screen order (left, right); never more than 2. */
  readonly open: readonly string[]
  readonly focused: null | string
  /** The left pane's share of the two panes' width (the divider excluded). */
  readonly ratio: number
  readonly solo: SoloPlace
}

export const INITIAL_PANES: PaneState = { open: [], focused: null, ratio: DEFAULT_PANE_RATIO, solo: 'full' }

export type PaneArrangement =
  | { readonly kind: 'none' }
  | { readonly kind: 'single'; readonly id: string; readonly place: SoloPlace }
  | { readonly kind: 'split'; readonly left: string; readonly right: string; readonly widths: PaneWidths }
  | { readonly kind: 'folded'; readonly shown: string; readonly tabbed: string; readonly order: readonly string[] }

export interface PaneWidths {
  readonly left: number
  readonly right: number
}

/** Where one pane draws: `left`/`width` in px from the frame's left edge, or the whole frame, or not at all. */
export type PaneSlot =
  | { readonly place: 'full' }
  | { readonly place: 'hidden' }
  | { readonly place: PaneSide; readonly left: number; readonly width: number }

const finiteArea = (area: number): number => (Number.isFinite(area) && area > 0 ? Math.floor(area) : 0)

/** Whether two panes fit side by side at this usable width (758 yes, 757 no). */
export function canArrange(area: number): boolean {
  return finiteArea(area) >= PANE_SPLIT_MIN_PX
}

/** The two panes' widths for a ratio, each clamped to ≥ 375 (the divider's 8 px between them). */
export function splitWidths(area: number, ratio: number): PaneWidths {
  const inner = finiteArea(area) - PANE_DIVIDER_PX
  const share = Number.isFinite(ratio) ? ratio : DEFAULT_PANE_RATIO
  const left = Math.min(Math.max(Math.round(inner * share), PANE_MIN_PX), inner - PANE_MIN_PX)

  return { left, right: inner - left }
}

/** A ratio kept inside the 375 / 375 limits for this width. */
export function clampRatio(area: number, ratio: number): number {
  const inner = finiteArea(area) - PANE_DIVIDER_PX

  if (inner < PANE_MIN_PX * 2) {
    return DEFAULT_PANE_RATIO
  }

  return splitWidths(area, ratio).left / inner
}

/** The ratio a divider dragged to `x` (px from the frame's left edge, the pointer on the divider's centre) asks for. */
export function ratioAt(area: number, x: number): number {
  const inner = finiteArea(area) - PANE_DIVIDER_PX

  if (inner <= 0) {
    return DEFAULT_PANE_RATIO
  }

  return clampRatio(area, (x - PANE_DIVIDER_PX / 2) / inner)
}

/** The width a pane alone on one half takes: half the frame, never under 375, never past the frame. */
export function soloWidth(area: number): number {
  const usable = finiteArea(area)

  return Math.min(usable, Math.max(PANE_MIN_PX, Math.round((usable - PANE_DIVIDER_PX) / 2)))
}

function focusedOf(state: PaneState): string {
  const { focused, open } = state

  return focused !== null && open.includes(focused) ? focused : open[open.length - 1]
}

/** The arrangement the panes take at this width, with these panes filled (expanded). */
export function arrangePanes(state: PaneState, area: number, expanded: readonly string[] = []): PaneArrangement {
  const { open } = state

  if (open.length === 0) {
    return { kind: 'none' }
  }

  if (open.length === 1) {
    return { kind: 'single', id: open[0], place: canArrange(area) || state.solo === 'full' ? state.solo : 'full' }
  }

  const [left, right] = open

  if (canArrange(area) && !expanded.includes(left) && !expanded.includes(right)) {
    return { kind: 'split', left, right, widths: splitWidths(area, state.ratio) }
  }

  const shown = focusedOf(state)

  return { kind: 'folded', shown, tabbed: shown === left ? right : left, order: open }
}

/** One pane's slot in an arrangement. */
export function slotFor(arrangement: PaneArrangement, id: string, area: number): PaneSlot {
  switch (arrangement.kind) {
    case 'none':
      return { place: 'full' }
    case 'single': {
      if (arrangement.id !== id || arrangement.place === 'full') {
        return { place: 'full' }
      }

      const width = soloWidth(area)

      return arrangement.place === 'left'
        ? { place: 'left', left: 0, width }
        : { place: 'right', left: finiteArea(area) - width, width }
    }

    case 'split': {
      const { left, right } = arrangement.widths

      if (id === arrangement.left) {
        return { place: 'left', left: 0, width: left }
      }

      if (id === arrangement.right) {
        return { place: 'right', left: left + PANE_DIVIDER_PX, width: right }
      }

      return { place: 'full' }
    }

    case 'folded':
      return id === arrangement.tabbed ? { place: 'hidden' } : { place: 'full' }
  }
}

export interface PaneOpen {
  readonly state: PaneState
  /** The pane that had to make room (it is closed by its owner), or null. */
  readonly replaced: null | string
}

/**
 * Open (or bring forward) a pane. Already open: it takes the focus. One open: the new one sits on the free side.
 * Two open: the new one takes the place of the pane WITHOUT focus (D4). `exclusive` names panes that can never sit
 * beside this one (they share one route: Message and Settings) — one of those, when open, is the one replaced.
 */
export function openPane(state: PaneState, id: string, exclusive: readonly string[] = []): PaneOpen {
  if (state.open.includes(id)) {
    return { state: { ...state, focused: id }, replaced: null }
  }

  const clash = state.open.find(open => exclusive.includes(open))

  if (clash !== undefined) {
    return {
      state: { ...state, open: state.open.map(open => (open === clash ? id : open)), focused: id },
      replaced: clash
    }
  }

  if (state.open.length === 0) {
    return { state: { ...state, open: [id], focused: id, solo: 'full' }, replaced: null }
  }

  if (state.open.length === 1) {
    // A pane resting on one half keeps it; the newcomer takes the other half.
    const open = state.solo === 'right' ? [id, state.open[0]] : [state.open[0], id]

    return { state: { ...state, open, focused: id, ratio: DEFAULT_PANE_RATIO }, replaced: null }
  }

  const keep = focusedOf(state)
  const replaced = state.open.find(open => open !== keep) ?? state.open[0]

  return {
    state: { ...state, open: state.open.map(open => (open === replaced ? id : open)), focused: id },
    replaced
  }
}

/** The same pane under a new id (the five EconomyOS windows share one chassis): its side and focus carry over. */
export function renamePane(state: PaneState, from: string, to: string): PaneState {
  if (!state.open.includes(from) || from === to) {
    return state.open.includes(to) ? state : openPane(state, to).state
  }

  if (state.open.includes(to)) {
    return closePane({ ...state, focused: to }, from)
  }

  return {
    ...state,
    open: state.open.map(open => (open === from ? to : open)),
    focused: state.focused === from ? to : state.focused
  }
}

export function closePane(state: PaneState, id: string): PaneState {
  if (!state.open.includes(id)) {
    return state
  }

  const open = state.open.filter(item => item !== id)

  // The pane left alone goes back to the whole frame: a half it never chose would look like a bug.
  return {
    open,
    focused: open.length === 0 ? null : state.focused === id || state.focused === null ? open[0] : state.focused,
    ratio: DEFAULT_PANE_RATIO,
    solo: 'full'
  }
}

export function focusPane(state: PaneState, id: string): PaneState {
  return state.open.includes(id) && state.focused !== id ? { ...state, focused: id } : state
}

/** Move left / Move right: two panes swap so `id` is on that side; one pane rests on that half. */
export function movePane(state: PaneState, id: string, side: PaneSide): PaneState {
  if (!state.open.includes(id)) {
    return state
  }

  if (state.open.length === 1) {
    return { ...state, solo: side, focused: id }
  }

  const other = state.open.find(open => open !== id) as string
  const open = side === 'left' ? [id, other] : [other, id]
  const swapped = open[0] !== state.open[0]

  // The divider stays where it was on screen: a swap mirrors the ratio.
  return { ...state, open, focused: id, ratio: swapped ? 1 - state.ratio : state.ratio }
}

/** Fill's way back (Arrange side by side) also puts a lone pane back on the whole frame. */
export function arrangeSideBySide(state: PaneState): PaneState {
  return state.open.length === 1 ? { ...state, solo: 'full' } : state
}

export function setRatio(state: PaneState, area: number, ratio: number): PaneState {
  const next = clampRatio(area, ratio)

  return next === state.ratio ? state : { ...state, ratio: next }
}

export function resetRatio(state: PaneState): PaneState {
  return state.ratio === DEFAULT_PANE_RATIO ? state : { ...state, ratio: DEFAULT_PANE_RATIO }
}

/** Which side of the pair a pane is on, or null alone / not open. */
export function sideOf(state: PaneState, id: string): null | PaneSide {
  if (state.open.length === 1) {
    return state.open[0] === id && state.solo !== 'full' ? state.solo : null
  }

  const at = state.open.indexOf(id)

  return at === 0 ? 'left' : at === 1 ? 'right' : null
}

// ── the divider, kept per pair ───────────────────────────────────────────────
// v0.0.9 F6 (owner, 18 Nov): the divider's place is remembered per PAIR of panes, so Message + Email comes back where
// the owner left it while Email + ACP Market keeps its own. Stored for the alphabetically first pane, so a swap (Move
// left / right) reads the same entry mirrored. A pair never stored opens at half and half.
//
// What is stored is WHERE THE OWNER LEFT IT, not a fraction of the width of the day: a divider left at a limit is
// stored as that limit ('min' / 'max' for the first pane), so "as wide as it goes" opens as wide as it goes on a
// wider window too (a fraction at 800 pt would open near half on 1900 pt). Anywhere between the limits it is the
// first pane's share. Written once per gesture (drag end, a key), never per pointer move.

/** The pair's key: the two ids, sorted, so the order on screen does not matter. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}+${b}` : `${b}+${a}`
}

/** A pair's stored place: the first pane's share (0..1), or that pane at its 375 pt minimum / at its maximum. */
export type PairPlace = 'max' | 'min' | number

type PairRatios = Readonly<Record<string, PairPlace>>

const isPairKey = (key: string): boolean => {
  const at = key.indexOf('+')

  return at > 0 && at < key.length - 1 && key.indexOf('+', at + 1) === -1
}

function readPairRatios(): PairRatios {
  const raw = readJson<unknown>(ICLONE_STORAGE.paneRatios.key)

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }

  const out: Record<string, PairPlace> = Object.create(null) as Record<string, PairPlace>

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPairKey(key)) {
      continue
    }

    if (
      value === 'min' ||
      value === 'max' ||
      (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1)
    ) {
      out[key] = value
    }
  }

  return out
}

/** The left pane's ratio for this pair as last left by the owner, or half and half. A limit reads as 0 / 1, which
 *  the layout clamps to exactly 375 pt / the window − 375 pt at any width. */
export function storedPairRatio(left: string, right: string): number {
  const place = readPairRatios()[pairKey(left, right)]

  if (place === undefined) {
    return DEFAULT_PANE_RATIO
  }

  const first = place === 'min' ? 0 : place === 'max' ? 1 : place

  return left < right ? first : 1 - first
}

/** The place a pair is left at, for the first (sorted) pane: a limit when the divider sits on one. */
export function pairPlaceOf(state: PaneState, area: number): null | PairPlace {
  if (state.open.length !== 2) {
    return null
  }

  const [left, right] = state.open
  const inner = Math.floor(area) - PANE_DIVIDER_PX

  // Back at the centre (within a pixel: an odd width cannot split exactly): forgotten.
  if (inner <= 0 || Math.abs(state.ratio - DEFAULT_PANE_RATIO) < 1 / inner) {
    return null
  }

  const widths = splitWidths(area, state.ratio)

  const leftEdge: 'max' | 'min' | null =
    inner >= PANE_MIN_PX * 2 && widths.left <= PANE_MIN_PX ? 'min' : widths.right <= PANE_MIN_PX ? 'max' : null

  if (left < right) {
    return leftEdge ?? state.ratio
  }

  return leftEdge === 'min' ? 'max' : leftEdge === 'max' ? 'min' : 1 - state.ratio
}

function rememberPairPlace(state: PaneState, area: number): void {
  // Only a pair side by side has a divider to leave somewhere; folded, nothing the owner did moved it.
  if (state.open.length !== 2 || !canArrange(area)) {
    return
  }

  const key = pairKey(state.open[0], state.open[1])
  const ratios: Record<string, PairPlace> = { ...readPairRatios() }
  const place = pairPlaceOf(state, area)

  if (place === null) {
    if (!(key in ratios)) {
      return
    }

    delete ratios[key]
  } else if (ratios[key] === place) {
    return
  } else {
    ratios[key] = place
  }

  writeJson(ICLONE_STORAGE.paneRatios.key, Object.keys(ratios).length > 0 ? ratios : null)
}

const pairOf = (state: PaneState): null | string =>
  state.open.length === 2 ? pairKey(state.open[0], state.open[1]) : null

// ── the store ────────────────────────────────────────────────────────────────

export const $panes = atom<PaneState>(INITIAL_PANES)
/** The frame's inner width in px, published by PaneLayer; 0 until measured (one pane fills, as before F6). */
export const $paneArea = atom<number>(0)

export const $paneArrangement = computed([$panes, $paneArea, $expandedWindows], (state, area, expanded) =>
  arrangePanes(state, area, expanded)
)

/** Every write of the store: a pair that just formed takes its remembered divider. */
function commit(next: PaneState): void {
  const prev = $panes.get()
  const pair = pairOf(next)

  if (pair !== null && pair !== pairOf(prev)) {
    next = { ...next, ratio: storedPairRatio(next.open[0], next.open[1]) }
  }

  $panes.set(next)
}

type ReplaceListener = (replaced: string, by: string) => void

const closers = new Map<string, () => void>()
const replaceListeners = new Set<ReplaceListener>()

/** The pane's own close, used when a newcomer takes its place. The window chassis keeps it current. */
export function setPaneCloser(id: string, close: (() => void) | null): void {
  if (close) {
    closers.set(id, close)
  } else {
    closers.delete(id)
  }
}

/** Told when a pane had to make room (the replace toast, pane-layer.tsx). */
export function onPaneReplaced(listener: ReplaceListener): () => void {
  replaceListeners.add(listener)

  return () => replaceListeners.delete(listener)
}

/** Panes that are routes (Message: the chat route; Settings: `/settings`): a route CHANGE swaps them by itself. */
export const ROUTE_PANES: readonly string[] = ['message', 'settings']

/**
 * v0.0.9 r2 (F6 spec gap): Settings open as a PANE rather than as its route — beside the Message window, or left
 * open when Message closed — so Message and Settings pair like any two Dock panes (max two, the 375/758 rules, the one
 * opacity, a × each, per-pair memory). Set by the Dock (a drop, the split menu, a click on the tile beside Message);
 * cleared by Settings' own close and when the `/settings` route takes Settings back (contrib/wiring.tsx).
 */
export const $settingsBesideMessage = atom(false)

/**
 * A placement decided before the pane exists: a Dock icon dropped on one side of the window (dock-split.ts). The
 * pane registers when its window mounts — a lazy window a few frames later — so the placement waits for it, for a
 * short while only.
 */
export interface PendingPlacement {
  readonly id: string
  /** The panes in screen order once the newcomer is in. */
  readonly open: readonly string[]
  /** The pane that makes room, or null. */
  readonly replaced: null | string
}

const PENDING_PLACEMENT_MS = 4000
let pending: null | (PendingPlacement & { readonly until: number }) = null

export function setPendingPlacement(placement: PendingPlacement | null, now: number = performance.now()): void {
  pending = placement === null ? null : { ...placement, until: now + PENDING_PLACEMENT_MS }
}

function takePending(id: string): null | PendingPlacement {
  const placed = pending

  if (placed === null || placed.id !== id || performance.now() > placed.until) {
    return null
  }

  pending = null

  return placed
}

/** The panes once a placed newcomer is in: its planned order, kept to the panes still open (the one making room goes). */
export function placePane(state: PaneState, placement: PendingPlacement): PaneState {
  const stays = (id: string) => id === placement.id || (id !== placement.replaced && state.open.includes(id))
  const open = placement.open.filter(stays)

  if (!open.includes(placement.id)) {
    return openPane(state, placement.id).state
  }

  return { open, focused: placement.id, ratio: DEFAULT_PANE_RATIO, solo: 'full' }
}

function makeRoom(replaced: string, by: string): void {
  // A route pane replaced by the other route pane leaves by itself (the route changed); every other one is closed by
  // its owner. Deferred: this runs inside a commit of the newcomer, and the owner's close sets state in another
  // component.
  // Settings as a pane (beside Message) is closed by its owner like any pane.
  const routeSwap = ROUTE_PANES.includes(replaced) && ROUTE_PANES.includes(by) && !$settingsBesideMessage.get()
  const close = routeSwap ? undefined : closers.get(replaced)

  queueMicrotask(() => {
    close?.()
    replaceListeners.forEach(listener => listener(replaced, by))
  })
}

export function registerPane(id: string): void {
  const placed = takePending(id)

  // The opening has been read (the window rendered): a later click-open follows the Settings size choice again.
  clearFramedOpening(id)

  if (placed !== null) {
    const before = $panes.get()

    commit(placePane(before, placed))

    if (placed.replaced !== null && before.open.includes(placed.replaced)) {
      makeRoom(placed.replaced, id)
    }

    return
  }

  // Message and Settings exclude each other only while Settings is its route (one route replaces the other); as a
  // pane beside Message they are two panes like any other pair.
  const exclusive = ROUTE_PANES.includes(id) && !$settingsBesideMessage.get() ? ROUTE_PANES : []
  const { replaced, state } = openPane($panes.get(), id, exclusive)

  commit(state)

  if (replaced !== null) {
    makeRoom(replaced, id)
  }
}

export function renameRegisteredPane(from: string, to: string): void {
  clearFramedOpening(to)

  // A chassis that takes the dropped kind (the econ window switching to another app) is the placed pane.
  const placed = takePending(to)

  commit(placed !== null ? placePane(renamePane($panes.get(), from, to), placed) : renamePane($panes.get(), from, to))
}

const paneName = (id: string): string => f6PaneNames[id as IcWindowId] ?? id

export function unregisterPane(id: string): void {
  const before = $panes.get()

  commit(closePane(before, id))

  // One of two closed (its ×, Esc): the other has the window now. Replaced panes left the pair already, so silent.
  const after = $panes.get()

  if (before.open.length === 2 && after.open.length === 1) {
    announcePanes(f6Split.closed(paneName(id), paneName(after.open[0])))
  }
}

/** A placement that will never be used (the dropped window could not open): forget it now, not in 4 s. */
export function clearPendingPlacement(id?: string): void {
  if (id === undefined || pending?.id === id) {
    pending = null
  }
}

export function focusRegisteredPane(id: string): void {
  commit(focusPane($panes.get(), id))
}

export function moveRegisteredPane(id: string, side: PaneSide): void {
  commit(movePane($panes.get(), id, side))
}

export function arrangeRegisteredPanes(): void {
  commit(arrangeSideBySide($panes.get()))
}

/**
 * The divider moved. The store follows at once (the panes move with the pointer); storage only when `persist` — a
 * key press, or the end of a drag (`persistPaneRatio`). Unchanged (parked past a limit): nothing at all.
 */
export function setPaneRatio(ratio: number, { persist = true }: { persist?: boolean } = {}): void {
  const before = $panes.get()
  const next = setRatio(before, $paneArea.get(), ratio)

  if (next !== before) {
    commit(next)
  }

  if (persist) {
    rememberPairPlace($panes.get(), $paneArea.get())
  }
}

/** The end of a divider drag: the pair remembers where it was left, once. */
export function persistPaneRatio(): void {
  rememberPairPlace($panes.get(), $paneArea.get())
}

/** Double-click (or Enter) on the divider: half and half, and the pair forgets its place. */
export function resetPaneRatio(): void {
  commit(resetRatio($panes.get()))
  rememberPairPlace($panes.get(), $paneArea.get())
}

/** Tests only: a clean slate. */
export function resetPanesForTests(): void {
  $panes.set(INITIAL_PANES)
  $paneArea.set(0)
  $settingsBesideMessage.set(false)
  closers.clear()
  replaceListeners.clear()
  pending = null
}
