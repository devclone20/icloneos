// Boot order: these modules run process-level setup at load (paths and pre-ready switches, native theme, app
// identity and crash forensics), so they are evaluated first and in this order; every other module reads their state.
// Ruling 54.4: the telemetry seal goes first — every child of this process inherits or merges it.
import './iclone-telemetry-seal-install'
import './main/env'
import './main/log'
import './main/theme'
import './main/app-identity'
import './main/backend-state'

import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

import { CancellationToken } from 'builder-util-runtime'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell
} from 'electron'
import { autoUpdater as electronAutoUpdater } from 'electron-updater'

import { errorMessage } from '../src/iclone-shared/errors'
import { MAIN_DIALOG_LOCALE } from '../src/iclone-shared/offered-locale'

import { destroyKeepaliveAgents } from './api-transport'
import { APP_UPDATE_CHANNELS, broadcastToWindows, registerAppUpdateIpc } from './app-update-ipc'
import { createLabCancelToken, createLabUpdater, resolveLabFeed } from './app-update-lab'
import { appendAppUpdateLog, readAppUpdateLog, settleAppUpdateLog } from './app-update-log'
import { isPinnedRuntimeUpdateRunning } from './bootstrap-runner'
import { installEmbedReferer } from './embed-referer'
import { registerFsIpc } from './fs-ipc'
import { registerGitIpc } from './git-ipc'
import { enableBasicPasswordStoreEncryption, resolveRequestedPathForIpc } from './hardening'
import { registerHudIpc } from './hud-ipc'
import { acpWorkCli, initIcloneAcp, refreshAcpToolsSealing, startIcloneSelftest } from './iclone-acp'
import { streamingSlugs } from './iclone-acp-ipc'
import { acpToolsSealer } from './iclone-acp-tools/sealer'
import { createWorkAuditSink } from './iclone-acp-work/audit-sink'
import { registerAcpWork } from './iclone-acp-work/ipc'
import {
  appUpdateFeedPresent,
  createAppUpdate,
  createAppUpdateNotifier,
  MOVE_TO_APPLICATIONS_PROMPT,
  offerMoveToApplications
} from './iclone-app-update'
import { initIcloneBalances } from './iclone-balances'
import { initIcloneClaudeCode } from './iclone-claude-code'
import { registerConfinement, stopConfinement } from './iclone-confinement/ipc'
import { bundledLegalDir, consentAllows, onConsentPermissionsChanged, registerIcloneConsent } from './iclone-consent'
import { registerConsentDoor } from './iclone-consent-door'
import { initIcloneDoctor } from './iclone-doctor-main'
import { initInftBook } from './iclone-inft-book'
import { initIcloneIt } from './iclone-it'
import { registerKeychainIpc } from './iclone-keychain-ipc'
import { createKeychainSwitch } from './iclone-live-sealing'
import { initIcloneModel } from './iclone-model'
import { initIcloneOwnership } from './iclone-ownership'
import { initPaneBus, paneBusTerminalHooks } from './iclone-pane-bus/ipc'
import { gestureOf, permissionGestureOk } from './iclone-permissions/gesture'
import {
  confirmFunctionRaiseNatively,
  confirmIgnoreNatively,
  permissionKeySealer
} from './iclone-permissions/ignore-dialog'
import {
  activePermissions,
  recordInstall,
  recordPayment,
  registerPermissions,
  republishPermissions
} from './iclone-permissions/ipc'
import { INDEXER_CHAINS, initIclonePrivy, onPrivySession, privySignInState, readIndexerPage } from './iclone-privy'
import { createRelaunchOnQuit } from './iclone-relaunch'
import { initIcloneSkills } from './iclone-skills'
import { initIcloneUpdates } from './iclone-updates'
import { clearCachesOnVersionChange, lastSeenVersion } from './iclone-version-caches'
import { registerPayments } from './iclone-x402'
import { createAppSenderGuard } from './ipc-sender-guard'
import { legacyCleanupNotice, runLegacyUpdateCleanup } from './legacy-update-cleanup'
import { ensureMainWindow } from './main-window-lifecycle'
import { registerAgentRosterIpc } from './main/agent-roster-ipc'
import { lastTrustedInputAt } from './main/agent-update'
import { registerApiProxyIpc } from './main/api-proxy-ipc'
import { registerAppearanceIpc } from './main/appearance-ipc'
import {
  activeSshTerminalTarget,
  primaryBackendIsRemote,
  primaryProfileKey,
  sendConnectionApplied,
  teardownPrimaryBackendAndWait
} from './main/backend'
import {
  backendShutdown,
  poolStopper,
  prepareProfileDeleteRequest,
  releaseBackendLock,
  revalidatePool,
  saveRegistryConnection,
  stopPoolBackend,
  stopRegistryConnectionBackends,
  touchPoolBackend
} from './main/backend-pool'
import { ensureTerminalBackend, registerPowerResumeListeners, resumeManagedSshRecoveries } from './main/backend-routing'
import {
  activeWorkByWebContents,
  backendConnectionState,
  backendDialClaims,
  backendPool,
  profileDeletionGate,
  progressState,
  remoteLiveness,
  remoteRevalidation,
  updateStreamThrottleFromActiveWork,
  windowConnectionRouteOwners,
  windowConnectionRoutes
} from './main/backend-state'
import { registerBootstrapIpc } from './main/bootstrap-ipc'
import {
  installRemoteHeaderRules,
  managedConnectionRecoveries,
  managedConnectionUpdates,
  readActiveDesktopProfile,
  sshConnections
} from './main/connection-config'
import { registerConnectionConfigIpc } from './main/connection-config-ipc'
import { registerConnectionRoutingIpc } from './main/connection-routing-ipc'
import { registerConnectionsIpc } from './main/connections-ipc'
import { _extractDeepLink, handleDeepLink, registerDeepLinkIpc, registerDeepLinkProtocol } from './main/deep-link'
import {
  ACTIVE_HERMES_ROOT,
  activeVenvRoot,
  DEV_SERVER,
  directoryExists,
  HERMES_HOME,
  IS_MAC,
  IS_WINDOWS,
  SKIP_QUIT_CONFIRM
} from './main/env'
import { findOnPath, resolveGhBinary, resolveGitBinary } from './main/executables'
import { registerFilesIpc } from './main/files-ipc'
import { closeHudWindow, hudSnapShortcut, openHudWindow, resetHudWindowLayout } from './main/hud'
import { flushDesktopLogBufferSync, hermesLog, rememberLog, updatePolicy } from './main/log'
import { createWindow } from './main/main-window'
import { sshBootstrapCoordinator, teardownSshConnection } from './main/managed-ssh'
import { registerMediaProtocol } from './main/media-protocol'
import { closePreviewWatchers, expandUserPath } from './main/preview'
import { applyQuickEntrySettings, closeQuickEntryWindow, readQuickEntrySettings } from './main/quick-entry'
import { resolveRendererIndex } from './main/runtime'
import { migrateLegacyEncryptedSecretsOnce } from './main/secret-storage'
import { onSecretStoragePolicyWrite, secretStoragePolicy } from './main/secrets'
import { registerSetupIpc } from './main/setup-ipc'
import { registerShellIpc } from './main/shell-ipc'
import { ensureWslWindowsFonts } from './main/shell-open'
import { startHermes } from './main/start-hermes'
import {
  bootState,
  connectionRuntimeState,
  deepLinkState,
  lateBound,
  logBufferState,
  quitState,
  sandboxState,
  windowsState
} from './main/state'
import { themeState, writePersistedTranslucency } from './main/theme'
import { registerUpdatesIpc } from './main/updates-ipc'
import { installDownloadHandling, installMediaPermissions } from './main/window-events'
import { keepAwake, readPersistedDisableF12, readPersistedKeepAwake, registerWindowIpc } from './main/window-ipc'
import { buildApplicationMenu, focusWindow, wakeIndicatorController } from './main/windows'
import { waitForManagedUpdateOperations } from './managed-ssh-update'
import { registerPetOverlay } from './pet-overlay'
import { mergeActiveWork, quitPromptFor } from './quit-guard'
import { ensureLoginShellPath } from './shell-path'
import { configureSpellChecker } from './spellchecker'
import { registerTerminalIpc } from './terminal-ipc'
import { readLiveUpdateMarker } from './update-marker'
import { markerAfterSuccessfulBoot, writeSandboxMarker } from './windows-sandbox-fallback'
import { installWindowsSystemCaTrust } from './windows-system-ca'
import { setActiveGatewayProfile, setWslBridgeProfileState } from './wsl-path-bridge'

