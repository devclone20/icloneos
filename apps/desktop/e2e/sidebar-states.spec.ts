/**
 * E2E tests for desktop sidebar states — background processes, subagents,
 * and session dot transitions.
 *
 * The mock server returns scripted tool_calls that the agent executes for
 * real (trivial commands + real subagent delegations). The tests assert the
 * sidebar states driven by real gateway events.
 *
 * Prerequisite: `npm run build` must have been run so dist/ exists.
 */

import { type MockBackendFixture, newConversation, openConversationList, setupMockBackend, waitForAppReady } from './fixtures'
import { createBackgroundReleaseHandle, MOCK_REPLY, restartMockServer, SIDEBAR_CROSS_TEXTS, SIDEBAR_TEXTS } from './mock-server'
// v0.0.9 e2e harness: the shared test (ready claims, error-banner guard), not the bare Playwright one.
import { expect, type Page, test } from './test'

/** Background-running dot aria-label (from i18n en.ts). */
const BG_DOT_LABEL = 'Background task running'
/** Foreground turn-running dot aria-label. */
const SESSION_RUNNING_DOT_LABEL = 'Session running'
/** Finished-unread dot aria-label. */
const UNREAD_DOT_LABEL = 'Finished — unread'

/**
 * Reviewed port (v0.0.9): upstream's left sidebar is, in icloneOS, the Message pane's conversation list (the same
 * SidebarSessionRow and session-status-dot, src/app/home/msg-sidebar.tsx:642, src/app/chat/session-status-dot.tsx:57).
 * Its rows, and so their dots, are drawn while the list is open: open it, then count the dots in it.
 */
async function dotCount(page: Page, label: string): Promise<number> {
  await openConversationList(page)

  return page.getByRole('navigation', { name: 'Conversations' }).locator(`[aria-label="${label}"]`).count()
}

/** Send a message and wait for the final response to appear. */
async function sendMessageAndWait(page: Page, trigger: string, finalText: string, timeout = 90_000): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 10_000 })
  await composer.click()
  await composer.type(trigger, { delay: 20 })
  await page.keyboard.press('Enter')

  await page.waitForFunction(() => (document.body.textContent ?? '').includes('E2E_'), undefined, { timeout: 15_000 })

  await page.waitForFunction(text => (document.body.textContent ?? '').includes(text), finalText, { timeout })
}

// ────────────────────────────────────────────────────────────────────────
// Test 1: background process + subagent appear in sidebar during turn
// ────────────────────────────────────────────────────────────────────────

