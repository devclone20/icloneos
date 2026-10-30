/**
 * iCLONE OS — the three deep ownership verifications (R9 §2, §7, §11.3).
 *
 *   1. indexer — Blockscout's view of the token's current holder;
 *   2. chain   — `ownerOf` (ERC-721) / `balanceOf` (ERC-1155) on every RPC of
 *                the registry entry, each RPC first proving its chain id;
 *   3. logs    — the `Transfer` (or `TransferSingle`) event that moved the
 *                token out of the owner's wallet, with its tx hash and block.
 *
 * Golden rule: the verdict is `lost` ONLY when all three agree positively on
 * another holder. Any failure, timeout, disagreement, wrong chain id, burn
 * or missing log is `unknown` — and `unknown` never changes anything.
 */
import type { RegistryEntry } from './iclone-ownership-registry'

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export const TRANSFER_SINGLE_TOPIC = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62'
const OWNER_OF = '0x6352211e'
const BALANCE_OF_1155 = '0x00fdd58e'
const ZERO = '0x0000000000000000000000000000000000000000'
const RPC_TIMEOUT_MS = 8_000
const INDEXER_TIMEOUT_MS = 12_000
const MAX_LOG_WINDOWS = 24

const INDEXER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

type VerificationSource = 'indexer' | 'chain' | 'logs'

export interface Verification {
  source: VerificationSource
  /** The check produced a usable answer. */
  ok: boolean
  /** true = the owner's wallet holds the token per this source. */
  heldByWallet: boolean | null
  /** The holder this source names, when it names one. */
  holder: string | null
  /** Chain head (or the log's block) the answer was observed at. */
  block: number | null
  txHash: string | null
  /** Where the answer came from (URL host) + any reason. */
  detail: string
}

export interface TransferProof {
  txHash: string
  block: number
  from: string
  to: string
  /** Block timestamp, seconds. */
  timestamp: number
  explorerUrl: string
}

type Verdict = 'held' | 'lost' | 'unknown'

export interface ProofResult {
  verdict: Verdict
  verifications: Verification[]
  transfer: TransferProof | null
  head: { number: number; timestamp: number } | null
  /** `agentStatus(tokenId)` when the registry says the contract exposes it. */
  agentStatus: number | null
  reason: string
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const hex = (n: number) => `0x${n.toString(16)}`
const word = (v: bigint) => v.toString(16).padStart(64, '0')
const addrFromTopic = (t: string) => `0x${t.slice(-40)}`.toLowerCase()

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return 'invalid-url'
  }
}

function tokenWord(tokenId: string): string | null {
  try {
    const v = BigInt(tokenId)

    return v >= 0n ? word(v) : null
  } catch {
    return null
  }
}

/** JSON-RPC over the entry's RPCs. Each URL proves `eth_chainId` first; a URL
 *  on the wrong chain is never asked anything else. */
