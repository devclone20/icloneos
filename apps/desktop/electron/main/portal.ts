// Nous Portal sign-in and Hermes Cloud agent discovery.
import { app, BrowserWindow } from 'electron'

import { cookiesHavePrivyAccessToken, cookiesHavePrivySession, normalizeRemoteBaseUrl } from '../connection-config'
import { installWindowRendererLifecycle } from '../window-renderer-lifecycle'

import { rememberLog } from './log'
import {
  fetchJsonViaOauthSession,
  getOauthSession,
  hasOauthSessionCookie,
  openOauthLoginWindow,
  warmOauthCookieStore
} from './oauth'

// --- Hermes Cloud discovery + silent per-agent sign-in (cloud-auto-discovery
// Phase 3) ---------------------------------------------------------------
//
// The "cloud" connection mode lets a user sign in to the Nous portal ONCE in
// the OAuth session partition, then (a) discover their hosted agents and (b)
// connect to any of them with no second interactive sign-in. Both ride the one
// portal session cookie living in `persist:hermes-remote-oauth`:
//   - discovery  → GET {portal}/api/agents over the partition-bound net; the
//     portal session cookie authenticates it (NAS Phase 2.5 accepts the cookie).
//   - cascade    → opening an agent's own /login in the same partition hits the
//     portal's silent auto-approve (org member, existing session) and 302s back
//     with that agent's session cookie — no prompt. Each agent still completes
//     its own PKCE exchange; SSO removes the human click, not a security check.

// Canonical Nous portal base URL, overridable for staging/dev. Mirrors the CLI
// convention (hermes_cli/auth.py DEFAULT_NOUS_PORTAL_URL + the same env names)
// so a single override flips every Hermes surface to the same portal.
const DEFAULT_NOUS_PORTAL_URL = 'https://portal.nousresearch.com'

export function resolvePortalBaseUrl() {
  const raw = process.env.HERMES_PORTAL_BASE_URL || process.env.NOUS_PORTAL_BASE_URL || DEFAULT_NOUS_PORTAL_URL

  return String(raw).trim().replace(/\/+$/, '')
}

// Whether the OAuth partition currently holds a live Nous portal session — the
// credential that powers both discovery and the silent cascade. The portal
// authenticates via PRIVY, not the Hermes gateway session cookies, so this
// checks for the `privy-token` cookie on the portal host (NOT
// hasLiveOauthSession, which looks for hermes_session_at/rt that the portal
// never sets). See connection-config.ts cookiesHavePrivySession.
//
// Mirrors hasLiveOauthSession's cold-start guard (#73495): a `persist:`
// partition's cookie store hydrates lazily, so the FIRST read on a fresh boot
// can come back empty even for a signed-in user. The renderer checks Cloud
// status exactly once on entering cloud mode, so a single false-negative here
// used to clear the discovered agent list and demand a re-login that a plain
// retry would have avoided. Warm the store and re-read with a short backoff
// before trusting a negative.
export async function hasLivePortalSession() {
  const sess = getOauthSession()

  if (!sess) {
    return false
  }

  const portalBaseUrl = resolvePortalBaseUrl()
  const parsed = new URL(portalBaseUrl)

  const readPortal = async () => {
    try {
      const cookies = await sess.cookies.get({ url: portalBaseUrl })

      return cookiesHavePrivySession(cookies)
    } catch {
      try {
        const cookies = await sess.cookies.get({ domain: parsed.hostname })

        return cookiesHavePrivySession(cookies)
      } catch {
        return false
      }
    }
  }

  if (await readPortal()) {
    return true
  }

  await warmOauthCookieStore()

  for (const delayMs of [30, 60, 90]) {
    if (await readPortal()) {
      return true
    }

    await new Promise(resolve => setTimeout(resolve, delayMs))
  }

  return readPortal()
}

// Whether the jar holds the short-lived Privy ACCESS token — the exact cookie
// `/api/agents` validates. hasLivePortalSession() answers "signed in at all?"
// (renewal material counts); this answers "can discovery succeed right now?".
async function hasPortalAccessToken() {
  const sess = getOauthSession()

  if (!sess) {
    return false
  }

  const portalBaseUrl = resolvePortalBaseUrl()
  const parsed = new URL(portalBaseUrl)

  try {
    const cookies = await sess.cookies.get({ url: portalBaseUrl })

    return cookiesHavePrivyAccessToken(cookies)
  } catch {
    try {
      const cookies = await sess.cookies.get({ domain: parsed.hostname })

      return cookiesHavePrivyAccessToken(cookies)
    } catch {
      return false
    }
  }
}

