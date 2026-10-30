import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useState } from 'react'

import { type SessionView, useSessionView } from '@/app/chat/session-view'
import { ContextCard, ContextRing } from '@/app/context-panel/context-panel'
import { CONTEXT_PANEL_COPY } from '@/app/context-panel/context-panel.copy'
import { contextHeadline, formatTokens } from '@/app/context-panel/context-rows'
import { useContextUsage } from '@/app/context-panel/use-context-panel'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const CHIP = cn(
  'h-(--composer-control-size) min-w-0 shrink-0 gap-1.5 rounded-md px-2 text-xs font-normal tabular-nums',
  'text-(--ic-text-2) hover:bg-(--ic-fill-hover) hover:text-[color:var(--ic-text-1)]',
  'data-[state=open]:bg-(--ic-fill-hover) data-[state=open]:text-[color:var(--ic-text-1)]'
)

/**
 * One door per SURFACE (lead decision, recorded in
 * gates/L/fronts.json; corrected by the r2 critic): the Message window's head
 * band carries its own context door since the owner asked for it there
 * (msg-head.tsx), and it claims the door for the surface it covers. Two doors
 * to the same card, ~300 px apart on ONE surface, is what the chip would
 * otherwise add — so the chip yields there, and only there.
 *
 * The set is keyed by the claiming `SessionView`, the same per-surface identity
 * `use-context-panel.ts` keys its usage atoms by: a session TILE is a second
 * `[data-chat-surface]` in the SAME document with its own view, so a document-
 * wide flag (what r2 shipped) took away the only door to a tile's own numbers.
 * The HUD and the browser popout are their own windows, hence their own module
 * state, and no band: there the chip stays the only way in.
 */
const $bandContextDoors = atom<ReadonlySet<SessionView>>(new Set<SessionView>())

/** Claims counted per view: a remount (React strict mode mounts an effect
 *  twice) must not let the first cleanup drop the second claim. */
const bandDoorClaims = new Map<SessionView, number>()

const publishBandDoors = () => $bandContextDoors.set(new Set(bandDoorClaims.keys()))

/**
 * Raise the band's context door for ONE surface; the returned function lowers
 * it again (the band calls it on unmount). Idempotent per call, so an effect
 * cleanup that runs twice cannot lower someone else's door.
 */
export function claimBandContextDoor(view: SessionView): () => void {
  bandDoorClaims.set(view, (bandDoorClaims.get(view) ?? 0) + 1)
  publishBandDoors()

  let released = false

  return () => {
    if (released) {
      return
    }

    released = true

    const left = (bandDoorClaims.get(view) ?? 1) - 1

    if (left > 0) {
      bandDoorClaims.set(view, left)
    } else {
      bandDoorClaims.delete(view)
    }

    publishBandDoors()
  }
}

/** Test seam: the surfaces whose band door is up right now. */
export const bandContextDoorSurfaces = (): ReadonlySet<SessionView> => $bandContextDoors.get()

/**
 * Live-gate seam — the same shape `store/session-states.ts` uses for
 * `__HERMES_SESSION_TILES__`. A gate that can only count chips in the DOM
 * cannot tell "this surface yielded" from "every surface hid" (that is how r2's
 * document-wide flag passed), so it reads the claimed surfaces instead. Kinds
 * only: the view objects themselves stay inside the module.
 */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__icloneContextDoors = () =>
    [...$bandContextDoors.get()].map(view => view.kind)
}

/**
 * Composer context chip: ring + % used (and used / max when there is room),
 * straight from this surface's live `session.usage`. Opens the context card.
 * Hidden until the runtime has reported a context window, and on the one
 * surface whose Message band already carries that door.
 */
export function ContextChip({ compact = false, disabled = false }: { compact?: boolean; disabled?: boolean }) {
  const bandDoors = useStore($bandContextDoors)
  const view = useSessionView()
  const runtimeId = useStore(view.$runtimeId)
  const usage = useContextUsage(view)
  const [open, setOpen] = useState(false)
  const headline = contextHeadline(usage, null)

  // `bandDoors.has(view)`, never a document-wide flag: the question is whether
  // THIS surface already has a door, not whether any surface does.
  if (bandDoors.has(view) || !runtimeId || !headline || headline.max <= 0) {
    return null
  }

  const percent = Math.round(headline.percent)
  const used = formatTokens(headline.used, headline.estimated)
  const max = formatTokens(headline.max)

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={CONTEXT_PANEL_COPY.chipLabel(percent, used, max)}
          className={CHIP}
          data-testid="context-chip"
          disabled={disabled}
          type="button"
          variant="ghost"
        >
          <ContextRing percent={headline.percent} />
          <span data-testid="context-chip-percent">{percent}%</span>
          {compact ? null : (
            <span data-testid="context-chip-used">
              {used} / {max}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] max-w-[calc(100vw-16px)] p-0" side="top">
        <ContextCard open={open} view={view} />
      </PopoverContent>
    </Popover>
  )
}