// Quit-guard latches: one while the confirmation is on screen (a second
// Cmd-Q must not stack dialogs), one after the user has said "quit anyway"
// (the app.quit() that follows re-enters before-quit and must pass through).
let quitPromptOpen = false
let quitConfirmedWithActiveWork = false

let managedUpdateQuitWait: Promise<void> | null = null
let managedUpdateQuitWaitDone = false

let sshQuitTeardownDone = false
let backendQuitTeardownDone = false

registerDeepLinkIpc({ deepLinkState, windowsState })
registerConnectionRoutingIpc({
  backendConnectionState,
  backendDialClaims,
  remoteLiveness,
  remoteRevalidation,
  revalidatePool,
  touchPoolBackend,
  windowConnectionRouteOwners,
  windowConnectionRoutes
})
registerWindowIpc({ connectionRuntimeState, windowsState })
registerBootstrapIpc({ backendConnectionState, bootState, progressState })
registerConnectionsIpc({ saveRegistryConnection, stopRegistryConnectionBackends })
registerAgentRosterIpc({ backendDialClaims, backendPool })
registerConnectionConfigIpc({ bootState, stopPoolBackend, windowsState })
registerApiProxyIpc({ backendDialClaims, backendPool, poolStopper, prepareProfileDeleteRequest, profileDeletionGate })
registerShellIpc({ windowsState })
registerFilesIpc({ windowsState })
registerAppearanceIpc({
  activeWorkByWebContents,
  lateBound,
  themeState,
  updateStreamThrottleFromActiveWork,
  windowsState
})
registerUpdatesIpc({ quitState, releaseBackendLock })

// --- HUD mode (chrome-free floating chat) — see hud-ipc.ts. ---------------
lateBound.hudIpc = registerHudIpc({
  isMac: IS_MAC,
  getTranslucencyState: () => themeState.translucencyState,
  getHudWindow: () => windowsState.hudWindow,
  openHudWindow,
  closeHudWindow,
  resetHudLayout: resetHudWindowLayout,
  setHudSessionId: value => {
    windowsState.hudSessionId = value
  }
})

// Flush a pending write before the process can exit, so a quit landing inside
// the debounce window doesn't lose the setting.
app.on('before-quit', () => {
  if (windowsState.translucencyWriteTimer) {
    clearTimeout(windowsState.translucencyWriteTimer)
    windowsState.translucencyWriteTimer = null
    writePersistedTranslucency(themeState.translucencyState)
  }
})