function createChainClient(entry: RegistryEntry, fetchImpl: FetchLike) {
  const verified = new Map<string, boolean>()

  async function raw(url: string, method: string, params: unknown[]): Promise<unknown> {
    const res = await fetchImpl(url, {
      method: 'POST',
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })

    if (!res.ok) {
      throw new Error(`http ${res.status}`)
    }

    const body = (await res.json()) as { result?: unknown; error?: { message?: string } }

    if (body.error || body.result === undefined || body.result === null) {
      throw new Error(body.error?.message || 'empty result')
    }

    return body.result
  }

  async function onChain(url: string): Promise<boolean> {
    const known = verified.get(url)

    if (known !== undefined) {
      return known
    }

    try {
      const id = await raw(url, 'eth_chainId', [])
      const ok = typeof id === 'string' && Number.parseInt(id, 16) === entry.chainId
      verified.set(url, ok)

      return ok
    } catch {
      return false
    }
  }

  /** Every RPC that answers, each on the right chain. */
  async function all(method: string, params: unknown[]): Promise<{ url: string; result: unknown }[]> {
    const out: { url: string; result: unknown }[] = []

    for (const url of entry.rpcs) {
      if (!(await onChain(url))) {
        continue
      }

      try {
        out.push({ url, result: await raw(url, method, params) })
      } catch {
        // one RPC down is not an answer; the next one may be
      }
    }

    return out
  }

  /** The first RPC that answers, on the right chain. */
  async function first(method: string, params: unknown[]): Promise<{ url: string; result: unknown } | null> {
    for (const url of entry.rpcs) {
      if (!(await onChain(url))) {
        continue
      }

      try {
        return { url, result: await raw(url, method, params) }
      } catch {
        // failover
      }
    }

    return null
  }

  async function head(): Promise<{ number: number; timestamp: number } | null> {
    const r = await first('eth_getBlockByNumber', ['latest', false])
    const b = r?.result as { number?: string; timestamp?: string } | undefined

    if (!b || typeof b.number !== 'string' || typeof b.timestamp !== 'string') {
      return null
    }

    return { number: Number.parseInt(b.number, 16), timestamp: Number.parseInt(b.timestamp, 16) }
  }

  async function blockTime(block: number): Promise<number | null> {
    const r = await first('eth_getBlockByNumber', [hex(block), false])
    const b = r?.result as { timestamp?: string } | undefined

    return b && typeof b.timestamp === 'string' ? Number.parseInt(b.timestamp, 16) : null
  }

  return { all, first, head, blockTime }
}

type ChainClient = ReturnType<typeof createChainClient>

async function checkIndexer(entry: RegistryEntry, tokenId: string, wallet: string, fetchImpl: FetchLike) {
  const base: Verification = {
    source: 'indexer',
    ok: false,
    heldByWallet: null,
    holder: null,
    block: null,
    txHash: null,
    detail: ''
  }

  if (!entry.indexer) {
    return { ...base, detail: 'no indexer for this chain' }
  }

  const url =
    entry.standard === 'erc721'
      ? `${entry.indexer}/tokens/${entry.contract}/instances/${encodeURIComponent(tokenId)}`
      : `${entry.indexer}/addresses/${wallet}/nft?type=ERC-1155`

  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': INDEXER_UA, referer: `${new URL(entry.indexer).origin}/` }
    })

    if (!res.ok) {
      return { ...base, detail: `${hostOf(url)} http ${res.status}` }
    }

    const body = (await res.json()) as Record<string, unknown>

    if (entry.standard === 'erc721') {
      const owner = (body.owner as { hash?: unknown } | null | undefined)?.hash

      if (typeof owner !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
        return { ...base, detail: `${hostOf(url)} no owner field` }
      }

      const holder = owner.toLowerCase()

      return { ...base, ok: true, holder, heldByWallet: holder === wallet, detail: hostOf(url) }
    }

    // ERC-1155: the wallet's own list either carries the token or it does not.
    // A capped page (next_page_params) without it proves nothing.
    const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : null

    if (!items) {
      return { ...base, detail: `${hostOf(url)} no items` }
    }

    const has = items.some(
      it =>
        String(it.id) === tokenId &&
        String((it.token as { address_hash?: string } | undefined)?.address_hash ?? '').toLowerCase() === entry.contract
    )

    if (!has && body.next_page_params) {
      return { ...base, detail: `${hostOf(url)} partial page` }
    }

    return { ...base, ok: true, heldByWallet: has, detail: hostOf(url) }
  } catch (e) {
    return {
      ...base,
      detail: `${hostOf(url)} ${e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'failed'}`
    }
  }
}

