/**
 * EconomyOS — Market. What the market client and its hooks share: the views,
 * the write in flight, the offering being edited, the last write's notice and
 * two small helpers. The hooks import these from here, never from market-app.
 */
import { useCallback, useRef } from 'react'

import { emptySlot, type OwnOffering, type Slot, type Stamped } from './market-data'
import { type OfferingDraft } from './market-editor'

export type View = 'discover' | 'jobs' | 'offerings' | 'resources' | 'work'

/** A write in flight — one at a time, whatever the view. */
export type WriteKind = 'offering-create' | 'offering-delete' | 'offering-update' | 'resource-create'

/** An offering being written: the saved one it edits (null creates) and the draft. */
export interface OfferingSession {
  target: null | OwnOffering
  draft: OfferingDraft
}

/** What the last write did, shown atop its list until the next one. */
export interface Notice {
  view: View
  text: string
}

/** A handler whose identity never changes but always runs the latest body —
 *  so memoized rows and cards keep their props across renders. */
export function useStable<A extends unknown[], R>(body: (...args: A) => R): (...args: A) => R {
  const latest = useRef(body)

  latest.current = body

  return useCallback((...args: A) => latest.current(...args), [])
}

export function stampedSlot<T>(stamped: null | Stamped<T> | undefined): Slot<T> {
  return stamped ? { data: stamped.data, at: stamped.at, error: null, loading: false } : emptySlot<T>()
}
