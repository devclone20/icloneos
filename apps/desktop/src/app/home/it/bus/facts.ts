/**
 * Branch and ports for the sidebar's per-pane line. Only the panes of the
 * workspace on screen are probed, every 5 s, and only while the window is
 * visible; a hidden workspace keeps showing what was last seen (probes for
 * hidden workspaces = 0 is a gate). The directory itself is the one the
 * session already tracks (OSC 7 / the PTY cwd probe), not probed again.
 */
import { map } from 'nanostores'
import { useEffect } from 'react'

import { $terminals } from '../engine/terminals'

import { paneBus, type PaneFacts, parsePaneFacts } from './bridge'

const PANE_PROBE_INTERVAL_MS = 5_000

export const $paneFacts = map<Record<string, PaneFacts>>({})

/** One probe round for these panes. */
async function probePanes(terminalIds: readonly string[]): Promise<void> {
  const bus = paneBus()

  if (!bus || !terminalIds.length) {
    return
  }

  const pool = $terminals.get()

  const inputs = terminalIds.map(paneId => {
    const term = pool.find(entry => entry.id === paneId)

    return { paneId, cwd: term?.restoreCwd || term?.cwd || null }
  })

  for (const facts of parsePaneFacts(await bus.probe(inputs))) {
    $paneFacts.setKey(facts.paneId, facts)
  }
}

/** Probe the visible workspace's panes while `enabled`; nothing runs otherwise. */
export function useVisiblePaneProbe(terminalIds: readonly string[], enabled: boolean): void {
  const key = terminalIds.join('|')

  useEffect(() => {
    if (!enabled || !key) {
      return
    }

    const ids = key.split('|')

    const tick = () => {
      if (document.visibilityState === 'visible') {
        void probePanes(ids)
      }
    }

    tick()
    const timer = window.setInterval(tick, PANE_PROBE_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [enabled, key])
}