async function checkChain(
  entry: RegistryEntry,
  tokenId: string,
  wallet: string,
  client: ChainClient,
  headBlock: number | null
): Promise<Verification> {
  const base: Verification = {
    source: 'chain',
    ok: false,
    heldByWallet: null,
    holder: null,
    block: headBlock,
    txHash: null,
    detail: ''
  }

  const id = tokenWord(tokenId)

  if (!id) {
    return { ...base, detail: 'bad token id' }
  }

  const data =
    entry.standard === 'erc721' ? `${OWNER_OF}${id}` : `${BALANCE_OF_1155}${'0'.repeat(24)}${wallet.slice(2)}${id}`

  const answers = await entry_call(client, entry.contract, data)

  if (answers.length === 0) {
    return { ...base, detail: 'no rpc answered on the right chain' }
  }

  const values = new Set(answers.map(a => a.value))

  if (values.size > 1) {
    return { ...base, detail: `rpcs disagree (${answers.map(a => hostOf(a.url)).join(', ')})` }
  }

  const value = answers[0].value
  const hosts = answers.map(a => hostOf(a.url)).join(', ')

  if (entry.standard === 'erc721') {
    const holder = `0x${value.slice(-40)}`.toLowerCase()

    if (value.length < 66 || holder === ZERO) {
      return { ...base, detail: `${hosts} no holder` }
    }

    return { ...base, ok: true, holder, heldByWallet: holder === wallet, detail: hosts }
  }

  const balance = BigInt(`0x${value.slice(2) || '0'}`)

  return { ...base, ok: true, heldByWallet: balance > 0n, detail: hosts }
}

async function entry_call(client: ChainClient, to: string, data: string) {
  const answers = await client.all('eth_call', [{ to, data }, 'latest'])

  return answers
    .filter((a): a is { url: string; result: string } => typeof a.result === 'string' && a.result.length > 2)
    .map(a => ({ url: a.url, value: a.result.toLowerCase() }))
}

interface RawLog {
  topics?: string[]
  data?: string
  blockNumber?: string
  transactionHash?: string
  logIndex?: string
}

interface Move {
  from: string
  to: string
  block: number
  index: number
  tx: string
}

interface TransferHints {
  /** Block of the token's newest transfer. */
  last: number | null
  /** Block of the newest transfer OUT of the wallet. */
  out: number | null
}

/**
 * The Transfer-log verification. It names the CURRENT holder (the token's
 * newest move) and, separately, the wallet's own OUT transfer after the last
 * block the token was proven held — the two differ after a resale (A→B→C).
 */
