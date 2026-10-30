/**
 * Ruling 57.3 (V3-FX r6) — renderer and web pages are blocked at the network layer.
 *
 * Every session the app creates (the default one, the Privy login partition, OAuth, previews, link titles…) gets one
 * `webRequest.onBeforeRequest` dispatcher that CANCELS any request to an analytics endpoint — the Privy SDK's
 * `/api/v1/analytics_events` (critic r5 M2) and every host of the denylist (hermes_cli/iclone_sinks.py ANALYTICS_HOSTS;
 * a test keeps both lists equal). Electron keeps one onBeforeRequest listener per session, so the session's
 * `onBeforeRequest` is replaced by a registrar: a module that registers its own listener later is chained AFTER the
 * analytics check and never sees (nor can allow) a blocked request — a page cannot opt out.
 *
 * Installed from main's first import (iclone-telemetry-seal-install.ts) through `app.on('session-created')`, again on
 * the default session at ready, and explicitly on the Privy partition before its page loads.
 */

export const ANALYTICS_HOSTS: readonly string[] = Object.freeze([
  'posthog.com',
  'sentry.io',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'amplitude.com',
  'datadoghq.com',
  'datadoghq.eu',
  'browser-intake-datadoghq.com',
  'honeycomb.io',
  'langfuse.com',
  'smith.langchain.com',
  'logfire-api.pydantic.dev',
  'api.wandb.ai',
  'agentops.ai',
  'google-analytics.com',
  'googletagmanager.com',
  'pulse.walletconnect.org',
  'telemetry.nousresearch.com',
  'cca-lite.coinbase.com',
  'analytics-service-dev.cbhq.net',
  'sentry.hcaptcha.com',
  'as.coinbase.com',
  'analytics-service-internal.cbhq.net',
  'analytics-service-internal-dev.cbhq.net'
])

/** Paths that are analytics on any host: the Privy SDK posts its events here (auth.privy.io or a custom domain). */
// Built from segments: this is Privy's path on Privy's hosts, not a route of the Hermes runtime, and the contract
// extractor (iclone/contract/extract.mjs) reads any '/api/' literal in electron/ as a runtime REST call.
export const ANALYTICS_PATHS: readonly string[] = Object.freeze([['', 'api', 'v1', 'analytics_events'].join('/')])

const SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:'])

function decodedPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname).toLowerCase()
  } catch {
    return pathname.toLowerCase()
  }
}

export function isAnalyticsUrl(raw: string): boolean {
  let url: URL

  try {
    url = new URL(raw)
  } catch {
    return false
  }

  if (!SCHEMES.has(url.protocol)) {
    return false
  }

  const host = url.hostname.toLowerCase().replace(/\.+$/, '')

  if (ANALYTICS_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) {
    return true
  }

  const path = decodedPath(url.pathname).replace(/\/{2,}/g, '/')

  return ANALYTICS_PATHS.some(p => path.startsWith(p))
}

/** Chrome match pattern (`<all_urls>`, `scheme://host/path` with `*`) — for a chained listener's own filter. */
export function matchesPattern(raw: string, pattern: string): boolean {
  if (pattern === '<all_urls>') {
    return true
  }

  const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/i.exec(pattern)

  if (!m) {
    return false
  }

  let url: URL

  try {
    url = new URL(raw)
  } catch {
    return false
  }

  const [, scheme, host, path] = m
  const protocol = url.protocol.slice(0, -1)

  if (scheme === '*' ? !['http', 'https', 'ws', 'wss'].includes(protocol) : scheme !== protocol) {
    return false
  }

  const hostname = url.hostname.toLowerCase()

  if (host !== '*') {
    const base = host!.toLowerCase().replace(/^\*\./, '')

    if (host!.startsWith('*.') ? !(hostname === base || hostname.endsWith(`.${base}`)) : hostname !== base) {
      return false
    }
  }

  const glob = new RegExp(
    `^${path!
      .split('*')
      .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`
  )

  return glob.test(url.pathname + url.search)
}

interface RequestDetails {
  url: string
}

type Callback = (response: { cancel?: boolean }) => void
type Listener = (details: RequestDetails, callback: Callback) => void
type Filter = { urls: string[] }

export interface WebRequestLike {
  onBeforeRequest: (...args: unknown[]) => void
}

export interface SessionLike {
  webRequest: WebRequestLike
}

const guarded = new WeakSet<object>()

/** Installs the analytics dispatcher on one session (idempotent) and turns its onBeforeRequest into a registrar. */
export function blockAnalytics(session: SessionLike, log: (line: string) => void = () => {}): void {
  const webRequest = session.webRequest

  if (guarded.has(webRequest)) {
    return
  }

  guarded.add(webRequest)

  const register = webRequest.onBeforeRequest.bind(webRequest)
  let chained: { filter: Filter | null; listener: Listener } | null = null

  register((details: RequestDetails, callback: Callback) => {
    if (isAnalyticsUrl(details.url)) {
      log(`[iclone-analytics-block] cancelled ${new URL(details.url).host}`)
      callback({ cancel: true })

      return
    }

    if (chained && (!chained.filter || chained.filter.urls.some(p => matchesPattern(details.url, p)))) {
      chained.listener(details, callback)

      return
    }

    callback({})
  })

  webRequest.onBeforeRequest = (...args: unknown[]) => {
    const [first, second] = args
    const filter = typeof first === 'function' || first === null ? null : ((first as Filter | undefined) ?? null)
    const listener = (typeof first === 'function' ? first : second) as Listener | null | undefined

    chained = listener ? { filter, listener } : null
  }
}

export interface AppLike {
  on: (event: 'session-created', listener: (session: SessionLike) => void) => unknown
  whenReady: () => Promise<unknown>
}

/** Every session the app ever creates, and the default one at ready. */
export function installAnalyticsBlock(
  app: AppLike,
  defaultSession: () => SessionLike,
  log?: (line: string) => void
): Promise<void> {
  app.on('session-created', session => blockAnalytics(session, log))

  return app.whenReady().then(() => blockAnalytics(defaultSession(), log))
}
