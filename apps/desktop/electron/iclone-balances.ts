import * as https from 'node:https'

import { ipcMain, type IpcMainInvokeEvent } from 'electron'

/**
 * iCLONE OS — multi-chain native-coin balances (main process).
 *
 * Self-contained on purpose, same fork discipline as `electron/iclone-privy.ts`
 * (see its file header): the ONE file this feature owns, no imports from
 * main.ts/preload.ts/iclone-privy.ts, and — by explicit owner spec — zero new
 * npm dependencies AND no `fetch`. Every network call goes through node:https
 * directly (`postJson` below), not the WHATWG fetch iclone-privy.ts uses, so
 * this module has no runtime surface beyond what Electron's Node ships.
 *
 * Reads the native-coin balance of one EVM address across the 6 EVM chains
 * the owner named important, plus SOL for an optional Solana address (Privy's
 * embedded wallet is EVM-only today, so the caller omits `solAddress` until a
 * linked Solana address exists — the SOL row simply isn't in the result).
 * Every chain is read from a small list of PUBLIC, keyless JSON-RPC endpoints
 * with in-order failover per chain (mirrors iclone-privy.ts's `rpcCall`
 * idiom), a 6s timeout per attempt, and `Promise.allSettled` across chains —
 * one dead RPC or one wrong address never fails the other rows.
 *
 * IPC surface (renderer talks to this via `window.hermesDesktop.icloneBalances`
 * — see this feature's integration report for the preload.ts/global.d.ts patch):
 *   invoke 'iclone:balances' (address: string, solAddress?: string)
 *     → IcloneBalancesResult
 */

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

type IcloneChainKey = 'robinhood' | 'solana' | 'bnb' | 'ethereum' | 'base' | 'polygon' | 'arbitrum'

interface ChainBalanceRow {
  key: IcloneChainKey
  chain: string
  symbol: string
  /** Decimal string, e.g. "0.011726". Formatted with BigInt math only — the
   *  raw integer (wei/lamports) never round-trips through a float. */
  balance: string
  ok: boolean
  error?: string
}

interface IcloneBalancesResult {
  ok: boolean
  rows: ChainBalanceRow[]
  fetchedAt: number
}

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const BALANCES_CHANNEL = 'iclone:balances'

const RPC_TIMEOUT_MS = 6_000
// A balance RPC response is a few hundred bytes; anything wildly past that is
// either a misbehaving endpoint or an error page, not a bigger valid answer.
const MAX_RESPONSE_BYTES = 262_144

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/
// Base58, no 0/O/I/l — loose length check only (this module never derives
// keys or signs, so it doesn't need full base58 decode + checksum work to
// stay safe: a malformed address just fails the RPC call cleanly below).
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

interface ChainSpec {
  key: IcloneChainKey
  chain: string
  symbol: string
  decimals: number
  kind: 'evm' | 'solana'
  /** Tried in order; first one that returns a usable result wins. */
  rpcs: string[]
}

// Display order is the owner's spec, verbatim: Robinhood, SOL, BNB, Ethereum,
// Base, Polygon, Arbitrum. Endpoints were live-tested against mainnet during
// this feature's build (see integration report for the latency table) —
// llamarpc.com's eth/base endpoints were dropping with HTTP 521 and
// ankr.com's shared endpoints now require an API key, so neither is listed;
// polygon-rpc.com was answering 401 and is likewise skipped in favor of
// publicnode.com + 1rpc.io, which both answered cleanly.
const CHAINS: ChainSpec[] = [
  {
    key: 'robinhood',
    chain: 'Robinhood Chain',
    symbol: 'ETH',
    decimals: 18,
    kind: 'evm',
    // Chain ID 4663, Arbitrum-Orbit L2 — docs.robinhood.com/chain/connecting.
    rpcs: ['https://rpc.mainnet.chain.robinhood.com']
  },
  {
    key: 'solana',
    chain: 'Solana',
    symbol: 'SOL',
    decimals: 9,
    kind: 'solana',
    rpcs: ['https://api.mainnet-beta.solana.com']
  },
  {
    key: 'bnb',
    chain: 'BNB Smart Chain',
    symbol: 'BNB',
    decimals: 18,
    kind: 'evm',
    rpcs: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com', 'https://1rpc.io/bnb']
  },
  {
    key: 'ethereum',
    chain: 'Ethereum',
    symbol: 'ETH',
    decimals: 18,
    kind: 'evm',
    rpcs: ['https://ethereum.publicnode.com', 'https://eth.merkle.io', 'https://1rpc.io/eth']
  },
  {
    key: 'base',
    chain: 'Base',
    symbol: 'ETH',
    decimals: 18,
    kind: 'evm',
    rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com']
  },
  {
    key: 'polygon',
    chain: 'Polygon PoS',
    // POL is the current native symbol — Polygon's MATIC→POL migration
    // completed network-wide well before this feature was built.
    symbol: 'POL',
    decimals: 18,
    kind: 'evm',
    rpcs: ['https://polygon.publicnode.com', 'https://polygon-bor-rpc.publicnode.com', 'https://1rpc.io/matic']
  },
  {
    key: 'arbitrum',
    chain: 'Arbitrum One',
    symbol: 'ETH',
    decimals: 18,
    kind: 'evm',
    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://1rpc.io/arb']
  }
]

