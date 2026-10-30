/**
 * EconomyOS — Market · My resources: the endpoints the iNFT exposes on ACP
 * (a URL and the params it takes — no job, no escrow).
 *
 * Creating one runs here, on the owner's click. Updating or deleting one is
 * interactive-only in this CLI version, so those are handed to the iNFT,
 * which drives a terminal session.
 */
import { Globe, Plus, X } from 'lucide-react'
import { type FormEvent, memo, useMemo, useState } from 'react'

import { Action, Cell, Empty, IconAction, Note, Pill, Row, Rows, SkeletonRows, Toolbar } from '../ui'

import { ResourceCard } from './market-agent'
import { type MarketResource, needsSetup, type ResourceChange, type Slot } from './market-data'
import { checkResource, previewResource, type ResourceDraft, URL_MAX } from './market-editor'
import { EditorFrame, FormSection, ListingFields, SchemaEditor, TextField, Toggle } from './market-form'
import { FailureState, StaleNote } from './market-ui'

export function resourceKey(resource: MarketResource): string {
  return resource.id || `${resource.name}|${resource.url}`
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url)

    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}

interface ResourcesProps {
  notice: null | string
  resources: Slot<MarketResource[]>
  selectedKey: null | string
  onNew: () => void
  onRetry: () => void
  onSelect: (resource: MarketResource) => void
  onSetup: () => void
}

export function ResourcesView(props: ResourcesProps) {
  const { notice, onNew, onRetry, resources } = props
  const list = resources.data

  return (
    <>
      <Toolbar
        end={
          <Action kind="primary" onClick={onNew} title="Publish an endpoint on ACP">
            <Plus size={13} strokeWidth={1.9} />
            New resource
          </Action>
        }
      >
        <span className="mk-heading">
          My resources
          {list ? <span className="mk-count">{list.length}</span> : null}
        </span>
      </Toolbar>
      {list && resources.error && !needsSetup(resources.error) ? (
        <StaleNote at={resources.at} failure={resources.error} onRetry={onRetry} />
      ) : null}
      {notice ? (
        <div aria-live="polite" className="mk-notice" role="status">
          <Note>{notice}</Note>
        </div>
      ) : null}
      <div className="e-scroll mk-list">
        <ResourcesBody {...props} />
      </div>
    </>
  )
}

function ResourcesBody({ onNew, onRetry, onSelect, onSetup, resources, selectedKey }: ResourcesProps) {
  const list = resources.data

  if (resources.error && (!list || needsSetup(resources.error))) {
    return (
      <FailureState
        failure={resources.error}
        onRetry={onRetry}
        onSetup={onSetup}
        title="Your resources could not be read"
      />
    )
  }

  if (!list) {
    return <SkeletonRows rows={3} />
  }

  if (list.length === 0) {
    return (
      <Empty
        action={
          <Action kind="primary" onClick={onNew}>
            <Plus size={13} strokeWidth={1.9} />
            New resource
          </Action>
        }
        hint="A resource is an endpoint other agents call directly — a price feed, a lookup, a data API — listed with the params it takes."
        icon={<Globe size={22} strokeWidth={1.6} />}
        title="No resources yet"
      />
    )
  }

  return (
    <div className="mk-rows mk-rows--resources">
      <Rows>
        {list.map(resource => (
          <ResourceRow
            active={resourceKey(resource) === selectedKey}
            key={resourceKey(resource)}
            onSelect={onSelect}
            resource={resource}
          />
        ))}
      </Rows>
    </div>
  )
}

const ResourceRow = memo(function ResourceRow({
  active,
  onSelect,
  resource
}: {
  active: boolean
  onSelect: (resource: MarketResource) => void
  resource: MarketResource
}) {
  return (
    <Row active={active} onClick={() => onSelect(resource)}>
      <Cell grow>
        <span className="mk-row__main">{resource.name}</span>
        {resource.description ? <span className="mk-row__sub">{resource.description}</span> : null}
      </Cell>
      <Cell width={80}>{resource.isHidden ? <Pill tone="muted">hidden</Pill> : null}</Cell>
      <Cell align="end" mono muted width={220}>
        {resource.url ? hostOf(resource.url) : '—'}
      </Cell>
    </Row>
  )
})

