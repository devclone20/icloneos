// OAuth sessions and the native token store for gateway sign-in.
import fs from 'node:fs'
import path from 'node:path'

import { app, BrowserWindow, net as electronNet, session } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import { cookiesHaveLiveSession, cookiesHaveSession, normalizeRemoteBaseUrl } from '../connection-config'
import { DEFAULT_FETCH_TIMEOUT_MS, resolveTimeoutMs } from '../hardening'
import { resolveJsonBody } from '../native-auth-decisions'
import { nativeRefreshUrl, type NativeTokenSet, parseTokenResponse, tokenNeedsRefresh } from '../native-oauth'
import { loadNativeTokenSet, type NativeTokenStoreIo, persistNativeTokenSet } from '../native-token-store'
import { serializeJsonBody, setJsonRequestHeaders } from '../oauth-net-request'
import { LEGACY_OAUTH_PARTITION, resolveOauthPartition } from '../oauth-partition'
import { installWindowRendererLifecycle } from '../window-renderer-lifecycle'

import {
  headersForRemoteRequest,
  readDesktopConnectionConfig,
  readDesktopConnectionsRegistry
} from './connection-config'
import { fetchJson } from './http'
import { rememberLog } from './log'
import { decryptDesktopSecret, encryptDesktopSecret } from './secrets'

let oauthSession: Electron.Session | null = null

// ---------------------------------------------------------------------------
// OAuth remote-gateway auth.
//
// Hosted Hermes gateways gate the dashboard behind an OAuth provider (e.g.
// Nous Research) instead of a static session token. The auth model is
// fundamentally different from the token path:
//
//   * REST is authed by HttpOnly session cookies (``hermes_session_at``),
//     established by a browser redirect round-trip (/login → IDP →
//     /auth/callback sets cookies). We cannot read the HttpOnly cookie value
//     in JS — instead we let an Electron BrowserWindow complete the round
//     trip into a PERSISTENT session partition, and thereafter route our REST
//     through Electron's ``net`` bound to that same partition so the cookie
//     jar attaches the cookie automatically.
//   * WebSocket upgrades require a single-use ``?ticket=`` minted at
//     ``POST /api/auth/ws-ticket`` (cookie-authed). The legacy ``?token=``
//     path is unconditionally rejected by gated gateways.
//   * Nous Portal now issues a 24h ROTATING, reuse-detected refresh token
//     alongside the ~15-min access token (Portal NAS #293 / hermes #37247).
//     Both are set as HttpOnly cookies (``hermes_session_at`` ~15 min,
//     ``hermes_session_rt`` 24h). When the AT cookie lapses but the RT cookie
//     is still alive, the gateway middleware transparently rotates a fresh AT
//     on the next authenticated request — so connectivity must NOT be gated on
//     the AT cookie alone. We probe liveness by actually minting a ws-ticket
//     (which triggers that server-side refresh) and treat a real 401 as
//     "needs re-login"; the AT-or-RT cookie presence check is only a cheap
//     "is the user signed in at all?" gate / display signal.
// ---------------------------------------------------------------------------

const OAUTH_SESSION_PARTITION = LEGACY_OAUTH_PARTITION

export function getOauthSession() {
  if (oauthSession || !app.isReady()) {
    return oauthSession
  }

  oauthSession = session.fromPartition(OAUTH_SESSION_PARTITION)

  return oauthSession
}

// Per-connection cookie jars (#92183). A NON-primary v2 registry remote with
// cookie auth rides its own partition so two registered gateways can never
// evict — or be handed — each other's session cookies (Chromium jars ignore
// the port, so two dashboards on one VPN host used to collide in the shared
// jar above). The primary / v1 remote / cloud / portal flows keep the legacy
// shared partition; see oauth-partition.ts for the full rules.
const oauthSessionsByPartition = new Map()

function resolveOauthPartitionForUrl(url: unknown) {
  try {
    return resolveOauthPartition(url, {
      registry: readDesktopConnectionsRegistry(),
      v1RemoteUrl: readDesktopConnectionConfig()?.remote?.url
    })
  } catch {
    // A broken registry read must never take cookie auth down with it.
    return OAUTH_SESSION_PARTITION
  }
}

export function getOauthSessionForUrl(url: unknown) {
  const partition = resolveOauthPartitionForUrl(url)

  if (partition === OAUTH_SESSION_PARTITION) {
    return getOauthSession()
  }

  if (!app.isReady()) {
    return null
  }

  let sess = oauthSessionsByPartition.get(partition)

  if (!sess) {
    sess = session.fromPartition(partition)
    oauthSessionsByPartition.set(partition, sess)
  }

  return sess
}

