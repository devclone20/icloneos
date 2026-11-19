'use client'

import { useStore } from '@nanostores/react'
import { type ComponentProps, type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'

import { PendingApprovalFallback } from '@/components/assistant-ui/tool/approval'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { f4bPrompts } from '@/i18n/en/v009-f4b'
import { isMissingPendingPromptRequest } from '@/lib/gateway-rpc'
import { triggerHaptic } from '@/lib/haptics'
import { KeyRound, Loader2, Lock } from '@/lib/icons'
import { answerServerRequest } from '@/lib/server-requests'
import { notifyError } from '@/store/notifications'
import {
  clearSecretRequest,
  clearSudoRequest,
  sessionSecretRequest,
  sessionSudoRequest,
  type ValueResult
} from '@/store/prompts'

// Renders the modal mid-turn prompts the gateway raises and waits on: sudo
// password and skill secret capture. Dangerous-command / execute_code approval
// prefers the pending tool row, but also has a chat-level fallback when no row
// is mounted (remote gateway sessions can raise the request before the matching
// tool call is visible). Each Python-side caller blocks the agent thread until
// the server request is answered; without a renderer the agent stalls until
// its timeout and the tool is BLOCKED.
//
// v0.0.9 F4 (X7): an answer is only ever an explicit act. Esc is the keyboard
// form of the "Not now" button: it sends the same refusal through the same
// `onCancel` path (never the typed value), and only once. A click or focus move
// outside the dialog is NOT an answer — the blocking prompt stays up. Radix's
// `onOpenChange(false)` therefore never answers; both close paths are
// intercepted (preventDefault) so there is exactly one send per request.

function SudoDialog({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n()
  const copy = t.prompts
  const $request = useMemo(() => sessionSudoRequest(sessionId), [sessionId])
  const request = useStore($request)
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setPassword('')
    setSubmitting(false)
  }, [request?.requestId])

  const send = useCallback(
    async (value: string) => {
      if (!request) {
        return
      }

      setSubmitting(true)

      try {
        // The password goes only into the response frame (never a store, log
        // or notification); '' refuses.
        await answerServerRequest(request.requestId, { value } satisfies ValueResult)
        triggerHaptic('submit')
        clearSudoRequest(request.sessionId, request.requestId)
      } catch (error) {
        if (isMissingPendingPromptRequest(error, 'password')) {
          clearSudoRequest(request.sessionId, request.requestId)

          return
        }

        notifyError(error, copy.sudoSendFailed)
        setSubmitting(false)
      }
    },
    [copy.sudoSendFailed, request]
  )

  // "Not now" / Esc → empty password. The backend treats an empty sudo response
  // as a failed sudo (no command runs), so the explicit refusal is safe.
  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      void send(password)
    },
    [password, send]
  )

  if (!request) {
    return null
  }

  return (
    <MaskedPromptDialog
      canSubmit
      description={copy.sudoDesc}
      icon={Lock}
      onCancel={() => void send('')}
      onSubmit={onSubmit}
      onValueChange={setPassword}
      placeholder={copy.sudoPlaceholder}
      submitting={submitting}
      title={copy.sudoTitle}
      value={password}
    />
  )
}

function SecretDialog({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n()
  const copy = t.prompts
  const $request = useMemo(() => sessionSecretRequest(sessionId), [sessionId])
  const request = useStore($request)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setValue('')
    setSubmitting(false)
  }, [request?.requestId])

  const send = useCallback(
    async (secret: string) => {
      if (!request) {
        return
      }

      setSubmitting(true)

      try {
        // The value goes only into the response frame (never a store, log or
        // notification); '' skips.
        await answerServerRequest(request.requestId, { value: secret } satisfies ValueResult)
        triggerHaptic('submit')
        clearSecretRequest(request.sessionId, request.requestId)
      } catch (error) {
        if (isMissingPendingPromptRequest(error, 'value')) {
          clearSecretRequest(request.sessionId, request.requestId)

          return
        }

        notifyError(error, copy.secretSendFailed)
        setSubmitting(false)
      }
    },
    [copy.secretSendFailed, request]
  )

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      void send(value)
    },
    [send, value]
  )

  if (!request) {
    return null
  }

  return (
    <MaskedPromptDialog
      canSubmit={Boolean(value)}
      description={request.prompt || copy.secretDesc}
      icon={KeyRound}
      onCancel={() => void send('')}
      onSubmit={onSubmit}
      onValueChange={setValue}
      placeholder={request.envVar || copy.secretPlaceholder}
      submitting={submitting}
      title={request.envVar || copy.secretTitle}
      value={value}
    />
  )
}

interface MaskedPromptDialogProps {
  canSubmit: boolean
  description: string
  icon: ComponentProps<typeof DialogTitle>['icon']
  onCancel: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onValueChange: (value: string) => void
  placeholder: string
  submitting: boolean
  title: string
  value: string
}

/** The single masked field both credential prompts (sudo password, secret) render. */
function MaskedPromptDialog({
  canSubmit,
  description,
  icon,
  onCancel,
  onSubmit,
  onValueChange,
  placeholder,
  submitting,
  title,
  value
}: MaskedPromptDialogProps) {
  const { t } = useI18n()

  // Esc = the "Not now" button (explicit refusal, one send). Ignored while a
  // send is in flight and while an IME composition owns the key.
  const onEscapeKeyDown = useCallback(
    (event: KeyboardEvent) => {
      event.preventDefault()

      if (submitting || event.isComposing) {
        return
      }

      onCancel()
    },
    [onCancel, submitting]
  )

  // A click or focus move outside is never an answer to a blocking prompt.
  const keepOpen = useCallback((event: Event) => event.preventDefault(), [])

  return (
    <Dialog open>
      <DialogContent
        onEscapeKeyDown={onEscapeKeyDown}
        onInteractOutside={keepOpen}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle icon={icon}>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form className="grid gap-3" onSubmit={onSubmit}>
          <Input
            autoFocus
            disabled={submitting}
            onChange={event => onValueChange(event.target.value)}
            placeholder={placeholder}
            type="password"
            value={value}
          />
          <DialogFooter>
            <Button disabled={submitting} onClick={onCancel} type="button" variant="ghost">
              {f4bPrompts.notNow}
            </Button>
            <Button disabled={submitting || !canSubmit} type="submit">
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : t.common.send}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Mid-turn prompt surfaces for ONE session. Mounted by both the primary chat
 *  and each tile with its own session id, so a background/tiled session's
 *  blocking prompt renders instead of silently stalling. */
export function PromptOverlays({ sessionId }: { sessionId: string | null }) {
  return (
    <>
      <PendingApprovalFallback />
      <SudoDialog sessionId={sessionId} />
      <SecretDialog sessionId={sessionId} />
    </>
  )
}
