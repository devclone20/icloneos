import * as fs from 'node:fs'
import * as path from 'node:path'

import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
/**
 * E2E smoke tests for the dev-mode desktop app.
 *
 * These tests launch the Electron app from the built dist/ (not the
 * packaged binary) with a real `hermes serve` backend pointed at a mock
 * inference server. The full chain is exercised:
 *
 *   electron → hermes serve (python) → mock provider → renderer
 *
 * Prerequisite: `npm run build` must have been run so dist/ exists.
 * Run from the nix devshell:
 *   npm exec playwright test e2e/boot.spec.ts --reporter=list
 */
import { expect, test } from './test'
import { expectVisualSnapshot } from './visual-snapshot'

let fixture: MockBackendFixture | null = null

// v0.0.9 e2e harness (owner condition): every test below claims a booted app, so the suite reaches ready FIRST. A
// launch that never reaches ready (no consent seed, a gate the python cannot load) fails here with its cause, instead
// of the DOM-only tests passing over a policy dialog and a gate card (e2e triage "false passes").
test.beforeAll(async () => {
  fixture = await setupMockBackend()
  await waitForAppReady(fixture, 120_000)
})

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
})

test.describe('dev-mode boot with mock backend', () => {
  // Reviewed loosening (v0.0.9 e2e triage, class A): the upstream expectation was "Hermes"; the product title is
  // index.html's own `<title>iclone os</title>`. The test now reads that file and asserts the window carries exactly
  // it, so a future rename moves both together instead of loosening the check further.
  test('window opens with the product title (index.html)', async () => {
    const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8')
    const product = /<title>([^<]+)<\/title>/.exec(html)?.[1]

    expect(product).toBe('iclone os')
    expect(await fixture!.page.title()).toBe(product)
  })

  test('renderer mounts and shows DOM content', async () => {
    const page = fixture!.page
    // Wait for the React root to mount. The app renders into #root
    // (see src/main.tsx), but content may arrive through portals — so
    // check the body for any interactive content instead.
    await page.waitForSelector('body', { state: 'attached' })
    // Wait for the main app shell — the composer is always present.
    await page.waitForSelector('textarea, [contenteditable="true"]', {
      state: 'attached',
      timeout: 30_000
    })
  })

  // A preload that throws never reaches contextBridge, so the renderer boots
  // into "Desktop IPC bridge is unavailable" and every test below it dies on a
  // 120s never-became-ready timeout instead. Checking the bridge by name makes
  // that failure legible. The sandbox lets preload require only electron,
  // events, timers and url — adding any other node builtin lands here.
  test('the preload bridge reaches the renderer', async () => {
    const bridge = await fixture!.page.evaluate(() => {
      const desktop = (window as unknown as { hermesDesktop?: Record<string, unknown> }).hermesDesktop

      return {
        present: typeof desktop,
        glassSupported: typeof desktop?.glassSupported,
        translucencySupported: typeof desktop?.translucencySupported
      }
    })

    expect(bridge).toEqual({ present: 'object', glassSupported: 'boolean', translucencySupported: 'boolean' })
  })

  test('backend boots and app becomes ready', async () => {
    // This is the big one — wait for the full boot chain to complete:
    // electron starts → hermes serve is spawned → WS connects → config
    // loaded → sessions loaded → boot overlay dismissed → composer visible.
    await waitForAppReady(fixture!, 120_000)
  })

  test('screenshot after boot', async () => {
    await expectVisualSnapshot(fixture!.page, { name: 'boot-ready', app: fixture!.app })
  })
})
