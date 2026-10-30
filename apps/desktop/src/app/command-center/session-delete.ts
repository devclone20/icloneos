import { atom } from 'nanostores'

/**
 * The session DELETE the Command Center pane cannot build for itself.
 *
 * Command Center became a Settings topic in front K5, so it no longer gets
 * props from `contrib/wiring.tsx`. Its delete is not a REST call: the
 * controller's `removeSession` resolves the owning profile, covers the
 * messaging/cron sidebar slices and the archived store, and refuses rather
 * than deleting against the wrong backend when ownership cannot be resolved.
 * Re-implementing that in a pane would silently drop those branches, so the
 * controller publishes it here and the pane reads it — the same crossing
 * `$newSessionTabAction` already makes for the tab strip.
 *
 * `null` until the controller mounts: the pane then renders NO delete control
 * rather than a button that does nothing (the presence rule
 * `contrib/latest-actions.ts` states for optional handlers).
 */
export const $commandCenterSessionDelete = atom<null | ((sessionId: string) => Promise<void> | void)>(null)
