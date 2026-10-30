import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { DecodeText } from '@/components/ui/decode-text'
import { prefersReducedMotion } from '@/hooks/use-media-query'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $desktopBoot } from '@/store/boot'
import { $gatewaySwitching } from '@/store/gateway-switch'
import { $gatewayState } from '@/store/session'

// ── The boot word ────────────────────────────────────────────────────────────
// The word on the boot screen: the owner's theme name. To change it (another
// word, or lowercase), edit this one line — it renders exactly as written (the
// overlay lifts DecodeText's uppercase), and its first word always stays legible
// while the rest decodes, the way CONN did in CONNECTING. The `&` decodes in
// turn like every other glyph (the charset is mono, so it never shifts width);
// only spaces are never scrambled, so the gaps either side of it stay even.
export const BOOT_WORD = 'GODS & ROBOTS'
export const BOOT_WORD_LEGIBLE_PREFIX = BOOT_WORD.split(' ')[0].length
// ─────────────────────────────────────────────────────────────────────────────

// Exit choreography (ms): text fades down + out, hold, then the overlay fades.
const TEXT_OUT_MS = 360
const POST_TEXT_HOLD_MS = 300
const OVERLAY_OUT_MS = 520
// Preview-only: how long to "connect" for, and the pause before replaying.
const PREVIEW_CONNECT_MS = 2600
const PREVIEW_REPLAY_MS = 1100
// Survives a renderer reload (not a relaunch): a reload re-runs the boot
// progress from zero, but the backend it reconnects to is the one that already
// booted, so the full-window mask would only flash for the socket's reconnect.
export const COLD_BOOT_DONE_KEY = 'iclone.connecting.coldBootDone'

function readColdBootDone(): boolean {
  try {
    return window.sessionStorage.getItem(COLD_BOOT_DONE_KEY) === '1'
  } catch {
    return false
  }
}

function markColdBootDone() {
  try {
    window.sessionStorage.setItem(COLD_BOOT_DONE_KEY, '1')
  } catch {
    // Storage unavailable: a later reload shows the overlay, as before.
  }
}

type Phase = 'live' | 'text-out' | 'overlay-out' | 'gone'

// Dev affordance: a warm Cmd+R reconnects almost instantly, so the overlay
// only flashes. Load with `?connecting=1` to force a looping preview.
function forcedPreview(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return false
  }

  try {
    return new URLSearchParams(window.location.search).get('connecting') === '1'
  } catch {
    return false
  }
}

