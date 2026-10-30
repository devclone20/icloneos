/**
 * The compatibility verdict next to Update. The gate itself is enforced in
 * Electron main (hermes:updates:apply); this only shows it and shapes the
 * button. A missing verdict is UNKNOWN, and UNKNOWN is never GREEN. INFO is a
 * new capability, never a break, so it reads as GREEN.
 */

import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { IcButton } from '@/components/onboarding/ic-system'
import { AlertTriangle, CheckCircle2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $compatVerdict, beginOwnerHold, cancelOwnerHold, releaseOwnerHold } from '@/store/iclone-compat'

type CompatLevel = 'AMBER' | 'GREEN' | 'RED' | 'UNKNOWN'

interface CompatGate {
  /** Owner hold before the update starts; 0 = a plain click. */
  holdMs: number
  label: string
}

const CHIP: Record<CompatLevel, { className: string; text: string }> = {
  GREEN: { className: 'border-(--ic-success) text-(--ic-success)', text: 'Compatible' },
  AMBER: { className: 'border-(--ic-warning) text-(--ic-warning)', text: 'Review changes' },
  RED: { className: 'border-(--ic-danger) text-(--ic-danger)', text: 'Breaks the app' },
  UNKNOWN: { className: 'border-(--ic-border-subtle) text-(--ic-text-2)', text: 'Not verified' }
}

const GATE: Record<CompatLevel, CompatGate> = {
  GREEN: { holdMs: 0, label: 'Update' },
  AMBER: { holdMs: 0, label: 'Update and accept' },
  RED: { holdMs: 3000, label: 'Hold to override' },
  UNKNOWN: { holdMs: 1500, label: 'Hold to update' }
}

export function compatLevel(level: null | string | undefined): CompatLevel {
  if (level === 'INFO') {
    return 'GREEN'
  }

  return level === 'GREEN' || level === 'AMBER' || level === 'RED' ? level : 'UNKNOWN'
}

export function compatGate(level: null | string | undefined): CompatGate {
  return GATE[compatLevel(level)]
}

export function CompatChip({ level, title }: { level: null | string | undefined; title?: string }) {
  const known = compatLevel(level)
  const chip = CHIP[known]
  const Icon = known === 'GREEN' ? CheckCircle2 : AlertTriangle

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-(--ic-radius-pill) border px-2 py-0.5 text-[0.7rem] font-medium leading-none',
        chip.className
      )}
      data-iclone-compat-level={known}
      title={title}
    >
      <Icon aria-hidden className="size-3" />
      {chip.text}
    </span>
  )
}

const NAMES_SHOWN = 4

type HoldPhase = 'accepting' | 'holding' | 'idle'

/**
 * Update for the runtime, shaped by the verdict main gates on (`pending.json`).
 * GREEN is a plain click. Anything else asks main to time the owner's hold:
 * press begins it, main answers with the hold it requires, and only a hold
 * that lasts that long mints the ack — naming every finding — before install.
 * Releasing early cancels the hold in main.
 */
export function CompatUpdateButton({ label, onInstall }: { label: string; onInstall: () => void }) {
  const verdict = useStore($compatVerdict)
  const level = compatLevel(verdict?.level)
  const gate = GATE[level]

  const names = useMemo(
    () => [...new Set((verdict?.cards ?? []).filter(c => compatLevel(c.level) !== 'GREEN').flatMap(c => c.names))],
    [verdict]
  )

  const [phase, setPhase] = useState<HoldPhase>('idle')
  const [holdMs, setHoldMs] = useState(0)
  const [error, setError] = useState<null | string>(null)
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
    async (id: number, verdictId: string, nonce: string) => {
      live.current = false
      setPhase('accepting')
      const minted = await releaseOwnerHold(verdictId, nonce, names)

      if (id !== attempt.current) {
        return
      }

      setPhase('idle')
      setHoldMs(0)

      if (minted.ok) {
        onInstall()
      } else {
        setError(`The update gate refused the override (${minted.reason}).`)
      }
    },
    [names, onInstall]
  )

  const press = useCallback(async () => {
    if (!verdict) {
      setError('No verdict for the update target yet — the check runs after the next update check.')

      return
    }

    stop()
    const id = attempt.current
    setError(null)
    setPhase(gate.holdMs > 0 ? 'holding' : 'accepting')
    live.current = true
    const begun = await beginOwnerHold(verdict.id)

    if (id !== attempt.current) {
      return
    }

    if (!begun.ok || begun.phase !== 'begin') {
      live.current = false
      setPhase('idle')
      setError(`The update gate refused the hold (${begun.ok ? 'unexpected answer' : begun.reason}).`)

      return
    }

    setHoldMs(begun.holdMs)
    timer.current = window.setTimeout(() => {
      timer.current = null
      void mint(id, verdict.id, begun.nonce)
    }, begun.holdMs)
  }, [gate.holdMs, mint, stop, verdict])

  const release = useCallback(() => {
    if (phase === 'holding' && live.current) {
      stop()
      setPhase('idle')
      setHoldMs(0)
    }
  }, [phase, stop])

  if (level === 'GREEN') {
    return (
      <IcButton className="font-semibold" onClick={onInstall} size="lg">
        {label}
      </IcButton>
    )
  }

  const held = gate.holdMs > 0
  const shown = names.slice(0, NAMES_SHOWN)

  return (
    <div className="grid gap-2" data-iclone-compat-update={level}>
      <div className="flex justify-center">
        <CompatChip level={level} />
      </div>
      <IcButton
        className="relative overflow-hidden font-semibold"
        disabled={phase === 'accepting'}
        onClick={held ? undefined : () => void press()}
        onKeyDown={held ? e => (e.key === ' ' || e.key === 'Enter') && !e.repeat && void press() : undefined}
        onKeyUp={held ? e => (e.key === ' ' || e.key === 'Enter') && release() : undefined}
        onPointerCancel={held ? release : undefined}
        onPointerDown={held ? () => void press() : undefined}
        onPointerLeave={held ? release : undefined}
        onPointerUp={held ? release : undefined}
        size="lg"
        variant={level === 'RED' ? 'destructive' : 'default'}
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-(--ic-glint) transition-[width] ease-linear"
          style={{ width: holdMs > 0 ? '100%' : '0%', transitionDuration: `${holdMs}ms` }}
        />
        <span className="relative">
          {phase === 'holding' ? 'Keep holding…' : phase === 'accepting' ? 'Starting the update…' : gate.label}
        </span>
      </IcButton>
      {shown.length > 0 && (
        <p className="text-center text-xs text-(--ic-text-2)">
          Overrides {names.length === 1 ? 'one finding' : `${names.length} findings`}:{' '}
          <span className="font-mono">{shown.join(' · ')}</span>
          {names.length > shown.length ? ` +${names.length - shown.length}` : ''}
        </p>
      )}
      {error && <p className="text-center text-xs text-(--ic-danger)">{error}</p>}
    </div>
  )
}
