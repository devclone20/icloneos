// Entry injected before main.tsx in the web build only (vite.web.config.ts).
import { BUNDLED_POLICY } from '../../electron/policy-version.generated'

import { createWebBridge } from './bridge'

interface GatewayGlobals {
  __HERMES_AUTH_REQUIRED__?: boolean
  __HERMES_SESSION_TOKEN__?: string
  __ICLONE_WEB__?: boolean
  hermesDesktop?: unknown
}

const globals = window as unknown as GatewayGlobals

if (!globals.hermesDesktop) {
  const authRequired = globals.__HERMES_AUTH_REQUIRED__ === true
  const token = typeof globals.__HERMES_SESSION_TOKEN__ === 'string' ? globals.__HERMES_SESSION_TOKEN__ : null

  globals.__ICLONE_WEB__ = true
  globals.hermesDesktop = createWebBridge({ authRequired, location: window.location, policy: BUNDLED_POLICY, token })
  document.documentElement.dataset.icloneWeb = 'true'

  if (!token && !authRequired) {
    // Not served by a gateway (opened from disk or another server): say so instead of a broken shell.
    window.addEventListener('DOMContentLoaded', () => {
      document.body.innerHTML =
        '<main style="font:15px/1.6 system-ui;color:#ddd;background:#111;min-height:100vh;display:grid;place-items:center">' +
        '<div><h1 style="font-size:20px">Gateway not reachable</h1><p>icloneOS Web is served by your Hermes gateway.' +
        ' Start it with <code>./start-gateway.sh</code> and open the address it prints.</p></div></main>'
    })
  }

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined)
    })
  }
}
