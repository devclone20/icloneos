/**
 * v0.0.9 F6 · owner addition (18 Nov): drag a Dock icon onto the window to split it (PLANO_V009.md «F6 · Acrescento
 * do dono»), plus the r1 fix pass of the four lenses (drag, divider, chrome, a11y). Every case here fails on the code
 * before it: there was no drag, no preview, no keyboard split, no per-pair divider and one opacity control per pane.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ICLONE_STORAGE } from '@/app/home/lib/storage-keys'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { Dock, type DockItem } from '../dock'
import { $stagePlace } from '../stage3d-window/handover'

import {
  $dockDrag,
  $dockDrop,
  abandonDrop,
  beginDockDrag,
  canStartDockDrag,
  endDockDrag,
  type FrameRect,
  moveDockDrag,
  planDrop,
  planSide
} from './dock-split'
import { DockSplitPreview } from './dock-split-preview'
import { $expandedWindows, openFramed, useWindowExpanded } from './expanded'
import { IcWindow } from './ic-window'
import { $paneOpacity, resetPaneOpacityForTests } from './opacity'
import { $paneAnnouncement } from './pane-announce'
import { PaneLayer } from './pane-layer'
import {
  $paneArea,
  $paneArrangement,
  $panes,
  INITIAL_PANES,
  pairKey,
  PANE_DIVIDER_PX,
  PANE_MIN_PX,
  registerPane,
  resetPanesForTests,
  setPaneCloser,
  setPendingPlacement,
  slotFor,
  storedPairRatio,
  unregisterPane
} from './pane-layout'

const FRAME: FrameRect = { left: 100, top: 50, width: 1000, height: 700 }
const AREA = FRAME.width
const INNER = AREA - PANE_DIVIDER_PX
const LEFT_X = FRAME.left + 200
const RIGHT_X = FRAME.left + 800
const MID_Y = FRAME.top + 300
const RATIOS_KEY = ICLONE_STORAGE.paneRatios.key
const doc = () => window.document

const flush = () => act(async () => await Promise.resolve())
const preview = () => doc().querySelector<HTMLElement>('[data-ic-split-preview]')
const half = (side: string) => preview()?.querySelector<HTMLElement>(`[data-split-half="${side}"]`) ?? null
const said = () => $paneAnnouncement.get().text

function openPanes(...ids: string[]) {
  for (const id of ids) {
    registerPane(id)
  }
}

/** The pane registers when its window mounts: what HomeView's drop does next, in one step. */
function mountDropped(id: string) {
  registerPane(id)
}

function splitWidths() {
  const arrangement = $paneArrangement.get()

  return arrangement.kind === 'split' ? arrangement.widths : null
}

/** A probe on the frame, as the pane layer draws it (jsdom lays nothing out, so it reports FRAME). */
function mountProbe(frame: FrameRect = FRAME) {
  const probe = doc().createElement('div')

  probe.className = 'ic-pane-probe'
  doc().body.append(probe)
  vi.spyOn(probe, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        ...frame,
        right: frame.left + frame.width,
        bottom: frame.top + frame.height,
        x: frame.left,
        y: frame.top
      }) as DOMRect
  )

  return probe
}

beforeAll(() => {
  stubMenuDomApis()
  stubResizeObserver()
})

beforeEach(() => {
  window.localStorage.clear()
  resetPanesForTests()
  resetPaneOpacityForTests()
  $paneArea.set(AREA)
  $expandedWindows.set([])
  $dockDrag.set(null)
  $paneAnnouncement.set({ text: '', seq: 0 })
})

afterEach(() => {
  cleanup()
  $dockDrag.set(null)
  $stagePlace.set('docked')
  vi.restoreAllMocks()
  doc()
    .querySelectorAll('.ic-pane-probe')
    .forEach(node => node.remove())
})