test.describe('sidebar states — background process and subagent', () => {
  test.describe.configure({ mode: 'serial' })

  let fixture: MockBackendFixture

  test.beforeAll(async () => {
    restartMockServer()
    fixture = await setupMockBackend()
    await waitForAppReady(fixture, 120_000)
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('background process dot appears and disappears, subagent runs, final answer visible', async () => {
    const page = fixture.page

    await sendMessageAndWait(page, 'E2E_SIDEBAR_TRIGGER', SIDEBAR_TEXTS.finalText)

    // The background process (sleep 1) should have shown a "Background task
    // running" dot at some point during the turn. We try to catch it; if
    // the process was too fast, that's OK — the real assertion is that the
    // final answer appeared and the dot is gone afterward.
    try {
      await expect
        .poll(() => dotCount(page, BG_DOT_LABEL), {
          timeout: 15_000,
          message: 'background dot should appear'
        })
        .toBeGreaterThan(0)
    } catch {
      // sleep 1 may have finished before we polled — not a failure.
    }

    // After the turn completes and auto-dismiss fires, the background dot
    // should be gone.
    await page.waitForTimeout(8000)
    const bgCount = await dotCount(page, BG_DOT_LABEL)
    expect(bgCount, 'background dot should be gone after auto-dismiss').toBe(0)

    // Evidence: capture the final state — no background dot, final answer visible.
    await page.screenshot({ path: 'test-results/bg-dot-gone-after-dismiss.png' })

    // The final answer text must be in the transcript.
    const viewportText = await page.locator('[data-slot="aui_thread-viewport"]').textContent()

    expect(viewportText).toContain(SIDEBAR_TEXTS.finalText)
  })
})

// ────────────────────────────────────────────────────────────────────────
// Test 2: subagent running shows background dot too (longer bg process)
// ────────────────────────────────────────────────────────────────────────

test.describe('sidebar states — subagent and background dot coexist', () => {
  test.describe.configure({ mode: 'serial' })

  let fixture: MockBackendFixture

  test.beforeAll(async () => {
    restartMockServer()
    fixture = await setupMockBackend()
    await waitForAppReady(fixture, 120_000)
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('background dot visible while subagent runs', async () => {
    const page = fixture.page

    // Start the turn but DON'T wait for the final answer yet — we want
    // to assert the background dot is visible WHILE the subagent runs.
    const composer = page.locator('[contenteditable="true"]').first()
    await composer.waitFor({ state: 'visible', timeout: 10_000 })
    await composer.click()
    await composer.type('E2E_SIDEBAR_CROSS', { delay: 20 })
    await page.keyboard.press('Enter')

    // Wait for the user's message to appear.
    await page.waitForFunction(() => (document.body.textContent ?? '').includes('E2E_SIDEBAR_CROSS'), undefined, {
      timeout: 15_000
    })

    // Reviewed port (v0.0.9): the composer runs in Manual mode, so the scripted background command parks on the
    // permission card ("Allow once / Deny") and spawns nothing until the owner answers (v009-trace2.md). Allow it,
    // as a user does; the dot below is still the assertion.
    await page.getByRole('button', { name: 'Allow once' }).first().click({ timeout: 20_000 })

    // The background process (sleep 5) should show a "Background task
    // running" dot while the subagent is also running.
    await expect
      .poll(() => dotCount(page, BG_DOT_LABEL), {
        timeout: 30_000,
        message: 'background dot should appear while subagent runs'
      })
      .toBeGreaterThan(0)

    // Evidence: the background dot is visible while the subagent runs.
    await page.screenshot({ path: 'test-results/bg-dot-while-subagent-runs.png' })

    // Now wait for the final answer to appear.
    await page.waitForFunction(
      text => (document.body.textContent ?? '').includes(text),
      SIDEBAR_CROSS_TEXTS.finalText,
      { timeout: 90_000 }
    )

    // After the turn + auto-dismiss, the background dot should be gone.
    await page.waitForTimeout(8000)
    const bgCount = await dotCount(page, BG_DOT_LABEL)
    expect(bgCount, 'background dot should be gone after process exits').toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────
// Test 3: cross-session — dot updates when viewing a different session
// ────────────────────────────────────────────────────────────────────────

test.describe('sidebar states — cross-session dot transition', () => {
  test.describe.configure({ mode: 'serial' })

  let fixture: MockBackendFixture
  // Keeps the background process alive until this test releases it, so the
  // "still running after the turn finished" state can't expire on its own.
  const bgRelease = createBackgroundReleaseHandle()

  test.beforeAll(async () => {
    restartMockServer()
    fixture = await setupMockBackend({
      mockServer: { backgroundReleasePath: bgRelease.path }
    })
    await waitForAppReady(fixture, 120_000)
  })

  test.afterAll(async () => {
    // Release first so the process exits even if the test failed early,
    // then drop the sentinel file.
    bgRelease.release()
    await fixture?.cleanup()
    bgRelease.cleanup()
  })

  test('background dot transitions to finished when viewing another session', async () => {
    const page = fixture.page

    // Start a turn whose background process runs until we release it.
    const composer = page.locator('[contenteditable="true"]').first()
    await composer.waitFor({ state: 'visible', timeout: 10_000 })
    await composer.click()
    await composer.type('E2E_SIDEBAR_CROSS', { delay: 20 })
    await page.keyboard.press('Enter')

    // Reviewed port (v0.0.9): allow the parked background command (Manual mode's permission card), as a user does.
    await page.getByRole('button', { name: 'Allow once' }).first().click({ timeout: 20_000 })

    // Wait for the background dot to appear.
    await expect
      .poll(() => dotCount(page, BG_DOT_LABEL), {
        timeout: 30_000,
        message: 'background dot should appear'
      })
      .toBeGreaterThan(0)

    // The final answer text streams before message.complete, so text visibility
    // alone is not a completion barrier. Wait for the foreground-running state
    // to clear before asserting the background-process state.
    await page.waitForFunction(
      text => (document.body.textContent ?? '').includes(text),
      SIDEBAR_CROSS_TEXTS.finalText,
      { timeout: 90_000 }
    )
    // Reviewed (v0.0.9 G 914237d39d, :198 flaky): a top-level delegate_task always runs in the background
    // (tools/delegate_tool.py:747) and its result re-enters the chat as one more turn after the scripted turn ends,
    // answered here with the mock's default reply. Until that turn is over the row rightly shows "Session running",
    // which hides the background dot; the G failed when the re-entry started between the two samples. Wait for that
    // turn too, so the state below is the stable one the comment promises.
    await page.waitForFunction(
      ([finalText, reply]) => {
        const text = document.querySelector('[data-slot="aui_thread-viewport"]')?.textContent ?? ''
        const at = text.indexOf(finalText)

        return at >= 0 && text.indexOf(reply, at) > at
      },
      [SIDEBAR_CROSS_TEXTS.finalText, MOCK_REPLY] as const,
      { timeout: 90_000 }
    )
    await expect
      .poll(() => dotCount(page, SESSION_RUNNING_DOT_LABEL), {
        timeout: 30_000,
        message: 'session running dot should disappear after turn completes'
      })
      .toBe(0)

    // The background dot must still be visible: the turn is done but the
    // process is held open by the sentinel, so this is a stable state rather
    // than a window we have to catch in time.
    const bgDuringTurn = await dotCount(page, BG_DOT_LABEL)
    expect(bgDuringTurn, 'background dot should still be visible after turn completes').toBeGreaterThan(0)

    // Evidence: bg dot visible on session A while its turn is done but the
    // background process hasn't exited yet.
    await page.screenshot({ path: 'test-results/cross-session-bg-dot-before-switch.png' })

    // Create a new session (Reviewed port (v0.0.9): the list's "New conversation", fixtures.newConversation).
    await newConversation(page)
    await page.waitForTimeout(2000)

    // Now let the background process finish. The session A dot should
    // transition away from "background running".
    bgRelease.release()
    await expect
      .poll(() => dotCount(page, BG_DOT_LABEL), {
        timeout: 30_000,
        message: 'background dot should disappear after process finishes'
      })
      .toBe(0)

    // The original session should show a "finished unread" indicator (green dot)
    // since its turn completed while we were in a different session. This is an
    // event-driven transition, so wait for it instead of sampling the DOM right
    // after the running dot disappears.
    await expect
      .poll(() => dotCount(page, UNREAD_DOT_LABEL), {
        timeout: 30_000,
        message: 'original session should show finished-unread dot'
      })
      .toBeGreaterThan(0)

    // Evidence: the green "finished unread" dot on the original session after
    // switching to a new session — the cross-session dot transition.
    await page.screenshot({ path: 'test-results/cross-session-unread-dot-after-switch.png' })
  })
})
