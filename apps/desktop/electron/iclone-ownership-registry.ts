/**
 * iCLONE OS — the contract registry the ownership guard reads (R9 §7).
 *
 * The bundled copy below is the floor: it mirrors iclone/contracts/registry.json
 * (a test pins the two together) and is compiled into the main bundle, so a
 * packaged build can never lose it. An administrator can publish a newer
 * signed copy at `remote.url`; it is read at most once per hour with an ETag
 * and accepted only when its Ed25519 signature verifies against the bundled
 * public key AND its version is >= the bundled one. Anything else — no key,
 * bad signature, older version, malformed JSON, network failure — falls back
 * to the bundled copy. This module never throws.
 */
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'

import { isRecord } from '../src/iclone-shared/guards'

import { writeFileAtomicSync } from './lib/atomic-write'

type TokenStandard = 'erc721' | 'erc1155'

interface AgentStatusSpec {
  /** 4-byte selector of `agentStatus(uint256) returns (uint8)`. */
  selector: string
  /** The value the contract uses for "deactivated". */
  deactivated: number
}

export interface RegistryEntry {
  id: string
  chain: string
  chainId: number
  contract: string
  standard: TokenStandard
  collection: string
  soulSource: string
  explorer: string
  indexer: string | null
  rpcs: string[]
  logWindow: number
  activeFrom: number
  agentStatus: AgentStatusSpec | null
}

export interface ContractRegistry {
  schema: 1
  version: number
  updatedAt: string
  remote: { url: string | null; publicKey: string | null }
  entries: RegistryEntry[]
}

export const BUNDLED_REGISTRY: ContractRegistry = Object.freeze({
  schema: 1,
  version: 1,
  updatedAt: '2026-10-16',
  remote: { url: null, publicKey: null },
  entries: [
    {
      id: 'robinhood-icloneos-i01',
      chain: 'Robinhood',
      chainId: 4663,
      contract: '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631',
      standard: 'erc721',
      collection: 'icloneOS i01 · Studio Experimentals',
      soulSource: 'agent_bootstrap',
      explorer: 'https://robinhoodchain.blockscout.com',
      indexer: 'https://robinhoodchain.blockscout.com/api/v2',
      rpcs: ['https://rpc.mainnet.chain.robinhood.com'],
      logWindow: 50_000,
      activeFrom: 0,
      agentStatus: null
    },
    {
      id: 'base-atlas',
      chain: 'Base',
      chainId: 8453,
      contract: '0x3d9f35e08c41a80155353862f883f2b70119809f',
      standard: 'erc721',
      collection: 'CLONE FRAME · ATLAS',
      soulSource: 'agent_bootstrap',
      explorer: 'https://base.blockscout.com',
      indexer: 'https://base.blockscout.com/api/v2',
      rpcs: [
        'https://mainnet.base.org',
        'https://base-rpc.publicnode.com',
        'https://base.llamarpc.com',
        'https://1rpc.io/base'
      ],
      logWindow: 10_000,
      activeFrom: 0,
      agentStatus: null
    },
    {
      id: 'base-erc8004-identity',
      chain: 'Base',
      chainId: 8453,
      contract: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
      standard: 'erc721',
      collection: 'ERC-8004 AgentIdentity',
      soulSource: 'agent_bootstrap',
      explorer: 'https://base.blockscout.com',
      indexer: 'https://base.blockscout.com/api/v2',
      rpcs: [
        'https://mainnet.base.org',
        'https://base-rpc.publicnode.com',
        'https://base.llamarpc.com',
        'https://1rpc.io/base'
      ],
      logWindow: 10_000,
      activeFrom: 0,
      agentStatus: null
    }
  ]
}) as ContractRegistry

const ADDR = /^0x[0-9a-f]{40}$/
const SELECTOR = /^0x[0-9a-f]{8}$/
const HTTPS = /^https:\/\/[^\s]+$/

function validEntry(v: unknown): RegistryEntry | null {
  if (!isRecord(v)) {
    return null
  }

  const {
    id,
    chain,
    chainId,
    contract,
    standard,
    collection,
    soulSource,
    explorer,
    indexer,
    rpcs,
    logWindow,
    activeFrom
  } = v

  const agentStatus = v.agentStatus

  if (
    typeof id !== 'string' ||
    typeof chain !== 'string' ||
    !Number.isSafeInteger(chainId) ||
    (chainId as number) <= 0 ||
    typeof contract !== 'string' ||
    !ADDR.test(contract) ||
    (standard !== 'erc721' && standard !== 'erc1155') ||
    typeof collection !== 'string' ||
    typeof explorer !== 'string' ||
    !HTTPS.test(explorer) ||
    !(indexer === null || (typeof indexer === 'string' && HTTPS.test(indexer))) ||
    !Array.isArray(rpcs) ||
    rpcs.length === 0 ||
    !rpcs.every(r => typeof r === 'string' && HTTPS.test(r)) ||
    !Number.isSafeInteger(logWindow) ||
    (logWindow as number) < 100 ||
    !Number.isSafeInteger(activeFrom) ||
    (activeFrom as number) < 0
  ) {
    return null
  }

  let status: AgentStatusSpec | null = null

  if (agentStatus !== null && agentStatus !== undefined) {
    if (
      !isRecord(agentStatus) ||
      typeof agentStatus.selector !== 'string' ||
      !SELECTOR.test(agentStatus.selector) ||
      !Number.isSafeInteger(agentStatus.deactivated)
    ) {
      return null
    }

    status = { selector: agentStatus.selector, deactivated: agentStatus.deactivated as number }
  }

  return {
    id,
    chain,
    chainId: chainId as number,
    contract,
    standard,
    collection,
    soulSource: typeof soulSource === 'string' ? soulSource : 'agent_bootstrap',
    explorer,
    indexer: indexer as string | null,
    rpcs: rpcs as string[],
    logWindow: logWindow as number,
    activeFrom: activeFrom as number,
    agentStatus: status
  }
}

