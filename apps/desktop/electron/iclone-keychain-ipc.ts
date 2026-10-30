/**
 * V3-FX M1 / r3 — the renderer's two doors on the Keychain switch:
 *   `iclone:keychain:state`   the setting now and when this main started (no keychain touch);
 *   `iclone:keychain:restart` relaunch the app cleanly so the permission modes pick the Keychain up (their key is
 *                              sealed at launch). Accepted only when it can change something: the setting is on now
 *                              and was off at launch. Both refuse any sender the app's guard refuses (null).
 */
interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

export interface KeychainIpcDeps {
  ipcMain: IpcMainLike
  isTrustedSender: (event: unknown, channel: string) => boolean
  on: () => boolean
  atLaunch: boolean
  /** app.relaunch() then app.quit(): every will-quit handler runs (payments, ACP work, the backend). */
  relaunch: () => void
}

export function registerKeychainIpc(deps: KeychainIpcDeps): void {
  deps.ipcMain.handle('iclone:keychain:state', event =>
    deps.isTrustedSender(event, 'iclone:keychain:state') ? { on: deps.on(), atLaunch: deps.atLaunch } : null
  )

  deps.ipcMain.handle('iclone:keychain:restart', event => {
    if (!deps.isTrustedSender(event, 'iclone:keychain:restart')) {
      return null
    }

    if (!deps.on() || deps.atLaunch) {
      return false
    }

    deps.relaunch()

    return true
  })
}
