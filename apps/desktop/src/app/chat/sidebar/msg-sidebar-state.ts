import { atom } from 'nanostores'

/** The Message window's sessions sidebar (D3): `true` = the conversation list
 *  is on stage. A store, not window state, so the ⌘B keybind (and the `it` CLI)
 *  can reach it. In-memory only — every window open starts collapsed (owner
 *  rule): the window resets it on mount. */
export const $msgSidebarOpen = atom(false)

export function setMsgSidebarOpen(open: boolean): void {
  $msgSidebarOpen.set(open)
}

export function toggleMsgSidebar(): void {
  $msgSidebarOpen.set(!$msgSidebarOpen.get())
}
