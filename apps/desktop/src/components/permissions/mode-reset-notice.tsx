import { useStore } from '@nanostores/react'

import { useI18n } from '@/i18n'
import type { PermissionModeResetView } from '@/iclone-shared/permissions'
import { cn } from '@/lib/utils'
import { $shownModeResets, dismissModeResets } from '@/store/mode-reset'

/**
 * CF4 (B2-m1): main put a mode back at launch because the audit had no record of choosing it (fail closed). The owner
 * is told once, in one calm line per layer, until he dismisses it here or in the other surface, or chooses again.
 * CF5 (B3-n1): the same notice also stands above the main window's chat (`ModeResetBanner`), and outlives the launch
 * that made it (src/store/mode-reset.ts) until dismissed.
 */
export function ModeResetLines({ resets }: { resets: readonly PermissionModeResetView[] }) {
  const copy = useI18n().t.settings.permissions
  const name = (mode: PermissionModeResetView['now']) => (mode === null ? null : copy.modes[mode].name)

  const line = (reset: PermissionModeResetView) =>
    reset.scope === 'standing'
      ? copy.modeReset.standing(name(reset.now) ?? copy.modes.manual.name)
      : copy.modeReset[reset.scope](name(reset.now))

  return (
    <div className="min-w-0 flex-1">
      {resets.map(reset => (
        <p data-mode-reset-line={reset.scope} key={reset.id}>
          {line(reset)}
        </p>
      ))}
    </div>
  )
}

export function ModeResetNotice({ className }: { className?: string }) {
  const shown = useStore($shownModeResets)
  const copy = useI18n().t.settings.permissions

  if (shown.length === 0) {
    return null
  }

  return (
    <div
      className={cn('flex items-start gap-2 text-[0.75rem] leading-4 text-(--ic-text-2)', className)}
      data-mode-reset=""
      role="status"
    >
      <ModeResetLines resets={shown} />
      <button
        className="shrink-0 underline-offset-2 hover:underline"
        data-mode-reset-dismiss=""
        onClick={event => {
          event.stopPropagation()
          dismissModeResets(shown.map(reset => reset.id))
        }}
        onKeyDown={event => event.stopPropagation()}
        type="button"
      >
        {copy.modeReset.dismiss}
      </button>
    </div>
  )
}
