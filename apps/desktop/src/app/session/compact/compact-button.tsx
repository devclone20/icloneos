import './compact.css'

import { useId } from 'react'

import { Button } from '@/components/ui/button'
import { Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { CompactResult } from './compact-result'
import { compactCopy } from './compact.copy'
import { useCompactSession } from './use-compact-session'

function CompactGlyph() {
  return (
    <svg aria-hidden className="ic-compact__glyph" fill="none" viewBox="0 0 16 16">
      <path
        d="M4 2.5 8 6l4-3.5M4 13.5 8 10l4 3.5M2.5 8h11"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  )
}

export interface CompactButtonProps {
  className?: string
  /** Runtime session id; defaults to the focused chat. */
  sessionId?: null | string
  /** `footer` = labelled action + progress + result row (context card);
   *  `head` = icon button for a window head. */
  variant?: 'footer' | 'head'
}

/** "Compact session" — the Hermes runtime's own compaction, any provider. */
export function CompactButton({ className, sessionId, variant = 'footer' }: CompactButtonProps) {
  const { compact, disabledReason, entry, running } = useCompactSession(sessionId)
  const reasonId = useId()
  const blocked = Boolean(disabledReason) && !running
  const glyph = running ? <Loader2 className="animate-spin" /> : <CompactGlyph />
  const progress = running ? (entry?.progress ?? compactCopy.running) : null

  if (variant === 'head') {
    return (
      <span className={cn('ic-compact', className)} data-variant="head" title={disabledReason ?? compactCopy.button}>
        <Button
          aria-busy={running}
          aria-describedby={blocked ? reasonId : undefined}
          aria-label={compactCopy.button}
          data-testid="compact-session-head"
          disabled={Boolean(disabledReason)}
          onClick={() => void compact()}
          size="icon-xs"
          variant="ghost"
        >
          {glyph}
        </Button>
        {blocked ? (
          <span className="sr-only" id={reasonId}>
            {disabledReason}
          </span>
        ) : null}
      </span>
    )
  }

  return (
    <div className={cn('ic-compact', className)} data-variant="footer">
      <div className="ic-compact__bar">
        <Button
          aria-busy={running}
          aria-describedby={blocked ? reasonId : undefined}
          className="ic-compact__action"
          data-testid="compact-session-button"
          disabled={Boolean(disabledReason)}
          onClick={() => void compact()}
          size="sm"
          variant="outline"
        >
          {glyph}
          {running ? compactCopy.running : compactCopy.button}
        </Button>
        {progress ? (
          <span aria-live="polite" className="ic-compact__progress" data-testid="compact-progress">
            {progress}
          </span>
        ) : blocked ? (
          <span className="ic-compact__reason" data-testid="compact-disabled-reason" id={reasonId}>
            {disabledReason}
          </span>
        ) : null}
      </div>
      {entry?.phase === 'done' && entry.outcome ? <CompactResult outcome={entry.outcome} /> : null}
    </div>
  )
}
