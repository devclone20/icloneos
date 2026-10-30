/**
 * THE ROUTE REGISTRY.
 *
 * This file no longer lists the app's pages. Every page declares its own route
 * in its own module — `src/app/<page>/route.ts`, one `AppRoute` descriptor —
 * and this file only COLLECTS them. A front that rebuilds a page therefore
 * never has to write this shared file, so the page fronts don't contend on it.
 *
 * Two properties the collection guarantees:
 *  - order-independent: descriptors are sorted by `id` before anything reads
 *    them, so no behaviour depends on the order the bundler evaluates modules;
 *  - collision-proof: two pages claiming one path throw at module init (the app
 *    fails to boot, loudly) and fail `routes.test.ts`, which also pins every
 *    exported path constant against the registry — so a typo or a duplicate is
 *    a red gate, not a silent 404.
 *
 * A page's `route.ts` may import from here with `import type` ONLY: a value
 * import would close a cycle (this module eagerly imports every `route.ts`).
 */

import { atom } from 'nanostores'
import type { ReactNode } from 'react'

import { noteActiveTreeGroup, revealTreePane } from '@/components/pane-shell/tree/store'
import { registry } from '@/contrib/registry'

type NavigateLike = (to: string, options?: { replace?: boolean; state?: unknown }) => void

const SESSION_ROUTE_PREFIX = '/'

// The URL vocabulary. Frozen surface: every module that navigates imports the
// constant from here, never a bare string, and a page's descriptor repeats the
// same literal (`routes.test.ts` proves the two agree).
export const NEW_CHAT_ROUTE = '/'
export const SETTINGS_ROUTE = '/settings'
export const HOME_ROUTE = '/home'
export const SKILLS_ROUTE = '/skills'
export const CRON_ROUTE = '/cron'
// Profiles is a Settings TOPIC, not a page the user travels to (front K3, the
// owner's request): its pane renders inside the Settings body, and
// this is the target every door uses — the profile rail's `Manage profiles…`
// pill and the `nav.profiles` action. `?tab=` is the Settings rail's param.
export const PROFILES_PANE = `${SETTINGS_ROUTE}?tab=profiles`
// Messaging and Command Center are Settings TOPICS too (front K5, the owner's
// 2026-10-20 order to move Command Center whole): their panes render inside
// the Settings body and these are the targets every door uses — the
// `nav.messaging` / `nav.commandCenter` actions and `toggleCommandCenter`.
// Command Center's four sections keep riding `&section=` on this target, so
// `?tab=command-center&section=usage` still deep-links a section.
export const MESSAGING_PANE = `${SETTINGS_ROUTE}?tab=messaging`
/** The Settings rail id of the Command Center pane. Exported because
 *  `useOverlayRouting` has to recognise "the pane is showing" from the URL,
 *  and a second spelling of the tab id is how that goes quietly wrong. */
export const COMMAND_CENTER_PANE_TAB = 'command-center'
export const COMMAND_CENTER_PANE = `${SETTINGS_ROUTE}?tab=${COMMAND_CENTER_PANE_TAB}`
export const AGENTS_ROUTE = '/agents'

