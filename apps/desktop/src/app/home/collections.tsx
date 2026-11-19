/**
 * The home iNFT Collection — right-edge pull tab + side panel of the owner's iNFT roster (v0.0.9 F5 contract,
 * P0_DESIGN_SPECS.md "F5 · iNFT Collection no home").
 *
 *   - Panel: the same right-edge island (`claimRightEdge`), `clamp(384px, 34vw, 560px)` wide. Header: "iNFT
 *     Collection" in the display face, "12 iNFTs · 3 collections" in mono, Open iNFT Book (always there) and ✕.
 *   - Grid: 2 columns from 460 px of useful width, 1 below; 4:5 portrait cards, 14 px gap. The metal edge and the
 *     tilt stay (they are the brand) at 4°, off under reduced motion. Drag-to-reorder works in 2-D.
 *   - Card: art full width; under it the name (display 17 px, wraps to two lines, never cut), collection · chain
 *     in mono; one state in the corner (EconomyOS · Setup needed · Deactivated). Hover or keyboard focus slides up
 *     a detail plate (token, chain, contract + Copy, Open, Set up in EconomyOS) that never covers the name.
 *   - States: loading skeletons shaped like the card, signed in and empty, signed out (Connect wallet), error
 *     (IcAlert + Retry, now), partial (the cards that loaded + an inline alert naming what is missing).
 *
 * `CollectionsTab` is always mounted (home-view.tsx); `CollectionsPanel` only while open, so it owns its enter
 * animation (double-rAF flip to `data-phase="open"`) and a short "closing" phase that plays the exit before
 * calling the real `onClose`. Esc is the caller's job (home-view.tsx owns one Escape handler across overlays).
 */
import './collections.css'

import { useStore } from '@nanostores/react'
import { Check, Copy, X } from 'lucide-react'
import type { CSSProperties, JSX } from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { IcAlert, IcPageButton } from '@/components/ic/ic-page'
import { prefersReducedMotion, useMediaQuery } from '@/hooks/use-media-query'
import { f5Collection as copy } from '@/i18n/en/v009-f5'
import { cn } from '@/lib/utils'

import { CollectionsTab, PANEL_ID } from './collections-tab'
import { IcloneHeadMark } from './iclone-head'
import type { InftBootstrap } from './inft-bootstrap'
import { shortAddress } from './lib/format'
import { $ownership, DEACTIVATED_LABEL, isDeactivated, ownershipForId } from './ownership'
// F2 exports `retryInftScan()` (an immediate full re-scan of the signed-in wallet) from privy-session.ts.
import { openPrivyLogin, retryInftScan } from './privy-session'
import { claimRightEdge, watchRightEdge } from './right-edge'

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
  /** 3D render / poster. Undefined -> dark tile + the iCLONE head mark. */
  imageUrl?: string
  /** Metadata background_color ('#rrggbb') — one source for the stage field. */
  backdropColor?: string
  /** Virtuals CLI configured state -> gold 'EconomyOS' state vs outlined 'Setup needed'. */
  configured: boolean
  /** The on-chain `agent_bootstrap` — the profile source. Null for plain NFTs. */
  bootstrap?: InftBootstrap | null
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const PANEL_CLOSE_MS = 280
const PANEL_CLOSE_REDUCED_MS = 150
/** The island's width — the same string `.inft-panel` resolves (`--ic-inft-panel-w`), published to the chrome. */
const PANEL_WIDTH_CSS = 'min(clamp(384px, 34vw, 560px), calc(100vw - 24px))'

/** Two columns from this much useful (inner) grid width; one below it. */
export const GRID_TWO_COLUMN_MIN_PX = 460
/** The grid gap (`--ic-inft-grid-gap`): the drag pitch adds it to the measured card box. */
const GRID_GAP_PX = 14
const DRAG_THRESHOLD = 6
const SKELETON_COUNT = 4
const COPY_RESET_MS = { copied: 1_400, failed: 2_400 } as const

/** The grid's column count for a useful width: 2 from 460 px, 1 below. */
export function gridColumnsFor(usefulWidth: number): 1 | 2 {
  return usefulWidth >= GRID_TWO_COLUMN_MIN_PX ? 2 : 1
}

