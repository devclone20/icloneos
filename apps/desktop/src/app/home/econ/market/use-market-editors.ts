import { type RefObject, useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import type { AcpResult } from '../cli'

import { type MarketAgent, type MarketJob, type MarketResource, type OwnOffering } from './market-data'
import {
  checkOffering,
  checkResource,
  emptyResourceDraft,
  offeringDeleteArgv,
  type OfferingValues,
  resourceCreateArgv,
  type ResourceDraft,
  writtenId
} from './market-editor'
import { type Notice, type OfferingSession, useStable, type View, type WriteKind } from './market-shared'

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName))
}

/** Keys belong to this window only when focus is inside it, or nowhere. */
function ownsKey(root: HTMLElement | null, target: EventTarget | null): boolean {
  return Boolean(root) && (target === document.body || (target instanceof Node && root!.contains(target)))
}

export function useMarketEditors({
  offerSession,
  offeringArgv,
  runWrite,
  loadOfferings,
  setOfferSession,
  setOffering,
  setNotice,
  setWriteError,
  setResourceDraft,
  resourceDraft,
  loadResources,
  setResource,
  rootRef,
  setAgent,
  setJob,
  setView
}: {
  offerSession: OfferingSession | null
  offeringArgv: (session: OfferingSession, values: OfferingValues) => null | string[]
  runWrite: (kind: WriteKind, argv: string[]) => Promise<AcpResult<unknown> | null>
  loadOfferings: (force: boolean) => Promise<AcpResult<OwnOffering[]>>
  setOfferSession: Dispatch<SetStateAction<OfferingSession | null>>
  setOffering: Dispatch<SetStateAction<OwnOffering | null>>
  setNotice: Dispatch<SetStateAction<Notice | null>>
  setWriteError: Dispatch<SetStateAction<string | null>>
  setResourceDraft: Dispatch<SetStateAction<ResourceDraft | null>>
  resourceDraft: ResourceDraft | null
  loadResources: (force: boolean) => Promise<AcpResult<MarketResource[]>>
  setResource: Dispatch<SetStateAction<MarketResource | null>>
  rootRef: RefObject<HTMLDivElement | null>
  setAgent: Dispatch<SetStateAction<MarketAgent | null>>
  setJob: Dispatch<SetStateAction<MarketJob | null>>
  setView: Dispatch<SetStateAction<View>>
}) {
  const onSaveOffering = useStable(async () => {
    const session = offerSession
    const values = session ? checkOffering(session.draft).values : null
    const argv = session && values ? offeringArgv(session, values) : null

    if (!session || !values || !argv) {
      return
    }

    const result = await runWrite(session.target ? 'offering-update' : 'offering-create', argv)

    if (!result) {
      return
    }

    const reread = await loadOfferings(true)

    if (!result.ok) {
      return
    }

    const id = writtenId(result) || session.target?.id || ''
    const saved = reread.ok ? reread.data.find(item => item.id === id) : undefined

    setOfferSession(null)
    setOffering(saved ?? null)
    setNotice({
      view: 'offerings',
      text: session.target
        ? `Saved “${values.name}”.`
        : `Created “${values.name}”${values.hidden ? ' — hidden from marketplace search' : ' — buyers can hire it on ACP'}.`
    })
  })

  const onDeleteOffering = useStable(async (target: OwnOffering) => {
    const argv = offeringDeleteArgv(target.id)

    if (!argv) {
      setWriteError('This offering’s id cannot be addressed from here.')

      return
    }

    const result = await runWrite('offering-delete', argv)

    if (!result) {
      return
    }

    await loadOfferings(true)

    if (result.ok) {
      setOffering(current => (current && current.id === target.id ? null : current))
      setNotice({ view: 'offerings', text: `Deleted “${target.name}”.` })
    }
  })

  const onNewResource = useStable(() => {
    setWriteError(null)
    setNotice(null)
    setResourceDraft(emptyResourceDraft())
  })

  const onResourceDraft = useStable((draft: ResourceDraft) => setResourceDraft(current => (current ? draft : current)))

  const onCancelResource = useStable(() => {
    setResourceDraft(null)
    setWriteError(null)
  })

  const onSaveResource = useStable(async () => {
    const values = resourceDraft ? checkResource(resourceDraft).values : null

    if (!values) {
      return
    }

    const result = await runWrite('resource-create', resourceCreateArgv(values))

    if (!result) {
      return
    }

    const reread = await loadResources(true)

    if (!result.ok) {
      return
    }

    const id = writtenId(result)

    setResourceDraft(null)
    setResource((id && reread.ok ? reread.data.find(item => item.id === id) : undefined) ?? null)
    setNotice({ view: 'resources', text: `Published “${values.name}”.` })
  })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        !ownsKey(rootRef.current, event.target)
      ) {
        return
      }

      if (event.key === 'Escape') {
        setAgent(null)
        setOffering(null)
        setResource(null)
        setJob(null)

        return
      }

      if (event.key !== '/' || isEditable(event.target)) {
        return
      }

      event.preventDefault()
      setView('discover')
      window.requestAnimationFrame(() => {
        const input = rootRef.current?.querySelector<HTMLInputElement>('.e-search')

        input?.focus()
        input?.select()
      })
    }

    document.addEventListener('keydown', onKey)

    return () => document.removeEventListener('keydown', onKey)
  }, [rootRef, setAgent, setJob, setOffering, setResource, setView])

  return { onDeleteOffering, onSaveOffering, onCancelResource, onResourceDraft, onSaveResource, onNewResource }
}
