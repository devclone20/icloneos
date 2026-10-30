/** Track A of the App Atualisation pane: the Hermes runtime beneath the app. */

import { useStore } from '@nanostores/react'
import { memo, type ReactNode, useCallback, useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { displayPath } from '@/lib/display-path'
import { Cpu, Loader2, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $clock,
  $runtimeError,
  $runtimeLoading,
  $runtimeStatus,
  loadRuntimeStatus,
  updaterTargetsRuntime
} from '@/store/iclone-updates'
import {
  $desktopVersion,
  $updateApply,
  $updateChecking,
  $updatePolicy,
  $updateStatus,
  $upstreamCompare,
  $upstreamComparing,
  checkUpdates,
  compareWithUpstream,
  isCuratedPolicy
} from '@/store/updates'
import type { IcloneBackupZip, IcloneRuntimeStatus, IcloneUpdateReceipt } from '@/types/iclone-updates'

import { type UpdatesCopy, useUpdatesCopy } from '../machine/updates-copy'
import { SettingsSection } from '../primitives'
import { SettingRow } from '../setting-row'

import { agentVerdictWords, useAgentUpdateCopy } from './agent-model'
import { developerHowItUpdates } from './intro'
import {
  Aside,
  Code,
  count,
  formatDate,
  formatDownloadSize,
  MINUTE,
  type RuntimeSummary,
  shortSha,
  StatusCard,
  timeAgo
} from './parts'
import { useAgentVerdict } from './use-agent-verdict'

// ── Track A: the runtime ───────────────────────────────────────────────────

function receiptLine(receipt: IcloneUpdateReceipt): string {
  const from = receipt.pre.version ?? shortSha(receipt.pre.sha)
  const to = receipt.post.version ?? shortSha(receipt.post.sha)
  const moved = receipt.pre.sha && receipt.pre.sha === receipt.post.sha ? `already at ${to}` : `${from} → ${to}`

  return [
    formatDate(receipt.finishedAt ?? receipt.startedAt, MINUTE),
    receipt.viaDesktop ? 'in-app Update now' : 'terminal',
    moved,
    receipt.outcome
  ].join(' · ')
}

/** The zip is this run's only when it was written while the run was going. */
function zipOfReceipt(receipt: IcloneUpdateReceipt, zip: IcloneBackupZip | null): IcloneBackupZip | null {
  const at = Date.parse(zip?.at ?? '')
  const started = Date.parse(receipt.startedAt)
  const finished = Date.parse(receipt.finishedAt ?? '') || Date.now()

  return zip && at >= started - 60_000 && at <= finished + 60_000 ? zip : null
}

function backupLine(receipt: IcloneUpdateReceipt | null, zip: IcloneBackupZip | null): { text: string; warn: boolean } {
  const backup = receipt?.backup

  if (!receipt || !backup) {
    return { text: 'The last receipt does not record a pre-update backup.', warn: Boolean(receipt) }
  }

  if (backup.kind === 'skip') {
    return { text: `Switched off for the last update: ${backup.detail || 'no reason recorded'}.`, warn: true }
  }

  if (!backup.ok) {
    return { text: `The last update took no pre-update backup (“${backup.detail || 'no detail'}”).`, warn: true }
  }

  const snapshot = backup.detail.replace(/^snapshot=/, '')
  const own = zipOfReceipt(receipt, zip)

  return {
    text: own
      ? `Full backup before the last update: state snapshot ${snapshot} + ${own.name} (${formatDownloadSize(own.bytes)}).`
      : `State snapshot ${snapshot} before the last update.`,
    warn: false
  }
}

function runtimeSummary(
  runtime: IcloneRuntimeStatus | null,
  loading: boolean,
  error: null | string,
  u: UpdatesCopy
): RuntimeSummary {
  if (!runtime) {
    return loading
      ? { detail: u.readingHint, title: u.readingTitle, tone: 'idle' }
      : { detail: error ?? u.noAnswer, title: u.agentFactsUnavailable, tone: 'error' }
  }

  if (!runtime.available || !runtime.head) {
    return { detail: runtime.reason ?? displayPath(runtime.runtimeRoot), title: u.agentUnavailable, tone: 'error' }
  }

  const head = runtime.head

  return {
    detail: [
      head.short,
      runtime.branch ?? 'detached',
      formatDate(head.date),
      runtime.shallow === null ? null : runtime.shallow ? 'shallow clone' : 'full clone',
      runtime.dirty === null ? null : runtime.dirty ? 'local changes' : 'clean'
    ]
      .filter(Boolean)
      .join(' · '),
    title: runtime.version ? `Hermes runtime v${runtime.version}` : 'Hermes runtime — version unknown',
    tone: runtime.dirty ? 'warn' : 'idle'
  }
}

export const RuntimeTrack = memo(function RuntimeTrack({ upstreamBase }: { upstreamBase?: string }) {
  const u = useUpdatesCopy()
  const { copy: agentCopy } = useAgentUpdateCopy()
  const { verdict } = useAgentVerdict()
  const policyInfo = useStore($updatePolicy)
  const upstream = useStore($upstreamCompare)
  const comparing = useStore($upstreamComparing)
  const curated = isCuratedPolicy(policyInfo)
  const runtime = useStore($runtimeStatus)
  const runtimeLoading = useStore($runtimeLoading)
  const runtimeError = useStore($runtimeError)
  const status = useStore($updateStatus)
  const version = useStore($desktopVersion)
  const apply = useStore($updateApply)
  const checking = useStore($updateChecking)
  const now = useStore($clock)

  const targetsRuntime = updaterTargetsRuntime(runtime, version)
  const applying = apply.applying || apply.stage === 'restart'
  // R1: the app's own status is the bundled pin; "behind" only ever comes from an explicit developer compare.
  const behind = curated ? 0 : upstream?.behind
  const updateAvailable = curated ? false : (behind ?? 0) > 0 || Boolean(upstream?.updateAvailable)
  const pinSha = status?.pinSha ?? policyInfo?.pin.sha ?? null
  const pinDate = status?.pinDate ?? policyInfo?.pin.date ?? ''
  const pin7 = pinSha ? pinSha.slice(0, 7) : 'unknown'
  const notAligned = status?.pinned === true && status.aligned === false
  const head = runtime?.head ?? null
  // $updateStatus comes from the poller; after a terminal update it can describe a HEAD that is gone.
  const statusPredatesHead = Boolean(status?.currentSha && head && status.currentSha !== head.sha)

  const canUpdate =
    targetsRuntime &&
    !statusPredatesHead &&
    status?.supported !== false &&
    !status?.error &&
    (curated ? notAligned : updateAvailable) &&
    !applying

  // A count for a HEAD that is gone would offer a no-op update; ask origin again.
  useEffect(() => {
    if (statusPredatesHead && targetsRuntime) {
      void checkUpdates()
    }
  }, [statusPredatesHead, targetsRuntime])

  const check = useCallback(() => {
    void loadRuntimeStatus()

    if (targetsRuntime) {
      void checkUpdates()
    }
  }, [targetsRuntime])

  const dirty = runtime?.dirty === true
  const branch = status?.branch ?? 'main'

  const summary = runtimeSummary(runtime, runtimeLoading, runtimeError, u)

  const devRun = runtime !== null && !targetsRuntime
  let originLine: string

  if (devRun) {
    originLine =
      'Dev run — the runtime here is not the installed agent; update the agent in Settings › Updates › Agent.'
  } else if (applying) {
    originLine = 'Updating — follow it in the updater window.'
  } else if (curated && status?.pinned) {
    originLine =
      `Pinned at ${pin7} (${pinDate}) · ` +
      (status.aligned === true ? 'aligned' : status.aligned === false ? 'not aligned' : 'alignment unknown')
  } else if (!curated && !upstream) {
    originLine = status?.pinned
      ? `Pinned at ${pin7} (${pinDate}) · ${status.aligned ? 'aligned' : 'not aligned'} — not compared with upstream.`
      : 'Not compared with upstream yet.'
  } else if (!status) {
    originLine = 'Not checked yet.'
  } else if (status.supported === false) {
    originLine = status.message ?? 'The desktop updater cannot update this install.'
  } else if (!curated && upstream?.error) {
    originLine = `Could not reach upstream${upstream.message ? `: ${upstream.message}` : '.'}`
  } else if ((behind ?? 0) > 0) {
    originLine = `${count(behind ?? 0)} commits behind upstream ${upstream?.branch ?? 'main'}.`
  } else if (updateAvailable) {
    originLine = 'An update is waiting; the exact count is unknown.'
  } else {
    originLine = `On the latest upstream ${upstream?.branch ?? 'main'}.`
  }

  const originDetail: ReactNode = devRun ? (
    <>
      The desktop’s own updater points at the fork checkout ({displayPath(version?.hermesRoot ?? runtime?.updaterRoot)}
      ), not at the runtime — it would run <Code>hermes update</Code> inside the source tree. The runtime moves only to
      the pin a release ships ({pin7}); never run a bare <Code>hermes update</Code> against it — that pulls upstream
      main.
    </>
  ) : (
    `Checked ${timeAgo((curated ? status : (upstream ?? status))?.fetchedAt, now)}${statusPredatesHead ? ` — before the runtime moved to ${head?.short}; checking again` : ''}.`
  )

  const receipt = runtime?.receipt ?? null
  const backup = backupLine(receipt, runtime?.backupZip ?? null)
  const clones = runtime?.rollbackClones ?? []

  return (
    <SettingsSection
      aside={runtime ? <Aside>read {timeAgo(runtime.readAt, now)}</Aside> : undefined}
      icon={Cpu}
      meta="Track A"
      title={u.runtimeTitle}
    >
      <StatusCard
        actions={
          <>
            <Button disabled={checking || runtimeLoading || applying} onClick={check} size="sm" variant="textStrong">
              {checking || runtimeLoading ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              {checking ? u.checking : u.checkNow}
            </Button>
            {!curated && (
              <Button
                disabled={comparing || applying}
                onClick={() => void compareWithUpstream()}
                size="sm"
                variant="textStrong"
              >
                {comparing ? <Loader2 className="size-3 animate-spin" /> : null}
                {u.compare}
              </Button>
            )}
            {curated && status?.aligned === true && (
              <Button disabled size="sm" variant="textStrong">
                {u.aligned}
              </Button>
            )}
          </>
        }
        busy={!runtime && runtimeLoading}
        detail={summary.detail}
        title={summary.title}
        tone={canUpdate ? 'available' : summary.tone}
      >
        {/* Until the runtime answers, $updateStatus may describe the fork checkout, not the runtime. */}
        {runtime && (
          <div className="mt-2 border-t border-(--ui-stroke-tertiary) pt-2">
            <p className="text-foreground">{originLine}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{originDetail}</p>
            {runtimeError && (
              <p className="mt-0.5 text-xs text-muted-foreground">Last re-read failed: {runtimeError}</p>
            )}
          </div>
        )}
      </StatusCard>

      <SettingRow
        detail={receipt && receipt.flags.length > 0 ? `hermes update ${receipt.flags.join(' ')}` : undefined}
        hint={receipt ? receiptLine(receipt) : 'No update receipt under ~/.hermes/logs/update_receipts yet.'}
        title={u.lastUpdateTitle}
        wide
      />

      <SettingRow
        detail={
          clones.length > 0 ? `Rollback clones: ${clones.join(' · ')}` : 'No rollback clone in ~/.hermes-update-backups'
        }
        hint={
          <>
            <span className={cn(backup.warn && 'text-amber-600 dark:text-amber-400')}>{backup.text}</span> In-app
            updates take whatever <Code>updates.pre_update_backup</Code> says; from a terminal always pass{' '}
            <Code>--backup</Code>.
          </>
        }
        title={u.backupTitle}
        wide
      />

      {curated && pinSha && head && (
        <SettingRow
          hint={
            pinSha.startsWith(head.sha) || head.sha.startsWith(pinSha)
              ? u.runtimeIsPin(pin7, pinDate, agentVerdictWords(verdict, agentCopy))
              : u.runtimeOffPin(pin7, pinDate, head.short)
          }
          title={u.rendererTitle}
          wide
        />
      )}
      {!curated && upstreamBase && head && (
        <SettingRow
          hint={
            head.sha.startsWith(upstreamBase)
              ? `The renderer and the runtime come from the same upstream point (${upstreamBase}).`
              : `This desktop was built from upstream ${upstreamBase}; the runtime beneath it is at ${head.short}` +
                ` (${runtime?.version ? `v${runtime.version}, ` : ''}${formatDate(head.date)}). The GUI has not been` +
                ' rebuilt for the runtime it runs on — closing that gap is Track B.'
          }
          title={u.rendererTitle}
          wide
        />
      )}

      {curated ? (
        <SettingRow
          hint={
            `iclone os ships the Hermes runtime it was verified against (pin ${pin7}, ${pinDate}) and never contacts ` +
            'NousResearch on its own. The first launch after an app update offers to align the runtime to that pin; ' +
            'Hermes’s own update check is off. New runtimes arrive only with a new iclone os release.'
          }
          title={u.howTitle}
          wide
        />
      ) : (
        <SettingRow
          detail={`Runtime pin ${pin7}${pinDate ? ` · ${pinDate}` : ''}`}
          hint={developerHowItUpdates(policyInfo)}
          title={u.howTitle}
          wide
        />
      )}
    </SettingsSection>
  )
})
