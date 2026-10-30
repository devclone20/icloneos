/**
 * Settings → Updates, Developer section — both trees that update iclone os, shown only under
 * developer policy (dev runs, or the packaged typed-ack override). Users see app-update-pane.tsx.
 *
 * Track A is the Hermes runtime beneath the app (~/.hermes/hermes-agent). Under
 * curated policy it is the runtime this release pins and nothing contacts
 * upstream on its own; only developer policy keeps the raw `hermes update` door
 * (store/updates.ts). This pane adds what the updater does not show — the
 * version, the last receipt, the backups — from local reads only.
 *
 * Track B is the iclone os source. It never merges upstream: the adoption
 * scan ranks upstream commits into the Inbox, and what the owner adopts is
 * re-implemented here. iclone/UPSTREAM_BASE only names the import origin.
 * "Start …" hands the mission to Hermes in the Message window; the owner reads
 * it and presses Enter — the agent's turn starts on the owner's key.
 *
 * Compatibility is the engine's verdict (Electron main) on the app's runtime
 * contract; the gate that acts on it lives in main, never here.
 */

import { useStore } from '@nanostores/react'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'

import { NEW_CHAT_ROUTE } from '@/app/routes'
import { Button } from '@/components/ui/button'
import { GitFork, Loader2, RefreshCw } from '@/lib/icons'
import {
  $backlog,
  $compatLatest,
  $compatStatus,
  $compatVerdict,
  decideAdoption,
  loadBacklog
} from '@/store/iclone-compat'
import {
  $clock,
  $upstreamChecking,
  $upstreamStatus,
  buildUpdateMission,
  checkUpstream,
  isReimport,
  loadRuntimeStatus,
  toPlainLine
} from '@/store/iclone-updates'
import { setSidebarOpen } from '@/store/layout'
import { $desktopVersion, $updatePolicy, refreshDesktopVersion, refreshUpdatePolicy } from '@/store/updates'
import type { IcloneUpstreamStatus } from '@/types/iclone-updates'

import { requestComposerFocus, requestComposerInsert } from '../../chat/composer/focus'
import { type UpdatesCopy, useUpdatesCopy } from '../machine/updates-copy'
import { SettingsSection } from '../primitives'
import { SettingRow } from '../setting-row'

import { CompatSection, installTip } from './compat'
import { DigestSection, digestView } from './digest'
import { type InboxDecision, inboxDecision, InboxSection } from './inbox'
import { updatesIntro } from './intro'
import { Aside, count, formatDate, type RuntimeSummary, StatusCard, timeAgo } from './parts'
import { RuntimeTrack } from './runtime-track'

// ── formatting ─────────────────────────────────────────────────────────────

// ── Track B: the source ────────────────────────────────────────────────────

function sourceSummary(
  status: IcloneUpstreamStatus | null,
  checking: boolean,
  now: number,
  u: UpdatesCopy
): RuntimeSummary {
  if (!status || status.unchecked) {
    return checking
      ? {
          detail: u.fetchingHint,
          title: u.fetchingTitle,
          tone: 'idle'
        }
      : {
          detail: u.notCheckedHint,
          title: u.notCheckedTitle,
          tone: 'idle'
        }
  }

  if (!status.available) {
    return { detail: status.reason ?? u.unavailable, title: u.compareUnavailable, tone: 'warn' }
  }

  const behind = status.behind ?? 0
  const checked = `Checked ${timeAgo(status.fetchedAt, now)}${checking ? ' · fetching upstream…' : ''}.`

  if (isReimport(status)) {
    const tag = status.latestTag?.name ?? 'the newest release tag'

    return {
      detail: `Nothing is merged: the Inbox ranks them and what you adopt is re-implemented here. Newest release: ${tag}. ${checked}`,
      title: u.changesToReview(count(behind)),
      tone: 'warn'
    }
  }

  if (behind > 0) {
    return { detail: checked, title: u.changesToReview(count(behind)), tone: 'available' }
  }

  return { detail: checked, title: u.upToDate, tone: 'idle' }
}