// Close the pooled keep-alive sockets on quit so lingering connections can't
// hold the event loop open or leak FDs past app teardown.
app.on('will-quit', () => {
  destroyKeepaliveAgents()
  // V3-G: the refusal stream is a `log stream` child; it must not outlive the app.
  stopConfinement()
})

// Local filesystem + plugin-root IPC (readDir/reveal/rename/trash/…) — see fs-ipc.ts.
registerFsIpc({
  hermesHome: HERMES_HOME,
  readActiveDesktopProfile,
  expandUserPath,
  resolveRequestedPathForIpc,
  directoryExists,
  resolveGitBinary
})

// Git-driven features (worktrees, review pane, repo scan) — see git-ipc.ts.
registerGitIpc({
  resolveGitBinary,
  resolveGhBinary,
  // iclone-seam: p7-ipc-sender — git and gh run in a directory the caller names; only the app's own renderer.
  isTrustedSender: createAppSenderGuard({
    devServer: DEV_SERVER,
    rendererIndexPath: resolveRendererIndex,
    log: rememberLog
  })
})

// V3-P: the pop-out pet window; every channel answers only the app's own renderer (see pet-overlay.ts).
const petOverlay = registerPetOverlay(() => windowsState.mainWindow)

// Embedded terminal PTY host (hermes:terminal:*) — see terminal-ipc.ts.
const terminalIpc = registerTerminalIpc({
  isWindows: IS_WINDOWS,
  findOnPath,
  rememberLog,
  activeSshTerminalTarget,
  ensureBackend: webContentsId => ensureTerminalBackend(webContentsId),
  getSshConnectionState: scope => sshConnections.get(scope),
  // iclone-seam: p7-ipc-sender
  isTrustedSender: createAppSenderGuard({
    devServer: DEV_SERVER,
    rendererIndexPath: resolveRendererIndex,
    log: rememberLog
  }),
  paneHooks: paneBusTerminalHooks
})

lateBound.terminalIpc = terminalIpc

// Single-instance lock: deep links on a running app (Win/Linux) arrive as a
// second-instance argv. Without the lock a second `hermes://` launch spawns a
// whole new app instead of routing into the running one.
// iclone-seam: p7-selftest — `--iclone-selftest=acp|pty|all` answers headless ([iclone-selftest]) and exits; no lock, no window
updatePolicy() // iclone-seam: r1-policy — the policy line is logged at boot, before a self-test exits
const icloneSelftest = startIcloneSelftest(process.argv) // iclone-seam: p7-selftest
const _gotSingleInstanceLock = icloneSelftest || app.requestSingleInstanceLock() // iclone-seam: p7-selftest
lateBound.isPrimaryInstance = _gotSingleInstanceLock

if (!lateBound.isPrimaryInstance) {
  // Hard-exit, not app.quit(): the before-quit teardown coordinator defers a
  // plain quit (event.preventDefault + async backend shutdown), and in that
  // window `ready` still fires — the lock-losing instance then runs the full
  // startup (shortcut registration, createWindow → startHermes), whose
  // reapOrphans() SIGTERMs the running instance's live backend (#87295).
  // app.exit() terminates immediately, before `ready`, so a second launch
  // routes into the running window and never touches backend machinery.
  app.exit(0)
} else {
  app.on('second-instance', (_event, argv) => {
    const url = _extractDeepLink(argv)

    if (url) {
      handleDeepLink({ deepLinkState, windowsState }, url)
    }

    ensureMainWindow(windowsState.mainWindow, {
      isReady: app.isReady(),
      createWindow,
      focusWindow,
      // deep-link delivery focuses a live window after its renderer is ready.
      focusExisting: !url
    })
  })
}

// macOS delivers deep links via 'open-url' — register early (can fire before
// whenReady; handleDeepLink queues until the renderer is ready).
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLink({ deepLinkState, windowsState }, url)
})

