/**
 * ROUTE (PAGE) TILES — a full-page view rendered as a layout-tree pane BESIDE
 * the main thread, the page analog of session tiles. Built-in pages
 * (Capabilities) render their view; plugin pages render their `ROUTES_AREA`
 * contribution. Lifecycle mirrors session tiles:
 * `openRouteTile(path)` -> `watchRouteTiles` registers a pane docked beside
 * main -> tree adoption lands it on the chosen edge; closing removes it.
 */

import { lazy, type ReactNode, Suspense } from 'react'

import { ContribBoundary, ContribRender } from '@/contrib/react/boundary'
import { useContributions } from '@/contrib/react/use-contributions'
import { $routeTiles, closeRouteTile, type RouteTile } from '@/store/route-tiles'

import { appViewForPath, contributedRoutes, isOverlayView, ROUTES_AREA, SKILLS_ROUTE } from '../routes'

import { paneMirror } from './pane-mirror'

const SkillsView = lazy(async () => ({ default: (await import('../skills')).SkillsView }))

// Built-in page views + their pane titles, keyed by route.
//
// MESSAGING IS NOT HERE ANY MORE (front K5, 2026-10-20). This registry was the
// last mount of the Messaging page outside Settings, and the owner's criterion
// is LOCATION: Messaging is a Settings topic, so it renders in the Settings
// body and nowhere else. "Open Messaging in a split" is therefore GONE — a
// named, justified loss, counted in the front's own probe — rather than
// silently re-pointed at the pane's address, which this registry cannot mount
// at all (it would have opened a tile reading "no page at /settings?tab=…").
const BUILTIN_PAGES: Record<string, { render: () => ReactNode; title: string }> = {
  [SKILLS_ROUTE]: { render: () => <SkillsView />, title: 'Capabilities' }
}

/** Can `path` actually be opened as a route tile? A tile renders a built-in
 *  page or a `ROUTES_AREA` contribution and nothing else, so every other path
 *  — a retired page, a Settings pane address — would open a pane reading "no
 *  page at …". A door that offers "Open in split" asks this first. */
export function canOpenRouteTile(path: string): boolean {
  if (BUILTIN_PAGES[path]) {
    return true
  }

  // A contributed page is mountable; an overlay or a retired path is not.
  return contributedRoutes().some(route => route.path === path) && !isOverlayView(appViewForPath(path))
}

/** Humanize a route path into a tab title: `/my-atlas` → `My Atlas`. */
const humanizePath = (path: string): string =>
  path
    .replace(/^\/+/, '')
    .split(/[/-]/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ') || path

/** Title for a route tile: the built-in name, the contribution's own `title`,
 *  else a humanized path — never the internal `${source}:${id}` key. */
function routeTitle(path: string): string {
  if (BUILTIN_PAGES[path]) {
    return BUILTIN_PAGES[path].title
  }

  return contributedRoutes().find(r => r.path === path)?.title ?? humanizePath(path)
}

function RouteTilePane({ path }: { path: string }) {
  const builtin = BUILTIN_PAGES[path]

  // Subscribe so a plugin page tile appears the moment its route registers.
  useContributions(ROUTES_AREA)
  const contrib = builtin ? null : contributedRoutes().find(r => r.path === path)

  if (builtin) {
    return (
      <ContribBoundary id={path}>
        <Suspense fallback={null}>
          <ContribRender render={builtin.render} />
        </Suspense>
      </ContribBoundary>
    )
  }

  if (contrib) {
    return (
      <ContribBoundary id={path}>
        <ContribRender render={contrib.render} />
      </ContribBoundary>
    )
  }

  return (
    <div className="grid h-full place-items-center font-mono text-[11px] text-(--ic-text-3)">no page at {path}</div>
  )
}

// ---------------------------------------------------------------------------
// Route tile -> pane contribution sync (call once from the app root).
// ---------------------------------------------------------------------------

/** Keep pane contributions mirroring `$routeTiles`. Call once from the root. */
export const watchRouteTiles = paneMirror<RouteTile>({
  source: $routeTiles,
  workspaceMode: 'sessions',
  key: t => t.path,
  prefix: 'route-tile',
  dir: t => t.dir,
  minWidth: '22rem',
  title: routeTitle,
  render: path => <RouteTilePane path={path} />,
  close: closeRouteTile
})