describe('the preview follows the pointer', () => {
  it('one pane open: the side the new pane takes is the half the pointer is on, at the widths the drop gives', () => {
    openPanes('message')
    render(<DockSplitPreview />)

    act(() => beginDockDrag('email', LEFT_X, MID_Y, FRAME))
    expect(preview()!.dataset.plan).toBe('split')
    expect(preview()!.dataset.side).toBe('left')
    expect(half('left')!.dataset.role).toBe('incoming')
    expect(half('left')!.textContent).toBe('Email opens here')
    expect(half('right')!.textContent).toBe('Message stays')
    // Half and half for a pair never resized: 496 + 8 + 496.
    expect(half('left')!.style.width).toBe(`${INNER / 2}px`)

    act(() => moveDockDrag(RIGHT_X, MID_Y))
    expect(preview()!.dataset.side).toBe('right')
    expect(half('right')!.dataset.role).toBe('incoming')
    expect(half('left')!.dataset.role).toBe('keep')

    // Off the frame (over the Dock, out of the window): nothing would change, no halves are drawn.
    act(() => moveDockDrag(FRAME.left - 40, MID_Y))
    expect(preview()!.dataset.plan).toBe('outside')
    expect(preview()!.querySelector('[data-split-half]')).toBeNull()
  })

  it('the preview is a fixed, hit-transparent overlay outside the flow; its halves are absolute inside it', () => {
    openPanes('message')

    const { container } = render(
      <div data-testid="flow">
        <DockSplitPreview />
      </div>
    )

    expect(container.querySelector('[data-testid="flow"]')!.childElementCount).toBe(0)
    act(() => beginDockDrag('email', LEFT_X, MID_Y, FRAME))

    const layer = preview()!

    // Positioned by the element itself (not only by a stylesheet jsdom never loads): it can never join the flow.
    expect(getComputedStyle(layer).position).toBe('fixed')
    expect(getComputedStyle(layer).pointerEvents).toBe('none')
    expect([layer.style.left, layer.style.top, layer.style.width, layer.style.height]).toEqual([
      `${FRAME.left}px`,
      `${FRAME.top}px`,
      `${FRAME.width}px`,
      `${FRAME.height}px`
    ])
    expect(getComputedStyle(half('left')!).position).toBe('absolute')
    expect(getComputedStyle(half('right')!).position).toBe('absolute')
    expect(getComputedStyle(layer.querySelector('.ic-split-preview__chip')!).position).toBe('absolute')
    // The chip follows the pointer by a transform, never by left/top.
    expect(layer.querySelector<HTMLElement>('.ic-split-preview__chip')!.style.transform).toContain('translate3d')
    // Seen, not read: the always-mounted live region speaks for it.
    expect(layer.getAttribute('aria-hidden')).toBe('true')

    act(() => $dockDrag.set(null))
    expect(container.querySelector('[data-testid="flow"]')!.childElementCount).toBe(0)
  })

  it('a pane already open with nowhere to move: the preview says so instead of staying silent', () => {
    openPanes('message')
    render(<DockSplitPreview />)
    act(() => beginDockDrag('message', RIGHT_X, MID_Y, FRAME))

    expect(preview()!.dataset.plan).toBe('outside')
    expect(preview()!.dataset.reason).toBe('open')
    expect(preview()!.textContent).toContain('Message is already open')
  })

  it('a viewport change mid-drag reads the frame again', () => {
    openPanes('message')
    const probe = mountProbe()

    beginDockDrag('email', LEFT_X, MID_Y)
    expect($dockDrag.get()!.frame.left).toBe(FRAME.left)

    vi.spyOn(probe, 'getBoundingClientRect').mockReturnValue({ ...FRAME, left: 40 } as DOMRect)
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(window.innerWidth + 200)
    moveDockDrag(LEFT_X + 1, MID_Y)
    expect($dockDrag.get()!.frame.left).toBe(40)
  })
})

