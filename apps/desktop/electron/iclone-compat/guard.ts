// Boot/respawn guard (contract decision 11), in order: (1) `/api/health.commit` == runtime HEAD, else the backend is
// stale; (2) sha256 of the runtime's OpenRPC; (3) a verdict cache keyed by (contractHash, lockHash); (4) the probe,
// scheduled by the caller off the boot path. Budget: <= 20 ms on the boot path, so no git process and no verify here.
import { createHash } from 'node:crypto'

import { readRuntimeFile, runtimeHead } from './runtime-git'

export const OPENRPC_PATH = 'apps/shared/src/gateway-contract.openrpc.json'

export interface StaleCard {
  root: 'stale-backend'
  level: 'UNKNOWN'
  items: 1
  names: string[]
  rules: ['STALE-BACKEND']
  upstream: string[]
  ticket: null
  sites: 0
}

export type GuardResult =
  | { status: 'stale-backend'; head: string | null; card: StaleCard }
  | { status: 'no-openrpc'; head: string }
  | { status: 'cached'; head: string; key: string; contractHash: string }
  | { status: 'verify'; head: string; key: string; contractHash: string }

function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = String(a ?? '').toLowerCase()
  const y = String(b ?? '').toLowerCase()

  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x))
}

export function staleBackendCard(healthCommit: string | null, head: string | null): StaleCard | null {
  if (sameCommit(healthCommit, head)) {
    return null
  }

  return {
    root: 'stale-backend',
    level: 'UNKNOWN',
    items: 1,
    names: [
      `backend ${String(healthCommit ?? 'unknown').slice(0, 10)} != runtime ${String(head ?? 'unknown').slice(0, 10)}`
    ],
    rules: ['STALE-BACKEND'],
    upstream: [],
    ticket: null,
    sites: 0
  }
}

export function guard(opts: {
  runtimeDir: string
  healthCommit: string | null
  lockHash: string
  cached: (key: string) => boolean
  openrpcPath?: string
}): GuardResult {
  const head = runtimeHead(opts.runtimeDir)
  const card = staleBackendCard(opts.healthCommit, head)

  if (card || !head) {
    return { status: 'stale-backend', head, card: card ?? (staleBackendCard(null, head) as StaleCard) }
  }

  const openrpc = readRuntimeFile(opts.runtimeDir, opts.openrpcPath ?? OPENRPC_PATH)

  if (openrpc === null) {
    return { status: 'no-openrpc', head }
  }

  const contractHash = createHash('sha256').update(openrpc).digest('hex')
  const key = `${contractHash.slice(0, 16)}-${opts.lockHash.slice(0, 16)}`

  return { status: opts.cached(key) ? 'cached' : 'verify', head, key, contractHash }
}