// Pages the owner removed (E3 contract §6 decisions #8/#16). The page code is
// GONE — nothing can render them — but their paths stay RESERVED and their
// constants stay exported:
//  - a path that simply disappeared would fall through to the session-id
//    parser, so `/starmap` would read as the session "starmap" and the app
//    would try to resume a chat that never existed;
//  - the doors that still navigate here (a command-palette entry, a sidebar
//    row, a keybind, a slash command) live in files other fronts own; they
//    keep compiling and now land on home instead of a blank page, and each one
//    is deleted with the page rebuild that owns it.
// A removed path resolves to `home` and no `route.ts` may re-declare it.
export const ARTIFACTS_ROUTE = '/artifacts'
export const STARMAP_ROUTE = '/starmap'
export const WEBHOOKS_ROUTE = '/webhooks'
// `/profiles` is reserved for a different reason: the page did not go, it
// MOVED (front K3). Profiles is a Settings topic now and no `route.ts`
// declares this path any more — but it stays reserved so a stale bookmark can
// never read as the session "profiles". The address itself lands on home like
// every other removed path (measured on lab 2, 2026-10-20): no redirect exists
// and none can, because the resolution below happens before the chat surface
// routes. The pane's address is `PROFILES_PANE`.
export const PROFILES_ROUTE = '/profiles'
// `/messaging` and `/command-center` are reserved for the same reason as
// `/profiles`: the pages MOVED (front K5), they were not removed. No
// `route.ts` declares either path any more and nothing can render them
// outside Settings; the paths stay reserved so a stale bookmark can never
// read as the session "messaging" or "command-center".
// WHERE A MOVED ADDRESS LANDS, corrected 2026-10-20 (front K5 r2): it lands on
// its PANE, not on home. `appViewForPath` still answers `home` for the path —
// that is the VIEW a retired path resolves to, and the chat surface must never
// read it as a session id — but the shell redirects the location itself
// (`useOverlayRouting`, by `MOVED_ROUTE_PANES` below), carrying `?section=`
// through. An earlier draft of this comment said "no redirect exists and none
// can": that was false. It confused the view resolution, which happens before
// the chat surface routes, with a navigation, which happens after the shell
// mounts — and it left four doors landing on home.
export const MESSAGING_ROUTE = '/messaging'
export const COMMAND_CENTER_ROUTE = '/command-center'

export const REMOVED_ROUTES: readonly string[] = [
  ARTIFACTS_ROUTE,
  COMMAND_CENTER_ROUTE,
  MESSAGING_ROUTE,
  PROFILES_ROUTE,
  STARMAP_ROUTE,
  WEBHOOKS_ROUTE
]

// The views those pages used to render. `isOverlayView` must keep reporting them
// as overlays even though no route declares them any more: a removed view must
// never uncover the legacy Hermes shell (legacyShellMode would turn 'live').
/** Retired paths that MOVED into a Settings pane, mapped to that pane. A
 *  bookmark, an external link or a door that still addresses the old path is
 *  sent here instead of to home; `?section=` is carried through by the shell.
 *  `/profiles` is deliberately NOT listed: front K3 measured and documented it
 *  landing on home, and `profiles/settings-home.test.tsx` pins that — moving it
 *  here is a one-line change that belongs to whoever owns that test.
 *  NOT exported: `movedRoutePane()` below is the only reader, and the whole
 *  point of the function is that the shell and its test read ONE rule. */
const MOVED_ROUTE_PANES: Readonly<Record<string, string>> = {
  [COMMAND_CENTER_ROUTE]: COMMAND_CENTER_PANE,
  [MESSAGING_ROUTE]: MESSAGING_PANE
}

/** The Settings pane a retired, MOVED path resolves to, or `null` for a path
 *  that did not move. `to` is a full location (`/command-center?section=usage`),
 *  and the one query param the old overlays carried — `section` — survives the
 *  hop. Pure, so the shell's redirect and its test read the same rule. */
export function movedRoutePane(to: string): null | string {
  const path = routePathname(to)
  const pane = MOVED_ROUTE_PANES[path]

  if (!pane) {
    return null
  }

  // Everything after the path, hash dropped: `URLSearchParams` would otherwise
  // read `?section=usage#x` as the section "usage#x".
  const query = to.slice(path.length).split('#')[0]
  const section = new URLSearchParams(query).get('section')

  return section ? `${pane}&section=${encodeURIComponent(section)}` : pane
}

const REMOVED_ROUTE_VIEWS: readonly AppView[] = [
  'artifacts',
  'command-center',
  'messaging',
  'profiles',
  'starmap',
  'webhooks'
]

export type AppView =
  | 'agents'
  // Removed pages (§6 #8/#16). No route declares these views, so
  // `appViewForPath` never returns one and every `currentView === 'artifacts'`
  // style door outside this module is inert. They stay in the union only so
  // those doors keep compiling until the fronts that own them delete the door
  // with the page rebuild; a new page must never reuse one.
  | 'artifacts'
  | 'chat'
  // Moved, not removed: Command Center is a Settings topic (front K5). No
  // route declares this view; it stays so the reserved path keeps an overlay
  // view and never uncovers the legacy shell.
  | 'command-center'
  | 'cron'
  // A contributed (plugin) full page at its own route — NOT chat. Without this
  // distinction contributed paths fell through appViewForPath's 'chat' default,
  // so the sidebar kept a session highlighted and the titlebar kept the
  // session-title dropdown while a plugin page was showing.
  | 'extension'
  | 'home'
  // Moved, not removed: Messaging is a Settings topic (front K5). Same rule
  // as `command-center` above.
  | 'messaging'
  // Moved, not removed: Profiles is a Settings topic (front K3). No route
  // declares this view; it stays so the reserved path keeps an overlay view.
  | 'profiles'
  | 'settings'
  | 'skills'
  | 'starmap'
  | 'webhooks'