describe('drop, cancel, max two', () => {
  it('drop opens both panes half and half, the new one on the side dropped', () => {
    openPanes('message')
    act(() => beginDockDrag('email', RIGHT_X, MID_Y, FRAME))
    expect(endDockDrag(RIGHT_X, MID_Y).kind).toBe('split')
    mountDropped('email')
    expect($panes.get().open).toEqual(['message', 'email'])
    expect($panes.get().focused).toBe('email')
    expect(splitWidths()).toEqual({ left: INNER / 2, right: INNER / 2 })

    resetPanesForTests()
    $paneArea.set(AREA)
    openPanes('message')
    beginDockDrag('acp-market', LEFT_X, MID_Y, FRAME)
    endDockDrag(LEFT_X, MID_Y)
    mountDropped('acp-market')
    expect($panes.get().open).toEqual(['acp-market', 'message'])
  })

  it('a release outside the frame — or outside the window (negative, past the viewport) — cancels', () => {
    openPanes('message')

    for (const [x, y] of [
      [FRAME.left + FRAME.width + 30, MID_Y],
      [-20, MID_Y],
      [RIGHT_X, -5],
      [RIGHT_X, 99_999]
    ]) {
      beginDockDrag('email', RIGHT_X, MID_Y, FRAME)
      expect(endDockDrag(x, y).kind).toBe('outside')
      expect($dockDrag.get()).toBeNull()
      expect(said()).toBe('Split cancelled')
    }

    // Nothing waits for the pane: a later click opens it where a click puts it.
    registerPane('email')
    expect($panes.get().open).toEqual(['message', 'email'])
  })

  it('Esc cancels the drag, the home never sees that Esc, and the Esc listener is gone afterwards', () => {
    openPanes('message')
    const homeEscape = vi.fn()

    window.addEventListener('keydown', homeEscape)
    render(<DockSplitPreview />)
    act(() => beginDockDrag('email', RIGHT_X, MID_Y, FRAME))
    expect(preview()).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect($dockDrag.get()).toBeNull()
    expect(preview()).toBeNull()
    expect(homeEscape).not.toHaveBeenCalled()
    expect(said()).toBe('Split cancelled')
    expect($panes.get().open).toEqual(['message'])

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(homeEscape).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', homeEscape)
  })

  // v0.0.9 r4c (critic-r4 02d): Esc during a drag over a PAIR changes nothing — the pair, its order, no pane filled,
  // and the release that still follows is not a drop. (A drag already ended by the window's blur is a plain Esc.)
  it('Esc over a Message + Settings pair keeps exactly the layout before the drag', () => {
    openPanes('message', 'settings')
    const before = { open: [...$panes.get().open], arrangement: $paneArrangement.get(), expanded: $expandedWindows.get() }
    const homeEscape = vi.fn()

    window.addEventListener('keydown', homeEscape)
    act(() => beginDockDrag('email', RIGHT_X, MID_Y, FRAME))
    act(() => moveDockDrag(LEFT_X, MID_Y))
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyUp(window, { key: 'Escape' })
    const released = endDockDrag(LEFT_X, MID_Y)

    expect(released.kind).toBe('outside')
    expect(homeEscape).not.toHaveBeenCalled()
    expect($panes.get().open).toEqual(before.open)
    expect($paneArrangement.get()).toEqual(before.arrangement)
    expect($expandedWindows.get()).toEqual(before.expanded)
    window.removeEventListener('keydown', homeEscape)
  })

  it('a drag the window blur already ended leaves the next Esc to the home (what a blurred harness window sees)', () => {
    openPanes('message', 'settings')
    const homeEscape = vi.fn()

    window.addEventListener('keydown', homeEscape)
    act(() => beginDockDrag('email', RIGHT_X, MID_Y, FRAME))
    fireEvent.blur(window)
    expect($dockDrag.get()).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(homeEscape).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', homeEscape)
  })

  it('two begins in a row leave ONE Esc listener; after a drop a later Esc reaches the home', () => {
    openPanes('message')
    const homeEscape = vi.fn()

    window.addEventListener('keydown', homeEscape)
    beginDockDrag('email', RIGHT_X, MID_Y, FRAME)
    beginDockDrag('email', RIGHT_X, MID_Y, FRAME)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect($dockDrag.get()).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(homeEscape).toHaveBeenCalledTimes(1)

    beginDockDrag('email', RIGHT_X, MID_Y, FRAME)
    endDockDrag(RIGHT_X, MID_Y)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(homeEscape).toHaveBeenCalledTimes(2)
    window.removeEventListener('keydown', homeEscape)
  })

  it('the window losing focus cancels the drag', () => {
    openPanes('message')
    beginDockDrag('email', RIGHT_X, MID_Y, FRAME)
    fireEvent.blur(window)
    expect($dockDrag.get()).toBeNull()
    expect(said()).toBe('Split cancelled')
  })

  it('max two: with two open, the drop replaces the pane on the side dropped, and the preview says so', async () => {
    openPanes('message', 'email')
    const closeMessage = vi.fn()
    const closeEmail = vi.fn()

    setPaneCloser('message', closeMessage)
    setPaneCloser('email', closeEmail)
    render(<DockSplitPreview />)

    act(() => beginDockDrag('acp-market', LEFT_X, MID_Y, FRAME))
    expect(half('left')!.textContent).toBe('ACP Market replaces Message')
    expect(half('right')!.textContent).toBe('Email stays')

    act(() => moveDockDrag(RIGHT_X, MID_Y))
    expect(half('right')!.textContent).toBe('ACP Market replaces Email')

    act(() => moveDockDrag(LEFT_X, MID_Y))
    act(() => void endDockDrag(LEFT_X, MID_Y))
    mountDropped('acp-market')
    await flush()

    expect($panes.get().open).toEqual(['acp-market', 'email'])
    // Message is a route pane replaced by a non-route one: its own close runs (it used to stay drawn as a third).
    expect(closeMessage).toHaveBeenCalledTimes(1)
    expect(closeEmail).not.toHaveBeenCalled()
    expect($panes.get().focused).toBe('acp-market')
  })

  it('every combination: any pane beside any other, never more than two', () => {
    const panes = ['message', 'email', 'settings', 'acp-market', 'wallet', 'bank-card', 'hyperliquid', 'containers']

    for (const first of panes) {
      for (const second of panes) {
        if (first === second) {
          continue
        }

        resetPanesForTests()
        $paneArea.set(AREA)
        openPanes(first)
        beginDockDrag(second, RIGHT_X, MID_Y, FRAME)
        const plan = endDockDrag(RIGHT_X, MID_Y)

        mountDropped(second)
        const open = $panes.get().open

        expect(open.length).toBeLessThanOrEqual(2)
        expect(open).toContain(second)

        // v0.0.9 r2 (F6 spec: any pane type): EVERY pair sits side by side — Message and Settings included.
        expect(plan.kind).toBe('split')
        expect(open).toEqual([first, second])
      }
    }
  })

  it('a pane already open moves to the side it is dropped on, at exactly the widths the preview drew', () => {
    openPanes('message', 'email')
    $panes.set({ ...$panes.get(), ratio: 0.3 })
    beginDockDrag('email', LEFT_X, MID_Y, FRAME)

    const shown = $dockDrop.get()
    const promised = shown?.kind === 'move' ? shown.widths : null

    expect(endDockDrag(LEFT_X, MID_Y).kind).toBe('move')
    expect($panes.get().open).toEqual(['email', 'message'])
    expect(splitWidths()).toEqual(promised)
    expect(said()).toBe('Email moved to the left')
  })

  it('tabs (< 758 pt): the drop replaces the pane on screen, whatever half the pointer is on', () => {
    $paneArea.set(700)
    openPanes('message', 'email')
    $panes.set({ ...$panes.get(), focused: 'email' })

    const plan = planDrop($panes.get(), 700, { ...FRAME, width: 700 }, 'acp-market', FRAME.left + 10, MID_Y)

    expect(plan).toMatchObject({ kind: 'tab', replaced: 'email', keep: 'message' })
  })

  it('a placement that waited longer than 4 s does not hijack a later click-open', () => {
    openPanes('message')
    setPendingPlacement({ id: 'email', open: ['email', 'message'], replaced: null }, performance.now() - 5000)
    registerPane('email')
    // The click's own rule (the newcomer on the free side), not the stale left-side placement.
    expect($panes.get().open).toEqual(['message', 'email'])
  })

  it('a drop whose window could not open leaves nothing waiting (no placement, no framed opening)', () => {
    openPanes('message')
    beginDockDrag('email', LEFT_X, MID_Y, FRAME)
    abandonDrop(endDockDrag(LEFT_X, MID_Y))
    registerPane('email')
    expect($panes.get().open).toEqual(['message', 'email'])

    openFramed('wallet')
    abandonDrop({
      kind: 'split',
      incoming: 'wallet',
      keep: 'message',
      replaced: null,
      side: 'left',
      widths: { left: 1, right: 1 }
    })

    function Probe() {
      return <span data-expanded={String(useWindowExpanded('wallet').expanded)} />
    }

    const { container } = render(<Probe />)

    // Opens as Settings says (maximized by default), not framed by a drop that never happened.
    expect(container.querySelector('span')!.dataset.expanded).toBe('true')
  })
})