/** `chain:contract:tokenId` (inft-scan.ts `toInftCards`) — null for an id of another shape. */
export function parseCardId(id: string): { chain: string; contract: string; tokenId: string } | null {
  const [chain, contract, ...rest] = id.split(':')
  const tokenId = rest.join(':')

  return chain && contract && tokenId ? { chain, contract, tokenId } : null
}

/** How many distinct collections a roster spans (the header count). */
export function collectionCount(cards: readonly INftCardData[]): number {
  return new Set(cards.map(card => card.collection)).size
}

/** The slot a dragged card lands on: its own slot moved by whole pitches in x and y, kept inside the grid. */
export function reorderTarget(
  from: number,
  dx: number,
  dy: number,
  cols: number,
  pitchX: number,
  pitchY: number,
  count: number
): number {
  const row = Math.floor(from / cols) + Math.round(dy / Math.max(1, pitchY))
  const col = Math.min(cols - 1, Math.max(0, (from % cols) + Math.round(dx / Math.max(1, pitchX))))

  return Math.max(0, Math.min(count - 1, Math.max(0, row) * cols + col))
}

/** The displacement from slot `from` to slot `to` in a grid of `cols` columns. */
function slotOffset(from: number, to: number, cols: number, pitchX: number, pitchY: number): [number, number] {
  return [((to % cols) - (from % cols)) * pitchX, (Math.floor(to / cols) - Math.floor(from / cols)) * pitchY]
}

/** Signed in with iNFTs in the wallet, none checked: the iNFT Book rule, said, with its door. */
interface BookEmptyState {
  action: string
  line: string
  onOpen: () => void
  rule: string
}

interface CollectionsPanelProps {
  bookEmpty?: BookEmptyState
  cards: INftCardData[]
  /** Partial scan: the collections (or chains) that could not be read — named in the inline alert. */
  missingCollections?: readonly string[]
  onClose: () => void
  /** Settings › iNFT Book. The header's primary action; falls back to `bookEmpty.onOpen` when absent. */
  onOpenBook?: () => void
  /** Owner reordered the cards by drag — persist this id order. */
  onReorder?: (ids: string[]) => void
  onSelect: (id: string) => void
  /** "Set up in EconomyOS" on a card that is not configured yet; the line is hidden without it. */
  onSetUp?: (id: string) => void
  /** The roster scan's state — 'loading' renders skeleton cards, 'error' explains itself and offers Retry. */
  scanError?: null | string
  scanStatus?: 'error' | 'idle' | 'loading' | 'ready'
  signedIn?: boolean
}

/** Which face the panel body wears — one decision, tested without a DOM. */
export type CollectionsView = 'book-empty' | 'empty' | 'error' | 'grid' | 'loading' | 'signed-out'

export function collectionsView({
  bookEmpty,
  cards,
  scanStatus,
  signedIn
}: Pick<CollectionsPanelProps, 'bookEmpty' | 'cards' | 'scanStatus' | 'signedIn'>): CollectionsView {
  // v0.0.9 Q (proofs F5): no wallet is the specified empty state, whatever cards a caller passes — never a grid of
  // samples or of a signed-out wallet's roster.
  if (!signedIn) {
    return 'signed-out'
  }

  if (cards.length > 0) {
    return 'grid'
  }

  if (scanStatus === 'loading') {
    return 'loading'
  }

  if (scanStatus === 'error') {
    return 'error'
  }

  return bookEmpty ? 'book-empty' : 'empty'
}

type PanelPhase = 'closing' | 'entering' | 'open'

interface PressState {
  cols: number
  id: string
  index: number
  pitchX: number
  pitchY: number
  pointerId: number
  startX: number
  startY: number
}

interface DragState {
  cols: number
  dx: number
  dy: number
  from: number
  id: string
  pitchX: number
  pitchY: number
  target: number
}