const SourceTrack = memo(function SourceTrack({
  checking,
  onStart,
  starting,
  status
}: {
  checking: boolean
  onStart: () => void
  starting: boolean
  status: IcloneUpstreamStatus | null
}) {
  const now = useStore($clock)
  const reimport = isReimport(status)
  const u = useUpdatesCopy()
  const summary = sourceSummary(status, checking, now, u)
  const tag = status?.available ? status.latestTag : null
  const recent = status?.available ? (status.recent ?? []).slice(0, 6).map(line => toPlainLine(line)) : []

  const recheck = useCallback(() => void checkUpstream({ force: true }), [])

  return (
    <SettingsSection
      aside={status?.available ? <Aside>checked {timeAgo(status.fetchedAt, now)}</Aside> : undefined}
      icon={GitFork}
      meta="Track B"
      title={u.sourceTitle}
    >
      <StatusCard
        actions={
          <>
            <Button disabled={starting} onClick={onStart} size="sm">
              {starting ? u.startingCurated : u.startCurated}
            </Button>
            <Button disabled={checking || starting} onClick={recheck} size="sm" variant="textStrong">
              {checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              {checking ? u.checkingUpstream : u.checkUpstream}
            </Button>
          </>
        }
        busy={(!status || status.unchecked) && checking}
        detail={summary.detail}
        title={summary.title}
        tone={summary.tone}
      >
        {status?.refreshError && (
          <p className="mt-2 border-t border-(--ui-stroke-tertiary) pt-2 text-xs text-muted-foreground">
            The last re-check failed ({status.refreshError}); this is the answer from {timeAgo(status.fetchedAt, now)}.
          </p>
        )}
      </StatusCard>

      {status?.available && (
        <>
          <SettingRow
            detail="iclone/UPSTREAM_BASE names the import origin and never moves; HEAD shares no ancestor with upstream"
            hint={`Imported from upstream ${status.upstreamBase}${status.upstreamTip ? ` · upstream main is now at ${toPlainLine(status.upstreamTip)}` : ''}`}
            title={u.anchorTitle}
            wide
          />
          <SettingRow
            detail={
              status.ownCommits === undefined ? undefined : `${status.ownCommits} commits of ours since the import`
            }
            hint={`${status.baseCommit} — ${toPlainLine(status.baseSubject ?? '')}`}
            title={u.headTitle}
            wide
          />
          {status.diff && (
            <SettingRow
              hint={`${count(status.diff.files)} files · +${count(status.diff.insertions)} / −${count(status.diff.deletions)}`}
              title={u.distanceTitle}
              wide
            />
          )}
          <SettingRow
            detail="Newest upstream release; canaries and pre-releases are skipped"
            hint={
              tag
                ? `${tag.name} · ${tag.sha.slice(0, 10)} · ${formatDate(tag.date)}`
                : 'No upstream release tag found locally — check upstream to fetch tags.'
            }
            title={u.releaseTitle}
            wide
          />
          {!reimport && recent.length > 0 && (
            <SettingRow
              hint={<span className="font-mono whitespace-pre-line">{recent.join('\n')}</span>}
              title={u.commitsTitle}
              wide
            />
          )}
        </>
      )}
    </SettingsSection>
  )
})

// ── the pane ───────────────────────────────────────────────────────────────

export function DeveloperUpdates({ navigate, onClose }: { navigate: (route: string) => void; onClose: () => void }) {
  const u = useUpdatesCopy()
  const [devOpen, setDevOpen] = useState(false)
  const status = useStore($upstreamStatus)
  const checking = useStore($upstreamChecking)
  const [starting, setStarting] = useState(false)
  const now = useStore($clock)
  const pending = useStore($compatVerdict)
  const latest = useStore($compatLatest)
  const compatStatus = useStore($compatStatus)
  const backlog = useStore($backlog)
  const [deciding, setDeciding] = useState<null | string>(null)
  const [decided, setDecided] = useState<ReadonlySet<string>>(() => new Set())

  // Paint from the atoms first; these only refresh. The runtime read is local
  // and fast; the upstream read is cache-only — git runs only from a button.
  useEffect(() => {
    void loadRuntimeStatus()
    void checkUpstream({ cacheOnly: true })
    void loadBacklog().catch(() => undefined)

    if (!$desktopVersion.get()) {
      void refreshDesktopVersion()
    }

    if (!$updatePolicy.get()) {
      void refreshUpdatePolicy()
    }
  }, [])

  const start = useCallback(async () => {
    setStarting(true)

    try {
      const collected = await checkUpstream({ force: false })

      setSidebarOpen(false)
      onClose()
      navigate(NEW_CHAT_ROUTE)
      requestComposerInsert(buildUpdateMission(collected), { mode: 'block', target: 'main' })
      requestComposerFocus('main')
    } finally {
      setStarting(false)
    }
  }, [navigate, onClose])

  const onStart = useCallback(() => void start(), [start])
  const policyInfo = useStore($updatePolicy)

  const inbox = useMemo(() => (backlog?.inbox ?? []).filter(row => !decided.has(row.sha)), [backlog, decided])
  const digest = useMemo(() => digestView(backlog), [backlog])

  // A decision is one ledger line written by main; the row leaves the Inbox once main confirms it.
  const decide = useCallback(
    async (sha: string, decision: InboxDecision) => {
      const row = inbox.find(r => r.sha === sha)

      if (!row || deciding) {
        return
      }

      setDeciding(sha)

      try {
        const result = await decideAdoption(inboxDecision(row, decision))

        if (result.ok) {
          setDecided(prev => new Set(prev).add(sha))
        }
      } finally {
        setDeciding(null)
      }
    },
    [deciding, inbox]
  )

  const onDecide = useCallback((sha: string, decision: InboxDecision) => void decide(sha, decision), [decide])

  return (
    <section aria-label={u.devHeading} className="mt-10 border-t border-(--ui-stroke-tertiary) pt-6">
      <SettingRow
        control={
          <Button aria-expanded={devOpen} onClick={() => setDevOpen(open => !open)} size="sm" variant="textStrong">
            {devOpen ? u.devHide : u.devShow}
          </Button>
        }
        hint={u.devHint}
        title={u.devTitle}
      />
      {devOpen && (
        <>
          <p className="mt-3 mb-5 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
            {updatesIntro(policyInfo)}
          </p>
          <RuntimeTrack upstreamBase={status?.available ? status.upstreamBase : undefined} />
          <CompatSection
            now={now}
            probe={compatStatus?.probe ?? null}
            tip={installTip(compatStatus)}
            verdict={pending ?? latest}
          />
          <SourceTrack checking={checking} onStart={onStart} starting={starting} status={status} />
          <InboxSection busySha={deciding} onDecide={onDecide} rows={inbox} />
          <DigestSection backlog={digest} />
        </>
      )}
    </section>
  )
}