describe('the divider', () => {
  function renderSplit() {
    openPanes('message', 'email')
    const probe = mountProbe()

    render(<PaneLayer />)
    // The probe is measured from the mocked box: the frame's width.
    act(() => $paneArea.set(AREA))

    return { divider: screen.getByRole('separator', { name: 'Resize the two windows' }), probe }
  }

  it('bounds: each pane ≥ 375 pt, so a pane is at most the window − 375 (and the divider)', () => {
    const { divider } = renderSplit()

    fireEvent.keyDown(divider, { key: 'End' })
    expect(Number(divider.getAttribute('aria-valuenow'))).toBe(INNER - PANE_MIN_PX)
    expect(Number(divider.getAttribute('aria-valuemax'))).toBe(INNER - PANE_MIN_PX)

    for (let i = 0; i < 5; i++) {
      fireEvent.keyDown(divider, { key: 'ArrowRight' })
    }

    expect(splitWidths()).toEqual({ left: INNER - PANE_MIN_PX, right: PANE_MIN_PX })
    fireEvent.keyDown(divider, { key: 'Home' })
    expect(splitWidths()).toEqual({ left: PANE_MIN_PX, right: INNER - PANE_MIN_PX })
    expect(Number(divider.getAttribute('aria-valuemin'))).toBe(PANE_MIN_PX)
  })

  it('the pointer drags it: capture, past both limits, no jump on the first move, ONE storage write per drag', () => {
    const { divider } = renderSplit()
    const writes = vi.spyOn(window.localStorage, 'setItem')
    const seam = FRAME.left + INNER / 2 + PANE_DIVIDER_PX / 2
    const capture = vi.spyOn(divider, 'setPointerCapture')

    // Grabbed 3 px right of the seam's centre: the first move by 0 px moves nothing.
    fireEvent.pointerDown(divider, { button: 0, clientX: seam + 3, pointerId: 4 })
    expect(capture).toHaveBeenCalledWith(4)
    fireEvent.pointerMove(divider, { clientX: seam + 3, pointerId: 4 })
    expect(splitWidths()).toEqual({ left: INNER / 2, right: INNER / 2 })

    fireEvent.pointerMove(divider, { clientX: seam + 3 + 40, pointerId: 4 })
    expect(splitWidths()!.left).toBe(INNER / 2 + 40)

    // Far past each limit, many moves: clamped, and still nothing written.
    for (let x = 0; x < 30; x++) {
      fireEvent.pointerMove(divider, { clientX: 5000 + x, pointerId: 4 })
    }

    expect(splitWidths()).toEqual({ left: INNER - PANE_MIN_PX, right: PANE_MIN_PX })

    for (let x = 0; x < 30; x++) {
      fireEvent.pointerMove(divider, { clientX: -5000 - x, pointerId: 4 })
    }

    expect(splitWidths()).toEqual({ left: PANE_MIN_PX, right: INNER - PANE_MIN_PX })
    expect(writes.mock.calls.filter(([key]) => key === RATIOS_KEY)).toHaveLength(0)

    // Another pointer cannot steal it.
    fireEvent.pointerMove(divider, { clientX: seam, pointerId: 9 })
    expect(splitWidths()!.left).toBe(PANE_MIN_PX)

    fireEvent.pointerUp(divider, { clientX: -5000, pointerId: 4 })
    expect(writes.mock.calls.filter(([key]) => key === RATIOS_KEY)).toHaveLength(1)

    // A lost capture ends a drag the same way (once).
    fireEvent.pointerDown(divider, { button: 0, clientX: FRAME.left + PANE_MIN_PX + 4, pointerId: 5 })
    fireEvent.pointerMove(divider, { clientX: FRAME.left + 600, pointerId: 5 })
    fireEvent(divider, new Event('lostpointercapture', { bubbles: true }))
    // jsdom's lost capture carries no pointerId: the up ends it instead.
    fireEvent.pointerUp(divider, { pointerId: 5 })
    expect(writes.mock.calls.filter(([key]) => key === RATIOS_KEY)).toHaveLength(2)
  })

  it('keyboard: an accessible separator; ← / → move it 16 pt, it reads both widths, the pair remembers where', () => {
    const { divider } = renderSplit()

    expect(divider.getAttribute('aria-orientation')).toBe('vertical')
    expect(divider.tabIndex).toBe(0)
    expect(divider.getAttribute('aria-keyshortcuts')).toBe('ArrowLeft ArrowRight Home End Enter')
    expect(divider.getAttribute('aria-valuetext')).toBe(`Message ${INNER / 2} points, Email ${INNER / 2} points`)
    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(Number(divider.getAttribute('aria-valuenow'))).toBe(INNER / 2 + 16)
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(Number(divider.getAttribute('aria-valuenow'))).toBe(INNER / 2 - 16)

    const stored = JSON.parse(window.localStorage.getItem(RATIOS_KEY) ?? '{}') as Record<string, number>

    expect(stored[pairKey('message', 'email')]).toBeCloseTo(1 - (INNER / 2 - 16) / INNER, 6)

    // Parked on a limit, a key that changes nothing writes nothing.
    fireEvent.keyDown(divider, { key: 'Home' })
    const writes = vi.spyOn(window.localStorage, 'setItem')

    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    fireEvent.keyDown(divider, { key: 'Home' })
    expect(writes.mock.calls.filter(([key]) => key === RATIOS_KEY)).toHaveLength(0)
  })

  it('double-click resets half and half, and the pair forgets its place (also a drag back to the centre)', () => {
    const { divider } = renderSplit()

    fireEvent.keyDown(divider, { key: 'End' })
    expect(window.localStorage.getItem(RATIOS_KEY)).not.toBeNull()
    fireEvent.doubleClick(divider)
    expect(Number(divider.getAttribute('aria-valuenow'))).toBe(INNER / 2)
    expect(window.localStorage.getItem(RATIOS_KEY)).toBeNull()

    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(window.localStorage.getItem(RATIOS_KEY)).toBeNull()
  })

  it('kept per pair: the same pair comes back where it was left, mirrored if swapped; others at half', () => {
    const { divider } = renderSplit()

    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    const left = INNER / 2 - 32

    act(() => unregisterPane('email'))
    act(() => beginDockDrag('email', RIGHT_X, MID_Y, FRAME))
    const shown = $dockDrop.get()

    expect(shown?.kind === 'split' ? shown.widths.left : null).toBe(left)
    act(() => void endDockDrag(RIGHT_X, MID_Y))
    act(() => mountDropped('email'))
    expect(Number(screen.getByRole('separator').getAttribute('aria-valuenow'))).toBe(left)
    expect(storedPairRatio('email', 'message')).toBeCloseTo(1 - left / INNER, 6)

    act(() => unregisterPane('email'))
    act(() => beginDockDrag('acp-market', RIGHT_X, MID_Y, FRAME))
    act(() => void endDockDrag(RIGHT_X, MID_Y))
    act(() => mountDropped('acp-market'))
    expect(Number(screen.getByRole('separator').getAttribute('aria-valuenow'))).toBe(INNER / 2)
  })

  it('a divider left AT a limit comes back at that limit on a wider window (not as a fraction of the old width)', () => {
    $paneArea.set(800)
    openPanes('message', 'email')
    render(<PaneLayer />)
    act(() => $paneArea.set(800))
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'End' })
    // Message on the right limit = Email (the sorted-first pane) at its 375 pt minimum.
    expect(JSON.parse(window.localStorage.getItem(RATIOS_KEY)!)).toEqual({ [pairKey('message', 'email')]: 'min' })

    act(() => unregisterPane('email'))
    act(() => $paneArea.set(1900))
    act(() => registerPane('email'))
    expect(splitWidths()).toEqual({ left: 1900 - PANE_DIVIDER_PX - PANE_MIN_PX, right: PANE_MIN_PX })

    // Shrink and grow with the pair open: the place holds through a fold.
    act(() => $paneArea.set(700))
    expect($paneArrangement.get().kind).toBe('folded')
    act(() => $paneArea.set(1500))
    expect(splitWidths()).toEqual({ left: 1500 - PANE_DIVIDER_PX - PANE_MIN_PX, right: PANE_MIN_PX })
  })

  it('survives a restart (only the stores reset, storage kept) and ignores corrupt or hostile stored data', () => {
    window.localStorage.setItem(RATIOS_KEY, JSON.stringify({ [pairKey('email', 'message')]: 0.4 }))
    resetPanesForTests()
    $paneArea.set(AREA)
    openPanes('email', 'message')
    expect($panes.get().ratio).toBeCloseTo(0.4, 6)

    for (const raw of [
      'not json',
      '[0.3]',
      '{"email+message":0}',
      '{"email+message":1}',
      '{"email+message":-1}',
      '{"email+message":"0.4"}',
      '{"email+message":null}',
      '{"+":0.3}',
      '{"email+":0.3}',
      '{"a+b+c":0.3}',
      '{"__proto__":{"email+message":0.3}}'
    ]) {
      window.localStorage.setItem(RATIOS_KEY, raw)
      expect(storedPairRatio('email', 'message')).toBe(0.5)
    }

    // A hostile key is only a key: nothing reaches the prototypes.
    window.localStorage.setItem(RATIOS_KEY, '{"__proto__+x":0.3,"constructor+prototype":0.2}')
    expect(storedPairRatio('__proto__', 'x')).toBeCloseTo(0.3, 6)
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })
})

