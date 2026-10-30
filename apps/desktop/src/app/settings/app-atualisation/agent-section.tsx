/**
 * Settings › Updates › Agent — every user sees it. Before the user's first click it says it has not
 * checked; one click asks Nous Research once (through main); Update opens a sheet that says exactly
 * what happens. The sheet's confirm buttons carry `data-it-noclick`: the `it` CLI (and so the agent)
 * can open this pane but never press them. On Windows the sheet only explains the terminal path.
 */
import { useStore } from '@nanostores/react'
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import type { AgentUpdateCopy } from '@/i18n/en'
import type { Locale } from '@/i18n/types'
import { AGENT_UPDATE_DOOR_OPEN } from '@/iclone-shared/update-status'
import { Loader2, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $agentCompatFlag,
  $agentUpdate,
  agentUpdateNeedsReview,
  agentUpdateTargetSha,
  applyAgentUpdate,
  checkAgentUpdate,
  loadLastAgentCheck,
  refusalFor,
  restoreOffered,
  restoreVerifiedAgent,
  watchAgentCompatFlag
} from '@/store/agent-update'
import { $compatStatus, $compatVerdict } from '@/store/iclone-compat'
import { $runtimeStatus, loadRuntimeStatus } from '@/store/iclone-updates'
import { $desktopVersion, $updatePolicy } from '@/store/updates'
import type {
  IcloneAgentInstalled,
  IcloneAgentLastUpdate,
  IcloneAgentUpdateCheck,
  IcloneCompatVerdictName
} from '@/types/iclone-updates'

import { useUpdatesCopy } from '../machine/updates-copy'
import { SettingRow } from '../setting-row'

import {
  agentVerdict,
  agentVerdictWords,
  backupStamp,
  checkedAgoLabel,
  dayLabel,
  latestVersionLabel,
  momentLabel,
  shortSha,
  useAgentUpdateCopy,
  verifiedVersion,
  versionLabel
} from './agent-model'
import { ReviewHoldButton, reviewLevel, reviewNames } from './review-hold'
import { useAgentVerdict } from './use-agent-verdict'

const CAPTION =
  'text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)'

const FINDINGS_SHOWN = 6

const VALUE = 'text-[length:var(--conversation-text-font-size)] text-(--ui-text-primary) tabular-nums'

const DOT: Record<IcloneCompatVerdictName | 'verified', string> = {
  AMBER: 'bg-amber-400',
  GREEN: 'bg-emerald-400',
  RED: 'bg-red-400',
  UNKNOWN: 'bg-(--ui-text-tertiary)',
  verified: 'bg-emerald-400'
}

function isWindows(): boolean {
  return typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent)
}

function Pill({ children, tone }: { children: ReactNode; tone: keyof typeof DOT }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-(--ui-stroke-tertiary) px-2 py-0.5 text-[0.7rem] leading-none text-(--ui-text-secondary)"
      data-agent-pill={tone}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', DOT[tone])} />
      {children}
    </span>
  )
}

function Facts({ items }: { items: (null | string | undefined)[] }) {
  const shown = items.filter((item): item is string => Boolean(item))

  return (
    <span className={cn(VALUE, 'font-mono')}>
      {shown.map((item, index) => (
        <span key={item}>
          {index > 0 && <span className="px-1.5 text-(--ui-text-tertiary)">·</span>}
          {item}
        </span>
      ))}
    </span>
  )
}

function Row({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid gap-1 py-3.5 @xl:grid-cols-[minmax(10rem,13rem)_minmax(0,1fr)] @xl:gap-6">
      <dt className={CAPTION}>{label}</dt>
      <dd className="flex min-w-0 flex-col gap-1.5">{children}</dd>
    </div>
  )
}

