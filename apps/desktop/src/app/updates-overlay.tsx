import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import {
  IcButton,
  IcDialog,
  IcDialogDescription,
  IcDialogTitle,
  IcErrorGlyph,
  IcProgress,
  IcSpinner,
  IcState
} from '@/components/onboarding/ic-system'
import { writeClipboardText } from '@/components/ui/copy-button'
import { preventCloseButtonAutoFocus } from '@/components/ui/dialog'
import type { DesktopUpdateBlocker, DesktopUpdateCommit, DesktopUpdateStage, DesktopUpdateStatus } from '@/global'
import { useI18n } from '@/i18n'
import { buildCommitChangelog, type CommitGroup } from '@/lib/commit-changelog'
import { AlertCircle, Check, Copy, Terminal } from '@/lib/icons'
import { resolveUpdateCopy, type UpdateTarget } from '@/lib/update-copy'
import { cn } from '@/lib/utils'
import {
  $backendUpdateApply,
  $backendUpdateChecking,
  $backendUpdateStatus,
  $updateApply,
  $updateChecking,
  $updateOverlayOpen,
  $updateOverlayTarget,
  $updatePolicy,
  $updateStatus,
  applyBackendUpdate,
  applyUpdates,
  checkBackendUpdates,
  checkUpdates,
  isCuratedPolicy,
  resetUpdateApplyState,
  setUpdateOverlayOpen,
  type UpdateApplyState
} from '@/store/updates'

import { CompatUpdateButton } from './updates-overlay.compat-chip'

function totalItems(groups: readonly CommitGroup[]) {
  return groups.reduce((sum, g) => sum + g.items.length, 0)
}

export function UpdatesOverlay() {
  const { t } = useI18n()
  const open = useStore($updateOverlayOpen)
  const target = useStore($updateOverlayTarget)

  const clientStatus = useStore($updateStatus)
  const clientChecking = useStore($updateChecking)
  const clientApply = useStore($updateApply)
  const backendStatus = useStore($backendUpdateStatus)
  const backendChecking = useStore($backendUpdateChecking)
  const backendApply = useStore($backendUpdateApply)
  const policyInfo = useStore($updatePolicy)

  const isBackend = target === 'backend'
  const status = isBackend ? backendStatus : clientStatus
  const checking = isBackend ? backendChecking : clientChecking
  const apply = isBackend ? backendApply : clientApply
  const check = isBackend ? checkBackendUpdates : checkUpdates
  const install = isBackend ? applyBackendUpdate : applyUpdates
  // Curated builds never move a backend runtime from here (RC6); the store refuses it too.
  const installHidden = isBackend && isCuratedPolicy(policyInfo)

  useEffect(() => {
    if (open && !status && !checking) {
      void check()
    }
  }, [check, checking, open, status])

  const behind = status?.behind ?? 0
  const updateAvailable = status?.updateAvailable || behind > 0

  const phase: 'idle' | 'applying' | 'manual' | 'guiSkew' | 'error' =
    apply.stage === 'manual'
      ? 'manual'
      : apply.stage === 'guiSkew'
        ? 'guiSkew'
        : apply.applying || apply.stage === 'restart'
          ? 'applying'
          : apply.stage === 'error'
            ? 'error'
            : 'idle'

  const updateBlockers = !isBackend && apply.error === 'venv-blocked' && apply.blockers?.length ? apply.blockers : null

  const handleClose = (next: boolean) => {
    if (phase === 'applying') {
      return
    }

    setUpdateOverlayOpen(next)

    if (
      !next &&
      (apply.stage === 'error' || apply.stage === 'restart' || apply.stage === 'manual' || apply.stage === 'guiSkew')
    ) {
      resetUpdateApplyState()
    }
  }

  const handleInstall = () => {
    void install()
  }

  return (
    /* This dialog has no inputs, so Radix's default autofocus would land on
          the close button and trigger its tooltip immediately on open. */
    <IcDialog
      bodyClassName="overflow-hidden"
      className="max-w-sm"
      closeLabel={t.common.close}
      onOpenAutoFocus={preventCloseButtonAutoFocus}
      onOpenChange={handleClose}
      open={open}
      showCloseButton={phase !== 'applying'}
    >
      {phase === 'applying' && <ApplyingView apply={apply} isBackend={isBackend} />}

      {phase === 'manual' && (
        <ManualView command={apply.command ?? null} message={apply.message} onDone={() => handleClose(false)} />
      )}

      {phase === 'guiSkew' && <GuiSkewView message={apply.message} onDone={() => handleClose(false)} />}

      {phase === 'error' && updateBlockers ? (
        <BlockerView
          blockers={updateBlockers}
          onDismiss={() => handleClose(false)}
          onStopAndUpdate={() => void applyUpdates({ stopSafeBlockers: true })}
        />
      ) : null}

      {phase === 'error' && !updateBlockers ? (
        <ErrorView message={apply.message} onDismiss={() => handleClose(false)} onRetry={handleInstall} />
      ) : null}

      {phase === 'idle' && (
        <IdleView
          behind={behind}
          checking={checking}
          commits={status?.commits ?? []}
          installHidden={installHidden}
          onInstall={handleInstall}
          onLater={() => handleClose(false)}
          onRetryCheck={() => void check()}
          status={status}
          target={target}
          updateAvailable={updateAvailable}
        />
      )}
    </IcDialog>
  )
}

