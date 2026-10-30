/**
 * Ruling 57.3 (V3-FX r6, critic r5 M2): analytics endpoints are cancelled on every app session; Privy login still
 * works (a stub of the SDK's request sequence — the real Privy is never run).
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  ANALYTICS_HOSTS,
  blockAnalytics,
  installAnalyticsBlock,
  isAnalyticsUrl,
  matchesPattern,
  type SessionLike
} from './iclone-analytics-block'

const REPO = path.join(__dirname, '..', '..', '..')

/** A session stub that behaves like Electron's: ONE onBeforeRequest listener per session (a new call replaces it). */
function stubSession() {
  let listener: ((details: { url: string }, cb: (r: { cancel?: boolean }) => void) => void) | null = null

  const session: SessionLike = {
    webRequest: {
      onBeforeRequest: (...args: unknown[]) => {
        listener = (typeof args[0] === 'function' ? args[0] : args[1]) as typeof listener
      }
    }
  }

  const request = (url: string) =>
    new Promise<{ cancel?: boolean }>(resolve => (listener ? listener({ url }, resolve) : resolve({})))

  return { session, request }
}

const PRIVY_LOGIN = [
  'https://auth.privy.io/api/v1/apps/clxxxxxxxxxxxxxxxxxxxxxxx',
  'https://auth.privy.io/api/v1/siwe/init',
  'https://auth.privy.io/api/v1/siwe/authenticate',
  'https://auth.privy.io/api/v1/passwordless/init',
  'https://auth.privy.io/api/v1/passwordless/authenticate',
  'https://auth.privy.io/api/v1/sessions',
  'https://auth.privy.io/api/v1/users/me',
  'https://auth.privy.io/api/v1/embedded_wallets/x/recovery',
  'https://rpc.walletconnect.org/v1/?chainId=eip155:1',
  'https://verify.walletconnect.org/v3/public-key',
  'https://explorer-api.walletconnect.com/w3m/v1/getWallets',
  'https://api.developer.coinbase.com/rpc/v1/base/x'
]

const ANALYTICS = [
  'https://auth.privy.io/api/v1/analytics_events',
  'https://auth.privy.io/api/v1/analytics_events?client=x',
  'https://login.example-app.com/api/v1/analytics_events',
  'https://auth.privy.io/api/v1/%61nalytics_events',
  'https://auth.privy.io//api/v1/analytics_events',
  'https://AUTH.PRIVY.IO/api/v1/analytics_events',
  'https://us.i.posthog.com/e/',
  'https://o1.ingest.sentry.io/api/1/envelope/',
  'https://api.segment.io/v1/t',
  'https://api-js.mixpanel.com/track',
  'https://api2.amplitude.com/2/httpapi',
  'https://browser-intake-datadoghq.com/api/v2/rum',
  'https://api.honeycomb.io/1/events/x',
  'https://pulse.walletconnect.org/e',
  'https://www.google-analytics.com/g/collect',
  'https://cca-lite.coinbase.com/amp',
  'https://analytics-service-dev.cbhq.net/amp',
  'https://sentry.hcaptcha.com/api/1/envelope/?sentry_version=7',
  'https://as.coinbase.com/amp',
  'https://analytics-service-internal.cbhq.net/amp',
  'https://analytics-service-internal-dev.cbhq.net/amp',
  'wss://posthog.com./ws'
]

