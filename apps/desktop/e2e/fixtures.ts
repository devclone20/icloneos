/**
 * Shared E2E fixtures for the Hermes desktop Playwright suite.
 *
 * Two fixture modes:
 *
 *  1. `mockBackend` — starts a mock inference server, writes a config.yaml
 *     that points at it, and launches the desktop app so the full chain
 *     (electron → hermes serve → provider → inference → renderer) is
 *     exercised with a real backend but a fake LLM.
 *
 *  2. `noProvider` — launches the app with an empty config (no provider
 *     configured). The onboarding overlay should appear. Used to test the
 *     first-run flow without real credentials.
 *
 * Both modes launch the *dev* Electron app (`electron .` against the built
 * `dist/`), not the packaged binary. This avoids the multi-minute
 * `electron-builder --dir` step and matches `hermes desktop --source`. The
 * packaged-binary path is already covered by `launch.spec.ts`.
 *
 * Prerequisite: `npm run build` must have been run so that `dist/` exists.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { _electron, type ElectronApplication, type Page } from '@playwright/test'

import { consentSeed } from './consent-seed'
import { type MockServerOptions, startMockServer } from './mock-server'
import { GATE_TITLE, judgeReadiness, type ReadinessVerdict, TERMINAL_VERDICTS } from './readiness'
import { readinessFacts } from './readiness-page'
import { claimBooted, claimNonReady, markReady, noteLaunch } from './ready-state'
import { installErrorBannerGuard } from './test'

const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')
export { consentSeed, E2E_CONSENT_SEED_MARKER } from './consent-seed'
/**
 * v0.0.9 G-M1: the mock provider's context window. The agent refuses any model under 64,000 tokens ("below the
 * minimum 64,000 required by Hermes Agent"), so the old 4,096 failed every real turn; 65,536 clears it. A spec that
 * needs a small window (compression) still sets model.context_length itself.
 */
export const E2E_MOCK_CONTEXT = 65_536
const RELEASE_ROOT = path.join(DESKTOP_ROOT, 'release')

// ─── Credential stripping (matches launch.spec.ts) ──────────────────────

const CREDENTIAL_SUFFIXES: string[] = [
  '_API_KEY',
  '_TOKEN',
  '_SECRET',
  '_PASSWORD',
  '_CREDENTIALS',
  '_ACCESS_KEY',
  '_PRIVATE_KEY',
  '_OAUTH_TOKEN'
]

const CREDENTIAL_NAMES = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CUSTOM_API_KEY',
  'GEMINI_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENROUTER_BASE_URL',
  'OLLAMA_BASE_URL',
  'GROQ_BASE_URL',
  'XAI_BASE_URL'
])

function isCredentialEnvVar(name: string): boolean {
  if (CREDENTIAL_NAMES.has(name)) {
    return true
  }

  return CREDENTIAL_SUFFIXES.some(suffix => name.endsWith(suffix))
}

function stripCredentials(env: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (!value) {
      continue
    }

    if (isCredentialEnvVar(key)) {
      continue
    }

    clean[key] = value
  }

  return clean
}

// ─── Sandbox creation ──────────────────────────────────────────────────

export interface Sandbox {
  root: string
  hermesHome: string
  userDataDir: string
  cleanup: () => void
}

export { GATE_TITLE, HOME_REGION_LABEL } from './readiness'