function IdleView({
  behind,
  checking,
  commits,
  installHidden,
  onInstall,
  onLater,
  onRetryCheck,
  status,
  target,
  updateAvailable
}: {
  behind: number
  checking: boolean
  commits: readonly DesktopUpdateCommit[]
  installHidden: boolean
  onInstall: () => void
  onLater: () => void
  onRetryCheck: () => void
  status: DesktopUpdateStatus | null
  target: UpdateTarget
  updateAvailable: boolean
}) {
  const { t } = useI18n()
  const u = t.updates

  if (!status && checking) {
    return (
      <CenteredStatus
        icon={<IcSpinner className="size-12" label={u.checking} type="lemniscate-bloom" />}
        title={u.checking}
      />
    )
  }

  if (!status) {
    return (
      <CenteredStatus
        action={
          <IcButton onClick={onRetryCheck} size="sm">
            {u.tryAgain}
          </IcButton>
        }
        icon={<IcErrorGlyph />}
        title={u.checkFailedTitle}
      />
    )
  }

  if (!status.supported) {
    return (
      <CenteredStatus
        body={status.message ?? u.unsupportedMessage}
        icon={<AlertCircle className="size-6 text-(--ic-text-2)" />}
        title={u.notAvailableTitle}
      />
    )
  }

  if (status.error) {
    return (
      <CenteredStatus
        action={
          <IcButton disabled={checking} onClick={onRetryCheck} size="sm">
            {u.tryAgain}
          </IcButton>
        }
        body={u.connectionRetry}
        icon={<IcErrorGlyph />}
        title={u.checkFailedTitle}
      />
    )
  }

  if (!updateAvailable) {
    return (
      <CenteredStatus
        body={target === 'backend' ? u.latestBodyBackend : u.latestBody}
        icon={<BrandMark className="size-12" />}
        title={u.allSetTitle}
      />
    )
  }

  const groups = buildCommitChangelog(commits)
  const shownItems = totalItems(groups)
  const remaining = Math.max(0, behind - shownItems)

  // Name what's being updated. In remote mode the overlay acts on the connected
  // backend, not the local client — say so. When there are no commit rows to
  // show (e.g. pip/non-git backend), degrade to honest "no release notes" copy
  // instead of generic filler.
  const { title, body } = resolveUpdateCopy({ target, shownItems, copy: u })

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <BrandMark className="size-16" />

        <IcDialogTitle className="text-center text-xl">{title}</IcDialogTitle>
        <IcDialogDescription className="text-center text-sm">{body}</IcDialogDescription>
      </div>

      <div className="grid gap-3">
        {groups.map(group => (
          <div key={group.id}>
            <p className="text-[0.625rem] font-semibold uppercase tracking-wide text-(--ic-text-2)">{group.label}</p>
            <ul className="mt-1.5 grid gap-1.5 text-xs text-(--ic-text-1)">
              {group.items.map(item => (
                <li className="flex items-start gap-2" key={item}>
                  <span
                    aria-hidden
                    className="mt-1.5 inline-block size-1 shrink-0 rounded-(--ic-radius-pill) bg-(--ic-accent)"
                  />
                  <span className="leading-snug">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="grid gap-2">
        {installHidden ? null : target === 'backend' ? (
          <CompatUpdateButton label={u.updateNow} onInstall={onInstall} />
        ) : (
          <IcButton className="font-semibold" onClick={onInstall} size="lg">
            {u.updateNow}
          </IcButton>
        )}
        <IcButton className="font-medium" onClick={onLater} type="button" variant="text">
          {u.maybeLater}
        </IcButton>
      </div>

      {remaining > 0 && <p className="text-center text-xs text-(--ic-text-2)">{u.moreChanges(remaining)}</p>}
    </div>
  )
}

function ManualView({ command, message, onDone }: { command: string | null; message?: string; onDone: () => void }) {
  const { t } = useI18n()
  const u = t.updates
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (!command) {
      return
    }

    void writeClipboardText(command).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    })
  }

  // No command (e.g. the Linux sandbox-blocked relaunch): render the explanatory
  // message + a Done button, not a copy-a-command box.
  if (!command) {
    return (
      <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <Terminal className="size-8 text-(--ic-accent)" />

          <IcDialogTitle className="text-center text-xl">{u.manualTitle}</IcDialogTitle>
          <IcDialogDescription className="text-center text-sm">{message || u.manualPickedUp}</IcDialogDescription>
        </div>

        <IcButton className="font-semibold" onClick={onDone} size="lg" variant="secondary">
          {u.done}
        </IcButton>
      </div>
    )
  }

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <Terminal className="size-8 text-(--ic-accent)" />

        <IcDialogTitle className="text-center text-xl">{u.manualTitle}</IcDialogTitle>
        <IcDialogDescription className="text-center text-sm">{u.manualBody}</IcDialogDescription>
      </div>

      <button
        className={cn(
          'group flex w-full items-center justify-between gap-3 rounded-(--ic-radius-sm) border px-4 py-3 text-left transition-colors',
          copied ? 'border-(--ic-border-strong)' : 'border-(--ic-border-subtle) hover:border-(--ic-border-strong)'
        )}
        onClick={handleCopy}
        type="button"
      >
        <code className="min-w-0 flex-1 truncate select-all font-mono text-sm text-(--ic-text-1)">
          <span className="select-none text-(--ic-text-2)">$ </span>
          {command}
        </code>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 text-xs font-medium transition-colors',
            copied ? 'text-(--ic-accent)' : 'text-(--ic-text-2) group-hover:text-(--ic-text-1)'
          )}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? u.copied : u.copy}
        </span>
      </button>

      <p className="text-center text-xs text-(--ic-text-2)">{u.manualPickedUp}</p>

      <IcButton className="font-semibold" onClick={onDone} size="lg" variant="secondary">
        {u.done}
      </IcButton>
    </div>
  )
}

