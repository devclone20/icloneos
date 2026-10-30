import type { BrowserWindow } from 'electron'

import type { registerHudIpc } from '../hud-ipc'
import type { AppUpdateController } from '../iclone-app-update'
import type { registerTerminalIpc } from '../terminal-ipc'
import type { SandboxFallbackReason } from '../windows-sandbox-fallback'

// Mutable main-process state shared by more than one module, grouped by concern. A value read or written by a
// single module stays private to it; everything here is plain data with an explicit type.

export const windowsState = {
  // Device-local preference: block F12 from opening DevTools.
  // Set dynamically via IPC from the renderer Settings → Advanced.
  f12Blocked: false,
  rendererTitleBarTheme: null as any,
  mainWindow: null as BrowserWindow | null,
  // ── HUD mode ────────────────────────────────────────────────────────────────
  //
  // The chrome-free floating chat: a transparent, frameless, always-on-top
  // window showing only the composer and its scrollback, so Hermes can be driven
  // while the user works in another app.
  //
  // Unlike quick entry, this is a FULL app renderer with its
  // own gateway — the same thing createInstanceWindow() spawns, reshaped. That
  // is deliberate: the HUD renders the real chat surface, so its composer is the
  // app's composer (slash commands, attachments, queue, voice) instead of a
  // lookalike that drifts. Entering HUD mode hides the main window; leaving
  // restores it.
  hudWindow: null as BrowserWindow | null,
  // The session the HUD is currently on, reported by its renderer whenever the
  // selection changes. Leaving HUD mode is a HANDOFF, not just a window close:
  // the gateway binds a session's event stream to exactly one socket, so the
  // turn the HUD started is streaming to the HUD's socket and the app window
  // hears nothing. The app has to re-resume that session to take the stream
  // back, and it can only do that if it knows which session to ask for — the
  // HUD may have switched sessions, or started a new one the app has never
  // seen. Main is the only party that outlives the HUD's renderer, so it holds
  // the id and hands it over in the close broadcast.
  hudSessionId: null as any,
  quickEntryWindow: null as BrowserWindow | null,
  // Latest state push from the primary renderer (connection + recent sessions),
  // replayed to a quick window that spawns after the push happened.
  quickEntryLastState: null as any,
  // See-through window translucency. Persist + re-apply to every open window at
  // runtime (no recreation, so caching/sessions are untouched).
  //
  // The intensity slider is a HOT path: ~100 updates per drag. Two things make
  // that cheap. Native work is diffed, so an intensity-only change under glass
  // touches nothing (it's painted by the renderer). And the disk write is
  // coalesced onto a trailing timer, because writePersistedTranslucency is a
  // synchronous writeFileSync and doing one per tick blocks the main process
  // mid-drag. Only a cold launch reads that file, so it just has to be correct
  // once the hand comes off the slider.
  translucencyWriteTimer: null as ReturnType<typeof setTimeout> | null
}

export const sandboxState = {
  // Windows sandbox / GPU breakpoint crash recovery (#38216).
  //
  // Some hosts (AMD RX 6000 drivers, orphan AppContainer SIDs under %LOCALAPPDATA%,
  // missing S-1-15-2-2 ACEs) kill Chromium's sandboxed GPU/renderer children with
  // 0x80000003. After enough GPU deaths the browser process FATAL-exits before the
  // UI is usable. Must run before app `ready` so `--no-sandbox` applies to child
  // processes. The sticky marker recovers Start Menu / shortcut launches that
  // never go through `hermes desktop`; it is version-scoped so an app update
  // re-probes the sandbox instead of degrading forever.
  //
  // `windowsSandboxFallbackActive` = this process runs without the Chromium
  // sandbox (any cause, including a manual --no-sandbox flag) — guards the
  // relaunch handlers. `windowsSandboxFallbackSticky` = the fallback machinery
  // engaged and the marker must stay `fallback` after a successful boot; a
  // manual flag alone is honored but never made sticky.
  windowsSandboxFallbackActive: false,
  windowsSandboxFallbackSticky: false,
  windowsSandboxFallbackReason: 'boot-loop' as SandboxFallbackReason,
  windowsNoSandboxRelaunchAttempted: false
}

