/**
 * REL-6 — the installer's network call through Electron's `net` (the system proxy and certificate store apply). All
 * the rules — host, no redirect, size caps, stall and total timeouts — live in net-core.ts, where they are tested.
 */
import { net } from 'electron'

import { createRegistryFetch, type FetchLike } from './net-core'

export { MAX_TARBALL } from './net-core'

export const registryFetch = createRegistryFetch({ fetch: ((url, init) => net.fetch(url, init)) as FetchLike })
