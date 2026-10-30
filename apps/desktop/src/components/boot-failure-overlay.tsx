import { useStore } from '@nanostores/react'
import { type ComponentProps, lazy, type ReactNode, Suspense, useEffect, useState } from 'react'

import { IcButton, IcErrorGlyph, IcLog, IcSpinner } from '@/components/onboarding/ic-system'
import type { DesktopConnectionConfig } from '@/global'
import { useI18n } from '@/i18n'
import { isIcloneGateFailure, isIcloneGateUnmanaged } from '@/iclone-shared/iclone-gate'
import { diagnoseInstallFailure } from '@/iclone-shared/install-diagnosis'
import { openExternalLink } from '@/lib/external-link'
import { ChevronLeft, ExternalLink, FileText, Loader2, LogIn, RefreshCw, SlidersHorizontal, Wrench } from '@/lib/icons'
import { $installOverlayOwnsFailure } from '@/store/agent-runtime'
import { $desktopBoot } from '@/store/boot'
import { notify, notifyError } from '@/store/notifications'
import { $desktopOnboarding } from '@/store/onboarding'

import type { RemoteReauth } from './boot-failure-reauth'
import {
  deriveProviderShape,
  isRemoteConfig,
  isRemoteReauthFailure,
  signInLabel,
  sshFailureMessage
} from './boot-failure-reauth'

// The recovery "Gateway settings" view embeds the real Settings → Gateway panel
// (identical URL/auth/test/save controls — no parallel form to drift). Lazy so
// it stays out of the always-mounted overlay's bundle until opened.
const GatewaySettings = lazy(() =>
  import('@/app/settings/gateway-settings').then(module => ({ default: module.GatewaySettings }))
)

type BusyAction = 'local' | 'repair' | 'retry' | 'signin' | null
type RecoveryView = 'connect' | 'recovery'

// A remote gateway whose access cookie has lapsed (e.g. the dashboard
// restarted on the remote box) boots into this overlay with a reauth-shaped
// error. The local-recovery buttons (Retry resets the local bootstrap latch;
// Repair re-runs the installer) are no-ops for that case — the only fix is to
// re-establish the remote session. The detection + copy helpers live in
// ./boot-failure-reauth so they're unit-testable without a React render.

