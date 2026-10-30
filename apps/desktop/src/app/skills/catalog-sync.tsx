import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/i18n'
import { enSkills } from '@/i18n/en'
import { errorMessage } from '@/iclone-shared/errors'
import type { SkillInfo } from '@/types/hermes'

import { IcPageButton } from '../profiles/ic-page'
import {
  groupSkills,
  lastSyncLabel,
  manifestProblemLines,
  needsLines,
  offWarnings,
  rowNotes,
  type SkillCatalog
} from '../settings/skills-settings-model'

/**
 * Capabilities → the icloneOS skill catalog: the one thing `Settings → Skills`
 * offered that this page did not (front K2, 2026-10-19).
 *
 * That pane was a thinner second home for the same idea, so it is gone; what
 * only IT could do moved here, because only this surface knows the installed
 * list it has to be read against:
 * - **Re-sync** writes the app's own skills into every agent's skills tree
 *   (`window.hermesDesktop.icloneSkills`), reports what changed and offers the
 *   backend restart that makes the agent read them;
 * - the head band states the group counts (icloneOS · upstream · learned · hub)
 *   and the age of the last sync, so "is this machine current?" is answerable
 *   without clicking anything;
 * - a skill the runtime instructions name while it is off (or missing) warns
 *   STANDING, not only at the moment it is turned off.
 *
 * The copy is `enSkills` — the same English-only block the retired pane used,
 * reused verbatim so no string changed in this move (i18n belongs to another
 * front this round).
 *
 * Two slots, one hook: the buttons belong in `IcPage`'s actions and the line of
 * context belongs in its subtitle, so this returns both instead of rendering a
 * box of its own.
 */
const s = enSkills

interface SkillCatalogSync {
  actions: null | ReactNode
  subtitle: null | ReactNode
  /** V3-B: per-row facts (attribution, needs, an invalid manifest) keyed by skill name, for the Skills rows. */
  rowNotes: ReadonlyMap<string, string>
}

type Notice = { restart?: boolean; text: string; tone: 'ok' | 'warn' }

export function useSkillCatalogSync(
  installed: readonly SkillInfo[] | undefined,
  onSynced: () => void
): SkillCatalogSync {
  const [catalog, setCatalog] = useState<null | SkillCatalog>(null)
  const [syncedAt, setSyncedAt] = useState<number | undefined>()
  const [busy, setBusy] = useState<null | 'restart' | 'sync'>(null)
  const [notice, setNotice] = useState<null | Notice>(null)
  const { t } = useI18n()

  const bridge = window.hermesDesktop?.icloneSkills

  const readState = useCallback(async () => {
    if (!bridge) {
      return
    }

    const [cat, last] = await Promise.all([
      bridge.catalog?.().catch(() => null) ?? null,
      bridge.last().catch(() => null)
    ])

    setCatalog(cat)
    // A reload never moves the shown sync time backwards (a report read before
    // a Re-sync landed).
    setSyncedAt(prev => Math.max(prev ?? 0, last?.syncedAt ?? 0) || undefined)
  }, [bridge])

  useEffect(() => {
    void readState()
  }, [readState])

  const groups = useMemo(() => groupSkills(installed ?? [], catalog), [catalog, installed])
  const off = useMemo(() => offWarnings(groups), [groups])
  // V3-B: a ported skill this machine cannot run is named with what it lacks — standing, never hidden; so is a
  // bundled skill whose manifest.json fails the schema (F8), on the page line and on its own row.
  const needs = useMemo(() => needsLines(groups), [groups])
  const manifestProblems = useMemo(() => manifestProblemLines(groups), [groups])
  const notes = useMemo(() => rowNotes(groups, t.slash), [groups, t.slash])

  const resync = async () => {
    if (!bridge) {
      return
    }

    setBusy('sync')
    setNotice(null)

    try {
      const report = await bridge.sync()

      setSyncedAt(report.syncedAt)
      setNotice(
        !report.ok
          ? { text: s.resyncFailed(report.errors[0] ?? ''), tone: 'warn' }
          : report.written.length
            ? { restart: true, text: s.resyncWritten(report.written.length), tone: 'ok' }
            : { text: s.resyncUnchanged, tone: 'ok' }
      )
      await readState()
      onSynced()
    } catch (error) {
      setNotice({ text: s.resyncFailed(errorMessage(error)), tone: 'warn' })
    } finally {
      setBusy(null)
    }
  }

  const restart = async () => {
    setBusy('restart')

    try {
      const result = await window.hermesDesktop.restartBackend()

      setNotice(
        result.ok ? { text: s.restarted, tone: 'ok' } : { text: s.restartFailed(result.error ?? ''), tone: 'warn' }
      )
    } catch (error) {
      setNotice({ text: s.restartFailed(errorMessage(error)), tone: 'warn' })
    } finally {
      setBusy(null)
    }
  }

  // No bridge (a browser-only render, or an older main process) means no
  // catalog to sync: the surface says nothing rather than offering a dead
  // button.
  if (!bridge) {
    return { actions: null, subtitle: null, rowNotes: new Map() }
  }

  const counts = installed
    ? `${s.counts(groups.iclone.length, groups.upstream.length, groups.learned.length, groups.hub.length)} · ${lastSyncLabel(syncedAt, s)}`
    : lastSyncLabel(syncedAt, s)

  const warning = off.size > 0 ? s.offSummary([...off.keys()]) : null
  const needsLine = needs.length > 0 ? t.slash.needsSummary(needs) : null
  const manifestLine = manifestProblems.length > 0 ? t.slash.manifestSummary(manifestProblems) : null

  return {
    rowNotes: notes,
    actions: (
      <>
        {notice?.restart ? (
          <IcPageButton disabled={busy !== null} onClick={() => void restart()} tone="quiet">
            {busy === 'restart' ? s.restarting : s.restart}
          </IcPageButton>
        ) : null}
        <IcPageButton disabled={busy !== null} onClick={() => void resync()} tone="quiet">
          {busy === 'sync' ? s.resyncing : s.resync}
        </IcPageButton>
      </>
    ),
    subtitle: (
      <>
        {counts}
        {notice ? <span data-ic-sync-notice={notice.tone}> · {notice.text}</span> : null}
        {warning ? (
          // The retired pane painted this line `--ic-warning` behind an
          // AlertTriangle and named it for assistive tech; in the subtitle slot
          // the tone is the attribute (styled in skills-page.css) and the role
          // carries the sentence, so the move loses neither.
          <span aria-label={warning} data-ic-sync-warning="" role="status">
            {' · '}
            {warning}
          </span>
        ) : null}
        {needsLine ? (
          <span aria-label={needsLine} data-ic-sync-needs="" data-ic-sync-warning="" role="status">
            {' · '}
            {needsLine}
          </span>
        ) : null}
        {manifestLine ? (
          <span aria-label={manifestLine} data-ic-sync-manifest="" data-ic-sync-warning="" role="status">
            {' · '}
            {manifestLine}
          </span>
        ) : null}
      </>
    )
  }
}
