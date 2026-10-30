import { SETTINGS_ROUTE } from '../routes'

/**
 * An explicit arrival at a Settings pane from outside the pane itself — the
 * person chose a command-palette row (a search hit, a pane, a section) — even
 * when it is the pane already on screen (lead ruling 2026-10-28). It rides on
 * the navigation's `location.state`, so a sub-tab or any other query rewrite
 * inside the pane (no state) is never mistaken for one.
 */
const SETTINGS_ARRIVAL_STATE = Object.freeze({ settingsArrival: true as const })

/** The navigate options a palette row passes: the arrival marker on a Settings route, nothing elsewhere. */
export function settingsArrivalOptions(path: string): { state: typeof SETTINGS_ARRIVAL_STATE } | undefined {
  return path === SETTINGS_ROUTE || path.startsWith(`${SETTINGS_ROUTE}?`)
    ? { state: SETTINGS_ARRIVAL_STATE }
    : undefined
}

/** The current location's arrival key: its own key when it is an explicit arrival, '' otherwise. */
export function settingsArrivalKey(location: { key: string; state: unknown }): string {
  const state = location.state as { settingsArrival?: unknown } | null | undefined

  return state?.settingsArrival === true ? location.key : ''
}
