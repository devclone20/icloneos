import { atom } from 'nanostores'

/** `true` shows the inherited developer menu on session rows (tabs, windows,
 *  terminal, IDs, branching, projects, archive). Off by default: the Message
 *  sidebar shows the short user menu (U1-p2-05). A Settings › Advanced toggle
 *  is the intended writer. */
export const $developerSessionMenu = atom(false)