export function GatewayConnectingOverlay() {
  const gatewayState = useStore($gatewayState)
  const boot = useStore($desktopBoot)
  const gatewaySwitching = useStore($gatewaySwitching)
  const [previewing] = useState(forcedPreview)
  const reduce = prefersReducedMotion()
  const { t } = useI18n()
  // Under reduced motion, skip the multi-phase exit choreography (text-out →
  // hold → overlay fade) and jump straight to gone so the overlay unmounts
  // the instant the gateway opens. E2E screenshots rely on this to avoid
  // catching the overlay mid-fade.
  const [phase, setPhase] = useState<Phase>('live')
  // Once cold boot has completed once, never resurrect the fullscreen overlay
  // — soft gateway switches keep the shell and reskeleton the sidebar instead.
  const coldBootDoneRef = useRef<boolean | null>(null)

  if (coldBootDoneRef.current === null) {
    coldBootDoneRef.current = readColdBootDone()
  }

  if (!coldBootDoneRef.current && !boot.running && boot.progress >= 100 && !boot.error) {
    coldBootDoneRef.current = true
    markColdBootDone()
  }

  // The full-screen connecting overlay is for initial boot only. After a
  // healthy boot, flaky networks / sleep-wake can drop the socket and flip the
  // gateway state back to closed/error while the app reconnects. Do not cover
  // the chat then — users should still be able to type drafts, open settings,
  // and recover instead of staring at a modal CONNECTING screen.
  const initialBootActive = boot.visible || boot.running || boot.progress < 100

  const connecting =
    !coldBootDoneRef.current && !gatewaySwitching && gatewayState !== 'open' && !boot.error && initialBootActive

  // Latches once we've actually shown the overlay, so the brief frame where
  // gatewayState flips to "open" (connecting -> false) before the exit phase
  // kicks in doesn't unmount us and cause a flash.
  const shownRef = useRef(false)

  if (previewing || connecting) {
    shownRef.current = true
  }

  // Kick off the exit when connected: real connect, or a faked timer in preview.
  useEffect(() => {
    if (phase !== 'live') {
      return
    }

    if (previewing) {
      const id = window.setTimeout(() => setPhase('text-out'), PREVIEW_CONNECT_MS)

      return () => window.clearTimeout(id)
    }

    if (gatewayState === 'open' && shownRef.current) {
      // Under reduced motion, skip the multi-phase exit choreography
      // (text-out → hold → overlay fade) and jump straight to gone so the
      // overlay unmounts the instant the gateway opens. E2E screenshots
      // rely on this to avoid catching the overlay mid-fade.
      setPhase(reduce ? 'gone' : 'text-out')
    }
  }, [phase, previewing, gatewayState, reduce])

  // Advance the exit choreography: text-out -> overlay-out -> gone.
  useEffect(() => {
    if (phase === 'text-out') {
      const id = window.setTimeout(() => setPhase('overlay-out'), TEXT_OUT_MS + POST_TEXT_HOLD_MS)

      return () => window.clearTimeout(id)
    }

    if (phase === 'overlay-out') {
      const id = window.setTimeout(() => setPhase('gone'), OVERLAY_OUT_MS)

      return () => window.clearTimeout(id)
    }

    // Preview replays so we can keep watching the transition.
    if (phase === 'gone' && previewing) {
      const id = window.setTimeout(() => setPhase('live'), PREVIEW_REPLAY_MS)

      return () => window.clearTimeout(id)
    }
  }, [phase, previewing])

  // Boot failed — BootFailureOverlay owns the screen; don't linger behind it.
  if (boot.error && !previewing) {
    return null
  }

  // Real connect: once the fade finishes, get out of the way for good.
  if (phase === 'gone' && !previewing) {
    return null
  }

  // Never showed (e.g. gateway already up, or a renderer reload) — stay out.
  if (!previewing && !shownRef.current) {
    return null
  }

  const leaving = phase !== 'live'
  const overlayHidden = phase === 'overlay-out' || phase === 'gone'

  return (
    <div
      aria-busy={!leaving}
      className={cn(
        // ic-sys-void, not ic-sys-backdrop: the boot screen is pure black with
        // no bloom; the failure and crash screens keep their own stage.
        'fixed inset-0 z-(--z-connecting) grid place-items-center ic-sys ic-sys-void transition-opacity duration-500 ease-out',
        overlayHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
      )}
      data-boot-void=""
      // Masks the whole app while booting — must stay filled under window
      // glass or the shell shows through. Contract: `[data-glass-opaque]`
      // in styles.css.
      data-glass-opaque=""
      role="status"
    >
      {/* What a screen reader hears is the state the user is waiting on; the
          word on screen is the theme's name and its decode frames are glyph
          noise, so the visual word is hidden from assistive tech. */}
      <span className="sr-only">{t.common.connecting}</span>
      <DecodeText
        active={phase === 'live' && (previewing || connecting)}
        aria-hidden="true"
        className={cn(
          // whitespace-pre: the legible prefix and the decoding tail are
          // separate flex items, and a flex item drops its leading space —
          // without it the word renders as GODS& ROBOTS. It also keeps the
          // words on one line in a narrow window. normal-case: BOOT_WORD is
          // drawn as written, so its case is decided in one place.
          'whitespace-pre normal-case pl-[0.4em] text-(--ic-accent) transition duration-300 ease-out',
          leaving ? 'translate-y-2 opacity-0 saturate-0' : 'translate-y-0 opacity-100 saturate-100'
        )}
        cursor
        data-boot-word=""
        prefix={BOOT_WORD_LEGIBLE_PREFIX}
        text={BOOT_WORD}
      />
    </div>
  )
}
