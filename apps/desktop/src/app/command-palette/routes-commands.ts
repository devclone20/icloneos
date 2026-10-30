/**
 * The "Go to" rows are READ FROM THE ROUTE REGISTRY, never listed here.
 *
 * Twice in one day the pages under this palette moved (E3d1 removed four,
 * E3d2/E3d3 rebuilt six), and both times the hard-coded list kept offering
 * doors that no longer led anywhere. So the rows are `appRoutes()` — a page
 * that stops declaring its route stops appearing, with no edit in this file —
 * and this module only says how a route PRESENTS.
 *
 * The map is keyed by `AppRouteId`, so a new page cannot be registered without
 * tsc stopping here for its label; a deliberate `null` is how a route says it
 * is not a palette destination, and must say why.
 */

import type { Translations } from '@/i18n'
import { Clock, type IconComponent, Plus, Settings, Wrench } from '@/lib/icons'

import { type AppRouteId, appRoutes } from '../routes'

import type { PaletteItem } from './types'

interface RouteCommand {
  /** Keybind action id, so the row shows the combo that really runs it. */
  action?: string
  icon: IconComponent
  keywords?: string[]
  label: (t: Translations) => string
  /** Curated order inside the group; equal ranks keep registry (id) order. */
  rank: number
}

const ROUTE_COMMANDS: Record<AppRouteId, null | RouteCommand> = {
  // The agents spawn tree is a developer surface, not a product door (U2-p2-05).
  agents: null,
  cron: {
    action: 'nav.cron',
    icon: Clock,
    keywords: ['schedule', 'jobs'],
    label: t => t.shell.statusbar.cron,
    rank: 50
  },
  /**
   * The home stage is the app's ground floor, not a command: every overlay
   * closes onto it (Esc, ✕) and the Dock is how you reach it on purpose. It
   * also has no label of its own in i18n, and this front may not add one.
   */
  home: null,
  new: {
    action: 'session.new',
    icon: Plus,
    keywords: ['chat', 'create', 'session'],
    label: t => t.commandCenter.nav.newChat.title,
    rank: 10
  },
  settings: { action: 'nav.settings', icon: Settings, label: t => t.commandCenter.nav.settings.title, rank: 20 },
  skills: {
    action: 'nav.skills',
    icon: Wrench,
    keywords: ['skills', 'tools', 'toolsets', 'mcp', 'capabilities'],
    label: t => t.commandCenter.nav.skills.title,
    rank: 30
  }
}

/**
 * Every registered destination as a palette row, in curated order.
 * `run` is built by the caller so navigation stays the body's business.
 */
export function routeCommands(t: Translations, run: (path: string) => () => void): PaletteItem[] {
  return appRoutes()
    .map(route => ({ command: ROUTE_COMMANDS[route.id], route }))
    .filter((entry): entry is { command: RouteCommand; route: (typeof entry)['route'] } => entry.command !== null)
    .sort((a, b) => a.command.rank - b.command.rank)
    .map(({ command, route }) => ({
      action: command.action,
      icon: command.icon,
      id: `nav-${route.id}`,
      keywords: command.keywords,
      label: command.label(t),
      run: run(route.path)
    }))
}
