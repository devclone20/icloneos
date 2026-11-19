import { useStore } from '@nanostores/react'
import { createPortal } from 'react-dom'

import { ModeResetLines } from '@/components/permissions/mode-reset-notice'
import { IcStatusBanner } from '@/components/status-banner'
import { useI18n } from '@/i18n'
import { $shownModeResets, dismissModeResets } from '@/store/mode-reset'

/** v0.0.9 F4b: a told-once fact, below the states that stop work (agent, billing, provider). */
export const MODE_RESET_PRIORITY = 20

/**
 * CF5 (B3-n1): a mode the sealed launch put back is told where the owner looks on launch, above the main window's
 * chat, not only inside the mode menu and Settings. The same notice (one line per layer, one Dismiss for all of
 * them); it stays, across launches, until he dismisses it here or in either other surface, or chooses that mode again.
 *
 * v0.0.9 F4b — type 2 (IcStatusBanner): one band under the titlebar, by priority, portalled to the body. Its one
 * action is the existing Dismiss (the same `data-mode-reset-dismiss` hook).
 */
export function ModeResetBanner() {
  const shown = useStore($shownModeResets)
  const dismiss = useI18n().t.settings.permissions.modeReset.dismiss

  if (shown.length === 0 || typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <IcStatusBanner
      actions={
        <button
          className="icpg__btn icpg__btn--quiet"
          data-mode-reset-dismiss=""
          onClick={() => dismissModeResets(shown.map(reset => reset.id))}
          type="button"
        >
          {dismiss}
        </button>
      }
      data={{ 'data-mode-reset-banner': '' }}
      priority={MODE_RESET_PRIORITY}
      title={<ModeResetLines resets={shown} />}
      tone="info"
    />,
    document.body
  )
}
