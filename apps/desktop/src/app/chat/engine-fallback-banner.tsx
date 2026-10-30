import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { useInRouterContext, useNavigate } from 'react-router'

import { SETTINGS_ROUTE } from '@/app/routes'
import { readFallbackSeen, writeFallbackSeen } from '@/app/settings/engine-settings-model'
import { enEngine } from '@/i18n/en'
import { cn } from '@/lib/utils'
import { $selectedStoredSessionId } from '@/store/session'

const ENGINE_SETTINGS_LINK = `${SETTINGS_ROUTE}?tab=engine`
const POLL_MS = 10_000
const FRESH_MS = 10 * 60_000

const BAR = cn(
  'pointer-events-auto mx-auto mb-1 flex w-full max-w-(--composer-max-width,48rem) items-center gap-2 rounded-md px-3 py-1.5',
  'border border-(--ic-border-subtle) bg-(--ic-surface-raised) text-xs text-(--ic-text-ramp-80)'
)

const LINK = 'shrink-0 rounded px-1.5 font-medium text-[color:var(--ic-text-1)] underline-offset-2 hover:underline'

type Fallback = { at: number; reason: string; text: string }

export function freshFallback(last: Fallback | null | undefined, seenAt: number, now: number): Fallback | null {
  return last && last.at > seenAt && now - last.at < FRESH_MS ? last : null
}

const BOUND_KEY = 'iclone.engine.fallbackSession'

/** The fallback is a fact about ONE conversation: the one on stage when it
 *  first arrived. Bound once per `at`; a fallback that arrives with no session
 *  on stage binds to none and is never shown (U1-p2-04). */
export function bindFallbackSession(at: number, selectedId: null | string, read = readBound, write = writeBound) {
  const bound = read()

  if (bound?.at === at) {
    return bound.sessionId
  }

  write({ at, sessionId: selectedId })

  return selectedId
}

type Bound = { at: number; sessionId: null | string }

const ANNOUNCED_KEY = 'iclone.engine.fallbackAnnounced'
const ANNOUNCED_MAX = 50

/**
 * K54: the line is news once, not after every answer. A fallback is announced once per conversation and
 * reason; every later fallback with the same reason in the same conversation is consumed silently (seen, never
 * shown). A new conversation, or a different reason (the engine fell back for another cause), announces again.
 * Returns the list to store when it should announce, or null to stay silent.
 */
export function announceOnce(
  sessionId: string,
  reason: string,
  announced: readonly string[]
): null | readonly string[] {
  const key = `${sessionId}|${reason}`

  return announced.includes(key) ? null : [...announced.filter(entry => entry !== key), key].slice(-ANNOUNCED_MAX)
}

// n1 (V3-K critic r1): what this run has announced, kept in memory too. Without storage (none, or it refuses reads
// or writes) the list would read back empty and the line would come back after every answer; with this it is
// announced once per run instead, as the comment always said. While storage works it stays the only record.
let announcedThisRun: readonly string[] = []
let storageRefusedWrite = false

function readAnnounced(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(ANNOUNCED_KEY)

    if (raw === undefined) {
      return [...announcedThisRun]
    }

    const parsed: unknown = JSON.parse(raw ?? '[]')
    const stored = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []

    return storageRefusedWrite ? [...new Set([...stored, ...announcedThisRun])] : stored
  } catch {
    return [...announcedThisRun]
  }
}

function writeAnnounced(announced: readonly string[]): void {
  announcedThisRun = announced

  try {
    globalThis.localStorage?.setItem(ANNOUNCED_KEY, JSON.stringify(announced))
    storageRefusedWrite = false
  } catch {
    // No storage: announced once per run instead (announcedThisRun).
    storageRefusedWrite = true
  }
}

function readBound(): Bound | null {
  try {
    const raw = globalThis.localStorage?.getItem(BOUND_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null

    return parsed && typeof parsed === 'object' && 'at' in parsed ? (parsed as Bound) : null
  } catch {
    return null
  }
}

function writeBound(bound: Bound): void {
  try {
    globalThis.localStorage?.setItem(BOUND_KEY, JSON.stringify(bound))
  } catch {
    // No storage: the binding lives for this run only.
  }
}

/** One line above the composer after a Claude Code turn was answered by the fallback engine (the one in
 *  use before Claude Code). The engine choice is kept; the line only tells the person what happened
 *  (U1-p2-04). Mounted for every user, so it polls the plugin's files only and never starts `claude`. */
export function EngineFallbackBanner() {
  const bridge = window.hermesDesktop?.icloneClaudeCode
  const inRouter = useInRouterContext()
  const [fallback, setFallback] = useState<Fallback | null>(null)
  const [boundSession, setBoundSession] = useState<null | string>(null)
  const selectedSession = useStore($selectedStoredSessionId)

  useEffect(() => {
    if (!bridge) {
      return
    }

    let alive = true

    const poll = async () => {
      const status = await bridge.fallbackState().catch(() => null)

      if (alive) {
        const fresh = freshFallback(status?.lastFallback, readFallbackSeen(), Date.now())
        const selected = $selectedStoredSessionId.get()

        if (fresh && bindFallbackSession(fresh.at, selected) === selected && selected) {
          // Seen as soon as it arrives on its own conversation; shown only the first time for this reason there.
          writeFallbackSeen(fresh.at)

          const next = announceOnce(selected, fresh.reason, readAnnounced())

          if (next) {
            writeAnnounced(next)
            setFallback(fresh)
            setBoundSession(selected)
          }
        }
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)

    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [bridge])

  if (!fallback || boundSession !== selectedSession) {
    return null
  }

  const dismiss = () => {
    writeFallbackSeen(fallback.at)
    setFallback(null)
  }

  return (
    <div aria-live="polite" className={BAR} data-engine-fallback={fallback.reason} role="status">
      <span aria-hidden="true" className="text-[color:var(--ic-danger)]">
        ●
      </span>
      <span className="min-w-0 flex-1 truncate">{enEngine.fallback}</span>
      {inRouter ? <FixLink onFix={dismiss} /> : null}
      <button
        aria-label={enEngine.dismiss}
        className="shrink-0 rounded px-1 text-(--ic-text-2) hover:text-[color:var(--ic-text-1)]"
        onClick={dismiss}
        type="button"
      >
        ✕
      </button>
    </div>
  )
}

function FixLink({ onFix }: { onFix: () => void }) {
  const navigate = useNavigate()

  return (
    <button
      className={LINK}
      onClick={() => {
        onFix()
        navigate(ENGINE_SETTINGS_LINK)
      }}
      type="button"
    >
      {enEngine.fix}
    </button>
  )
}