export function createSandbox(prefix: string, { consent = true }: { consent?: boolean } = {}): Sandbox {
  // A short root, like a default install's userData, so the sockets under it bind: macOS's sun_path is 104 bytes, and
  // the old root (os.tmpdir() + 'hermes-e2e-<prefix>-<Math.random()>') put the launcher socket at 139 bytes, where it
  // never bound and the agent silently lost `terminal` (rt's capture; the app now refuses such a path loudly,
  // electron/socket-path.ts). A long os.tmpdir() (macOS's per-user /var/folders/…/T) falls back to /tmp.
  const base = Buffer.byteLength(os.tmpdir()) <= 32 ? os.tmpdir() : '/tmp'
  const root = fs.mkdtempSync(path.join(base, `e2e-${prefix.replace(/[^\w-]/g, '').slice(0, 10)}-`))
  const hermesHome = path.join(root, 'hermes-home')
  const userDataDir = path.join(root, 'electron-user-data')

  fs.mkdirSync(hermesHome, { recursive: true })
  fs.mkdirSync(userDataDir, { recursive: true })

  // Write a fixed window-state.json so the Electron window opens at a
  // consistent size — helps with visual regression screenshots.  The
  // exact size is also enforced right before each screenshot (see
  // expectVisualSnapshot in visual-snapshot.ts) because window managers
  // may resize after launch.
  fs.writeFileSync(
    path.join(userDataDir, 'window-state.json'),
    JSON.stringify({ x: 0, y: 0, width: 1220, height: 800, isMaximized: false }, null, 2),
    'utf8'
  )

  // Pin Chromium actual-size zoom (level 0) for the suite. Fresh installs
  // ship DEFAULT_ZOOM_LEVEL at the Appearance 90% preset, but Playwright
  // click hit-testing and the committed visual baselines were calibrated at
  // 100%. Without this file every sandbox would inherit the product default
  // and fail pointer interception + snapshot diffs.
  fs.writeFileSync(path.join(userDataDir, 'zoom-state.json'), JSON.stringify({ zoomLevel: 0 }, null, 2), 'utf8')

  if (consent) {
    fs.writeFileSync(path.join(userDataDir, 'consent.json'), `${JSON.stringify(consentSeed(), null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
  }

  return {
    root,
    hermesHome,
    userDataDir,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
  }
}

// ─── Config writing ─────────────────────────────────────────────────────

/**
 * Write a config.yaml that pre-configures a mock provider pointing at the
 * mock inference server. The provider is set as the active model provider so
 * the desktop app skips onboarding and boots straight to the chat UI.
 *
 * @param extraDisplayConfig optional YAML lines appended to the `display:`
 *   section, used by the interim-message e2e test.
 * @param extraConfig optional top-level YAML sections for a test scenario.
 * @param modelContextLength optional primary-model context limit.
 */
export function writeMockProviderConfig(
  hermesHome: string,
  mockUrl: string,
  extraDisplayConfig?: string,
  extraConfig?: string,
  modelContextLength?: number
): void {
  const configPath = path.join(hermesHome, 'config.yaml')

  const displaySection = extraDisplayConfig ? `\ndisplay:\n${extraDisplayConfig}\n` : ''

  const config = `# Auto-generated by E2E test fixtures
model:
  default: mock-model
  provider: mock
${modelContextLength ? `  context_length: ${modelContextLength}\n` : ''}providers:
  mock:
    api: ${mockUrl}/v1
    name: Mock
    api_mode: chat_completions
    key_env: MOCK_API_KEY
    models:
      mock-model: {}
    context_length: ${E2E_MOCK_CONTEXT}
${displaySection}${extraConfig ? `\n${extraConfig.trim()}\n` : ''}`

  fs.writeFileSync(configPath, config, 'utf8')
}

/**
 * Write a minimal .env with the mock API key. The key_env in config.yaml
 * references MOCK_API_KEY, so the backend resolves credentials from here.
 */
export function writeEnvFile(hermesHome: string, apiKey = 'e2e-mock-key'): void {
  const envPath = path.join(hermesHome, '.env')
  fs.writeFileSync(envPath, `MOCK_API_KEY=${apiKey}\n`, 'utf8')
}

/**
 * Write an empty config (no providers). The desktop app should show the
 * onboarding overlay because no inference provider is configured.
 */
function writeEmptyConfig(hermesHome: string): void {
  const configPath = path.join(hermesHome, 'config.yaml')
  fs.writeFileSync(configPath, '# Auto-generated by E2E test fixtures — no providers configured\n', 'utf8')
}

// ─── Env building ──────────────────────────────────────────────────────

/**
 * Build the environment for the Electron app process.
 *
 * Key env vars:
 *  - HERMES_HOME → sandbox hermes-home (isolated config/sessions)
 *  - HERMES_DESKTOP_USER_DATA_DIR → sandbox electron-user-data
 *  - HERMES_DESKTOP_IGNORE_EXISTING=1 → don't pick up `hermes` from PATH
 *    (we want the dev checkout at REPO_ROOT)
 *  - HERMES_DESKTOP_HERMES_ROOT → REPO_ROOT (dev checkout resolution)
 *  - HERMES_DESKTOP_APP_NAME → unique-ish per test (avoids single-instance lock)
 *  - XDG_RUNTIME_DIR → ensure Electron has a writable runtime dir on Linux
 */
export function buildAppEnv(sandbox: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  const clean = stripCredentials(process.env)

  // XDG_RUNTIME_DIR is needed for Electron on Linux when running in a
  // headless/CI context — without it the zygote may fail to initialize.
  if (!clean.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR) {
    clean.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR
  }

  // DISPLAY — needed for Electron to open a window.
  if (!clean.DISPLAY && process.env.DISPLAY) {
    clean.DISPLAY = process.env.DISPLAY
  }

  return {
    ...clean,
    HERMES_HOME: sandbox.hermesHome,
    HERMES_DESKTOP_USER_DATA_DIR: sandbox.userDataDir,
    HERMES_DESKTOP_IGNORE_EXISTING: '1',
    HERMES_DESKTOP_HERMES_ROOT: REPO_ROOT,
    HERMES_DESKTOP_APP_NAME: `HermesE2E-${Date.now()}`,
    // `app.close()` in teardown must exit even when a spec leaves a turn
    // mid-flight — otherwise the quit confirmation waits on a click that no
    // one is there to make, and the worker dies on a teardown timeout.
    HERMES_DESKTOP_SKIP_QUIT_CONFIRM: '1',
    // Clear dev-server override — we want the built dist/, not a vite server.
    // The dev-server check in main.ts looks for this env var; if it's set,
    // it loads from the vite URL instead of the local file.
    ...extra
  }
}

// ─── Electron launch ────────────────────────────────────────────────────

/**
 * Verify that the desktop app has been built (dist/ exists). Playwright
 * tests can't run without it — the Electron main process loads
 * dist/electron-main.mjs and the renderer loads dist/index.html.
 */
function assertDistBuilt(): void {
  const distDir = path.join(DESKTOP_ROOT, 'dist')
  const electronMain = path.join(distDir, 'electron-main.mjs')
  const indexHtml = path.join(distDir, 'index.html')

  if (!fs.existsSync(electronMain)) {
    throw new Error(
      `Desktop dist not built. Run 'cd apps/desktop && npm run build' first.\n` + `Missing: ${electronMain}`
    )
  }

  if (!fs.existsSync(indexHtml)) {
    throw new Error(
      `Desktop dist/index.html not found. Run 'cd apps/desktop && npm run build' first.\n` + `Missing: ${indexHtml}`
    )
  }
}

/**
 * Find the Electron binary: the one the `electron` package installed (its `path.txt` names the executable inside
 * `dist/`), else a real `electron` on PATH (the nix devshell). The package's own `.bin/electron` shim is never used:
 * since Electron 42 it downloads the binary on its first run, and a test must not download anything.
 */
export function findElectron(): string {
  const electronPackage = path.join(REPO_ROOT, 'node_modules', 'electron')
  const pathFile = path.join(electronPackage, 'path.txt')

  if (fs.existsSync(pathFile)) {
    const installed = path.join(electronPackage, 'dist', fs.readFileSync(pathFile, 'utf8').trim())

    if (fs.existsSync(installed)) {
      return installed
    }
  }

  const result = spawnSync('which', ['electron'], {
    encoding: 'utf8'
  })

  if (result.status === 0 && result.stdout.trim()) {
    const onPath = fs.realpathSync(result.stdout.trim())
    const packageRoot = fs.existsSync(electronPackage) ? fs.realpathSync(electronPackage) : electronPackage

    if (!onPath.startsWith(packageRoot + path.sep)) {
      return onPath
    }
  }

  throw new Error(
    `Electron binary not found under ${path.join(electronPackage, 'dist')}. ` +
      'Run "node node_modules/electron/install.js" from the repo root to install it (tests never download it).'
  )
}

/**
 * Launch the desktop app in dev mode.
 *
 * @param sandbox  - isolated HERMES_HOME + userData
 * @param env      - the process environment (already has HERMES_HOME etc.)
 * @returns the ElectronApplication + first Page
 */
/**
 * v0.0.9 e2e harness (triage B1): the dev backend and the permission-gate probe run `<hermes root>/.venv/bin/python`.
 * A bare venv (no packages) makes the probe die on `ruamel`, and the app correctly refuses to start the agent, so every
 * boot test timed out at 90 s. This preflight fails the launch at once with the cause and the remedy instead. Checked
 * only for the repo's own root (the fail-closed spec points the app at a bare one on purpose), once per worker.
 */
const preflightOk = new Set<string>()

export function e2ePythonProblem(root: string = REPO_ROOT): null | string {
  const python = path.join(root, '.venv', 'bin', 'python')

  if (!fs.existsSync(python)) {
    return `${python} does not exist`
  }

  // The agent's own YAML layer: ruamel.yaml (a core dependency) behind hermes_yaml. PyYAML is NOT a runtime
  // dependency (only optional voice extras pull it in), so probing `yaml` refused a correct core install.
  const probe = spawnSync(python, ['-s', '-c', 'import ruamel.yaml, hermes_yaml'], { encoding: 'utf8', timeout: 30_000 })

  if (probe.status !== 0) {
    return `${python} cannot import the agent's packages (${(probe.stderr || probe.stdout).trim().split('\n').at(-1)})`
  }

  if (!fs.existsSync(path.join(root, '.venv', 'bin', 'hermes'))) {
    return `${path.join(root, '.venv', 'bin', 'hermes')} does not exist (the hermes entry point)`
  }

  return null
}

export function assertE2ePython(root: string = REPO_ROOT): void {
  if (preflightOk.has(root)) {
    return
  }

  const problem = e2ePythonProblem(root)

  if (problem) {
    throw new Error(
      `e2e preflight: ${problem}. The dev backend and the permission-gate probe run this venv, so the app would ` +
        'refuse to start the agent. Create it with the repo\'s packages and entry point: ' +
        '`uv sync --frozen` in the checkout (see the v0.0.9 e2e harness note).'
    )
  }

  preflightOk.add(root)
}

export async function launchDesktop(
  env: Record<string, string>,
  { claim = 'booted', reason = '' }: { claim?: 'booted' | 'non-ready'; reason?: string } = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  assertDistBuilt()

  if (env.HERMES_DESKTOP_HERMES_ROOT === REPO_ROOT && !env.HERMES_DESKTOP_BOOT_FAKE_ERROR) {
    assertE2ePython(REPO_ROOT)
  }

  if (claim === 'booted') {
    claimBooted()
  } else {
    claimNonReady(reason || 'not ready by design')
  }

  noteLaunch()

  const electronBin = findElectron()

  // `electron .` loads from the package.json `main` field
  // (dist/electron-main.mjs after build).
  const app = await _electron.launch({
    executablePath: electronBin,
    args: [
      DESKTOP_ROOT, // `electron .` — the `.` is the desktop package dir
      '--disable-gpu',
      '--no-sandbox',
      // v0.0.9: never the real macOS keychain from an e2e run (safeStorage would create and prompt for a real
      // "<app> Safe Storage" item on the developer's machine). Chromium's mock keychain is per process.
      '--use-mock-keychain'
    ],
    env,
    cwd: DESKTOP_ROOT
  })

  const page = await app.firstWindow()

  // Install the error-banner guard so any [role="alert"] that appears
  // during a test is collected and surfaced in afterEach.
  installErrorBannerGuard(page)

  return { app, page }
}

// ─── Public fixtures ────────────────────────────────────────────────────

export interface MockBackendFixture {
  app: ElectronApplication
  page: Page
  mock: Awaited<ReturnType<typeof startMockServer>>
  mockUrl: string
  sandbox: Sandbox
  cleanup: () => Promise<void>
}

export interface MockBackendOptions {
  /**
   * Optional YAML lines to inject under the `display:` section of the
   * generated config.yaml. Used by the interim-message e2e test to toggle
   * `display.interim_assistant_messages`.
   */
  extraDisplayConfig?: string
  /** Additional top-level config.yaml sections for an E2E scenario. */
  extraConfig?: string
  /** Override the mock model's context window for compression scenarios. */
  modelContextLength?: number
  mockServer?: MockServerOptions
}

/**
 * Set up a full mock-backend E2E environment:
 *   1. Start the mock inference server
 *   2. Create a sandbox with config.yaml pointing at it
 *   3. Launch the desktop app
 *   4. Return handles for test interaction
 */
export async function setupMockBackend(options: MockBackendOptions = {}): Promise<MockBackendFixture> {
  // 1. Start mock server
  const mock = await startMockServer(options.mockServer)

  // 2. Create sandbox + write config
  const sandbox = createSandbox('mock')
  writeMockProviderConfig(
    sandbox.hermesHome,
    mock.url,
    options.extraDisplayConfig,
    options.extraConfig,
    options.modelContextLength
  )
  writeEnvFile(sandbox.hermesHome)

  // 3. Build env + launch
  const env = buildAppEnv(sandbox)
  const { app, page } = await launchDesktop(env)

  return {
    app,
    page,
    mock,
    mockUrl: mock.url,
    sandbox,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      await mock.close()
      sandbox.cleanup()
    }
  }
}