describe('narrow windows', () => {
  it('below 758 pt usable the drop makes two tabs (the preview says so), and they unfold when wide again', () => {
    openPanes('message')
    $paneArea.set(700)
    render(<DockSplitPreview />)

    act(() => beginDockDrag('email', FRAME.left + 600, MID_Y, { ...FRAME, width: 700 }))
    expect(preview()!.dataset.plan).toBe('tab')
    expect(preview()!.textContent).toContain('Email opens as a tab beside Message')
    expect(half('left')).toBeNull()

    act(() => void endDockDrag(FRAME.left + 600, MID_Y))
    mountDropped('email')
    expect($paneArrangement.get()).toMatchObject({ kind: 'folded', shown: 'email', tabbed: 'message' })

    $paneArea.set(758)
    expect($paneArrangement.get().kind).toBe('split')
  })

  it('757 folds, 758 splits (the plan reads the same rule as the layout)', () => {
    const state = { ...INITIAL_PANES, open: ['message'], focused: 'message' }
    const frame = (width: number) => ({ ...FRAME, width })

    expect(planDrop(state, 757, frame(757), 'email', FRAME.left + 600, MID_Y).kind).toBe('tab')
    expect(planDrop(state, 758, frame(758), 'email', FRAME.left + 600, MID_Y).kind).toBe('split')
  })
})

