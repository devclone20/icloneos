/**
 * v0.0.9 (#8, user input loss): typing right after the first Enter of a fresh chat could be wiped when the chat's
 * composer key moved from "no session yet" to the created session id (use-composer-draft.ts; unit test
 * use-composer-draft.adopt.test.tsx). This types immediately after the first Enter of several fresh chats, without any
 * delay, and requires every character to stay.
 */
import { MOCK_REPLY } from './mock-server'
import { type MockBackendFixture, newConversation, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

const FOLLOW_UP = 'E2E correction typed right after Enter'
const RUNS = 5

let fixture: MockBackendFixture | null = null

test.beforeAll(async () => {
  fixture = await setupMockBackend()
  await waitForAppReady(fixture, 120_000)
})

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
})

test('typing right after the first Enter of a fresh chat keeps every character', async () => {
  test.setTimeout(240_000)
  const page = fixture!.page
  const composer = page.locator('[data-slot="composer-root"] [contenteditable="true"]').first()

  for (let run = 0; run < RUNS; run += 1) {
    if (run > 0) {
      await newConversation(page)
    }

    await composer.click()
    await page.keyboard.insertText(`first message ${run}`)
    await page.keyboard.press('Enter')
    // No wait: the follow-up starts while the fresh chat is still being created.
    await page.keyboard.type(FOLLOW_UP)

    // Let the session creation land, then the reply, and the composer must still hold the whole follow-up.
    await page.waitForFunction(text => (document.body.textContent ?? '').includes(text), MOCK_REPLY, { timeout: 60_000 })
    await expect(composer, `run ${run}`).toHaveText(FOLLOW_UP)

    await composer.click()
    await page.keyboard.press('Meta+A')
    await page.keyboard.press('Backspace')
  }
})