function InstalledRow({
  check,
  copy,
  flagged,
  installed,
  locale,
  unmanaged
}: {
  check: IcloneAgentUpdateCheck | null
  copy: AgentUpdateCopy
  flagged: boolean
  installed: IcloneAgentInstalled | null
  locale: Locale
  /** V3-S r4 (ruling 36): a dev-backend checkout runs, not the app's own runtime. */
  unmanaged: boolean
}) {
  const unmanagedPill = unmanaged ? <Pill tone="AMBER">{copy.unmanagedRuntime}</Pill> : null

  if (!installed) {
    return (
      <Row label={copy.installed}>
        <span className={CAPTION}>{copy.unknown}</span>
        {unmanagedPill}
      </Row>
    )
  }

  const verdict = check?.compat?.verdict ?? 'UNKNOWN'
  const pinned = agentVerdict(installed, flagged)

  return (
    <Row label={copy.installed}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Facts items={[versionLabel(installed.version), shortSha(installed.sha), dayLabel(installed.date, locale)]} />
        {pinned === 'verified' ? (
          <Pill tone="verified">{agentVerdictWords(pinned, copy)}</Pill>
        ) : pinned === 'verified-but-flagged' ? (
          <Pill tone="RED">{agentVerdictWords(pinned, copy)}</Pill>
        ) : (
          <Pill tone={verdict}>
            {copy.newer}
            {check?.compat ? ` · ${copy.compatibility(copy.compatibilityWords[verdict])}` : ''}
          </Pill>
        )}
        {unmanagedPill}
      </div>
      {installed.dirty === true && <span className={CAPTION}>{copy.localChanges}</span>}
    </Row>
  )
}

function checkProblem(check: IcloneAgentUpdateCheck | null, fault: null | string, copy: AgentUpdateCopy) {
  if (fault === 'bridge') {
    return copy.noBridge
  }

  if (fault === 'failed') {
    return copy.failed
  }

  switch (check?.error) {
    case 'door-closed':
      return copy.doorClosed

    case 'offline':
      return copy.offline

    case 'unavailable':
      return copy.unavailable

    case 'no-runtime':
      return copy.noRuntime

    default:
      return null
  }
}

function LatestRow({
  check,
  copy,
  fault,
  locale
}: {
  check: IcloneAgentUpdateCheck | null
  copy: AgentUpdateCopy
  fault: null | string
  locale: Locale
}) {
  const problem = checkProblem(check, fault, copy)
  const latest = check?.latest ?? null
  const ago = check ? checkedAgoLabel(check.checkedAt, copy) : null

  return (
    <Row label={copy.latest}>
      {problem ? (
        <span className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)" role="alert">
          {problem}
        </span>
      ) : !latest ? (
        <span className={CAPTION} data-agent-not-checked>
          {copy.notChecked}
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Facts items={[latestVersionLabel(latest), shortSha(latest.sha), dayLabel(latest.date, locale)]} />
          <span className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)">
            {!check?.updateAvailable
              ? copy.upToDate
              : latest.commitsNewer === null
                ? copy.countUnavailable
                : copy.commitsNewer(latest.commitsNewer)}
          </span>
        </div>
      )}
      {(latest?.releaseTag || ago) && (
        <span className={CAPTION}>
          {[latest?.releaseTag ? copy.releaseTag(latest.releaseTag) : null, ago].filter(Boolean).join(' · ')}
        </span>
      )}
    </Row>
  )
}

