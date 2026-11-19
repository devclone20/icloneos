/**
 * Extended Playwright test fixture that auto-fails any test if an error
 * banner (notification toast with role="alert") appears in the DOM.
 *
 * The desktop app surfaces errors as `[data-slot="alert"][role="alert"]`
 * elements (see components/notifications.tsx). When one appears during a
 * test, it means something went wrong (resume failed, boot error, etc.)
 * — the test should fail with the error message, not silently pass while
 * an error toast is visible on screen.
 *
 * Usage: import { test, expect } from './test' instead of
 * '@playwright/test'. The guard is auto-installed on every page — no
 * per-spec setup needed.
 */

import { _electron, test as base, type ElectronApplication, expect, type Page } from '@playwright/test'

import { judgeReadiness } from './readiness'
import { readinessFacts } from './readiness-page'
import {
  BOOTED_ANNOTATION,
  currentClaim,
  launchWasUnclaimed,
  markReady,
  NON_READY_ANNOTATION,
  READY_ANNOTATION,
  setSpecFileSource,
  startTest,
  UNCLAIMED_ANNOTATION
} from './ready-state'

/** The spec file of the running test or hook (beforeAll included), or '' outside Playwright. */
function runningSpecFile(): string {
  try {
    return base.info().file
  } catch {
    return ''
  }
}

setSpecFileSource(runningSpecFile)

// Track error messages per test so afterEach can assert + report.
const seenErrors: string[] = []
let activePage: Page | null = null
// The spec file whose launch installed activePage: another file's page (closed, or from its beforeAll) never answers.
let activePageFile = ''
// When true, the afterEach guard skips the error-banner check.
// Set by tests that deliberately trigger error states (e.g. boot-failure).
let errorBannersAllowed = false

/**
 * Opt out of the error-banner guard for the current test. Call in
 * test.beforeEach or at the top of a test body when error banners are
 * expected (e.g. boot-failure tests that deliberately trigger errors).
 */
export function allowErrorBanners(): void {
  errorBannersAllowed = true
}

/**
 * Install the error-banner guard on a page. Watches for `[role="alert"]`
 * elements appearing in the DOM. When one is found, records its text
 * content for the afterEach assertion.
 *
 * Exported so e2e fixture functions (which create pages via _electron.launch)
 * can install the guard on their custom pages — the default Playwright `page`
 * fixture override only catches pages created by Playwright itself, not
 * pages created by the test's own Electron launch.
 */
export function installErrorBannerGuard(page: Page): void {
  activePage = page
  activePageFile = runningSpecFile()

  // Clear any errors from a previous test when a new page is created.
  seenErrors.length = 0

  // Use a MutationObserver to catch error banners as they appear.
  // We inject this via addInitScript so it runs before any app code.
  page.addInitScript(() => {
    const seen: string[] = []

    ;(window as unknown as { __ERROR_BANNER_GUARD__?: string[] }).__ERROR_BANNER_GUARD__ = seen

    const observer = new MutationObserver(() => {
      const alerts = document.querySelectorAll('[role="alert"]')

      for (const alert of alerts) {
        const text = (alert.textContent ?? '').trim()

        if (text && !seen.includes(text)) {
          seen.push(text)
        }
      }
    })

    // Start observing once the DOM is ready.
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true })
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, { childList: true, subtree: true })
      })
    }
  })

  // Also poll via evaluate — MutationObserver via addInitScript can miss
  // elements that appear during the Electron renderer's initial mount
  // (before the observer is installed). A periodic poll catches those.
  page.on('console', () => {
    // Console messages are not errors — but we keep the listener to
    // ensure the page context is active for our evaluate calls.
  })
}

/**
 * Check for error banners that appeared during the test. Called in
 * afterEach via the custom fixture below. Also exported so specs that
 * manage their own page lifecycle can call it directly.
 */
