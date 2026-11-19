/**
 * IcWindow — the one chassis every Dock window opens in (Message and the five
 * EconomyOS windows, and Settings): the frame rect, the header band, the body
 * and the control column (close · expand/retract · opacity). Every window
 * opens on ONE fixed rect, the iNFT backdrop's frame (rect.ts); none resizes
 * with the mouse, and expanded fills the app.
 *
 * The root `.ic-win[data-ic-window=<id>]` is the full window rect. One plate
 * paints it, once (AD1), and the opacity slider fades only that plate:
 * - placement 'self' (econ): the plate is the root's EMPTY first child; the
 *   header and the body are its siblings, painted over it in tree order.
 * - placement 'under-shell' (Message): the plate lives in the home's base
 *   layer and the chat / iT shells are not ours to render, so the window
 *   publishes its outer rect as `--iwin-outer-*` vars on <html>, lays out an
 *   empty `.ic-win__body` below the header band and publishes that element's
 *   MEASURED box as the shells' clip (`--iwin-*`). The root draws only the
 *   frame decor; tabs and controls keep their own registry
 *   rungs (ihome.chrome / ihome.controls) above the frame (ihome.frame).
 *
 * v0.0.9 F6: every IcWindow is a PANE (pane-layout.ts). Two of them stand
 * side by side, each on its part of the frame; a pane folded into a tab stays
 * mounted and is not drawn. The control column's expand/retract button became
 * the window menu (window-menu.tsx): Move left · Move right · Fill (the old
 * expand) · Arrange side by side.
 */
import { X } from 'lucide-react'
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { f6Menu, f6PaneNames, f6Split } from '@/i18n/en/v009-f6'

import { releaseDockFocus } from '../dock'

import { useEdgeAutoHide } from './edge-autohide'
import { setWindowExpanded } from './expanded'
import { PaneOpacity, usePlateOpacity, useShellOpacity } from './opacity'
import { outerInset, type PaneGeometry, publishBodyRect, publishShellRect, readInsets, windowRectStyle } from './rect'
import { usePaneMenu, usePanePlacement, usePaneRegistration } from './use-pane'
import { WindowMenu } from './window-menu'

export type IcWindowId =
  'acp-market' | 'bank-card' | 'containers' | 'email' | 'hyperliquid' | 'message' | 'settings' | 'wallet'

interface IcWindowLabels {
  close: string
  /** Kept for the consumers' catalogue; since F6 the window menu's Fill carries the expand (window-menu-model.ts). */
  expand: string
  retract: string
  opacity: string
}

/** A pane's slot as one string, so an effect re-runs only when the rect really moves. */
function geometryKey({ area, slot }: PaneGeometry): string {
  return slot.place === 'left' || slot.place === 'right'
    ? `${slot.place}:${slot.left}:${slot.width}:${Math.round(area)}`
    : slot.place
}

interface IcWindowBase {
  id: IcWindowId
  labels: IcWindowLabels
  expanded: boolean
  onToggleExpanded: () => void
  onClose: () => void
  head: ReactNode
  children?: ReactNode
}

interface SelfWindowProps extends IcWindowBase {
  placement: 'self'
  /** The root's accessible name. */
  label: string
  /** Extra data-kind for app-specific styling. */
  kind?: string
}

interface UnderShellWindowProps extends IcWindowBase {
  placement: 'under-shell'
  /** CSS length of the header band above the body (see window-frame.ts). */
  headBand: string
  /** CSS length the body (the shells' clip) starts right of the window's left edge. */
  bodyInsetLeft?: string
}

type IcWindowProps = SelfWindowProps | UnderShellWindowProps

