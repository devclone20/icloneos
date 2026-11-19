/**
 * A queued prompt must remain local until the current inference turn settles.
 *
 * Hold the first streamed reply open after its first token. This gives the
 * composer a live, busy turn while the user queues a follow-up, then lets us
 * assert against the mock provider's real request log before and after the
 * held turn completes.
 */

import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { MOCK_REPLY } from './mock-server'
import { expect, type Page, test } from './test'

const ACTIVE_PROMPT = 'E2E_QUEUE_TURN_BOUNDARY_ACTIVE'
const QUEUED_PROMPT = 'E2E_QUEUE_TURN_BOUNDARY_QUEUED'
const STEER_PROMPT = 'E2E_STEER_TURN_BOUNDARY_CORRECTION'

async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 15_000 })
  await composer.click()
  await composer.type(text, { delay: 5 })
  await page.keyboard.press('Enter')
}

async function steer(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first()

  await composer.click()
  await composer.type(text, { delay: 5 })
  await page.keyboard.press('Enter')
}

async function queue(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first()

  await composer.click()
  await composer.type(text, { delay: 5 })
  await page.keyboard.press('Control+Enter')
}

async function transcriptMessageOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const viewport = document.querySelector('[data-slot="aui_thread-viewport"]')

    if (!viewport) {
      return []
    }

    return Array.from(viewport.querySelectorAll<HTMLElement>('[data-role="user"], [data-role="assistant"]'))
      .map(message => message.textContent?.trim() ?? '')
      .filter(Boolean)
  })
}

function steerTurnOrder(messages: string[]): string[] {
  return messages.flatMap(message => {
    if (message.includes(ACTIVE_PROMPT)) {
      return [ACTIVE_PROMPT]
    }

    if (message.includes(STEER_PROMPT)) {
      return [STEER_PROMPT]
    }

    if (message.includes(MOCK_REPLY)) {
      return [MOCK_REPLY]
    }

    return []
  })
}

test.describe('queued prompt turn boundary', () => {
  let fixture: MockBackendFixture | null = null

  test.beforeEach(async () => {
    fixture = await setupMockBackend({
      mockServer: { holdFirstStreamForPrompt: ACTIVE_PROMPT }
    })
    await waitForAppReady(fixture, 120_000)
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
    fixture = null
  })

  test('submits a queued prompt only after the active turn completes', async () => {
    const { mock, page } = fixture!

    await send(page, ACTIVE_PROMPT)
    await mock.waitForHeldStream()
    await queue(page, QUEUED_PROMPT)
    await expect(page.getByText('1 Queued')).toBeVisible()

    // The mock keeps the active SSE stream open, so a queued prompt has no
    // completed-turn boundary that could legitimately drain it. Wait past the
    // queue retry interval and assert the provider saw only the active turn.
    await page.waitForTimeout(1_000)
    expect(mock.receivedPrompts.filter(prompt => prompt === QUEUED_PROMPT)).toHaveLength(0)
    await expect(page.locator('[data-slot="aui_thread-viewport"]')).not.toContainText(QUEUED_PROMPT)

    mock.releaseHeldStream()
    await page.waitForFunction(
      expected => (document.querySelector('[data-slot="aui_thread-viewport"]')?.textContent ?? '').includes(expected),
      MOCK_REPLY,
      { timeout: 60_000 }
    )
    await expect.poll(() => mock.receivedPrompts.filter(prompt => prompt === QUEUED_PROMPT)).toHaveLength(1)

    // Reviewed (v0.0.9, G 1c2bbb9423 :89 flaky): after every turn the runtime asks the model for a session title
    // (agent/title_generator.py), and that request carries the turn's user text as its last user message. The mock
    // logged it as a prompt, so the poll above passed only when it sampled between the turn and its title request,
    // and under load it saw two. The queue itself submitted once. The mock now keeps title requests apart; the
    // assertion holds once the queued turn's title request has really arrived, so no sampling window decides it.
    await expect.poll(() => mock.receivedTitleRequests.filter(text => text === QUEUED_PROMPT).length, { timeout: 30_000 }).toBeGreaterThan(0)
    expect(mock.receivedPrompts.filter(prompt => prompt === QUEUED_PROMPT)).toHaveLength(1)
  })

  test('places a steer prompt before the reply it redirects', async () => {
    const { mock, page } = fixture!

    await send(page, ACTIVE_PROMPT)
    await mock.waitForHeldStream()
    await steer(page, STEER_PROMPT)
    mock.releaseHeldStream()

    await page.waitForFunction(
      expected => (document.querySelector('[data-slot="aui_thread-viewport"]')?.textContent ?? '').includes(expected),
      MOCK_REPLY,
      { timeout: 60_000 }
    )

    expect(steerTurnOrder(await transcriptMessageOrder(page))).toEqual([ACTIVE_PROMPT, STEER_PROMPT, MOCK_REPLY])
  })
})