// Cold-start cookie-jar warm-up. A `persist:` partition materialized via
// session.fromPartition() loads its on-disk cookie store LAZILY: the very first
// cookies.get() on a fresh cold start can resolve BEFORE the jar has finished
// hydrating from disk and return an empty array — even though the user is
// signed in. That false-negative used to make hasLiveOauthSession() report
// "not signed in", which on the initial boot path (startHermes → the renderer's
// single-shot boot() with no retry) surfaced as the "Hermes couldn't start"
// OAuth overlay that vanishes the instant the user clicks Retry.
//
// We force the store to hydrate once, up front: flushStorageData() then a
// throwaway cookies.get(). The promise is memoized so every caller awaits the
// same single warm-up. Best-effort — any error resolves so we fall back to the
// live read (which then does its own bounded re-check).
// Memoized per PARTITION: per-connection jars (#92183) hydrate independently.
const oauthCookieWarmups = new Map()

export function warmOauthCookieStore(url?: unknown) {
  const partition = resolveOauthPartitionForUrl(url)
  const pending = oauthCookieWarmups.get(partition)

  if (pending) {
    return pending
  }

  const warmup = (async () => {
    const sess = getOauthSessionForUrl(url)

    if (!sess) {
      // App not ready yet — don't memoize a no-op; let a later call retry.
      oauthCookieWarmups.delete(partition)

      return
    }

    try {
      // flushStorageData() forces Chromium to reconcile the in-memory cookie
      // monster with the on-disk SQLite store; the subsequent get() then reads
      // a populated jar rather than racing the lazy first-access load.
      sess.flushStorageData?.()
      await sess.cookies.get({})
    } catch {
      // Best effort; the real read below re-checks with bounded retries.
    }
  })()

  oauthCookieWarmups.set(partition, warmup)

  return warmup
}

// Bare + prefixed variants of the session cookies live in
// connection-config.ts (cookiesHaveSession / cookiesHaveLiveSession). See
// that module for details.

export async function hasOauthSessionCookie(baseUrl: string) {
  const sess = getOauthSessionForUrl(baseUrl)

  if (!sess) {
    return false
  }

  const parsed = new URL(baseUrl)

  try {
    // Query by URL so the cookie jar applies Domain/Path/Secure scoping for us.
    const cookies = await sess.cookies.get({ url: baseUrl })

    return cookiesHaveSession(cookies)
  } catch {
    // Fall back to a host match if the URL query path errors.
    try {
      const cookies = await sess.cookies.get({ domain: parsed.hostname })

      return cookiesHaveSession(cookies)
    } catch {
      return false
    }
  }
}

// Like hasOauthSessionCookie, but returns true when EITHER a live access-token
// cookie OR a (longer-lived) refresh-token cookie is present. This is the right
// "is the user signed in at all?" check: an expired AT with a live RT is still
// a connectable session because the gateway rotates a fresh AT server-side on
// the next authenticated request. Gating on the AT alone forces a needless full
// re-login every ~15 min. Used for the Settings "connected" indicator and as a
// cheap early-out before attempting a network round-trip in resolveRemoteBackend.
export async function hasLiveOauthSession(baseUrl: string) {
  const sess = getOauthSessionForUrl(baseUrl)

  if (!sess) {
    return false
  }

  const parsed = new URL(baseUrl)

  const readLive = async () => {
    try {
      const cookies = await sess.cookies.get({ url: baseUrl })

      return cookiesHaveLiveSession(cookies)
    } catch {
      try {
        const cookies = await sess.cookies.get({ domain: parsed.hostname })

        return cookiesHaveLiveSession(cookies)
      } catch {
        return false
      }
    }
  }

  // First read against the (possibly still-hydrating) jar.
  if (await readLive()) {
    return true
  }

  // Cold-start false-negative guard. A `persist:` partition's cookie store
  // loads lazily, so the FIRST read on a fresh boot can come back empty even
  // for a signed-in user — the exact race that produced the transient "Hermes
  // couldn't start / not signed in" overlay that Retry always cleared. Before
  // trusting a negative, force the store to hydrate and re-read a couple of
  // times with a short backoff. A genuinely signed-out user still resolves
  // false quickly (≤ ~180ms); a signed-in user racing the load now wins.
  await warmOauthCookieStore(baseUrl)

  for (const delayMs of [30, 60, 90]) {
    if (await readLive()) {
      return true
    }

    await new Promise(resolve => setTimeout(resolve, delayMs))
  }

  return readLive()
}

