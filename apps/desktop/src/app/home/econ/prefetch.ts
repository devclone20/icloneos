/**
 * EconomyOS — warm the CLI cache the moment an iNFT takes the stage.
 *
 * A window's first paint used to wait for its own reads. With the snapshot
 * (snapshot.ts) it paints at once from the last answer; with this prefetch
 * the FRESH answer is usually already in cli.ts's cache by the time the owner
 * clicks a dock icon — the reads ran quietly while the 3D model loaded.
 *
 * Each app's data module may export `prefetch(inftId, slug)`: its first-paint
 * reads only, through `acpJson` with a TTL, so the window's own load then hits
 * memory. The identity and the email warm start together (the header needs
 * the one everywhere; the other's speculative reads queue ahead of every
 * other warm-up), then the apps in dock order. Everything goes through the per-iNFT queue, so a click
 * mid-prefetch simply lands its reads behind the ones already running — and
 * those are the reads it wanted anyway.
 *
 * One prefetch per (iNFT, live-engine state): a rescan or a re-summon of the
 * same token does not spawn the CLI again.
 */
import { loadAgentIdentity } from './agent'
import { $liveEconEnabled } from './prefs'
import { ECON_APPS, ECON_ORDER } from './registry'
import type { EconKind } from './types'

type PrefetchFn = (inftId: string, slug: string) => Promise<void>

interface DataModule {
  prefetch?: PrefetchFn
}

const warmed = new Set<string>()
let current: string | null = null

/** Forget that an iNFT was warmed — a manual refresh, or a sign-out. */
export function forgetPrefetch(slug?: string): void {
  if (slug) {
    warmed.delete(slug)
  } else {
    warmed.clear()
  }
}

let windowsPreloaded = false

/** Fetch every dock window's code once, at idle: the first click after a
 *  reload then paints the window's snapshot instead of a skeleton. */
function preloadWindows(): void {
  if (windowsPreloaded) {
    return
  }

  windowsPreloaded = true
  const run = () => ECON_ORDER.forEach(kind => void ECON_APPS[kind].preload().catch(() => undefined))

  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 300 })
  } else {
    window.setTimeout(run, 0)
  }
}

async function prefetchApp(kind: EconKind, inftId: string, slug: string): Promise<void> {
  const app = ECON_APPS[kind]

  if (!app.data) {
    return
  }

  try {
    const module = (await app.data()) as DataModule

    if (typeof module.prefetch === 'function') {
      await module.prefetch(inftId, slug)
    }
  } catch {
    // A warm-up is a courtesy: the window loads for itself when it opens.
  }
}

/**
 * Warm every dock app for one configured iNFT. Returns at once; the reads
 * proceed in the background and are abandoned (not cancelled — the CLI calls
 * still complete and fill the cache) if a different iNFT takes the stage.
 */
export function prefetchEcon(inftId: string, slug: string): void {
  preloadWindows()

  if (!$liveEconEnabled.get() || warmed.has(slug)) {
    return
  }

  warmed.add(slug)
  current = slug

  const email = prefetchApp('email', inftId, slug)

  void (async () => {
    await loadAgentIdentity(inftId, slug)
    await email

    for (const kind of ECON_ORDER) {
      if (current !== slug) {
        return
      }

      if (kind === 'email') {
        continue
      }

      await prefetchApp(kind, inftId, slug)
    }
  })()
}

// The dock imports this module: the windows' code loads right behind the first
// paint, not on the first click after a reload (a 2.2 s skeleton in the lab).
if (import.meta.env.MODE !== 'test') {
  preloadWindows()
}