// Linux GUI/backend skew (#45205): backend updated, but the running desktop app
// package (AppImage/.deb/.rpm) was NOT changed. Closeable terminal state that
// tells the user to update/reinstall the desktop app — never claims the GUI was
// updated.
function GuiSkewView({ message, onDone }: { message?: string; onDone: () => void }) {
  const { t } = useI18n()
  const u = t.updates

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <AlertCircle className="size-8 text-(--ic-warning)" />

        <IcDialogTitle className="text-center text-xl">{u.guiSkewTitle}</IcDialogTitle>
        <IcDialogDescription className="max-w-prose text-center text-sm leading-5 text-(--ic-text-2)">
          {message || u.guiSkewBody}
        </IcDialogDescription>
      </div>

      <IcButton className="font-semibold" onClick={onDone} size="lg" variant="secondary">
        {u.done}
      </IcButton>
    </div>
  )
}

function ApplyingView({ apply, isBackend }: { apply: UpdateApplyState; isBackend: boolean }) {
  const { t } = useI18n()
  const u = t.updates
  const label = u.stages[apply.stage as DesktopUpdateStage] ?? u.stages.idle
  const body = isBackend ? u.applyingBodyBackend : u.applyingBody
  const currentMessage = apply.message.trim()
  const recentLog = apply.log.slice(-4)

  const percent =
    typeof apply.percent === 'number' && Number.isFinite(apply.percent)
      ? Math.max(2, Math.min(100, Math.round(apply.percent)))
      : null

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7">
      <div className="flex flex-col items-center gap-3 text-center">
        <IcSpinner className="size-16" label={label} type="lemniscate-bloom" />

        <IcDialogTitle className="text-center text-xl">{label}</IcDialogTitle>
        <IcDialogDescription className="text-center text-sm">{body}</IcDialogDescription>

        {currentMessage ? (
          <p className="max-w-lg break-words text-center text-xs leading-5 text-(--ic-text-2)">{currentMessage}</p>
        ) : null}
      </div>

      <IcProgress
        aria-label={label}
        indeterminate={percent === null}
        size="lg"
        value={percent === null ? 0 : percent / 100}
      />

      {recentLog.length > 1 ? (
        <div className="max-h-24 overflow-hidden rounded-(--ic-radius-sm) border border-(--ic-border-subtle) bg-(--ic-surface-sunken) px-3 py-2 text-left font-mono text-[11px] leading-4 text-(--ic-text-2)">
          {recentLog.map((entry, index) => (
            <div className="truncate" key={`${entry.at}-${index}`}>
              {entry.message}
            </div>
          ))}
        </div>
      ) : null}

      <p className="text-center text-xs text-(--ic-text-2)">{u.applyingClose}</p>
    </div>
  )
}

