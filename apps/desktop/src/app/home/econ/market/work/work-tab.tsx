import './work.css'

/**
 * V3-I — ACP Market › Work: put the iNFT online from main (it stays online with this window closed), take it offline
 * safely (a drain, never a kill under a job half done), reboot its listener, choose how far the watchdog may act,
 * answer the offers it found, and follow every job from offer to payment. Everything here is main's view, read on
 * open and again whenever main says it changed.
 */
import { useStore } from '@nanostores/react'
import { Briefcase } from 'lucide-react'
import { useEffect } from 'react'

import type { AcpWorkTranslations } from '@/i18n/types/acpWork'
import { acpToolsReady } from '@/iclone-shared/acp-tools'
import { AUTONOMY_LEVELS, type WorkView } from '@/iclone-shared/acp-work'
import { hasAcpToolsBridge, useAcpTools } from '@/store/acp-tools'
import {
  $acpWork,
  $acpWorkNotice,
  loadWork,
  runWorkAction,
  watchWork,
  workAvailable,
  type WorkNotice
} from '@/store/acp-work'

import { AcpToolsPanel } from '../../acp-tools-panel'
import { Action, Empty, Note, RefreshAction, Rows, SectionTitle, SkeletonRows, Stat, StatRow, Toolbar } from '../../ui'

import { useWorkCopy } from './work-copy'
import { inboxOrder, microsLabel, rowsIn, WORK_GROUPS } from './work-data'
import { ConfirmButton, FixRow, OfferRow, WorkRowItem } from './work-row'

const STATE_TONE: Partial<Record<WorkView['state'], 'down' | 'up' | 'warn'>> = {
  online: 'up',
  starting: 'warn',
  draining: 'warn',
  failed: 'down'
}

function noticeText(copy: AcpWorkTranslations, notice: WorkNotice): string {
  if (notice.kind === 'stop') {
    return copy.stopReport(notice.report.open.length, microsLabel(notice.report.escrowMicros))
  }

  const { error, rule } = notice.result

  return error === 'policy' && rule ? copy.refusedBy(copy.offers.rules[rule]) : copy.errors[error]
}

