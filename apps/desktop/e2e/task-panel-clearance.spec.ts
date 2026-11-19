/**
 * Regression coverage for returning to a working session as its task panel
 * expands. The transcript must reconcile to the composer's full measured
 * height without needing a manual scroll to repair the position.
 */

import { type MockBackendFixture, newConversation, openConversationList, setupMockBackend, waitForAppReady } from './fixtures'
import { TASK_PANEL_RESUME_TRIGGER } from './mock-server'
import { expect, type Page, test } from './test'

const SURFACE = '[data-composer-target]:visible'
const PROMPT = `${TASK_PANEL_RESUME_TRIGGER}: keep the task panel expanded while this session is reopened.`

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

// Reviewed port (v0.0.9): upstream's sidebar is, in icloneOS, the Message pane's conversation list (the same
// SidebarSessionRow, src/app/home/msg-sidebar.tsx:642): "New conversation" there, and the working row there.
async function openFreshDraft(page: Page): Promise<void> {
  await newConversation(page)
  await expect(activeSurface(page).locator('[data-slot="aui_thread-viewport"]')).not.toContainText(PROMPT)
  await page.waitForTimeout(1_000)
}

async function reopenWorkingSession(page: Page): Promise<void> {
  await openConversationList(page)
  const sidebar = page.getByRole('navigation', { name: 'Conversations' }).locator('.imsg-side__panel')
  const row = sidebar.getByRole('button', { name: /^(?:Session running|Needs your input|Working)\b/ }).first()

  await row.waitFor({ state: 'visible', timeout: 30_000 })
  await row.click()
  await expect(activeSurface(page).locator('[data-slot="aui_thread-viewport"]')).toContainText(
    'Task-panel clearance line 24',
    { timeout: 30_000 }
  )
}

interface ClearanceMetrics {
  composerHeight: number
  distanceFromBottom: number
  latestMessageBottom: number
  statusPanelTop: number
  viewportHeight: number
}

async function clearanceMetrics(page: Page): Promise<ClearanceMetrics> {
  return activeSurface(page).evaluate(surface => {
    const chatSurface = surface.closest<HTMLElement>('[data-chat-surface]')!
    const viewport = surface.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]')!
    const latest = Array.from(surface.querySelectorAll<HTMLElement>('[data-role="assistant"]')).at(-1)!
    const status = surface.querySelector<HTMLElement>('[data-slot="composer-status-stack"]')!
    const styles = getComputedStyle(chatSurface)

    return {
      composerHeight: Number.parseFloat(styles.getPropertyValue('--composer-measured-height')),
      distanceFromBottom: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      latestMessageBottom: latest.getBoundingClientRect().bottom,
      statusPanelTop: status.getBoundingClientRect().top,
      viewportHeight: viewport.clientHeight
    }
  })
}