export function CollectionsPanel({
  bookEmpty,
  cards,
  missingCollections,
  onClose,
  onOpenBook,
  onReorder,
  onSelect,
  onSetUp,
  scanError,
  scanStatus,
  signedIn
}: CollectionsPanelProps): JSX.Element {
  const [phase, setPhase] = useState<PanelPhase>('entering')
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY)
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLUListElement>(null)
  const [cols, setCols] = useState<1 | 2>(1)
  const [drag, setDrag] = useState<DragState | null>(null)
  // Handlers read/write the ref, never the state: pointer events can arrive several per task (coalesced moves,
  // synthetic tests) — before React has re-rendered — and the drag must track every one of them.
  const dragRef = useRef<DragState | null>(null)
  // Once ANY drag starts, the entrance stagger is retired for good — React reorders replay CSS animations on
  // moved <li>s otherwise (flash).
  const [settled, setSettled] = useState(false)
  const suppressClickRef = useRef(false)
  const pressRef = useRef<PressState | null>(null)
  const view = collectionsView({ bookEmpty, cards, scanStatus, signedIn })
  const openBook = onOpenBook ?? bookEmpty?.onOpen
  const partial = view === 'grid' && (scanStatus === 'error' || (missingCollections?.length ?? 0) > 0)

  // Own the right edge while open — the same width `.inft-panel` resolves.
  useEffect(() => claimRightEdge('collections', PANEL_WIDTH_CSS), [])

  // The column count follows the grid's own useful width (the panel is clamp()ed to the window, so a resize can
  // cross 460 px either way). Measured, not a media query: the 2-D drag needs the same number the CSS uses.
  useLayoutEffect(() => {
    const grid = gridRef.current

    if (!grid) {
      return
    }

    const measure = () => setCols(gridColumnsFor(grid.clientWidth))

    measure()

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(measure)

    observer.observe(grid)

    return () => observer.disconnect()
  }, [view])

  const handleCardPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, id: string, index: number) => {
      if (event.button !== 0 || !onReorder) {
        return
      }

      const slot = event.currentTarget.closest('li')?.getBoundingClientRect()

      pressRef.current = {
        cols,
        id,
        index,
        pitchX: (slot?.width ?? 0) + GRID_GAP_PX,
        pitchY: (slot?.height ?? 0) + GRID_GAP_PX,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY
      }

      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Capture is an assist, not a requirement — the drag still tracks moves that bubble through the card.
      }
    },
    [cols, onReorder]
  )

  const handleCardPointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const press = pressRef.current

      if (!press || press.pointerId !== event.pointerId) {
        return
      }

      const dx = event.clientX - press.startX
      const dy = event.clientY - press.startY

      if (!dragRef.current) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
          return
        }

        setSettled(true)

        const card = event.currentTarget.closest<HTMLElement>('.inft-card')

        if (card) {
          card.dataset.dragging = '1'
        }
      }

      // Auto-scroll near the list edges so long rosters stay reachable.
      const scroller = scrollRef.current

      if (scroller) {
        const rect = scroller.getBoundingClientRect()

        if (event.clientY < rect.top + 44) {
          scroller.scrollTop -= 12
        } else if (event.clientY > rect.bottom - 44) {
          scroller.scrollTop += 12
        }
      }

      const target = reorderTarget(press.index, dx, dy, press.cols, press.pitchX, press.pitchY, cards.length)

      dragRef.current = {
        cols: press.cols,
        dx,
        dy,
        from: press.index,
        id: press.id,
        pitchX: press.pitchX,
        pitchY: press.pitchY,
        target
      }
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

      const card = event.currentTarget.closest<HTMLElement>('.inft-card')

      if (card) {
        delete card.dataset.dragging
      }

      const active = dragRef.current

      if (!active) {
        return
      }

      // The click that follows this pointerup must not summon the iNFT.
      suppressClickRef.current = true

      if (active.target !== active.from) {
        const ids = cards.map(item => item.id)
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

  // Flip to the open state one frame after mount so the initial off-screen transform paints first.
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

  // v0.0.9 F4: another island taking the right edge (FILES, the notification centre) closes this one, animated.
  useEffect(() => watchRightEdge('collections', requestClose), [requestClose])

  // The unmount timer must key on the PHASE alone: `onClose` arrives as an inline arrow with a new identity on
  // every parent render, and with it in the deps each render during the close restarted the timer — under store
  // churn it never fired, leaving an invisible full-viewport scrim that ate every click. The ref makes the timer
  // fire exactly once per close, whatever the parent is doing.
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

  const retry = useCallback(() => {
    void retryInftScan()
  }, [])

  return (
    <>
      <div aria-hidden="true" className="inft-scrim" data-phase={phase} onClick={requestClose} />
      <section
        aria-busy={view === 'loading' || undefined}
        aria-label={copy.dialogLabel}
        aria-modal="true"
        className="inft-panel"
        data-phase={phase}
        data-view={view}
        id={PANEL_ID}
        role="dialog"
      >
        <header className="inft-panel__header">
          <div className="inft-panel__heading">
            <h2 className="inft-panel__title">{copy.title}</h2>
            {view === 'grid' ? (
              <p className="inft-panel__count">{copy.count(cards.length, collectionCount(cards))}</p>
            ) : null}
          </div>
          <div className="inft-panel__actions">
            {openBook ? (
              <IcPageButton onClick={openBook} tone="accent">
                {copy.openBook}
              </IcPageButton>
            ) : null}
            <button
              aria-label={copy.close}
              className="inft-panel__close"
              onClick={requestClose}
              ref={closeButtonRef}
              type="button"
            >
              <X aria-hidden="true" size={16} strokeWidth={2} />
            </button>
          </div>
        </header>

        {partial ? (
          <div className="inft-panel__notice">
            {/* Q renderer 6: the user has data, so this is a warning, not a failure; with no names to give, the
                scan's own reason is the cause. */}
            {/* r4d (design r4 F5-3): the one Rescan rides inside the alert it answers. */}
            <IcAlert action={{ label: copy.retry, onClick: retry }} tone="warning">
              {(missingCollections?.length ?? 0) === 0 && scanError
                ? copy.partialCause(scanError)
                : copy.partial(missingCollections ?? [])}
            </IcAlert>
          </div>
        ) : null}

        <div className="inft-panel__scroll" ref={scrollRef}>
          {view === 'loading' ? (
            <ul
              aria-busy="true"
              aria-label={copy.loading}
              className="inft-panel__body inft-panel__body--skeleton"
              data-cols={cols}
              ref={gridRef}
              role="status"
              style={{ '--inft-cols': cols } as CSSProperties}
            >
              {Array.from({ length: SKELETON_COUNT }, (_, i) => (
                <li aria-hidden="true" className="inft-skel" key={i}>
                  <span className="inft-skel__art" />
                  <span className="inft-skel__line" />
                  <span className="inft-skel__line inft-skel__line--short" />
                </li>
              ))}
            </ul>
          ) : view === 'signed-out' ? (
            <div className="inft-panel__state" role="status">
              <IcloneHeadMark className="inft-panel__state-mark" />
              <p className="inft-panel__line">{copy.signedOut}</p>
              <IcPageButton onClick={openPrivyLogin} tone="accent">
                {copy.connectWallet}
              </IcPageButton>
            </div>
          ) : view === 'error' ? (
            <ScanErrorState onRetry={retry} raw={scanError ?? null} />
          ) : view === 'book-empty' && bookEmpty ? (
            <div className="inft-panel__state" role="status">
              <IcloneHeadMark className="inft-panel__state-mark" />
              <p className="inft-panel__line">{bookEmpty.line}</p>
              <p className="inft-panel__rule">{bookEmpty.rule}</p>
            </div>
          ) : view === 'empty' ? (
            <div className="inft-panel__state" role="status">
              <IcloneHeadMark className="inft-panel__state-mark" />
              <p className="inft-panel__line">{copy.emptyWallet}</p>
            </div>
          ) : (
            <ul
              className={cn('inft-panel__body', settled && 'inft-panel__body--settled')}
              data-cols={cols}
              ref={gridRef}
              style={{ '--inft-cols': cols } as CSSProperties}
            >
              {cards.map((card, index) => {
                const isDragged = drag?.id === card.id
                let offset: [number, number] | null = null

                if (drag && isDragged) {
                  offset = [drag.dx, drag.dy]
                } else if (drag) {
                  if (index > drag.from && index <= drag.target) {
                    offset = slotOffset(index, index - 1, drag.cols, drag.pitchX, drag.pitchY)
                  } else if (index < drag.from && index >= drag.target) {
                    offset = slotOffset(index, index + 1, drag.cols, drag.pitchX, drag.pitchY)
                  }
                }

                return (
                  <InftCard
                    card={card}
                    dragging={isDragged}
                    index={index}
                    key={card.id}
                    offset={offset}
                    onPointerDown={handleCardPointerDown}
                    onPointerEnd={handleCardPointerEnd}
                    onPointerMove={handleCardPointerMove}
                    onSelect={handleSelect}
                    onSetUp={onSetUp}
                    reducedMotion={reducedMotion}
                  />
                )
              })}
            </ul>
          )}
        </div>
      </section>
    </>
  )
}