export type AppRouteId = 'agents' | 'cron' | 'home' | 'new' | 'settings' | 'skills'

export interface AppRoute {
  id: AppRouteId
  path: string
  view: AppView
  /**
   * The view renders as a full-screen modal card (OverlayView) over the shell
   * instead of inside the workspace pane. Overlays get the shared card + ✕ +
   * Esc and closing returns exactly where the user was (see useOverlayRouting's
   * return stack — Settings survives the round-trip at its very pane, `?tab=`
   * rides the URL). A page WITHOUT this flag is a one-way trip into the
   * workspace, which the owner has banned twice.
   */
  overlay?: boolean
}

// The app's own shell destinations (not pages): they have no page module to
// declare them, so they live here.
const CORE_ROUTES = [
  { id: 'new', path: NEW_CHAT_ROUTE, view: 'chat' },
  { id: 'home', path: HOME_ROUTE, view: 'home' },
  { id: 'settings', path: SETTINGS_ROUTE, view: 'settings', overlay: true }
] as const satisfies readonly AppRoute[]

// Every page's own declaration. Eager so the registry is complete before the
// first render (a lazy glob would 404 a deep link on a cold start).
//
// What a declaration does NOT do: this registry CLASSIFIES a path (view,
// overlay, reserved). What RENDERS a page is still wired by hand in two files
// E3a owns — `contrib/surfaces.tsx` (the <Route> stub, which still carries
// stubs for the three removed paths) and `contrib/wiring.tsx` (the lazy import
// + overlay mount). Declaring a route.ts alone shows nothing on screen; those
// two edits go through the lead / E3a, never through this file.
const PAGE_ROUTE_MODULES = import.meta.glob<{ route: AppRoute }>('./*/route.ts', { eager: true })

function collectAppRoutes(): readonly AppRoute[] {
  const byPath = new Map<string, string>()
  const collected: AppRoute[] = []

  for (const [moduleId, module] of Object.entries(PAGE_ROUTE_MODULES)) {
    const route = module?.route

    if (!route || typeof route.path !== 'string' || !route.path.startsWith('/')) {
      throw new Error(`Route registry: ${moduleId} must export \`route\` with an absolute \`path\`.`)
    }

    collected.push(route)
    byPath.set(route.path, moduleId)
  }

  for (const route of CORE_ROUTES) {
    byPath.set(route.path, 'app/routes.ts')
    collected.push(route)
  }

  for (const path of REMOVED_ROUTES) {
    if (byPath.has(path)) {
      throw new Error(`Route registry: ${byPath.get(path)} re-declares the removed path ${path}.`)
    }

    byPath.set(path, 'app/routes.ts (removed)')
  }

  // Sorting by id makes every consumer order-independent: the bundler may
  // evaluate the page modules in any order, and two pages that collide are a
  // boot failure rather than a last-one-wins mystery.
  collected.sort((a, b) => a.id.localeCompare(b.id))

  if (byPath.size !== collected.length + REMOVED_ROUTES.length) {
    const seen = new Set<string>()
    const duplicates = collected.map(route => route.path).filter(path => !seen.add(path))

    throw new Error(`Route registry: duplicate path(s) ${[...new Set(duplicates)].join(', ')}.`)
  }

  return collected
}

const APP_ROUTES = collectAppRoutes()
const APP_VIEW_BY_PATH = new Map<string, AppView>(APP_ROUTES.map(route => [route.path, route.view]))
const RESERVED_PATHS: ReadonlySet<string> = new Set([...APP_ROUTES.map(route => route.path), ...REMOVED_ROUTES])

const OVERLAY_VIEWS: ReadonlySet<AppView> = new Set([
  ...APP_ROUTES.filter(route => route.overlay).map(route => route.view),
  ...REMOVED_ROUTE_VIEWS
])

