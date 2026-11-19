/**
 * Regression coverage for #69578: harmless route-token churn during a send
 * must not make the desktop silently drop the prompt before prompt.submit.
 */

import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

const PROMPT = 'E2E route token drift must still submit this prompt.'

let fixture: MockBackendFixture | null = null

test.beforeAll(async () => {
  fixture = await setupMockBackend()
  await waitForAppReady(fixture!, 120_000)
})

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
})

test('submits while same-chat search tokens churn during new-session creation', async ({}, testInfo) => {
  const { page, mock } = fixture!

  // Reviewed port (v0.0.9): the Message pane's own composer (the one waitForAppReady opens), never a hidden editable.
  // The rest holds unchanged in icloneOS: the chat routes are hash routes (src/app/routes.ts, NEW_CHAT_ROUTE '/'), the
  // churn below keeps the current chat path and changes only its query, and the transcript is the same
  // `aui_thread-viewport` (src/components/assistant-ui/thread/list.tsx).
  const composer = page
    .locator('[data-slot="composer-root"] [contenteditable="true"]')
    .filter({ visible: true })
    .first()

  // Reviewed (v0.0.9 G 914237d39d, :23 flaky on its first attempt in every G): the churn ran every 1 ms, far over
  // Chromium's navigation flood limit (about 200 per 10 s). Chromium then logs "Throttling navigation to prevent the
  // browser from hanging" and holds the renderer's IPC; the gateway dial for this send fell into that window and the
  // WebSocket never opened ("no WebSocket open within 15000 ms", trace). That is the harness flooding Chromium, not
  // the app. Churn under the limit; session creation still spans several churn writes, and the count below proves
  // they landed. A throttle warning fails the test, so the flood cannot come back unseen.
  const throttled: string[] = []

  page.on('console', message => {
    if (message.text().includes('Throttling navigation')) {
      throttled.push(message.text())
    }
  })

  await composer.click()
  await composer.type(PROMPT, { delay: 10 })

  // The submit pipeline snapshots the route synchronously, then awaits session
  // creation. Keep changing only the query string of whichever chat route is
  // current. Before #69578, comparing the raw route token treated this as a
  // user chat switch and aborted before prompt.submit.
  await page.evaluate(() => {
    let revision = 0

    const interval = window.setInterval(() => {
      const pathname = window.location.hash.slice(1).split(/[?#]/, 1)[0] || '/new'
      const token = `e2e-route-churn=${revision++}`

      window.location.hash = `${pathname}?${token}`

      // Reviewed port (v0.0.9): non-vacuity. Count the churn writes that actually landed on the route, so the test
      // proves the churn ran during the send instead of passing without exercising #69578.
      if (window.location.hash.includes(token)) {
        const w = window as typeof window & { __e2eRouteChurnApplied?: number }

        w.__e2eRouteChurnApplied = (w.__e2eRouteChurnApplied ?? 0) + 1
      }
    }, 75)

    ;(window as typeof window & { __e2eStopRouteChurn?: () => void }).__e2eStopRouteChurn = () => {
      window.clearInterval(interval)
    }
  })

  try {
    await page.keyboard.press('Enter')

    // Reviewed (v0.0.9, G 1c2bbb9423): a turn request, never the session-title request, must carry the prompt. The
    // first message of a fresh chat reaches the model with the runtime's first-message note appended, so the old
    // exact match was only ever met by the title request (its user text is the bare prompt), which the mock no
    // longer counts as a prompt.
    await expect
      .poll(() => mock.receivedPrompts.some(prompt => prompt.startsWith(PROMPT)), { timeout: 60_000 })
      .toBe(true)

    const churned = await page.evaluate(
      () => (window as typeof window & { __e2eRouteChurnApplied?: number }).__e2eRouteChurnApplied ?? 0
    )

    expect(churned, 'the route-token churn never reached the chat route during the send').toBeGreaterThan(0)
    expect(throttled, 'the churn must stay under Chromium navigation flood limit').toEqual([])

    await page.waitForFunction(
      prompt => document.querySelector('[data-slot="aui_thread-viewport"]')?.textContent?.includes(prompt) ?? false,
      PROMPT,
      { timeout: 15_000 }
    )
    await page.waitForFunction(
      () =>
        document.querySelector('[data-slot="aui_thread-viewport"]')?.textContent?.includes('mock inference server') ??
        false,
      undefined,
      { timeout: 60_000 }
    )
  } finally {
    await page.evaluate(() => {
      ;(window as typeof window & { __e2eStopRouteChurn?: () => void }).__e2eStopRouteChurn?.()
    })
  }

  await page.screenshot({ path: testInfo.outputPath('same-chat-route-churn-submitted.png') })
})