export interface NoProviderFixture {
  app: ElectronApplication
  page: Page
  sandbox: Sandbox
  cleanup: () => Promise<void>
}

/**
 * Launch the app with no provider configured. The onboarding overlay should
 * appear because there's no inference provider in config.yaml.
 */
export async function setupNoProvider(): Promise<NoProviderFixture> {
  const sandbox = createSandbox('noprovider')
  writeEmptyConfig(sandbox.hermesHome)

  const env = buildAppEnv(sandbox)

  const { app, page } = await launchDesktop(env, {
    claim: 'non-ready',
    reason: 'onboarding: no provider configured, the provider picker is the expected state'
  })

  return {
    app,
    page,
    sandbox,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      sandbox.cleanup()
    }
  }
}

export interface DeadBackendFixture {
  app: ElectronApplication
  page: Page
  sandbox: Sandbox
  cleanup: () => Promise<void>
}

export interface DeadBackendOptions {
  /**
   * When true, inject a fake boot error via HERMES_DESKTOP_BOOT_FAKE_ERROR
   * so the backend resolution itself "fails" with a controlled error message.
   * This is the only reliable way to trigger BootFailureOverlay in dev mode
   * (the real backend always resolves via SOURCE_REPO_ROOT).
   */
  fakeError?: boolean
}

