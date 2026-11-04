// The app's side of shutdown-signals.ts: the real modules behind shutdown-signals-app.ts. Wired from main.ts with one
// call (installAppShutdownSignals()); main.ts's before-quit records its SSH teardown and remote-update wait with
// trackQuitStep(), quits again with requitAfter(), writes its steps with quitTrace(), and tells the quit cap about the
// active-work choice (holdQuitForChoice), the app-update install (capQuitForInstall) and the remote-update wait
// (capQuitForRemoteUpdates, then quitRemoteUpdatesJoined). Its teardown begins with sealQuitTeardown() (the quit is
// marked and the SSH bootstrap coordinator sealed, past any remote-update wait). What every way out must stop is
// registered in the ONE teardown registry (../teardown-registry.ts, registerTeardown()), which shutdown-signals.ts
// runs on will-quit and on every forced exit; the "Restart now" relaunch a quit cap's forced exit runs is registered
// with relaunchOnForcedQuit(). Nothing happens on import.
import { app, BrowserWindow, session } from 'electron'

import { installShutdownSignals, type ShutdownSignalsHandle } from '../shutdown-signals'
import { appTeardown } from '../teardown-registry'

import { forceKillProcessTree } from './backend-ownership'
import { backendShutdown } from './backend-pool'
import { backendConnectionState, backendPool } from './backend-state'
import { managedConnectionRecoveries, managedConnectionUpdates, sshConnections } from './connection-config'
import { schedulePersistWindowState } from './desktop-settings'
import { IS_WINDOWS } from './env'
import { flushDesktopLogBufferSync, rememberLog } from './log'
import { sshBootstrapCoordinator } from './managed-ssh'
import { createdOauthSessions } from './oauth'
import {
  buildAppShutdownDeps,
  createOwnedChildren,
  createRequit,
  type OwnedChild,
  quitSteps
} from './shutdown-signals-app'
import { beginQuitTeardown, bootState, logBufferState, quitState, windowsState } from './state'
import { themeState, writePersistedTranslucency } from './theme'

export type { SshQuitTeardown } from './shutdown-signals-app'
export { SSH_QUIT_TEARDOWN_HOLD_MS, sshQuitTeardownStep, trackQuitStep } from './shutdown-signals-app'

function* ownedChildren(): Generator<readonly [string, null | OwnedChild | undefined]> {
  yield ['backend', backendConnectionState.getProcess() as null | OwnedChild]

  for (const [key, entry] of backendPool) {
    yield [`pool ${key}`, entry.process as null | OwnedChild]
  }
}

let handle: null | ShutdownSignalsHandle = null
let forcedQuitRelaunch: null | (() => void) = null

/** The "Restart now" relaunch a quit cap's forced exit runs (it skips will-quit); never on a signal's forced exit. */
export function relaunchOnForcedQuit(run: () => void): void {
  forcedQuitRelaunch = run
}

/**
 * The quit's teardown begins (main's before-quit, past any remote-update wait): no boot, dial or `ssh -G` starts from
 * now on, and the SSH bootstrap coordinator is sealed so no reconnect recreates a backend.
 */
export function sealQuitTeardown(): void {
  teardownSealed = true
  beginQuitTeardown()
  sshBootstrapCoordinator.shutdown()
}

let shutdownLog: null | ((line: string) => void) = null
let requit: null | ((after: string) => void) = null

/**
 * A later turn of the event loop, after the before-quit pass that prevented the quit has returned (see createRequit):
 * the only way the wiring re-quits, installed or not.
 */
function nextTurn(run: () => void): void {
  setImmediate(run)
}

/** One '[shutdown] <line>' in desktop.log at once (before installAppShutdownSignals() ran: nowhere). */
export function quitTrace(line: string): void {
  try {
    shutdownLog?.(`[shutdown] ${line}`)
  } catch {
    // Diagnostics never decide the quit.
  }
}

/** The teardown before-quit prevented has settled: quit again, on the next turn (see createRequit). */
export function requitAfter(after: string): void {
  if (requit) {
    requit(after)
  } else {
    nextTurn(() => app.quit())
  }
}

export function holdQuitForChoice(): void {
  handle?.holdForChoice()
}

export function capQuitForInstall(): void {
  handle?.capForInstall()
}

/** before-quit is waiting for remote update operations: the quit's cap becomes the long remote-update one. */
export function capQuitForRemoteUpdates(): void {
  handle?.capForRemoteUpdates()
}