app.whenReady().then(() => {
  // iclone-seam: p7-selftest — the self-test owns this launch
  if (icloneSelftest) {
    return
  }

  // Warm the login-shell PATH resolution immediately so it usually completes
  // before the backend start path awaits the same single-flight promise.
  void ensureLoginShellPath()

  // Read before clearCachesOnVersionChange rewrites it: the Privy "signed out since the update" hint needs it.
  const versionChange = { current: app.getVersion(), previous: lastSeenVersion(app.getPath('userData')) }

  // iclone-seam: version-caches — a new version starts with clean caches (user data untouched).
  void clearCachesOnVersionChange({
    log: rememberLog,
    session: session.defaultSession,
    userData: app.getPath('userData'),
    version: app.getVersion()
  })

  const systemCa = installWindowsSystemCaTrust(tls)

  if (systemCa.applied) {
    rememberLog(
      `[tls] trusting ${systemCa.systemCertificateCount} Windows system CA certificate(s) for backend connections`
    )
  } else if (systemCa.error) {
    rememberLog(`[tls] could not load Windows system CA certificates: ${systemCa.error}`)
  }

  // Keyring-less Linux `--password-store=basic` support. This must run before
  // createWindow() and anything that could touch safeStorage; the narrow
  // platform/switch/guard semantics live in the extracted helper.
  enableBasicPasswordStoreEncryption({
    platform: process.platform,
    passwordStoreSwitch: app.commandLine.getSwitchValue('password-store'),
    safeStorageApi: safeStorage
  })

  // Keychain encryption is opt-in (default OFF). One-shot: rewrite any
  // legacy safeStorage-encrypted secrets as plain so no later launch ever
  // touches the OS keychain unless the user turns encryption on in
  // Settings → Gateway. Must run before createWindow() and the first
  // connection resolution.
  migrateLegacyEncryptedSecretsOnce()

  // iclone-seam: p7-move-to-applications
  offerMoveToApplications({
    app,
    confirm: () => dialog.showMessageBoxSync(MOVE_TO_APPLICATIONS_PROMPT) === 0,
    declineMarker: path.join(app.getPath('userData'), 'move-to-applications-declined'),
    exePath: app.getPath('exe'),
    home: os.homedir(),
    isPackaged: app.isPackaged,
    log: rememberLog,
    platform: process.platform
  })

  // iclone-seam: p7-app-update
  startAppUpdates()

  if (IS_MAC) {
    Menu.setApplicationMenu(buildApplicationMenu())
  } else {
    Menu.setApplicationMenu(null)
  }

  installMediaPermissions()
  installDownloadHandling()
  registerMediaProtocol()
  installEmbedReferer()
  installRemoteHeaderRules()
  registerDeepLinkProtocol()

  // iCLONE OS — Privy wallet login + iNFT wallet scan (loopback HTTP server +
  // IPC handlers). Self-contained; see electron/iclone-privy.ts.
  // iclone-seam: p7-ipc-sender — only the app's own renderer may spend the indexer budget on a wallet scan.
  const scanSenderGuard = createAppSenderGuard({
    devServer: DEV_SERVER,
    rendererIndexPath: resolveRendererIndex,
    log: rememberLog
  })

  initIclonePrivy({ getMainWindow: () => windowsState.mainWindow, versionChange, isTrustedSender: scanSenderGuard })
  initInftBook({ chains: INDEXER_CHAINS, readPage: readIndexerPage, isTrustedSender: scanSenderGuard })
  const ownershipWatch = initIcloneOwnership({ getMainWindow: () => windowsState.mainWindow })

  // iCLONE OS — App Atualisation (curated upstream update status; collect
  // stage only — see electron/iclone-updates.ts).
  initIcloneUpdates()

  // iCLONE OS — on-chain 3D model fetch for the iNFT Stage.
  initIcloneModel()

  // iCLONE OS — multi-chain native-coin balances (public-RPC fan-out; no
  // window, no session — see electron/iclone-balances.ts).
  initIcloneBalances()

  // V3-FX M1: the one owner of "may the keychain seal now" (the owner's Keychain setting). Its sealers are built only
  // while the setting is on (FX-2: never at launch with it off) and rebuilt on every toggle; subscribers below.
  const keychain = createKeychainSwitch(() => secretStoragePolicy().on)
  const acpToolsSealing = keychain.sealer(() => acpToolsSealer(safeStorage))
  const paymentsSealing = keychain.sealer(() => permissionKeySealer(safeStorage))

  onSecretStoragePolicyWrite(() => keychain.changed())

  // iCLONE OS — Virtuals ACP CLI per-iNFT setup (argv-allowlisted spawns,
  // one isolated ACP_CONFIG_DIR per iNFT — see electron/iclone-acp.ts).
  // iclone-seam: p7-ipc-sender — only the app's own renderer reaches the CLI, wallet and iNFT files.
  initIcloneAcp({
    isTrustedSender: createAppSenderGuard({
      devServer: DEV_SERVER,
      rendererIndexPath: resolveRendererIndex,
      log: rememberLog
    }),
    // REL-6: the ACP tools are installed at first use from npm, only on the owner's own click (V3-F's lock).
    gestureOk: (event, input) => {
      const sender = (event as { sender?: Electron.WebContents } | null)?.sender

      return permissionGestureOk({
        payload: gestureOf(input),
        lastInputAt: sender ? lastTrustedInputAt(sender) : 0,
        now: Date.now()
      })
    },
    // Round 2 (lead ruling on m7): a real OS seal or no ACP tools at all (Linux basic_text is not a seal).
    // FX-2: the sealer probes the keychain when built, so only under the owner's Keychain setting (default off): no
    // keychain dialog at launch. M1: read live on every check, so turning the setting on or off takes effect at once;
    // off = `unavailable · keychain-off` (the pane names the fix), an OS that cannot seal = `unsealable`.
    sealer: () => acpToolsSealing.current(),
    noSealReason: () => acpToolsSealing.noSealReason(),
    // An `I` (install) action under V3-F, in its chained audit; no audit (the authority not up) = no install.
    audit: entry => recordInstall(entry),
    broadcastTools: view => broadcastToWindows(() => BrowserWindow.getAllWindows(), 'iclone:acp-tools:changed', view),
    openFile: file => shell.openPath(file)
  })

  // iCLONE OS — the app teaches its agent: bundled Hermes skills into the
  // root skills tree and every iNFT profile (see electron/iclone-skills.ts).
  initIcloneSkills({ hermesHome: HERMES_HOME })
  initIcloneClaudeCode({ hermesHome: HERMES_HOME })

  // iCLONE OS — first-launch policy acceptance + permission intents (<userData>/consent.json; see
  // electron/iclone-consent.ts). Registered before the first window so the sheet can ask on frame 1.
  const consentSenderGuard = createAppSenderGuard({
    devServer: DEV_SERVER,
    rendererIndexPath: resolveRendererIndex,
    log: rememberLog
  })

  // V3-FX M1: the Keychain setting now and as it was when this main started (the permission key is sealed at launch,
  // so a setting turned on since then needs a restart for the modes; payments and the ACP tools follow it live).
  const keychainAtLaunch = keychain.on()

  registerKeychainIpc({
    ipcMain,
    isTrustedSender: (event, channel) => consentSenderGuard(event as Electron.IpcMainInvokeEvent, channel),
    on: () => keychain.on(),
    atLaunch: keychainAtLaunch,
    // r3: "Restart now" beside the modes' restart line — a clean relaunch (every will-quit handler runs). r4: armed
    // until the quit really goes through, so "Keep Running" over a turn in flight leaves no relaunch behind.
    relaunch: () => relaunchOnQuit.request()
  })

  const consentStore = registerIcloneConsent({
    ipcMain,
    isTrustedSender: consentSenderGuard,
    keychainEncrypted: () => secretStoragePolicy().on,
    legalDir: bundledLegalDir({
      appPath: app.getAppPath(),
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath
    }),
    openExternal: url => shell.openExternal(url),
    quit: () => app.quit(),
    userDataDir: app.getPath('userData')
  })

  // V3-ON: the first-launch Set up step's system permissions and package states (same sender guard).
  registerSetupIpc(consentSenderGuard, consentStore)

  // The consent door: `acp consent request <key> --reason …` from an agent → one sheet at a time in the app windows.
  let consentDoorBounce: number | null = null

  const senderInputAt = (event: unknown) => {
    const sender = (event as { sender?: Electron.WebContents } | null)?.sender

    return sender ? lastTrustedInputAt(sender) : 0
  }

  const consentDoor = registerConsentDoor({
    ipcMain,
    isTrustedSender: consentSenderGuard,
    gestureOk: (event, input) =>
      permissionGestureOk({ payload: gestureOf(input), lastInputAt: senderInputAt(event), now: Date.now() }),
    store: consentStore,
    broadcast: request => {
      const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed())

      for (const window of windows) {
        window.webContents.send('iclone:consent:door', request)
        window.flashFrame(false)
      }

      if (consentDoorBounce !== null) {
        app.dock?.cancelBounce(consentDoorBounce)
        consentDoorBounce = null
      }

      // An unseen sheet times out as a Deny, so ask for attention — never with a notification (that is a switch).
      if (request && !windows.some(window => window.isFocused())) {
        if (IS_MAC && app.dock) {
          consentDoorBounce = app.dock.bounce('informational')
        } else {
          const target =
            windowsState.mainWindow && !windowsState.mainWindow.isDestroyed() ? windowsState.mainWindow : windows[0]

          target?.flashFrame(true)
        }
      }
    },
    userDataDir: app.getPath('userData')
  })

  // V3-F — the five permission modes: main is the only authority (electron/iclone-permissions/).
  registerPermissions({
    ipcMain,
    isTrustedSender: consentSenderGuard,
    userDataDir: app.getPath('userData'),
    paths: { hermesHome: HERMES_HOME, home: os.homedir(), hermesRoot: ACTIVE_HERMES_ROOT },
    door: consentDoor,
    consent: () => consentStore.read(),
    lastInputAt: senderInputAt,
    // FX-2: the master key is sealed (and its seal probed) only under the owner's Keychain setting: no keychain dialog
    // at launch. Off = an unsealed per-run key (the authority's 'unavailable' key status), as with no OS encryption.
    sealer: secretStoragePolicy().on ? permissionKeySealer(safeStorage) : null,
    confirmIgnore: request =>
      confirmIgnoreNatively(dialog, BrowserWindow.getFocusedWindow(), MAIN_DIALOG_LOCALE, request),
    confirmFunctionRaise: request =>
      confirmFunctionRaiseNatively(dialog, BrowserWindow.getFocusedWindow(), MAIN_DIALOG_LOCALE, request),
    broadcast: seq => broadcastToWindows(() => BrowserWindow.getAllWindows(), 'iclone:permissions:changed', seq)
  })
  onConsentPermissionsChanged(() => republishPermissions())

  // V3-J — payments (electron/iclone-x402/): the agent's pay socket (a token per Hermes spawn) and Settings › Economy ›
  // Payments. Keys only when the owner turned the Keychain setting on (R2); every decision is audited through V3-F.
  const payments = registerPayments({
    ipcMain,
    isTrustedSender: consentSenderGuard,
    userDataDir: app.getPath('userData'),
    socketDir: path.join(app.getPath('userData'), 'run'),
    sealer: paymentsSealing.current(),
    door: consentDoor,
    mode: () => activePermissions().authority?.state().mode.standing ?? 'manual',
    audit: entry => recordPayment(entry),
    gestureOk: (event, input) =>
      permissionGestureOk({ payload: gestureOf(input), lastInputAt: senderInputAt(event), now: Date.now() }),
    broadcast: () => broadcastToWindows(() => BrowserWindow.getAllWindows(), 'iclone:payments:changed', null),
    log: rememberLog,
    hermesHome: HERMES_HOME,
    hermesRoot: ACTIVE_HERMES_ROOT
  })

  app.on('will-quit', () => payments.close())

  // V3-FX M1: the Keychain setting changed — payments re-read their keys and the ACP tools check again, live.
  keychain.subscribe(() => {
    payments.reseal(paymentsSealing.current())
    refreshAcpToolsSealing()
  })

  // V3-I — the ACP WORK supervisor + watchdog: main-held, so an iNFT the owner put online stays online with every
  // window closed (electron/iclone-acp-work/). Its own fixed argv; the window's acp allowlist is not widened. It is
  // online only for the signed-in owner: every start and resume waits for a fresh ownership proof.
  const acpWork = registerAcpWork({
    ipcMain,
    isTrustedSender: consentSenderGuard,
    userDataDir: app.getPath('userData'),
    cli: acpWorkCli,
    streaming: streamingSlugs,
    account: {
      signedIn: privySignInState,
      prove: slug => ownershipWatch?.check(slug) ?? Promise.resolve('unknown'),
      walletOf: slug => ownershipWatch?.walletOf(slug) ?? null
    },
    gestureOk: (event, input) =>
      permissionGestureOk({ payload: gestureOf(input), lastInputAt: senderInputAt(event), now: Date.now() }),
    spendTradeOn: () => consentAllows('spendTrade'),
    // Interim chain until V3-F exports its watchdog writer; the switch is `shared: <that writer>`.
    audit: createWorkAuditSink({ dir: path.join(app.getPath('userData'), 'acp-work', 'audit'), shared: null }),
    send: (channel, payload) => broadcastToWindows(() => BrowserWindow.getAllWindows(), channel, payload),
    log: rememberLog
  })

  onPrivySession((status, address) => acpWork.session(status, address))
  ownershipWatch?.onChange((slug, state) => acpWork.ownership(slug, state))
  void acpWork.resume()
  app.on('will-quit', () => acpWork.stopAll())

  // V3-G — confinement (electron/iclone-confinement/): Seatbelt profiles now, Apple container behind the same seam.
  registerConfinement({
    ipcMain,
    isTrustedSender: consentSenderGuard,
    userDataDir: app.getPath('userData'),
    home: os.homedir(),
    hermesHome: HERMES_HOME,
    hermesRoot: ACTIVE_HERMES_ROOT,
    memberPython: path.join(activeVenvRoot(), 'bin', 'python'),
    // T5: the hard-link allowance key is sealed in safeStorage only under the owner's keychain opt-in (secrets.ts);
    // otherwise allowances are session-only and the record on disk is never read.
    keyStore: secretStoragePolicy().on
      ? {
          seal: key => safeStorage.encryptString(key.toString('hex')).toString('base64'),
          open: sealed => Buffer.from(safeStorage.decryptString(Buffer.from(sealed, 'base64')), 'hex')
        }
      : null,
    lastInputAt: senderInputAt,
    hermesPids: () => [backendConnectionState.getProcess()?.pid].filter((pid): pid is number => Boolean(pid)),
    broadcast: channel => broadcastToWindows(() => BrowserWindow.getAllWindows(), channel, null)
  })
  // iCLONE OS — local self-diagnostics + fixes (Settings › Diagnostics, `acp doctor`; see electron/iclone-doctor-main.ts).
  initIcloneDoctor({
    hermesHome: HERMES_HOME,
    venvDir: activeVenvRoot(),
    recentLogs: () => hermesLog,
    gateway: () => {
      const child = backendConnectionState.getProcess()
      const pending = backendConnectionState.getPromise()

      return child?.pid && pending
        ? { pid: child.pid, baseUrl: pending.then(c => (typeof c?.baseUrl === 'string' ? c.baseUrl : null)) }
        : null
    },
    stopGateway: () => teardownPrimaryBackendAndWait({ soft: true }),
    startGateway: async () => {
      await startHermes()
      sendConnectionApplied()
    },
    encryptionOn: () => secretStoragePolicy().on,
    isTrustedSender: createAppSenderGuard({
      devServer: DEV_SERVER,
      rendererIndexPath: resolveRendererIndex,
      log: rememberLog
    }),
    log: rememberLog
  })

  // iCLONE OS — the `it` CLI control plane (loopback + installed POSIX CLI;
  // see electron/iclone-it.ts).
  initIcloneIt({ getMainWindow: () => windowsState.mainWindow })
  // V3-D — the pane bus (Unix socket, per-pane tokens; see electron/iclone-pane-bus/ipc.ts).
  initPaneBus({
    getMainWindow: () => windowsState.mainWindow,
    isTrustedSender: createAppSenderGuard({
      devServer: DEV_SERVER,
      rendererIndexPath: resolveRendererIndex,
      log: rememberLog
    }),
    findOnPath
  })

  ensureWslWindowsFonts()
  configureSpellChecker(session.defaultSession, error =>
    rememberLog(`Spellchecker setup failed: ${errorMessage(error)}`)
  )
  registerPowerResumeListeners()
  keepAwake.set(readPersistedKeepAwake())
  windowsState.f12Blocked = readPersistedDisableF12()
  // Seed this before the first window exists: a picker can open before
  // startHermes() finishes resolving the configured backend.
  const primaryProfile = primaryProfileKey()

  setActiveGatewayProfile(primaryProfile)
  setWslBridgeProfileState(primaryProfile, !primaryBackendIsRemote())
  // Quick Entry's global chord — registered on ready so a cold launch restores
  // it without the renderer visiting Settings. A failed registration is logged
  // here and surfaced in Settings via the IPC state (never silent).
  applyQuickEntrySettings(readQuickEntrySettings())

  if (IS_MAC) {
    const reposition = () => wakeIndicatorController.reposition()

    screen.on('display-added', reposition)

    screen.on('display-metrics-changed', reposition)

    screen.on('display-removed', reposition)
  }

  // A hard crash can interrupt the in-memory restore loop after exact remote
  // serves were drained. The owner-only recovery journal survives that crash;
  // its worker waits for the install marker to clear, then reopens every scope
  // captured by the original transaction before removing the journal entry.
  void resumeManagedSshRecoveries()
  createWindow()
  scheduleLegacyUpdateCleanup()

  // Win/Linux cold start: the launching hermes:// URL is in our own argv.
  const _coldStartLink = _extractDeepLink(process.argv)

  if (_coldStartLink) {
    handleDeepLink({ deepLinkState, windowsState }, _coldStartLink)
  }

  app.on('activate', () => {
    // Recreate the primary window if it's gone. Guard on mainWindow directly
    // (not just total window count) so a dock click still restores the main
    // window when only secondary session windows remain open.
    if (!windowsState.mainWindow || windowsState.mainWindow.isDestroyed()) {
      createWindow()
    } else {
      focusWindow(windowsState.mainWindow)
    }
  })
})

