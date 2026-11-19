import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { IcStatusBanner } from '@/components/status-banner'
import { translateNow } from '@/i18n'

/** v0.0.9 F4b: a fact about this run's rendering — the lowest of the status banners. */
export const REMOTE_DISPLAY_PRIORITY = 10

/**
 * GPU acceleration is disabled under remote display (RDP/VNC/etc) to avoid flicker. It is a STATE of this run, so
 * since v0.0.9 F4b it is a status banner (type 2, one band under the titlebar, by priority), not a sticky toast that
 * filled a slot of the toast stack for the whole run. The owner may put it away (✕) for this run.
 */
export function RemoteDisplayBanner() {
  const [reason, setReason] = useState<null | string>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let alive = true

    void window.hermesDesktop?.getRemoteDisplayReason?.().then(found => {
      if (alive && found) {
        setReason(found)
      }
    })

    return () => {
      alive = false
    }
  }, [])

  if (!reason || dismissed || typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <IcStatusBanner
      data={{ 'data-remote-display': '' }}
      onDismiss={() => setDismissed(true)}
      priority={REMOTE_DISPLAY_PRIORITY}
      title={translateNow('remoteDisplayBanner.message', reason)}
      tone="info"
    />,
    document.body
  )
}