/** Every route the app answers, sorted by id. Read-only: declare a page's route
 *  in the page's own `route.ts`, never by pushing into this. */
export function appRoutes(): readonly AppRoute[] {
  return APP_ROUTES
}

// ── Contributed routes — the `routes` registry area ─────────────────────────
// A contribution mounts a FULL PAGE in the workspace pane at `data.path`
// (`render` on the contribution itself, like every other area). Contributed
// paths are reserved exactly like APP_ROUTES so the session-id parser never
// mistakes them for a session route. Navigate with `host.navigate(path)`.

export const ROUTES_AREA = 'routes'

/** Payload of a `routes` contribution's `data`. */
export interface RouteContribution {
  /** Absolute path, e.g. `/kanban`. One segment; no params. */
  path: string
}

export function contributedRoutes(): Array<{ key: string; path: string; title?: string; render: () => ReactNode }> {
  return registry
    .getArea(ROUTES_AREA)
    .map(c => ({
      key: `${c.source ?? 'core'}:${c.id}`,
      path: (c.data as RouteContribution | undefined)?.path ?? '',
      title: c.title,
      render: c.render!
    }))
    .filter(route => Boolean(route.path.startsWith('/') && route.render) && !RESERVED_PATHS.has(route.path))
}

function isContributedPath(pathname: string): boolean {
  return contributedRoutes().some(route => route.path === pathname)
}

// ── Contributed sidebar nav — the `sidebar.nav` registry area ────────────────
// A DATA contribution adds a row to the sidebar's top nav. Pair with a
// ROUTES_AREA page: the row navigates to `path` and lights up while the app is
// there.

export const SIDEBAR_NAV_AREA = 'sidebar.nav'

/** Payload of a `sidebar.nav` data contribution. */
export interface SidebarNavContribution {
  /** Codicon name, e.g. `'project'`. */
  codicon: string
  label: string
  /** Route to navigate to (usually a contributed page's path). */
  path: string
}

export function isOverlayView(view: AppView): boolean {
  return OVERLAY_VIEWS.has(view)
}

/** The pathname of a router target. Every classifier below reasons about a
 *  PATH, but callers navigate to full targets (`/skills?tab=mcp`), and an
 *  unstripped query reaches the session-id parser — `/skills?tab=mcp` reads as
 *  the session `skills?tab=mcp`, so Capabilities classifies as a chat.
 *  `sessionRoute` percent-encodes ids, so `?`/`#` can only start a query or a
 *  hash. */
