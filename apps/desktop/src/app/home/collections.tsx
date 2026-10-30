/**
 * "collections inft" — right-edge pull tab + frosted panel of the owner's
 * iNFT roster, in the metallic/champagne-holo card grammar (dark chrome +
 * brushed metal + pointer-tracked foil + glare, tilt clamped to ±12°).
 *
 * `CollectionsTab` is always mounted (see home-view.tsx); `CollectionsPanel`
 * is mounted only while open, so it owns its own enter animation (double-rAF
 * flip to `data-phase="open"`) and a short self-managed "closing" phase that
 * plays the exit slide before calling the real `onClose` — the caller can
 * unmount unconditionally on that callback and still get a graceful close
 * whether the panel was dismissed via the × button or the scrim. Esc is the
 * caller's job (home-view.tsx already owns a single Escape handler across
 * its overlays); this file only ever attaches per-card pointer listeners.
 * The pill itself lives in collections-tab.tsx and is re-exported from here.
 */
import './collections.css'

import { useStore } from '@nanostores/react'
import { X } from 'lucide-react'
import type { CSSProperties, JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { IcPageButton } from '@/components/ic/ic-page'
import { prefersReducedMotion, useMediaQuery } from '@/hooks/use-media-query'
import { cn } from '@/lib/utils'

import { CollectionsTab, PANEL_ID } from './collections-tab'
import { IcloneHeadMark } from './iclone-head'
import type { InftBootstrap } from './inft-bootstrap'
import { $ownership, DEACTIVATED_LABEL, isDeactivated, ownershipForId } from './ownership'
import { claimRightEdge } from './right-edge'

// home-view.tsx imports the pill from here (frozen path); the pill itself lives in collections-tab.tsx.
export { CollectionsTab }

export interface INftCardData {
  id: string
  /** e.g. 'i01 ZEUS' — rendered in the display face (Noto Serif Display ExtraCondensed), as-is (no forced case). */
  name: string
  /** On-chain 3D model URL (GLB) — the stage summons this. */
  modelUrl?: string
  /** e.g. 'iCLONE · 1111' */
  collection: string
  /** e.g. 'Base' */
  chain: string
  /** 3D render / poster. Undefined -> dark tile + champagne monogram of the first letter. */
  imageUrl?: string
  /** Metadata background_color ('#rrggbb') — one source for the stage field. */
  backdropColor?: string
  /** Virtuals CLI configured state -> gold 'ECONOMYOS' chip vs dim 'SETUP NEEDED' chip. */
  configured: boolean
  /** The on-chain `agent_bootstrap` — the profile source. Null for plain NFTs. */
  bootstrap?: InftBootstrap | null
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const PANEL_CLOSE_MS = 280
const PANEL_CLOSE_REDUCED_MS = 150

/** Signed in with iNFTs in the wallet, none checked: the iNFT Book rule, said, with its door. */
interface BookEmptyState {
  action: string
  line: string
  onOpen: () => void
  rule: string
}

interface CollectionsPanelProps {
  bookEmpty?: BookEmptyState
  /** The roster scan's state — 'loading' renders skeleton cards, 'error'
   *  explains itself. Without these the panel showed "connect a wallet" to a
   *  signed-in user mid-scan, which is a lie with good posture. */
  scanError?: null | string
  scanStatus?: 'error' | 'idle' | 'loading' | 'ready'
  signedIn?: boolean
  cards: INftCardData[]
  onClose: () => void
  /** Owner reordered the cards by drag — persist this id order. */
  onReorder?: (ids: string[]) => void
  onSelect: (id: string) => void
}

type PanelPhase = 'closing' | 'entering' | 'open'

// Row pitch: fixed card height (200) + list gap (16). Fixed rows keep the
// drag's index math exact under scroll.
const CARD_PITCH = 216
const DRAG_THRESHOLD = 6

interface DragState {
  id: string
  from: number
  target: number
  dy: number
}

export function CollectionsPanel({
  bookEmpty,
  cards,
  onClose,
  onReorder,
  onSelect,
  scanError,
  scanStatus,
  signedIn
}: CollectionsPanelProps): JSX.Element {
  const [phase, setPhase] = useState<PanelPhase>('entering')
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY)
  const bodyRef = useRef<HTMLUListElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  // Handlers read/write the ref, never the state: pointer events can arrive
  // several per task (coalesced moves, synthetic tests) — before React has
  // re-rendered — and the drag must track every one of them.
  const dragRef = useRef<DragState | null>(null)
  // Once ANY drag starts, the entrance stagger is retired for good — React
  // reorders replay CSS animations on moved <li>s otherwise (flash).
  const [settled, setSettled] = useState(false)
  const suppressClickRef = useRef(false)
  const pressRef = useRef<{ id: string; index: number; pointerId: number; startY: number } | null>(null)

  // Own the right edge while open — matches `.inft-panel`'s own width rule.
  useEffect(() => claimRightEdge('collections', 'min(384px, 92vw)'), [])

  const handleCardPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, id: string, index: number) => {
      if (event.button !== 0 || !onReorder) {
        return
      }

      pressRef.current = { id, index, pointerId: event.pointerId, startY: event.clientY }

      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Capture is an assist, not a requirement — the drag still tracks
        // moves that bubble through the card.
      }
    },
    [onReorder]
  )

  const handleCardPointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const press = pressRef.current

      if (!press || press.pointerId !== event.pointerId) {
        return
      }

      const dy = event.clientY - press.startY

      if (!dragRef.current) {
        if (Math.abs(dy) < DRAG_THRESHOLD) {
          return
        }

        setSettled(true)
        event.currentTarget.dataset.dragging = '1'
      }

      // Auto-scroll near the list edges so long rosters stay reachable.
      const body = bodyRef.current

      if (body) {
        const rect = body.getBoundingClientRect()

        if (event.clientY < rect.top + 44) {
          body.scrollTop -= 12
        } else if (event.clientY > rect.bottom - 44) {
          body.scrollTop += 12
        }
      }

      const target = Math.max(0, Math.min(cards.length - 1, press.index + Math.round(dy / CARD_PITCH)))

      dragRef.current = { id: press.id, from: press.index, target, dy }
      setDrag(dragRef.current)
    },
    [cards.length]
  )

  const handleCardPointerEnd = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const press = pressRef.current

      if (!press || press.pointerId !== event.pointerId) {
        return
      }

      pressRef.current = null
      delete event.currentTarget.dataset.dragging

      const active = dragRef.current

      if (!active) {
        return
      }

      // The click that follows this pointerup must not summon the iNFT.
      suppressClickRef.current = true

      if (active.target !== active.from) {
        const ids = cards.map(card => card.id)
        const [moved] = ids.splice(active.from, 1)

        ids.splice(active.target, 0, moved)
        onReorder?.(ids)
      }

      dragRef.current = null
      setDrag(null)
    },
    [cards, onReorder]
  )

  const handleSelect = useCallback(
    (id: string) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false

        return
      }

      onSelect(id)
    },
    [onSelect]
  )

  // Flip to the open state one frame after mount so the initial
  // translateX(100%) actually paints before the transition kicks in.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setPhase('open'))

    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    closeButtonRef.current?.focus()
  }, [])

  const requestClose = useCallback(() => {
    setPhase('closing')
  }, [])

  // The unmount timer must key on the PHASE alone. `onClose` arrives as an
  // inline arrow with a new identity on every parent render, and with it in
  // the deps each render during the 280ms close cleared and RESTARTED the
  // timer — under sustained store churn (a streaming turn, gateway activity)
  // the timeout never fired, and what remained was an invisible, full-viewport
  // scrim at z 61 whose own click handler is a no-op in this phase. Every
  // click in the app landed on it: the window painted perfectly and accepted
  // nothing. The ref makes the timer fire exactly once per close, whatever
  // the parent is doing.
  const onCloseRef = useRef(onClose)

  onCloseRef.current = onClose

  useEffect(() => {
    if (phase !== 'closing') {
      return
    }

    const duration = prefersReducedMotion() ? PANEL_CLOSE_REDUCED_MS : PANEL_CLOSE_MS
    const timer = window.setTimeout(() => onCloseRef.current(), duration)

    return () => window.clearTimeout(timer)
  }, [phase])

  return (
    <>
      <div aria-hidden="true" className="inft-scrim" data-phase={phase} onClick={requestClose} />
      <section
        aria-label="Collections"
        aria-modal="true"
        className="inft-panel"
        data-phase={phase}
        id={PANEL_ID}
        role="dialog"
      >
        <header className="inft-panel__header">
          <span className="inft-panel__title">inft</span>
          <button
            aria-label="Close collections"
            className="inft-panel__close"
            onClick={requestClose}
            ref={closeButtonRef}
            type="button"
          >
            <X aria-hidden="true" size={16} strokeWidth={2} />
          </button>
        </header>

        {cards.length === 0 ? (
          scanStatus === 'loading' ? (
            <div aria-label="Scanning your wallet" className="inft-panel__skeletons" role="status">
              <div className="inft-panel__skeleton" />
              <div className="inft-panel__skeleton" />
              <div className="inft-panel__skeleton" />
            </div>
          ) : scanStatus === 'error' ? (
            <p className="inft-panel__empty">{scanError || 'The wallet scan failed.'} It retries on the next open.</p>
          ) : signedIn && bookEmpty ? (
            <div className="inft-panel__empty grid justify-items-start gap-3" role="status">
              <p>{bookEmpty.line}</p>
              <p>{bookEmpty.rule}</p>
              <IcPageButton onClick={bookEmpty.onOpen} tone="accent">
                {bookEmpty.action}
              </IcPageButton>
            </div>
          ) : signedIn ? (
            <p className="inft-panel__empty">No iNFTs in this wallet yet.</p>
          ) : (
            <p className="inft-panel__empty">No iNFTs yet — connect a wallet to summon one.</p>
          )
        ) : (
          <ul className={cn('inft-panel__body', settled && 'inft-panel__body--settled')} ref={bodyRef}>
            {cards.map((card, index) => {
              const isDragged = drag?.id === card.id
              let shift = 0

              if (drag && !isDragged) {
                if (index > drag.from && index <= drag.target) {
                  shift = -CARD_PITCH
                } else if (index < drag.from && index >= drag.target) {
                  shift = CARD_PITCH
                }
              }

              return (
                <InftCard
                  card={card}
                  dragOffset={isDragged ? drag.dy : null}
                  index={index}
                  key={card.id}
                  onPointerDown={handleCardPointerDown}
                  onPointerEnd={handleCardPointerEnd}
                  onPointerMove={handleCardPointerMove}
                  onSelect={handleSelect}
                  reducedMotion={reducedMotion}
                  shift={shift}
                />
              )
            })}
          </ul>
        )}
      </section>
    </>
  )
}