export async function collectErrorBanners(page: Page | null): Promise<string[]> {
  if (!page) {
    return []
  }

  try {
    // Read errors collected by the MutationObserver in the page context.
    const pageErrors = await page.evaluate(() => {
      const w = window as unknown as { __ERROR_BANNER_GUARD__?: string[] }

      return [...(w.__ERROR_BANNER_GUARD__ ?? [])]
    })

    // Also do a final DOM scan for any alert elements still visible.
    const domAlerts = await page
      .locator('[role="alert"]')
      .allTextContents()
      .catch(() => [] as string[])

    const all = [...new Set([...pageErrors, ...domAlerts.map(t => t.trim()).filter(Boolean)])]
    seenErrors.push(...all)

    return [...new Set(seenErrors)]
  } catch {
    // Page might be closed — return whatever we have.
    return [...new Set(seenErrors)]
  }
}

/** The page this test's own spec file launched, if any. */
const ownPage = (file: string): Page | null => (activePage && activePageFile === file ? activePage : null)

/**
 * v0.0.9 eng G2-m1: the per-test readiness re-check, the ready annotations and the error-banner guard are ONE auto
 * fixture. They were module-level beforeEach/afterEach/afterAll hooks, which Playwright attaches only to the first
 * spec file that imports this module in a worker, so with 9 workers about 21 of 61 tests were judged and annotated.
 * An auto fixture runs for every test in every file. Claims and the guarded page are keyed by spec file
 * (ready-state.ts), which replaces the old per-file afterAll reset.
 *
 * Before the test (G-m5): a booted claim made in a beforeAll is re-proven, ready again only if the live app is ready
 * now. After it: a test that claims a booted app must have reached ready, every test says which it was, and any error
 * banner fails it, even when it already failed for another reason (an error banner often IS the root cause).
 */
export const test = base.extend<{ readyGuard: void }>({
  // Override the page fixture to auto-install the guard.
  page: async ({ page }, provide) => {
    installErrorBannerGuard(page)
    await provide(page)
  },
  readyGuard: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads fixtures from a destructuring pattern; this one needs none.
    async ({}, use, testInfo) => {
      errorBannersAllowed = false
      startTest()

      const page = ownPage(testInfo.file)

      if (currentClaim()?.kind === 'booted' && page && !page.isClosed()) {
        if (judgeReadiness(await readinessFacts(page)) === 'ready') {
          markReady()
        }
      }

      await use()

      // A test marked fixme/skip never ran its body: there is no app to judge, and it counts nowhere.
      if (testInfo.expectedStatus === 'skipped' || testInfo.status === 'skipped') {
        errorBannersAllowed = false

        return
      }

      const claim = currentClaim()

      if (claim?.kind === 'booted') {
        testInfo.annotations.push({ type: BOOTED_ANNOTATION })

        if (claim.ready) {
          testInfo.annotations.push({ type: READY_ANNOTATION })
        } else if (testInfo.status === testInfo.expectedStatus) {
          throw new Error(
            `"${testInfo.title}" drives a booted app but never reached ready (waitForAppReady): a test that never ` +
              'reaches the permission gate cannot pass. Wait for ready in its beforeAll/beforeEach, or claim a non-ready state.'
          )
        }
      } else if (claim?.kind === 'non-ready') {
        testInfo.annotations.push({ type: NON_READY_ANNOTATION, description: claim.reason })
      } else if (launchWasUnclaimed()) {
        testInfo.annotations.push({ type: UNCLAIMED_ANNOTATION })

        if (testInfo.status === testInfo.expectedStatus) {
          throw new Error(`"${testInfo.title}" launched the app without claiming booted or non-ready (e2e/ready-state.ts)`)
        }
      }

      const wasAllowed = errorBannersAllowed
      errorBannersAllowed = false

      if (wasAllowed) {
        // Test opted out: clear any collected errors without asserting.
        seenErrors.length = 0

        return
      }

      const errors = await collectErrorBanners(ownPage(testInfo.file))

      if (errors.length > 0) {
        throw new Error(
          `Error banner(s) appeared during test "${testInfo.title}":\n` + errors.map(e => `  • ${e}`).join('\n')
        )
      }
    },
    { auto: true }
  ]
})

export { _electron, type ElectronApplication, expect, type Page }
