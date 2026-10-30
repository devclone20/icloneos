// Backend readiness: wait until a Hermes backend answers its health probe.

import { type BackendActivitySource, waitForHermesReady } from '../backend-health'
import type { probeGatewayWebSocket } from '../gateway-ws-probe'
import { resolveReadinessProbeAuth } from '../native-auth-decisions'

import { fetchJson, fetchPublicJson, requestOptionsWithHeaders } from './http'
import { ensureNativeAccessToken, fetchJsonViaOauthSession } from './oauth'

// Build the readiness probe for a connection's auth mode. A gated gateway
// must be probed with the SAME credentials the rest of the connection uses:
// an anonymous probe 401s forever against a live session, and it can never
// see the 404 that identifies a backend predating /api/health (the auth gate
// answers before the SPA catch-all). `probeIsCredentialed` tells
// waitForHermesReady how to read a 401 — rejected session vs gated route.
async function buildReadinessHealthProbe(
  baseUrl: string,
  authMode: string | null | undefined,
  token: string | null | undefined
) {
  const nativeAt = authMode === 'oauth' ? await ensureNativeAccessToken(baseUrl).catch(() => null) : null
  const probeAuth = resolveReadinessProbeAuth(authMode, nativeAt, token)

  if (probeAuth.kind === 'bearer') {
    return {
      // fetchJson takes the bearer via `options.bearer` — a raw `headers`
      // option is ignored, so passing one here would silently probe
      // uncredentialed and reintroduce the 401 loop.
      probeHealth: (url: string, options: any = {}) => fetchJson(url, null, { ...options, bearer: probeAuth.token }),
      probeIsCredentialed: true
    }
  }

  if (probeAuth.kind === 'cookie') {
    return {
      probeHealth: (url: string, options: any = {}) => fetchJsonViaOauthSession(url, options),
      probeIsCredentialed: true
    }
  }

  if (probeAuth.kind === 'token' && probeAuth.token) {
    return {
      probeHealth: (url: string, options: any = {}) => fetchJson(url, probeAuth.token, options),
      probeIsCredentialed: true
    }
  }

  return { probeHealth: fetchPublicJson, probeIsCredentialed: false }
}

export async function waitForHermes(
  baseUrl: string,
  token: string | null | undefined,
  signal?: AbortSignal,
  authMode?: string,
  headers = {},
  /** A local child's classified output (start-hermes): slides the deadline while it installs (ruling 42). */
  activity?: BackendActivitySource
) {
  const { probeHealth, probeIsCredentialed } = await buildReadinessHealthProbe(baseUrl, authMode, token)

  return waitForHermesReady(baseUrl, {
    activity,
    token,
    signal,
    fetchPublicJson,
    fetchJson: probeIsCredentialed
      ? (url, _token, options = {}) => probeHealth(url, requestOptionsWithHeaders(options, headers))
      : fetchJson,
    probeHealth: (url, options = {}) => probeHealth(url, requestOptionsWithHeaders(options, headers)),
    probeIsCredentialed
  })
}

// Electron's main process exposes Node's (undici) WebSocket, whose init also takes the non-standard `{ headers }`
// the probe sends; lib.dom types the global as the WHATWG constructor, so call sites assert the probe's shape.
export type ProbeWebSocketImpl = NonNullable<Parameters<typeof probeGatewayWebSocket>[1]>['WebSocketImpl']