export async function clearOauthSession(baseUrl: unknown) {
  const sess = getOauthSessionForUrl(baseUrl)

  if (!sess) {
    return
  }

  try {
    const cookies = await sess.cookies.get(baseUrl ? { url: baseUrl } : {})
    await Promise.all(
      cookies.map((c: Electron.Cookie) => {
        // A cookie without a domain cannot be addressed by URL; there is nothing to remove.
        if (!c.domain) {
          return undefined
        }

        const scheme = c.secure ? 'https' : 'http'
        const cookieUrl = `${scheme}://${c.domain.replace(/^\./, '')}${c.path || '/'}`

        return sess.cookies.remove(cookieUrl, c.name).catch(() => undefined)
      })
    )
  } catch {
    // Best effort — a stale cookie self-expires anyway.
  }
}

// Open a gateway login window in the OAuth session partition, resolving once
// the access-token cookie appears (login done) or rejecting if the user closes
// the window first. The window navigates through the IDP and back to
// /auth/callback, which sets the session cookies on the partition; we poll the
// cookie jar rather than try to read the HttpOnly value.
//
// `silent` selects the URL the window loads, which decides interactive-vs-silent:
//   - silent=false (default): load ``/login`` — the public interstitial that
//     renders the "Log in with X" provider chooser. This is the interactive
//     remote-gateway login the settings UI drives.
//   - silent=true: load the PROTECTED root ``/`` instead. ``/login`` is a public
//     route, so loading it NEVER triggers the gate's auto-SSO and always shows
//     the chooser. Loading a protected page with no session cookie makes the
//     gate run ``_auto_sso_response``: single registered provider + a live
//     portal session in this partition → a silent 302 through
//     ``/auth/login`` → portal ``/oauth/authorize`` (auto-approves org members)
//     → ``/auth/callback``, which sets the gateway cookie with NO interactive
//     prompt. This is the per-agent cloud cascade (decisions.md Q5).
export function openOauthLoginWindow(baseUrl: string, { silent = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!app.isReady()) {
      reject(new Error('Desktop is not ready to start an OAuth login.'))

      return
    }

    const sess = getOauthSessionForUrl(baseUrl)

    if (!sess) {
      reject(new Error('OAuth session partition is unavailable.'))

      return
    }

    let settled = false
    let win: Electron.BrowserWindow | null = null
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let revealTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (err: unknown) => {
      if (settled) {
        return
      }

      settled = true

      if (pollTimer) {
        clearInterval(pollTimer)
      }

      if (revealTimer) {
        clearTimeout(revealTimer)
      }

      try {
        if (win && !win.isDestroyed()) {
          win.destroy()
        }
      } catch {
        // window already torn down
      }

      if (err) {
        reject(err)
      } else {
        resolve({ baseUrl, ok: true })
      }
    }

    const checkCookie = async () => {
      if (settled) {
        return
      }

      if (await hasOauthSessionCookie(baseUrl)) {
        finish(null)
      }
    }

    try {
      win = new BrowserWindow({
        width: 520,
        height: 720,
        title: silent ? 'Connecting to Hermes Cloud agent…' : 'Sign in to Hermes gateway',
        autoHideMenuBar: true,
        // Silent cascade: start HIDDEN. The auto-SSO 302 chain completes in
        // well under a second, so the window normally never needs to show. We
        // only reveal it as a fallback if the cascade DOESN'T complete quickly
        // (e.g. the portal session lapsed and the gate fell through to the
        // interactive chooser) — see the reveal timer below.
        show: !silent,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          session: sess,
          webSecurity: true
        }
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))

      return
    }

    // Re-check the cookie jar on every successful navigation (the callback
    // redirect is the moment cookies get set) plus a low-frequency poll as a
    // belt-and-braces fallback for IDPs that finish via in-page JS.
    win.webContents.on('did-navigate', () => void checkCookie())
    win.webContents.on('did-redirect-navigation', () => void checkCookie())
    win.webContents.on('did-frame-navigate', () => void checkCookie())
    // Log-only lifecycle diagnostics: a crashed sign-in renderer is invisible
    // to the window's promise path (it never settles), so without this the
    // failure leaves no trace in desktop.log (#81290 follow-up).
    installWindowRendererLifecycle(win, { kind: 'oauth', callbacks: { log: rememberLog } })
    pollTimer = setInterval(() => void checkCookie(), 750)

    // Silent-mode reveal fallback: if the cascade hasn't settled shortly, the
    // auto-SSO didn't go through silently (no portal session, multi-provider,
    // loop-guard tripped, etc.) and the window is now showing an interactive
    // page. Reveal it so the user can complete sign-in manually rather than
    // staring at nothing. Cleared on finish().
    if (silent && win) {
      revealTimer = setTimeout(() => {
        try {
          if (!settled && win && !win.isDestroyed() && !win.isVisible()) {
            win.show()
          }
        } catch {
          // window torn down
        }
      }, 2500)
    }

    win.on('closed', () => {
      if (!settled) {
        finish(new Error('Login window closed before authentication completed.'))
      }
    })

    // ``next`` is intentionally omitted: the gateway lands on ``/`` after
    // login, which is a valid authenticated page that sets the cookies. We
    // only care that the cookie jar is populated.
    //
    // silent=true loads the protected root so the gate auto-SSOs (no chooser);
    // silent=false loads the public ``/login`` chooser for interactive sign-in.
    const normalizedBase = normalizeRemoteBaseUrl(baseUrl)
    const loginUrl = silent ? `${normalizedBase}/` : `${normalizedBase}/login`
    win.loadURL(loginUrl).catch(error => {
      finish(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

// The OAuth session and parsed URL for a request through the session partition, or the error that rejects it.
export function prepareOauthSessionRequest(url: string): { error: Error } | { parsed: URL; sess: Electron.Session } {
  const sess = getOauthSessionForUrl(url)

  if (!sess) {
    return { error: new Error('OAuth session partition is unavailable.') }
  }

  let parsed: URL

  try {
    parsed = new URL(url)
  } catch (error) {
    return { error: new Error(`Invalid URL: ${errorMessage(error)}`) }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: new Error(`Unsupported Hermes backend URL protocol: ${parsed.protocol}`) }
  }

  return { parsed, sess }
}

// JSON request routed through the OAuth session partition so the HttpOnly
// session cookie is attached automatically by Electron's net stack. Used for
// authed REST against a gated gateway, including minting WS tickets.
export function fetchJsonViaOauthSession(url: string, options: any = {}) {
  return new Promise((resolve, reject) => {
    const target = prepareOauthSessionRequest(url)

    if ('error' in target) {
      reject(target.error)

      return
    }

    const { sess } = target

    const body = serializeJsonBody(options.body)
    const timeoutMs = resolveTimeoutMs(options.timeoutMs, DEFAULT_FETCH_TIMEOUT_MS)

    const request = electronNet.request({
      method: options.method || 'GET',
      url,
      session: sess,
      useSessionCookies: true,
      redirect: 'follow'
    } as any)

    setJsonRequestHeaders(request)

    for (const [name, value] of Object.entries({ ...headersForRemoteRequest(url), ...(options.headers || {}) })) {
      request.setHeader(name, String(value))
    }

    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true

      try {
        request.abort()
      } catch {
        // already finished
      }

      reject(new Error(`Timed out connecting to Hermes backend after ${timeoutMs}ms`))
    }, timeoutMs)

    request.on('response', res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        if (timedOut) {
          return
        }

        clearTimeout(timer)
        const text = Buffer.concat(chunks).toString('utf8')
        const statusCode = res.statusCode || 500

        if (statusCode >= 400) {
          const err = new Error(`${statusCode}: ${text || ''}`) as any
          err.statusCode = statusCode
          reject(err)

          return
        }

        if (!text) {
          resolve(null)

          return
        }

        const looksHtml = /^\s*<(?:!doctype|html)/i.test(text)
        const contentType = String(res.headers['content-type'] || res.headers['Content-Type'] || '')

        if (looksHtml || contentType.includes('text/html')) {
          reject(new Error(`Expected JSON from ${url} but got HTML (status ${statusCode}).`))

          return
        }

        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error(`Invalid JSON from ${url} (status ${statusCode}): ${text.slice(0, 200)}`))
        }
      })
    })
    request.on('error', error => {
      if (timedOut) {
        return
      }

      clearTimeout(timer)
      reject(error)
    })

    if (body) {
      request.write(body)
    }

    request.end()
  })
}

