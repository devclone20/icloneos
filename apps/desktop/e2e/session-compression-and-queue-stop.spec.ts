/**
 * E2E coverage for session compression, which rotates a live backend session.
 */

import { contrastInBothModes } from './contrast'
import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { MOCK_REPLY, receivedUserTexts, restartMockServer } from './mock-server'
// v0.0.9 e2e harness: the shared test (ready claims, error-banner guard), not the bare Playwright one.
import { expect, type Page, test } from './test'

async function send(page: Page, text: string, delay = 15): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.click()
  await composer.type(text, { delay })
  await page.keyboard.press('Enter')
}

async function pasteAndSend(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.click()
  await page.keyboard.insertText(text)
  await page.keyboard.press('Enter')
}

async function waitForTranscript(page: Page, text: string, timeout = 90_000): Promise<void> {
  await page.waitForFunction(
    expected => document.querySelector('[data-slot="aui_thread-viewport"]')?.textContent?.includes(expected) ?? false,
    text,
    { timeout }
  )
}

/**
 * Reviewed (v0.0.9 G 914237d39d, :48 and :107 red): the barrier the tests' own comments promise, "completed exchanges".
 * The old waits were not one: :48 waited only for the mock to receive each prompt, and :107's second
 * waitForTranscript(MOCK_REPLY) was already satisfied by the FIRST reply. So the next input landed while the previous
 * turn still ran, and the app did what it is built to do: /compress on a running turn answers "session busy"
 * (session.compress is idle-gated, tui_gateway/host_supervisor.py) and a plain Enter steers the live turn
 * (use-composer-submit.ts). Since the sandboxes got a short root (fe3d6becba) the launcher socket binds and the
 * agent carries its full confined toolset, so a turn takes long enough for that race to be lost every time.
 * Wait for `count` replies in the transcript and for the turn to be over (an empty composer shows Stop only while
 * a turn runs, controls.tsx showStop).
 */
async function waitForExchanges(page: Page, count: number, timeout = 90_000): Promise<void> {
  await page.waitForFunction(
    ([reply, wanted]) =>
      (document.querySelector('[data-slot="aui_thread-viewport"]')?.textContent ?? '').split(reply).length - 1 >=
      wanted,
    [MOCK_REPLY, count] as const,
    { timeout }
  )
  await expect(page.locator('[data-slot="composer-root"] button[aria-label="Stop"]')).toHaveCount(0, { timeout })
}

test.describe('session compression', () => {
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

  test('compresses an existing session and accepts a follow-up turn on its continuation', async () => {
    const { page } = fixture
    const reply = 'Hello from the mock inference server! The full boot chain is working.'

    // Three completed exchanges leave a compressible middle after the
    // compressor's protected head/tail boundaries.
    await send(page, 'E2E_COMPRESSION_FIRST')
    await waitForTranscript(page, reply)
    await waitForExchanges(page, 1)
    await send(page, 'E2E_COMPRESSION_SECOND')
    await expect.poll(() => receivedUserTexts().filter(text => text === 'E2E_COMPRESSION_SECOND').length).toBe(1)
    await waitForExchanges(page, 2)
    await send(page, 'E2E_COMPRESSION_THIRD')
    await expect.poll(() => receivedUserTexts().filter(text => text === 'E2E_COMPRESSION_THIRD').length).toBe(1)
    await waitForExchanges(page, 3)

    // This test covers compression and continuation, not slash completion.
    // Insert the complete command atomically and click Send so an async
    // completion response cannot consume Enter as a picker acceptance.
    const composer = page.locator('[contenteditable="true"]').first()
    await composer.click()
    await page.keyboard.insertText('/compress preserve the three test turns')
    await expect.poll(() => composer.textContent()).toContain('preserve the three test turns')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect
      .poll(() => page.locator('[data-slot="aui_thread-viewport"]').textContent(), { timeout: 90_000 })
      .toMatch(/Compressed|No changes from compression/)

    // Compression rotates the agent's live session id. A post-compression
    // ordinary turn proves the desktop's runtime binding followed that child.
    await send(page, 'E2E_COMPRESSION_FOLLOW_UP')
    await expect.poll(() => receivedUserTexts().filter(text => text === 'E2E_COMPRESSION_FOLLOW_UP').length).toBe(1)
    await waitForTranscript(page, reply)
    await page.screenshot({ path: 'test-results/session-compression-continuation.png' })
  })
})

