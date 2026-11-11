import { useStore } from '@nanostores/react'

import { ModeResetLines } from '@/components/permissions/mode-reset-notice'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $shownModeResets, dismissModeResets } from '@/store/mode-reset'

const BAR = cn(
  'pointer-events-auto mx-auto mb-1 flex w-full max-w-(--composer-max-width,48rem) items-start gap-2 rounded-md px-3 py-1.5',
  'border border-(--ic-border-subtle) bg-(--ic-surface-raised) text-xs leading-4 text-(--ic-text-ramp-80)'
)

/**
 * CF5 (B3-n1): a mode the sealed launch put back is told where the owner looks on launch, above the main window's
 * chat, not only inside the mode menu and Settings. The same notice (one line per layer, one Dismiss for all of
 * them); it stays, across launches, until he dismisses it here or in either other surface, or chooses that mode again.
 */
export function ModeResetBanner() {
  const shown = useStore($shownModeResets)
  const dismiss = useI18n().t.settings.permissions.modeReset.dismiss

  if (shown.length === 0) {
    return null
  }

  return (
    <div className={BAR} data-mode-reset-banner="" role="status">
      <ModeResetLines resets={shown} />
      <button
        className="shrink-0 rounded px-1.5 font-medium text-(--ic-text-1) underline-offset-2 hover:underline"
        data-mode-reset-dismiss=""
        onClick={() => dismissModeResets(shown.map(reset => reset.id))}
        type="button"
      >
        {dismiss}
      </button>
    </div>
  )
}