const BLOCKER_COMMAND_LINE_LIMIT = 500

const SENSITIVE_ARGUMENT_NAME =
  '(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|x[-_]?plex[-_]?token|token|password|passwd|client[-_]?secret|secret|authorization)'

const SENSITIVE_COMMAND_TAIL = new RegExp(
  `((?:^|\\s)(?:(?:--?)${SENSITIVE_ARGUMENT_NAME}(?:\\s*=\\s*|\\s+)|${SENSITIVE_ARGUMENT_NAME}\\s*(?:=|:)\\s*)).*$`,
  'i'
)

const SENSITIVE_QUERY_ARGUMENT = new RegExp(`([?&]${SENSITIVE_ARGUMENT_NAME}=)[^&#\\s]+`, 'gi')

export function formatBlockerCommandLine(commandLine: string): string {
  const redacted = commandLine
    .replace(SENSITIVE_QUERY_ARGUMENT, '$1[REDACTED]')
    .replace(SENSITIVE_COMMAND_TAIL, '$1[REDACTED]')

  const characters = Array.from(redacted)

  return characters.length > BLOCKER_COMMAND_LINE_LIMIT
    ? `${characters.slice(0, BLOCKER_COMMAND_LINE_LIMIT - 1).join('')}…`
    : redacted
}

