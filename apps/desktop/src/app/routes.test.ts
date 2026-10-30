import { describe, expect, it } from 'vitest'

import {
  AGENTS_ROUTE,
  appRoutes,
  appViewForPath,
  ARTIFACTS_ROUTE,
  COMMAND_CENTER_PANE,
  COMMAND_CENTER_ROUTE,
  CRON_ROUTE,
  HOME_ROUTE,
  isNewChatRoute,
  isOverlayView,
  MESSAGING_PANE,
  MESSAGING_ROUTE,
  movedRoutePane,
  NEW_CHAT_ROUTE,
  primaryRouteSelectedSessionId,
  PROFILES_PANE,
  PROFILES_ROUTE,
  REMOVED_ROUTES,
  routeIsShowing,
  routeSessionId,
  sessionRoute,
  SETTINGS_ROUTE,
  SKILLS_ROUTE,
  STARMAP_ROUTE,
  WEBHOOKS_ROUTE
} from './routes'

const SESS_A = 'sess-a'
const SESS_B = 'sess-b'

describe('primaryRouteSelectedSessionId', () => {
  it('prefers the routed session id over a stale/different store selection (#59305)', () => {
    // The route already committed to B while the store selection hasn't
    // caught up yet (still reads A) — the route wins.
    expect(primaryRouteSelectedSessionId(sessionRoute(SESS_B), SESS_A)).toBe(SESS_B)
  })

  it('returns null on the new-chat route even with a leftover selection from the previous chat', () => {
    expect(primaryRouteSelectedSessionId(NEW_CHAT_ROUTE, SESS_A)).toBeNull()
  })

  it('falls back to the store selection on a non-chat route (settings, overlays)', () => {
    expect(primaryRouteSelectedSessionId(SETTINGS_ROUTE, SESS_A)).toBe(SESS_A)
  })

  it('falls back to the store selection when the route matches the same session', () => {
    expect(primaryRouteSelectedSessionId(sessionRoute(SESS_A), SESS_A)).toBe(SESS_A)
  })

  it('returns null on a non-chat route with no store selection', () => {
    expect(primaryRouteSelectedSessionId(SETTINGS_ROUTE, null)).toBeNull()
  })
})

// ── The registry ───────────────────────────────────────────────────────────
// `routes.ts` collects a descriptor from every page's own `route.ts`, so the
// invariants a central table used to give by construction are pinned here
// instead: these cases are the build failure the contract asks for when two
// pages claim one path, when a page stops declaring its route, or when a path
// constant and the page that owns it drift apart.

// Every page route this app answers, with the constant other modules navigate
// by. A page added without its entry here fails the completeness case below.
const PAGE_ROUTES: ReadonlyArray<[string, string]> = [
  ['agents', AGENTS_ROUTE],
  ['cron', CRON_ROUTE],
  ['skills', SKILLS_ROUTE]
]

const CORE_ROUTES: ReadonlyArray<[string, string]> = [
  ['home', HOME_ROUTE],
  ['new', NEW_CHAT_ROUTE],
  ['settings', SETTINGS_ROUTE]
]

describe('route registry', () => {
  it('claims every path exactly once', () => {
    const paths = appRoutes().map(route => route.path)

    expect(paths).toHaveLength(new Set(paths).size)
    expect(paths.some(path => REMOVED_ROUTES.includes(path))).toBe(false)
  })

  it('collects every page that declares a route, and nothing else', () => {
    expect(appRoutes().map(route => [route.id, route.path])).toEqual(
      [...CORE_ROUTES, ...PAGE_ROUTES].sort(([a], [b]) => a.localeCompare(b))
    )
  })

  it('is read in a deterministic order, never the order modules were evaluated', () => {
    const ids = appRoutes().map(route => route.id)

    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)))
  })

  it('resolves each page constant to its own view, so a path typo cannot pass', () => {
    for (const [id, path] of PAGE_ROUTES) {
      expect(appViewForPath(path)).toBe(id)
      expect(appViewForPath(`${path}?tab=mcp`)).toBe(id)
    }
  })

  it('renders every page as a closable overlay, never a full-page trap (owner rule)', () => {
    for (const [, path] of PAGE_ROUTES) {
      expect(isOverlayView(appViewForPath(path))).toBe(true)
    }

    expect(isOverlayView(appViewForPath(HOME_ROUTE))).toBe(false)
    expect(isOverlayView(appViewForPath(NEW_CHAT_ROUTE))).toBe(false)
  })
})

