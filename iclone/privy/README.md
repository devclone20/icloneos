# iCLONE OS — Privy wallet login

Wallet sign-in (+ iNFT wallet scan) for the desktop app, ported from the
proven CLONE FRAME HUB pattern: `@privy-io/react-auth` bundled offline into a
single IIFE (`privy-login.js`), served over loopback HTTP, hosted in its own
Electron `BrowserWindow` — never inside the app's own renderer, because Privy
needs a real secure-context origin and file:// kills it stone dead.

## ⚠️ Owner action required — Privy dashboard

The app reuses the existing Privy app **`cmrje191z000a0ckzdzc0a9ki`** (same one
the CLONE FRAME HUB uses). Before wallet login works in iCLONE OS, add this
app's origin to that app's allowlist:

1. https://dashboard.privy.io → app `cmrje191z000a0ckzdzc0a9ki` → **Settings → Domains**.
2. Add **`http://127.0.0.1:47831`** to allowed origins.
3. Save.

The port is fixed (47831) specifically so this is a one-time step — the origin
never changes between runs or machines. If port 47831 is ever taken by
something else on the user's machine, the loopback server in
`apps/desktop/electron/iclone-privy.ts` fails to bind and login-window open
requests report the error; nothing silently falls back to a different origin
(that would silently break the dashboard allowlist).

## Why a whole extra window

- **Secure context.** Privy's SDK (WebCrypto, iframes to Privy's own domains)
  requires `https:` or `http://localhost`/`http://127.0.0.1`. The app's own
  renderer loads from `file://` (or a dev server origin that isn't allowlisted
  and shouldn't be, to avoid widening the trusted-origin surface) — neither
  works, so login runs in a dedicated window pointed at the loopback server.
- **Isolated session partition.** The login window runs on
  `persist:iclone-privy`, its own cookie jar — logging out clears exactly this
  partition's storage and nothing else in the app.
- **No OAuth social login.** Electron cannot reliably complete a social
  provider's popup/redirect flow (no custom-protocol redirect handler is wired
  for it here). `login-island/src/island.jsx` pins Privy's `loginMethods` to
  `['email', 'wallet']` so the dashboard's social buttons never surface inside
  this window — email OTP and wallet connect are the two paths, wallet
  labeled as recommended. Either path auto-provisions an embedded wallet on
  Base for a user with no wallet extension installed.

## File map

| File | What |
|---|---|
| `privy.html` | The page the login window loads — dark iCLONE ink/gold styling, calls `PrivyIsland.init/open`, relays session state via `window.postMessage`. |
| `privy-login.js` | **Vendored build artifact.** React + react-dom + `@privy-io/react-auth` bundled offline into one IIFE. Committed so the packaged app never needs `node_modules` or a build step at runtime. |
| `privy-preload.cjs` | Preload for the login `BrowserWindow` only (contextIsolation + sandbox on). Relays `privy.html`'s `postMessage` to the main process over `ipcRenderer.send('iclone:privy-window-event', …)`. Completely separate from `apps/desktop/electron/preload.ts` — the app's main window never loads this file. |
| `login-island/src/island.jsx` | Source for `privy-login.js`. Ported behavior-for-behavior from the CLONE FRAME HUB's `login-island` (same SDK version, same never-a-silent-no-op `open()` invariant) — only the default accent color and the `loginMethods` pin changed. |
| `login-island/build.mjs` | Offline esbuild bundler: `island.jsx` → `../privy-login.js`. |
| `login-island/package.json` | Pinned build deps: `@privy-io/react-auth@3.35.0`, `react@18.3.1`, `react-dom@18.3.1`, `esbuild@0.25.5`. |

## Rebuilding `privy-login.js`

```
cd iclone/privy/login-island
npm install
npm run build   # writes ../privy-login.js
```

Built and verified in this repo on 2026-08-28 — `npm install` (687 packages,
network reachable) + `npm run build` (esbuild 0.25.5, 551ms) produced a
4.9MB IIFE (`privy-login.js`, 5,097,477 bytes) containing `PrivyIsland` and
the `d7c9a6` accent default. This is a **fresh build**, not a copy of the
HUB's artifact — only the *source* (`island.jsx`) traces back to the HUB's
proven pattern.

`login-island/node_modules/` is gitignored — the build machine needs it once
to produce `privy-login.js`; the packaged app and every other checkout only
ever need the committed bundle.

## Runtime contract

`window.PrivyIsland` (defined by `privy-login.js` once loaded):

- `init({ appId, accent, onAuth, onLogout })` — mounts the React tree once.
  Idempotent; a second call is a no-op.
- `open()` — shows the Privy modal, or re-announces an already-authenticated
  session through `onAuth` so the caller resyncs. Never a silent no-op — see
  the invariant documented at the top of `island.jsx`.
- `logout()` — signs out of the current Privy session.

`privy.html` calls these and turns `onAuth`/`onLogout` into
`window.postMessage({ __iclonePrivySession: true, type: 'auth' | 'logout',
status: 'in' | 'out', address, userId, label }, window.location.origin)` —
same-window, same-origin only. `privy-preload.cjs` relays that to the main
process; `apps/desktop/electron/iclone-privy.ts` forwards it to the app's main
window over `iclone:privy-session`. Full shape and IPC channel names are
documented in `apps/desktop/electron/iclone-privy.ts`.

## Security notes

- Only the **public** Privy app id ever appears in this directory. The app
  secret is a server credential and must never be added here.
- `privy-login.js` is served by a loopback-only (`127.0.0.1`) HTTP server that
  answers exactly two paths (`/privy.html`, `/privy-login.js`) and 404s
  everything else — no directory listing, no path traversal surface (see
  `apps/desktop/electron/iclone-privy.ts`).
- Never enter a seed phrase or private key anywhere in this flow — Privy's
  embedded wallet and any injected extension wallet both keep key material out
  of this app entirely.