export function ResourceDetail({
  agentName,
  onAsk,
  onClose,
  resource
}: {
  agentName: string
  onAsk: (resource: MarketResource, change: ResourceChange) => void
  onClose?: () => void
  resource: MarketResource
}) {
  return (
    <div className="mk-detail">
      <div className="mk-detail__bar">
        <p className="mk-label">Your resource</p>
        {onClose ? (
          <IconAction label="Close" onClick={onClose}>
            <X size={14} strokeWidth={1.8} />
          </IconAction>
        ) : null}
      </div>
      <ResourceCard resource={resource} />
      <Note>
        Changing or removing a resource only runs interactively in this ACP CLI version, so it can’t be done from here.{' '}
        {agentName} can do it in a terminal session, with you confirming each step.
      </Note>
      <div className="mk-detail__actions">
        <Action onClick={() => onAsk(resource, 'update')} title="Draft a brief — nothing is sent until you press Enter">
          Ask {agentName} to update it
        </Action>
        <Action
          kind="quiet"
          onClick={() => onAsk(resource, 'delete')}
          title="Draft a brief — nothing is sent until you press Enter"
        >
          Ask {agentName} to delete it
        </Action>
      </div>
    </div>
  )
}

interface ResourceEditorProps {
  busy: boolean
  draft: ResourceDraft
  error: null | string
  onCancel: () => void
  onChange: (draft: ResourceDraft) => void
  onSubmit: () => void
}

export function ResourceEditor({ busy, draft, error, onCancel, onChange, onSubmit }: ResourceEditorProps) {
  const [attempted, setAttempted] = useState(false)
  const check = useMemo(() => checkResource(draft), [draft])
  const preview = useMemo(() => previewResource(draft), [draft])
  const errors = attempted ? check.errors : {}

  const set = <K extends keyof ResourceDraft>(key: K, value: ResourceDraft[K]) => onChange({ ...draft, [key]: value })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setAttempted(true)

    if (check.values && !busy) {
      onSubmit()
    }
  }

  return (
    <EditorFrame
      backLabel="My resources"
      error={error}
      onCancel={onCancel}
      onSubmit={submit}
      preview={<ResourceCard resource={preview} />}
      previewLabel="Preview · as callers see it"
      submitDisabled={busy}
      submitLabel={busy ? 'Publishing…' : 'Publish resource'}
      title="New resource"
      why={attempted && !check.values ? 'Fix the marked fields to continue.' : ''}
    >
      <FormSection hint="Other agents call it directly — no job, no escrow." title="Endpoint">
        <ListingFields
          description={draft.description}
          descriptionPlaceholder="What it returns, and how often it updates."
          errors={errors}
          name={draft.name}
          namePlaceholder="Live token price"
          onChange={set}
        />
        <TextField
          error={errors.url}
          hint="https only — every buyer can read it, so keep keys and tokens out."
          inputMode="url"
          label="URL"
          max={URL_MAX}
          mono
          onChange={value => set('url', value)}
          placeholder="https://api.example.com/v1/price"
          value={draft.url}
        />
      </FormSection>

      <FormSection hint="The query a caller sends. No fields means it takes none." title="Params">
        <SchemaEditor
          allowEmpty
          draft={draft.params}
          error={errors.params}
          label="Params"
          modes={['fields', 'json']}
          noun="params"
          onChange={value => set('params', value)}
        />
      </FormSection>

      <FormSection title="Options">
        <Toggle
          checked={draft.hidden}
          hint="Kept off marketplace search."
          label="Hidden"
          onChange={value => set('hidden', value)}
        />
      </FormSection>
    </EditorFrame>
  )
}