export const connectionRuntimeState = {
  // True while connection-config:apply soft-rehomes the primary — suppresses the
  // backend-exit toast so an intentional kill doesn't look like a crash.
  softRehomeInProgress: false,
  // Mirror of powerMonitor's AC/battery state, broadcast to every window so
  // renderer backstop polls can slow down on battery (see store/power.ts).
  // `null` until the first powerMonitor read after app ready.
  onBatteryPower: null as boolean | null
}

export const bootState = {
  // Latched bootstrap failure: when the first-launch install fails, we hold
  // onto the error so subsequent startHermes() calls (e.g. the renderer's
  // ensureGatewayOpen retrying after the WS won't open) return the same error
  // instead of re-running install.ps1 in a hot loop. Cleared explicitly by
  // the renderer's "Reload and retry" path or by quitting the app.
  bootstrapFailure: null as any,
  // Latched non-bootstrap backend spawn failure — stops getConnection() from
  // respawning hermes serve backend children in a tight loop while boot is broken.
  backendStartFailure: null as Error | null,
  // Latched CONFIRMED remote reauth failure. Remote failures deliberately do not
  // latch via backendStartFailure (they're usually transient and must stay
  // retryable), but a rejected session cannot self-heal — and the non-latching
  // path actively breaks recovery: each retry re-emits running:true and hides
  // the boot-failure overlay, so the "Sign in" button flickers away before it
  // can be clicked. Cleared on every recovery path and on a confirmed sign-in.
  remoteReauthFailure: null as Error | null,
  // Active first-launch install, so the renderer's Cancel button (and app quit)
  // can abort the in-flight install.sh/ps1 instead of leaving it running.
  bootstrapAbortController: null as AbortController | null,
  // Explicit "the user asked for a repair" flag. Repair used to signal intent by
  // deleting the bootstrap marker, which stranded healthy installs whose only
  // problem was a transient backend error (#72166). Intent now lives here, so
  // repair can force the installer without destroying provenance about how the
  // install was created. Cleared once the reinstall is under way.
  bootstrapRepairRequested: false,
  // Counter for in-flight repair attempts. Reset on a clean boot completion
  // (see runBootstrap -> ensureRuntime resolve path). Each successive repair
  // in the same failure episode increments this; once it crosses
  // MAX_BOOTSTRAP_REPAIR_SOFT_ATTEMPTS the guard escalates from "soft restart"
  // to "hard reinstall" so a transient backend stall (issue #74874) stops
  // looping the user through a destructive venv reinstall.
  bootstrapRepairAttempt: 0
}

export const logBufferState = {
  desktopLogFlushTimer: null as ReturnType<typeof setTimeout> | null
}

export const quitState = {
  updateInFlight: false,
  // Set to true when the desktop is about to quit so a detached swap/install/
  // uninstall script can take over. On macOS, app.quit() closes windows but
  // window-all-closed deliberately keeps the process alive (standard Electron
  // macOS convention). Without this flag the process never exits — the detached
  // hand-off script spins its PID-wait for the full timeout, and the user sees a
  // blank app with no window (and an uninstall that appears to do nothing). When
  // set, window-all-closed calls app.quit() on every platform so the process
  // actually dies and the hand-off script can proceed immediately.
  isQuittingForHandoff: false,
  // iclone-seam: p7-app-update
  icloneAppUpdate: null as AppUpdateController | null
}

export const deepLinkState = {
  _rendererReadyForDeepLink: false
}

/**
 * Values owned by the composition root (main.ts) or by a module that loads after their first reader. Each slot is
 * assigned exactly once during startup, before any window, IPC call or child-process event can reach a reader.
 */
export const lateBound = {
  terminalIpc: null as ReturnType<typeof registerTerminalIpc> | null,
  hudIpc: null as ReturnType<typeof registerHudIpc> | null,
  isPrimaryInstance: false,
  exitAfterBackendShutdown(code: number): Promise<void> {
    return Promise.reject(new Error(`exitAfterBackendShutdown(${code}) ran before the backend pool bound it`))
  }
}
