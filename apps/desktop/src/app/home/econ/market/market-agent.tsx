/**
 * EconomyOS — Market: one agent in full, and the cards its detail and the
 * owner's own catalogue share — an offering (price, SLA, deliverable, and its
 * requirements as the form a buyer fills in) and a resource (endpoint + params).
 */
import { Handshake, Timer, X } from 'lucide-react'
import { memo, type ReactNode, useMemo } from 'react'

import { Tip } from '@/components/ui/tooltip'

import { chainById, explorerAddressUrl } from '../format'
import { Action, AddressChip, Avatar, CopyText, IconAction, Link, Note, Pill } from '../ui'

import {
  fieldPlaceholder,
  hireChainId,
  type MarketAgent,
  type MarketOffering,
  type MarketResource,
  presenceOf,
  priceLabel,
  ratingLabel,
  type SchemaField,
  type SchemaModel,
  slaLabel
} from './market-data'
import { matchAgent } from './market-search'
import { ChainPills, Highlight, OnlineDot } from './market-ui'

const NO_TOKENS: readonly string[] = []

export const AgentDetail = memo(function AgentDetail({
  agent,
  agentName,
  clock,
  onClose,
  onHire,
  tokens = NO_TOKENS
}: {
  agent: MarketAgent
  agentName: string
  clock: number
  onClose?: () => void
  onHire: (agent: MarketAgent, offering: MarketOffering) => void
  /** The words of the search that found this agent — its matching offerings lead. */
  tokens?: readonly string[]
}) {
  const presence = presenceOf(agent, clock)
  const network = chainById(hireChainId(agent.chainIds))?.network ?? 'base-mainnet'

  const evmExplorer = agent.walletAddress
    ? explorerAddressUrl(network === 'solana-mainnet' ? 'base-mainnet' : network, agent.walletAddress)
    : ''

  const solExplorer = agent.solWalletAddress ? explorerAddressUrl('solana-mainnet', agent.solWalletAddress) : ''
  const count = agent.offerings.length

  const offerings = useMemo(() => {
    if (tokens.length === 0) {
      return agent.offerings
    }

    const matching = matchAgent(agent, tokens).offerings
    const lead = new Set(matching)

    return [...matching, ...agent.offerings.filter(offering => !lead.has(offering))]
  }, [agent, tokens])

  return (
    <div className="mk-detail">
      <header className="mk-detail__head">
        <Avatar name={agent.name} size={48} src={agent.imageUrl} />
        <div className="mk-detail__id">
          <h3 className="mk-detail__name">{agent.name}</h3>
          <p className="mk-detail__sub">
            <OnlineDot online={presence.online} />
            <span>{presence.label}</span>
            <span aria-hidden="true" className="mk-sep">
              ·
            </span>
            <span className={agent.rating == null ? '' : 'mk-rating'}>{ratingLabel(agent.rating)}</span>
            {agent.isNew && agent.rating != null ? <Pill tone="tone">new</Pill> : null}
          </p>
        </div>
        {onClose ? (
          <IconAction label="Close" onClick={onClose}>
            <X size={14} strokeWidth={1.8} />
          </IconAction>
        ) : null}
      </header>

      {agent.description ? <p className="e-prose mk-detail__desc">{agent.description}</p> : null}

      {presence.online ? null : (
        <Note>
          {presence.label === 'offline' ? 'Offline' : `Offline — ${presence.label}`}. A job you create now waits until
          it is back; the brief says so.
        </Note>
      )}

      <dl className="e-kv">
        {agent.walletAddress ? (
          <>
            <dt>Wallet</dt>
            <dd>
              <AddressChip address={agent.walletAddress} href={evmExplorer || undefined} />
            </dd>
          </>
        ) : null}
        {agent.solWalletAddress ? (
          <>
            <dt>Solana</dt>
            <dd>
              <AddressChip address={agent.solWalletAddress} href={solExplorer || undefined} />
            </dd>
          </>
        ) : null}
        {agent.chainIds.length > 0 ? (
          <>
            <dt>Chains</dt>
            <dd>
              <ChainPills chainIds={agent.chainIds} max={8} />
            </dd>
          </>
        ) : null}
        {agent.cluster || agent.tag ? (
          <>
            <dt>Cluster</dt>
            <dd>{[agent.cluster, agent.tag].filter(Boolean).join(' · ')}</dd>
          </>
        ) : null}
        {agent.id ? (
          <>
            <dt>Agent id</dt>
            <dd className="mk-idline">
              <span className="mk-mono">{agent.id}</span>
              <CopyText text={agent.id} />
            </dd>
          </>
        ) : null}
      </dl>

      <section aria-label="Offerings" className="mk-stack">
        <p className="mk-label">
          Offerings <span className="mk-label__count">{count}</span>
        </p>
        {count > 0 ? (
          offerings.map(offering => (
            <OfferingCard
              action={
                <Action
                  kind="primary"
                  onClick={() => onHire(agent, offering)}
                  title={`Draft a hire brief for ${agentName} — nothing is sent until you press Enter`}
                >
                  <Handshake size={13} strokeWidth={1.8} />
                  Hire via {agentName}
                </Action>
              }
              key={offering.id || offering.name}
              offering={offering}
              tokens={tokens}
            />
          ))
        ) : (
          <Note>This agent lists no public offerings right now.</Note>
        )}
      </section>

      {agent.resources.length > 0 ? (
        <section aria-label="Resources" className="mk-stack">
          <p className="mk-label">
            Resources <span className="mk-label__count">{agent.resources.length}</span>
          </p>
          <p className="mk-stack__hint">Endpoints this agent exposes — called directly, no job or escrow.</p>
          {agent.resources.map(resource => (
            <ResourceCard key={resource.id || resource.name} resource={resource} />
          ))}
        </section>
      ) : null}
    </div>
  )
})

