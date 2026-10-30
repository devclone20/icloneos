/**
 * The owner's compatibility review inside Settings › Updates › Agent: the same main-timed ack the updates overlay's
 * chip mints (`beginOwnerHold` → `releaseOwnerHold`, gate.ts), so the gate in main — not this control — decides. A
 * press starts main's clock; a release before main's hold cancels it there; only a hold main measured long enough,
 * naming every finding, mints the ack. GREEN needs no ack and AMBER a plain click (main's hold is 0).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { AgentUpdateCopy } from '@/i18n/en'
import { Loader2 } from '@/lib/icons'
import { beginOwnerHold, cancelOwnerHold, releaseOwnerHold } from '@/store/iclone-compat'
import type { IcloneCompatVerdict } from '@/types/iclone-compat'

export type ReviewLevel = 'AMBER' | 'GREEN' | 'RED' | 'UNKNOWN'

/** The gate's level for a verdict: INFO is a new capability, never a break; anything unreadable is UNKNOWN. */
export function reviewLevel(level: null | string | undefined): ReviewLevel {
  if (level === 'INFO') {
    return 'GREEN'
  }

  return level === 'GREEN' || level === 'AMBER' || level === 'RED' ? level : 'UNKNOWN'
}

/** Every name the owner accepts: the gate requires each RED one, and the overlay chip names all non-GREEN cards. */
export function reviewNames(verdict: IcloneCompatVerdict | null): string[] {
  return [...new Set((verdict?.cards ?? []).filter(c => reviewLevel(c.level) !== 'GREEN').flatMap(c => c.names))]
}

type Phase = 'accepting' | 'holding' | 'idle'

export function ReviewHoldButton({
  copy,
  describedBy,
  onAccepted,
  verdict
}: {
  copy: AgentUpdateCopy
  /** Id of the sentence that says what the hold accepts (read with the button). */
  describedBy?: string
  onAccepted: () => void
  verdict: IcloneCompatVerdict
}) {
  const level = reviewLevel(verdict.level)
  const held = level === 'RED' || level === 'UNKNOWN'
  const [phase, setPhase] = useState<Phase>('idle')
  const [holdMs, setHoldMs] = useState(0)
  const [refused, setRefused] = useState(false)
  // Each press is one attempt; a release or unmount bumps it so late answers from main are dropped.
  const attempt = useRef(0)
  const live = useRef(false)
  const timer = useRef<null | number>(null)

  const stop = useCallback(() => {
    attempt.current += 1

    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }

    if (live.current) {
      live.current = false
      void cancelOwnerHold().catch(() => undefined)
    }
  }, [])

  useEffect(() => stop, [stop])

  const mint = useCallback(
    async (id: number, nonce: string) => {
      live.current = false
      setPhase('accepting')
      const minted = await releaseOwnerHold(verdict.id, nonce, reviewNames(verdict)).catch(() => null)

      if (id !== attempt.current) {
        return
      }

      setPhase('idle')
      setHoldMs(0)

      if (minted?.ok) {
        onAccepted()
      } else {
        setRefused(true)
      }
    },
    [onAccepted, verdict]
  )

  const press = useCallback(async () => {
    if (level === 'GREEN') {
      onAccepted()

      return
    }

    stop()
    const id = attempt.current
    setRefused(false)
    setPhase(held ? 'holding' : 'accepting')
    live.current = true
    const begun = await beginOwnerHold(verdict.id).catch(() => null)

    if (id !== attempt.current) {
      return
    }

    if (!begun?.ok || begun.phase !== 'begin') {
      live.current = false
      setPhase('idle')
      setRefused(true)

      return
    }

    setHoldMs(begun.holdMs)
    timer.current = window.setTimeout(() => {
      timer.current = null
      void mint(id, begun.nonce)
    }, begun.holdMs)
  }, [held, level, mint, onAccepted, stop, verdict.id])

  const release = useCallback(() => {
    if (phase === 'holding' && live.current) {
      stop()
      setPhase('idle')
      setHoldMs(0)
    }
  }, [phase, stop])

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        aria-describedby={describedBy}
        className="relative overflow-hidden"
        data-agent-review-hold={level}
        disabled={phase === 'accepting'}
        // Focus leaving mid-hold (Tab away, window switch) ends the hold like a release would.
        onBlur={held ? release : undefined}
        onClick={held ? undefined : () => void press()}
        onKeyDown={held ? e => (e.key === ' ' || e.key === 'Enter') && !e.repeat && void press() : undefined}
        onKeyUp={held ? e => (e.key === ' ' || e.key === 'Enter') && release() : undefined}
        onPointerCancel={held ? release : undefined}
        onPointerDown={held ? () => void press() : undefined}
        onPointerLeave={held ? release : undefined}
        onPointerUp={held ? release : undefined}
        size="sm"
      >
        <span
          aria-hidden
          className="absolute inset-y-0 start-0 bg-current/15 transition-[width] ease-linear"
          style={{ width: holdMs > 0 ? '100%' : '0%', transitionDuration: `${holdMs}ms` }}
        />
        <span className="relative inline-flex items-center gap-1.5">
          {phase === 'accepting' && <Loader2 className="size-3.5 motion-safe:animate-spin" />}
          {phase === 'holding' ? copy.reviewHolding : copy.reviewAccept[level]}
        </span>
      </Button>
      {refused && (
        <span className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)" role="alert">
          {copy.reviewRefused}
        </span>
      )}
    </div>
  )
}
