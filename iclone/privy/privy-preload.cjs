'use strict'
/*
 * iCLONE OS — preload for the Privy login BrowserWindow ONLY.
 *
 * Never used by the app's main window (see apps/desktop/electron/preload.ts
 * for that bridge). This one has exactly one job: relay the login page's
 * session state (privy.html's postMessage) to the main process, and nothing
 * else. contextIsolation + sandbox stay on (see electron/iclone-privy.ts's
 * webPreferences) — this file never touches Node outside the sandboxed
 * `require('electron')` allowance.
 *
 * privy.html posts `{ __iclonePrivySession: true, type, status, address,
 * userId, label }` to ITS OWN window (same-origin, same-window — never a
 * cross-window/cross-frame message), matching the shape
 * electron/iclone-privy.ts expects on 'iclone:privy-window-event'.
 */
const { ipcRenderer } = require('electron')

window.addEventListener('message', event => {
  // event.source !== window: reject anything not posted by this exact page to
  // itself (e.g. a stray message from a devtools frame or a future iframe).
  // event.origin check: reject anything not from the loopback origin this
  // window was loaded from — belt-and-braces alongside the source check.
  if (event.source !== window) return
  if (event.origin !== window.location.origin) return

  const data = event.data
  if (!data || data.__iclonePrivySession !== true) return

  const type = data.type === 'logout' ? 'logout' : 'auth'

  ipcRenderer.send('iclone:privy-window-event', {
    type,
    status: type === 'logout' ? 'out' : 'in',
    address: typeof data.address === 'string' ? data.address : null,
    userId: typeof data.userId === 'string' ? data.userId : null,
    label: typeof data.label === 'string' ? data.label : null
  })
})
