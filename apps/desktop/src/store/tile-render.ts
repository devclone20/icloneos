import { atom } from 'nanostores'

/**
 * Is a pane mounted that can render a session tile? Not in this version: the
 * pane shell is gone (the routes mount only the chat), so a tile in
 * `$sessionTiles` shows nothing. While this is false, a door that would add a
 * tile acts on the main chat, and a stored tile never counts as on screen. A pane
 * shell that renders tiles again sets it true when it mounts.
 */
export const $sessionTilesRender = atom(false)
