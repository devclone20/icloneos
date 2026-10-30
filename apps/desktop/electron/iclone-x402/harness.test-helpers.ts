/**
 * V3-J test harness: a whole payments world on 127.0.0.1 with a throwaway profile dir, a fake OS sealer (so no
 * Keychain is touched), a throwaway pocket key minted inside the test, the stub facilitator and the iNFT's resource
 * server. Nothing here reaches the owner's wallet, Privy, AgentCard, `~/.hermes` or any network beyond loopback.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { KeySealer } from '../iclone-permissions/keys'

import { createX402Client, type PaymentAuditEntry, type SpendDoor, type X402Client } from './client'
import { createFacilitator, type Facilitator } from './facilitator'
import { loadAgentKey, loadOwnerMandateKey } from './keys'
import { createLedger, type PaymentLedger } from './ledger'
import { DEFAULTS, type PaymentSettings } from './limits'
import { type Constraint, createMandateStore, type MandateStore } from './mandates'
import { createX402Server, type X402Server } from './server'
import { createPocketSigner, type PaymentSigner } from './signer'
import { isStopped, type PaymentPaths, paymentPaths } from './store'
import { type ResourceHost, startResourceHost, startStubFacilitator, type StubFacilitator, type StubMode } from './stub'

/** Reversible, never the plain text on disk: enough to prove the plain hex is not written and a tampered blob fails. */
export function fakeSealer(): KeySealer {
  return {
    seal: plain => `sealed:${Buffer.from(plain, 'utf8').reverse().toString('base64')}`,
    unseal: sealed => {
      if (!sealed.startsWith('sealed:')) {
        throw new Error('not sealed')
      }

      return Buffer.from(sealed.slice(7), 'base64').reverse().toString('utf8')
    }
  }
}

export function tmpProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v3j-'))
}

/** The iNFT's earn wallet in the lab (the `acp wallet address` seam): a fixed public address, no key anywhere. */
export const EARN_WALLET = '0x1111111111111111111111111111111111111111'
export const OTHER_WALLET = '0x2222222222222222222222222222222222222222'

interface CountingSigner extends PaymentSigner {
  calls: number
}

function countingSigner(inner: PaymentSigner): CountingSigner {
  const signer: CountingSigner = {
    ...inner,
    calls: 0,
    signAuthorization: (auth, domain) => {
      signer.calls += 1

      return inner.signAuthorization(auth, domain)
    }
  }

  return signer
}

export interface World {
  dir: string
  paths: PaymentPaths
  settings: PaymentSettings
  ledger: PaymentLedger
  mandates: MandateStore
  signer: CountingSigner
  facilitator: Facilitator
  server: X402Server
  host: ResourceHost
  stub: StubFacilitator
  client: X402Client
  audit: PaymentAuditEntry[]
  door: { answer: boolean; asked: number }
  /** A resource URL on the host, priced 1.00 USDC unless the test prices otherwise. */
  url: (route?: string) => string
  issue: (agent: string, constraints?: Constraint[], ttlSeconds?: number) => string
  close: () => Promise<void>
}

interface WorldOptions {
  stubMode?: StubMode
  priceMicros?: number
  sealer?: KeySealer | null
  door?: SpendDoor | null | 'none'
  now?: () => Date
  facilitatorTimeoutMs?: number
  doorTimeoutMs?: number
  /** The earn server's `maxTimeoutSeconds` (default 60). */
  maxTimeoutSeconds?: number
  /** Settings on top of the defaults; the payee/origin allowlists default to the earn wallet and the host. */
  settings?: Partial<PaymentSettings>
  allowlist?: boolean
}

export async function makeWorld(options: WorldOptions = {}): Promise<World> {
  const dir = tmpProfile()
  const paths = paymentPaths(dir)
  const sealer = options.sealer === undefined ? fakeSealer() : options.sealer
  const now = options.now ?? (() => new Date())
  const stub = await startStubFacilitator(options.stubMode ?? 'ok')

  const facilitator = createFacilitator({
    urls: { 'eip155:84532': stub.url },
    fetch,
    timeoutMs: options.facilitatorTimeoutMs ?? 2_000
  })

  const ledger = createLedger({ file: paths.ledger, now })
  const earnLedger = createLedger({ file: path.join(dir, 'earn', 'ledger.jsonl'), now })
  const price = options.priceMicros ?? 1_000_000

  const server = createX402Server({
    network: 'eip155:84532',
    payTo: EARN_WALLET,
    facilitator,
    ledger: earnLedger,
    priceOf: url => (new URL(url).pathname.startsWith('/paid') ? price : null),
    serve: async url => ({ body: `paid content of ${new URL(url).pathname}`, mimeType: 'text/plain' }),
    maxTimeoutSeconds: options.maxTimeoutSeconds
  })

  const host = await startResourceHost(server)

  const settings: PaymentSettings = {
    ...DEFAULTS,
    payees: options.allowlist === false ? [] : [EARN_WALLET],
    origins: options.allowlist === false ? [] : [host.origin],
    ...options.settings
  }

  const signer = countingSigner(createPocketSigner(paths.keys, sealer))
  const ownerKey = loadOwnerMandateKey(paths.keys, sealer)

  const mandates = createMandateStore({
    dir: paths.mandates,
    ownerKey,
    agentKey: slug => loadAgentKey(paths.keys, sealer, slug),
    ledger
  })

  const audit: PaymentAuditEntry[] = []
  const door = { answer: true, asked: 0 }

  const spendDoor: SpendDoor | null =
    options.door === 'none'
      ? null
      : (options.door ??
        (async () => {
          door.asked += 1

          return door.answer
        }))

  const client = createX402Client({
    settings: () => settings,
    stopped: () => isStopped(paths),
    ledger,
    mandates,
    signer,
    door: spendDoor,
    audit: { record: entry => audit.push(entry) },
    fetch,
    timeoutMs: 5_000,
    doorTimeoutMs: options.doorTimeoutMs
  })

  const issue = (agent: string, constraints?: Constraint[], ttlSeconds = 3600): string => {
    const result = mandates.issue({
      agent,
      ttlSeconds,
      constraints: constraints ?? [
        { type: 'payment.budget', amount: '100.00', currency: 'USDC' },
        { type: 'payment.amount_range', min: '0.000001', max: '50.00', currency: 'USDC' },
        { type: 'payment.allowed_payees', payees: [EARN_WALLET, OTHER_WALLET] }
      ]
    })

    if (!result.ok) {
      throw new Error(`issue failed: ${result.reason}`)
    }

    return result.record.jti
  }

  return {
    dir,
    paths,
    settings,
    ledger,
    mandates,
    signer,
    facilitator,
    server,
    host,
    stub,
    client,
    audit,
    door,
    url: (route = '/paid/one') => `${host.origin}${route}`,
    issue,
    close: async () => {
      await host.close()
      await stub.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}
