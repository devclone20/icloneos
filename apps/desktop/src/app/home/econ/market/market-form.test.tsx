import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { type MarketSubscription, type OwnOffering, schemaModel, type Slot } from './market-data'
import { emptyOfferingDraft, emptyResourceDraft, type OfferingDraft, type ResourceDraft } from './market-editor'
import { OfferingEditor } from './market-offering-form'
import { ResourceEditor } from './market-resources'

// The offering and resource editors share EditorFrame + ListingFields. These snapshots were recorded from the
// editors as they were before that merge, so any change to the markup either editor renders fails here.

const REACT_ID = /_r_[0-9a-z]+_|«r[0-9a-z]+»|:r[0-9a-z]+:/g

/** The rendered DOM, one tag per line, with React's generated ids numbered in order of appearance. */
function markup(node: ReactElement): string {
  const { container, unmount } = render(node)
  const ids = new Map<string, string>()

  const html = container.innerHTML.replace(REACT_ID, id => {
    if (!ids.has(id)) {
      ids.set(id, `id-${ids.size + 1}`)
    }

    return ids.get(id) ?? id
  })

  unmount()

  return html.replaceAll('><', '>\n<')
}

const noop = () => undefined

beforeAll(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-01T12:00:00Z'), toFake: ['Date'] })
})

afterAll(() => {
  vi.useRealTimers()
})

const resourceDraft: ResourceDraft = {
  ...emptyResourceDraft(),
  description: 'Hourly forecasts for any city.',
  name: 'Weather feed',
  url: 'https://api.example.com/weather'
}

const resourceCases: Array<[string, { busy: boolean; draft: ResourceDraft; error: null | string }]> = [
  ['a new, empty resource', { busy: false, draft: emptyResourceDraft(), error: null }],
  ['a filled resource', { busy: false, draft: resourceDraft, error: null }],
  [
    'a hidden resource saving after a failure',
    { busy: true, draft: { ...resourceDraft, hidden: true }, error: 'The service refused the write.' }
  ]
]

describe('ResourceEditor markup', () => {
  it.each(resourceCases)('%s', (_name, props) => {
    expect(markup(<ResourceEditor {...props} onCancel={noop} onChange={noop} onSubmit={noop} />)).toMatchSnapshot()
  })
})

const subscription: MarketSubscription = {
  durationDays: 30,
  id: 'sub-1',
  name: 'Monthly',
  packageId: 'pkg-1',
  priceUsdc: 25
}

function ready<T>(data: T): Slot<T> {
  return { at: 0, data, error: null, loading: false }
}

const target: OwnOffering = {
  agentId: 'agent-1',
  deliverable: schemaModel('A PDF report'),
  description: 'Audits a Solidity contract.',
  id: 'off-1',
  isHidden: false,
  isPrivate: false,
  name: 'Contract audit',
  priceType: 'fixed',
  priceValue: 120,
  requiredFunds: false,
  requirements: schemaModel('The contract address'),
  slaMinutes: 240,
  source: { deliverable: 'A PDF report', requirements: 'The contract address', subscriptionIds: [] }
}

const offeringDraft: OfferingDraft = {
  ...emptyOfferingDraft(),
  description: target.description,
  name: target.name,
  price: '120',
  slaMinutes: '240'
}

interface OfferingCase {
  busy: boolean
  count: null | number
  draft: OfferingDraft
  error: null | string
  subscriptions: Slot<MarketSubscription[]>
  target: null | OwnOffering
}

const offeringCases: Array<[string, OfferingCase]> = [
  [
    'a new, empty offering',
    {
      busy: false,
      count: 2,
      draft: emptyOfferingDraft(),
      error: null,
      subscriptions: ready([subscription]),
      target: null
    }
  ],
  [
    'an offering being edited',
    { busy: false, count: 3, draft: offeringDraft, error: null, subscriptions: ready([]), target }
  ],
  [
    'a share-of-value offering saving after a failure, subscriptions unread',
    {
      busy: true,
      count: null,
      draft: {
        ...offeringDraft,
        hidden: true,
        price: '5',
        priceType: 'percentage',
        requiredFunds: true,
        subscriptionIds: ['sub-1']
      },
      error: 'Price must be a number.',
      subscriptions: { at: 0, data: null, error: null, loading: true },
      target: null
    }
  ]
]

describe('OfferingEditor markup', () => {
  it.each(offeringCases)('%s', (_name, props) => {
    expect(
      markup(
        <OfferingEditor
          {...props}
          agentName="Atlas"
          onCancel={noop}
          onChange={noop}
          onRetrySubscriptions={noop}
          onSubmit={noop}
        />
      )
    ).toMatchSnapshot()
  })
})
