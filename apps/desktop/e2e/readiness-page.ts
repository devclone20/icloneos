/**
 * v0.0.9 e2e harness: the readiness facts read from a live page — the DOM half (readiness.ts collectDomFacts, run in the
 * page) and main's boot progress over the real bridge. A module of its own so test.ts can re-check readiness at the
 * start of every test (per-test claims, G-m5) without importing fixtures.ts (which imports test.ts).
 */
import type { Page } from '@playwright/test'

import { collectDomFacts, GATE_TITLE, HOME_REGION_LABEL, type ReadinessFacts } from './readiness'

/** The facts the readiness rule judges, read from the live page (the DOM, and main's boot progress over the bridge). */
export async function readinessFacts(page: Page): Promise<ReadinessFacts> {
  const dom = (await page
    .evaluate(
      `(${collectDomFacts.toString()})(document, ${JSON.stringify(GATE_TITLE)}, ${JSON.stringify(HOME_REGION_LABEL)})`
    )
    .catch(() => null)) as Omit<ReadinessFacts, 'boot'> | null

  const boot = (await page
    .evaluate(async () => {
      const progress = (await (
        window as unknown as { hermesDesktop?: { getBootProgress?: () => Promise<unknown> } }
      ).hermesDesktop?.getBootProgress?.()) as { phase?: unknown; error?: unknown } | undefined

      return progress && typeof progress.phase === 'string'
        ? { phase: progress.phase, error: typeof progress.error === 'string' && progress.error ? progress.error : null }
        : null
    })
    .catch(() => null)) as ReadinessFacts['boot']

  return { ...(dom ?? { home: false, gate: false, consent: false, connecting: false, modal: false }), boot }
}