/**
 * Launch the app with a provider pointing at a dead endpoint (port 1, which
 * nothing listens on). By default the backend still boots (`hermes serve`
 * starts fine — the dead endpoint only matters at chat time). Pass
 * `{ fakeError: true }` to inject a fake boot failure, triggering the
 * BootFailureOverlay.
 */
export async function setupDeadBackend(options: DeadBackendOptions = {}): Promise<DeadBackendFixture> {
  const sandbox = createSandbox('dead')
  const configPath = path.join(sandbox.hermesHome, 'config.yaml')
  fs.writeFileSync(
    configPath,
    `# Auto-generated by E2E test fixtures — dead provider
model:
  default: mock-model
  provider: mock
providers:
  mock:
    api: http://127.0.0.1:1/v1
    name: Mock
    api_mode: chat_completions
    key_env: MOCK_API_KEY
    models:
      mock-model: {}
    context_length: ${E2E_MOCK_CONTEXT}
`,
    'utf8'
  )
  writeEnvFile(sandbox.hermesHome)

  const env = buildAppEnv(
    sandbox,
    options.fakeError
      ? { HERMES_DESKTOP_BOOT_FAKE_ERROR: 'Failed to connect to Hermes backend: connection refused' }
      : {}
  )

  const { app, page } = await launchDesktop(env, {
    claim: 'non-ready',
    reason: 'boot failure: the backend is dead (or a fake boot error) by design; the failure card is the expected state'
  })

  return {
    app,
    page,
    sandbox,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      sandbox.cleanup()
    }
  }
}

