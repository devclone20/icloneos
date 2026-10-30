/**
 * This page's route declaration — the ONLY place its path is registered.
 * `app/routes.ts` collects every page-level `route.ts` eagerly, so no page is
 * ever added to a shared table. Keep the import below type-only: a value
 * import from `../routes` would close a cycle.
 */

import type { AppRoute } from '../routes'

export const route = {
  id: 'agents',
  path: '/agents',
  view: 'agents',
  overlay: true
} as const satisfies AppRoute
