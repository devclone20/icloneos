/**
 * V3-I — the Work tab's rows: an offer in the inbox, a traced job, a fix. Built from the Dock apps' own parts
 * (econ/ui) and the market's row classes; no new chrome.
 */
import { memo, type ReactNode } from 'react'

import type { AcpWorkTranslations } from '@/i18n/types/acpWork'
import type { WorkFixView, WorkOfferView, WorkRowView } from '@/iclone-shared/acp-work'

import { shortAddress } from '../../format'
import { Cell, Pill, Row } from '../../ui'
import { StatusPill } from '../market-ui'

import { hopValue, microsLabel, TRACE_HOPS, type TraceHop } from './work-data'

/**
 * A button for an owner decision. It carries `data-acp-work-confirm`, so the preload's gesture lock counts only a
 * real click or key on it; `onConfirm` must call the bridge synchronously.
 */
export function ConfirmButton({
  children,
  disabled,
  kind = 'default',
  onConfirm,
  pressed
}: {
  children: ReactNode
  disabled?: boolean
  kind?: 'default' | 'primary' | 'quiet'
  onConfirm: () => void
  pressed?: boolean
}) {
  return (
    <button
      aria-pressed={pressed}
      className={`e-btn e-btn--${kind}`}
      data-acp-work-confirm=""
      disabled={disabled}
      onClick={onConfirm}
      type="button"
    >
      {children}
    </button>
  )
}

const STANDING_TONE: Record<WorkOfferView['standing'], 'down' | 'muted' | 'tone' | 'up' | 'warn'> = {
  pending: 'warn',
  approved: 'up',
  declined: 'muted',
  refused: 'down',
  seen: 'muted'
}

export const OfferRow = memo(function OfferRow({
  canDecide,
  copy,
  offer,
  onApprove,
  onDecline
}: {
  canDecide: boolean
  copy: AcpWorkTranslations
  offer: WorkOfferView
  onApprove: (jobId: string) => void
  onDecline: (jobId: string) => void
}) {
  const pending = offer.standing === 'pending'

  return (
    <Row>
      <Cell mono width={92}>
        #{offer.jobId}
      </Cell>
      <Cell grow>
        <span className="mk-row__main">{offer.title || '—'}</span>
        <span className="mk-row__sub">
          {copy.offers.price(microsLabel(offer.priceMicros))} ·{' '}
          {copy.offers.requester(shortAddress(offer.requester) || '—')}
          {offer.rule ? ` · ${copy.refusedBy(copy.offers.rules[offer.rule])}` : ''}
          {offer.note && offer.standing === 'approved' ? ` · ${copy.writesOff}` : ''}
        </span>
      </Cell>
      <Cell width={150}>
        <Pill tone={STANDING_TONE[offer.standing]}>{copy.offers.standing[offer.standing]}</Pill>
      </Cell>
      <Cell align="end" width={190}>
        {pending && canDecide ? (
          <span className="mk-actions">
            <ConfirmButton kind="primary" onConfirm={() => onApprove(offer.jobId)}>
              {copy.offers.approve}
            </ConfirmButton>
            <ConfirmButton kind="quiet" onConfirm={() => onDecline(offer.jobId)}>
              {copy.offers.decline}
            </ConfirmButton>
          </span>
        ) : null}
      </Cell>
    </Row>
  )
})

const HOP_LABEL = (copy: AcpWorkTranslations, hop: TraceHop): string =>
  ({
    offer: copy.trace.offer,
    job: copy.trace.job,
    budgetMicros: copy.trace.budget,
    deliverable: copy.trace.deliverable,
    paymentMicros: copy.trace.payment
  })[hop]

export const WorkRowItem = memo(function WorkRowItem({ copy, row }: { copy: AcpWorkTranslations; row: WorkRowView }) {
  return (
    <Row>
      <Cell mono width={92}>
        #{row.jobId}
      </Cell>
      <Cell grow>
        <span className="mk-row__main">{row.title || '—'}</span>
        <span className="mk-row__sub mk-work-trace">
          {TRACE_HOPS.map(hop => {
            const value = hopValue(row.trace, hop)

            return (
              <span data-gap={value === null ? '' : undefined} key={hop}>
                {HOP_LABEL(copy, hop)} {value === null ? copy.trace.gap : hop === 'offer' ? '✓' : value}
              </span>
            )
          })}
        </span>
      </Cell>
      <Cell width={112}>
        <StatusPill status={row.status} />
      </Cell>
    </Row>
  )
})

export function FixRow({ copy, fix, stateLabel }: { copy: AcpWorkTranslations; fix: WorkFixView; stateLabel: string }) {
  return (
    <Row>
      <Cell grow>
        <span className="mk-row__main">{copy.fixes.causes[fix.cause]}</span>
        <span className="mk-row__sub">
          {copy.fixes.actions[fix.tried]} · {copy.fixes.now(stateLabel)}
        </span>
      </Cell>
      <Cell mono muted width={92}>
        {fix.at.slice(11, 19)}
      </Cell>
    </Row>
  )
}