// ─────────────────────────────────────────────────────────────────────────
// node:https JSON POST — the one primitive every RPC call below is built on.
// Never throws: every failure mode (bad url, network error, timeout,
// oversized body, non-2xx, unparsable JSON) resolves `{ ok: false, error }`.
// ─────────────────────────────────────────────────────────────────────────

// A flat, optional-field shape rather than a `{ ok: true; data } | { ok: false;
// error }` discriminated union — deliberately, so every call site narrows
// with a plain `!res.ok || !res.data` truthiness check instead of leaning on
// negated-discriminant control-flow narrowing across an `await` boundary.
interface PostJsonResult<T> {
  ok: boolean
  data?: T
  error?: string
}

function postJson<T>(urlString: string, body: unknown, timeoutMs: number): Promise<PostJsonResult<T>> {
  return new Promise<PostJsonResult<T>>(resolve => {
    let url: URL

    try {
      url = new URL(urlString)
    } catch {
      resolve({ ok: false, error: 'bad rpc url' })

      return
    }

    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    let settled = false

    const finish = (result: PostJsonResult<T>) => {
      if (settled) {
        return
      }

      settled = true
      resolve(result)
    }

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length
        }
      },
      res => {
        const chunks: Buffer[] = []
        let total = 0
        let oversized = false

        res.on('data', (chunk: Buffer) => {
          total += chunk.length

          if (total > MAX_RESPONSE_BYTES) {
            oversized = true
            req.destroy(new Error('response too large'))

            return
          }

          chunks.push(chunk)
        })

        res.on('end', () => {
          if (oversized) {
            return
          }

          const status = res.statusCode ?? 0

          if (status < 200 || status >= 300) {
            finish({ ok: false, error: `http ${status}` })

            return
          }

          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as T

            finish({ ok: true, data: parsed })
          } catch {
            finish({ ok: false, error: 'bad json' })
          }
        })
      }
    )

    req.on('error', err => {
      finish({ ok: false, error: err.message || 'request failed' })
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('rpc timeout'))
    })

    req.write(payload)
    req.end()
  })
}

// ─────────────────────────────────────────────────────────────────────────
// BigInt-exact decimal formatting — the wei/lamports integer is never cast
// through a float. `maxFractionDigits` just truncates the printed string;
// the underlying division is still exact.
// ─────────────────────────────────────────────────────────────────────────

function formatUnits(raw: bigint, decimals: number, maxFractionDigits = 8): string {
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = abs % base

  let fracStr = frac.toString().padStart(decimals, '0')

  if (maxFractionDigits < fracStr.length) {
    fracStr = fracStr.slice(0, maxFractionDigits)
  }

  fracStr = fracStr.replace(/0+$/, '')

  const sign = negative ? '-' : ''

  return fracStr ? `${sign}${whole.toString()}.${fracStr}` : `${sign}${whole.toString()}`
}

