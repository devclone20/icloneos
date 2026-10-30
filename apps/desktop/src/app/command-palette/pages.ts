/**
 * The palette's nested pages — the id list, and the only ids a door may name.
 *
 * `openCommandPalettePage(id)` is called from modules that know nothing about
 * this file (a slash command, a Settings keystroke, a keybind), and a door
 * naming a page that was deleted used to fall through to the ROOT list in
 * silence: the deleted page kept a live label and nothing failed. So the ids
 * are declared ONCE here, `PaletteItem.to` is typed with them (an in-tree door
 * into a page that does not exist is a tsc error) and `isPalettePage` turns an
 * out-of-tree one into a loud failure instead of a quiet root list.
 */

export const PALETTE_PAGES = ['color-mode', 'install-theme', 'settings', 'theme'] as const

export type PalettePageId = (typeof PALETTE_PAGES)[number]

export function isPalettePage(value: string): value is PalettePageId {
  return (PALETTE_PAGES as readonly string[]).includes(value)
}