test.describe('session compression in progress', () => {
  let fixture: MockBackendFixture

  test.beforeAll(async () => {
    fixture = await setupMockBackend({
      modelContextLength: 64_000,
      // Reviewed loosening (v0.0.9, G 914237d39d :107): threshold_tokens 22000 -> 30000. Measured: with the sandbox's
      // launcher bound (fe3d6becba) the agent carries its confined toolset, and the runtime logged the SECOND history
      // turn at "~23,686 tokens >= 22,000 threshold" (agent.log, insufficient_messages): the ambient prompt alone is
      // over 22k, so an empty compression ran on the history and the anti-thrash breaker then blocked the trigger's
      // real one. 30k still proves the behaviour, and the test now proves it from both sides instead of trusting the
      // number: no "Summarizing thread" may appear during the history turns (an observer, so a flash counts; at 22k it
      // does flash), and the trigger (~12k tokens on its own) must then start the held summary. That is the delta
      // assertion: ambient + history < threshold <= ambient + history + payload, checked at run time.
      extraConfig: `compression:
  threshold_tokens: 30000
  protect_first_n: 0
  protect_last_n: 1
auxiliary:
  compression:
    provider: custom
    model: mock-model`,
      mockServer: {
        holdFirstCompletionContaining: 'You are a summarization agent creating a context checkpoint.'
      }
    })
    await waitForAppReady(fixture, 120_000)
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('queues an Enter-submitted draft instead of steering while compaction is active', async ({}, testInfo) => {
    const { page } = fixture
    const queued = 'E2E_QUEUED_DURING_COMPACTION'

    // A normal message crosses the tiny configured context budget. The mock
    // blocks only the resulting summary request, so these assertions run
    // during automatic compaction rather than a slash-command path.
    // The payload must cross threshold_tokens (30k) on its OWN weight
    // (~12k tokens) on top of the system prompt. Do not shrink it: at
    // repeat(500) the trigger only worked because the ambient system prompt
    // (skills index + tool schemas) happened to carry it over the line, and
    // a 160-token skills-index cleanup on main broke the test for a day.
    // Every appearance of the compaction status, however brief, from before the first history turn.
    await page.evaluate(() => {
      const w = window as typeof window & { __summarizingSeen?: number }

      w.__summarizingSeen = 0
      new MutationObserver(() => {
        if (document.querySelector('[role="status"][aria-label="Summarizing thread"]')) {
          w.__summarizingSeen = (w.__summarizingSeen ?? 0) + 1
        }
      }).observe(document.body, { childList: true, subtree: true })
    })

    await pasteAndSend(page, 'E2E_COMPACTION_HISTORY_ONE '.repeat(5))
    await waitForTranscript(page, MOCK_REPLY)
    await waitForExchanges(page, 1)
    await pasteAndSend(page, 'E2E_COMPACTION_HISTORY_TWO '.repeat(5))
    await waitForTranscript(page, MOCK_REPLY)
    await waitForExchanges(page, 2)

    // The lower side of the delta: the ambient prompt plus both history turns stayed under the threshold.
    const summarizingBeforeTrigger = await page.evaluate(
      () => (window as typeof window & { __summarizingSeen?: number }).__summarizingSeen ?? -1
    )

    expect(summarizingBeforeTrigger, 'no compaction may start before the trigger (threshold under the ambient prompt)').toBe(0)
    expect(fixture.mock.heldCompletionCount()).toBe(0)

    await pasteAndSend(page, 'E2E_TRIGGER_AUTOMATIC_COMPACTION '.repeat(1500))
    await fixture.mock.waitForHeldCompletion()
    await expect(page.getByRole('status', { name: 'Summarizing thread' }).last()).toBeVisible()

    // v0.0.9 G UI lens: the live status hint is words the owner reads; it holds AA in both skins, like the timer.
    const hint = page.getByRole('status', { name: 'Summarizing thread' }).last().locator('[data-slot="status-hint"]')
    const hintContrast = await contrastInBothModes(page, hint)

    expect(new Set(hintContrast.map(row => row.mode))).toEqual(new Set(['dark', 'light']))

    for (const row of hintContrast) {
      expect(row.ratio, JSON.stringify(row)).toBeGreaterThanOrEqual(4.5)
    }

    // Reviewed port (v0.0.9): upstream's primary button turned into "Queue message" during compaction. In icloneOS an
    // empty composer's primary is always Stop (src/app/chat/composer/controls.tsx:81), and a typed draft brings up
    // the separate "Queue message" button while compaction rules out steering (composer/index.tsx:359-366, busyAction
    // 'queue'). The contract a user relies on is unchanged and asserted in full: the draft queues ("1 Queued"),
    // never reaches the model during compaction, and is sent exactly once after it.
    const primary = page.locator('[data-slot="composer-root"] button[type="submit"]')
    const queueButton = page.locator('[data-slot="composer-root"] button[aria-label="Queue message"]')
    await expect(primary).toHaveAttribute('aria-label', 'Stop')
    await expect(queueButton).toHaveCount(0)

    const composer = page.locator('[contenteditable="true"]').first()
    await composer.click()
    await composer.type(queued, { delay: 15 })
    await expect(queueButton).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByText('1 Queued')).toBeVisible()
    expect(fixture.mock.heldCompletionCount()).toBe(1)
    expect(receivedUserTexts()).not.toContain(queued)
    await page.screenshot({ path: testInfo.outputPath('queued-during-compaction.png') })

    fixture.mock.releaseHeldStream()
    await expect.poll(() => receivedUserTexts().filter(text => text === queued).length).toBe(1)
    expect(fixture.mock.heldCompletionCount()).toBe(1)
  })
})

test.describe('session compression refused while a turn runs', () => {
  const HOLD = 'E2E_BUSY_COMPRESS_HOLD'
  let fixture: MockBackendFixture

  test.beforeAll(async () => {
    fixture = await setupMockBackend({ mockServer: { holdFirstCompletionContaining: HOLD } })
    await waitForAppReady(fixture, 120_000)
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  // v0.0.9 (G 914237d39d side finding, coordinator decision): /compress on a running turn is refused as busy, and the
  // answer is written as a line in the chat. A transcript refresh a few seconds later dropped it (the stored
  // transcript never holds the desktop's own lines), so the answer vanished. It must stay, once, after the turn ends.
  test('the busy answer of a /compress on a running turn stays in the chat after the turn ends', async () => {
    const { page } = fixture
    const transcript = () => page.locator('[data-slot="aui_thread-viewport"]').textContent()
    const busyLines = async () => ((await transcript()) ?? '').split('The agent is still replying').length - 1

    await send(page, HOLD)
    await fixture.mock.waitForHeldCompletion()

    // v0.0.9 G GF-7 (owner decision): the live-turn timer ("23s") reads at AA in both skins, measured against its real
    // composited background while the turn runs.
    const timer = page.locator('[data-slot="status-timer"]').last()

    await expect(timer).toBeVisible({ timeout: 15_000 })

    const timerContrast = await contrastInBothModes(page, timer)

    expect(new Set(timerContrast.map(row => row.mode))).toEqual(new Set(['dark', 'light']))

    for (const row of timerContrast) {
      expect(row.ratio, JSON.stringify(row)).toBeGreaterThanOrEqual(4.5)
    }

    const composer = page.locator('[contenteditable="true"]').first()
    await composer.click()
    await page.keyboard.insertText('/compress')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(busyLines, { timeout: 15_000 }).toBe(1)

    fixture.mock.releaseHeldStream()
    await waitForExchanges(page, 1)

    // The refresh that used to drop it came about 7.5 s after the answer; watch well past that, every half second.
    for (let sample = 0; sample < 24; sample += 1) {
      expect(await busyLines(), `the busy answer is still shown once (${sample * 0.5}s after the turn)`).toBe(1)
      await page.waitForTimeout(500)
    }
  })
})
