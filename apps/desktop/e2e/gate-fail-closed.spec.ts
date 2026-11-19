/**
 * v0.0.9 e2e harness (owner condition): the permission gate FAILS CLOSED. A Hermes root whose python cannot load the
 * iclone permission gate (here: a bare venv with none of the agent's packages, the exact state the e2e triage found
 * in the gates worktree) must show the gate card "The permission gate is not in place" and never reach ready.
 *
 * Nothing is mocked: the app spawns its real gate probe with that root's python, the probe cannot import the gate, and
 * the app refuses to start the agent. The root is a throwaway folder whose entries link to the checkout, except `.venv`
 * (a bare `python3 -m venv --without-pip`). The sandbox carries the consent seed, so the gate card is the ONLY overlay.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  buildAppEnv,
  createSandbox,
  GATE_TITLE,
  launchDesktop,
  type Sandbox,
  writeEnvFile,
  writeMockProviderConfig
} from './fixtures'
import { allowErrorBanners, type ElectronApplication, expect, test } from './test'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

/** A Hermes root that is the checkout in every entry but `.venv`, which is bare (no packages, no gate imports). */
function bareGateRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iclone-e2e-bare-gate-'))

  for (const entry of fs.readdirSync(REPO_ROOT)) {
    if (entry !== '.venv' && entry !== 'venv') {
      fs.symlinkSync(path.join(REPO_ROOT, entry), path.join(root, entry))
    }
  }

  const venv = spawnSync('python3', ['-m', 'venv', '--without-pip', path.join(root, '.venv')], { encoding: 'utf8' })

  if (venv.status !== 0) {
    throw new Error(`could not create the bare venv: ${venv.stderr}`)
  }

  // The premise of the test, checked: this python cannot import what the gate probe needs.
  const probe = spawnSync(path.join(root, '.venv', 'bin', 'python'), ['-s', '-c', 'import ruamel.yaml'])

  if (probe.status === 0) {
    throw new Error('the bare venv can import ruamel.yaml: the fail-closed premise does not hold')
  }

  return root
}

let app: ElectronApplication | null = null
let sandbox: Sandbox | null = null
let root: null | string = null

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  sandbox?.cleanup()
  sandbox = null

  if (root) {
    fs.rmSync(root, { force: true, recursive: true })
    root = null
  }
})

test('a Hermes root whose python cannot load the gate shows "The permission gate is not in place" and never gets ready', async () => {
  // The refused start raises its own error notice: expected here.
  allowErrorBanners()
  root = bareGateRoot()
  sandbox = createSandbox('gate-fail-closed')
  writeMockProviderConfig(sandbox.hermesHome, 'http://127.0.0.1:9')
  writeEnvFile(sandbox.hermesHome)

  const launched = await launchDesktop(buildAppEnv(sandbox, { HERMES_DESKTOP_HERMES_ROOT: root }), {
    claim: 'non-ready',
    reason: 'fail-closed: the gate cannot load, the gate card is the expected state'
  })

  app = launched.app

  const { page } = launched
  const card = page.getByRole('dialog').filter({ hasText: GATE_TITLE })

  await expect(card).toBeVisible({ timeout: 90_000 })
  expect(GATE_TITLE).toBe('The permission gate is not in place')

  // It stays: the app latches the cause and never starts the agent, so the card is still the top layer and no
  // composer can be reached, 15 s later.
  await page.waitForTimeout(15_000)
  await expect(card).toBeVisible()

  const topIsCard = await page.evaluate(title => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)

    return Boolean(el?.closest('[role="dialog"]')?.textContent?.includes(title))
  }, GATE_TITLE)

  // The card is the top layer at the window's centre: nothing behind it (the composer) can be reached, so the app is
  // not ready, which is the fail-closed state.
  expect(topIsCard).toBe(true)
})