export function BlockerView({
  blockers,
  onDismiss,
  onStopAndUpdate
}: {
  blockers: readonly DesktopUpdateBlocker[]
  onDismiss: () => void
  onStopAndUpdate: () => void
}) {
  const { t } = useI18n()
  const u = t.updates

  const safeBlockers = blockers.filter(blocker => blocker.kind === 'local-preview' && blocker.safeToStop)
  const hasForeignBlockers = safeBlockers.length !== blockers.length
  const title = hasForeignBlockers ? u.foreignBlockerTitle : u.blockerTitle

  const body = hasForeignBlockers
    ? safeBlockers.length > 0
      ? u.mixedBlockerBody
      : u.foreignBlockerBody
    : u.blockerBody

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="grid size-12 place-items-center rounded-(--ic-radius-pill) bg-[color-mix(in_srgb,var(--ic-warning)_var(--ic-a14),transparent)] text-(--ic-warning)">
          <AlertCircle aria-hidden className="size-6" />
        </div>
        <IcDialogTitle className="text-center text-xl font-semibold tracking-tight">{title}</IcDialogTitle>
        <IcDialogDescription className="max-w-prose text-center text-sm leading-5 text-(--ic-text-2)">
          {body}
        </IcDialogDescription>
      </div>

      <div className="grid gap-2">
        {blockers.map(blocker => {
          const isSafePreview = blocker.kind === 'local-preview' && blocker.safeToStop

          return (
            <div
              className="rounded-(--ic-radius-md) border border-(--ic-border-subtle) bg-(--ic-surface-sunken) px-3 py-2.5"
              key={blocker.pid}
            >
              <div className="text-sm font-medium">
                {isSafePreview ? blocker.label || u.localPreview : blocker.name}
              </div>
              <div className="text-xs text-(--ic-text-2)">
                {isSafePreview && blocker.port ? u.portLabel(blocker.port) : u.pidLabel(blocker.pid)}
              </div>
            </div>
          )
        })}
      </div>

      <details className="rounded-(--ic-radius-sm) border border-(--ic-border-subtle) px-3 py-2 text-xs text-(--ic-text-2)">
        <summary className="cursor-pointer select-none font-medium">{u.technicalDetails}</summary>
        <div className="mt-2 grid gap-2 font-mono text-[11px] leading-4">
          {blockers.map(blocker => (
            <div className="break-all" key={blocker.pid}>
              PID {blocker.pid} · {formatBlockerCommandLine(blocker.cmdline)}
            </div>
          ))}
        </div>
      </details>

      <div className="grid gap-1">
        {safeBlockers.length > 0 ? (
          <IcButton className="font-semibold" onClick={onStopAndUpdate} size="lg">
            {hasForeignBlockers ? u.closePreviewsAndCheckAgain : u.closePreviewsAndUpdate}
          </IcButton>
        ) : null}
        <IcButton onClick={onDismiss} variant="text">
          {u.notNow}
        </IcButton>
      </div>
    </div>
  )
}

function ErrorView({ message, onDismiss, onRetry }: { message: string; onDismiss: () => void; onRetry: () => void }) {
  const { t } = useI18n()
  const u = t.updates

  return (
    <IcState
      className="px-6 pb-6 pt-7 pr-8"
      description={
        <IcDialogDescription className="max-w-prose text-center text-sm leading-5 text-(--ic-text-2)">
          {message || u.errorBody}
        </IcDialogDescription>
      }
      title={<IcDialogTitle className="text-center text-xl font-semibold tracking-tight">{u.errorTitle}</IcDialogTitle>}
    >
      <IcButton className="font-semibold" onClick={onRetry} size="lg">
        {u.tryAgain}
      </IcButton>
      <IcButton onClick={onDismiss} variant="text">
        {u.notNow}
      </IcButton>
    </IcState>
  )
}

function CenteredStatus({
  action,
  body,
  icon,
  title
}: {
  action?: React.ReactNode
  body?: string
  icon: React.ReactNode
  title: string
}) {
  return (
    <div className="grid gap-4 px-6 pb-6 pt-8 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        {icon}

        <IcDialogTitle className="text-center text-lg">{title}</IcDialogTitle>
        {body && <IcDialogDescription className="text-center text-sm">{body}</IcDialogDescription>}
      </div>

      {action && <div className="flex justify-center">{action}</div>}
    </div>
  )
}