// ── App updates (H1) ──────────────────────────────────────────────────────

const appUpdateRuntimeBusy = () => Boolean(readLiveUpdateMarker(HERMES_HOME)) || isPinnedRuntimeUpdateRunning()

function broadcastAppUpdate(channel: string, payload: unknown) {
  broadcastToWindows(() => BrowserWindow.getAllWindows(), channel, payload)
}

/** Settings → Updates in the main window; false when there is no window to show it in. */
function revealAppUpdates(): boolean {
  const win = windowsState.mainWindow

  if (!win || win.isDestroyed()) {
    return false
  }

  if (win.isMinimized()) {
    win.restore()
  }

  win.show()
  win.focus()
  win.webContents.send(APP_UPDATE_CHANNELS.open, null)

  return true
}

const appUpdateNotifier = createAppUpdateNotifier({
  allowed: () => Notification.isSupported() && consentAllows('notifications'),
  create: options => new Notification(options),
  log: rememberLog,
  reveal: () => void revealAppUpdates()
})

/** The packaged macOS updater, or the lab's stand-in on a dev run with a loopback feed; IPC answers either way. */
function startAppUpdates() {
  const userData = app.getPath('userData')
  const labFeed = resolveLabFeed(process.env, app.isPackaged)

  registerAppUpdateIpc({
    controller: () => quitState.icloneAppUpdate,
    currentVersion: () => app.getVersion(),
    ipcMain,
    isTrustedSender: createAppSenderGuard({
      devServer: DEV_SERVER,
      rendererIndexPath: resolveRendererIndex,
      log: rememberLog
    }),
    readLog: () => readAppUpdateLog(userData)
  })

  if (!labFeed && !(app.isPackaged && IS_MAC)) {
    return
  }

  quitState.icloneAppUpdate = createAppUpdate({
    activeWork: () => quitPromptFor(mergeActiveWork(activeWorkByWebContents.values()), false)?.detail ?? null,
    createCancelToken: labFeed ? createLabCancelToken : () => new CancellationToken(),
    currentVersion: app.getVersion(),
    emit: state => broadcastAppUpdate(APP_UPDATE_CHANNELS.changed, state),
    env: process.env,
    hasFeed: labFeed ? () => true : () => appUpdateFeedPresent(process.resourcesPath), // iclone-seam: r1-feed
    lastInstall: settleAppUpdateLog(userData, app.getVersion()),
    log: rememberLog,
    notify: appUpdateNotifier.notify,
    onInstall: entry => appendAppUpdateLog(userData, entry),
    reveal: revealAppUpdates,
    runtimeUpdateInFlight: appUpdateRuntimeBusy,
    updater: labFeed
      ? createLabUpdater({ currentVersion: app.getVersion(), feed: labFeed, log: rememberLog })
      : electronAutoUpdater,
    windowFocused: () => Boolean(BrowserWindow.getFocusedWindow())
  })
  quitState.icloneAppUpdate.start()
  powerMonitor.on('resume', () => quitState.icloneAppUpdate?.checkIfStale())
}