// ─── Packaged-binary fixture ───────────────────────────────────────────

/**
 * Resolve the packaged Electron binary path, per-platform, matching
 * electron-builder's output layout under release/.
 */
function resolvePackagedBinaryPath(): string {
  if (process.platform === 'win32') {
    return path.join(RELEASE_ROOT, 'win-unpacked', 'Hermes.exe')
  }

  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

    return path.join(RELEASE_ROOT, `mac-${arch}`, 'Hermes.app', 'Contents', 'MacOS', 'Hermes')
  }

  return path.join(RELEASE_ROOT, 'linux-unpacked', 'hermes')
}

export const PACKAGED_BINARY_PATH = resolvePackagedBinaryPath()

export function packagedBinaryExists(): boolean {
  return fs.existsSync(PACKAGED_BINARY_PATH)
}

export interface PackagedAppFixture {
  app: ElectronApplication
  page: Page
  sandbox: Sandbox
  cleanup: () => Promise<void>
}

/**
 * Launch the *packaged* Electron binary (from `npm run pack` →
 * `electron-builder --dir`) with `BOOT_FAKE=1` so it simulates boot
 * progress without spawning a real Hermes backend.
 *
 * Uses the same sandbox isolation (credential stripping, isolated
 * HERMES_HOME + userData, unique app name) as the dev-mode fixtures.
 *
 * Skips if the packaged binary doesn't exist — run `npm run pack` first.
 */
