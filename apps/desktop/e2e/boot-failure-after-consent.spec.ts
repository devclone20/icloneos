/**
 * v0.0.9 F3 (owner decision, permanent): after the first run (the consent seeded), a dead backend must show the
 * failure CARD and the card must close. Red on 776b6d9e98: main's late progress snapshot turned the failed boot back to
 * "running", the card (which needs a stopped boot) never showed, and the onboarding sheet sat on "The failure screen
 * shows what happened" over nothing.
 *
 * Two dead backends:
 * 1. the boot-failure fixture's fake error (the fast failure that first showed the bug);
 * 2. a REAL failed start: the agent's own config.yaml does not parse, so its process exits during start-up (the
 *    checkout's own venv, the gate in place, no fake flag).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  buildAppEnv,
  createSandbox,
  type DeadBackendFixture,
  launchDesktop,
  type Sandbox,
  setupDeadBackend,
  waitForBootFailure,
  writeEnvFile
} from './fixtures'
import { allowErrorBanners, type ElectronApplication, expect, type Page, test } from './test'

async function expectCardThenClose(page: Page): Promise<void> {
  await waitForBootFailure(page, 90_000)

  const card = page.getByRole('dialog').filter({ has: page.locator('#boot-failure-title') })

  await expect(card).toBeVisible()
  await expect(page.locator('[data-consent-step]')).toHaveCount(0)
  // Not the onboarding sheet's dead end: no line about a failure screen that is not there.
  await expect(page.getByTestId('onboarding-boot-cause')).toHaveCount(0)

  // Closable (F3 point B): the X closes the card into the "agent stopped" banner; nothing is started.
  await page.getByTestId('boot-failure-close').click()
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('agent-stopped-banner')).toBeVisible()
}

let fixture: DeadBackendFixture | null = null
let app: ElectronApplication | null = null
let sandbox: Sandbox | null = null

test.beforeEach(() => {
  // A failed boot raises its own error notice: expected here.
  allowErrorBanners()
})

test.afterEach(async () => {
  await fixture?.cleanup()
  fixture = null
  await app?.close().catch(() => undefined)
  app = null
  sandbox?.cleanup()
  sandbox = null

})

test('after the consent, a dead backend (the boot-failure fixture) shows the failure card, and it closes', async () => {
  fixture = await setupDeadBackend({ fakeError: true })
  await expectCardThenClose(fixture.page)
})

test('after the consent, a REAL failed agent start shows the failure card, and it closes', async () => {
  sandbox = createSandbox('dead-agent')
  // A real failed start: the agent's own config does not parse, so its process exits during start-up (no fake flag).
  fs.writeFileSync(path.join(sandbox.hermesHome, 'config.yaml'), 'model: [unclosed\n  provider: : :\n', 'utf8')
  writeEnvFile(sandbox.hermesHome)

  const launched = await launchDesktop(buildAppEnv(sandbox), {
    claim: 'non-ready',
    reason: 'boot failure: the agent exits at start on its broken config (real failure path); the card is expected'
  })

  app = launched.app
  // The agent's own failure, not the gate's.
  await waitForBootFailure(launched.page, 90_000)
  await expect(launched.page.locator('#boot-failure-title')).toHaveText("The agent couldn't start")
  await expectCardThenClose(launched.page)
})

// v0.0.9 G re-shoot (G-banner-centred-island-open): with the Collection island open, the stopped banner was squeezed
// into a narrow column (light: the R5-6 equal insets left ~390px) or docked over the titlebar (dark: the split rule
// won over the island). Beside an open island it keeps its readable minimum width and hangs under the titlebar band,
// in both skins, panes side by side or not.
test('beside the open Collection island the stopped banner keeps its minimum width and stays under the titlebar', async () => {
  fixture = await setupDeadBackend({ fakeError: true })
  const { page } = fixture

  await expectCardThenClose(page)
  await page.getByRole('button', { name: 'iNFT collection' }).click()
  await expect(page.locator(':root[data-iclone-island]')).toHaveCount(1)

  const rows = await page.getByTestId('agent-stopped-banner').evaluate(banner => {
    const root = document.documentElement
    const plate = (banner.closest('.icn-banner') ?? banner) as HTMLElement
    const wrap = (plate.closest('.icn-banner-wrap') ?? plate) as HTMLElement
    const before = { panes: root.dataset.icPanes, skin: root.dataset.hermesTheme }

    const px = (value: string) => {
      const probe = document.createElement('div')

      probe.style.cssText = `position:absolute;visibility:hidden;width:${value}`
      document.body.append(probe)
      const width = probe.getBoundingClientRect().width
      probe.remove()

      return width
    }

    const minWidth = px(getComputedStyle(wrap).getPropertyValue('--icn-banner-min-w').trim() || '0px')
    const bandBottom = px(getComputedStyle(root).getPropertyValue('--ic-titlebar-band-h').trim() || '0px')

    // Design delta GF-8: in a split the panes' own header strips sit right under the band; the banner clears them.
    const paneHeadBottom =
      px(getComputedStyle(root).getPropertyValue('--ic-frame-top').trim() || '0px') +
      px(getComputedStyle(root).getPropertyValue('--ic-win-head-h').trim() || '0px')

    const out: {
      case: string
      width: number
      top: number
      minWidth: number
      bandBottom: number
      clearOf: number
    }[] = []

    for (const skin of ['iclone-dark', 'iclone-light']) {
      for (const panes of [before.panes ?? '', 'split']) {
        root.dataset.hermesTheme = skin

        if (panes) {
          root.dataset.icPanes = panes
        } else {
          delete root.dataset.icPanes
        }

        const box = plate.getBoundingClientRect()
        out.push({
          bandBottom,
          case: `${skin}/${panes || 'single'}`,
          clearOf: panes === 'split' ? paneHeadBottom : bandBottom,
          minWidth,
          top: box.top,
          width: box.width
        })
      }
    }

    before.skin === undefined ? delete root.dataset.hermesTheme : (root.dataset.hermesTheme = before.skin)
    before.panes === undefined ? delete root.dataset.icPanes : (root.dataset.icPanes = before.panes)

    return out
  })

  // v0.0.9 G UI lens: the minimum holds below 1100px too (it read 386px at 900-1026px); 960px beside the island.
  await fixture.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 800))
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(960)

  const narrow = await page.getByTestId('agent-stopped-banner').evaluate(banner => {
    const plate = (banner.closest('.icn-banner') ?? banner) as HTMLElement
    const wrap = (plate.closest('.icn-banner-wrap') ?? plate) as HTMLElement
    const probe = document.createElement('div')

    probe.style.cssText = `position:absolute;visibility:hidden;width:${getComputedStyle(wrap).getPropertyValue('--icn-banner-min-w').trim()}`
    document.body.append(probe)
    const minWidth = probe.getBoundingClientRect().width
    probe.remove()

    return { minWidth, width: plate.getBoundingClientRect().width }
  })

  expect(narrow.width, `banner at 960px ${JSON.stringify(narrow)}`).toBeGreaterThanOrEqual(narrow.minWidth - 0.5)

  for (const row of rows) {
    expect(row.minWidth, JSON.stringify(row)).toBeGreaterThan(0)
    expect(row.width, `banner width ${JSON.stringify(row)}`).toBeGreaterThanOrEqual(row.minWidth - 0.5)
    expect(row.top, `banner top ${JSON.stringify(row)}`).toBeGreaterThanOrEqual(row.bandBottom)
    expect(row.top, `banner clear of the pane headers ${JSON.stringify(row)}`).toBeGreaterThanOrEqual(row.clearOf)
  }
})
