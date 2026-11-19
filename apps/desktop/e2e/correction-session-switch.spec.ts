/**
 * Regression coverage for a correction sent during a live response, then a
 * warm session switch away and back. The correction is an accepted user turn,
 * not an optimistic duplicate of the original prompt, and its relative place
 * in the transcript must survive the resume reconciliation.
 */

import { type TestInfo } from '@playwright/test'

import { contrastInBothModes } from './contrast'
import { conversationRow, type MockBackendFixture, newConversation, openConversationList, setupMockBackend, waitForAppReady } from './fixtures'
import { CORRECTION_SWITCH_TRIGGER, MOCK_REPLY } from './mock-server'
import { expect, type Page, test } from './test'

const OTHER_SESSION_PROMPT = 'E2E persisted session used for a warm resume.'
const ORIGINAL_PROMPT = `${CORRECTION_SWITCH_TRIGGER}: original prompt must remain singular after a correction.`
const CORRECTION = 'E2E correction must stay after the original prompt.'
const TOOL_STARTED = 'Checking the long-running task before I continue.'
const CORRECTED_REPLY = 'The corrected task finished.'
const INFERENCE_SWITCH_TRIGGER = 'E2E_INFERENCE_SWITCH_TRIGGER'
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Reviewed port (v0.0.9): the other session's row, by its generated title (upstream: the mock reply) or, before a
// title lands, by its first prompt (icloneOS rows show sessionTitle(session), src/app/home/msg-sidebar.tsx:642).
const OTHER_SESSION_ROW = new RegExp(`${escapeRe(MOCK_REPLY)}|${escapeRe(OTHER_SESSION_PROMPT)}`)

// The row of a session names its latest turn as it goes (the screenshots of the first port run: "The corrected task
// finished." for the original session, its correction for the inference one), so each session's row is matched by
// any text that session alone carries.
// A generated title drops the closing period ("The corrected task finished"), so match without it.
const ORIGINAL_SESSION_ROW = new RegExp(
  [ORIGINAL_PROMPT, CORRECTION, TOOL_STARTED, CORRECTED_REPLY].map(text => escapeRe(text.replace(/\.$/, ''))).join('|')
)

const INFERENCE_SESSION_ROW = new RegExp(escapeRe(INFERENCE_SWITCH_TRIGGER))
const INFERENCE_PROMPT = `${INFERENCE_SWITCH_TRIGGER}: original inference prompt must remain singular.`
const INFERENCE_CORRECTION = `${INFERENCE_SWITCH_TRIGGER}: correction sent while inference is live.`

// Inactive tabs stay mounted under a data-pane-hidden ancestor. Match the
// renderer's keep-alive visibility policy instead of relying on DOM order.
const SURFACE = '[data-composer-target]:not([data-pane-hidden] [data-composer-target])'

function activeSurface(page: Page) {
  return page.locator(SURFACE).last()
}

async function send(page: Page, text: string): Promise<void> {
  const composer = activeSurface(page).locator('[contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 15_000 })
  await composer.click()
  await composer.type(text, { delay: 5 })
  await page.keyboard.press('Enter')
}

async function waitForTranscriptText(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    ([expected, surfaceSelector]: [string, string]) => {
      const surfaces = document.querySelectorAll(surfaceSelector)
      const active = surfaces[surfaces.length - 1]

      return (active?.querySelector('[data-slot="aui_thread-viewport"]')?.textContent ?? '').includes(expected)
    },
    [text, SURFACE] as [string, string],
    { timeout: 30_000 }
  )
}

async function textNodeOccurrences(page: Page, text: string): Promise<number> {
  return page.evaluate(
    ([expected, surfaceSelector]: [string, string]) => {
      const surfaces = document.querySelectorAll(surfaceSelector)
      const viewport = surfaces[surfaces.length - 1]?.querySelector('[data-slot="aui_thread-viewport"]')

      if (!viewport) {
        return 0
      }

      const walker = document.createTreeWalker(viewport, NodeFilter.SHOW_TEXT)
      let count = 0

      while (walker.nextNode()) {
        // Reviewed port (v0.0.9): only transcript messages count. icloneOS's chat header names the session by its
        // title, which can be this very prompt; that is chrome, not a duplicated turn.
        if (walker.currentNode.parentElement?.closest('[data-role]') && walker.currentNode.textContent?.includes(expected)) {
          count += 1
        }
      }

      return count
    },
    [text, SURFACE] as [string, string]
  )
}

async function transcriptTextOrder(page: Page): Promise<string[]> {
  return page.evaluate((surfaceSelector: string) => {
    const surfaces = document.querySelectorAll(surfaceSelector)
    const viewport = surfaces[surfaces.length - 1]?.querySelector('[data-slot="aui_thread-viewport"]')

    if (!viewport) {
      return []
    }

    return Array.from(viewport.querySelectorAll<HTMLElement>('[data-role="message"], [data-message-id]'))
      .map(message => message.textContent?.trim() ?? '')
      .filter(Boolean)
  }, SURFACE)
}

