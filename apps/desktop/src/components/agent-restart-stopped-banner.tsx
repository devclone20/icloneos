import { useStore } from '@nanostores/react'

import { $backendRestart, backendRestartLabel, isRestartStopped } from '@/store/backend-restart'
import { $desktopBoot } from '@/store/boot'
import { notify, openNotificationCentre } from '@/store/notifications'
import { $gatewayState } from '@/store/session'

import { AgentStoppedBanner } from './agent-stopped-banner'

/** Said when the manual restart itself was refused or failed (the banner stays: the agent is still not running). */
export const RESTART_FAILED_TITLE = 'The agent did not start'

/**
 * v0.0.9 Q (proofs F2-b, P0_NOTIFICATIONS type 2): main's automatic restart stopped after its attempts (or on a cause a
 * restart cannot cure) while the app was running — no boot failure, so the boot card never shows. One status banner
 * says so with the cause and a Retry that runs the existing manual restart (`hermes:backend:restart`: clears the
 * latched failure, resets the restart budget, starts the agent and tells this window to dial again). It leaves when
 * the gateway is open again. A boot failure keeps its own card and banner (BootFailureOverlay).
 */
export function AgentRestartStoppedBanner() {
  const restart = useStore($backendRestart)
  const gatewayState = useStore($gatewayState)
  const boot = useStore($desktopBoot)
  const bootCardOwnsIt = Boolean(boot.error) && !boot.running

  if (!isRestartStopped(restart, gatewayState) || bootCardOwnsIt) {
    return null
  }

  return (
    <AgentStoppedBanner
      cause={backendRestartLabel(restart)}
      onRetry={async () => {
        const result = await window.hermesDesktop?.restartBackend?.().catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        }))

        if (!result?.ok) {
          notify({ kind: 'error', title: RESTART_FAILED_TITLE, message: result?.error || backendRestartLabel(restart) || '' })
        }
      }}
      onShowDetails={() => openNotificationCentre()}
    />
  )
}
