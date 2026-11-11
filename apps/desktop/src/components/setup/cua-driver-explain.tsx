import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { triggerHaptic } from '@/lib/haptics'
import { ChevronRight, Loader2 } from '@/lib/icons'
import type { ComputerUseStatus } from '@/types/hermes'

import { type ComputerUsePhase, missingPanes, openCuaPane } from './computer-use-flow'
import { type ComputerUseState, CUA_DRIVER_WORDS as W } from './copy'

const NOTE = 'mt-1 block text-[0.75rem] leading-4 text-muted-foreground'
const TERM = 'text-[0.68rem] font-medium uppercase tracking-[0.08em] text-(--ui-text-tertiary)'
const BODY = 'mt-0.5 text-[0.78rem] leading-[1.15rem] text-muted-foreground'

/** What CuaDriver is, closed until asked for: an explanation, not a wall. */
export function CuaDriverExplain({ open: startOpen = false }: { open?: boolean }) {
  const [open, setOpen] = useState(startOpen)

  return (
    <div className="mt-1.5" data-cua-explain={open ? 'open' : 'closed'}>
      <button
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[0.75rem] text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen(value => !value)}
        type="button"
      >
        <ChevronRight className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        {W.disclose}
      </button>
      {open ? (
        <div className="mt-2 grid max-w-prose gap-2.5 border-l border-(--stroke-nous) pl-3">
          <p className="text-[0.8rem] leading-[1.2rem] text-foreground">{W.what}</p>
          <div>
            <p className={TERM}>{W.whyTitle}</p>
            <p className={BODY}>{W.accessibility}</p>
            <p className={BODY}>{W.screen}</p>
            <p className={BODY}>{W.identity}</p>
          </div>
          <div>
            <p className={TERM}>{W.installTitle}</p>
            <p className={BODY}>{W.install}</p>
          </div>
          <div>
            <p className={TERM}>{W.grantTitle}</p>
            <p className={BODY}>{W.grant}</p>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** The line under the row: what is happening now, and the buttons that open the exact panes. */
export function CuaDriverFlowNote({
  phase,
  reason,
  state,
  status
}: {
  phase: ComputerUsePhase
  reason: string
  state: ComputerUseState | null
  status: ComputerUseStatus | null
}) {
  const panes = state === 'needs' || state === 'unknown' ? missingPanes(status) : []

  const line =
    phase === 'waiting'
      ? W.waitingNote
      : phase === 'notAsked'
        ? W.notAsked
        : phase === 'failed'
          ? W.failed(reason)
          : phase === 'installFailed'
            ? W.installFailed
            : state === 'unknown'
              ? W.unreadable
              : null

  return (
    <>
      {line ? (
        <span className={NOTE} data-cua-phase={phase}>
          {line}
        </span>
      ) : null}
      {panes.length > 0 ? (
        <span className="mt-1.5 flex flex-wrap gap-2">
          {panes.map(pane => (
            <Button
              data-cua-pane={pane}
              key={pane}
              onClick={() => {
                triggerHaptic('selection')
                openCuaPane(pane)
              }}
              size="sm"
              variant="text"
            >
              {pane === 'cua:accessibility' ? W.openAccessibility : W.openScreen}
            </Button>
          ))}
        </span>
      ) : null}
    </>
  )
}

export function CuaDriverAction({
  grant,
  install,
  phase,
  state
}: {
  grant: () => void
  install: () => void
  phase: ComputerUsePhase
  state: ComputerUseState | null
}) {
  const busy = phase === 'waiting' || phase === 'installing'

  if (state === 'notInstalled' || phase === 'installing') {
    return (
      <Button
        data-setup-action="install"
        disabled={busy}
        onClick={() => {
          triggerHaptic('selection')
          install()
        }}
        size="sm"
        variant="outline"
      >
        {phase === 'installing' ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {phase === 'installing' ? W.installing : W.installAction}
      </Button>
    )
  }

  if (state !== 'needs' && state !== 'unknown') {
    return null
  }

  return (
    <Button
      data-setup-action="request"
      disabled={busy}
      onClick={() => {
        triggerHaptic('selection')
        grant()
      }}
      size="sm"
      variant="outline"
    >
      {phase === 'waiting' ? <Loader2 className="size-3.5 animate-spin" /> : null}
      {phase === 'waiting' ? W.waiting : 'Allow…'}
    </Button>
  )
}