export function WorkTab({ slug }: { slug: string }) {
  const copy = useWorkCopy()
  const view = useStore($acpWork)[slug] ?? null
  const notice = useStore($acpWorkNotice)[slug] ?? null
  const tools = useAcpTools()

  useEffect(() => watchWork(slug), [slug])

  if (!workAvailable()) {
    return <Empty hint={copy.desktopOnly} icon={<Briefcase size={22} strokeWidth={1.6} />} title={copy.tab} />
  }

  // REL-6: the listener and every read run the ACP CLI; until it is installed and verified, its state instead.
  if (hasAcpToolsBridge() && !acpToolsReady(tools)) {
    return <AcpToolsPanel view={tools ?? { state: 'checking', cliVersion: null }} />
  }

  if (!view) {
    return (
      <div className="e-scroll e-pad">
        <SkeletonRows rows={5} />
      </div>
    )
  }

  const up = view.state === 'online' || view.state === 'starting' || view.state === 'draining'
  const canDecide = view.effective !== 'L0' && view.state !== 'draining'

  // Each owner call runs synchronously inside its own click: the gesture lock reads that click.
  const approve = (jobId: string) => void runWorkAction(slug, api => api.approve(slug, jobId))
  const decline = (jobId: string) => void runWorkAction(slug, api => api.decline(slug, jobId))

  return (
    <>
      <Toolbar end={<RefreshAction onClick={() => void loadWork(slug, 'refresh')} spinning={false} />}>
        <span className="mk-actions">
          {up ? null : (
            <ConfirmButton kind="primary" onConfirm={() => void runWorkAction(slug, api => api.online(slug))}>
              {copy.actions.online}
            </ConfirmButton>
          )}
          {up ? (
            <Action onClick={() => void runWorkAction(slug, api => api.offline(slug))}>{copy.actions.offline}</Action>
          ) : null}
          {up || view.state === 'failed' ? (
            <Action kind="quiet" onClick={() => void runWorkAction(slug, api => api.reboot(slug))}>
              {copy.actions.reboot}
            </Action>
          ) : null}
        </span>
      </Toolbar>
      <div className="e-scroll mk-list mk-work">
        <div className="e-pad">
          <StatRow>
            <Stat
              hero
              label={copy.tab}
              sub={copy.awakeOnly}
              tone={STATE_TONE[view.state]}
              value={copy.states[view.state]}
            />
            <Stat label={copy.totals.earned} value={microsLabel(view.totals.earnedMicros)} />
            <Stat label={copy.totals.escrow} value={microsLabel(view.totals.escrowMicros)} />
            <Stat label={copy.totals.spent} sub={copy.autonomy.earnOnly} value={microsLabel(view.totals.spentMicros)} />
          </StatRow>
          <Note>{copy.onlineMeaning}</Note>
          {notice ? <Note kind={notice.kind === 'error' ? 'error' : 'info'}>{noticeText(copy, notice)}</Note> : null}
          {view.state === 'draining' ? (
            <Note kind="warn">
              {view.blocking.length > 0 ? copy.draining(view.blocking.join(', ')) : copy.drainUnknown}
            </Note>
          ) : null}
          {view.hold ? (
            <Note kind={view.hold === 'ownership-unverified' ? 'info' : 'warn'}>{copy.holds[view.hold]}</Note>
          ) : null}
          {view.readError ? <Note kind="warn">{copy.readError(view.readError)}</Note> : null}
          {view.chain.ok ? null : (
            <>
              <Note kind="error">{copy.chainBroken}</Note>
              <Note>{copy.repair.hint}</Note>
              <span className="mk-actions">
                <ConfirmButton onConfirm={() => void runWorkAction(slug, api => api.repair(slug))}>
                  {copy.repair.action}
                </ConfirmButton>
              </span>
            </>
          )}
          {view.chain.ok && view.chain.gaps > 0 ? <Note>{copy.chainGaps(view.chain.gaps)}</Note> : null}

          <SectionTitle>{copy.autonomy.title}</SectionTitle>
          <div className="mk-filters mk-work-levels" role="group">
            {AUTONOMY_LEVELS.map(level => (
              <ConfirmButton
                key={level}
                kind={view.level === level ? 'primary' : 'default'}
                onConfirm={() => void runWorkAction(slug, api => api.setLevel(slug, level))}
                pressed={view.level === level}
              >
                {copy.autonomy.levels[level].name}
              </ConfirmButton>
            ))}
          </div>
          <Note>{copy.autonomy.levels[view.level].summary}</Note>
          {view.downgrade ? <Note kind="warn">{copy.autonomy.downgrade[view.downgrade]}</Note> : null}
          {view.writes === 'off' && view.effective !== 'L0' ? <Note>{copy.writesOff}</Note> : null}

          <SectionTitle>{copy.offers.title}</SectionTitle>
          {view.offers.length === 0 ? (
            <Empty
              hint={copy.offers.emptyHint}
              icon={<Briefcase size={22} strokeWidth={1.6} />}
              title={copy.offers.empty}
            />
          ) : (
            <Rows>
              {inboxOrder(view.offers).map(offer => (
                <OfferRow
                  canDecide={canDecide}
                  copy={copy}
                  key={offer.jobId}
                  offer={offer}
                  onApprove={approve}
                  onDecline={decline}
                />
              ))}
            </Rows>
          )}

          {WORK_GROUPS.map(group => {
            const rows = rowsIn(view, group)

            return (
              <section key={group}>
                <SectionTitle>{copy.groups[group]}</SectionTitle>
                {rows.length === 0 ? (
                  <p className="mk-rail-hint">{copy.groupsEmpty}</p>
                ) : (
                  <Rows>
                    {rows.map(row => (
                      <WorkRowItem copy={copy} key={row.jobId} row={row} />
                    ))}
                  </Rows>
                )}
              </section>
            )
          })}

          <SectionTitle>{copy.fixes.title}</SectionTitle>
          {view.fixes.length === 0 ? (
            <p className="mk-rail-hint">{copy.fixes.empty}</p>
          ) : (
            <Rows>
              {view.fixes.map(fix => (
                <FixRow copy={copy} fix={fix} key={fix.id} stateLabel={copy.states[fix.now]} />
              ))}
            </Rows>
          )}
        </div>
      </div>
    </>
  )
}
