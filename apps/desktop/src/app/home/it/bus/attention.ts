/**
 * Pane-level attention. A pane that needs input says so — through `it bus
 * attention`, a terminal bell, or an OSC 9 / OSC 777 notification — and its
 * slot wears a steady ring until the owner focuses it (owner rule: steady,
 * never blinking). Main holds the state; this store mirrors it so the slot and
 * the sidebar paint without a round trip, and a local signal paints at once.
 */
import { map } from 'nanostores'

import { $itInstances, $itSurfaceOpen, activeItWorkspace } from '../../it-store'

import { paneBus, type PaneSummary, parsePaneSummary, type RendererSignalSource } from './bridge'

export const $paneStates = map<Record<string, PaneSummary>>({})

function upsert(summary: PaneSummary): void {
  $paneStates.setKey(summary.paneId, summary)
}

/** The pane the owner is looking at right now, if the iT surface is on screen. */
function lookedAtPane(): null | string {
  return $itSurfaceOpen.get() ? (activeItWorkspace()?.focusTerminalId ?? null) : null
}

/** A bell or an OSC notification came out of a pane's shell. */
export function reportPaneSignal(paneId: string, text: string, source: RendererSignalSource): void {
  if (paneId === lookedAtPane()) {
    return
  }

  const current = $paneStates.get()[paneId]

  if (current) {
    upsert({ ...current, state: 'needs-input', signal: { text, at: Date.now(), source } })
  }

  void paneBus()?.signal(paneId, text, source)
}

function clearLookedAt(): void {
  const paneId = lookedAtPane()

  if (!paneId) {
    return
  }

  const current = $paneStates.get()[paneId]

  if (current?.state === 'needs-input') {
    upsert({ ...current, state: 'running' })
    void paneBus()?.clear(paneId)
  }
}

let started = false

/** Idempotent; the iT wiring calls it once per window. */
export function initPaneAttention(): void {
  const bus = paneBus()

  if (started || !bus) {
    return
  }

  started = true

  bus.onChange(raw => {
    const summary = parsePaneSummary(raw)

    if (summary) {
      upsert(summary)

      if (summary.paneId === lookedAtPane()) {
        clearLookedAt()
      }
    }
  })

  void bus.snapshot().then(list => {
    for (const raw of Array.isArray(list) ? list : []) {
      const summary = parsePaneSummary(raw)

      if (summary) {
        upsert(summary)
      }
    }
  })

  $itInstances.subscribe(clearLookedAt)
  $itSurfaceOpen.subscribe(clearLookedAt)
}
