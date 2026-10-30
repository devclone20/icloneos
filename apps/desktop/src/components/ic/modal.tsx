import './ic-ui.css'

import { type ReactNode, useEffect, useState } from 'react'

import { useOverlaySurface } from '@/app/overlays/use-overlay-surface'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'

import { IcAction } from './controls'
import { IcNote } from './feedback'

/**
 * OUR dialog — the one modal shape our pages use, on the page frame's own
 * material. It reuses the overlay FOCUS contract (focus in, Tab trapped, focus
 * returned) and nothing visual.
 *
 * Esc: `useOverlaySurface` registers the page's own rung, so a dialog opened
 * over a page must outrank it or one Esc would close both. It sits between
 * `overlay` and `drag` — a drag in flight still owns Esc.
 */
const DIALOG_ESCAPE_PRIORITY = ESCAPE_PRIORITY.overlay + 5

function useDialogEscape(onEscape: () => void): void {
  useEffect(() => {
    const release = pushEscapeLayer(DIALOG_ESCAPE_PRIORITY)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isTopEscapeLayer(DIALOG_ESCAPE_PRIORITY)) {
        return
      }

      event.preventDefault()
      onEscape()
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      release()
    }
  }, [onEscape])
}

export function IcModal({
  children,
  description,
  footer,
  onClose,
  title
}: {
  children: ReactNode
  description?: string
  footer?: ReactNode
  onClose: () => void
  title: string
}) {
  const plateRef = useOverlaySurface<HTMLDivElement>(onClose)

  useDialogEscape(onClose)

  return (
    <div className="icmodal" role="presentation">
      <div aria-label={title} aria-modal="true" className="icmodal__plate" ref={plateRef} role="dialog" tabIndex={-1}>
        <header className="icmodal__head">
          <h3 className="icmodal__title">{title}</h3>
          {description ? <p className="icmodal__desc">{description}</p> : null}
        </header>

        <div className="icmodal__body">{children}</div>

        {footer ? <div className="icmodal__foot">{footer}</div> : null}
      </div>
    </div>
  )
}

/**
 * Destructive confirmation. `onConfirm` may reject: the dialog stays open and
 * shows the failure inline, because a delete that silently failed is worse than
 * one the user has to retry.
 */
export function IcConfirm({
  busyLabel,
  cancelLabel,
  confirmLabel,
  description,
  onClose,
  onConfirm,
  title
}: {
  busyLabel: string
  cancelLabel: string
  confirmLabel: string
  description: ReactNode
  onClose: () => void
  onConfirm: () => Promise<void>
  title: string
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  async function run() {
    setBusy(true)
    setError(null)

    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <IcModal
      footer={
        <>
          <IcAction disabled={busy} onClick={onClose}>
            {cancelLabel}
          </IcAction>
          <IcAction disabled={busy} onClick={() => void run()} tone="danger">
            {busy ? busyLabel : confirmLabel}
          </IcAction>
        </>
      }
      onClose={busy ? () => {} : onClose}
      title={title}
    >
      <div className="icui-meta">{description}</div>
      {error ? <IcNote tone="danger">{error}</IcNote> : null}
    </IcModal>
  )
}

/** The dialog's action row, for a form that must own its own submit button. */
export function IcModalFoot({ children }: { children: ReactNode }) {
  return <div className="icmodal__foot">{children}</div>
}