export async function setupPackagedApp(): Promise<PackagedAppFixture> {
  if (!packagedBinaryExists()) {
    throw new Error(`Built app binary not found: ${PACKAGED_BINARY_PATH}. Run 'npm run pack' first.`)
  }

  const sandbox = createSandbox('packaged')

  // Build the sandbox env using the shared helpers, then add the
  // packaged-binary-specific overrides.
  const env = buildAppEnv(sandbox, {
    // Fake boot: simulates progress steps without spawning the real backend.
    HERMES_DESKTOP_BOOT_FAKE: '1',
    HERMES_DESKTOP_BOOT_FAKE_STEP_MS: '120'
  })

  // Clear dev-server + hermes-root overrides — the packaged binary
  // should use its own bundled renderer, not the dev checkout.
  delete (env as Record<string, string | undefined>).HERMES_DESKTOP_DEV_SERVER
  delete (env as Record<string, string | undefined>).HERMES_DESKTOP_HERMES
  delete (env as Record<string, string | undefined>).HERMES_DESKTOP_HERMES_ROOT

  // The packaged smoke checks the binary (window, renderer, HUD, the fake boot overlay), not a live agent.
  claimNonReady('packaged smoke: fake boot (HERMES_DESKTOP_BOOT_FAKE), the binary and its renderer only')

  const app = await _electron.launch({
    executablePath: PACKAGED_BINARY_PATH,
    args: ['--disable-gpu', '--no-sandbox', '--use-mock-keychain'],
    env
  })

  const page = await app.firstWindow()
  installErrorBannerGuard(page)

  return {
    app,
    page,
    sandbox,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      sandbox.cleanup()
    }
  }
}

// ─── Wait helpers ──────────────────────────────────────────────────────

/**
 * Wait until the icloneOS app is ready (e2e/readiness.ts): the home region is shown, main's boot progress says the
 * backend is up, and no known blocker (the gate card, the consent sheet, the connecting overlay, any aria-modal
 * dialog) is on screen. The gate card, the consent sheet and a backend error never clear by themselves, so they fail at
 * once with their cause. Then, unless `openMessage: false`, the Message pane is opened from the Dock the way a user
 * does, and its composer is awaited (the chat specs type into it). The window is polled visible (Electron 40.x
 * ready-to-show, electron/electron#51972). Marks the test's booted claim ready (reached-ready).
 */