function errorRow(spec: ChainSpec, error: string): ChainBalanceRow {
  return { key: spec.key, chain: spec.chain, symbol: spec.symbol, balance: '0', ok: false, error }
}

// ─────────────────────────────────────────────────────────────────────────
// Per-chain reads
// ─────────────────────────────────────────────────────────────────────────

interface EthGetBalanceResponse {
  result?: string
  error?: { message?: string }
}

async function getEvmBalance(spec: ChainSpec, address: string): Promise<ChainBalanceRow> {
  let lastError = 'no rpcs configured'

  for (const url of spec.rpcs) {
    const res = await postJson<EthGetBalanceResponse>(
      url,
      { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] },
      RPC_TIMEOUT_MS
    )

    if (!res.ok || !res.data) {
      lastError = res.error ?? 'rpc failed'

      continue
    }

    if (res.data.error) {
      lastError = res.data.error.message || 'rpc error'

      continue
    }

    if (typeof res.data.result !== 'string') {
      lastError = 'empty rpc result'

      continue
    }

    try {
      const wei = BigInt(res.data.result)

      return {
        key: spec.key,
        chain: spec.chain,
        symbol: spec.symbol,
        balance: formatUnits(wei, spec.decimals),
        ok: true
      }
    } catch {
      lastError = 'unparsable rpc result'
    }
  }

  return errorRow(spec, lastError)
}

interface GetBalanceResponse {
  result?: { value?: number }
  error?: { message?: string }
}

async function getSolanaBalance(spec: ChainSpec, address: string): Promise<ChainBalanceRow> {
  let lastError = 'no rpcs configured'

  for (const url of spec.rpcs) {
    const res = await postJson<GetBalanceResponse>(
      url,
      { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] },
      RPC_TIMEOUT_MS
    )

    if (!res.ok || !res.data) {
      lastError = res.error ?? 'rpc failed'

      continue
    }

    if (res.data.error) {
      lastError = res.data.error.message || 'rpc error'

      continue
    }

    const lamports = res.data.result?.value

    if (typeof lamports !== 'number' || !Number.isFinite(lamports)) {
      lastError = 'empty rpc result'

      continue
    }

    return {
      key: spec.key,
      chain: spec.chain,
      symbol: spec.symbol,
      balance: formatUnits(BigInt(Math.trunc(lamports)), spec.decimals),
      ok: true
    }
  }

  return errorRow(spec, lastError)
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fan out to every chain in `CHAINS` (Solana only when `solAddress` is a
 * plausible base58 address) and resolve once every read has settled — never
 * throws, and one bad RPC never takes the others down with it.
 */
async function fetchIcloneBalances(address: string, solAddress?: string): Promise<IcloneBalancesResult> {
  if (!EVM_ADDR_RE.test(address)) {
    return { ok: false, rows: [], fetchedAt: Date.now() }
  }

  const activeChains = CHAINS.filter(
    spec => spec.kind === 'evm' || (typeof solAddress === 'string' && SOL_ADDR_RE.test(solAddress))
  )

  const settled = await Promise.allSettled(
    activeChains.map(spec =>
      spec.kind === 'evm' ? getEvmBalance(spec, address) : getSolanaBalance(spec, solAddress as string)
    )
  )

  const rows = settled.map((result, i) =>
    result.status === 'fulfilled'
      ? result.value
      : errorRow(activeChains[i], result.reason instanceof Error ? result.reason.message : 'balance read failed')
  )

  return { ok: true, rows, fetchedAt: Date.now() }
}

let initialized = false

/**
 * Call once, at app ready — see this feature's integration report for the
 * exact one-line main.ts patch. Idempotent, matching `initIclonePrivy`.
 */
export function initIcloneBalances(): void {
  if (initialized) {
    return
  }

  initialized = true

  ipcMain.handle(
    BALANCES_CHANNEL,
    (_event: IpcMainInvokeEvent, address: unknown, solAddress?: unknown): Promise<IcloneBalancesResult> => {
      if (typeof address !== 'string') {
        return Promise.resolve({ ok: false, rows: [], fetchedAt: Date.now() })
      }

      return fetchIcloneBalances(address, typeof solAddress === 'string' ? solAddress : undefined)
    }
  )
}
