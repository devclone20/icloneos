import { HOME_ROUTE } from '@/app/routes'
import { isAuxiliaryWindow } from '@/store/windows'

const EMPTY_HASHES = new Set(['', '#', '#/'])

/** The hash a window must boot on, or null to keep the one it has. The main
 *  window opens on the home stage; a deep link (any non-empty hash) and every
 *  auxiliary window (HUD, popped-out browser, secondary session) keep theirs. */
export function bootHash(hash: string, auxiliary: boolean): null | string {
  return !auxiliary && EMPTY_HASHES.has(hash) ? `#${HOME_ROUTE}` : null
}

/** Runs before the router mounts, so the very first render is already the home
 *  route — the chat route never gets a frame. replaceState: no history entry,
 *  no hashchange event. */
export function applyBootRoute(target: Window = window, auxiliary = isAuxiliaryWindow()): void {
  const next = bootHash(target.location.hash, auxiliary)

  if (next) {
    target.history.replaceState(target.history.state, '', next)
  }
}