interface InftCardProps {
  card: INftCardData
  /** Pointer offset while THIS card is being dragged; null otherwise. */
  dragOffset: null | number
  index: number
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>, id: string, index: number) => void
  onPointerEnd: (event: React.PointerEvent<HTMLButtonElement>) => void
  onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void
  onSelect: (id: string) => void
  reducedMotion: boolean
  /** Displacement (px) for a card making room for the dragged one. */
  shift: number
}

function InftCard({
  card,
  dragOffset,
  index,
  onPointerDown,
  onPointerEnd,
  onPointerMove,
  onSelect,
  reducedMotion,
  shift
}: InftCardProps): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  const deactivated = isDeactivated(ownershipForId(useStore($ownership), card.id))

  // ONE pointermove (+ pointerleave to recenter) per card, rAF-throttled,
  // writing --px/--py/--pd only — no layout reads outside the listener, no
  // per-frame allocation. Skipped entirely under reduced motion.
  useEffect(() => {
    const el = ref.current

    if (!el || reducedMotion) {
      return
    }

    let raf = 0
    let px = 0.5
    let py = 0.5

    const paint = () => {
      raf = 0
      el.style.setProperty('--px', px.toFixed(3))
      el.style.setProperty('--py', py.toFixed(3))
      el.style.setProperty('--pd', Math.min(Math.hypot(px - 0.5, py - 0.5) * 2, 1).toFixed(3))
    }

    const onPointerMove = (event: PointerEvent) => {
      // A card being dragged for reorder must not keep tilting under the
      // pointer — the two transforms fight.
      if (el.dataset.dragging) {
        return
      }

      const rect = el.getBoundingClientRect()

      px = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
      py = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))

      if (!raf) {
        raf = requestAnimationFrame(paint)
      }
    }

    const onPointerLeave = () => {
      px = 0.5
      py = 0.5

      if (!raf) {
        raf = requestAnimationFrame(paint)
      }
    }

    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerleave', onPointerLeave)

    return () => {
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerleave', onPointerLeave)

      if (raf) {
        cancelAnimationFrame(raf)
      }
    }
  }, [reducedMotion])

  const dragging = dragOffset !== null

  // The `translate` property (not `transform`) on purpose: the entrance
  // animation's forwards fill and the reduced-motion `transform: none
  // !important` both own `transform`, but neither touches `translate`.
  const slotStyle = useMemo(
    () =>
      ({
        '--i': index,
        translate: dragging ? `0 ${dragOffset}px` : shift ? `0 ${shift}px` : undefined
      }) as CSSProperties,
    [dragging, dragOffset, index, shift]
  )

  return (
    <li className={cn('inft-card-slot', dragging && 'inft-card-slot--dragging')} style={slotStyle}>
      <button
        aria-label={`${card.name} — ${card.collection}`}
        className="inft-card"
        onClick={() => onSelect(card.id)}
        onPointerCancel={onPointerEnd}
        onPointerDown={event => onPointerDown(event, card.id, index)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        ref={ref}
        type="button"
      >
        <span aria-hidden="true" className="inft-card__chrome" />
        <span aria-hidden="true" className="inft-card__art">
          {card.imageUrl ? (
            <img alt="" className="inft-card__img" loading="lazy" src={card.imageUrl} />
          ) : (
            <span className="inft-card__placeholder">
              <IcloneHeadMark className="inft-card__headmark" />
            </span>
          )}
        </span>
        <span aria-hidden="true" className="inft-card__edge" />
        <span aria-hidden="true" className="inft-card__meta">
          <span className="inft-card__top-row">
            <span className="inft-card__chain">{card.chain}</span>
          </span>
          <span className="inft-card__bottom-row">
            <span className="inft-card__text">
              <span className="inft-card__name">{card.name}</span>
              <span className="inft-card__collection">{card.collection}</span>
            </span>
            {deactivated ? (
              <span className="inft-card__badge ownership-pill">{DEACTIVATED_LABEL}</span>
            ) : (
              <span
                className={cn('inft-card__badge', card.configured ? 'inft-card__badge--gold' : 'inft-card__badge--dim')}
              >
                {card.configured ? 'ECONOMYOS' : 'SETUP NEEDED'}
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  )
}