const LEGACY_CLEANUP_DELAY_MS = 20_000

/** H1b: once, packaged only, a while after the first window is up (never in a lab: dev runs are not packaged). */
function scheduleLegacyUpdateCleanup() {
  if (!app.isPackaged) {
    return
  }

  setTimeout(() => {
    void runLegacyUpdateCleanup({
      appVersion: app.getVersion(),
      hermesHome: HERMES_HOME,
      homeDir: os.homedir(),
      isPackaged: app.isPackaged,
      log: rememberLog,
      runtimeBusy: appUpdateRuntimeBusy,
      trash: target => shell.trashItem(target),
      userData: app.getPath('userData')
    })
      .then(summary => {
        const text = legacyCleanupNotice(summary)

        if (text) {
          broadcastAppUpdate(APP_UPDATE_CHANNELS.notice, { text })
        }
      })
      .catch(error => rememberLog(`[iclone-legacy-cleanup] failed: ${errorMessage(error)}`))
  }, LEGACY_CLEANUP_DELAY_MS).unref?.()
}

// V3-FX r4: "Restart now" relaunches only when the quit goes through (iclone-relaunch.ts).
const relaunchOnQuit = createRelaunchOnQuit(app)

// Ask before a quit kills a turn in flight. True when the quit was intercepted
// and the confirmation is on screen; "Quit Anyway" re-enters before-quit with
// the latch set and falls straight through to the teardown below.
function heldQuitForActiveWork(event: Electron.Event): boolean {
  // "Restart to update" already asked in the window; the quit it starts passes through.
  if (quitState.icloneAppUpdate?.consumeInstallLatch()) {
    quitConfirmedWithActiveWork = true
  }

  if (SKIP_QUIT_CONFIRM || quitConfirmedWithActiveWork || quitPromptOpen) {
    return false
  }

  const prompt = quitPromptFor(mergeActiveWork(activeWorkByWebContents.values()), quitState.isQuittingForHandoff)
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]

  if (!prompt || !parent || parent.isDestroyed()) {
    return false
  }

  event.preventDefault()
  quitPromptOpen = true

  void dialog
    .showMessageBox(parent, {
      buttons: ['Keep Running', 'Quit Anyway'],
      cancelId: 0,
      defaultId: 0,
      detail: prompt.detail,
      message: prompt.message,
      type: 'question'
    })
    .then(({ response }) => {
      quitPromptOpen = false

      if (response === 1) {
        quitConfirmedWithActiveWork = true
        app.quit()
      } else {
        // r4: "Keep Running" — a quit asked for by "Restart now" is cancelled with it.
        relaunchOnQuit.disarm()
      }
    })
    .catch(() => {
      // A dialog we can't show must not become a quit we can't perform.
      quitPromptOpen = false
      quitConfirmedWithActiveWork = true
      app.quit()
    })

  return true
}

