import { useStore } from '@nanostores/react'
import { type PointerEvent, StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { Input } from '@/components/ui/input'
import { normalizeLocale } from '@/i18n/languages'
import { loadedTranslations, loadTranslations, translationsOrEnglish } from '@/i18n/locale-loader'
import {
  PET_PROMPT_MAX_CHARS,
  type PetPromptRefusal,
  type PetPromptReply,
  petPromptText
} from '@/iclone-shared/pet-prompt'
import { Mail } from '@/lib/icons'
import { $petActivity, $petLiveActivity, $petScale, $petState, setPetScale } from '@/store/pet'
import {
  OVERLAY_PET_PAD_BOTTOM,
  overlayWindowSize,
  type PetOverlayBounds,
  type PetOverlayControl,
  type PetOverlayStatePayload
} from '@/store/pet-overlay'
import { ThemeProvider } from '@/themes/context'

import { PetBubble, PetPromptNote } from './pet-bubble'
import { usePet } from './pet-catalog'
import { petPixelHit } from './pet-hit'
import { petCssSize, PetSprite } from './pet-sprite'
import { type PetState, WAVE_SECONDS } from './pet-states'
import { usePetZoomGesture } from './use-pet-zoom-gesture'

const CLICK_SLOP_PX = 3
const DOUBLE_CLICK_MS = 250
/**
 * How long the box stays read-only waiting on the app's answer. Main answers at once when the app cannot take the
 * message (no main window, its page reloaded), and closing the box stops the wait. This bounds only a send still in
 * flight, and only past the composer's own submit ceiling (`PROMPT_SUBMIT_REQUEST_TIMEOUT_MS`, 30 min: a long turn
 * can take minutes to be acknowledged): by then that send has given up, so "not sent" is the truth, never a guess
 * that invites a duplicate. The box turns writable with its text and that line; a late sent/queued still clears it.
 */
const PET_PROMPT_ANSWER_MS = 31 * 60_000
/** The refusal's words in the locale: a reason (IPC, kebab) → its i18n key. */
const REFUSAL_KEY = { command: 'command', 'no-session': 'noSession', 'not-sent': 'notSent' } as const

/** What the box's one line says: a refusal's reason, or `unknown` — the app went away after handing the text on. */
type PetPromptNoteKind = 'unknown' | PetPromptRefusal

/** The text stays in the box (refused, or maybe sent): the line to show, if any. */
const noteOf = (result: PetPromptReply): null | PetPromptNoteKind =>
  result.outcome === 'refused' ? result.reason : result.outcome === 'unknown' ? 'unknown' : null

interface Drag {
  startX: number
  startY: number
  offX: number
  offY: number
  width: number
  height: number
  moved: boolean
}

/**
 * The popped-out pet's window (`?win=pet`): a transparent, always-on-top puppet. The main renderer pushes the pet
 * (id, scale, activity, unread, language) over IPC and this mirrors it into its own copies of the pet atoms, so it
 * draws the very same pet with no gateway of its own. Only the pet's opaque pixels catch the mouse; the rest of the
 * rectangle passes clicks through. Drag: move it anywhere. Click: it waves (every click, from the start) and opens
 * its prompt box — type a message, Enter hands it to the app's pet sender (main checks it on the way): sent to the
 * session on screen, or queued behind its running turn, and the box clears; refused (a command, no session, a send
 * that did not land) and the text stays with one line saying why; maybe sent (the app went away after it had handed the
 * message on) and the text stays too, with "check the chat" — never resent on its own. Escape or a click beside it
 * closes the box. Double-click: show/hide the app. Shift-click:
 * back into the app. Alt+wheel: a whole scale up or down. The mail marker: a turn finished while you were away —
 * click it to open the app.
 */
export function PetOverlayApp() {
  const [payload, setPayload] = useState<null | PetOverlayStatePayload>(null)
  const pet = usePet(payload?.petId ?? null)
  const live = useStore($petState)
  const awaiting = Boolean(useStore($petLiveActivity).awaitingInput)
  const scale = useStore($petScale)
  const [pokedAt, setPokedAt] = useState<null | number>(null)
  const [promptOpen, setPromptOpenState] = useState(false)
  const [draft, setDraft] = useState('')
  // A sent message waits for its answer (sent / queued / refused): the box keeps the text, read-only, until then.
  const [pending, setPending] = useState(false)
  // The box's one line: why the text is still there (a refusal), or that it may have gone already (`unknown`).
  const [refusal, setRefusal] = useState<null | PetPromptNoteKind>(null)
  const pendingIdRef = useRef<null | number>(null)
  // The message the box stopped waiting on (it closed, or the answer took too long): a late sent/queued for it still
  // clears the text, if the text is still the one that went out.
  const lateRef = useRef<null | { id: number; text: string }>(null)
  const answerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const draftRef = useRef('')
  draftRef.current = draft
  const submitSeqRef = useRef(0)
  // Read by the window-level mousemove listener (it must not re-subscribe on every toggle): written with the state.
  const promptOpenRef = useRef(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const petRef = useRef<HTMLDivElement | null>(null)
  const ignoreRef = useRef(true)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const api = window.hermesDesktop?.petOverlay
  const locale = normalizeLocale(payload?.locale)
  // K99: the pet window loads only its owner's locale (English until the chunk is in, then a re-render).
  const t = translationsOrEnglish(locale)
  const [, setLocaleArrived] = useState(0)

  useEffect(() => {
    if (loadedTranslations(locale)) {
      return
    }

    let current = true

    void loadTranslations(locale).then(() => current && setLocaleArrived(count => count + 1))

    return () => {
      current = false
    }
  }, [locale])

  const setIgnore = useCallback(
    (ignore: boolean) => {
      if (ignoreRef.current !== ignore) {
        ignoreRef.current = ignore
        api?.setIgnoreMouse(ignore)
      }
    },
    [api]
  )

  // Stop waiting on the message in flight (the box closed, or no answer came in time): the box is writable again with
  // its text; the message is remembered so a late answer can still clear it.
  const stopWaiting = useCallback(() => {
    clearTimeout(answerTimer.current)
    answerTimer.current = undefined
    const id = pendingIdRef.current

    if (id === null) {
      return false
    }

    lateRef.current = { id, text: petPromptText(draftRef.current) ?? '' }
    pendingIdRef.current = null
    setPending(false)

    return true
  }, [])

  // The prompt box needs the keyboard: the panel turns focusable (and the whole window takes the mouse) while it is
  // open, and goes back to a non-activating, click-through panel when it closes — at once, not on the next mouse move
  // (after an app switch none may come, and the window would eat the desktop's clicks).
  const setPromptOpen = useCallback(
    (open: boolean) => {
      if (promptOpenRef.current === open) {
        return
      }

      if (!open) {
        stopWaiting()
      }

      promptOpenRef.current = open
      api?.setFocusable(open)

      setIgnore(!open)
      setPromptOpenState(open)
    },
    [api, setIgnore, stopWaiting]
  )

  useEffect(() => {
    const off = api?.onState(next => {
      $petActivity.set(next.activity ?? {})
      $petScale.set(next.scale)
      setPayload(next)
    })

    const ready: PetOverlayControl = { type: 'ready' }
    api?.control(ready)

    return off
  }, [api])

  // What became of the message: only sent or queued clears the text and closes the box; refused keeps both and says
  // why on one line. An answer to anything but the message in flight (or the one the box stopped waiting on) is ignored.
  useEffect(
    () =>
      api?.onPromptResult(result => {
        if (result.id !== pendingIdRef.current) {
          const late = lateRef.current

          // A late answer counts only while the box still holds the text that went out: nothing typed since is lost.
          if (late && result.id === late.id) {
            lateRef.current = null

            if (petPromptText(draftRef.current) === late.text) {
              const note = noteOf(result)

              if (note) {
                setRefusal(note)
              } else {
                setRefusal(null)
                setDraft('')
                setPromptOpen(false)
              }
            }
          }

          return
        }

        clearTimeout(answerTimer.current)
        answerTimer.current = undefined
        pendingIdRef.current = null
        setPending(false)

        // Refused, or maybe sent (`unknown`): the text stays, writable, with its line — and nothing is resent.
        const note = noteOf(result)

        if (note) {
          setRefusal(note)

          return
        }

        setRefusal(null)
        setDraft('')
        setPromptOpen(false)
      }),
    [api, setPromptOpen]
  )

  // Click-through everywhere but the pet's own opaque pixels (and while a drag is on).
  useEffect(() => {
    setIgnore(true)

    const onMove = (ev: MouseEvent) => {
      if (dragRef.current || promptOpenRef.current) {
        setIgnore(false)

        return
      }

      const host = petRef.current
      const target = document.elementFromPoint(ev.clientX, ev.clientY)

      if (!host || !target || !host.contains(target)) {
        setIgnore(true)

        return
      }

      if (!(target instanceof HTMLCanvasElement)) {
        setIgnore(false)

        return
      }

      setIgnore(!petPixelHit(target, ev.clientX, ev.clientY))
    }

    window.addEventListener('mousemove', onMove)

    return () => {
      window.removeEventListener('mousemove', onMove)
      clearTimeout(clickTimer.current)
      clearTimeout(answerTimer.current)
    }
  }, [setIgnore])

  useEffect(() => {
    if (!promptOpen) {
      return
    }

    inputRef.current?.focus()
    // Another app (or the desktop) took the focus: the box closes, its text kept for next time.
    const onBlur = () => setPromptOpen(false)
    window.addEventListener('blur', onBlur)

    return () => window.removeEventListener('blur', onBlur)
  }, [promptOpen, setPromptOpen])

  useEffect(() => {
    if (pokedAt === null) {
      return
    }

    const id = window.setTimeout(() => setPokedAt(null), WAVE_SECONDS * 1000)

    return () => window.clearTimeout(id)
  }, [pokedAt])

  // Keep the window just big enough for the pet at its scale (the pet's feet stay put).
  useEffect(() => {
    if (!pet || !api) {
      return
    }

    const css = petCssSize(pet, scale)
    const { width, height } = overlayWindowSize(css.width, css.height)

    if (width === window.outerWidth && height === window.outerHeight) {
      return
    }

    const bounds: PetOverlayBounds = {
      height,
      width,
      x: Math.round(window.screenX + (window.outerWidth - width) / 2),
      y: Math.round(window.screenY + window.outerHeight - height)
    }

    api.setBounds(bounds)
    api.control({ bounds, type: 'bounds' })
  }, [pet, scale, api])

  const onScale = useCallback(
    (next: number) => {
      setPetScale(next)
      api?.control({ scale: next, type: 'scale' })
    },
    [api]
  )

  usePetZoomGesture(petRef, onScale, Boolean(pet))

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      return
    }

    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = {
      height: window.outerHeight,
      moved: false,
      offX: e.screenX - window.screenX,
      offY: e.screenY - window.screenY,
      startX: e.screenX,
      startY: e.screenY,
      width: window.outerWidth
    }
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current

    if (!drag) {
      return
    }

    if (Math.hypot(e.screenX - drag.startX, e.screenY - drag.startY) > CLICK_SLOP_PX) {
      drag.moved = true
    }

    if (drag.moved) {
      api?.setBounds({ height: drag.height, width: drag.width, x: e.screenX - drag.offX, y: e.screenY - drag.offY })
    }
  }

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)

    if (!drag) {
      return
    }

    if (drag.moved) {
      // A drag cancels a pending single click: the box does not pop open after you move the pet.
      clearTimeout(clickTimer.current)
      clickTimer.current = undefined
      const bounds = { height: drag.height, width: drag.width, x: e.screenX - drag.offX, y: e.screenY - drag.offY }
      api?.control({ bounds, type: 'bounds' })

      return
    }

    if (e.shiftKey) {
      api?.control({ type: 'pop-in' })

      return
    }

    if (clickTimer.current) {
      clearTimeout(clickTimer.current)
      clickTimer.current = undefined
      api?.control({ type: 'toggle-app' })

      return
    }

    clickTimer.current = setTimeout(() => {
      clickTimer.current = undefined
      setPokedAt(performance.now())
      setPromptOpen(!promptOpenRef.current)
    }, DOUBLE_CLICK_MS)
  }

  // Enter: send a non-blank message within the cap to the app's pet sender, one at a time; the box clears and
  // closes only when the app answers sent or queued (anything else stays here, with its reason).
  const send = () => {
    const text = petPromptText(draft)

    if (text === null || pendingIdRef.current !== null || !api) {
      return
    }

    const id = ++submitSeqRef.current
    pendingIdRef.current = id
    lateRef.current = null
    setPending(true)
    setRefusal(null)
    clearTimeout(answerTimer.current)
    answerTimer.current = setTimeout(() => {
      if (pendingIdRef.current === id && stopWaiting()) {
        setRefusal('not-sent')
      }
    }, PET_PROMPT_ANSWER_MS)
    api.control({ id, text, type: 'submit' })
  }

  if (!pet || !payload) {
    return null
  }

  const state: PetState = pokedAt !== null ? 'wave' : live

  return (
    <div
      onPointerDown={e => {
        // A click beside the pet (the transparent backdrop) closes the box.
        if (promptOpen && e.target === e.currentTarget) {
          setPromptOpen(false)
        }
      }}
      style={{
        alignItems: 'center',
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        justifyContent: 'flex-end',
        paddingBottom: OVERLAY_PET_PAD_BOTTOM,
        userSelect: 'none',
        width: '100vw'
      }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        ref={petRef}
        style={{ alignItems: 'center', cursor: 'grab', display: 'flex', flexDirection: 'column', touchAction: 'none' }}
        title={t.commandCenter.pets.popIn}
      >
        <div style={{ marginBottom: 4, minHeight: 24 }}>
          {promptOpen && refusal && (
            <PetPromptNote
              text={
                refusal === 'unknown'
                  ? t.commandCenter.pets.promptMaybeSent
                  : t.commandCenter.pets.promptRefused[REFUSAL_KEY[refusal]]
              }
            />
          )}
          {promptOpen ? (
            <Input
              aria-label={t.commandCenter.pets.promptLabel}
              className="w-48"
              data-pet-prompt=""
              maxLength={PET_PROMPT_MAX_CHARS}
              onChange={e => {
                setDraft(e.target.value)
                setRefusal(null)
              }}
              onKeyDown={e => {
                // An input method is composing (ja, zh, zh-hant): Enter commits the composition and Escape cancels
                // it — neither is ours. Chromium stamps isComposing on every keydown of a composition.
                if (e.nativeEvent.isComposing) {
                  return
                }

                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setPromptOpen(false)
                }
              }}
              // Typing and selecting in the box is not a drag of the pet.
              onPointerDown={e => e.stopPropagation()}
              onPointerUp={e => e.stopPropagation()}
              placeholder={t.commandCenter.pets.promptPlaceholder}
              readOnly={pending}
              ref={inputRef}
              size="sm"
              value={draft}
            />
          ) : (
            <PetBubble awaitingInput={awaiting} state={state} words={t.commandCenter.pets.bubble} />
          )}
        </div>
        <div style={{ lineHeight: 0, position: 'relative' }}>
          <PetSprite
            animateUnfocused
            clockKey={pokedAt ?? undefined}
            label={t.commandCenter.pets.label(pet.name)}
            pet={pet}
            readable
            scale={scale}
            state={state}
          />
          {payload.unread && (
            <button
              aria-label={t.commandCenter.pets.openApp}
              data-pet-unread
              onClick={() => api?.control({ type: 'open-app' })}
              onPointerDown={e => e.stopPropagation()}
              onPointerUp={e => e.stopPropagation()}
              style={{
                alignItems: 'center',
                background: 'var(--ui-bg-elevated)',
                border: '1px solid var(--ui-stroke-secondary)',
                borderRadius: 999,
                color: 'var(--foreground)',
                cursor: 'pointer',
                display: 'flex',
                height: 18,
                justifyContent: 'center',
                padding: 0,
                position: 'absolute',
                right: -6,
                top: -6,
                width: 18
              }}
              type="button"
            >
              <Mail style={{ height: 11, width: 11 }} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Boot the pet window. Loaded by the same bundle via `?win=pet`, so it shares the CSS and atoms but mounts only
 * the pet: no shell, no gateway, no config. The boot script paints an opaque themed background to avoid a flash
 * in normal windows; this window must be see-through, so every host layer is forced transparent.
 */
export function mountPetOverlay(): void {
  const style = document.createElement('style')
  style.textContent = 'html,body,#root{background:transparent !important;}'
  document.head.appendChild(style)
  document.title = 'Pet'

  const root = document.getElementById('root')

  if (!root) {
    return
  }

  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <PetOverlayApp />
      </ThemeProvider>
    </StrictMode>
  )
}