export async function waitForAppReady(
  fixture: MockBackendFixture | NoProviderFixture | DeadBackendFixture,
  timeoutMs = 60_000,
  { openMessage = true }: { openMessage?: boolean } = {}
): Promise<void> {
  const { page, app } = fixture
  const deadline = Date.now() + timeoutMs
  let verdict: ReadinessVerdict = 'no-home'

  while (Date.now() < deadline) {
    verdict = judgeReadiness(await readinessFacts(page))

    if (verdict === 'ready') {
      break
    }

    if (TERMINAL_VERDICTS.includes(verdict)) {
      throw new Error(readinessFailure(verdict))
    }

    await page.waitForTimeout(250)
  }

  if (verdict !== 'ready') {
    throw new Error(`the app did not become ready in ${timeoutMs} ms (last state: ${verdict})`)
  }

  if (app) {
    while (Date.now() < deadline) {
      const visible = await app
        .evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows()[0]

          return w ? w.isVisible() : false
        })
        .catch(() => false)

      if (visible) {
        break
      }

      await page.waitForTimeout(500)
    }
  }

  markReady()

  if (openMessage) {
    await openMessagePane(page, Math.max(10_000, deadline - Date.now()))
  }
}

function readinessFailure(verdict: ReadinessVerdict): string {
  switch (verdict) {
    case 'gate':
      return (
        `the app shows "${GATE_TITLE}": the agent's python cannot load the permission gate, so the app refuses to ` +
        'start it (correct). Fix the e2e venv (assertE2ePython) — never mock the gate.'
      )

    case 'consent':
      return 'the first-run policy dialog covers the window: the sandbox has no consent.json (createSandbox)'

    default:
      return `the backend failed to start (main's boot progress: ${verdict})`
  }
}

/** Open the Message pane from the Dock, as a user does, and wait for its composer. */
export async function openMessagePane(page: Page, timeoutMs = 30_000): Promise<void> {
  // The chat composer (pane-focus.ts targets the same root); never another textarea, e.g. the iT terminal's hidden one.
  const composer = page
    .locator('[data-slot="composer-root"] textarea, [data-slot="composer-root"] [contenteditable="true"]')
    .filter({ visible: true })
    .first()

  if (await composer.isVisible().catch(() => false)) {
    return
  }

  // A reload restores an open Message window, and its composer and frame mount a moment after ready while the Dock
  // already sits outside the viewport (b2's report). The Dock leaving the viewport is the sign a window is up: then
  // wait for its composer, never click the Dock.
  const dockButton = page.getByRole('navigation', { name: 'Dock' }).getByRole('button', { name: 'Message', exact: true })
  const box = await dockButton.boundingBox().catch(() => null)
  // Electron has no emulated viewport (viewportSize() is null): read the window's own.
  const viewport = await page.evaluate(() => ({ height: window.innerHeight, width: window.innerWidth }))
  const dockOnScreen =
    box !== null && box.x + box.width > 0 && box.y + box.height > 0 && box.x < viewport.width && box.y < viewport.height

  if (!dockOnScreen || (await page.locator('[data-ic-window="message"]').count()) > 0) {
    await composer.waitFor({ state: 'visible', timeout: timeoutMs })

    return
  }

  await dockButton.click()
  await composer.waitFor({ state: 'visible', timeout: timeoutMs })
}

/**
 * Wait for the onboarding overlay to appear (no provider configured).
 */
export async function waitForOnboarding(page: Page, timeoutMs = 60_000): Promise<void> {
  // The onboarding overlay contains a heading with "Choose your provider"
  // or similar text. We look for any text that indicates the picker.
  await page.waitForFunction(
    () => {
      const root = document.getElementById('root')

      if (!root) {
        return false
      }

      const text = root.textContent ?? ''

      // The policy dialog's own text mentions "Sign in" and "provider": it is not onboarding.
      if (document.body.textContent?.includes('Before you begin')) {
        return false
      }

      return (
        text.includes('provider') ||
        text.includes('Provider') ||
        text.includes('Choose') ||
        text.includes('API key') ||
        text.includes('Sign in')
      )
    },
    undefined,
    { timeout: timeoutMs }
  )
}

