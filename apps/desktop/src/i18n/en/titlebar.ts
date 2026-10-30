import type { Translations } from '../types'

export const titlebar: Translations['titlebar'] = {
  hideSidebar: 'Hide sidebar',
  showSidebar: 'Show sidebar',
  search: 'Search',
  searchTitle: 'Search sessions, views, and actions',
  swapSidebarSides: 'Swap sidebar sides',
  hideRightSidebar: 'Hide right sidebar',
  showRightSidebar: 'Show right sidebar',
  unreadSessions: count => (count === 1 ? '1 unread session' : `${count} unread sessions`),
  muteHaptics: 'Mute haptics',
  unmuteHaptics: 'Unmute haptics',
  openSettings: 'Open settings',
  openStarmap: 'Open memory graph',
  enterHud: 'HUD mode',
  exitHud: 'Exit HUD mode',
  resetHudLayout: 'Reset HUD size and position',
  layoutEditor: 'Layout editor',
  layoutEditorTitle: mod => `Layout editor — ${mod}-click resets the layout`
}