describe('the Dock drives the drag', () => {
  function renderDock(ids: string[] = ['email']) {
    const onSelect = vi.fn()
    const onDrop = vi.fn()

    mountProbe()

    const items: DockItem[] = ids.map(id => ({
      id,
      label: id === 'email' ? 'Email' : id === 'wallet' ? 'Wallet' : 'Message',
      icon: id[0],
      onSelect: () => onSelect(id),
      split: { pane: id === 'chat' ? 'message' : id, onDrop: plan => onDrop(id, plan) }
    }))

    const view = render(
      <>
        <Dock items={items} />
        <DockSplitPreview />
      </>
    )

    return { onDrop, onSelect, tile: (name = 'Email') => screen.getByRole('button', { name }), view }
  }

  it('press, drag past the slop onto the window, release: the drop opens the pane (never a click)', () => {
    openPanes('message')
    const { onDrop, onSelect, tile } = renderDock()

    fireEvent.pointerDown(tile(), { button: 0, clientX: 20, clientY: 300, pointerId: 1 })
    fireEvent.pointerMove(tile(), { clientX: 22, clientY: 301, pointerId: 1 })
    expect($dockDrag.get()).toBeNull()

    fireEvent.pointerMove(tile(), { clientX: RIGHT_X, clientY: MID_Y, pointerId: 1 })
    expect(preview()!.dataset.side).toBe('right')
    expect(tile().dataset.dragging).toBe('')

    fireEvent.pointerUp(tile(), { button: 0, clientX: RIGHT_X, clientY: MID_Y, pointerId: 1 })
    expect(onDrop).toHaveBeenCalledWith(
      'email',
      expect.objectContaining({ kind: 'split', incoming: 'email', side: 'right' })
    )
    expect(onSelect).not.toHaveBeenCalled()
    expect(tile().dataset.dragging).toBeUndefined()
    expect(said()).toBe('Email opens beside Message')
  })

  it('Esc mid-drag: the tile stops looking dragged at once; the release opens nothing and selects nothing', () => {
    openPanes('message')
    const { onDrop, onSelect, tile } = renderDock()

    fireEvent.pointerDown(tile(), { button: 0, clientX: 20, clientY: 300, pointerId: 1 })
    fireEvent.pointerMove(tile(), { clientX: RIGHT_X, clientY: MID_Y, pointerId: 1 })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(tile().dataset.dragging).toBeUndefined()
    expect(tile().dataset.pressed).toBeUndefined()

    fireEvent.pointerUp(tile(), { button: 0, clientX: RIGHT_X, clientY: MID_Y, pointerId: 1 })
    expect(onDrop).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    expect($panes.get().open).toEqual(['message'])
  })

  it('pointercancel and a lost capture mid-drag cancel it and clear the tile', () => {
    openPanes('message')
    const { onDrop, tile } = renderDock()

    fireEvent.pointerDown(tile(), { button: 0, clientX: 20, clientY: 300, pointerId: 1 })
    fireEvent.pointerMove(tile(), { clientX: RIGHT_X, clientY: MID_Y, pointerId: 1 })
    fireEvent.pointerCancel(tile(), { pointerId: 1 })
    expect($dockDrag.get()).toBeNull()
    expect(tile().dataset.dragging).toBeUndefined()

    fireEvent.pointerDown(tile(), { button: 0, clientX: 20, clientY: 300, pointerId: 2 })
    fireEvent.pointerMove(tile(), { clientX: RIGHT_X, clientY: MID_Y, pointerId: 2 })
    fireEvent(tile(), Object.assign(new Event('lostpointercapture', { bubbles: true }), { pointerId: 2 }))
    expect($dockDrag.get()).toBeNull()
    expect(tile().dataset.dragging).toBeUndefined()
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('a Dock that unmounts mid-drag leaves no preview behind', () => {
    openPanes('message')
    const { tile, view } = renderDock()

    fireEvent.pointerDown(tile(), { button: 0, clientX: 20, clientY: 300, pointerId: 1 })
    fireEvent.pointerMove(tile(), { clientX: RIGHT_X, clientY: MID_Y, pointerId: 1 })
    view.unmount()
    expect($dockDrag.get()).toBeNull()
  })

  it('a second pointer mid-drag is ignored: no select on its release, the first one still drops', () => {
    openPanes('message')
    const { onDrop, onSelect, tile } = renderDock(['email', 'wallet'])

    fireEvent.pointerDown(tile(), { button: 0, clientX: 20, clientY: 300, pointerId: 1 })
    fireEvent.pointerMove(tile(), { clientX: RIGHT_X, clientY: MID_Y, pointerId: 1 })
    fireEvent.pointerDown(tile('Wallet'), { button: 0, clientX: 20, clientY: 360, pointerId: 2 })
    fireEvent.pointerUp(tile('Wallet'), { button: 0, clientX: 20, clientY: 360, pointerId: 2 })
    expect(onSelect).not.toHaveBeenCalled()
    expect($dockDrag.get()).not.toBeNull()

    fireEvent.pointerMove(tile(), { clientX: LEFT_X, clientY: MID_Y, pointerId: 1 })
    expect(preview()!.dataset.side).toBe('left')
    fireEvent.pointerUp(tile(), { button: 0, clientX: LEFT_X, clientY: MID_Y, pointerId: 1 })
    expect(onDrop).toHaveBeenCalledWith('email', expect.objectContaining({ side: 'left' }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('no drag when nothing is open, nor when the only open pane is the dragged one (a jittery click still toggles)', () => {
    const { onSelect, tile } = renderDock()

    fireEvent.pointerDown(tile(), { button: 0, clientX: 20, clientY: 300, pointerId: 1 })
    fireEvent.pointerMove(tile(), { clientX: RIGHT_X, clientY: MID_Y, pointerId: 1 })
    expect($dockDrag.get()).toBeNull()
    fireEvent.pointerUp(tile(), { button: 0, clientX: RIGHT_X, clientY: MID_Y, pointerId: 1 })

    act(() => openPanes('email'))
    expect(canStartDockDrag('email')).toBe(false)
    fireEvent.pointerDown(tile(), { button: 0, clientX: 0, clientY: 0, pointerId: 3 })
    fireEvent.pointerMove(tile(), { clientX: 8, clientY: 0, pointerId: 3 })
    expect($dockDrag.get()).toBeNull()
    fireEvent.pointerUp(tile(), { button: 0, clientX: 8, clientY: 0, pointerId: 3 })
    expect(onSelect).toHaveBeenCalledWith('email')

    // Folded (< 758) and open: it cannot trade sides either.
    act(() => openPanes('message'))
    act(() => $paneArea.set(700))
    expect(canStartDockDrag('email')).toBe(false)
    act(() => $paneArea.set(AREA))
    expect(canStartDockDrag('email')).toBe(true)
  })
})

describe('the keyboard split (the Dock tile menu)', () => {
  function renderDock() {
    const onDrop = vi.fn()
    const escapes = vi.fn()

    // The home's Escape router, as a bubble listener on the window: it hears every Esc that is not swallowed.
    const homeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        escapes()
      }
    }

    window.addEventListener('keydown', homeEscape)

    render(
      <Dock
        items={[
          {
            id: 'email',
            label: 'Email',
            icon: 'e',
            onSelect: () => undefined,
            split: { pane: 'email', onDrop }
          }
        ]}
      />
    )

    return {
      cleanupEscape: () => window.removeEventListener('keydown', homeEscape),
      homeEscape: escapes,
      onDrop,
      tile: screen.getByRole('button', { name: 'Email' })
    }
  }

  it('Shift+Enter on the tile opens a menu; "Open on the right" gives the same panes as a drop there', () => {
    openPanes('message')
    const { cleanupEscape, onDrop, tile } = renderDock()

    expect(tile.getAttribute('aria-haspopup')).toBe('menu')
    expect(tile.getAttribute('aria-keyshortcuts')).toBe('Shift+Enter')
    tile.focus()
    fireEvent.keyDown(tile, { key: 'Enter', shiftKey: true })

    const menu = screen.getByRole('menu', { name: 'Open Email beside' })
    const items = screen.getAllByRole('menuitem')

    expect(items.map(item => item.textContent)).toEqual(['Open on the left', 'Open on the right'])
    expect(doc().activeElement).toBe(items[0])
    fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    expect(doc().activeElement).toBe(items[1])
    fireEvent.keyDown(items[1], { key: 'ArrowDown' })
    expect(doc().activeElement).toBe(items[0])
    fireEvent.keyDown(items[0], { key: 'End' })
    fireEvent.click(doc().activeElement as HTMLElement)

    expect(menu.isConnected).toBe(false)
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ kind: 'split', side: 'right' }))
    mountDropped('email')
    expect($panes.get().open).toEqual(['message', 'email'])
    cleanupEscape()
  })

  it('the menu names what a side replaces, Esc closes it back to the tile and never reaches the home', () => {
    openPanes('message', 'wallet')
    const { cleanupEscape, homeEscape, onDrop, tile } = renderDock()

    tile.focus()
    fireEvent.keyDown(tile, { key: 'F10', shiftKey: true })
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Open on the leftreplaces Message',
      'Open on the rightreplaces Wallet'
    ])

    fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(homeEscape).not.toHaveBeenCalled()
    expect(doc().activeElement).toBe(tile)
    expect(onDrop).not.toHaveBeenCalled()
    cleanupEscape()
  })

  it('a right-click opens it too; an already-open pane with nowhere to move is listed, disabled', () => {
    openPanes('email', 'message')
    $paneArea.set(700)
    const { cleanupEscape, onDrop, tile } = renderDock()

    fireEvent.contextMenu(tile)
    const [only] = screen.getAllByRole('menuitem')

    expect(only.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(only)
    expect(onDrop).not.toHaveBeenCalled()
    cleanupEscape()
  })

  it('planSide reads the same rules as a drop on that half (all sides, all pairs)', () => {
    openPanes('message', 'email')

    expect(planSide($panes.get(), AREA, 'wallet', 'left')).toMatchObject({ kind: 'split', replaced: 'message' })
    expect(planSide($panes.get(), AREA, 'wallet', 'right')).toMatchObject({ kind: 'split', replaced: 'email' })
    // Settings is a pane like the others (r2): it replaces the pane on the side it goes to, never Message by route.
    expect(planSide($panes.get(), AREA, 'settings', 'right')).toMatchObject({ kind: 'split', replaced: 'email' })
    expect(planSide($panes.get(), AREA, 'settings', 'left')).toMatchObject({ kind: 'split', replaced: 'message' })
  })
})