// ---------------------------------------------------------------------------
// RFC 8252 native-app tokens (system-browser + loopback + PKCE).
//
// Unlike the cookie flow, the native flow hands the desktop opaque bearer
// tokens it holds itself: the access token authenticates REST via
// ``Authorization: Bearer`` (which the gateway gate now accepts) and mints WS
// tickets the same way, so NO browser session cookie or embedded webview is
// involved. Tokens are persisted encrypted at rest via Electron ``safeStorage``
// (OS keychain) keyed by gateway base URL, and refreshed via
// ``/auth/native/refresh`` before expiry. This is the desktop half of the
// feature; the server half lives in hermes_cli/dashboard_auth/native_flow.py.
// ---------------------------------------------------------------------------

// In-memory cache of decrypted native tokens, keyed by normalized base URL.
// Backed by the encrypted on-disk store so it survives restarts.
const _nativeTokens = new Map<string, NativeTokenSet>()

function _nativeTokenStorePath() {
  // Co-located with the connection config under userData; one JSON file mapping
  // baseUrl → { encoding, value } safeStorage payloads.
  return path.join(app.getPath('userData'), 'native-oauth-tokens.json')
}

// The electron-coupled half of the token store: safeStorage encryption plus the
// userData file. native-token-store.ts owns the serialization/parse round trip
// so it can be tested without an Electron runtime.
export function _nativeTokenStoreIo(): NativeTokenStoreIo {
  return {
    encrypt: encryptDesktopSecret,
    decrypt: decryptDesktopSecret,
    readStoreText: () => fs.readFileSync(_nativeTokenStorePath(), 'utf8'),
    writeStoreText: (text: string) => {
      fs.mkdirSync(path.dirname(_nativeTokenStorePath()), { recursive: true })
      fs.writeFileSync(_nativeTokenStorePath(), text, { mode: 0o600 })
    },
    rememberLog
  }
}

