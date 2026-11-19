import type { Page } from '@playwright/test'

/**
 * Open Settings › Sessions & Bots: icloneOS hosts the old left sidebar there (src/app/settings/sessions-bots.tsx:45,
 * `<WiredPane part="sidebar" />`, the same wiring and stores). Reached through the app's own Settings door (the
 * `?tab=` deep link that palette rows and other surfaces use, settings/index.tsx:244), then waits for the sidebar.
 */
export async function openSessionsAndBots(page: Page, timeoutMs = 120_000): Promise<void> {
  // The chat route has a sidebar of its own, so only the Settings tab's profile rail proves Settings holds (fleet
  // tracer, v009-fleet-trace.md). A gateway re-home lands with requestFreshSession(), which navigates back to the chat
  // and closes Settings: open, wait for the rail, then re-check the route after a beat, and open again if it moved.
  const route = '#/settings?tab=sessions-bots'
  const rail = page.locator('[data-slot="profile-rail"]')
  const deadline = Date.now() + timeoutMs

  for (;;) {
    await page.evaluate(target => {
      if (window.location.hash !== target) {
        window.location.hash = target.slice(1)
      }
    }, route)

    const shown = await rail
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false)

    if (shown) {
      await page.waitForTimeout(1_500)

      if ((await page.evaluate(() => window.location.hash)) === route) {
        return
      }
    }

    if (Date.now() > deadline) {
      throw new Error('Settings › Sessions & Bots did not hold (its profile rail never stayed on screen)')
    }
  }
}
