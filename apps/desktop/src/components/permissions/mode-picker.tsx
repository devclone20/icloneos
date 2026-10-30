import { useState } from 'react'

import { Pill } from '@/app/settings/primitives'
import { SettingRow } from '@/app/settings/setting-row'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import {
  type ModeScope,
  PERMISSION_MODES,
  type PermissionMode,
  type SetModeResultView
} from '@/iclone-shared/permissions'
import { triggerHaptic } from '@/lib/haptics'
import { requestPermissionMode } from '@/store/permissions'

interface Target {
  scope: Extract<ModeScope, 'project' | 'standing'>
  key: string | null
}

/**
 * The five modes for one scope (everywhere, or the open project). Every control that changes the mode carries
 * `data-perm-mode-confirm` and calls main synchronously in its own click handler: main refuses without that click.
 * Ignore permissions takes a second confirm listing what it lifts — a system dialog main shows, never a sheet in this
 * window — and is never offered for everywhere.
 */
export function ModePicker({ current, target }: { current: PermissionMode; target: Target }) {
  const copy = useI18n().t.settings.permissions
  const [error, setError] = useState<string | null>(null)

  const settle = (result: Promise<SetModeResultView>) =>
    void result.then(
      outcome => {
        if (outcome.ok) {
          setError(null)
          triggerHaptic('success')
        } else if (outcome.error === 'confirm') {
          // The owner chose "Keep the current mode" on the system dialog: nothing changed, nothing to explain.
          setError(null)
        } else {
          setError(outcome.error === 'gesture' ? copy.refused.gesture : copy.refused.invalid)
        }
      },
      () => setError(copy.refused.unavailable)
    )

  return (
    <div data-permission-mode-picker={target.scope}>
      {PERMISSION_MODES.map(mode => {
        const blocked = mode === 'ignore' && target.scope === 'standing'

        return (
          <SettingRow
            control={
              mode === current ? (
                <Pill tone="primary">{copy.current}</Pill>
              ) : (
                <Button
                  data-perm-mode={mode}
                  data-perm-mode-confirm=""
                  disabled={blocked}
                  onClick={() => settle(requestPermissionMode({ mode, scope: target.scope, key: target.key }))}
                  size="sm"
                  variant="outline"
                >
                  {copy.choose}
                </Button>
              )
            }
            disabled={blocked}
            hint={blocked ? copy.ignoreConfirm.standingOnly : copy.modes[mode].summary}
            key={mode}
            title={copy.modes[mode].name}
          />
        )
      })}
      {error ? (
        <p className="pt-2 text-[0.75rem] leading-4 text-(--ic-danger)" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