async function findTransferOut(
  entry: RegistryEntry,
  tokenId: string,
  wallet: string,
  client: ChainClient,
  head: { number: number },
  sinceBlock: number | null,
  hints: () => Promise<TransferHints> = () => Promise.resolve({ last: null, out: null })
): Promise<{ verification: Verification; log: { from: string; to: string; block: number; tx: string } | null }> {
  const base: Verification = {
    source: 'logs',
    ok: false,
    heldByWallet: null,
    holder: null,
    block: null,
    txHash: null,
    detail: ''
  }

  const id = tokenWord(tokenId)

  if (!id) {
    return { verification: { ...base, detail: 'bad token id' }, log: null }
  }

  const floor = Math.max(entry.activeFrom, sinceBlock ?? 0)

  const topics =
    entry.standard === 'erc721' ? [TRANSFER_TOPIC, null, null, `0x${id}`] : [TRANSFER_SINGLE_TOPIC, null, null, null]

  let host = ''

  const scanRange = async (from: number, to: number): Promise<Move[] | 'failed'> => {
    const r = await client.first('eth_getLogs', [
      { address: entry.contract, fromBlock: hex(from), toBlock: hex(to), topics }
    ])

    if (!r || !Array.isArray(r.result)) {
      return 'failed'
    }

    host = hostOf(r.url)

    return (r.result as RawLog[])
      .filter(l => Array.isArray(l.topics) && l.topics.length >= 3 && l.blockNumber && l.transactionHash)
      .filter(l => entry.standard === 'erc721' || (l.data ?? '').slice(2, 66).toLowerCase() === id)
      .map(l => {
        const t = l.topics as string[]
        // TransferSingle(operator, from, to, id, value): from/to shift by one.
        const shift = entry.standard === 'erc721' ? 0 : 1

        return {
          from: addrFromTopic(t[1 + shift]),
          to: addrFromTopic(t[2 + shift]),
          block: Number.parseInt(l.blockNumber as string, 16),
          index: Number.parseInt(l.logIndex ?? '0x0', 16),
          tx: (l.transactionHash as string).toLowerCase()
        }
      })
      .filter(m => Number.isSafeInteger(m.block) && m.block >= from && m.block <= to)
      .sort((a, b) => a.block - b.block || a.index - b.index)
  }

  const outOf = (moves: Move[]) => [...moves].reverse().find(m => m.from === wallet && m.to !== wallet) ?? null
  const failed = (at: string) => ({ verification: { ...base, detail: `getLogs failed at ${at}` }, log: null })

  let holderMove: Move | null = null
  let outMove: Move | null = null

  // Newest window first: the newest move names the holder; keep going (down
  // to the last held block) until the wallet's own transfer out is found.
  let to = head.number

  for (let i = 0; i < MAX_LOG_WINDOWS && to >= floor && !outMove; i++) {
    const from = Math.max(floor, to - entry.logWindow + 1)
    const moves = await scanRange(from, to)

    if (moves === 'failed') {
      return failed(`${from}-${to}`)
    }

    if (moves.length > 0) {
      holderMove ??= moves[moves.length - 1]
      outMove = outOf(moves)

      // The newest move INTO the wallet ends the search: an older "out" was undone.
      if (!outMove && moves.some(m => m.to === wallet)) {
        break
      }
    }

    to = from - 1
  }

  // Older than the scanned windows: the indexer names the blocks and the chain
  // itself confirms each block's log. An indexer that lags can only make the
  // holders disagree (unknown), never forge a loss.
  if ((!holderMove || !outMove) && to >= floor) {
    const hint = await hints()

    for (const want of ['holder', 'out'] as const) {
      const block = want === 'holder' ? (holderMove ? null : hint.last) : outMove ? null : hint.out

      if (block === null || block < floor || block > to) {
        continue
      }

      const moves = await scanRange(block, block)

      if (moves === 'failed') {
        return failed(String(block))
      }

      if (want === 'holder' && moves.length > 0) {
        holderMove = moves[moves.length - 1]
      } else if (want === 'out') {
        outMove = outOf(moves)
      }
    }
  }

  // Every block since the last proven-held block was scanned and none moved
  // the token: the logs agree the wallet still holds it. This can only ever
  // say "held" — a loss always needs a real Transfer out of the wallet.
  if (!holderMove && sinceBlock !== null && to < floor) {
    return {
      verification: {
        ...base,
        ok: true,
        holder: wallet,
        heldByWallet: true,
        block: head.number,
        detail: `no Transfer since block ${floor}, held then${host ? ` (${host})` : ''}`
      },
      log: null
    }
  }

  if (!holderMove) {
    return {
      verification: { ...base, detail: `no Transfer found since block ${floor}${host ? ` (${host})` : ''}` },
      log: null
    }
  }

  // An out move only counts when nothing newer brought the token back.
  const log = outMove && holderMove.to !== wallet ? outMove : null

  return {
    verification: {
      ...base,
      ok: true,
      holder: holderMove.to,
      heldByWallet: holderMove.to === wallet,
      block: holderMove.block,
      txHash: log?.tx ?? holderMove.tx,
      detail: log && log.tx !== holderMove.tx ? `${host}; out of the wallet at block ${log.block}` : host
    },
    log
  }
}

/** Blockscout's transfers for the token — HINTS the chain must confirm. */
async function transferHints(
  entry: RegistryEntry,
  tokenId: string,
  wallet: string,
  fetchImpl: FetchLike
): Promise<TransferHints> {
  const none: TransferHints = { last: null, out: null }

  if (!entry.indexer || entry.standard !== 'erc721') {
    return none
  }

  try {
    const res = await fetchImpl(
      `${entry.indexer}/tokens/${entry.contract}/instances/${encodeURIComponent(tokenId)}/transfers`,
      {
        signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
        headers: { accept: 'application/json', 'user-agent': INDEXER_UA, referer: `${new URL(entry.indexer).origin}/` }
      }
    )

    if (!res.ok) {
      return none
    }

    const body = (await res.json()) as { items?: { block_number?: unknown; from?: { hash?: unknown } }[] }
    const items = Array.isArray(body.items) ? body.items : []

    const block = (v: unknown) => {
      const n = Number(v)

      return Number.isSafeInteger(n) && n >= 0 ? n : null
    }

    const out = items.find(i => typeof i.from?.hash === 'string' && i.from.hash.toLowerCase() === wallet)

    return { last: block(items[0]?.block_number), out: out ? block(out.block_number) : null }
  } catch {
    return none
  }
}

