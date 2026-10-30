/**
 * V3-J — the LOCAL stub facilitator and the `node:http` wrapper for the resource server, for tests and the gates.
 * The stub speaks the facilitator's v2 shape (`POST /verify`, `POST /settle`, `GET /supported`) on 127.0.0.1 and
 * really verifies the EIP-3009 signature (viem `verifyTypedData` against `authorization.from`), the `to`, the
 * `value` and the window — so a flipped signature byte is `isValid:false` here as it would be at x402.org. Modes
 * make it misbehave on purpose: `invalid`, `settle_fail`, `pending` (`settlement_pending`), `timeout` (never
 * answers `/settle`). Every call is counted: J2 / J3 assert 0 facilitator requests, J7 asserts exactly 1 `/settle`.
 * No key lives here; the stub only ever sees public addresses and signatures.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { verifyTypedData } from 'viem'

import type { X402Server } from './server'
import { authorizationMessage, domainFor, TRANSFER_WITH_AUTHORIZATION_TYPES } from './signer'
import {
  isNetwork,
  isPaymentPayload,
  isPaymentRequirements,
  microsOf,
  type Network,
  normalizeAddress,
  type PaymentPayload,
  type PaymentRequirements
} from './types'

export type StubMode = 'ok' | 'invalid' | 'pending' | 'settle_fail' | 'timeout'

export interface StubFacilitator {
  url: string
  mode: StubMode
  counts: { verify: number; settle: number; supported: number }
  /** The settled payloads, by nonce: what "the chain" would hold. */
  settled: Map<string, { payer: string; micros: number; transaction: string }>
  close: () => Promise<void>
}

const readJson = (request: http.IncomingMessage): Promise<unknown> =>
  new Promise(resolve => {
    let text = ''

    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      text += chunk
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve(null)
      }
    })
  })

const json = (response: http.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function checkAuthorization(payload: PaymentPayload, requirements: PaymentRequirements): Promise<string | null> {
  const auth = payload.payload.authorization

  if (!isNetwork(requirements.network) || payload.accepted.network !== requirements.network) {
    return 'unsupported_network'
  }

  if (normalizeAddress(auth.to) !== normalizeAddress(requirements.payTo)) {
    return 'invalid_exact_evm_payload_recipient_mismatch'
  }

  const value = microsOf(auth.value)

  if (value === null || value < (microsOf(requirements.amount) as number)) {
    return 'invalid_exact_evm_payload_authorization_value'
  }

  const seconds = Math.floor(Date.now() / 1000)

  if (Number(auth.validBefore) < seconds + 6 || Number(auth.validAfter) > seconds) {
    return 'invalid_exact_evm_payload_authorization_valid_before'
  }

  const domain = domainFor(requirements.network as Network, requirements)

  if (!domain) {
    return 'invalid_exact_evm_payload_missing_eip712_domain'
  }

  let valid = false

  try {
    valid = await verifyTypedData({
      address: auth.from as `0x${string}`,
      domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: authorizationMessage(auth),
      signature: payload.payload.signature as `0x${string}`
    })
  } catch {
    valid = false
  }

  return valid ? null : 'invalid_exact_evm_payload_signature'
}

export function startStubFacilitator(mode: StubMode = 'ok'): Promise<StubFacilitator> {
  const stub: StubFacilitator = {
    url: '',
    mode,
    counts: { verify: 0, settle: 0, supported: 0 },
    settled: new Map(),
    close: () => Promise.resolve()
  }

  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/supported') {
      stub.counts.supported += 1
      json(response, 200, {
        kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }],
        extensions: [],
        signers: {}
      })

      return
    }

    if (request.method !== 'POST' || (request.url !== '/verify' && request.url !== '/settle')) {
      json(response, 404, { error: 'not found' })

      return
    }

    const body = (await readJson(request)) as Record<string, unknown> | null
    const payload = body?.paymentPayload
    const requirements = body?.paymentRequirements

    if (body?.x402Version !== 2 || !isPaymentPayload(payload) || !isPaymentRequirements(requirements)) {
      json(response, 400, { error: 'malformed' })

      return
    }

    const reason = stub.mode === 'invalid' ? 'forced_invalid' : await checkAuthorization(payload, requirements)
    const payer = normalizeAddress(payload.payload.authorization.from) as string

    if (request.url === '/verify') {
      stub.counts.verify += 1
      json(response, 200, reason ? { isValid: false, invalidReason: reason } : { isValid: true, payer })

      return
    }

    stub.counts.settle += 1

    if (stub.mode === 'timeout') {
      return
    }

    if (reason) {
      json(response, 200, { success: false, errorReason: reason, transaction: '', network: requirements.network })

      return
    }

    if (stub.mode === 'settle_fail') {
      json(response, 200, {
        success: false,
        errorReason: 'insufficient_funds',
        transaction: '',
        network: requirements.network
      })

      return
    }

    const nonce = payload.payload.authorization.nonce
    const transaction = `0x${nonce.slice(2, 34)}${'f'.repeat(32)}`

    if (stub.mode === 'pending') {
      json(response, 200, {
        success: false,
        errorReason: 'settlement_pending',
        transaction,
        network: requirements.network
      })

      return
    }

    stub.settled.set(nonce, { payer, micros: microsOf(payload.payload.authorization.value) as number, transaction })
    json(response, 200, {
      success: true,
      payer,
      transaction,
      network: requirements.network,
      amount: payload.payload.authorization.value
    })
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      stub.close = () =>
        new Promise(done => {
          server.closeAllConnections()
          server.close(() => done())
        })
      resolve(stub)
    })
  })
}

export interface ResourceHost {
  origin: string
  requests: number
  close: () => Promise<void>
}

/** The x402 server behind `node:http` on 127.0.0.1. `hijack` lets a test answer in the server's place (a redirect, a v1 402). */
export function startResourceHost(
  x402: X402Server,
  hijack?: (request: http.IncomingMessage, response: http.ServerResponse) => boolean
): Promise<ResourceHost> {
  const host: ResourceHost = { origin: '', requests: 0, close: () => Promise.resolve() }

  const server = http.createServer(async (request, response) => {
    host.requests += 1

    if (hijack?.(request, response)) {
      return
    }

    const headers: Record<string, string | undefined> = {}

    for (const [name, value] of Object.entries(request.headers)) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value
    }

    const answer = await x402.handle({ url: `${host.origin}${request.url ?? '/'}`, headers })

    response.writeHead(answer.status, answer.headers)
    response.end(answer.body)
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      host.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      host.close = () =>
        new Promise(done => {
          server.closeAllConnections()
          server.close(() => done())
        })
      resolve(host)
    })
  })
}