app.on('before-quit', event => {
  // Runs ahead of every teardown below, so "Keep Running" leaves the app
  // exactly as it was.
  if (heldQuitForActiveWork(event)) {
    return
  }

  // A detached remote updater can outlive this Electron process. Do not tear
  // down its SSH observer/restore transaction at the generic SSH shutdown
  // deadline: join it first (BEFORE sealing the bootstrap coordinator, whose
  // shutdown would refuse the restore dials), then re-enter before-quit for
  // normal teardown. A crash still fails closed on next launch via the remote
  // install-marker preflight in both POSIX and Windows lifecycle
  // implementations.
  if (
    !managedUpdateQuitWaitDone &&
    (managedUpdateQuitWait || managedConnectionUpdates.size > 0 || managedConnectionRecoveries.size > 0)
  ) {
    event.preventDefault()

    if (!managedUpdateQuitWait) {
      managedUpdateQuitWait = waitForManagedUpdateOperations(() => [
        ...managedConnectionUpdates.values(),
        ...managedConnectionRecoveries.values()
      ]).finally(() => {
        managedUpdateQuitWaitDone = true
        app.quit()
      })
    }

    return
  }

  // A prevented first quit leaves the renderer alive while teardown runs.
  // Seal the SSH coordinator before touching connections so reconnect
  // callbacks cannot recreate a backend for a registration whose app is
  // already quitting (#91668).
  sshBootstrapCoordinator.shutdown()

  if (!backendQuitTeardownDone) {
    event.preventDefault()
    void backendShutdown.run().finally(() => {
      backendQuitTeardownDone = true
      app.quit()
    })
  }

  if ((sshConnections.size > 0 || sshBootstrapCoordinator.promises().length > 0) && !sshQuitTeardownDone) {
    event.preventDefault()
    const scopes = [...sshConnections.keys()]

    const pending = Promise.allSettled([
      ...scopes.map(scope => teardownSshConnection(scope || null)),
      ...sshBootstrapCoordinator.promises()
    ])

    // cleanupStale waits up to 5s for the owned pid to exit (50 * 100ms).
    // The previous 4s race could close SSH first and leave serve --isolated
    // reparented to pid 1.
    void Promise.race([pending, new Promise(resolve => setTimeout(resolve, 6_000))]).then(async () => {
      await sshBootstrapCoordinator.forceCleanupAll()
      sshQuitTeardownDone = true
      app.quit()
    })
  }

  // Clean quit mid-boot should not trip next-launch --no-sandbox (#38216).
  // FATAL GPU aborts skip before-quit, leaving the `booting` marker in place.
  // Keyed on sticky (not active): a manual --no-sandbox run still records a
  // clean quit, while an engaged fallback keeps its sticky marker.
  if (IS_WINDOWS && !sandboxState.windowsSandboxFallbackSticky) {
    try {
      writeSandboxMarker(app.getPath('userData'), markerAfterSuccessfulBoot({ fallbackActive: false }))
    } catch {
      void 0
    }
  }

  // The always-on-top wake indicator isn't a "real" app window; close it so it
  // can't keep the process alive or float over a quit app.
  wakeIndicatorController.close()
  petOverlay.close()

  // Same for the HUD — an always-on-top panel outliving the app would leave a
  // floating composer with nothing behind it. Close it directly rather than via
  // closeHudWindow(): that also re-shows the main window, which is wrong on the
  // way out (and `hudRestoreMainWindow` may still be armed from entering HUD).
  hudSnapShortcut.dispose()

  if (windowsState.hudWindow && !windowsState.hudWindow.isDestroyed()) {
    windowsState.hudWindow.removeAllListeners('closed')
    windowsState.hudWindow.destroy()
  }

  windowsState.hudWindow = null

  // Same for the Quick Entry composer — and release its global accelerator so a
  // quitting Hermes never keeps another app's chord hostage.
  closeQuickEntryWindow()

  // Quitting mid-install should stop the installer, not orphan it.
  if (bootState.bootstrapAbortController) {
    try {
      bootState.bootstrapAbortController.abort()
    } catch {
      void 0
    }
  }

  if (logBufferState.desktopLogFlushTimer) {
    clearTimeout(logBufferState.desktopLogFlushTimer)
    logBufferState.desktopLogFlushTimer = null
  }

  flushDesktopLogBufferSync()
  closePreviewWatchers()

  // Kill open PTYs before environment teardown to avoid the node-pty#904
  // ThreadSafeFunction SIGABRT race.
  terminalIpc.disposeAllTerminalSessions()

  void backendShutdown.run()
})

app.on('window-all-closed', () => {
  // macOS convention: keep the process alive in the Dock when the user closes
  // the last window. But when we're handing off to a detached updater / swap /
  // uninstall script, the process MUST exit so the script can replace or remove
  // the bundle and relaunch — without this the script's PID-wait spins to its
  // full timeout and the user is left with an invisible app (or an uninstall
  // that appears to do nothing).
  if (process.platform !== 'darwin' || quitState.isQuittingForHandoff) {
    app.quit()
  }
})