function ReceiptCard({ copy, last, locale }: { copy: AgentUpdateCopy; last: IcloneAgentLastUpdate; locale: Locale }) {
  const u = useUpdatesCopy()
  const from = versionLabel(last.from.version) ?? shortSha(last.from.sha) ?? copy.unknown
  const to = versionLabel(last.to.version) ?? shortSha(last.to.sha) ?? copy.unknown
  const zip = last.backupZip
  const seconds = last.durationMs === null ? null : Math.max(1, Math.round(last.durationMs / 1000))

  return (
    <figure
      aria-label={copy.lastUpdate}
      className="mt-6 rounded-xl border border-(--ui-stroke-tertiary) px-4 py-3.5"
      data-agent-receipt={last.outcome}
    >
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={cn(CAPTION, 'tracking-[0.08em] uppercase')}>{copy.lastUpdate}</span>
        <span className={CAPTION}>
          {[dayLabel(last.at, locale), seconds && copy.tookSeconds(seconds)].filter(Boolean).join(' · ')}
        </span>
      </figcaption>
      <p className={cn(VALUE, 'mt-2 font-mono')}>
        {from} <span className="text-(--ui-text-tertiary)">→</span> {to}
        <span className="ps-3 font-sans text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)">
          {copy.outcomes[last.outcome]}
        </span>
      </p>
      <SettingRow
        control={
          zip &&
          window.hermesDesktop?.revealPath && (
            <Button onClick={() => void window.hermesDesktop?.revealPath?.(zip)} size="sm" variant="text">
              {copy.reveal}
            </Button>
          )
        }
        hint={zip ? copy.backup(backupStamp(zip)) : copy.noBackup}
        title={u.receiptTitle}
      />
    </figure>
  )
}

interface SheetProps {
  /** A control of its own in place of `confirm` (the compatibility review's hold). */
  action?: ReactNode
  body: ReactNode
  cancel: string
  /** Absent: the sheet only informs, and `cancel` closes it. */
  confirm?: string
  /** The Update confirm only: the preload mints the gesture token for a trusted click inside this marker. */
  gestureMarked?: boolean
  onCancel: () => void
  onConfirm?: () => void
  title: string
}

function ConfirmSheet({
  action,
  body,
  cancel,
  confirm,
  gestureMarked = false,
  onCancel,
  onConfirm,
  title
}: SheetProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => ref.current?.focus(), [])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <div
      aria-labelledby="agent-update-sheet-title"
      className="mt-4 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-5 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
      onKeyDown={onKeyDown}
      ref={ref}
      role="alertdialog"
      tabIndex={-1}
    >
      <h3
        className="text-[length:var(--conversation-text-font-size)] font-medium text-(--ui-text-primary)"
        id="agent-update-sheet-title"
      >
        {title}
      </h3>
      <div className="mt-2">{body}</div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel} size="sm" variant="ghost">
          {cancel}
        </Button>
        {/* The human's click: `it click` refuses anything inside [data-it-noclick]. */}
        {confirm && onConfirm && (
          <Button
            data-agent-update-confirm={gestureMarked ? '' : undefined}
            data-it-noclick
            onClick={onConfirm}
            size="sm"
          >
            {confirm}
          </Button>
        )}
        {action}
      </div>
    </div>
  )
}

function UpdateSteps({ copy }: { copy: AgentUpdateCopy }) {
  const steps = [copy.confirmBackup, copy.confirmClose, copy.confirmFetch, copy.confirmReopen]

  return (
    <ol className="space-y-1.5">
      {steps.map((step, index) => (
        <li
          className="flex gap-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)"
          key={step}
        >
          <span aria-hidden className="w-3 shrink-0 font-mono text-(--ui-text-tertiary) tabular-nums">
            {index + 1}
          </span>
          {step}
        </li>
      ))}
    </ol>
  )
}