/** The remote-update wait ended: the rest of the quit gets the normal cap from now. */
export function quitRemoteUpdatesJoined(): void {
  handle?.remoteUpdatesJoined()
}

/**
 * Every session this run has created (the default one, each persistent partition, each per-connection OAuth jar), seen
 * through app 'session-created' from the install on (module scope in main.ts, before ready, so before any session).
 * The flush reads this set and never calls session.fromPartition(): a partition the run never opened is never created
 * during the quit.
 */
const createdSessions = new Set<Electron.Session>()

/** Whether the quit's teardown was sealed: from then on no pass may hold the quit for a choice again. */
let teardownSealed = false

export function quitTeardownSealed(): boolean {
  return teardownSealed
}

/**
 * A signal quit's storage flush, for the default session, every session this run created (privy, the legacy OAuth
 * jar, preview, embed, ...) and every OAuth jar oauth.ts opened (the per-connection ones included): DOM storage is asked
 * to commit (flushStorageData returns nothing to wait on) and each cookie store is flushed to disk and awaited. Read
 * lazily (a signal before ready has no session yet: the throw is the flush failing, which the cap logs and moves
 * past). One store failing never stops the others; the first failure is reported once all have settled.
 */
export async function flushSessionStorage(): Promise<void> {
  const sessions = [...new Set([session.defaultSession, ...createdSessions, ...createdOauthSessions()])]

  // One session failing (a throw or a rejection) never stops the others; the first failure is reported at the end.
  const failures: unknown[] = []

  for (const current of sessions) {
    try {
      current.flushStorageData()
    } catch (error) {
      failures.push(error)
    }
  }

  const results = await Promise.allSettled(sessions.map(async current => current.cookies.flushStore()))

  for (const result of results) {
    if (result.status === 'rejected') {
      failures.push(result.reason)
    }
  }

  if (failures.length > 0) {
    throw failures[0]
  }
}

export function installAppShutdownSignals(): ShutdownSignalsHandle {
  const children = createOwnedChildren({
    list: ownedChildren,
    kill: (pid, signal) => process.kill(pid, signal),
    isWindows: IS_WINDOWS,
    killTree: forceKillProcessTree
  })

  const deps = buildAppShutdownDeps({
    remember: rememberLog,
    flushLogSync: flushDesktopLogBufferSync,
    clearLogFlushTimer() {
      if (logBufferState.desktopLogFlushTimer) {
        clearTimeout(logBufferState.desktopLogFlushTimer)
        logBufferState.desktopLogFlushTimer = null
      }
    },
    flushPendingAppearance() {
      if (windowsState.translucencyWriteTimer) {
        clearTimeout(windowsState.translucencyWriteTimer)
        windowsState.translucencyWriteTimer = null
        writePersistedTranslucency(themeState.translucencyState)
      }
    },
    persistWindowState: () => schedulePersistWindowState.flush(),
    stopBackends: () => backendShutdown.run(),
    children,
    abortInstaller() {
      const controller = bootState.bootstrapAbortController

      if (!controller || controller.signal.aborted) {
        return false
      }

      controller.abort()

      return true
    },
    sshBootstrap: {
      cleanups: () =>
        [...sshBootstrapCoordinator.active].reduce((count, entry) => count + (entry.forceCleanups?.size ?? 0), 0),
      forceCleanupAll: () => sshBootstrapCoordinator.forceCleanupAll()
    },
    sshOpen: () => sshConnections.size + sshBootstrapCoordinator.promises().length,
    remoteUpdates: () => managedConnectionUpdates.size + managedConnectionRecoveries.size,
    openWindows: () => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).length,
    steps: quitSteps
  })

  app.on('session-created', created => createdSessions.add(created))
  shutdownLog = deps.log
  requit = createRequit({ quit: () => app.quit(), log: deps.log, defer: nextTurn })
  handle = installShutdownSignals({
    app,
    process,
    quitState,
    flushStorage: flushSessionStorage,
    teardown: () => appTeardown.run(shutdownLog),
    relaunchIfArmed: () => forcedQuitRelaunch?.(),
    ...deps
  })
  // Where a quit stops shows in desktop.log: a before-quit followed by window-all-closed and no will-quit is a lost quit.
  app.on('will-quit', () => quitTrace('will-quit'))
  app.on('window-all-closed', () => quitTrace('window-all-closed'))

  return handle
}
