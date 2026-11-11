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
 * window.
 *
 * `chosen` is the owner's stored choice and `inForce` what main enforces; they differ when an unsealed launch clamps
 * every mode to Manual. The in-force row keeps its Use control then: Use is the only way to change the stored choice,
 * which would otherwise come back on the next sealed launch.
 */
export function ModePicker({
  chosen,
  inForce,
  target
}: {
  chosen: PermissionMode
  inForce: PermissionMode
  target: Target
}) {
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
          // L5-13: the same words the Message bar shows for the same refusal.
          setError(outcome.error === 'gesture' ? copy.refused.gesture : outcome.message || copy.refused.invalid)
        }
      },
      () => setError(copy.refused.unavailable)
    )

  return (
    <div data-permission-mode-picker={target.scope}>
      {PERMISSION_MODES.map(mode => {
        const pill =
          mode === inForce ? (
            <Pill tone="primary">{copy.current}</Pill>
          ) : mode === chosen ? (
            <Pill tone="warn">{copy.chosenNotInForce}</Pill>
          ) : null

        const use =
          mode === chosen ? null : (
            <Button
              data-perm-mode={mode}
              data-perm-mode-confirm=""
              onClick={() => settle(requestPermissionMode({ mode, scope: target.scope, key: target.key }))}
              size="sm"
              variant="outline"
            >
              {copy.choose}
            </Button>
          )

        return (
          <SettingRow
            control={
              pill && use ? (
                <div className="flex items-center gap-2">
                  {pill}
                  {use}
                </div>
              ) : (
                (pill ?? use)
              )
            }
            hint={copy.modes[mode].summary}
            key={mode}
            title={copy.modes[mode].name}
          />
        )
      })}
      {error ? (
        <p className="pt-2 text-xs leading-4 text-(--ic-danger)" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
