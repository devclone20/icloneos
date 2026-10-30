import { useCallback, useMemo, useState } from 'react'
import { useLocation } from 'react-router'

import { type SettingsGroupId, settingsGroupOf } from './panes'
import { settingsArrivalKey } from './settings-arrival'

/**
 * The open/closed state of the Settings rail groups — the ONE owner of it.
 * Nothing else in Settings holds, derives or overrides which group is open.
 *
 * The rules (owner's design rule 2026-10-20, closing rule 2026-10-28):
 *  1. A cold open with no destination opens nothing: four headings, no rows.
 *  2. An ARRIVAL opens its pane's group (`revealGroup`): opening Settings ON a
 *     pane (a `?tab=` deep link, a palette row, another surface's door), moving
 *     to another pane, or choosing a command-palette row — even for the pane
 *     already on screen (`arrivalKey`, lead ruling 2026-10-28: picking a search
 *     result is an explicit wish to go there; its row then takes the focus).
 *     A sub-tab or any other query rewrite inside the pane on screen
 *     (Providers' Accounts / API keys) is NOT an arrival: a group the person
 *     closed stays closed (owner 2026-10-28).
 *     Arrival only ever opens; it never closes a group and never holds one open.
 *  3. A click on a heading flips that group (`toggleGroup`) — every time, in
 *     any order, including the group that holds the pane on screen. The
 *     person's click is the only thing that closes a group.
 *
 * Rule 3 replaces the old "the active pane's group refuses to close" pin
 * (tester U1-p2b-02): that pin is what made headings stop closing once the
 * person had picked a row under them. Closing the active group leaves its
 * `aria-current` row inside the inert region, which the rail's keyboard walk
 * and the palette's focus hand-off already skip; the next arrival reopens it.
 */

/** Rule 3: flips one group, returning a new set. */
function toggleGroup<G extends string>(expanded: ReadonlySet<G>, group: G): ReadonlySet<G> {
  const next = new Set(expanded)

  if (!next.delete(group)) {
    next.add(group)
  }

  return next
}

/** Rule 2: opens one group; the SAME set back when there is nothing to open, so a no-op never re-renders. */
function revealGroup<G extends string>(expanded: ReadonlySet<G>, group: G | undefined): ReadonlySet<G> {
  return group === undefined || expanded.has(group) ? expanded : new Set([...expanded, group])
}

export interface GroupDisclosure<G extends string> {
  expanded: ReadonlySet<G>
  /** Opens a closed group, closes an open one — always (rule 3). */
  toggle: (group: G) => void
}

export function useGroupDisclosure<G extends string>(
  activePane: string,
  groupOf: (pane: string) => G | undefined,
  revealActiveOnOpen: boolean,
  arrivalKey = ''
): GroupDisclosure<G> {
  const activeGroup = groupOf(activePane)

  // Rule 1 / rule 2 at mount.
  const [expanded, setExpanded] = useState<ReadonlySet<G>>(() =>
    revealGroup(new Set<G>(), revealActiveOnOpen ? activeGroup : undefined)
  )

  // Rule 2 on every later arrival: the pane changed, or a NEW explicit arrival
  // key ('' — a sub-tab — never counts). Derived during render (not in an
  // effect), so the rail never paints one frame with the newly active row
  // still hidden.
  const [seenPane, setSeenPane] = useState(activePane)
  const [seenArrival, setSeenArrival] = useState(arrivalKey)
  const paneChanged = seenPane !== activePane
  const arrivedAgain = seenArrival !== arrivalKey && arrivalKey !== ''

  if (seenArrival !== arrivalKey) {
    setSeenArrival(arrivalKey)
  }

  if (paneChanged || arrivedAgain) {
    setSeenPane(activePane)

    const revealed = revealGroup(expanded, activeGroup)

    if (revealed !== expanded) {
      setExpanded(revealed)
    }
  }

  const toggle = useCallback((group: G) => setExpanded(current => toggleGroup(current, group)), [])

  return useMemo(() => ({ expanded, toggle }), [expanded, toggle])
}

/** The Settings rail's groups: the one hook SettingsView calls. */
export function useSettingsGroups(activePane: string, revealActiveOnOpen: boolean): GroupDisclosure<SettingsGroupId> {
  return useGroupDisclosure(activePane, settingsGroupOf, revealActiveOnOpen, settingsArrivalKey(useLocation()))
}