interface InftCardProps {
  card: INftCardData
  /** True while THIS card is the one being dragged. */
  dragging: boolean
  index: number
  /** Translate (px) for the dragged card, or for a card making room for it; null at rest. */
  offset: [number, number] | null
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>, id: string, index: number) => void
  onPointerEnd: (event: React.PointerEvent<HTMLButtonElement>) => void
  onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void
  onSelect: (id: string) => void
  onSetUp?: (id: string) => void
  reducedMotion: boolean
}

type CopyState = 'copied' | 'failed' | 'idle'

function InftCard({
  card,
  dragging,
  index,
  offset,
  onPointerDown,
  onPointerEnd,
  onPointerMove,
  onSelect,
  onSetUp,
  reducedMotion
}: InftCardProps): JSX.Element {
  const ref = useRef<HTMLElement>(null)
  const deactivated = isDeactivated(ownershipForId(useStore($ownership), card.id))
  const parsed = parseCardId(card.id)
  const [copyState, setCopyState] = useState<CopyState>('idle')

  // ONE pointermove (+ pointerleave to recenter) per card, rAF-throttled, writing --px/--py only — no layout
  // reads outside the listener, no per-frame allocation. Skipped entirely under reduced motion.
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
    }

    const onMove = (event: PointerEvent) => {
      // A card being dragged for reorder must not keep tilting under the pointer — the two transforms fight.
      if (el.dataset.dragging) {
        return
      }

      const rect = el.getBoundingClientRect()

      px = Math.min(1, Math.max(0, (event.clientX - rect.left) / (rect.width || 1)))
      py = Math.min(1, Math.max(0, (event.clientY - rect.top) / (rect.height || 1)))

      if (!raf) {
        raf = requestAnimationFrame(paint)
      }
    }

    const onLeave = () => {
      px = 0.5
      py = 0.5

      if (!raf) {
        raf = requestAnimationFrame(paint)
      }
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)

    return () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)

      if (raf) {
        cancelAnimationFrame(raf)
      }
    }
  }, [reducedMotion])

  useEffect(() => {
    if (copyState === 'idle') {
      return
    }

    const timer = window.setTimeout(() => setCopyState('idle'), COPY_RESET_MS[copyState])

    return () => window.clearTimeout(timer)
  }, [copyState])

  const copyContract = useCallback(() => {
    const contract = parsed?.contract

    if (!contract) {
      return
    }

    const write = navigator.clipboard?.writeText?.bind(navigator.clipboard)

    if (!write) {
      setCopyState('failed')

      return
    }

    write(contract).then(
      () => setCopyState('copied'),
      () => setCopyState('failed')
    )
  }, [parsed?.contract])

  // The `translate` property (not `transform`) on purpose: the entrance animation's forwards fill and the tilt
  // own `transform`; neither touches `translate`.
  const slotStyle = useMemo(
    () =>
      ({
        '--i': index,
        translate: offset ? `${offset[0]}px ${offset[1]}px` : undefined
      }) as CSSProperties,
    [index, offset]
  )

  const label = copy.cardLabel(card.name, card.collection)
  const state = deactivated ? 'deactivated' : card.configured ? 'economyos' : 'setup'

  return (
    <li className={cn('inft-card-slot', dragging && 'inft-card-slot--dragging')} style={slotStyle}>
      <article aria-label={label} className="inft-card" data-state={state} ref={ref}>
        <span aria-hidden="true" className="inft-card__edge" />

        {/* The primary action covers the whole card: Tab lands here, Enter opens (switchInft, as before). */}
        <button
          aria-label={label}
          className="inft-card__open"
          onClick={() => onSelect(card.id)}
          onPointerCancel={onPointerEnd}
          onPointerDown={event => onPointerDown(event, card.id, index)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          type="button"
        />

        {deactivated ? (
          <span className="inft-card__state ownership-pill">{DEACTIVATED_LABEL}</span>
        ) : (
          <span className="inft-card__state" data-tone={card.configured ? 'gold' : 'dim'}>
            {card.configured ? copy.economyOs : copy.setupNeeded}
          </span>
        )}

        <div className="inft-card__art">
          <span aria-hidden="true" className="inft-card__media">
            {card.imageUrl ? (
              <img alt="" className="inft-card__img" draggable={false} loading="lazy" src={card.imageUrl} />
            ) : (
              <span className="inft-card__placeholder">
                <IcloneHeadMark className="inft-card__headmark" />
              </span>
            )}
          </span>

          {/* The detail plate: slides up inside the art (never over the name) on hover or keyboard focus. */}
          <div className="inft-card__plate">
            <dl className="inft-card__facts">
              {parsed ? (
                <div className="inft-card__fact">
                  <dt>{copy.tokenId}</dt>
                  <dd className="inft-card__mono">#{parsed.tokenId}</dd>
                </div>
              ) : null}
              <div className="inft-card__fact">
                <dt>{copy.chain}</dt>
                <dd>{card.chain}</dd>
              </div>
              {parsed ? (
                <div className="inft-card__fact">
                  <dt>{copy.contract}</dt>
                  <dd className="inft-card__contract">
                    <span className="inft-card__mono">{shortAddress(parsed.contract)}</span>
                    <button
                      aria-label={copy.copyContract(parsed.contract)}
                      className="inft-card__copy"
                      data-state={copyState}
                      onClick={copyContract}
                      type="button"
                    >
                      {copyState === 'copied' ? (
                        <Check aria-hidden="true" size={11} strokeWidth={2} />
                      ) : (
                        <Copy aria-hidden="true" size={11} strokeWidth={1.8} />
                      )}
                      <span aria-live="polite">
                        {copyState === 'copied' ? copy.copied : copyState === 'failed' ? copy.copyFailed : copy.copy}
                      </span>
                    </button>
                  </dd>
                </div>
              ) : null}
            </dl>
            <div className="inft-card__plate-actions">
              <button
                aria-label={copy.openLabel(card.name)}
                className="inft-card__plate-btn inft-card__plate-btn--primary"
                onClick={() => onSelect(card.id)}
                type="button"
              >
                {copy.open}
              </button>
              {!card.configured && !deactivated && onSetUp ? (
                <button className="inft-card__plate-btn" onClick={() => onSetUp(card.id)} type="button">
                  {copy.setUp}
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <span className="inft-card__caption">
          <span className="inft-card__name">{card.name}</span>
          <span className="inft-card__meta">
            {card.collection} · {card.chain}
          </span>
        </span>
      </article>
    </li>
  )
}

/**
 * v0.0.9 r4d (design r4 F5-2): the Collection's scan error in the owner's words — what failed and who (the indexer or
 * the network) and that the wallet is unchanged — with its one Rescan inside the alert (r4b). The raw scan text (an
 * HTTP or RPC message) is never the sentence: it sits behind Details, selectable, for a bug report.
 */
function ScanErrorState({ onRetry, raw }: { onRetry: () => void; raw: null | string }) {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const cause = raw?.trim() ?? ''

  return (
    <div className="inft-panel__state inft-panel__state--error">
      <IcAlert action={{ label: copy.retry, onClick: onRetry }} title={copy.scanFailed}>
        {copy.scanFailedCause}
      </IcAlert>
      {cause ? (
        <>
          <button
            aria-controls={detailId}
            aria-expanded={open}
            className="icpg__btn icpg__btn--quiet"
            onClick={() => setOpen(v => !v)}
            type="button"
          >
            {open ? copy.hideDetails : copy.details}
          </button>
          <pre className="inft-panel__detail" data-selectable-text="true" hidden={!open} id={detailId}>
            {cause}
          </pre>
        </>
      ) : null}
    </div>
  )
}