// Bounded silent renewal of the short-lived Privy access token (#73495).
//
// After a Desktop restart the long-lived `privy-session` / `privy-refresh-token`
// cookies routinely survive while the ~1h `privy-token` access cookie has
// expired. Discovery then 401s and the only offered recovery used to be a full
// interactive re-login — even though the persisted refresh material can mint a
// fresh access token with no user action: loading any portal page runs the
// Privy client, which rotates a new `privy-token` from the refresh session.
//
// This drives exactly that, headlessly: a hidden window on the portal root in
// the OAuth partition, polled until the access cookie lands, torn down on a
// bounded timeout. Never shown — if renewal can't complete silently the caller
// falls back to the interactive needsCloudLogin path. The in-flight promise is
// shared so concurrent discovery + cascade calls ride one renewal.
let portalAccessRenewal: Promise<boolean> | null = null

function renewPortalAccessSilently() {
  if (portalAccessRenewal) {
    return portalAccessRenewal
  }

  portalAccessRenewal = (async () => {
    if (!app.isReady()) {
      return false
    }

    const sess = getOauthSession()

    if (!sess) {
      return false
    }

    // No renewal material at all → nothing to renew; interactive login is
    // genuinely required.
    if (!(await hasLivePortalSession())) {
      return false
    }

    if (await hasPortalAccessToken()) {
      return true
    }

    const portalBaseUrl = resolvePortalBaseUrl()

    return await new Promise<boolean>(resolve => {
      let settled = false
      let win: Electron.BrowserWindow | null = null
      let pollTimer: ReturnType<typeof setTimeout> | null = null
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null

      const finish = (ok: boolean) => {
        if (settled) {
          return
        }

        settled = true

        if (pollTimer) {
          clearInterval(pollTimer)
        }

        if (deadlineTimer) {
          clearTimeout(deadlineTimer)
        }

        try {
          if (win && !win.isDestroyed()) {
            win.destroy()
          }
        } catch {
          // window already torn down
        }

        rememberLog(`[cloud] silent portal access renewal ${ok ? 'succeeded' : 'did not complete'}`)
        resolve(ok)
      }

      const checkCookie = async () => {
        if (settled) {
          return
        }

        if (await hasPortalAccessToken()) {
          finish(true)
        }
      }

      try {
        win = new BrowserWindow({
          width: 520,
          height: 720,
          show: false,
          title: 'Renewing Hermes Cloud session…',
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            session: sess,
            webSecurity: true
          }
        })
      } catch {
        finish(false)

        return
      }

      win.webContents.on('did-navigate', () => void checkCookie())
      win.webContents.on('did-redirect-navigation', () => void checkCookie())
      win.webContents.on('did-frame-navigate', () => void checkCookie())
      installWindowRendererLifecycle(win, { kind: 'portal-renew', callbacks: { log: rememberLog } })
      pollTimer = setInterval(() => void checkCookie(), 500)
      // Hard deadline: this window is never revealed, so an unrenewable session
      // (revoked refresh token, portal down) must resolve false rather than
      // hang the discovery call behind an invisible window.
      deadlineTimer = setTimeout(() => finish(false), 12_000)

      win.on('closed', () => finish(false))

      win.loadURL(portalBaseUrl).catch(() => finish(false))
    })
  })().finally(() => {
    portalAccessRenewal = null
  }) as Promise<boolean>

  return portalAccessRenewal
}