test.describe('working-session task-panel clearance', () => {
  let fixture: MockBackendFixture | null = null

  test.beforeEach(async () => {
    fixture = await setupMockBackend({
      mockServer: { holdFirstCompletionContaining: TASK_PANEL_RESUME_TRIGGER }
    })
    await waitForAppReady(fixture, 120_000)
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
    fixture = null
  })

  test('window focus reanchors a working session above the expanded task panel', async ({}, testInfo) => {
    const page = fixture!.page

    await send(page, PROMPT)
    await fixture!.mock.waitForHeldCompletion()
    await openFreshDraft(page)

    // Re-open while the long response is still streaming. Its todo call lands
    // afterward, so the already-visible composer grows only after the initial
    // session-load scroll settle has finished.
    fixture!.mock.releaseHeldStream()
    await page.waitForTimeout(1_000)
    await reopenWorkingSession(page)
    await expect(activeSurface(page).getByText('Tasks 1/5')).toBeVisible({ timeout: 30_000 })

    // Reproduce the stale geometry at the foreground boundary. Active turns
    // disable Chromium's background throttling, so visibility can stay `visible`
    // and window focus is the only foreground edge that can repair it.
    await page.waitForTimeout(750)

    const staleState = await activeSurface(page)
      .locator('[data-slot="aui_thread-viewport"]')
      .evaluate(viewport => {
        // Grow scrollHeight before the observed thread-content node. This
        // shifts the transcript behind the dock without resizing the observed
        // node or synthesizing a user scroll (which must escape the lock).
        const staleClearance = document.createElement('div')
        staleClearance.style.height = '160px'
        staleClearance.setAttribute('aria-hidden', 'true')
        viewport.prepend(staleClearance)

        const distance = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
        const surface = viewport.closest<HTMLElement>('[data-composer-target]')!
        const latest = Array.from(surface.querySelectorAll<HTMLElement>('[data-role="assistant"]')).at(-1)!
        const status = surface.querySelector<HTMLElement>('[data-slot="composer-status-stack"]')!

        window.dispatchEvent(new Event('focus'))

        return {
          distance,
          following: viewport.dataset.following,
          latestMessageBottom: latest.getBoundingClientRect().bottom,
          statusPanelTop: status.getBoundingClientRect().top,
          visibility: document.visibilityState
        }
      })

    expect(staleState.visibility, JSON.stringify(staleState)).toBe('visible')
    expect(staleState.following, JSON.stringify(staleState)).toBe('true')
    expect(staleState.distance).toBeGreaterThan(100)
    expect(staleState.latestMessageBottom, JSON.stringify(staleState)).toBeGreaterThan(staleState.statusPanelTop)
    await page.waitForTimeout(1_000)
    const metrics = await clearanceMetrics(page)
    await page.screenshot({ path: testInfo.outputPath('task-panel-after-resume.png') })

    expect(metrics.composerHeight, JSON.stringify(metrics)).toBeGreaterThanOrEqual(190)
    expect(metrics.distanceFromBottom, JSON.stringify(metrics)).toBeLessThan(staleState.distance / 2)
    expect(metrics.latestMessageBottom, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.statusPanelTop)

    // v0.0.9 G GF-M1 (MAJOR): the pinned prompt is the F1c shot of this very state. Its sticky slab must be opaque
    // in both skins, so the scrolled reply never shows inside it: the computed background alpha is 1.
    const slabAlpha = await activeSurface(page)
      .locator('[data-slot="aui_user-message-root"]')
      .first()
      .evaluate(row => {
        const root = document.documentElement
        const before = root.dataset.hermesTheme

        // rgb()/rgba() from a plain colour, color(srgb r g b / a) from a color-mix().
        const alphaOf = (color: string) => {
          const slash = /\/\s*([\d.]+)\s*\)$/.exec(color)

          if (slash) {
            return Number(slash[1])
          }

          const m = /rgba?\(([^)]+)\)/.exec(color)
          const parts = m ? m[1].split(/[,\s]+/).filter(Boolean) : []

          return parts.length === 4 ? Number(parts[3]) : parts.length === 3 ? 1 : /^color\(/.test(color) ? 1 : -1
        }

        const read = (skin: string) => {
          root.dataset.hermesTheme = skin

          return { skin, position: getComputedStyle(row).position, alpha: alphaOf(getComputedStyle(row).backgroundColor) }
        }

        const out = [read('iclone-dark'), read('iclone-light')]

        if (before === undefined) {
          delete root.dataset.hermesTheme
        } else {
          root.dataset.hermesTheme = before
        }

        return out
      })

    // v0.0.9 G design delta GF-6: no half-cut reply line shows in the strip between the viewport's top and the stuck
    // slab (the sticky offset), and a fade sits under the slab so the next line never butts against it.
    const edge = await activeSurface(page)
      .locator('[data-slot="aui_thread-viewport"]')
      .evaluate(viewport => {
        const top = viewport.getBoundingClientRect().top
        const row = viewport.querySelector('[data-slot="aui_user-message-root"]') as HTMLElement
        const box = row.getBoundingClientRect()
        const mask = row.querySelector('[data-slot="sticky-human-mask"]') as HTMLElement | null
        const fade = row.querySelector('[data-slot="sticky-human-fade"]')
        const m = mask?.getBoundingClientRect()
        const maskStyle = mask ? getComputedStyle(mask) : null

        return {
          fadeShown: fade ? getComputedStyle(fade).display !== 'none' && fade.getBoundingClientRect().height >= 8 : false,
          strip: box.top - top,
          // The mask spans the whole strip (from at or above the viewport's top down to the row), opaque, inside the
          // stuck row's own stacking (z-40), so the reply text under it never shows.
          stripIsMask: Boolean(
            m &&
              maskStyle!.display !== 'none' &&
              m.top <= top + 0.5 &&
              m.bottom >= box.top - 0.5 &&
              !/\/\s*0?\.\d+\)|rgba\([^)]*,\s*0?\.\d+\)/.test(maskStyle!.backgroundColor)
          )
        }
      })

    expect(edge.strip, JSON.stringify(edge)).toBeGreaterThan(0)
    expect(edge.stripIsMask, JSON.stringify(edge)).toBe(true)
    expect(edge.fadeShown, JSON.stringify(edge)).toBe(true)

    for (const { alpha, position, skin } of slabAlpha) {
      expect(position, skin).toBe('sticky')
      expect(alpha, `the sticky prompt's slab is opaque in ${skin}`).toBe(1)
    }
  })
})