describe('routes the owner removed (contract §6 #8/#16)', () => {
  it('keeps them reserved so the session parser never claims them', () => {
    for (const path of REMOVED_ROUTES) {
      expect(routeSessionId(path)).toBeNull()
    }
  })

  // The premise of the two prefix tests deleted from
  // session/hooks/use-route-resume.ts (lead grant 2026-10-20 05:30): that raw-hash
  // guard runs only behind `isNewChatRoute(locationPathname)`, so a retired
  // address can never reach it and needed no case of its own. Derived from
  // REMOVED_ROUTES, so a route retired later is covered without an edit here.
  it('never presents a retired address as the new-chat route, with or without a query', () => {
    for (const path of REMOVED_ROUTES) {
      expect(isNewChatRoute(path)).toBe(false)
      expect(isNewChatRoute(`${path}?section=usage`)).toBe(false)
    }

    expect(isNewChatRoute(NEW_CHAT_ROUTE)).toBe(true)
  })

  it('lands them on home instead of a blank page or a phantom session', () => {
    for (const path of REMOVED_ROUTES) {
      expect(appViewForPath(path)).toBe('home')
    }
  })

  // Their paths resolve to `home`, so the view can only be named, not derived.
  it('keeps their views overlays, so a stale door can never uncover the legacy shell', () => {
    const removedViews = ['artifacts', 'command-center', 'messaging', 'profiles', 'starmap', 'webhooks'] as const
    const removedSlugs = REMOVED_ROUTES.map(path => path.slice(1))

    for (const view of removedViews) {
      expect(removedSlugs).toContain(view)
      expect(isOverlayView(view)).toBe(true)
    }
  })

  // Profiles is in that list for a different reason (front K3): the page did
  // not go, it became a Settings topic. Its path stays reserved so a stale
  // bookmark cannot read as the session "profiles"; the address itself lands on
  // home like every other removed path (measured on lab 2, 2026-10-20), and the
  // pane is reached through `PROFILES_PANE`.
  // Messaging and Command Center joined it for the same reason in front K5
  // (the owner's 2026-10-20 order moved Command Center whole), so the rule is
  // asserted over all THREE moved paths rather than re-typed per page: a
  // reserved path, no descriptor, no session id, and the view still an overlay
  // so a stale address can never uncover the legacy shell.
  it('reserves the paths of the pages that MOVED into Settings, and declares none', () => {
    for (const path of [COMMAND_CENTER_ROUTE, MESSAGING_ROUTE, PROFILES_ROUTE]) {
      expect(REMOVED_ROUTES).toContain(path)
      expect(routeSessionId(path)).toBeNull()
      expect(appRoutes().some(route => route.path === path)).toBe(false)
      expect(appViewForPath(path)).toBe('home')
    }

    // The panes they moved to, as the doors now address them.
    expect(COMMAND_CENTER_PANE).toBe('/settings?tab=command-center')
    expect(MESSAGING_PANE).toBe('/settings?tab=messaging')
    expect(PROFILES_PANE).toBe('/settings?tab=profiles')
  })

  // `appViewForPath` answering `home` above is the VIEW a retired path
  // resolves to — the chat surface must never read `/messaging` as a session
  // id. WHERE THE USER ENDS UP is a different question, answered here: a path
  // that MOVED resolves to its pane, and the shell navigates there
  // (`useOverlayRouting`). Front K5 r2 — four doors were landing on home
  // because the two questions had been conflated.
  it('resolves a MOVED path to its pane, carrying ?section= through', () => {
    expect(movedRoutePane(MESSAGING_ROUTE)).toBe(MESSAGING_PANE)
    expect(movedRoutePane(COMMAND_CENTER_ROUTE)).toBe(COMMAND_CENTER_PANE)
    expect(movedRoutePane(`${COMMAND_CENTER_ROUTE}?section=usage`)).toBe(`${COMMAND_CENTER_PANE}&section=usage`)
    expect(movedRoutePane(`${COMMAND_CENTER_ROUTE}?section=usage#top`)).toBe(`${COMMAND_CENTER_PANE}&section=usage`)
    expect(movedRoutePane(`${MESSAGING_ROUTE}?section=a%20b`)).toBe(`${MESSAGING_PANE}&section=a%20b`)
  })

  it('leaves every other path alone, moved or not', () => {
    // `/profiles` moved too, but front K3 measured and documented it landing
    // on home and `profiles/settings-home.test.tsx` pins that: listing it is a
    // one-line change that belongs with that test, not here.
    for (const path of [PROFILES_ROUTE, ARTIFACTS_ROUTE, SETTINGS_ROUTE, MESSAGING_PANE, '/', '/some-session']) {
      expect(movedRoutePane(path)).toBeNull()
    }
  })

  it('declares no route for them, so nothing can mount a removed page', () => {
    const removed = [
      ARTIFACTS_ROUTE,
      COMMAND_CENTER_ROUTE,
      MESSAGING_ROUTE,
      PROFILES_ROUTE,
      STARMAP_ROUTE,
      WEBHOOKS_ROUTE
    ]

    expect([...REMOVED_ROUTES].sort()).toEqual([...removed].sort())
    expect(appRoutes().some(route => removed.includes(route.path))).toBe(false)
  })
})

