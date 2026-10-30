/**
 * The iNFT island — the right-edge pull tab of `CollectionsPanel` (collections.tsx),
 * always mounted by home-view.tsx. While a window is expanded it tucks behind the
 * edge like the Dock and comes back when the pointer searches that edge or on
 * keyboard focus (the shared edge-autohide hook, right edge). Opening the panel
 * is the caller's job; this module only owns the pill and its focus hand-back.
 */
import './collections.css'

import { useStore } from '@nanostores/react'
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'

import { useI18n } from '@/i18n'

import { OwnershipDialogHost } from './ownership-dialog'
import { useEdgeAutoHide } from './window/edge-autohide'
import { $expandedWindows } from './window/expanded'

/** The panel's DOM id — `aria-controls` on the pill, `id` on the panel (collections.tsx). */
export const PANEL_ID = 'collections-panel'

interface CollectionsTabProps {
  onToggle: () => void
  open: boolean
}

/** The iNFT island — a clean pill on the right edge, nothing but the word (owner rule). While a window is
 *  expanded it tucks behind that edge like the Dock, back at the edge level with it or on keyboard focus. */
export function CollectionsTab({ onToggle, open }: CollectionsTabProps): JSX.Element {
  const { t } = useI18n()
  const tabRef = useRef<HTMLButtonElement>(null)
  const autoHide = useStore($expandedWindows).length > 0
  const revealed = useEdgeAutoHide({ active: autoHide && !open, band: true, edge: 'right', targetRef: tabRef })

  // The panel takes focus while open. Closed with focus left on <body>, focus comes back here (dialog
  // pattern); otherwise the next Tab lands in whatever comes first, and a maximised terminal keeps it.
  useEffect(() => {
    const tab = tabRef.current

    if (!open || !tab) {
      return
    }

    return () => {
      if (!document.activeElement || document.activeElement === document.body) {
        tab.focus({ preventScroll: true })
      }
    }
  }, [open])

  return (
    <>
      <button
        aria-controls={PANEL_ID}
        aria-expanded={open}
        aria-label={t.desktop.home.inftCollection}
        className="inft-tab"
        data-autohide={autoHide || undefined}
        data-open={open}
        data-revealed={revealed || undefined}
        onClick={onToggle}
        ref={tabRef}
        type="button"
      >
        <span className="inft-tab__label">iNFT</span>
      </button>
      {/* A sibling, never a child: portal events bubble through React parents. */}
      <OwnershipDialogHost />
    </>
  )
}