describe('ruling 57.3: which requests are analytics', () => {
  it.each(ANALYTICS)('cancelled: %s', url => {
    expect(isAnalyticsUrl(url)).toBe(true)
  })

  it.each(PRIVY_LOGIN)('Privy login passes: %s', url => {
    expect(isAnalyticsUrl(url)).toBe(false)
  })

  it('a look-alike host is not ours to block, and non-web schemes are ignored', () => {
    expect(isAnalyticsUrl('https://www.coinbase.com/')).toBe(false) // only as.coinbase.com / cca-lite are analytics
    expect(isAnalyticsUrl('https://hcaptcha.com/1/api.js')).toBe(false) // only its Sentry host
    expect(isAnalyticsUrl('https://posthog.com.example.org/')).toBe(false)
    expect(isAnalyticsUrl('file:///api/v1/analytics_events')).toBe(false)
    expect(isAnalyticsUrl('not a url')).toBe(false)
  })

  it('every analytics path the shipped Privy page names is blocked', () => {
    const bundle = fs.readFileSync(path.join(REPO, 'iclone', 'privy', 'privy-login.js'), 'utf8')
    const paths = [...new Set([...bundle.matchAll(/["'`](\/api\/v1\/[a-z_]*analytic[a-z_/]*)["'`]/g)].map(m => m[1]!))]

    expect(paths.length).toBeGreaterThan(0)
    expect(paths.filter(p => !isAnalyticsUrl(`https://auth.privy.io${p}`))).toEqual([])
  })

  it('the host list equals the runtime denylist (hermes_cli/iclone_sinks.py ANALYTICS_HOSTS)', () => {
    const registry = fs.readFileSync(path.join(REPO, 'hermes_cli', 'iclone_sinks.py'), 'utf8')
    const start = registry.indexOf('ANALYTICS_HOSTS: tuple = (')
    const block = registry.slice(start, registry.indexOf(')', start + 30))

    expect([...block.matchAll(/"([^"]+)"/g)].map(m => m[1])).toEqual([...ANALYTICS_HOSTS])
  })
})

describe('ruling 57.3: the dispatcher on a session', () => {
  it('cancels analytics and lets the Privy login sequence through (SDK stub)', async () => {
    const { session, request } = stubSession()

    blockAnalytics(session)

    for (const url of PRIVY_LOGIN) {
      expect(await request(url), url).toEqual({})
    }

    for (const url of ANALYTICS) {
      expect(await request(url), url).toEqual({ cancel: true })
    }
  })

  it('a listener registered later is chained after the check: it cannot see or allow an analytics request', async () => {
    const { session, request } = stubSession()
    const seen: string[] = []

    blockAnalytics(session)
    session.webRequest.onBeforeRequest((details: { url: string }, cb: (r: { cancel?: boolean }) => void) => {
      seen.push(details.url)
      cb({ cancel: false })
    })

    expect(await request('https://auth.privy.io/api/v1/analytics_events')).toEqual({ cancel: true })
    expect(await request('https://example.org/')).toEqual({ cancel: false })
    expect(seen).toEqual(['https://example.org/'])
  })

  it("a chained listener's own filter is honoured, and null removes it", async () => {
    const { session, request } = stubSession()
    const seen: string[] = []

    blockAnalytics(session)
    session.webRequest.onBeforeRequest({ urls: ['*://*.example.org/*'] }, (d: { url: string }, cb: () => void) => {
      seen.push(d.url)
      cb()
    })
    await request('https://a.example.org/x')
    await request('https://other.net/x')
    session.webRequest.onBeforeRequest(null)
    await request('https://a.example.org/y')

    expect(seen).toEqual(['https://a.example.org/x'])
  })

  it('installing twice keeps one dispatcher', async () => {
    const { session, request } = stubSession()

    blockAnalytics(session)
    blockAnalytics(session)

    expect(await request('https://us.i.posthog.com/e/')).toEqual({ cancel: true })
  })

  it('match patterns', () => {
    expect(matchesPattern('https://a.b.com/x?y', '*://*.b.com/*')).toBe(true)
    expect(matchesPattern('https://b.com/x', '*://*.b.com/*')).toBe(true)
    expect(matchesPattern('https://xb.com/x', '*://*.b.com/*')).toBe(false)
    expect(matchesPattern('file:///x', '*://*/*')).toBe(false)
    expect(matchesPattern('file:///x', '<all_urls>')).toBe(true)
  })
})

describe('ruling 57.3: every app session', () => {
  it('every session created, and the default session at ready', async () => {
    const created: Array<(s: SessionLike) => void> = []

    const app = {
      on: vi.fn((_e: 'session-created', l: (s: SessionLike) => void) => created.push(l)),
      whenReady: () => Promise.resolve()
    }

    const partition = stubSession()
    const defaults = stubSession()

    const ready = installAnalyticsBlock(app, () => defaults.session)

    created.forEach(listener => listener(partition.session))
    await ready

    expect(await partition.request('https://auth.privy.io/api/v1/analytics_events')).toEqual({ cancel: true })
    expect(await defaults.request('https://api.segment.io/v1/t')).toEqual({ cancel: true })
  })

  it("main's first import installs it; the Privy window blocks its partition before the page loads", () => {
    const install = fs.readFileSync(path.join(__dirname, 'iclone-telemetry-seal-install.ts'), 'utf8')
    const privy = fs.readFileSync(path.join(__dirname, 'iclone-privy.ts'), 'utf8')
    const blockAt = privy.indexOf('blockAnalytics(session.fromPartition(PRIVY_PARTITION)')
    const loadAt = privy.indexOf('win.loadURL(')

    expect(install).toMatch(/installAnalyticsBlock\(app as unknown as AppLike, \(\) => session\.defaultSession/)
    expect(blockAt).toBeGreaterThan(0)
    expect(blockAt).toBeLessThan(loadAt)
  })
})