// Recovery surface for a hard boot failure (gateway never came up, backend
// exited during startup, bootstrap latched, …). Without this the app shell
// renders dead — "gateway offline", no composer, only a toast — with no way
// to retry, repair the install, switch the gateway, or find the logs.
export function BootFailureOverlay() {
  const boot = useStore($desktopBoot)
  const onboarding = useStore($desktopOnboarding)
  const { t } = useI18n()
  const [busy, setBusy] = useState<BusyAction>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const [remoteReauth, setRemoteReauth] = useState<RemoteReauth | null>(null)
  const [connectionConfig, setConnectionConfig] = useState<DesktopConnectionConfig | null>(null)
  // A remote/cloud backend that failed to boot is fixable from gateway settings,
  // so the escape hatch earns emphasis (local failures keep it as a quiet ghost).
  const [remoteFailure, setRemoteFailure] = useState(false)
  // Swap the card body to the embedded Gateway settings panel in place of routing
  // to the full Settings page (keeps the user on the recovery surface, no z-index
  // juggling, no second connection form to maintain).
  const [view, setView] = useState<RecoveryView>('recovery')

  const installOwnsFailure = useStore($installOverlayOwnsFailure)
  // From the error alone: the recent desktop log carries unrelated lines that would misclassify it.
  const diagnosis = diagnoseInstallFailure({ error: boot.error })
  // RTB-6: a failed INSTALL is shown by the install overlay with its diagnosis, one fix and "Skip for now"; this card
  // is for a backend that really died after the install.
  const visible = Boolean(boot.error) && !boot.running && !installOwnsFailure
  // While first-run onboarding owns the picker/flow we let it surface its own
  // progress; the recovery overlay is for hard failures, which it covers via a
  // higher z-index regardless of onboarding state.
  const suppressed = onboarding.flow.status !== 'idle' && onboarding.flow.status !== 'error'

  useEffect(() => {
    if (!visible) {
      return
    }

    void window.hermesDesktop
      ?.getRecentLogs()
      .then(res => setLogs(res.lines ?? []))
      .catch(() => undefined)
  }, [boot.error, visible])

  // Resolve whether this boot failure is a remote-gateway reauth so we can
  // offer the actionable "Sign in" path instead of the local-only recovery
  // buttons. Runs whenever the overlay becomes visible.
  useEffect(() => {
    if (!visible) {
      setRemoteReauth(null)
      setConnectionConfig(null)
      setRemoteFailure(false)
      setView('recovery')

      return
    }

    let cancelled = false

    void (async () => {
      const desktop = window.hermesDesktop

      if (!desktop?.getConnectionConfig) {
        return
      }

      let config: DesktopConnectionConfig

      try {
        config = await desktop.getConnectionConfig()
      } catch {
        return
      }

      if (cancelled) {
        return
      }

      setConnectionConfig(config)
      setRemoteFailure(isRemoteConfig(config))

      if (!isRemoteReauthFailure(config, boot.error)) {
        return
      }

      // Best-effort probe for the provider shape so the button copy matches
      // what the user will see in the login window (password form vs OAuth
      // redirect). Probe failure just keeps the generic copy.
      let shape = deriveProviderShape(null)

      try {
        const probe = await desktop.probeConnectionConfig(config.remoteUrl)
        shape = deriveProviderShape(probe?.providers)
      } catch {
        // Generic copy is fine.
      }

      if (!cancelled) {
        setRemoteReauth({ url: config.remoteUrl, ...shape })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [boot.error, visible])

  if (!visible || suppressed) {
    return null
  }

  const retry = async () => {
    setBusy('retry')
    await window.hermesDesktop?.resetBootstrap().catch(() => undefined)
    window.location.reload()
  }

  const repair = async () => {
    setBusy('repair')
    await window.hermesDesktop?.repairBootstrap().catch(() => undefined)
    window.location.reload()
  }

  const switchToLocalGateway = async () => {
    setBusy('local')
    // Soft apply: tears down the primary and re-dials in place (shell stays).
    await window.hermesDesktop?.applyConnectionConfig({ mode: 'local' }).catch(() => undefined)
    setBusy(null)
  }

  // Clear this gateway's stale auth first, then re-establish it through the
  // connection's owning login flow. Hermes Cloud must reuse its portal session
  // and per-agent cascade; generic remote gateways use native/embedded OAuth.
  // Reload after success so boot mints a fresh ticket against the new session.
  const signInRemote = async () => {
    if (!remoteReauth) {
      return
    }

    setBusy('signin')

    try {
      const desktop = window.hermesDesktop

      await desktop?.oauthLogoutConnectionConfig?.(remoteReauth.url)

      let result: { connected?: boolean } | undefined

      if (connectionConfig?.mode === 'cloud' && desktop?.cloud) {
        const status = await desktop.cloud.status()

        if (!status.signedIn) {
          const login = await desktop.cloud.login()

          if (!login.signedIn) {
            notify({
              kind: 'warning',
              title: t.boot.failure.signInIncompleteTitle,
              message: t.boot.failure.signInIncompleteMessage
            })

            return
          }
        }

        result = await desktop.cloud.agentSignIn(remoteReauth.url)
      } else {
        result = await desktop?.oauthLoginConnectionConfig(remoteReauth.url)
      }

      if (result?.connected) {
        if (connectionConfig?.mode === 'cloud') {
          await desktop?.resetBootstrap().catch(() => undefined)
        }

        notify({ kind: 'success', title: t.boot.failure.signedInTitle, message: t.boot.failure.signedInMessage })
        window.location.reload()

        return
      }

      notify({
        kind: 'warning',
        title: t.boot.failure.signInIncompleteTitle,
        message: t.boot.failure.signInIncompleteMessage
      })
    } catch (err) {
      notifyError(err, t.boot.failure.signInFailed)
    } finally {
      setBusy(null)
    }
  }

  const openLogs = () => void window.hermesDesktop?.revealLogs().catch(() => undefined)
  const copy = t.boot.failure

  const label = signInLabel(remoteReauth, {
    identityProvider: copy.identityProvider,
    remoteGateway: copy.signInToRemoteGateway,
    withProvider: copy.signInWithProvider
  })

  // Recovery actions are shaped by the failure kind so the leading (primary)
  // button is the one that actually fixes it: Sign in for a lapsed remote
  // session, Connection settings for any other remote failure (local Retry /
  // Repair can't revive a dead remote — Repair is dropped there), Retry for a
  // local backend. Open logs is always appended.
  type RecoveryVariant = ComponentProps<typeof IcButton>['variant']
  interface RecoveryAction {
    key: string
    label: string
    onClick: () => void
    icon?: ReactNode
    variant?: RecoveryVariant
    busy?: Exclude<BusyAction, null>
  }

  const settingsAction: RecoveryAction = {
    key: 'settings',
    label: copy.gatewaySettings,
    onClick: () => setView('connect'),
    icon: <SlidersHorizontal />
  }

  const retryAction: RecoveryAction = {
    key: 'retry',
    label: copy.retry,
    onClick: () => void retry(),
    icon: <RefreshCw />,
    busy: 'retry'
  }

  const localAction: RecoveryAction = {
    key: 'local',
    label: copy.useLocalGateway,
    onClick: () => void switchToLocalGateway(),
    variant: 'secondary',
    busy: 'local'
  }

  let actions: RecoveryAction[]
  let hint: string
  // The electron boot path flags a Nous Cloud backend-down (502/503/504) with
  // the structured isCloudBackendDown/statusCode it carries through boot
  // progress. When set, the recovery screen leads with the cloud-specific
  // guidance instead of the generic remote-failure copy (#85335).
  const cloudDown = Boolean(boot.isCloudBackendDown)
  // V3-S: main refused to spawn the local agent because its permission gate is not installed/loaded. Retry re-checks,
  // Repair reinstalls the runtime (the gate follows it); gateway settings cannot fix it, so they are not offered.
  const gateMissing = !remoteReauth && !cloudDown && !remoteFailure && isIcloneGateFailure(boot.error)

  if (remoteReauth) {
    actions = [
      {
        key: 'signin',
        label: copy.signOutAndSignIn,
        onClick: () => void signInRemote(),
        icon: <LogIn />,
        busy: 'signin'
      },
      { ...settingsAction, variant: 'secondary' },
      localAction
    ]
    hint = copy.remoteSignInHint(label)
  } else if (cloudDown) {
    // A Nous Cloud agent is down — the user cannot restart the managed
    // instance and Repair is local-only. Lead with the paths that actually
    // resolve it: check the portal (status/instance controls), switch to the
    // local gateway, retry, or get support on Discord. Portal/Discord are
    // buttons (not URLs buried in the hint prose) so localized hints can't
    // drift the links.
    actions = [
      {
        key: 'portal',
        label: copy.cloudDownCheckPortal,
        onClick: () => openExternalLink('https://portal.nousresearch.com'),
        icon: <ExternalLink />
      },
      localAction,
      { ...retryAction, variant: 'secondary' },
      {
        key: 'discord',
        label: copy.cloudDownDiscord,
        onClick: () => openExternalLink('https://discord.gg/NousResearch'),
        variant: 'ghost'
      },
      { ...settingsAction, variant: 'ghost' }
    ]
    hint = copy.cloudDownHint
  } else if (remoteFailure) {
    actions = [settingsAction, { ...retryAction, variant: 'secondary' }, localAction]
    hint = copy.remoteFailureHint
  } else if (gateMissing) {
    actions = [
      retryAction,
      {
        key: 'repair',
        label: copy.repairInstall,
        onClick: () => void repair(),
        icon: <Wrench />,
        variant: 'secondary',
        busy: 'repair'
      }
    ]
    // V3-S r4 (m-g): a runtime the app does not manage (a user's git checkout) gets its cause and its way out.
    hint = isIcloneGateUnmanaged(boot.error) ? copy.gateHintUnmanaged : copy.gateHint
  } else {
    // Local failure: Use-local is redundant with Retry (both re-target local), so
    // it's dropped here; keep it for remote failures where it's the fall-back.
    actions = [
      retryAction,
      {
        key: 'repair',
        label: copy.repairInstall,
        onClick: () => void repair(),
        icon: <Wrench />,
        variant: 'secondary',
        busy: 'repair'
      },
      { ...settingsAction, variant: 'ghost' }
    ]
    hint = copy.repairHint
  }

  if (view === 'connect') {
    return (
      <div
        className="fixed inset-0 z-(--z-setup) flex items-center justify-center ic-sys ic-sys-backdrop p-6"
        // Masks the whole app on boot failure — must stay filled under window
        // glass. Contract: `[data-glass-opaque]` in styles.css.
        data-glass-opaque=""
      >
        <div className="flex max-h-[86vh] w-full max-w-[46rem] flex-col overflow-hidden ic-sys-card">
          {/* Subtle back affordance (projects/overlay idiom): muted → foreground
              on hover, no divider. */}
          <button
            className="flex w-full items-center gap-1.5 px-4 pt-4 text-left text-xs text-(--ic-text-2) transition-colors hover:text-(--ic-text-1)"
            onClick={() => setView('recovery')}
            type="button"
          >
            <ChevronLeft className="size-3.5" />
            {copy.back}
          </button>
          <div className="min-h-0 flex-1 pt-4">
            <Suspense fallback={<IcSpinner className="mx-auto my-16 size-6 text-(--ic-text-3)" />}>
              <GatewaySettings embedded />
            </Suspense>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-(--z-setup) flex items-center justify-center ic-sys ic-sys-backdrop p-6"
      // Masks the whole app on boot failure — must stay filled under window
      // glass. Contract: `[data-glass-opaque]` in styles.css.
      data-glass-opaque=""
    >
      <div className="w-full max-w-[40rem] overflow-hidden ic-sys-card">
        <div className="flex items-start gap-3.5 px-6 pt-6 pb-5">
          <IcErrorGlyph className="mt-0.5" size="1.25rem" />
          <div className="min-w-0">
            <h2 className="ic-sys-title">
              {remoteReauth
                ? copy.remoteTitle
                : cloudDown
                  ? copy.cloudDownTitle
                  : gateMissing
                    ? copy.gateTitle
                    : copy.title}
            </h2>
            <p className="ic-sys-body mt-1">
              {remoteReauth
                ? copy.remoteDescription
                : cloudDown
                  ? copy.cloudDownDescription
                  : gateMissing
                    ? copy.gateDescription
                    : copy.description}
            </p>
          </div>
        </div>

        {/* V3-RT critic r2 m5: one column that never grows past the card — a long unbroken error (a path, a list of
            files) wraps inside its callout instead of widening the column under the buttons. */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 px-6 pb-6">
          {/* RTB-6 diagnosis first: what failed in plain words; the first line of the error below it, the rest (a
              traceback, the log path) only under "Show recent logs". */}
          {diagnosis.class !== 'unknown' ? (
            <p className="ic-sys-body">{t.install.recovery.diagnosis[diagnosis.class]}</p>
          ) : null}
          <div
            className="ic-sys-callout max-h-40 min-w-0 overflow-y-auto [overflow-wrap:anywhere]"
            data-testid="boot-failure-error"
            data-tone="danger"
          >
            {firstLine(sshFailureMessage(connectionConfig, boot.error, t.settings.gateway))}
          </div>

          <div className="grid gap-2">
            <div className="flex flex-wrap gap-2">
              {actions.map(action => (
                <IcButton disabled={Boolean(busy)} key={action.key} onClick={action.onClick} variant={action.variant}>
                  {action.busy && busy === action.busy ? <Loader2 className="animate-spin" /> : action.icon}
                  {action.label}
                </IcButton>
              ))}
              <IcButton onClick={openLogs} variant="ghost">
                <FileText />
                {copy.openLogs}
              </IcButton>
            </div>
            <p className="ic-sys-hint">{hint}</p>
          </div>

          {logs.length > 0 ? (
            <div className="grid gap-2">
              <IcButton
                className="-ml-2 self-start font-medium"
                onClick={() => setShowLogs(v => !v)}
                size="xs"
                type="button"
                variant="text"
              >
                {showLogs ? copy.hideRecentLogs : copy.showRecentLogs}
              </IcButton>
              {showLogs ? (
                <IcLog className="max-h-48">{[`${boot.error ?? ''}\n\n`, ...logs.slice(-40)].join('')}</IcLog>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** The first line of a failure message: a traceback or log path never sits above the fold (RTB-6). */
function firstLine(message: ReactNode): ReactNode {
  return typeof message === 'string' ? (message.split('\n')[0] ?? message) : message
}
