import { useEffect, useMemo, useRef, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { IcButton, IcErrorGlyph, IcLog, IcProgress, IcSpinner } from '@/components/onboarding/ic-system'
import type {
  DesktopBootstrapEvent,
  DesktopBootstrapStageDescriptor,
  DesktopBootstrapStageResult,
  DesktopBootstrapStageState,
  DesktopBootstrapState
} from '@/global'
import { useI18n } from '@/i18n'
import { errorMessage } from '@/iclone-shared/errors'
import { formatBytes, formatDurationMs, formatElapsedSeconds } from '@/iclone-shared/format'
import { diagnoseInstallFailure, type InstallFixAction } from '@/iclone-shared/install-diagnosis'
import {
  initialPackages,
  type PackageLine,
  PACKAGES_STAGE,
  packagesFromLog,
  packagesProgress,
  type PackagesState,
  PYTHON_ENV_PACKAGE,
  reducePackageLine,
  settlePackages,
  unattributedFailures
} from '@/iclone-shared/install-packages'
import { AlertCircle, Check, ChevronDown, ChevronRight, Globe, iconSize, Loader2, Monitor } from '@/lib/icons'
import { capitalize } from '@/lib/text'
import { cn } from '@/lib/utils'
import { $agentRuntimeSkipped, $installOverlayOwnsFailure } from '@/store/agent-runtime'
import { skipDesktopBoot } from '@/store/boot'

import { FirstRunRemoteForm } from './first-run-remote-form'

/**
 * DesktopInstallOverlay
 *
 * Renders the first-launch install progress for Hermes Agent. Mounted always;
 * shows itself only when main.ts reports an in-flight bootstrap (state.active)
 * OR an error from a completed-failed bootstrap (state.error). When the
 * bootstrap finishes successfully the overlay fades out and the rest of the
 * app (existing onboarding overlay -> main UI) takes over.
 *
 * Subscribes to two channels:
 *   - getBootstrapState()           -- initial snapshot on mount
 *   - onBootstrapEvent(callback)    -- live event stream
 *
 * The reducer is intentionally simple: every event mutates an in-component
 * snapshot the same way main.ts mutates its server-side snapshot. We don't
 * try to reconcile -- if we miss an event (shouldn't happen) the initial
 * getBootstrapState() call will resync the picture on the next render.
 *
 * Stages flagged needs_user_input render with a deliberately subdued style:
 * they're expected to come back as skipped=true (install.ps1 short-circuits
 * them under -NonInteractive). The post-install configuration flow that
 * those stages cover (API key, model, persona, gateway autostart) is handled
 * by the existing DesktopOnboardingOverlay, NOT by the install overlay.
 */

interface DesktopInstallOverlayProps {
  /** When false, the overlay never renders -- useful for dev when we want
   * to suppress it entirely. */
  enabled?: boolean
}

interface StageRowProps {
  descriptor: DesktopBootstrapStageDescriptor
  result: DesktopBootstrapStageResult | undefined
  now: number
}

function formatStageName(name: string): string {
  // 'system-packages' -> 'System packages'; 'uv' stays 'uv'
  if (name.length <= 3) {
    return name
  }

  return name
    .split('-')
    .map((word, i) => (i === 0 ? capitalize(word) : word))
    .join(' ')
}

function StageRow({ descriptor, result, now }: StageRowProps) {
  const { t } = useI18n()
  const copy = t.install
  const state: DesktopBootstrapStageState = result?.state || 'pending'

  const elapsed =
    state === 'running' && typeof result?.startedAt === 'number'
      ? formatElapsedSeconds((now - result.startedAt) / 1000)
      : ''

  const icon = useMemo(() => {
    switch (state) {
      case 'running':
        return <IcSpinner className="size-6" type="fourier-flow" />

      case 'succeeded':

      case 'skipped':
        return <Check className="size-[0.8125rem] text-(--ic-success)" />

      case 'failed':
        return <IcErrorGlyph size="1rem" />

      case 'pending':

      default:
        return <div className="size-1.5 rounded-(--ic-radius-pill) border border-(--ic-border-strong)" />
    }
  }, [state])

  // RTB-6 / r2b: no installer text on the rows — a failed stage's raw error and a skipped stage's reason ("source
  // tarball install: git and the Command Line Tools are not needed") sit under "Show details".

  return (
    <li className="flex items-center gap-3 px-3 py-1">
      {state === 'running' && (
        <div className="-mr-2 -ml-4 flex size-6 flex-shrink-0 items-center justify-center">{icon}</div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn('truncate text-sm', state === 'running' ? 'font-medium' : 'text-(--ic-text-2)')}>
            {copy.recovery.stageNames[descriptor.name] ?? formatStageName(descriptor.name)}
          </span>
          {state !== 'running' && <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>}
        </div>
      </div>
      <span className="flex-shrink-0 text-xs tabular-nums text-(--ic-text-2)">
        {state === 'running' ? (elapsed ? `${copy.stageStates[state]} · ${elapsed}` : copy.stageStates[state]) : null}
        {state === 'succeeded' || state === 'skipped' ? formatDurationMs(result?.durationMs) : null}
        {state === 'failed' ? copy.stageStates[state] : null}
      </span>
    </li>
  )
}

// RTB-7 (owner override): every package of the dependency stage is its own line, in the stage row's own style.
function PackageRow({ line }: { line: PackageLine }) {
  const { t } = useI18n()
  const copy = t.install.recovery
  const states = copy.packageStates

  const open =
    line.state === 'downloading' ||
    line.state === 'verifying' ||
    line.state === 'unpacking' ||
    line.state === 'installing'

  // A stopped row (its stage failed or was killed before it finished) keeps the waiting row's neutral dot.
  const icon =
    line.state === 'done' || line.state === 'not-needed' ? (
      <Check className="size-[0.8125rem] text-(--ic-success)" />
    ) : line.state === 'failed' ? (
      <IcErrorGlyph size="1rem" />
    ) : open ? (
      <Loader2 className="size-[0.8125rem] animate-spin text-(--ic-text-2)" />
    ) : (
      <div className="size-1.5 rounded-(--ic-radius-pill) border border-(--ic-border-strong)" />
    )

  // A repair opens the download before PM prints its first size: say so, not "0.0 % ·  / " (G-01 R4-2).
  const label =
    line.state === 'downloading'
      ? line.done !== null && line.total !== null
        ? states.downloading((line.percent ?? 0).toFixed(1), line.done, line.total)
        : states.repairing
      : line.state === 'not-needed'
        ? states.notNeeded
        : states[line.state]

  return (
    <li className="flex items-center gap-3 px-3 py-1 pl-5" data-package={line.name} data-state={line.state}>
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className={cn('min-w-0 flex-1 truncate text-sm', open ? 'font-medium' : 'text-(--ic-text-2)')}>
        {line.name === PYTHON_ENV_PACKAGE ? copy.pythonEnvironment : line.name}
      </span>
      <span className="flex-shrink-0 text-xs tabular-nums text-(--ic-text-2)">{label}</span>
    </li>
  )
}

/** The package lines of a bootstrap snapshot (a reloaded renderer): replay its log, settle a finished stage. */
function packagesFromSnapshot(snapshot: DesktopBootstrapState): PackagesState {
  const replayed = packagesFromLog(snapshot.log.map(entry => ({ ...entry, ts: entry.ts })))
  const stage = snapshot.stages[PACKAGES_STAGE]?.state

  return stage === 'succeeded' || stage === 'failed' ? settlePackages(replayed, stage, Date.now()) : replayed
}

function applyPackagesEvent(state: PackagesState, ev: DesktopBootstrapEvent): PackagesState {
  if (ev.type === 'manifest' && ev.stages.length > 0) {
    return initialPackages()
  }

  if (ev.type === 'log' && ev.stage === PACKAGES_STAGE) {
    return reducePackageLine(state, ev.line, Date.now())
  }

  if (ev.type === 'stage' && ev.name === PACKAGES_STAGE && (ev.state === 'succeeded' || ev.state === 'failed')) {
    return settlePackages(state, ev.state, Date.now())
  }

  return state
}

const EMPTY_STATE: DesktopBootstrapState = {
  active: false,
  manifest: null,
  stages: {},
  error: null,
  log: [],
  startedAt: null,
  completedAt: null,
  setupChoice: null,
  unsupportedPlatform: null
}

function applyEvent(state: DesktopBootstrapState, ev: DesktopBootstrapEvent): DesktopBootstrapState {
  if (ev.type === 'dismissed') {
    return { ...EMPTY_STATE }
  }

  if (ev.type === 'setup-choice') {
    return {
      ...state,
      active: false,
      manifest: null,
      stages: {},
      error: null,
      setupChoice: ev.active
        ? {
            platform: ev.platform || state.setupChoice?.platform || 'unknown',
            activeRoot: ev.activeRoot || state.setupChoice?.activeRoot || ''
          }
        : null,
      unsupportedPlatform: null
    }
  }

  if (ev.type === 'manifest') {
    const stages: Record<string, DesktopBootstrapStageResult> = {}

    for (const stage of ev.stages) {
      stages[stage.name] = { state: 'pending', durationMs: null, startedAt: null, json: null, error: null }
    }

    return {
      ...state,
      active: true,
      manifest: {
        type: 'manifest',
        stages: ev.stages,
        protocolVersion: ev.protocolVersion,
        ...(ev.purpose === 'runtime-upgrade' ? { purpose: ev.purpose } : {})
      },
      stages,
      error: null,
      setupChoice: null,
      startedAt: state.startedAt || Date.now()
    }
  }

  if (ev.type === 'stage') {
    const prev = state.stages[ev.name]

    return {
      ...state,
      stages: {
        ...state.stages,
        [ev.name]: {
          state: ev.state,
          durationMs: ev.durationMs ?? null,
          // Stamp the start time on the running transition so the UI can show
          // a live elapsed timer; preserve it across repeated running events.
          startedAt: ev.state === 'running' ? (prev?.startedAt ?? Date.now()) : (prev?.startedAt ?? null),
          json: ev.json ?? null,
          error: ev.error ?? null
        }
      }
    }
  }

  if (ev.type === 'log') {
    const next = state.log.concat({ ts: Date.now(), stage: ev.stage ?? null, line: ev.line, stream: ev.stream })

    while (next.length > 500) {
      next.shift()
    }

    return { ...state, log: next }
  }

  if (ev.type === 'complete') {
    return { ...state, active: false, completedAt: Date.now(), error: null }
  }

  if (ev.type === 'failed') {
    return { ...state, active: false, error: ev.error || 'unknown error', setupChoice: null }
  }

  if (ev.type === 'unsupported-platform') {
    return {
      ...state,
      active: false,
      setupChoice: null,
      unsupportedPlatform: {
        platform: ev.platform,
        activeRoot: ev.activeRoot,
        installCommand: ev.installCommand,
        docsUrl: ev.docsUrl
      }
    }
  }

  return state
}

export function DesktopInstallOverlay({ enabled = true }: DesktopInstallOverlayProps) {
  const { t } = useI18n()
  const copy = t.install

  const [state, setState] = useState<DesktopBootstrapState>(EMPTY_STATE)
  const [packages, setPackages] = useState<PackagesState>(() => initialPackages())
  // RTB-6: a fix that opened something outside the app (Storage / Network settings, the folder) turns the primary
  // button into "Retry now"; "Skip for now" dismisses the overlay for this run.
  const [fixOpened, setFixOpened] = useState(false)
  const [skipped, setSkipped] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const logEndRef = useRef<HTMLDivElement | null>(null)

  // Tick once a second while a bootstrap is in flight so running steps show a
  // live elapsed timer. Stops when nothing is active to avoid idle renders.
  useEffect(() => {
    if (!state.active) {
      return
    }

    const id = window.setInterval(() => setNow(Date.now()), 1000)

    return () => window.clearInterval(id)
  }, [state.active])

  // Subscribe to bootstrap events + load initial snapshot
  useEffect(() => {
    if (!enabled) {
      return
    }

    const desktop = window.hermesDesktop

    if (!desktop || typeof desktop.onBootstrapEvent !== 'function') {
      return
    }

    let cancelled = false

    desktop
      .getBootstrapState()
      .then(snapshot => {
        if (!cancelled && snapshot) {
          setState(snapshot)
          setPackages(packagesFromSnapshot(snapshot))
        }
      })
      .catch(() => {
        // Older Electron build without the IPC handler -- bootstrap UI just
        // stays empty, app falls through to existing onboarding flow.
      })

    const off = desktop.onBootstrapEvent(ev => {
      setState(prev => applyEvent(prev, ev))
      setPackages(prev => applyPackagesEvent(prev, ev))
    })

    return () => {
      cancelled = true
      off?.()
    }
  }, [enabled])

  // Autoscroll log to bottom when new lines arrive AND the log is open
  useEffect(() => {
    if (logOpen && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'auto', block: 'end' })
    }
  }, [state.log.length, logOpen])

  // Auto-expand the log panel when a bootstrap fails so the user immediately
  // sees the install.ps1 output. Without this, the failure block shows just
  // the top-level error message and the user has to click "Show installer
  // output" to see WHY the stage failed.
  // RTB-6: a failure no longer opens the raw output by itself — the diagnosis and its one fix come first, the
  // transcript stays one click away ("Show details").
  useEffect(() => {
    if (!state.error) {
      setFixOpened(false)
      setDetailsOpen(false)
    }
  }, [state.error])

  // The choice remains mounted while main hands off to local bootstrap. Once
  // a manifest/failure takes ownership (or a later repair presents a fresh
  // choice), this transient button state must not leak across phases — so it
  // records the root it was produced under and is read back only under that
  // same root. Deriving it beats clearing it in an effect: the choice paints
  // as soon as the first snapshot commits, and a click landing before such an
  // effect flushed would have its error wiped before it ever rendered.
  const [localStart, setLocalStart] = useState<{
    root: string | null
    starting: boolean
    error: string | null
  }>({ root: null, starting: false, error: null })

  const activeRoot = state.setupChoice?.activeRoot ?? null
  const forActiveRoot = localStart.root === activeRoot
  const localStarting = forActiveRoot && localStart.starting
  const localStartError = forActiveRoot ? localStart.error : null

  // Mount logic: show whenever a bootstrap is in flight, completed-with-error,
  // or actively running with a manifest. Hide entirely after a successful
  // completion so the rest of the UI can take over.
  const shouldShow = useMemo(() => {
    if (!enabled || skipped) {
      return false
    }

    if (state.active) {
      return true
    }

    if (state.error) {
      return true
    }

    if (state.unsupportedPlatform) {
      return true
    }

    if (state.setupChoice) {
      return true
    }

    return false
  }, [enabled, skipped, state.active, state.error, state.setupChoice, state.unsupportedPlatform])

  const failureShown = shouldShow && Boolean(state.error) && !state.setupChoice && !state.unsupportedPlatform

  // The failed install is this overlay's to explain; the post-install failure card stays down meanwhile.
  useEffect(() => {
    $installOverlayOwnsFailure.set(failureShown)

    return () => $installOverlayOwnsFailure.set(false)
  }, [failureShown])

  const diagnosis = useMemo(() => {
    if (!state.error) {
      return null
    }

    const failedStage = state.manifest?.stages.find(stage => state.stages[stage.name]?.state === 'failed')?.name ?? null

    return diagnoseInstallFailure({
      error: (failedStage ? state.stages[failedStage]?.error : null) ?? state.error,
      log: state.log.map(entry => entry.line),
      stage: failedStage
    })
  }, [state.error, state.log, state.manifest, state.stages])

  if (!shouldShow) {
    return null
  }

  if (remoteOpen) {
    return <FirstRunRemoteForm onBack={() => setRemoteOpen(false)} />
  }

  if (state.setupChoice) {
    return (
      <div className="fixed inset-0 z-(--z-setup) flex items-center justify-center ic-sys ic-sys-scrim p-4">
        <div className="w-full max-w-2xl ic-sys-card p-8">
          <div className="flex items-start gap-4">
            <BrandMark className="size-11 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-xl font-semibold tracking-tight">{copy.setupChoiceTitle}</h2>
              <p className="mt-1.5 text-sm text-(--ic-text-2)">{copy.setupChoiceDesc}</p>
            </div>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <button
              className="rounded-(--ic-radius-md) border border-(--ic-border-subtle) bg-(--ic-surface-raised) p-4 text-left transition hover:bg-(--ic-fill-hover)"
              onClick={() => setRemoteOpen(true)}
              type="button"
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <Globe className="size-4 text-(--ic-text-2)" />
                <span>{copy.connectExistingTitle}</span>
              </div>
              <p className="mt-2 text-sm leading-5 text-(--ic-text-2)">{copy.connectExistingDesc}</p>
            </button>

            <button
              className="rounded-(--ic-radius-md) border border-(--ic-border-subtle) bg-(--ic-surface-raised) p-4 text-left transition hover:bg-(--ic-fill-hover) disabled:cursor-wait disabled:opacity-60"
              disabled={localStarting}
              onClick={async () => {
                setLocalStart({ root: activeRoot, starting: true, error: null })

                try {
                  const desktop = window.hermesDesktop

                  if (!desktop || typeof desktop.continueBootstrapLocal !== 'function') {
                    throw new Error(copy.localStartUnavailable)
                  }

                  await desktop.continueBootstrapLocal()
                } catch (err) {
                  setLocalStart({ root: activeRoot, starting: false, error: errorMessage(err, 'Unknown error') })
                }
              }}
              type="button"
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                {localStarting ? (
                  <Loader2 className="size-4 animate-spin text-(--ic-text-2)" />
                ) : (
                  <Monitor className="size-4 text-(--ic-text-2)" />
                )}
                <span>{copy.installLocalTitle}</span>
              </div>
              <p className="mt-2 text-sm leading-5 text-(--ic-text-2)">{copy.installLocalDesc}</p>
            </button>
          </div>

          {localStartError ? (
            <div className="mt-4 flex items-start gap-2 text-sm text-(--ic-danger)">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{localStartError}</span>
            </div>
          ) : null}

          <div className="mt-6 text-xs text-(--ic-text-2)">
            {copy.installTo} <code className="font-mono text-(--ic-text-2)">{state.setupChoice.activeRoot}</code>
          </div>
        </div>
      </div>
    )
  }

  // Unsupported-platform branch: macOS/Linux packaged builds hit this when
  // there's no Hermes Agent installed yet and we can't drive install.sh
  // (no stage protocol equivalent yet). Show a copy-paste install command
  // and the docs URL; user runs it from Terminal and relaunches the app.
  if (state.unsupportedPlatform) {
    const ups = state.unsupportedPlatform
    const platformLabel = ups.platform === 'darwin' ? 'macOS' : ups.platform === 'linux' ? 'Linux' : ups.platform

    return (
      <div className="fixed inset-0 z-(--z-setup) flex items-center justify-center ic-sys ic-sys-scrim">
        <div className="w-full max-w-xl ic-sys-card p-8">
          <h2 className="text-xl font-semibold tracking-tight">{copy.oneTimeTitle}</h2>
          <p className="mt-2 text-sm text-(--ic-text-2)">{copy.unsupportedDesc(platformLabel)}</p>

          <div className="mt-4">
            <div className="mb-1.5 text-xs font-medium text-(--ic-text-2)">{copy.installCommand}</div>
            <pre className="overflow-x-auto rounded-(--ic-radius-sm) border border-(--ic-border-subtle) px-3 py-2.5 font-mono text-[12px]">
              <code>{ups.installCommand}</code>
            </pre>
            <div className="mt-2 flex items-center gap-2">
              <IcButton
                onClick={() => {
                  void navigator.clipboard?.writeText(ups.installCommand).catch(() => {})
                }}
                size="sm"
                variant="secondary"
              >
                {copy.copyCommand}
              </IcButton>
              <IcButton
                onClick={() => {
                  window.hermesDesktop?.openExternal?.(ups.docsUrl)
                }}
                size="sm"
                variant="ghost"
              >
                {copy.viewDocs}
              </IcButton>
            </div>
          </div>

          <div className="mt-6 flex items-center justify-between pt-2">
            <span className="text-xs text-(--ic-text-2)">
              {copy.installTo} <code className="font-mono text-(--ic-text-2)">{ups.activeRoot}</code>
            </span>
            <div className="flex items-center gap-2">
              <IcButton onClick={() => setRemoteOpen(true)} size="sm" variant="secondary">
                <Globe className="size-4" />
                {copy.connectExistingShort}
              </IcButton>
              <IcButton onClick={() => window.location.reload()} size="sm" variant="default">
                {copy.retryAfterRun}
              </IcButton>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const stages = state.manifest?.stages || []
  const currentStage = stages.find(s => state.stages[s.name]?.state === 'running')?.name

  const completedCount = stages.filter(
    s => state.stages[s.name]?.state === 'succeeded' || state.stages[s.name]?.state === 'skipped'
  ).length

  const totalCount = stages.length
  const failed = Boolean(state.error)

  // Count the running stage as half-done so the bar advances *during* a long
  // stage instead of sitting frozen at the last completed step while its logs
  // stream (e.g. "0 of 2" pinned at 0% for the whole first stage).
  // RTB-7: the dependency stage advances with its packages (downloads by their own percent), not as one half-step.
  const progressUnits =
    completedCount +
    (!failed && currentStage ? (currentStage === PACKAGES_STAGE ? packagesProgress(packages, now) : 0.5) : 0)

  const progressPct = totalCount > 0 ? Math.round((progressUnits / totalCount) * 100) : 0
  // The package the failure happened in: named by the output, else the row the stage's failure landed on.
  const failedPackage = diagnosis?.packageName ?? packages.packages.find(line => line.state === 'failed')?.name ?? null
  const currentStartedAt = currentStage ? state.stages[currentStage]?.startedAt : null

  const currentElapsed =
    typeof currentStartedAt === 'number' ? formatElapsedSeconds((now - currentStartedAt) / 1000) : ''

  return (
    <div className="fixed inset-0 z-(--z-setup) flex items-center justify-center ic-sys ic-sys-scrim p-4">
      <div className="flex w-full max-w-2xl max-h-[90vh] flex-col ic-sys-card">
        {/* Header -- always visible, never scrolls */}
        <div className="flex flex-shrink-0 items-start gap-4 p-8 pb-4">
          {!failed && <BrandMark className="size-11 shrink-0" />}
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight">
              {failed ? copy.failedTitle : state.active ? copy.settingUpTitle : copy.finishingTitle}
            </h2>
            <p className="mt-1.5 text-sm text-(--ic-text-2)">
              {failed
                ? diagnosis?.fix === 'repair'
                  ? copy.recovery.failedDescRepair
                  : copy.recovery.failedDesc
                : state.manifest?.purpose === 'runtime-upgrade'
                  ? copy.runtimeUpgradeDesc
                  : copy.activeDesc}
            </p>
          </div>
        </div>

        {/* Scrollable middle: progress, stages, error block, log */}
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-2">
          {totalCount > 0 && (
            <div className="mb-4">
              <div className="mb-1 flex items-center justify-between text-xs text-(--ic-text-2)">
                <span>
                  {copy.progress(completedCount, totalCount)}
                  {currentStage &&
                    copy.currentStage(copy.recovery.stageNames[currentStage] ?? formatStageName(currentStage))}
                  {currentElapsed && ` (${currentElapsed})`}
                </span>
                <span className="tabular-nums">{progressPct}%</span>
              </div>
              <IcProgress
                aria-label={copy.progress(completedCount, totalCount)}
                className="bg-(--ic-surface-sunken)"
                destructive={failed}
                value={progressPct / 100}
              />
            </div>
          )}

          {totalCount === 0 && state.active && (
            <div className="mb-4 flex items-center gap-2.5 text-sm text-(--ic-text-2)">
              <IcSpinner className="size-5" type="fourier-flow" />
              <span>{copy.fetchingManifest}</span>
            </div>
          )}

          {failed && state.error && diagnosis && (
            <div
              className="mb-4 flex items-start gap-2 text-sm"
              data-diagnosis={diagnosis.class}
              data-fix={diagnosis.fix}
            >
              <IcErrorGlyph className="mt-0.5 shrink-0" size="1rem" />
              <div className="min-w-0">
                <div className="font-medium text-(--ic-danger)">{copy.recovery.diagnosis[diagnosis.class]}</div>
                {failedPackage ? (
                  <p className="mt-0.5 text-(--ic-text-2)">
                    {copy.recovery.failedIn(
                      failedPackage === PYTHON_ENV_PACKAGE ? copy.recovery.pythonEnvironment : failedPackage
                    )}
                  </p>
                ) : null}
                {unattributedFailures(packages).map((line, index) => (
                  <p className="mt-0.5 break-words text-(--ic-text-2)" data-unattributed key={index}>
                    {copy.recovery.unattributed(line)}
                  </p>
                ))}
                <p className="mt-0.5 text-xs text-(--ic-text-2)">{copy.recovery.skipHint}</p>
              </div>
            </div>
          )}

          {stages.length > 0 && (
            <ol className="mb-4 space-y-0.5">
              {stages
                .map(stage => (
                  <StageRow descriptor={stage} key={stage.name} now={now} result={state.stages[stage.name]} />
                ))
                .flatMap((row, index) =>
                  stages[index].name === PACKAGES_STAGE &&
                  (state.stages[PACKAGES_STAGE]?.state ?? 'pending') !== 'pending'
                    ? [row, ...packages.packages.map(line => <PackageRow key={`package:${line.name}`} line={line} />)]
                    : [row]
                )}
            </ol>
          )}

          <div className="pt-3">
            <IcButton
              className="-ml-2 text-(--ic-text-2) hover:text-(--ic-text-1)"
              onClick={() => (failed ? setDetailsOpen(v => !v) : setLogOpen(v => !v))}
              size="xs"
              type="button"
              variant="ghost"
            >
              {(failed ? detailsOpen : logOpen) ? (
                <ChevronDown className={iconSize.sm} />
              ) : (
                <ChevronRight className={iconSize.sm} />
              )}
              <span>
                {failed
                  ? detailsOpen
                    ? copy.recovery.hideDetails
                    : copy.recovery.showDetails
                  : logOpen
                    ? copy.hideOutput
                    : copy.showOutput}
              </span>
              <span className="ml-1 tabular-nums">({copy.lines(state.log.length)})</span>
            </IcButton>

            {(failed ? detailsOpen : logOpen) && (
              <IcLog className={cn('mt-2', failed ? 'max-h-96' : 'max-h-64')}>
                {failed && state.error ? <div>{`${copy.error}: ${state.error}`}</div> : null}
                {stages.flatMap(stage => {
                  const result = state.stages[stage.name]
                  const why = result?.json?.reason || result?.error

                  return why ? [<div key={`reason:${stage.name}`}>{`[${stage.name}] ${why}`}</div>] : []
                })}
                {state.log.length === 0 ? (
                  <div>{copy.noOutput}</div>
                ) : (
                  <>
                    {state.log.map((entry, i) => (
                      <div className={cn(entry.stream === 'stderr' && 'text-(--ic-text-2)')} key={i}>
                        {entry.stage ? <span className="text-(--ic-text-3)">[{entry.stage}] </span> : null}
                        <span>{entry.line}</span>
                      </div>
                    ))}
                    <div ref={logEndRef} />
                  </>
                )}
              </IcLog>
            )}
          </div>
        </div>

        {/* Active footer: let the user actually cancel a running install. */}
        {state.active && !failed && (
          <div className="flex-shrink-0 bg-(--ic-surface-raised) p-4">
            <div className="flex items-center justify-end">
              <IcButton
                disabled={cancelling}
                onClick={async () => {
                  setCancelling(true)

                  try {
                    await window.hermesDesktop?.cancelBootstrap?.()
                  } catch {
                    // ignore -- the failed/cancelled event will surface the result
                  }
                }}
                size="sm"
                variant="ghost"
              >
                {cancelling ? <IcSpinner className="size-4" type="fourier-flow" /> : null}
                {cancelling ? copy.cancelling : copy.cancelInstall}
              </IcButton>
            </div>
          </div>
        )}

        {/* Footer -- always visible, never scrolls; only renders on failure */}
        {failed && (
          <div className="flex-shrink-0 bg-(--ic-surface-raised) p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-(--ic-text-2)">{copy.recovery.transcriptHint}</span>
              <div className="flex gap-2">
                <IcButton
                  onClick={async () => {
                    const text = state.log
                      .map(entry => (entry.stage ? `[${entry.stage}] ${entry.line}` : entry.line))
                      .join('\n')

                    const fullText = state.error ? `Error: ${state.error}\n\n${text}` : text

                    try {
                      await navigator.clipboard.writeText(fullText)
                      setCopied(true)
                      window.setTimeout(() => setCopied(false), 1500)
                    } catch {
                      // ignore -- some environments forbid clipboard writes
                    }
                  }}
                  size="sm"
                  variant="secondary"
                >
                  {copied ? copy.copiedOutput : copy.copyOutput}
                </IcButton>
                <IcButton
                  data-action="skip"
                  onClick={async () => {
                    // RTB-6 "Skip for now": main records it (Settings > Machine > Agent runtime shows the fix, the next
                    // launch offers the install once more) and the app opens without the agent.
                    try {
                      await window.hermesDesktop?.agentRuntime?.skip()
                    } catch {
                      // The record is best effort; the app still opens without the agent.
                    }

                    $agentRuntimeSkipped.set(true)
                    $installOverlayOwnsFailure.set(false)
                    skipDesktopBoot()
                    setSkipped(true)
                  }}
                  size="sm"
                  variant="ghost"
                >
                  {copy.recovery.skipForNow}
                </IcButton>
                <IcButton
                  data-action={fixOpened ? 'retry' : (diagnosis?.fix ?? 'retry')}
                  onClick={async () => {
                    const fix: InstallFixAction = fixOpened ? 'retry' : (diagnosis?.fix ?? 'retry')

                    if (fix === 'open-network-settings' || fix === 'open-storage-settings' || fix === 'reveal-folder') {
                      try {
                        await window.hermesDesktop?.agentRuntime?.openFix(fix)
                      } catch {
                        // Nothing opened: the button still turns into Retry.
                      }

                      setFixOpened(true)

                      return
                    }

                    // Retry resumes (finished stages and installed packages are reused); Repair forces a fresh
                    // install. Main clears its latched failure BEFORE the reload, or the reloaded renderer's
                    // getConnection would short-circuit to the latched error without re-running the installer.
                    try {
                      if (fix === 'repair') {
                        await window.hermesDesktop?.repairBootstrap?.()
                      } else {
                        await window.hermesDesktop?.resetBootstrap?.()
                      }
                    } catch {
                      // best-effort -- continue with reload regardless
                    }

                    window.location.reload()
                  }}
                  size="sm"
                  variant="default"
                >
                  {fixLabel(
                    fixOpened ? 'retry' : (diagnosis?.fix ?? 'retry'),
                    diagnosis?.neededBytes ?? null,
                    copy,
                    fixOpened
                  )}
                </IcButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function fixLabel(
  fix: InstallFixAction,
  neededBytes: null | number,
  copy: ReturnType<typeof useI18n>['t']['install'],
  afterFix: boolean
): string {
  switch (fix) {
    case 'repair':
      return copy.recovery.fixRepair

    case 'open-storage-settings':
      return copy.recovery.fixFreeDisk(neededBytes ? formatBytes(neededBytes) : null)

    case 'open-network-settings':
      return copy.recovery.fixNetworkSettings

    case 'reveal-folder':
      return copy.recovery.fixRevealFolder

    case 'retry':

    default:
      return afterFix ? copy.recovery.retryNow : copy.recovery.fixRetry
  }
}
