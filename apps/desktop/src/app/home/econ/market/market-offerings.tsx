/**
 * EconomyOS — Market · My offerings: the services the iNFT sells on ACP —
 * listed against ACP's cap of 40, created and edited in the editor
 * (market-offering-form), deleted after an inline confirmation.
 */
import { PackageOpen, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { memo, useState } from 'react'

import { Action, Cell, Empty, IconAction, Note, Pill, Row, Rows, SkeletonRows, Toolbar } from '../ui'

import { OfferingCard } from './market-agent'
import { type MarketOffering, needsSetup, type OwnOffering, priceLabel, slaLabel, type Slot } from './market-data'
import { canAddress, OFFERING_LIMIT, offeringLimitProblem } from './market-editor'
import { Usage } from './market-offering-form'
import { FailureState, StaleNote } from './market-ui'

interface OfferingsProps {
  agentName: string
  /** What the last write did ("Created …"), shown until the next one. */
  notice: null | string
  offerings: Slot<OwnOffering[]>
  selectedId: null | string
  onAsk: () => void
  onNew: () => void
  onRetry: () => void
  onSelect: (offering: OwnOffering) => void
  onSetup: () => void
}

export function offeringKey(offering: MarketOffering): string {
  return offering.id || offering.name
}

export function OfferingsView(props: OfferingsProps) {
  const { agentName, notice, offerings, onAsk, onNew, onRetry } = props
  const list = offerings.data
  const count = list?.length ?? null
  const blocked = offeringLimitProblem(count)

  return (
    <>
      <Toolbar
        end={
          <>
            <Action
              kind="quiet"
              onClick={onAsk}
              title={`Draft a brief for ${agentName} — nothing is sent until you press Enter`}
            >
              <Sparkles size={13} strokeWidth={1.8} />
              Draft via {agentName}
            </Action>
            <Action
              disabled={blocked !== null}
              kind="primary"
              onClick={onNew}
              title={blocked ?? 'Create an offering on ACP'}
            >
              <Plus size={13} strokeWidth={1.9} />
              New offering
            </Action>
          </>
        }
      >
        <span className="mk-heading">
          My offerings
          <Usage count={count} />
        </span>
      </Toolbar>
      {list && offerings.error && !needsSetup(offerings.error) ? (
        <StaleNote at={offerings.at} failure={offerings.error} onRetry={onRetry} />
      ) : null}
      {count != null && count >= OFFERING_LIMIT ? <Note kind="warn">{blocked}</Note> : null}
      {notice ? (
        <div aria-live="polite" className="mk-notice" role="status">
          <Note>{notice}</Note>
        </div>
      ) : null}
      <div className="e-scroll mk-list">
        <OfferingsBody {...props} />
      </div>
    </>
  )
}

function OfferingsBody({ agentName, offerings, onAsk, onNew, onRetry, onSelect, onSetup, selectedId }: OfferingsProps) {
  const list = offerings.data

  if (offerings.error && (!list || needsSetup(offerings.error))) {
    return (
      <FailureState
        failure={offerings.error}
        onRetry={onRetry}
        onSetup={onSetup}
        title="Your offerings could not be read"
      />
    )
  }

  if (!list) {
    return <SkeletonRows rows={4} />
  }

  if (list.length === 0) {
    return (
      <Empty
        action={
          <span className="mk-actions">
            <Action kind="primary" onClick={onNew}>
              <Plus size={13} strokeWidth={1.9} />
              New offering
            </Action>
            <Action onClick={onAsk}>
              <Sparkles size={13} strokeWidth={1.8} />
              Ask {agentName} to draft one
            </Action>
          </span>
        }
        hint={`Offerings are the services ${agentName} sells on ACP — other agents find them when they search the marketplace.`}
        icon={<PackageOpen size={22} strokeWidth={1.6} />}
        title="No offerings yet"
      />
    )
  }

  return (
    <div className="mk-rows mk-rows--offerings">
      <Rows>
        {list.map(offering => (
          <OfferingRow
            active={offeringKey(offering) === selectedId}
            key={offeringKey(offering)}
            offering={offering}
            onSelect={onSelect}
          />
        ))}
      </Rows>
    </div>
  )
}

const OfferingRow = memo(function OfferingRow({
  active,
  offering,
  onSelect
}: {
  active: boolean
  offering: OwnOffering
  onSelect: (offering: OwnOffering) => void
}) {
  return (
    <Row active={active} onClick={() => onSelect(offering)}>
      <Cell grow>
        <span className="mk-row__main">{offering.name}</span>
        {offering.description ? <span className="mk-row__sub">{offering.description}</span> : null}
      </Cell>
      <Cell width={124}>
        {offering.isHidden ? (
          <Pill tone="muted">hidden</Pill>
        ) : offering.requiredFunds ? (
          <Pill tone="warn">requires funds</Pill>
        ) : null}
      </Cell>
      <Cell align="end" muted width={72}>
        {slaLabel(offering.slaMinutes) || '—'}
      </Cell>
      <Cell align="end" mono width={120}>
        {priceLabel(offering)}
      </Cell>
    </Row>
  )
})

interface OfferingDetailProps {
  /** A delete of this offering is in flight. */
  deleting: boolean
  /** Why the last write failed, in words. */
  error: null | string
  offering: OwnOffering
  onClose?: () => void
  onDelete: (offering: OwnOffering) => void
  onEdit: (offering: OwnOffering) => void
}

/** One offering, with Edit and a Delete that asks once more, inline. */
export function OfferingDetail({ deleting, error, offering, onClose, onDelete, onEdit }: OfferingDetailProps) {
  const [confirming, setConfirming] = useState(false)
  const addressable = canAddress(offering.id)

  return (
    <div className="mk-detail">
      <div className="mk-detail__bar">
        <p className="mk-label">Your offering</p>
        {onClose ? (
          <IconAction label="Close" onClick={onClose}>
            <X size={14} strokeWidth={1.8} />
          </IconAction>
        ) : null}
      </div>
      <OfferingCard offering={offering} />
      {error ? <Note kind="error">{error}</Note> : null}
      {!addressable ? (
        <Note>This offering has no id the ACP CLI can address, so it can’t be changed from here.</Note>
      ) : confirming ? (
        <div aria-label="Confirm delete" className="mk-confirm" role="group">
          <p className="mk-confirm__text">
            Delete “{offering.name}”? It leaves the marketplace for good — this can’t be undone.
          </p>
          <div className="mk-confirm__actions">
            <Action disabled={deleting} kind="quiet" onClick={() => setConfirming(false)}>
              Keep it
            </Action>
            <button
              className="e-btn mk-btn--danger"
              disabled={deleting}
              onClick={() => onDelete(offering)}
              type="button"
            >
              <Trash2 size={13} strokeWidth={1.8} />
              {deleting ? 'Deleting…' : 'Delete offering'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mk-detail__actions">
          <Action kind="primary" onClick={() => onEdit(offering)}>
            <Pencil size={13} strokeWidth={1.8} />
            Edit
          </Action>
          <Action kind="quiet" onClick={() => setConfirming(true)}>
            <Trash2 size={13} strokeWidth={1.8} />
            Delete
          </Action>
        </div>
      )}
    </div>
  )
}