function WindowControls({
  className,
  expanded,
  id,
  labels,
  onClose,
  onToggleExpanded,
  opacity,
  style
}: Pick<IcWindowBase, 'expanded' | 'id' | 'labels' | 'onClose' | 'onToggleExpanded'> & {
  className: string
  opacity: ReactNode
  style?: CSSProperties
}) {
  const columnRef = useRef<HTMLDivElement>(null)
  const menuGroups = usePaneMenu(id, expanded, onToggleExpanded)
  const paneName = f6PaneNames[id]
  // Expanded, the column tucks off the right edge like the Dock off the left (ic-window.css).
  const revealed = useEdgeAutoHide({ active: expanded, band: true, edge: 'right', targetRef: columnRef })

  // Expanded, a press that began on any control (a button, the opacity slider)
  // drops the focus it left behind when it ends, wherever the pointer is
  // released: Chrome turns a mouse-focused element :focus-visible on the next
  // key press, which would pin the hidden column open (ic-window.css). Keyboard
  // activation fires no pointer event, so Tab still reveals. Retracted, the
  // column never hides, so a pressed control keeps its focus (the slider's
  // arrow keys fine-tune).
  const onPointerDown = () => {
    const column = columnRef.current

    if (!expanded || !column) {
      return
    }

    const doc = column.ownerDocument

    const release = () => {
      doc.removeEventListener('pointerup', release, true)
      doc.removeEventListener('pointercancel', release, true)

      const active = doc.activeElement

      if (active instanceof HTMLElement && column.contains(active)) {
        active.blur()
      }
    }

    doc.addEventListener('pointerup', release, true)
    doc.addEventListener('pointercancel', release, true)
  }

  // The press that expanded the window began retracted, so it armed no release:
  // a mouse-clicked Expand drops its focus here. Enter / Space leave the button
  // :focus-visible, and it keeps focus.
  useLayoutEffect(() => {
    const column = columnRef.current
    const active = column?.ownerDocument.activeElement

    if (expanded && active instanceof HTMLElement && column?.contains(active) && !active.matches(':focus-visible')) {
      active.blur()
    }
  }, [expanded])

  return (
    <div
      className={`ic-win__controls ${className}`}
      data-autohide={expanded ? 'true' : undefined}
      data-ic-pane={id}
      data-revealed={revealed ? 'true' : undefined}
      dir="ltr"
      onPointerDown={onPointerDown}
      ref={columnRef}
      style={style}
    >
      <button aria-label={labels.close} className="iwin-btn" onClick={onClose} type="button">
        <X size={14} strokeWidth={2} />
      </button>
      <WindowMenu groups={menuGroups} menuLabel={f6Menu.label(paneName)} triggerLabel={f6Menu.trigger(paneName)} />
      {opacity}
    </div>
  )
}

/**
 * v0.0.9 F6 (owner addition): ONE opacity control for two panes side by side — on the right pane's column, where a
 * lone window has it; the left pane's column carries close and the menu only. The value is shared (opacity.tsx), so
 * the control fades both.
 */
function paneOpacityControl(split: boolean, geometry: PaneGeometry, label: string): ReactNode {
  // One opacity for every window (owner rule): a lone window's control says so, so a new window opening faint is
  // never a surprise (chrome r1).
  if (!split) {
    return <PaneOpacity label={f6Split.opacityAll(label)} />
  }

  return geometry.slot.place === 'right' ? <PaneOpacity label={f6Split.opacityBoth} /> : null
}

// Only the pointer gate is inline; ic-window.css positions the header and the
// body so they paint over the plate in tree order.
function contentStyle(interactive: boolean): CSSProperties {
  return { pointerEvents: interactive ? 'auto' : 'none' }
}

function SelfWindow(props: SelfWindowProps) {
  const { children, expanded, head, id, kind, label } = props
  const { folded, geometry, split } = usePanePlacement(id)
  const plateRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  // The root is hit-transparent (home.css), so the content takes its hits
  // from the plate's pointer gate: a window faded below it passes every drag.
  const [interactive, setInteractive] = useState(true)

  usePlateOpacity(plateRef, setInteractive)

  // Opening (or switching kind in the same chassis) moves focus into the
  // window — unless the app already claimed it (a search field, the mail
  // list). The Dock tile used to keep focus until the stage re-rendered and
  // dropped it on <body>, so Tab started over from the top of the page.
  useEffect(() => {
    const root = rootRef.current

    if (root && !root.contains(root.ownerDocument.activeElement)) {
      root.focus({ preventScroll: true })
    }
  }, [id])

  return (
    <aside
      aria-hidden={folded ? true : undefined}
      aria-label={label}
      className="ic-win iecon"
      data-expanded={expanded ? 'true' : undefined}
      data-ic-window={id}
      data-kind={kind}
      data-pane={geometry.slot.place}
      inert={folded ? true : undefined}
      ref={rootRef}
      style={windowRectStyle(expanded, geometry)}
      tabIndex={-1}
    >
      <div className="ic-win__plate iecon__surface" ref={plateRef} />
      {/* Controls before the content in tree order: Tab reaches close · expand · opacity first. */}
      <WindowControls
        {...props}
        className="iecon-controls"
        opacity={paneOpacityControl(split, geometry, props.labels.opacity)}
      />
      <header className="ic-win__head iecon__head" style={contentStyle(interactive)}>
        {head}
      </header>
      <div className="ic-win__body iecon__body" style={contentStyle(interactive)}>
        {children}
      </div>
    </aside>
  )
}

