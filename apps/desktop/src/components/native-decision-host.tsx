import { useCallback, useEffect, useState } from 'react'

import { IcDialog, IcPageButton } from '@/components/ic/ic-page'
import {
  type NativeDecisionAsk,
  type NativeNotice,
  parseNativeDecisionAsk,
  parseNativeNotices
} from '@/iclone-shared/native-decision'
import { notify, recordNotification } from '@/store/notifications'

/**
 * v0.0.9 F4b — type 4 for the main process. Main used to ask some decisions with a native message box (quit with work
 * running, restart for Screen recording) and to report a failed detached update with `showErrorBox`; while this window
 * can answer, it asks here instead (electron/main/renderer-dialogs.ts holds the protocol and the native fallback).
 *
 *  - A decision is painted only after main confirms `shown` (a late window never shows a settled decision).
 *  - The safe button (`cancelId`) takes focus and answers Esc; Enter/Space answer only the focused button (IcDialog).
 *  - The words are the detail: wrapped and scrolled, never cut.
 *  - Every non-cancel button sits inside `data-native-decision-confirm`: main accepts its answer only with a trusted
 *    click on it (the preload's single-use confirm + the gesture rule), never from activation alone.
 *  - An answer main refuses (no real click behind it) leaves the dialog up.
 *  - Notices main could not show land in the notification centre: whole message, copyable detail, next step; they
 *    survive the reconnect clear and stay until closed.
 *
 * Mounted once, app-wide, by NotificationStack.
 */
export function NativeDecisionHost() {
  const bridge = typeof window === 'undefined' ? undefined : window.hermesDesktop?.nativeDecisions
  const [queue, setQueue] = useState<NativeDecisionAsk[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!bridge) {
      return
    }

    let live = true

    const offAsk = bridge.onAsk(raw => {
      const ask = parseNativeDecisionAsk(raw)

      if (!ask) {
        return
      }

      bridge.shown(ask.id).then(
        ok => {
          if (ok && live) {
            setQueue(list => (list.some(entry => entry.id === ask.id) ? list : [...list, ask]))
          }
        },
        () => {}
      )
    })

    const drain = () => {
      bridge.drainNotices().then(
        raw => {
          if (live) {
            parseNativeNotices(raw).forEach(deliverNativeNotice)
          }
        },
        () => {}
      )
    }

    const offReady = bridge.onNoticesReady(drain)

    // Anything main queued before this window mounted (the boot's update result).
    drain()

    return () => {
      live = false
      offAsk()
      offReady()
    }
  }, [bridge])

  const current = queue[0]

  const answer = useCallback(
    async (response: number) => {
      if (!bridge || !current || busy) {
        return
      }

      setBusy(true)

      let accepted = false

      try {
        accepted = await bridge.answer(current.id, response)
      } catch {
        accepted = false
      }

      setBusy(false)

      if (accepted) {
        setQueue(list => list.filter(entry => entry.id !== current.id))
      }
    },
    [bridge, busy, current]
  )

  if (!current) {
    return null
  }

  return (
    <IcDialog
      busy={busy}
      footer={
        <div className="icdlg__foot" data-testid="native-decision-buttons">
          {current.buttons.map((label, index) => {
            const button = (
              <IcPageButton
                disabled={busy}
                firstFocus={index === current.cancelId}
                key={`${current.id}-${index}`}
                onClick={() => void answer(index)}
                tone={buttonTone(current, index)}
              >
                {label}
              </IcPageButton>
            )

            // The owner-click marker (lead decision 2): main accepts a non-cancel answer only with the preload's
            // trusted click on a control inside this marker. The safe button never needs it. `contents` keeps the
            // footer's own layout (the wrapper draws no box).
            return index === current.cancelId ? (
              button
            ) : (
              <span className="contents" data-native-decision-confirm="" key={`${current.id}-${index}`}>
                {button}
              </span>
            )
          })}
        </div>
      }
      onClose={() => void answer(current.cancelId)}
      open
      title={current.title}
    >
      <p className="icn-decision__detail" data-testid="native-decision-detail">
        {current.detail}
      </p>
    </IcDialog>
  )
}

function buttonTone(ask: NativeDecisionAsk, index: number): 'accent' | 'danger' | 'quiet' {
  if (index === ask.cancelId) {
    return 'quiet'
  }

  return ask.tone === 'danger' ? 'danger' : 'accent'
}

/** A notice main could not show itself, into the one notification system (exported for the host's tests). */
export function deliverNativeNotice(notice: NativeNotice) {
  if (notice.historyOnly) {
    recordNotification({
      createdAt: notice.at,
      detail: notice.detail,
      kind: notice.kind,
      message: notice.message,
      nextStep: notice.nextStep,
      source: 'native',
      title: notice.title
    })

    return
  }

  notify({
    detail: notice.detail,
    // A warning from main asks for a step: it stays until closed, like an error (errors are sticky in the store).
    durationMs: notice.kind === 'warning' || notice.kind === 'error' ? 0 : undefined,
    id: `native-${notice.id}`,
    kind: notice.kind,
    message: notice.message,
    nextStep: notice.nextStep,
    survivesClear: true,
    title: notice.title
  })
}