/**
 * Wait for the boot failure overlay to appear.
 */
export async function waitForBootFailure(page: Page, timeoutMs = 60_000): Promise<void> {
  // v0.0.9 F3: the failure CARD itself — the BootFailureOverlay dialog (its `#boot-failure-title`), shown and on top.
  // Text alone ("Retry", a toast) is not enough: the onboarding sheet can name a failure screen that is not there.
  await page.waitForFunction(
    () => {
      const title = document.getElementById('boot-failure-title')
      const dialog = title?.closest('[role="dialog"][aria-modal="true"]')

      if (!dialog || dialog.closest('[hidden], [aria-hidden="true"]')) {
        return false
      }

      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)

      return Boolean(el && (dialog.contains(el) || el.contains(dialog)))
    },
    undefined,
    { timeout: timeoutMs }
  )
}

// ─── The Message pane's own conversation list (icloneOS) ────────────────
//
// v0.0.9 e2e harness (next layer): upstream specs drove the chat app's `[data-slot="sidebar"]` session list. The
// icloneOS user has the Message pane's own list instead (src/app/home/msg-sidebar.tsx): a `Conversations` nav whose
// panel opens from its rail ("Show conversations"), one `.imsg-row` per session, and "New conversation". These
// helpers drive it the way a user does; the copy is the app's own (src/i18n/en/desktop.ts), held equal by
// scripts/e2e-readiness.test.mjs.
export const MESSAGE_LIST = {
  nav: 'Conversations',
  show: 'Show conversations',
  newConversation: 'New conversation'
} as const

/** Open the Message pane's conversation panel (no-op when it is open). */
export async function openConversationList(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: MESSAGE_LIST.nav })

  await nav.waitFor({ state: 'attached', timeout: 30_000 })

  if ((await nav.getAttribute('data-open')) === null) {
    await nav.getByRole('button', { name: MESSAGE_LIST.show }).first().click()
    await page.waitForFunction(
      label => document.querySelector(`nav[aria-label="${label}"]`)?.hasAttribute('data-open') === true,
      MESSAGE_LIST.nav
    )
  }
}

/** A session's row in the Message pane's list (its open button), by its title. */
export function conversationRow(page: Page, title: RegExp | string) {
  return page
    .getByRole('navigation', { name: MESSAGE_LIST.nav })
    .locator('.imsg-side__panel .imsg-row')
    .filter({ hasText: title })
    .first()
    .locator('button')
    .first()
}

/** Open a stored session from the Message pane's list, as a user does. */
export async function openConversation(page: Page, title: RegExp | string, timeoutMs = 60_000): Promise<void> {
  await openConversationList(page)

  const row = conversationRow(page, title)

  await row.waitFor({ state: 'visible', timeout: timeoutMs })
  await row.click()
}

/** Start a new conversation from the Message pane's list. */
export async function newConversation(page: Page): Promise<void> {
  await openConversationList(page)
  // The open panel's own "+" (the rail's copy is inert while the panel is open).
  await page
    .getByRole('navigation', { name: MESSAGE_LIST.nav })
    .locator('.imsg-side__panel')
    .getByRole('button', { name: MESSAGE_LIST.newConversation })
    .first()
    .click()
}

export { openSessionsAndBots } from './settings-door'

/** Leave Settings for the home route (the app's own NEW_CHAT_ROUTE, '/'), and wait until it is gone. */
export async function closeSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '/'
  })
  await page.waitForFunction(() => !window.location.hash.startsWith('#/settings'), undefined, { timeout: 15_000 })
  // Back to the ready home by the harness's own rule, so the next test's per-test readiness claim holds.
  const deadline = Date.now() + 30_000
  let verdict = judgeReadiness(await readinessFacts(page))

  while (verdict !== 'ready' && Date.now() < deadline) {
    await page.waitForTimeout(250)
    verdict = judgeReadiness(await readinessFacts(page))
  }

  if (verdict !== 'ready') {
    throw new Error(`closeSettings: the app did not return to ready (${verdict}): ${JSON.stringify(await readinessFacts(page))}`)
  }
}
