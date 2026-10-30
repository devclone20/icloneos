/**
 * EconomyOS — the first-paint lifecycle every app data module shares.
 *
 * `prefetch(inftId, slug)` (prefetch.ts) runs once per iNFT before any window
 * opens: the last snapshot is revived and checked, its dock badge goes up, and
 * the window's own mount reads are warmed with the same argv and TTL so the
 * mount is a cache hit. An account the CLI says is gone loses its snapshot and
 * its badge; a transient failure keeps both.
 */
import { setEconBadge } from './badges'
import { clearSnapshot } from './snapshot'
import type { EconKind } from './types'

/** What the warm reads proved: `ready` (the account answers), `unprovisioned`
 *  (it is gone — forget what is on disk), or nothing (a transient failure). */
type WarmOutcome = 'ready' | 'unprovisioned' | void

interface EconDataSpec<Last> {
  kind: EconKind
  /** The last snapshot, revived and validated — null when there is none worth showing. */
  last?: (slug: string) => Last | null
  /** The dock badge drawn from that snapshot. */
  badge?: (slug: string, last: Last) => void
  /** `before-warm` paints the badge before the CLI answers (it may queue behind
   *  other reads); `after-ready` only once the warm reads proved the account. */
  badgeWhen?: 'after-ready' | 'before-warm'
  /** The window's first-paint reads. */
  warm: (inftId: string, slug: string) => Promise<WarmOutcome>
}

interface EconData {
  prefetch: (inftId: string, slug: string) => Promise<void>
}

export function defineEconData<Last>(spec: EconDataSpec<Last>): EconData {
  const { badge, badgeWhen = 'before-warm', kind, last, warm } = spec

  const publishBadge = (slug: string) => {
    const data = last ? last(slug) : null

    if (badge && data !== null) {
      badge(slug, data)
    }
  }

  async function prefetch(inftId: string, slug: string): Promise<void> {
    if (badgeWhen === 'before-warm') {
      publishBadge(slug)
    }

    const outcome = await warm(inftId, slug)

    if (outcome === 'unprovisioned') {
      setEconBadge(slug, kind, 0)
      clearSnapshot(kind, slug)
    } else if (outcome === 'ready' && badgeWhen === 'after-ready') {
      publishBadge(slug)
    }
  }

  return { prefetch }
}