/** Schema check of a whole registry; null when anything is off. */
export function validateRegistry(v: unknown): ContractRegistry | null {
  if (!isRecord(v) || v.schema !== 1 || !Number.isSafeInteger(v.version) || !Array.isArray(v.entries)) {
    return null
  }

  const entries = v.entries.map(validEntry)

  if (entries.length === 0 || entries.some(e => e === null)) {
    return null
  }

  const remote = isRecord(v.remote) ? v.remote : {}

  return {
    schema: 1,
    version: v.version as number,
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    remote: {
      url: typeof remote.url === 'string' && HTTPS.test(remote.url) ? remote.url : null,
      publicKey: typeof remote.publicKey === 'string' ? remote.publicKey : null
    },
    entries: entries as RegistryEntry[]
  }
}

/** The entry for one token's contract on one chain — address AND chain. */
export function findEntry(registry: ContractRegistry, chain: string, contract: string): RegistryEntry | null {
  const c = contract.toLowerCase()

  return registry.entries.find(e => e.chain === chain && e.contract === c) ?? null
}

/** Ed25519 over the exact payload bytes; the key is base64 SPKI DER. */
function verifySignedRegistry(payload: string, signatureB64: string, publicKeyB64: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' })

    return crypto.verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signatureB64, 'base64'))
  } catch {
    return false
  }
}

const REMOTE_MIN_INTERVAL_MS = 60 * 60 * 1000

interface RegistrySourceDeps {
  bundled?: ContractRegistry
  fetch: typeof fetch
  now: () => number
  /** Where the last accepted remote copy + ETag are kept. */
  cacheFile: string
}

interface RemoteCache {
  etag: string | null
  payload: string
  signature: string
  checkedAt: number
}

function readCache(file: string): RemoteCache | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))

    if (
      isRecord(v) &&
      typeof v.payload === 'string' &&
      typeof v.signature === 'string' &&
      typeof v.checkedAt === 'number'
    ) {
      return {
        etag: typeof v.etag === 'string' ? v.etag : null,
        payload: v.payload,
        signature: v.signature,
        checkedAt: v.checkedAt
      }
    }
  } catch {
    // absent or corrupt: the bundled copy stands
  }

  return null
}

function writeCache(file: string, cache: RemoteCache): void {
  try {
    writeFileAtomicSync(file, JSON.stringify(cache), { mode: 0o600 })
  } catch {
    // a cache that cannot be written only costs one more fetch next hour
  }
}

/** Accepts a signed copy only when it verifies and is not older than the floor. */
function acceptSigned(bundled: ContractRegistry, payload: string, signature: string): ContractRegistry | null {
  if (!bundled.remote.publicKey || !verifySignedRegistry(payload, signature, bundled.remote.publicKey)) {
    return null
  }

  try {
    const parsed = validateRegistry(JSON.parse(payload))

    return parsed && parsed.version >= bundled.version ? parsed : null
  } catch {
    return null
  }
}

export interface RegistrySource {
  get: () => Promise<ContractRegistry>
  /** What the last read used, for Settings → iNFT. */
  origin: () => 'bundled' | 'remote'
}

export function createRegistrySource(deps: RegistrySourceDeps): RegistrySource {
  const bundled = deps.bundled ?? BUNDLED_REGISTRY
  let current: ContractRegistry = bundled
  let origin: 'bundled' | 'remote' = 'bundled'
  let lastAttempt = Number.NEGATIVE_INFINITY
  let inflight: Promise<ContractRegistry> | null = null

  const cached = readCache(deps.cacheFile)

  if (cached) {
    const ok = acceptSigned(bundled, cached.payload, cached.signature)

    if (ok) {
      current = ok
      origin = 'remote'
    }
  }

  async function refresh(): Promise<ContractRegistry> {
    const url = bundled.remote.url

    if (!url || !bundled.remote.publicKey) {
      return current
    }

    const prior = readCache(deps.cacheFile)

    try {
      const res = await deps.fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: prior?.etag
          ? { 'if-none-match': prior.etag, accept: 'application/json' }
          : { accept: 'application/json' }
      })

      if (res.status === 304) {
        return current
      }

      if (!res.ok) {
        return current
      }

      const body: unknown = await res.json()

      if (!isRecord(body) || typeof body.payload !== 'string' || typeof body.signature !== 'string') {
        return current
      }

      const accepted = acceptSigned(bundled, body.payload, body.signature)

      if (!accepted) {
        return current
      }

      current = accepted
      origin = 'remote'
      writeCache(deps.cacheFile, {
        etag: res.headers.get('etag'),
        payload: body.payload,
        signature: body.signature,
        checkedAt: deps.now()
      })

      return current
    } catch {
      return current
    }
  }

  return {
    origin: () => origin,
    get: () => {
      const now = deps.now()

      if (now - lastAttempt < REMOTE_MIN_INTERVAL_MS) {
        return Promise.resolve(current)
      }

      if (!inflight) {
        lastAttempt = now
        inflight = refresh().finally(() => {
          inflight = null
        })
      }

      return inflight
    }
  }
}