describe('two panes side by side', () => {
  const LABELS = { close: 'Close', expand: 'Expand', retract: 'Retract', opacity: 'Opacity' }

  function TwoPanes({ open, onClose }: { open: { email: boolean; wallet: boolean }; onClose?: (id: string) => void }) {
    return (
      <>
        {(['email', 'wallet'] as const)
          .filter(id => open[id])
          .map(id => (
            <IcWindow
              expanded={false}
              head={null}
              id={id}
              key={id}
              label={id}
              labels={{ ...LABELS, close: `Close ${id}` }}
              onClose={() => onClose?.(id)}
              onToggleExpanded={() => undefined}
              placement="self"
            />
          ))}
      </>
    )
  }

  const plate = (id: string) =>
    doc().querySelector<HTMLElement>(`[data-ic-window="${id}"] .ic-win__plate`) as HTMLElement

  it('ONE transparency control, and it fades both panes, up and down', () => {
    render(<TwoPanes open={{ email: true, wallet: true }} />)
    expect($paneArrangement.get().kind).toBe('split')

    const sliders = screen.getAllByRole('slider')

    expect(sliders).toHaveLength(1)
    expect(sliders[0].getAttribute('aria-label')).toBe('Opacity of both windows')
    expect(sliders[0].closest('[data-ic-window]')!.getAttribute('data-ic-window')).toBe('wallet')

    fireEvent.keyDown(sliders[0], { key: 'ArrowDown' })
    fireEvent.keyDown(sliders[0], { key: 'ArrowDown' })
    expect(Number(plate('email').style.opacity)).toBeCloseTo(0.8, 6)
    expect(Number(plate('wallet').style.opacity)).toBeCloseTo(0.8, 6)

    fireEvent.keyDown(sliders[0], { key: 'ArrowUp' })
    expect(Number(plate('email').style.opacity)).toBeCloseTo(0.9, 6)
    expect(Number(plate('wallet').style.opacity)).toBeCloseTo(0.9, 6)
    expect($paneOpacity.get()).toBeCloseTo(0.9, 6)
  })

  it('the Message window (under the shells) follows the same one control: its <html> opacity vars', () => {
    render(
      <>
        <IcWindow
          expanded={false}
          head={null}
          headBand="40px"
          id="message"
          labels={LABELS}
          onClose={() => undefined}
          onToggleExpanded={() => undefined}
          placement="under-shell"
        />
        <TwoPanes open={{ email: true, wallet: false }} />
      </>
    )

    const root = doc().documentElement
    const [slider] = screen.getAllByRole('slider')

    expect(screen.getAllByRole('slider')).toHaveLength(1)
    fireEvent.keyDown(slider, { key: 'End' })
    expect(Number(root.style.getPropertyValue('--iclone-msg-opacity'))).toBeCloseTo(
      Number(plate('email').style.opacity),
      3
    )
    fireEvent.keyDown(slider, { key: 'Home' })
    expect(root.style.getPropertyValue('--iclone-msg-opacity')).toBe('1.000')
    expect(root.style.getPropertyValue('--iclone-msg-pe')).toBe('auto')
  })

  it('each pane has its own × inside it: closing the RIGHT one (which holds the control) gives the left the frame', () => {
    const onClose = vi.fn()
    const view = render(<TwoPanes onClose={onClose} open={{ email: true, wallet: true }} />)

    const walletClose = screen.getByRole('button', { name: 'Close wallet' })

    expect(
      screen.getByRole('button', { name: 'Close email' }).closest('[data-ic-window]')!.getAttribute('data-ic-window')
    ).toBe('email')
    expect(walletClose.closest('[data-ic-window]')!.getAttribute('data-ic-window')).toBe('wallet')
    fireEvent.click(walletClose)
    expect(onClose).toHaveBeenCalledWith('wallet')

    view.rerender(<TwoPanes onClose={onClose} open={{ email: true, wallet: false }} />)
    expect(doc().querySelector<HTMLElement>('[data-ic-window="email"]')!.dataset.pane).toBe('full')
    expect(slotFor($paneArrangement.get(), 'email', AREA)).toEqual({ place: 'full' })
    // The control moved to the survivor, and says it is every window's.
    expect(screen.getByRole('slider').getAttribute('aria-label')).toBe('Opacity · every window')
    expect(screen.getByRole('slider').closest('[data-ic-window]')!.getAttribute('data-ic-window')).toBe('email')
    expect(said()).toBe('Wallet closed · Email fills the window')

    // The last one closed: no pane, nothing stale.
    view.rerender(<TwoPanes onClose={onClose} open={{ email: false, wallet: false }} />)
    expect($paneArrangement.get().kind).toBe('none')
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('folded (< 758) and a lone pane on a half: one control, on the pane on screen', () => {
    $paneArea.set(700)
    render(<TwoPanes open={{ email: true, wallet: true }} />)
    expect($paneArrangement.get().kind).toBe('folded')

    const visible = screen.getAllByRole('slider').filter(slider => !slider.closest('[inert]'))

    expect(visible).toHaveLength(1)
    cleanup()
    resetPanesForTests()
    $paneArea.set(AREA)
    render(<TwoPanes open={{ email: true, wallet: false }} />)
    act(() => $panes.set({ ...$panes.get(), solo: 'left' }))
    expect(doc().querySelector<HTMLElement>('[data-ic-window="email"]')!.dataset.pane).toBe('left')
    expect(screen.getAllByRole('slider')).toHaveLength(1)
  })
})

describe('the live region', () => {
  it('is always mounted, and speaks the plan only when it changes — never per pointer move', () => {
    openPanes('message')
    render(<PaneLayer />)

    const region = screen.getByRole('status')

    expect(region.getAttribute('aria-live')).toBe('polite')
    act(() => beginDockDrag('email', LEFT_X, MID_Y, FRAME))
    expect(region.textContent).toBe('Left: Email opens here')
    const seq = $paneAnnouncement.get().seq

    for (let x = 0; x < 20; x++) {
      act(() => moveDockDrag(LEFT_X + x, MID_Y))
    }

    expect($paneAnnouncement.get().seq).toBe(seq)
    act(() => moveDockDrag(RIGHT_X, MID_Y))
    expect(region.textContent).toBe('Right: Email opens here')
    act(() => void endDockDrag(RIGHT_X, MID_Y))
    expect(region.textContent).toBe('Email opens beside Message')
  })
})

describe("the owner's reference flow", () => {
  it('3D iNFT in its own window + Message and Email side by side inside the app', () => {
    $stagePlace.set('away')
    openPanes('message')

    beginDockDrag('email', RIGHT_X, MID_Y, FRAME)
    endDockDrag(RIGHT_X, MID_Y)
    mountDropped('email')

    expect($stagePlace.get()).toBe('away')
    expect($panes.get().open).toEqual(['message', 'email'])
    expect($paneArrangement.get()).toMatchObject({ kind: 'split', left: 'message', right: 'email' })
  })
})