async function transcriptMessageOrder(page: Page): Promise<string[]> {
  return page.evaluate((surfaceSelector: string) => {
    const surfaces = document.querySelectorAll(surfaceSelector)
    const viewport = surfaces[surfaces.length - 1]?.querySelector('[data-slot="aui_thread-viewport"]')

    if (!viewport) {
      return []
    }

    return Array.from(
      viewport.querySelectorAll<HTMLElement>('[data-role="user"], [data-role="assistant"], [data-role="system"]')
    )
      .map(message => message.textContent?.trim() ?? '')
      .filter(Boolean)
  }, SURFACE)
}

/**
 * Reviewed port (v0.0.9): upstream's sidebar "+" is the Message pane's conversation list "New conversation" in
 * icloneOS (fixtures.newConversation). Wait for the active surface to show a transcript without the prior text.
 */
async function openFreshDraft(page: Page, priorSessionText: string): Promise<void> {
  await newConversation(page)
  await page.waitForFunction(
    ([priorText, surfaceSelector]: [string, string]) => {
      const surfaces = document.querySelectorAll(surfaceSelector)
      const active = surfaces[surfaces.length - 1]
      const transcript = active?.querySelector('[data-slot="aui_thread-viewport"]')?.textContent ?? ''

      return surfaces.length > 0 && !transcript.includes(priorText)
    },
    [priorSessionText, SURFACE] as [string, string],
    { timeout: 15_000 }
  )
}

// Reviewed port (v0.0.9): upstream's sidebar rows are the Message pane's conversation list rows in icloneOS.
async function openSidebarSession(page: Page, sidebarText: RegExp | string, expectedTranscriptText: string): Promise<void> {
  await openConversationList(page)
  const row = conversationRow(page, sidebarText)
  await row.waitFor({ state: 'visible', timeout: 30_000 })
  await row.click()
  await waitForTranscriptText(page, expectedTranscriptText)
}

async function reopenOriginalSession(page: Page): Promise<void> {
  // A still-running tool has not generated a final title yet, so the sidebar
  // retains the source prompt as its provisional session title.
  await openSidebarSession(page, ORIGINAL_SESSION_ROW, ORIGINAL_PROMPT)
}

async function reopenInferenceSession(page: Page): Promise<void> {
  await openConversationList(page)
  const row = conversationRow(page, INFERENCE_SESSION_ROW)
  await row.waitFor({ state: 'visible', timeout: 30_000 })
  await row.click()
  await waitForTranscriptText(page, INFERENCE_PROMPT)
}

function relevantOrder(messages: string[]): string[] {
  return messages.flatMap(message => {
    if (message.includes(ORIGINAL_PROMPT)) {
      return [ORIGINAL_PROMPT]
    }

    if (message.includes(CORRECTION)) {
      return [CORRECTION]
    }

    return []
  })
}

function steerTurnOrder(messages: string[]): string[] {
  return messages.flatMap(message => {
    if (message.includes(ORIGINAL_PROMPT)) {
      return [ORIGINAL_PROMPT]
    }

    if (message.includes(CORRECTION)) {
      return [CORRECTION]
    }

    if (message.includes(CORRECTED_REPLY)) {
      return [CORRECTED_REPLY]
    }

    return []
  })
}