describe('routeIsShowing', () => {
  it('lights a pane row only when its own tab is the one on screen', () => {
    expect(routeIsShowing(MESSAGING_PANE, SETTINGS_ROUTE, '?tab=messaging')).toBe(true)
    expect(routeIsShowing(MESSAGING_PANE, SETTINGS_ROUTE, '?tab=notifications')).toBe(false)
    expect(routeIsShowing(MESSAGING_PANE, SETTINGS_ROUTE, '')).toBe(false)
  })

  it('is not unmade by parameters the location adds on top', () => {
    expect(routeIsShowing(COMMAND_CENTER_PANE, SETTINGS_ROUTE, '?tab=command-center&section=usage')).toBe(true)
  })

  it('still matches a plain path row, with or without a query beside it', () => {
    expect(routeIsShowing(CRON_ROUTE, CRON_ROUTE, '')).toBe(true)
    expect(routeIsShowing(SETTINGS_ROUTE, SETTINGS_ROUTE, '?from=dock')).toBe(true)
    expect(routeIsShowing(CRON_ROUTE, SETTINGS_ROUTE, '')).toBe(false)
  })

  it('never lights at a retired destination, because no page answers there', () => {
    // The address resolves to the home view, so the location can read
    // `/artifacts` while the home stage paints. Matching the address alone made
    // the indicator claim a surface that is not on screen.
    expect(appViewForPath(ARTIFACTS_ROUTE)).toBe('home')
    expect(routeIsShowing(ARTIFACTS_ROUTE, ARTIFACTS_ROUTE, '?from=dock')).toBe(false)
    expect(routeIsShowing(STARMAP_ROUTE, STARMAP_ROUTE, '')).toBe(false)
  })

  it('still lights a MOVED destination, which the shell redirects before a row can light', () => {
    // `/messaging` is retired too, but it has a pane: `useOverlayRouting`
    // replaces the location with that pane, so this case never reaches a row —
    // and the pane address, which is what the row carries, must keep matching.
    expect(movedRoutePane(MESSAGING_ROUTE)).toBe(MESSAGING_PANE)
    expect(routeIsShowing(MESSAGING_ROUTE, MESSAGING_ROUTE, '')).toBe(true)
    expect(routeIsShowing(MESSAGING_PANE, SETTINGS_ROUTE, '?tab=messaging')).toBe(true)
  })

  it('needs the path AND the parameters, so a matching tab elsewhere is not a match', () => {
    expect(routeIsShowing(MESSAGING_PANE, CRON_ROUTE, '?tab=messaging')).toBe(false)
    // A caller that passes a full target as the location is normalised, not matched by string.
    expect(routeIsShowing(MESSAGING_PANE, MESSAGING_PANE, '?tab=messaging')).toBe(true)
  })
})
