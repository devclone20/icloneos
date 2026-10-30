// Gateway file downloads and saves, and gateway WebSocket tickets.
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'

import { net as electronNet } from 'electron'

import { errorMessage } from '../../src/iclone-shared/errors'
import { downloadAgentFor } from '../api-transport'
import { type RegistryBackendRequestScope, withTransientRetries } from '../connection-config'
import { filenameFromContentDisposition, parseDataUrlToBuffer, pumpStreamToFile } from '../gateway-file-download'
import { DEFAULT_FETCH_TIMEOUT_MS, resolveTimeoutMs } from '../hardening'
import { resolveGatedDownloadAuth } from '../native-auth-decisions'

import { showSaveDialogForMainWindow } from './dialogs'
import { fetchJson } from './http'
import { ensureNativeAccessToken, fetchJsonViaOauthSession, prepareOauthSessionRequest } from './oauth'

// Token-auth download that streams the response body straight to a
// user-selected destination (via finalizeGatewayDownload) instead of buffering
// the whole file in memory. The connect timeout is cleared once headers arrive
// so a slow save dialog or a large stream doesn't trip it. `options.bearer`
// switches the header to Authorization (RFC 8252 native flow), matching fetchJson.
export function downloadViaTokenToFile(
  url: string,
  token: string | null,
  ctx: { suggested: string; fallbackName: string },
  options: any = {}
) {
  return new Promise((resolve, reject) => {
    let parsed

    try {
      parsed = new URL(url)
    } catch (error) {
      reject(new Error(`Invalid URL: ${errorMessage(error)}`))

      return
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`Unsupported Hermes backend URL protocol: ${parsed.protocol}`))

      return
    }

    const client = parsed.protocol === 'https:' ? https : http
    const agent = downloadAgentFor(parsed.protocol)
    const timeoutMs = resolveTimeoutMs(options.timeoutMs, DEFAULT_FETCH_TIMEOUT_MS)

    const req = client.request(
      parsed,
      {
        agent,
        method: 'GET',
        headers: options.bearer
          ? { Authorization: `Bearer ${options.bearer}` }
          : { 'X-Hermes-Session-Token': token ?? '' }
      },
      res => {
        // Headers arrived — the connection phase is done. Drop the idle timeout
        // so it can't abort mid-stream or while the save dialog is open.
        req.setTimeout(0)
        finalizeGatewayDownload(res, res.statusCode || 500, res.headers || {}, {
          ...ctx,
          abort: () => {
            try {
              req.destroy()
            } catch {
              // already finished
            }
          }
        }).then(resolve, reject)
      }
    )

    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timed out connecting to Hermes backend after ${timeoutMs}ms`))
    })
    req.end()
  })
}

// OAuth-session download that streams the response body straight to a
// user-selected destination (via finalizeGatewayDownload). The connect timeout
// is cleared once the response headers arrive.
export function downloadViaOauthSessionToFile(
  url: string,
  ctx: { suggested: string; fallbackName: string },
  options: any = {}
) {
  return new Promise((resolve, reject) => {
    const target = prepareOauthSessionRequest(url)

    if ('error' in target) {
      reject(target.error)

      return
    }

    const { sess } = target

    const timeoutMs = resolveTimeoutMs(options.timeoutMs, DEFAULT_FETCH_TIMEOUT_MS)

    const request = electronNet.request({
      method: 'GET',
      url,
      session: sess,
      useSessionCookies: true,
      redirect: 'follow'
    } as any)

    let settled = false

    const timer = setTimeout(() => {
      if (settled) {
        return
      }

      settled = true

      try {
        request.abort()
      } catch {
        // already finished
      }

      reject(new Error(`Timed out connecting to Hermes backend after ${timeoutMs}ms`))
    }, timeoutMs)

    request.on('response', res => {
      if (settled) {
        return
      }

      // Response headers arrived — cancel the connect timeout so it can't abort
      // the stream while the save dialog is open or bytes are still flowing.
      settled = true
      clearTimeout(timer)
      finalizeGatewayDownload(res, res.statusCode || 500, res.headers || {}, {
        ...ctx,
        abort: () => {
          try {
            request.abort()
          } catch {
            // already finished
          }
        }
      }).then(resolve, reject)
    })
    request.on('error', error => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      reject(error)
    })
    request.end()
  })
}

// Shared tail for both transports: validate status, pick a filename, prompt the
// save dialog, then stream the (still-unconsumed) response body to the chosen
// destination. On an HTTP error the status code is attached so saveGatewayFile
// can trigger the 404-only compatibility fallback.
async function finalizeGatewayDownload(
  res: GatewayResponse,
  statusCode: number,
  headers: http.IncomingHttpHeaders | Record<string, string | string[]>,
  ctx: any = {}
) {
  if (statusCode >= 400) {
    const message = await readGatewayErrorText(res)
    const error: any = new Error(`${statusCode}: ${message}`)
    error.statusCode = statusCode
    throw error
  }

  const disposition = headers['content-disposition'] || headers['Content-Disposition']
  const filename = filenameFromContentDisposition(disposition) || ctx.suggested || ctx.fallbackName

  const result = await showSaveDialogForMainWindow({
    defaultPath: filename,
    title: 'Save File'
  })

  if (result.canceled || !result.filePath) {
    ctx.abort?.()

    return { canceled: true, saved: false }
  }

  try {
    await pumpStreamToFile(res, result.filePath, {
      createWriteStream: (destPath: string) => fs.createWriteStream(destPath),
      unlink: (destPath: string) => fs.promises.unlink(destPath)
    })
  } catch (error) {
    ctx.abort?.()
    throw error
  }

  return { path: result.filePath, saved: true }
}

// Read a bounded amount of an error response body for the thrown message.
// The response stream of either transport (node:http for token backends, electron.net for OAuth sessions).
type GatewayResponse = http.IncomingMessage | Electron.IncomingMessage

function readGatewayErrorText(res: GatewayResponse): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let total = 0

    res.on('data', (chunk: Buffer) => {
      if (total >= 500) {
        return
      }

      const buffer = Buffer.from(chunk)

      total += buffer.length
      chunks.push(buffer)
    })
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').slice(0, 500)))
    res.on('error', () => resolve(Buffer.concat(chunks).toString('utf8').slice(0, 500)))
  })
}

export interface GatewayFileConnection extends RegistryBackendRequestScope {
  authMode?: 'oauth' | 'token'
  baseUrl: string
  token?: null | string
}

interface GatewayFileSaveContext {
  fallbackName: string
  suggested: string
}

export interface GatewayFileSavePayload {
  connectionId?: unknown
  path?: unknown
  profile?: unknown
  suggestedName?: unknown
}

export async function gatedFileAuth(connection: GatewayFileConnection) {
  const nativeAt =
    connection.authMode === 'oauth' ? await ensureNativeAccessToken(connection.baseUrl).catch(() => null) : null

  return resolveGatedDownloadAuth(connection.authMode, nativeAt, connection.token)
}

// Compatibility fallback: fetch the file through the capped
// `/api/fs/read-data-url` route, decode it, and save. Bounded by the gateway's
// data-URL cap, so it only serves smaller files — enough to keep older gateways
// working until they gain the streaming route.
export async function saveGatewayFileViaDataUrl(
  connection: GatewayFileConnection,
  requestPath: string,
  ctx: GatewayFileSaveContext
) {
  const url = `${connection.baseUrl}${requestPath}`
  const auth = await gatedFileAuth(connection)
  let json: unknown

  if (auth.kind === 'bearer') {
    json = await fetchJson(url, null, { bearer: auth.token })
  } else if (auth.kind === 'cookie') {
    json = await fetchJsonViaOauthSession(url)
  } else {
    json = await fetchJson(url, auth.token)
  }

  const dataUrl =
    json && typeof json === 'object' && 'dataUrl' in json && typeof json.dataUrl === 'string' ? json.dataUrl : ''

  if (!dataUrl) {
    throw new Error('Gateway returned no file data')
  }

  const buffer = parseDataUrlToBuffer(dataUrl)
  const filename = ctx.suggested || ctx.fallbackName

  const result = await showSaveDialogForMainWindow({
    defaultPath: filename,
    title: 'Save File'
  })

  if (result.canceled || !result.filePath) {
    return { canceled: true, saved: false }
  }

  await fs.promises.writeFile(result.filePath, buffer)

  return { path: result.filePath, saved: true }
}

// Mint a single-use WS ticket for a gated gateway. Returns the ticket string.
// Prefers a native bearer token (cookieless RFC 8252 flow) when present,
// falling back to the OAuth cookie partition otherwise.
// Throws (with statusCode 401) if the session cookie is missing/expired —
// callers treat that as "needs re-login".
// Transient transport blips (brief host unreachable, 5xx, timeouts) are retried
// a few times before failing — those 1-3s flaps were promoting into the
// full-screen "couldn't start" lockout on reconnect.
export async function mintGatewayWsTicket(baseUrl: string, headers = {}) {
  return withTransientRetries(async () => {
    // Native flow: mint the ticket with the bearer token, no cookie involved.
    const nativeAt = await ensureNativeAccessToken(baseUrl).catch(() => null)

    if (nativeAt) {
      const body = (await fetchJson(`${baseUrl}/api/auth/ws-ticket`, null, {
        method: 'POST',
        timeoutMs: 8_000,
        bearer: nativeAt,
        headers
      })) as any

      const ticket = body?.ticket

      if (!ticket || typeof ticket !== 'string') {
        throw new Error('Gateway did not return a WS ticket.')
      }

      return ticket
    }

    const body = (await fetchJsonViaOauthSession(`${baseUrl}/api/auth/ws-ticket`, {
      method: 'POST',
      timeoutMs: 8_000,
      headers
    })) as any

    const ticket = body?.ticket

    if (!ticket || typeof ticket !== 'string') {
      throw new Error('Gateway did not return a WS ticket.')
    }

    return ticket
  })
}