export function AgentUpdateSection() {
  const u = useUpdatesCopy()
  const { copy, locale } = useAgentUpdateCopy()
  const { t } = useI18n()
  const windows = isWindows()
  const state = useStore($agentUpdate)
  const runtime = useStore($runtimeStatus)
  const version = useStore($desktopVersion)
  const policy = useStore($updatePolicy)
  const compatFlag = useStore($agentCompatFlag)
  const { installed, verdict } = useAgentVerdict()
  // The verdict main's gate reads (pending.json) and the gate's last refusal of the owner, both from main.
  const pending = useStore($compatVerdict)
  const refusal = useStore($compatStatus)?.lastRefusal ?? null
  const [sheet, setSheet] = useState<'restore' | 'review' | 'update' | null>(null)

  // Local reads only (the previous click's answer, git HEAD, receipts) — the network is asked on click.
  useEffect(() => {
    // K-RT3: with the door closed there is no upstream answer to show (a 0.0.2 check would name an update that cannot
    // be installed).
    if (AGENT_UPDATE_DOOR_OPEN) {
      void loadLastAgentCheck()
    }

    void loadRuntimeStatus()

    return watchAgentCompatFlag()
  }, [])

  const check = state.check
  const doorOpen = AGENT_UPDATE_DOOR_OPEN
  const target = doorOpen ? agentUpdateTargetSha(state) : null
  // Never a sha on the button: without a version the update is named for what it is.
  const latestLabel = latestVersionLabel(check?.latest)
  const checking = state.phase === 'checking'
  const applying = state.phase === 'applying'
  const verified = verifiedVersion(check, policy)
  const lastUpdate = runtime?.lastUpdate ?? null
  const needsReview = agentUpdateNeedsReview(state, refusal)
  const pendingTo = pending?.runtime?.to ?? ''
  // The ack binds to the verdict the gate holds, and that verdict must be for the rev this button installs.
  const reviewVerdict = pending && target && pendingTo.length >= 7 && target.startsWith(pendingTo) ? pending : null
  const reviewLevelNow = reviewLevel(reviewVerdict?.level)
  const reviewFindings = reviewNames(reviewVerdict)

  const refusalLine =
    refusal && refusalFor(refusal, target) ? copy.lastRefusal(momentLabel(refusal.at, locale) ?? refusal.at) : null

  const reviewTitle = latestLabel ? copy.reviewTitle(latestLabel) : copy.reviewTitleLatest

  const confirmUpdate = () => {
    if (target) {
      // Synchronous on purpose: the gesture token is minted inside this click.
      void applyAgentUpdate(target)
      setSheet(null)
    }
  }

  const confirmRestore = () => {
    setSheet(null)
    restoreVerifiedAgent(windows)
  }

  return (
    <section
      aria-labelledby="agent-update-title"
      className="@container mb-8"
      data-agent-update-phase={state.phase}
      data-settings-section="agent-update"
    >
      <h2
        className="text-[length:var(--conversation-font-size)] font-medium text-(--ui-text-primary)"
        id="agent-update-title"
      >
        {copy.title}
      </h2>
      <p className={cn(CAPTION, 'mt-1 max-w-prose')}>{copy.intro}</p>

      {compatFlag?.red && verdict !== 'unknown' && (
        <p
          className="mt-4 rounded-lg border border-red-400/30 px-3 py-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)"
          role="alert"
        >
          {verdict === 'verified-but-flagged' ? copy.compatFlagged : copy.compatRed}
        </p>
      )}

      <dl className="mt-4 divide-y divide-(--ui-stroke-tertiary) border-y border-(--ui-stroke-tertiary)">
        <InstalledRow
          check={check}
          copy={copy}
          flagged={verdict === 'verified-but-flagged'}
          installed={installed}
          locale={locale}
          unmanaged={runtime?.unmanaged === true}
        />
        <LatestRow check={check} copy={copy} fault={state.fault} locale={locale} />
      </dl>

      <SettingRow
        control={
          <div className="flex flex-wrap items-center gap-3">
            <Button
              data-agent-update-action="check"
              disabled={!doorOpen || checking || applying}
              onClick={() => void checkAgentUpdate()}
              size="sm"
              variant="outline"
            >
              {checking ? (
                <Loader2 className="size-3.5 motion-safe:animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {checking ? copy.checking : copy.check}
            </Button>
            {target && (
              <Button
                data-agent-update-action={needsReview ? 'review' : 'update'}
                disabled={applying || sheet !== null}
                onClick={() => setSheet(needsReview ? 'review' : 'update')}
                size="sm"
              >
                {applying && <Loader2 className="size-3.5 motion-safe:animate-spin" />}
                {needsReview ? copy.reviewCompat : latestLabel ? copy.update(latestLabel) : copy.updateLatest}
              </Button>
            )}
          </div>
        }
        hint={
          <span aria-live="polite" data-agent-refusal={!applying && !state.applyError && refusalLine ? '' : undefined}>
            {!doorOpen
              ? copy.doorClosed
              : applying
                ? copy.applying
                : state.applyError
                  ? copy.applyErrors[state.applyError.error]
                  : (refusalLine ?? '')}
          </span>
        }
        title={u.agentTitle}
        wide
      />

      {sheet === 'update' &&
        target &&
        (windows ? (
          // Main refuses the in-app update on Windows: the sheet explains the terminal path and only closes.
          <ConfirmSheet
            body={
              <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)">
                {copy.confirmWindows}
              </p>
            }
            cancel={t.common.close}
            onCancel={() => setSheet(null)}
            title={latestLabel ? copy.confirmTitle(latestLabel) : copy.confirmTitleLatest}
          />
        ) : (
          <ConfirmSheet
            body={<UpdateSteps copy={copy} />}
            cancel={copy.cancel}
            confirm={copy.confirmUpdate}
            gestureMarked
            onCancel={() => setSheet(null)}
            onConfirm={confirmUpdate}
            title={latestLabel ? copy.confirmTitle(latestLabel) : copy.confirmTitleLatest}
          />
        ))}

      {sheet === 'review' &&
        target &&
        (reviewVerdict ? (
          <ConfirmSheet
            action={
              <ReviewHoldButton
                copy={copy}
                describedBy="agent-review-body"
                onAccepted={() => setSheet('update')}
                verdict={reviewVerdict}
              />
            }
            body={
              <div className="space-y-2" data-agent-review={reviewLevelNow}>
                <p
                  className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)"
                  id="agent-review-body"
                >
                  {copy.reviewBody[reviewLevelNow]}
                </p>
                {reviewFindings.length > 0 && (
                  <p className="font-mono text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                    {reviewFindings.slice(0, FINDINGS_SHOWN).join(' · ')}
                    {reviewFindings.length > FINDINGS_SHOWN &&
                      ` ${copy.reviewMore(reviewFindings.length - FINDINGS_SHOWN)}`}
                  </p>
                )}
              </div>
            }
            cancel={copy.cancel}
            onCancel={() => setSheet(null)}
            title={reviewTitle}
          />
        ) : (
          // The gate holds no verdict for this rev (expired, or the app restarted since the check): check again.
          <ConfirmSheet
            body={
              <p
                className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)"
                data-agent-review="expired"
              >
                {copy.reviewRecheck}
              </p>
            }
            cancel={copy.cancel}
            confirm={copy.check}
            onCancel={() => setSheet(null)}
            onConfirm={() => {
              setSheet(null)
              void checkAgentUpdate()
            }}
            title={reviewTitle}
          />
        ))}

      {sheet === 'restore' && (
        <ConfirmSheet
          body={
            <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)">
              {copy.restoreBody}
            </p>
          }
          cancel={copy.cancel}
          confirm={copy.restoreConfirm}
          onCancel={() => setSheet(null)}
          onConfirm={confirmRestore}
          title={copy.restoreTitle(verified)}
        />
      )}

      {installed && !installed.verifiedWithRelease && verified && restoreOffered(policy, windows) && sheet === null && (
        <SettingRow
          control={
            <Button
              data-agent-update-action="restore"
              disabled={applying}
              onClick={() => setSheet('restore')}
              size="sm"
              variant="text"
            >
              {copy.restore(verified)}
            </Button>
          }
          title={copy.restoreTitle(verified)}
        />
      )}

      {lastUpdate && <ReceiptCard copy={copy} last={lastUpdate} locale={locale} />}
    </section>
  )
}
