/**
 * Settings → Updates (pane id `app-atualisation`, kept): the app's own updates, for every user —
 * the version, one button per phase, the download progress, the restart onto the new version and
 * our per-release history — then the Agent section (Hermes by Nous Research), also for every user,
 * which checks and updates only on the user's click. Main owns both state machines; this pane only
 * renders them. The developer section shows only under developer policy.
 */
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Loader2 } from '@/lib/icons'
import {
  $appUpdate,
  $appUpdateLog,
  appUpdatePrimary,
  cancelAppUpdate,
  checkForAppUpdate,
  downloadAppUpdate,
  refreshAppUpdate,
  refreshAppUpdateLog,
  restartToUpdate,
  shownVersion
} from '@/store/app-update'
import {
  $desktopVersion,
  $updatePolicy,
  isCuratedPolicy,
  refreshDesktopVersion,
  refreshUpdatePolicy
} from '@/store/updates'

import { AgentRuntimeSection } from './agent-runtime-settings'
import { AgentUpdateSection } from './app-atualisation/agent-section'
import { DeveloperUpdates } from './app-atualisation/developer'
import { appUpdateButton, appUpdateHistoryRows, appUpdateLine, useAppUpdateWords } from './machine/app-update-copy'
import { useUpdatesCopy } from './machine/updates-copy'
import { SettingsContent } from './primitives'
import { SettingRow } from './setting-row'

const caption =
  'text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)'

export function AppAtualisationSettings({
  navigate,
  onClose
}: {
  navigate: (route: string) => void
  onClose: () => void
}) {
  const state = useStore($appUpdate)
  const log = useStore($appUpdateLog)
  const version = useStore($desktopVersion)
  const policy = useStore($updatePolicy)
  const [confirmWork, setConfirmWork] = useState<null | string>(null)
  const u = useUpdatesCopy()
  const words = useAppUpdateWords()

  useEffect(() => {
    void refreshAppUpdate()
    void refreshAppUpdateLog()

    if (!$desktopVersion.get()) {
      void refreshDesktopVersion()
    }

    if (!$updatePolicy.get()) {
      void refreshUpdatePolicy()
    }
  }, [])

  const primary = appUpdatePrimary(state)

  const restart = useCallback(
    async (confirmed: boolean) => {
      const result = await restartToUpdate(confirmed)
      setConfirmWork(result?.outcome === 'active-work' ? (result.detail ?? u.workRunning) : null)
    },
    [u.workRunning]
  )

  const onPrimary = useCallback(() => {
    switch (primary.action) {
      case 'check':
        return void checkForAppUpdate()

      case 'download':
        return void downloadAppUpdate()

      case 'cancel':
        return void cancelAppUpdate()

      case 'restart':
        return void restart(false)
    }
  }, [primary.action, restart])

  const current = state?.current ?? version?.appVersion

  // The bar stays full once the download is verified, so its 100 % is always seen before "Restart to update".
  const progress =
    state?.phase === 'downloading' ? (state.progress?.percent ?? 0) : state?.phase === 'downloaded' ? 100 : null

  const history = appUpdateHistoryRows(words, log)

  return (
    <SettingsContent>
      <div className="mx-auto w-full max-w-2xl pt-2" data-app-update-phase={state?.phase ?? 'idle'}>
        <SettingRow
          below={
            <>
              {progress !== null && (
                <div
                  aria-label={u.progress}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={progress}
                  className="h-1 w-full overflow-hidden rounded-full bg-(--ui-stroke-tertiary)"
                  role="progressbar"
                >
                  <div className="h-full bg-(--ui-text-primary) transition-[width]" style={{ width: `${progress}%` }} />
                </div>
              )}
              {confirmWork && (
                <div className="flex flex-wrap items-center gap-3" role="alertdialog">
                  <p className={caption}>{u.restartAnyway(confirmWork)}</p>
                  <Button onClick={() => void restart(true)} size="sm" variant="default">
                    {u.restartNow}
                  </Button>
                  <Button onClick={() => setConfirmWork(null)} size="sm" variant="ghost">
                    {u.notNow}
                  </Button>
                </div>
              )}
            </>
          }
          control={
            <div className="flex flex-wrap items-center gap-3">
              {state?.releaseUrl && (state.phase === 'available' || state.phase === 'downloaded') && (
                <Button
                  onClick={() => void window.hermesDesktop?.openExternal(state.releaseUrl ?? '')}
                  size="sm"
                  variant="ghost"
                >
                  {u.whatsNew}
                </Button>
              )}
              <Button
                data-app-update-action={primary.action ?? 'none'}
                disabled={!primary.action}
                onClick={onPrimary}
                size="sm"
                variant={primary.action === 'cancel' ? 'outline' : 'default'}
              >
                {primary.busy && primary.action !== 'cancel' && <Loader2 className="size-3.5 animate-spin" />}
                {appUpdateButton(words, state)}
              </Button>
            </div>
          }
          hint={
            <>
              <span className="font-mono">{current ? `iclone os ${shownVersion(current)}` : 'iclone os'}</span>
              {' · '}
              <span data-app-update-status role="status">
                {appUpdateLine(words, state)}
              </span>
            </>
          }
          title={u.appTitle}
          wide
        />

        <SettingRow
          below={
            history.length > 0 && (
              <ul className="space-y-1">
                {history.map(row => (
                  <li className={`font-mono ${caption}`} key={row}>
                    {row}
                  </li>
                ))}
              </ul>
            )
          }
          hint={history.length === 0 ? u.historyEmpty : undefined}
          title={u.historyTitle}
        />

        {/* RTB-6/7: the install status of the agent runtime, its packages and Install again. */}
        <AgentRuntimeSection />
        <AgentUpdateSection />

        {!isCuratedPolicy(policy) && <DeveloperUpdates navigate={navigate} onClose={onClose} />}
      </div>
    </SettingsContent>
  )
}
