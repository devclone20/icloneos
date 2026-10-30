import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

import { useConsentCopy } from './copy'
import { PermissionAskBody } from './permission-ask'
import { consentRow, permissionName } from './rows'
import { $consent, consentBridge, loadConsent } from './store'
import type { ConsentDoorChoice, ConsentDoorRequest, PermissionDoorChoice } from './types'

/**
 * The consent door's sheet: "Your agent needs <Permission> — <reason>", answered Allow once / Allow always / Deny.
 * Main queues the requests and sends the one on screen; no answer within two minutes is a Deny (main's clock).
 * V3-F: the same sheet is the one place every permission ask is answered (a request carrying `permission`).
 * `doorAnswer` must run synchronously in the button's own click handler — the preload attaches the click's proof.
 */
export function ConsentDoorSheet() {
  const bank = useConsentCopy()
  const copy = bank.door
  const { snapshot } = useStore($consent)
  const [request, setRequest] = useState<ConsentDoorRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [entered, setEntered] = useState(false)
  const denyRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const bridge = consentBridge()

    if (!bridge?.onDoor) {
      return
    }

    const off = bridge.onDoor(next => setRequest(next))

    void bridge.doorCurrent?.().then(
      current => setRequest(previous => previous ?? current),
      () => undefined
    )

    return off
  }, [])

  useEffect(() => {
    setBusy(false)
    setEntered(false)

    if (!request) {
      return
    }

    const frame = requestAnimationFrame(() => setEntered(true))

    denyRef.current?.focus()

    return () => cancelAnimationFrame(frame)
  }, [request])

  if (!request) {
    return null
  }

  const policy = snapshot?.bundled
  const name = permissionName(policy, request.key, bank)
  const purpose = policy ? consentRow(policy, request.key, bank).purpose : ''

  const answer = (choice: ConsentDoorChoice | PermissionDoorChoice) => {
    const bridge = consentBridge()

    if (!bridge?.doorAnswer || busy) {
      return
    }

    triggerHaptic('selection')
    setBusy(true)
    void bridge.doorAnswer({ id: request.id, choice }).then(
      () => (choice === 'always' ? loadConsent(true) : undefined),
      () => setBusy(false)
    )
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-(--z-consent) flex justify-center px-6">
      <div
        aria-describedby="consent-door-reason"
        aria-labelledby="consent-door-title"
        aria-modal="false"
        className={cn(
          'pointer-events-auto w-full max-w-[30rem] overflow-hidden rounded-xl border border-(--stroke-nous) bg-(--ui-chat-bubble-background) shadow-nous transition-all duration-500 ease-out',
          entered ? 'translate-y-0 scale-100 opacity-100 blur-0' : '-translate-y-1 scale-[0.985] opacity-0 blur-[2px]'
        )}
        data-consent-door={request.key}
        data-consent-door-id={request.id}
        role="alertdialog"
      >
        {request.permission ? (
          <PermissionAskBody
            busy={busy}
            denyRef={denyRef}
            onAnswer={answer}
            permission={request.permission}
            request={request}
          />
        ) : (
          <>
            <div className="px-5 pt-5 pb-3">
              <p className="text-[0.6875rem] text-(--ui-text-tertiary)">{copy.eyebrow(request.inft)}</p>
              <h2
                className="mt-1.5 text-[length:var(--conversation-text-font-size)] font-semibold text-foreground"
                id="consent-door-title"
              >
                {copy.title(name)}
              </h2>
              {purpose ? (
                <p className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
                  {purpose}
                </p>
              ) : null}
              <p className="mt-3 text-[0.6875rem] text-(--ui-text-tertiary)">{copy.reasonLabel}</p>
              <p
                className="mt-1 text-[length:var(--conversation-text-font-size)] break-words text-foreground"
                data-consent-door-reason=""
                id="consent-door-reason"
              >
                {request.reason}
              </p>
              <p className="mt-3 text-[0.75rem] leading-4 text-muted-foreground">{copy.hint}</p>
              <p className="mt-1 text-[0.75rem] leading-4 text-(--ui-text-tertiary)">{copy.expires}</p>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-(--stroke-nous) px-5 py-3.5">
              <Button
                data-consent-door-answer="deny"
                disabled={busy}
                onClick={() => answer('deny')}
                ref={denyRef}
                variant="ghost"
              >
                {copy.deny}
              </Button>
              <Button data-consent-door-answer="once" disabled={busy} onClick={() => answer('once')} variant="outline">
                {copy.once}
              </Button>
              <Button data-consent-door-answer="always" disabled={busy} onClick={() => answer('always')}>
                {copy.always}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
