import { type CSSProperties, type ReactNode, useRef } from 'react'

import { TITLEBAR_HEIGHT } from '@/app/shell/titlebar'
import { TitlebarIcon } from '@/app/shell/titlebar-icon'
import { Button } from '@/components/ui/button'
import { translateNow } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

import { OVERLAY_SURFACE_MARKER, useOverlaySurface } from './use-overlay-surface'

// Shared top clearance for overlay content that sits *beside* the floating
// close button (which is absolute at `0.1875rem + titlebar/2`, -translate-y-1/2,
// so it costs no layout space): a Panel's header and the split layout's left
// sidebar links. They ride up next to the X on the same line across every
// overlay (settings, system, agents, cron, …) — change it here, not per-surface.
// Main content sits *under* the X (top-right) and keeps its own taller pad.
export const OVERLAY_TOP_CLEARANCE = 'pt-[calc(var(--titlebar-height)/2-0.4375rem)]'

interface OverlayViewProps {
  children: ReactNode
  onClose: () => void
  closeLabel?: string
  contentClassName?: string
  /** Chrome pinned to the card's top edge, horizontally centered and riding
   *  the border half-in half-out (e.g. the Settings search pill). Rendered
   *  beside the card, not inside it — the card clips its own overflow. */
  edgeBadge?: ReactNode
  headerContent?: ReactNode
  rootClassName?: string
  /** Controls rendered on the close button's row, to its left. They ride the
   *  titlebar strip, so keep them titlebar-sized and quiet. */
  titlebarActions?: ReactNode
}

export function OverlayView({
  children,
  onClose,
  closeLabel = translateNow('common.close'),
  contentClassName,
  edgeBadge,
  headerContent,
  rootClassName,
  titlebarActions
}: OverlayViewProps) {
  const closeOverlay = () => {
    triggerHaptic('close')
    onClose()
  }

  // Focus in, Tab trapped, focus returned, Esc closes: the one contract every
  // overlay surface shares (use-overlay-surface.ts).
  const cardRef = useOverlaySurface<HTMLDivElement>(onClose)

  // A backdrop click only dismisses when the press ALSO began on the backdrop.
  // Chrome fires `click` on the nearest common ancestor of press and release,
  // so a press on a sidebar row near the card's bottom edge that is released a
  // few pixels past it (or a text selection dragged out of the card) would
  // otherwise land on the backdrop and close the overlay.
  const pressOnBackdropRef = useRef(false)

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 bg-black/22 backdrop-blur-[0.125rem]',
        // Equidistant inset on every side. The top value is driven by the
        // titlebar height so the card clears the OS traffic-lights vertically;
        // since the card top already sits below them, the left needs no extra
        // inset — keeping all sides equal so the card is ~full-width at any size.
        'p-[calc(var(--titlebar-height)+0.625rem)]',
        'sm:p-[calc(var(--titlebar-height)+0.875rem)]'
      )}
      // Tells the composer's type-to-focus it is covered (see OVERLAY_SURFACE_MARKER).
      {...OVERLAY_SURFACE_MARKER}
      onClick={event => {
        const pressOnBackdrop = pressOnBackdropRef.current
        pressOnBackdropRef.current = false

        if (pressOnBackdrop && event.target === event.currentTarget) {
          closeOverlay()
        }
      }}
      onPointerDown={event => {
        pressOnBackdropRef.current = event.target === event.currentTarget
      }}
      role="presentation"
      // Window-level chrome: overlays always clear the real titlebar. The
      // contrib shell zeroes --titlebar-height for CONTENT areas (panes sit
      // below its in-flow title bar), and CSS vars inherit through the DOM —
      // so a fixed overlay mounted inside a zone would read 0 and bleed to
      // the edges. Re-pin the real height at the overlay root.
      style={{ '--titlebar-height': `${TITLEBAR_HEIGHT}px` } as CSSProperties}
    >
      <div className="relative h-full min-h-0">
        <div
          className={cn(
            'relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) shadow-md outline-none',
            rootClassName
          )}
          // Marks the card as a RAISED surface for window glass: while the field
          // behind it thins to show the desktop, this card stays near-opaque
          // (see the [data-glass-raised] rules in styles.css). Inert otherwise.
          data-glass-raised=""
          ref={cardRef}
          // Focusable as a container (the focus contract above), never a Tab stop.
          tabIndex={-1}
        >
          {/* The drag region is CUT AROUND the control corner instead of
              painted across it. The old shape — one full-width drag strip
              with no-drag carve-outs on the children — hung the carve-outs
              on absolutely-positioned, TRANSFORMED elements, and
              -webkit-app-region on a transformed element is exactly the
              carve-out macOS is known to drop: when it does, a click on the
              overlay's ✕ becomes a window drag and the close silently never
              fires. The right corner is simply not part of the drag region
              now, so no carve-out has to hold. */}
          <div className="pointer-events-none absolute left-0 right-40 top-0 z-10 h-[calc(var(--titlebar-height)+0.1875rem)] [-webkit-app-region:drag]" />
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[calc(var(--titlebar-height)+0.1875rem)]">
            {headerContent && (
              <div className="pointer-events-auto absolute left-1/2 top-[calc(0.5rem+var(--titlebar-height)/2)] -translate-x-1/2 -translate-y-1/2 [-webkit-app-region:no-drag]">
                {headerContent}
              </div>
            )}

            <div className="pointer-events-auto absolute right-3 top-[calc(0.1875rem+var(--titlebar-height)/2)] flex -translate-y-1/2 items-center gap-1.5 [-webkit-app-region:no-drag]">
              {titlebarActions}

              <Button
                aria-label={closeLabel}
                className="text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
                onClick={closeOverlay}
                size="icon-titlebar"
                variant="ghost"
              >
                <TitlebarIcon name="close" />
              </Button>
            </div>
          </div>

          {/* No top padding here: the split-layout columns own their own
              titlebar clearance so their backgrounds run flush to the card top
              (otherwise the card surface shows as a gap above the sidebar). */}
          <div className={cn('min-h-0 flex flex-1 flex-col', contentClassName)}>{children}</div>
        </div>

        {/* Sibling of the card, not a child: the card clips its own overflow
            (rounded corners), and the badge deliberately straddles the top
            border — half above, half below. */}
        {edgeBadge && <div className="absolute left-1/2 top-0 z-20 -translate-x-1/2 -translate-y-1/2">{edgeBadge}</div>}
      </div>
    </div>
  )
}