// Drive a one-time interactive portal sign-in in the OAuth partition. Unlike
// openOauthLoginWindow (which targets a gateway's /login), this lands on the
// portal itself so the resulting session cookie is portal-scoped — the cookie
// that authenticates discovery AND is reused for every silent per-agent
// cascade. Resolves once the portal session cookie appears.
export function openPortalLoginWindow() {
  const portalBaseUrl = resolvePortalBaseUrl()

  return new Promise((resolve, reject) => {
    if (!app.isReady()) {
      reject(new Error('Desktop is not ready to start a Hermes Cloud sign-in.'))

      return
    }

    const sess = getOauthSession()

    if (!sess) {
      reject(new Error('OAuth session partition is unavailable.'))

      return
    }

    let settled = false
    let win: BrowserWindow | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null

    const finish = (err: unknown) => {
      if (settled) {
        return
      }

      settled = true

      if (pollTimer) {
        clearInterval(pollTimer)
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
        resolve({ portalBaseUrl, ok: true })
      }
    }

    const checkCookie = async () => {
      if (settled) {
        return
      }

      // A live portal (Privy) session cookie means sign-in completed.
      if (await hasLivePortalSession()) {
        finish(null)
      }
    }

    try {
      win = new BrowserWindow({
        width: 520,
        height: 720,
        title: 'Sign in to Hermes Cloud',
        autoHideMenuBar: true,
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

    win.webContents.on('did-navigate', () => void checkCookie())
    win.webContents.on('did-redirect-navigation', () => void checkCookie())
    win.webContents.on('did-frame-navigate', () => void checkCookie())
    // Log-only lifecycle diagnostics, same rationale as the OAuth window:
    // a crashed portal sign-in renderer never settles the promise, so the
    // failure would otherwise leave no trace in desktop.log (#81290
    // follow-up).
    installWindowRendererLifecycle(win, { kind: 'portal', callbacks: { log: rememberLog } })
    pollTimer = setInterval(() => void checkCookie(), 750)

    win.on('closed', () => {
      if (!settled) {
        finish(new Error('Sign-in window closed before authentication completed.'))
      }
    })

    // Land on the portal root; any authenticated portal page sets the session
    // cookie. We only care that the partition cookie jar is populated.
    win.loadURL(portalBaseUrl).catch(error => {
      finish(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

// Discover the hosted (Hermes Cloud) agents the signed-in user can see. Calls
// the NAS trimmed-summary endpoint over the partition-bound net, so the portal
// session cookie is attached automatically (no bearer needed — NAS accepts the
// cookie). Returns { agents } on success, or { needsOrgSelection: true, orgs }
// when the user belongs to multiple orgs and hasn't picked one yet (NAS 409
// org_selection_required). Pass `org` (a slug/id from a prior org list) to
// scope discovery to that org. Throws a needsCloudLogin-tagged error when no
// portal session is present.
export async function discoverCloudAgents(org?: string) {
  const portalBaseUrl = resolvePortalBaseUrl()

  if (!(await hasLivePortalSession())) {
    const err = new Error(
      'You are not signed in to Hermes Cloud. Open Settings → Gateway, choose Hermes Cloud, and sign in.'
    ) as any

    err.needsCloudLogin = true
    throw err
  }

  // Renewable session present but the short-lived access token `/api/agents`
  // validates is gone (typical after a restart — `privy-token` is ~1h,
  // `privy-session`/`privy-refresh-token` last ~30 days). Renew silently up
  // front instead of letting the request 401 into a re-login demand (#73495).
  if (!(await hasPortalAccessToken())) {
    await renewPortalAccessSilently()
  }

  const orgQuery = org ? `?org=${encodeURIComponent(org)}` : ''
  let body

  const fetchAgents = () =>
    fetchJsonViaOauthSession(`${portalBaseUrl}/api/agents${orgQuery}`, {
      method: 'GET',
      timeoutMs: 15_000
    })

  try {
    body = (await fetchAgents()) as any
  } catch (initialError) {
    let error = initialError as any

    // A 401 with renewal material still in the jar: attempt ONE bounded silent
    // renewal and retry, so a lapsed access token doesn't surface as a full
    // interactive re-login while a 30-day refresh session sits unused. Only a
    // rejected/failed renewal (or a second 401 on genuinely fresh access)
    // falls through to needsCloudLogin.
    if (error && error.statusCode === 401 && (await renewPortalAccessSilently())) {
      try {
        body = (await fetchAgents()) as any
      } catch (retryError) {
        error = retryError
      }
    }

    if (body === undefined) {
      // A 401 means the portal session lapsed (and silent renewal could not
      // recover it) — surface it as a re-login, not a generic failure.
      if (error && error.statusCode === 401) {
        const err = new Error(
          'Your Hermes Cloud session has expired. Open Settings → Gateway and sign in again.'
        ) as any

        err.needsCloudLogin = true
        err.cause = error
        throw err
      }

      // A 409 means we're a multi-org user who hasn't picked an org. The body
      // carries the user's org list; surface it so the renderer shows a picker
      // and re-calls discovery with the chosen org. (fetchJsonViaOauthSession
      // throws on >=400 with err.statusCode + err.message "409: <json body>".)
      if (error && error.statusCode === 409) {
        const orgs = parseOrgSelectionError(error)

        if (orgs) {
          return { needsOrgSelection: true, orgs }
        }
      }

      throw error
    }
  }

  return { agents: trimCloudAgents(body), org: trimCloudOrg(body?.org) }
}

// Project a NAS response org ({ id, slug, name, isPersonal }) to the trimmed
// shape the renderer persists, or null when absent/malformed.
function trimCloudOrg(org: Record<string, unknown>) {
  if (!org || typeof org !== 'object' || typeof org.id !== 'string') {
    return null
  }

  return {
    id: org.id,
    slug: typeof org.slug === 'string' ? org.slug : null,
    name: typeof org.name === 'string' ? org.name : org.id,
    isPersonal: Boolean(org.isPersonal),
    role: typeof org.role === 'string' ? org.role : 'MEMBER'
  }
}

// One org entry of an org_selection_required error body, before validation.
interface PortalOrgCandidate {
  id?: unknown
  slug?: unknown
  name?: unknown
  isPersonal?: unknown
  role?: unknown
}

// Extract the org list from a 409 org_selection_required error body. The error
// message is "409: <raw json>" (see fetchJsonViaOauthSession); parse defensively
// and return null if it isn't the shape we expect (caller then rethrows).
function parseOrgSelectionError(error: Error) {
  const msg = String(error?.message || '')
  const jsonStart = msg.indexOf('{')

  if (jsonStart < 0) {
    return null
  }

  let parsed

  try {
    parsed = JSON.parse(msg.slice(jsonStart))
  } catch {
    return null
  }

  if (parsed?.error !== 'org_selection_required' || !Array.isArray(parsed.orgs)) {
    return null
  }

  return parsed.orgs
    .filter((o: PortalOrgCandidate | null) => o && typeof o === 'object' && typeof o.id === 'string')
    .map((o: PortalOrgCandidate & { id: string }) => ({
      id: o.id,
      slug: typeof o.slug === 'string' ? o.slug : null,
      name: typeof o.name === 'string' ? o.name : o.id,
      isPersonal: Boolean(o.isPersonal),
      role: typeof o.role === 'string' ? o.role : 'MEMBER'
    }))
}

// Project NAS's agent rows to the trimmed DTO the renderer consumes.
function trimCloudAgents(body: Record<string, unknown>) {
  const agents = Array.isArray(body?.agents) ? body.agents : []

  return agents
    .filter(a => a && typeof a === 'object' && typeof a.id === 'string')
    .map(a => ({
      id: a.id,
      name: typeof a.name === 'string' ? a.name : a.id,
      status: typeof a.status === 'string' ? a.status : 'unknown',
      dashboardUrl: typeof a.dashboardUrl === 'string' ? a.dashboardUrl : null,
      dashboardGatewayState: typeof a.dashboardGatewayState === 'string' ? a.dashboardGatewayState : 'unknown'
    }))
}

// Silent per-agent sign-in: open the selected agent dashboard's /login in the
// SAME OAuth partition. Because the user already holds a live portal session
// there, the agent's /oauth/authorize auto-approves (org member) and 302s back,
// setting that agent's gateway session cookie WITHOUT a second interactive
// prompt. Reuses openOauthLoginWindow — the window self-closes the instant the
// agent's session cookie lands (a silent flow finishes in well under a second;
// if the portal session were absent it would fall through to an interactive
// login, which the discovery gate already prevents). Returns once the agent's
// gateway session cookie is present.
export async function cloudAgentSilentSignIn(dashboardUrl: string) {
  const baseUrl = normalizeRemoteBaseUrl(dashboardUrl)

  // Pre-req: a live portal session must exist, or this would surface an
  // interactive prompt rather than a silent cascade. Discovery already gates on
  // this, but a selection can arrive after the session lapsed.
  if (!(await hasLivePortalSession())) {
    const err = new Error('Your Hermes Cloud session has expired. Sign in to Hermes Cloud again.') as any
    err.needsCloudLogin = true
    throw err
  }

  // The cascade rides the portal's auto-approve, which needs the short-lived
  // access state just like discovery. If only renewal material survived the
  // restart, mint a fresh access token first so the hidden cascade window
  // auto-SSOs instead of stalling on an interactive chooser (#73495).
  if (!(await hasPortalAccessToken())) {
    await renewPortalAccessSilently()
  }

  await openOauthLoginWindow(baseUrl, { silent: true })

  return { baseUrl, connected: await hasOauthSessionCookie(baseUrl) }
}