export function OfferingCard({
  action,
  offering,
  tokens = NO_TOKENS
}: {
  action?: ReactNode
  offering: MarketOffering
  tokens?: readonly string[]
}) {
  const sla = slaLabel(offering.slaMinutes)

  return (
    <article className="mk-offer">
      <header className="mk-offer__head">
        <h4 className="mk-offer__name">
          <Highlight text={offering.name} tokens={tokens} />
        </h4>
        <span className="mk-offer__price">{priceLabel(offering)}</span>
      </header>
      <div className="mk-offer__facts">
        <Pill tone="muted">{offering.priceType === 'percentage' ? 'share of value' : offering.priceType}</Pill>
        {sla ? (
          <Pill tone="muted">
            <Timer size={10} strokeWidth={1.8} />
            {sla} SLA
          </Pill>
        ) : null}
        {offering.requiredFunds ? <Pill tone="warn">requires funds</Pill> : null}
        {offering.isHidden ? <Pill tone="muted">hidden</Pill> : null}
        {offering.isPrivate ? <Pill tone="muted">private</Pill> : null}
      </div>
      {offering.description ? (
        <p className="mk-offer__desc">
          <Highlight text={offering.description} tokens={tokens} />
        </p>
      ) : null}
      <DeliverableBlock model={offering.deliverable} />
      <RequirementsBlock model={offering.requirements} />
      {action ? <footer className="mk-offer__action">{action}</footer> : null}
    </article>
  )
}

/** An endpoint card: what it is, where it lives, and what it takes. */
export function ResourceCard({ action, resource }: { action?: ReactNode; resource: MarketResource }) {
  return (
    <article className="mk-offer mk-res">
      <header className="mk-offer__head">
        <h4 className="mk-offer__name">{resource.name}</h4>
        {resource.isHidden ? <Pill tone="muted">hidden</Pill> : null}
      </header>
      {resource.description ? <p className="mk-offer__desc">{resource.description}</p> : null}
      {resource.url ? (
        <p className="mk-res__url">
          <Link href={resource.url}>
            <span className="mk-res__href">{resource.url}</span>
          </Link>
        </p>
      ) : (
        <p className="mk-offer__quiet">No public https URL.</p>
      )}
      <div className="mk-offer__block">
        <SchemaHeading label="Params" model={resource.params} />
        <SchemaForm answerHint="a value, in your own words" empty="None — call it as is." model={resource.params} />
      </div>
      {action ? <footer className="mk-offer__action">{action}</footer> : null}
    </article>
  )
}

function DeliverableBlock({ model }: { model: SchemaModel }) {
  if (model.kind === 'none') {
    return null
  }

  return (
    <div className="mk-offer__block">
      <p className="mk-label">Deliverable</p>
      {model.kind === 'text' ? (
        <p className="mk-offer__text">{model.text}</p>
      ) : (
        <ul className="mk-spec">
          {model.fields.map(field => (
            <li key={field.name}>
              <span className="mk-field__name">{field.name}</span>
              <span className="mk-field__type">{field.label}</span>
              {field.description ? <span className="mk-spec__desc">{field.description}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RequirementsBlock({ model }: { model: SchemaModel }) {
  return (
    <div className="mk-offer__block">
      <SchemaHeading label="Requirements" model={model} />
      <SchemaForm answerHint="your answer, in your own words" empty="None — nothing to fill in." model={model} />
    </div>
  )
}

function SchemaHeading({ label, model }: { label: string; model: SchemaModel }) {
  if (model.kind !== 'fields') {
    return <p className="mk-label">{label}</p>
  }

  const required = model.fields.filter(field => field.required).length

  return (
    <p className="mk-label">
      {label}
      <span className="mk-label__count">
        {required} required · {model.fields.length} {model.fields.length === 1 ? 'field' : 'fields'}
      </span>
    </p>
  )
}

/** Required fields first, each in the order the schema lists it. */
function requiredFirst(fields: readonly SchemaField[]): SchemaField[] {
  return [...fields].sort((a, b) => Number(b.required) - Number(a.required))
}

/** A schema read as the form a buyer fills in: prose as a question with an
 *  answer box, fields as labelled inputs — required ones first. */
function SchemaForm({ answerHint, empty, model }: { answerHint: string; empty: string; model: SchemaModel }) {
  if (model.kind === 'none') {
    return <p className="mk-offer__quiet">{empty}</p>
  }

  if (model.kind === 'text') {
    return (
      <>
        <p className="mk-offer__text">{model.text}</p>
        <div className="mk-faux">{answerHint}</div>
      </>
    )
  }

  return (
    <ul className="mk-form">
      {requiredFirst(model.fields).map(field => (
        <FieldPreview field={field} key={field.name} />
      ))}
    </ul>
  )
}

function FieldPreview({ field }: { field: SchemaField }) {
  return (
    <li className="mk-field">
      <div className="mk-field__top">
        <span className="mk-field__name">{field.name}</span>
        {field.type ? (
          <Tip label={field.type}>
            <span className="mk-field__type">{field.label}</span>
          </Tip>
        ) : (
          <span className="mk-field__type">{field.label}</span>
        )}
        <span className={field.required ? 'mk-field__need mk-field__need--on' : 'mk-field__need'}>
          {field.required ? 'required' : 'optional'}
        </span>
      </div>
      <div className="mk-faux">
        {field.enumValues.length > 0
          ? field.enumValues.map((value, index) => (
              <span className="mk-chip" key={`${index}:${value}`}>
                {value}
              </span>
            ))
          : fieldPlaceholder(field)}
      </div>
      {field.description ? <p className="mk-field__hint">{field.description}</p> : null}
    </li>
  )
}
