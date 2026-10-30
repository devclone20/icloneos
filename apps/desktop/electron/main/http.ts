// HTTP helpers for backend and public requests: JSON fetch, multipart bodies, MIME helpers.

import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

import { errorMessage } from '../../src/iclone-shared/errors'
import { jsonAgentFor, withRetry } from '../api-transport'
import { DEFAULT_FETCH_TIMEOUT_MS, resolveTimeoutMs } from '../hardening'

import { headersForRemoteRequest } from './connection-config'

export function requestOptionsWithHeaders(options: any = {}, headers = {}) {
  return {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {})
    }
  }
}

// Assemble a single-file multipart/form-data body (FastAPI `UploadFile`
// endpoints, e.g. kanban attachments). Hand-rolled because node's http has no
// FormData and the payload is one file — a dependency would be overkill.
interface MultipartUpload {
  filename?: string
  contentType?: string
  bytes: Uint8Array
}

function multipartBody(upload: MultipartUpload) {
  const boundary = `----hermes-${crypto.randomBytes(12).toString('hex')}`
  const filename = String(upload.filename || 'file').replace(/["\r\n]/g, '_')

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${upload.contentType || 'application/octet-stream'}\r\n\r\n`
    ),
    Buffer.from(upload.bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ])

  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

interface PreparedJsonRequest {
  parsed: URL
  headers: Record<string, string>
  body?: Buffer | undefined
}

// One JSON round-trip over node:http(s). Retry policy lives in api-transport.ts: idempotent verbs retry on any
// transient transport error; POST/PUT/DELETE only when the request provably never reached the server (see
// shouldRetryRequest) — never double-submit. `prepare` runs once per attempt; a throw rejects that attempt.
function requestJson(url: string, options: any, prepare: () => PreparedJsonRequest) {
  return withRetry(
    (requestState: any) =>
      new Promise((resolve, reject) => {
        let prepared: PreparedJsonRequest

        try {
          prepared = prepare()
        } catch (error) {
          reject(error)

          return
        }

        const { parsed, headers, body } = prepared
        const client = parsed.protocol === 'https:' ? https : http
        const agent = jsonAgentFor(parsed.protocol)
        const timeoutMs = resolveTimeoutMs(options.timeoutMs, DEFAULT_FETCH_TIMEOUT_MS)

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          reject(new Error(`Unsupported Hermes backend URL protocol: ${parsed.protocol}`))

          return
        }

        const req = client.request(
          parsed,
          {
            agent,
            method: options.method || 'GET',
            headers: { ...headers, ...(body ? { 'Content-Length': String(body.length) } : {}) }
          },
          res => {
            const chunks: Buffer[] = []
            res.on('error', reject)
            res.on('data', chunk => chunks.push(chunk))
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8')

              if ((res.statusCode || 500) >= 400) {
                reject(new Error(`${res.statusCode}: ${text || res.statusMessage}`))

                return
              }

              if (!text) {
                resolve(null)

                return
              }

              // A 2xx response whose body is HTML means the request fell through
              // to the SPA index.html (e.g. an unregistered /api path). JSON.parse
              // would throw an opaque `Unexpected token '<'` here, so surface a
              // clear diagnostic with the offending URL instead.
              const looksHtml = /^\s*<(?:!doctype|html)/i.test(text)
              const contentType = String(res.headers['content-type'] || '')

              if (looksHtml || contentType.includes('text/html')) {
                reject(
                  new Error(
                    `Expected JSON from ${url} but got HTML (status ${res.statusCode}). ` +
                      'The endpoint is likely missing on the Hermes backend.'
                  )
                )

                return
              }

              try {
                resolve(JSON.parse(text))
              } catch {
                reject(new Error(`Invalid JSON from ${url} (status ${res.statusCode}): ${text.slice(0, 200)}`))
              }
            })
          }
        )

        req.on('error', reject)
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`Timed out connecting to Hermes backend after ${timeoutMs}ms`))
        })

        // From here the request goes on the wire: a later transport error can no
        // longer prove the server didn't process it, so non-idempotent verbs must
        // not be retried past this point.
        requestState.bodySent = true

        if (body) {
          req.write(body)
        }

        req.end()
      }),
    { method: options.method || 'GET' }
  )
}

export function fetchJson(url: string, token: string | null | undefined, options: any = {}) {
  return requestJson(url, options, () => {
    const { body, contentType } = options.upload
      ? multipartBody(options.upload)
      : {
          body: options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body)),
          contentType: 'application/json'
        }

    return {
      parsed: new URL(url),
      body,
      headers: {
        ...headersForRemoteRequest(url),
        ...(options.headers || {}),
        'Content-Type': contentType,
        'X-Hermes-Session-Token': token,
        // RFC 8252 native flow authenticates the gated gateway with a bearer
        // token instead of the loopback session-token header. When
        // ``options.bearer`` is set we send Authorization: Bearer <token>;
        // the gateway's OAuth gate verifies it via the provider stack with
        // no cookie involved.
        ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {})
      }
    }
  })
}

export function fetchPublicJson(url: string, options: any = {}) {
  // Credential-free JSON GET/POST for public gateway endpoints
  // (``/api/status``, ``/api/auth/providers``). Unlike ``fetchJson`` it sends
  // NO ``X-Hermes-Session-Token`` header — used by the auth-mode probe before
  // any credentials exist, and any time we must not leak a token to an
  // endpoint that doesn't need one.
  return requestJson(url, options, () => {
    let parsed: URL

    try {
      parsed = new URL(url)
    } catch (error) {
      throw new Error(`Invalid URL: ${errorMessage(error)}`)
    }

    const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body))

    return {
      parsed,
      body,
      headers: { ...headersForRemoteRequest(url), ...(options.headers || {}), 'Content-Type': 'application/json' }
    }
  })
}