export function routePathname(to: string): string {
  const cut = to.search(/[?#]/)

  return cut === -1 ? to : to.slice(0, cut)
}

/** Is `target` the address on screen? `target` is a nav row's destination, so
 *  it may carry a query (`/settings?tab=messaging`): the path must be the same
 *  and every parameter the destination NAMES must hold, while parameters the
 *  location adds on top (`&section=usage`) do not unmake it. A row whose
 *  destination became a Settings pane can only light up through this: comparing
 *  it to a bare pathname never matches, which is how the Messaging indicator
 *  went dark when its page moved (lead ruling §6.2).
 *  A RETIRED destination is never showing, whatever the location says: see the
 *  gate below. */
export function routeIsShowing(target: string, pathname: string, search: string): boolean {
  const path = routePathname(target)

  // A retired address answers with no page of its own — `/artifacts` resolves
  // to the `home` view — so the location can read `/artifacts` while the home
  // stage paints, and a row that lit on the address alone claimed to be showing
  // a surface that is not on screen (critic, K5 r3). A path that MOVED is the
  // opposite case and is deliberately excluded: the shell replaces the location
  // with the pane before any row can light, so Messaging stays correct.
  if (REMOVED_ROUTES.includes(path) && !movedRoutePane(path)) {
    return false
  }

  if (path !== routePathname(pathname)) {
    return false
  }

  const wanted = new URLSearchParams(target.slice(path.length).replace(/^[?#]/, ''))
  const here = new URLSearchParams(search)

  return [...wanted].every(([key, value]) => here.get(key) === value)
}

export function isNewChatRoute(pathname: string): boolean {
  return routePathname(pathname) === NEW_CHAT_ROUTE
}

export function routeSessionId(pathname: string): string | null {
  const path = routePathname(pathname)

  if (!path.startsWith(SESSION_ROUTE_PREFIX) || RESERVED_PATHS.has(path) || isContributedPath(path)) {
    return null
  }

  const id = path.slice(SESSION_ROUTE_PREFIX.length)

  return id && !id.includes('/') ? decodeURIComponent(id) : null
}

/**
 * The primary composer's durable scope key candidate: the route is the source
 * of truth for which chat is on screen, so prefer its (stable) stored session
 * id over a store selection that can be momentarily null/stale mid-switch
 * (#59305). A genuine new-chat route always wins with `null`, never falling
 * back to a leftover selection from the chat just left. A non-chat route
 * (settings, an overlay) has no session opinion, so the store selection passes
 * through unchanged.
 */
export function primaryRouteSelectedSessionId(pathname: string, storeSelectedSessionId: string | null): string | null {
  if (isNewChatRoute(pathname)) {
    return null
  }

  return routeSessionId(pathname) ?? storeSelectedSessionId
}

export function sessionRoute(sessionId: string): string {
  return `${SESSION_ROUTE_PREFIX}${encodeURIComponent(sessionId)}`
}

export function appViewForPath(pathname: string): AppView {
  const path = routePathname(pathname)

  if (isNewChatRoute(path) || routeSessionId(path)) {
    return 'chat'
  }

  if (isContributedPath(path)) {
    return 'extension'
  }

  if (REMOVED_ROUTES.includes(path)) {
    return 'home'
  }

  return APP_VIEW_BY_PATH.get(path) ?? 'chat'
}

/** Does `to` land on a full page rendered INSIDE the workspace pane
 *  (contributed routes)? Overlays don't count — they float over whatever the
 *  workspace is already showing. */
function isWorkspacePageRoute(to: string): boolean {
  const path = routePathname(to)

  // A removed page's path resolves to home, which IS a workspace route — but a
  // stale `/artifacts` link must not front the workspace pane over whatever the
  // user was looking at, exactly as it did not when the page was still an
  // overlay. Pinned by routes.workspace-reveal.test.ts.
  if (REMOVED_ROUTES.includes(path)) {
    return false
  }

  const view = appViewForPath(path)

  return view !== 'chat' && !isOverlayView(view)
}

/** True while the workspace pane shows a FULL PAGE (plugin routes) instead of
 *  the chat. Published by the wiring (which owns the router location); the
 *  workspace pane contribution mirrors it as `headerVeto` so the zone tab bar
 *  stands down on pages. Overlays (settings/…) don't count — the chat stays
 *  beneath them. */
export const $workspaceIsPage = atom(false)

function revealWorkspacePane(): void {
  noteActiveTreeGroup(null)
  revealTreePane('workspace')
}

/**
 * Point the workspace at `pathname`: mirror "showing a full page" into
 * `$workspaceIsPage`, and FRONT the pane when it is one.
 *
 * A page renders inside `workspace`, so a main zone parked on a session tile
 * keeps the tile on screen while the route and the page content change behind
 * it — the navigation looks dead (#72602). Session switches already front the
 * pane in `store/session-states.ts`; pages had no equivalent.
 *
 * The router location drives this, so every entry point gets it without opting
 * in: sidebar, keybinds, command palette, Command Center, contributed `to`
 * targets, back/forward, and cold-start restore.
 */
export function syncWorkspaceRoute(pathname: string): void {
  const isPage = isWorkspacePageRoute(pathname)

  if (isPage !== $workspaceIsPage.get()) {
    $workspaceIsPage.set(isPage)
  }

  if (isPage) {
    revealWorkspacePane()
  }
}

/**
 * Navigate to `to`, fronting the workspace pane when it is a page route.
 *
 * `syncWorkspaceRoute` covers route CHANGES; this covers the RE-CLICK, the one
 * case it can't see — hitting a page affordance while already on that page with
 * a tile focused leaves the location untouched, so no effect fires and only an
 * imperative reveal brings the page back. Use it wherever a nav affordance can
 * be triggered from the page it targets.
 */
export function navigateToWorkspacePage(
  navigate: NavigateLike,
  to: string,
  options?: { replace?: boolean; state?: unknown }
): void {
  navigate(to, options)

  if (isWorkspacePageRoute(to)) {
    revealWorkspacePane()
  }
}