test.describe('correction session switch', () => {
  let fixture: MockBackendFixture | null = null

  test.beforeEach(async () => {
    fixture = await setupMockBackend({
      mockServer: { holdFirstStreamForPrompt: INFERENCE_SWITCH_TRIGGER }
    })
    await waitForAppReady(fixture, 120_000)
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
    fixture = null
  })

  // Reviewed port (v0.0.9): in icloneOS the e2e sandbox's gate refuses the scripted foreground `sleep 5` before it
  // runs, so there is no live tool to steer into. With rt's fix the refusal is a visible row (tool.complete
  // refused: true, rendered by tool/fallback-model 'refused'), the turn ends, and the correction becomes its own
  // turn. What a user relies on is asserted in full: the refusal is shown with its reason (never "Ran"), the correction
  // lands and is answered, and a warm switch away and back keeps exactly that transcript, no row duplicated or moved.
  // Steering into a live foreground tool is N/A in the e2e sandbox (the next test); steering into a live turn is
  // covered by the inference-time correction test.
  test('shows the refused tool and keeps the correction in place, unduplicated, after switching sessions', async ({}, testInfo: TestInfo) => {
    const { page } = fixture!

    // A blank draft does not exercise session hydration. Seed a real second
    // session first, matching the observed switch between two saved chats.
    await send(page, OTHER_SESSION_PROMPT)
    await waitForTranscriptText(page, MOCK_REPLY)
    await openFreshDraft(page, OTHER_SESSION_PROMPT)

    await send(page, ORIGINAL_PROMPT)
    await waitForTranscriptText(page, TOOL_STARTED)
    await waitForTranscriptText(page, ORIGINAL_PROMPT)

    // The refused command is a visible row: titled Refused, with the quiet refusal glyph, never a run.
    const refusedRow = activeSurface(page).getByText(/^Refused\b/).first()
    await expect(refusedRow).toBeVisible({ timeout: 30_000 })
    await expect(activeSurface(page).locator('[aria-label="Refused before it ran"]').first()).toBeVisible()
    // v0.0.9 G re-shoot: the row names the tool and says why it was refused, not only the command.
    await expect(activeSurface(page).getByText('Refused · Terminal').first()).toBeVisible()
    const reason = activeSurface(page).locator('[data-slot="tool-refusal-reason"]').first()

    await expect(reason).not.toBeEmpty()
    // v0.0.9 G GF-M2: the collapsed line speaks to the owner, never the agent-directed result, and it holds AA in
    // both skins, computed in the live page: its ink with every ancestor's opacity, over the backgrounds under it.
    await expect(reason).not.toContainText(/BLOCKED|tell the owner/)

    const contrast = await contrastInBothModes(page, reason)

    expect(new Set(contrast.map(row => row.mode))).toEqual(new Set(['dark', 'light']))

    for (const row of contrast) {
      expect(row.ratio, JSON.stringify(row)).toBeGreaterThanOrEqual(4.5)
    }

    await expect(activeSurface(page).getByText(/^Ran sleep/)).toHaveCount(0)
    await waitForTranscriptText(page, CORRECTED_REPLY)

    // The correction goes through the real composer (inserted, not typed key by key: typing dropped a space here once,
    // 'E2Ecorrection', noted as a finding) and is answered.
    const composer = activeSurface(page).locator('[contenteditable="true"]').first()
    await composer.click()
    await page.keyboard.insertText(CORRECTION)
    await page.keyboard.press('Enter')
    await waitForTranscriptText(page, CORRECTION)
    await expect
      .poll(async () => steerTurnOrder(await transcriptMessageOrder(page)), { timeout: 30_000 })
      .toEqual([ORIGINAL_PROMPT, CORRECTED_REPLY, CORRECTION, CORRECTED_REPLY])

    const orderBeforeSwitch = steerTurnOrder(await transcriptMessageOrder(page))
    expect(await textNodeOccurrences(page, ORIGINAL_PROMPT)).toBe(1)
    expect(await textNodeOccurrences(page, CORRECTION)).toBe(1)
    await page.screenshot({ path: testInfo.outputPath('correction-before-session-switch.png') })

    await openSidebarSession(page, OTHER_SESSION_ROW, OTHER_SESSION_PROMPT)
    await reopenOriginalSession(page)
    await page.waitForTimeout(500)
    await page.screenshot({ path: testInfo.outputPath('correction-after-warm-resume.png') })

    expect(steerTurnOrder(await transcriptMessageOrder(page))).toEqual(orderBeforeSwitch)
    expect(await textNodeOccurrences(page, ORIGINAL_PROMPT)).toBe(1)
    expect(await textNodeOccurrences(page, CORRECTION)).toBe(1)
    // The refusal is persisted (display_metadata.refused): it survives the switch...
    await expect(activeSurface(page).getByText(/^Refused\b/).first()).toBeVisible()
    await expect(activeSurface(page).getByText(/^Ran sleep/)).toHaveCount(0)

    // ...and a reload, where the transcript comes back from the stored session alone.
    await page.reload()
    await waitForAppReady(fixture!, 120_000)
    await reopenOriginalSession(page)
    await expect(activeSurface(page).getByText(/^Refused\b/).first()).toBeVisible({ timeout: 30_000 })
    await expect(activeSurface(page).getByText(/^Ran sleep/)).toHaveCount(0)
    expect(steerTurnOrder(await transcriptMessageOrder(page))).toEqual(orderBeforeSwitch)
  })

  test('steers a correction into a live foreground terminal tool', async () => {
    test.skip(true, 'N/A in v0.0.9: upstream steering into a live foreground tool; the foreground terminal is refused under e2e confinement plus Manual mode; steering into a live turn is covered by :266')
  })

  test('keeps an inference-time correction visible through a warm session switch', async ({}, testInfo: TestInfo) => {
    const { mock, page } = fixture!

    await send(page, OTHER_SESSION_PROMPT)
    await waitForTranscriptText(page, MOCK_REPLY)
    await openFreshDraft(page, OTHER_SESSION_PROMPT)

    await send(page, INFERENCE_PROMPT)
    await mock.waitForHeldStream()
    await waitForTranscriptText(page, INFERENCE_PROMPT)

    await send(page, INFERENCE_CORRECTION)
    await waitForTranscriptText(page, INFERENCE_CORRECTION)

    await openSidebarSession(page, OTHER_SESSION_ROW, OTHER_SESSION_PROMPT)
    await reopenInferenceSession(page)

    expect(await textNodeOccurrences(page, INFERENCE_PROMPT)).toBe(1)
    expect(await textNodeOccurrences(page, INFERENCE_CORRECTION)).toBe(1)
    await page.screenshot({ path: testInfo.outputPath('inference-correction-after-warm-resume.png') })

    mock.releaseHeldStream()
    await waitForTranscriptText(page, MOCK_REPLY)
  })
})