/** The pure decision over the three checks. */
export function decide(verifications: Verification[], hasOutLog: boolean): { verdict: Verdict; reason: string } {
  const by = (s: VerificationSource) => verifications.find(v => v.source === s)
  const chain = by('chain')
  const indexer = by('indexer')
  const logs = by('logs')

  if (!chain?.ok) {
    return { verdict: 'unknown', reason: `chain: ${chain?.detail || 'missing'}` }
  }

  if (chain.heldByWallet) {
    return { verdict: 'held', reason: 'ownerOf names the wallet' }
  }

  if (!indexer?.ok) {
    return { verdict: 'unknown', reason: `indexer: ${indexer?.detail || 'missing'}` }
  }

  if (!logs?.ok || !hasOutLog) {
    return { verdict: 'unknown', reason: `logs: ${logs?.detail || 'no transfer out of the wallet'}` }
  }

  if (indexer.heldByWallet !== false || logs.heldByWallet !== false) {
    return { verdict: 'unknown', reason: 'sources disagree' }
  }

  // ERC-721: all three must name the SAME other holder.
  if (chain.holder !== null && (indexer.holder !== chain.holder || logs.holder !== chain.holder)) {
    return { verdict: 'unknown', reason: 'holders disagree' }
  }

  return { verdict: 'lost', reason: 'indexer, ownerOf and Transfer logs agree' }
}

interface VerifyInput {
  entry: RegistryEntry
  tokenId: string
  wallet: string
  /** Last block the token was proven held — the log scan starts there. */
  sinceBlock: number | null
  fetch: FetchLike
}

export async function verifyOwnership(input: VerifyInput): Promise<ProofResult> {
  const wallet = input.wallet.toLowerCase()
  const client = createChainClient(input.entry, input.fetch)

  const empty = (reason: string): ProofResult => ({
    verdict: 'unknown',
    verifications: [],
    transfer: null,
    head: null,
    agentStatus: null,
    reason
  })

  try {
    const head = await client.head()

    if (!head) {
      return empty('no rpc answered on the right chain')
    }

    const [indexer, chain] = await Promise.all([
      checkIndexer(input.entry, input.tokenId, wallet, input.fetch),
      checkChain(input.entry, input.tokenId, wallet, client, head.number)
    ])

    indexer.block = head.number

    const logs = await findTransferOut(input.entry, input.tokenId, wallet, client, head, input.sinceBlock, () =>
      transferHints(input.entry, input.tokenId, wallet, input.fetch)
    )

    const verifications = [indexer, chain, logs.verification]
    const { verdict, reason } = decide(verifications, logs.log !== null)

    let transfer: TransferProof | null = null

    if (verdict === 'lost' && logs.log) {
      const ts = await client.blockTime(logs.log.block)

      if (ts === null) {
        return { ...empty('transfer block time unavailable'), verifications, head }
      }

      transfer = {
        txHash: logs.log.tx,
        block: logs.log.block,
        from: logs.log.from,
        to: logs.log.to,
        timestamp: ts,
        explorerUrl: `${input.entry.explorer}/tx/${logs.log.tx}`
      }
    }

    let agentStatus: number | null = null
    const spec = input.entry.agentStatus
    const id = tokenWord(input.tokenId)

    if (spec && id) {
      const r = await client.first('eth_call', [{ to: input.entry.contract, data: `${spec.selector}${id}` }, 'latest'])

      if (r && typeof r.result === 'string' && r.result.length > 2) {
        agentStatus = Number(BigInt(r.result))
      }
    }

    return { verdict, verifications, transfer, head, agentStatus, reason }
  } catch (e) {
    return empty(e instanceof Error ? e.message : 'verification failed')
  }
}