// The body box is laid out from the outer rect alone (never from the vars it
// publishes), so measuring it cannot feed back into itself.
function underShellBodyStyle(headBand: string, bodyInsetLeft: string): CSSProperties {
  return {
    position: 'fixed',
    top: `calc(${outerInset('top')} + ${headBand})`,
    right: outerInset('right'),
    bottom: outerInset('bottom'),
    left: `calc(${outerInset('left')} + ${bodyInsetLeft})`,
    pointerEvents: 'none'
  }
}

function UnderShellWindow(props: UnderShellWindowProps) {
  const { bodyInsetLeft = '0px', children, expanded, head, headBand, id } = props
  const { folded, geometry, split } = usePanePlacement(id)
  const placeKey = geometryKey(geometry)
  const geometryRef = useRef(geometry)
  const bodyRef = useRef<HTMLDivElement>(null)

  geometryRef.current = geometry
  useShellOpacity()

  // Folded behind the focused pane, the shells (not ours to hide) stay on the plain frame: the shown pane covers at
  // least the frame, so nothing of them shows around it (pane-layout.ts). Expanded, the same: the pane on top fills.
  const drawExpanded = expanded && !folded

  // Opening filled (the Dock's default), this window takes the focus off the Dock tile that opened it, as a self
  // window does by focusing its root: this one has no root of its own (its content, the chat, is portaled), and a
  // Dock that keeps the focus never tucks away over it. Opening at its usual size, nothing changes; a later expand
  // starts from the window's own controls, so only the opening counts.
  useEffect(() => {
    if (expanded) {
      releaseDockFocus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Before paint: the shells never show a frame without their clip.
  useLayoutEffect(() => {
    publishShellRect(drawExpanded, folded ? undefined : geometryRef.current)

    const body = bodyRef.current

    if (body) {
      publishBodyRect(readInsets(body))
    }
  }, [bodyInsetLeft, drawExpanded, folded, headBand, placeKey])

  // A viewport resize (the frame tokens may be responsive) and a header-band
  // change both resize the body; its observer republishes the clip
  // in the same frame, before paint.
  useLayoutEffect(() => {
    const body = bodyRef.current

    if (!body) {
      return
    }

    const measure = () => publishBodyRect(readInsets(body))
    const observer = new ResizeObserver(measure)

    observer.observe(body)
    window.addEventListener('resize', measure)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  // The column hugs the window's top-right corner from outside the frame (ic-window.css). On the LEFT of two panes
  // that corner is the divider, so the column steps inside the window instead of onto the other pane.
  const columnStyle: CSSProperties | undefined =
    !drawExpanded && geometry.slot.place === 'left' ? { right: `calc(${outerInset('right')} + 14px)` } : undefined

  return (
    <>
      {!drawExpanded && !folded && (
        <div aria-hidden className="ic-win ic-win--under-shell iwin-frame" data-ic-window={id} />
      )}

      <div
        aria-hidden
        className="ic-win__body"
        data-ic-window-body={id}
        ref={bodyRef}
        style={underShellBodyStyle(headBand, bodyInsetLeft)}
      />

      {/* Folded: the column, the head and the window's own pieces are kept mounted but not drawn (display: contents
          otherwise, so nothing moves in the tree the shells and their CSS expect). */}
      <div className="ic-win__fold" data-folded={folded ? 'true' : undefined} inert={folded ? true : undefined}>
        <WindowControls
          {...props}
          className="iwin-controls"
          opacity={paneOpacityControl(split, geometry, props.labels.opacity)}
          style={columnStyle}
        />

        {head}

        {children}
      </div>
    </>
  )
}

export function IcWindow(props: IcWindowProps) {
  const { expanded, id, onClose, onToggleExpanded } = props

  // F6: a pane while mounted; a 3rd one closes the pane without focus through this close.
  usePaneRegistration(id, onClose)

  // Published for the Dock, which tucks away while any window fills the app — with the retract (the toggle, while
  // expanded) for the Escape routers (expanded.ts).
  useEffect(() => {
    setWindowExpanded(id, expanded, onToggleExpanded)

    return () => setWindowExpanded(id, false)
  }, [expanded, id, onToggleExpanded])

  return props.placement === 'self' ? <SelfWindow {...props} /> : <UnderShellWindow {...props} />
}