function _persistNativeTokens(baseUrl: string, tokens: NativeTokenSet | null) {
  persistNativeTokenSet(baseUrl, tokens, _nativeTokenStoreIo())
}

function _loadNativeTokens(baseUrl: string): NativeTokenSet | null {
  const cached = _nativeTokens.get(baseUrl)

  if (cached) {
    return cached
  }

  const tokens = loadNativeTokenSet(baseUrl, _nativeTokenStoreIo())

  if (tokens) {
    _nativeTokens.set(baseUrl, tokens)
  }

  return tokens
}

export function _storeNativeTokens(baseUrl: string, tokens: NativeTokenSet) {
  _nativeTokens.set(baseUrl, tokens)
  _persistNativeTokens(baseUrl, tokens)
}

export function _clearNativeTokens(baseUrl: string) {
  _nativeTokens.delete(baseUrl)
  _persistNativeTokens(baseUrl, null)
}

// True when we hold native bearer tokens for this gateway (the native-flow
// analogue of hasLiveOauthSession's cookie check).
export function hasNativeSession(baseUrl: string): boolean {
  return _loadNativeTokens(baseUrl) !== null
}

// POST JSON WITHOUT the OAuth cookie partition — used for the native token +
// refresh exchanges, which are cookieless by design. Thin wrapper over
// fetchJson (no token) so it shares timeout/JSON handling.
export function postJsonNoAuth(url: string, body: unknown, opts: any = {}) {
  // resolveJsonBody passes the object through UNCHANGED — fetchJson owns
  // JSON.stringify. Pre-stringifying here double-encodes the body (a JSON
  // string inside a JSON string), which the gateway's Pydantic model rejects
  // with a 422 "Input should be a valid dictionary" (the native
  // /auth/native/token + /auth/native/refresh legs both go through here).
  return fetchJson(url, null, { method: 'POST', body: resolveJsonBody(body), ...opts })
}

// Return a valid native access token for baseUrl, refreshing via
// /auth/native/refresh if the stored one is at/near expiry. Returns null when
// there are no tokens or the refresh is terminally rejected (caller re-logins).
export async function ensureNativeAccessToken(baseUrl: string): Promise<string | null> {
  const tokens = _loadNativeTokens(baseUrl)

  if (!tokens) {
    return null
  }

  if (!tokenNeedsRefresh(tokens, Math.floor(Date.now() / 1000))) {
    return tokens.accessToken
  }

  if (!tokens.refreshToken) {
    // Access token expired and no RT to rotate — force re-login.
    _clearNativeTokens(baseUrl)

    return null
  }

  try {
    const body = await postJsonNoAuth(
      nativeRefreshUrl(baseUrl),
      { refresh_token: tokens.refreshToken, provider: tokens.provider },
      { timeoutMs: 10_000 }
    )

    const rotated = parseTokenResponse(body)
    _storeNativeTokens(baseUrl, rotated)

    return rotated.accessToken
  } catch (error: any) {
    // A 401 means the RT is dead (session_expired) — drop tokens so the UI
    // prompts a fresh native login. A 503/transient keeps them for a retry.
    if (error && error.statusCode === 401) {
      _clearNativeTokens(baseUrl)

      return null
    }

    throw error
  }
}
