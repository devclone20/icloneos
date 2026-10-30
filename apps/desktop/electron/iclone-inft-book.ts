import { ipcMain } from 'electron'

import { guardedHandler } from './iclone-consent'
import type { IpcSenderEventLike } from './ipc-sender-guard'

/**
 * iCLONE OS — the iNFT Book's paged wallet scan (main process).
 *
 * The Blockscout indexer answers a wallet's NFTs 50 at a time and hands back
 * `next_page_params` for the next page. This module owns the paging rules —
 * per-page retries with backoff, the 5 000-item ceiling, the cursor the
 * renderer may send back — and nothing about what an item is: the page reader
 * is injected (electron/iclone-privy.ts `readIndexerPage`, wired in main.ts),
 * so this file imports nothing from the wallet module and no cycle exists.
 *
 * Two consumers:
 *  - `collectPages` — the Home roster scan (`iclone:inft-scan`) follows the
 *    pages to exhaustion in one call (it replaced the old 60-item first-page cap).
 *  - `iclone:inft-book-scan` — the Book reads ONE page per call, cursor in,
 *    cursor out, so its first 50 cards paint before the last page is asked for,
 *    a failed page k keeps pages < k (the renderer retries from the same
 *    cursor), and a sign-out simply stops the renderer asking. Main keeps no
 *    scan state between calls.
 *
 * The cursor comes back from the renderer, so it is re-validated on every call
 * (`parseBookCursor`): a known chain name and a flat record of scalars whose
 * keys are Blockscout's own NFT cursor keys (an allow-list, so a forged cursor
 * cannot carry `type` and widen the indexer's token filter), which
 * `readIndexerPage` sets through URLSearchParams — never a string spliced into
 * a URL.
 *
 * The Home roster (`createHomeScanner`) is the other consumer, and the costly
 * one: it runs in the background for as long as the owner is signed in. So a
 * FULL paged scan runs only on sign-in and on the Book's Rescan; the 3-minute
 * refresh reads page 1 per chain (new arrivals) and proves the checked set with
 * batched `ownerOf` calls — 1 + ceil(checked / HOME_OWNER_BATCH) requests per
 * chain, never the whole wallet again. One scan at a time: a refresh while a
 * scan runs is skipped, and sign-out or a wallet switch aborts the running one
 * (its AbortSignal reaches every indexer and RPC request).
 *
 * Indexer limits (Blockscout REST API v2, called keyless):
 *  - Rate limit, documented default: 300 requests per minute per IP for calls
 *    without an API key (`API_RATE_LIMIT_BY_IP=300` per `1m`; "older instances
 *    used 3 requests per minute") —
 *    https://docs.blockscout.com/devs/apis/requests-and-limits (read 2026-10-21).
 *    The value the HOSTED instances we call (base.blockscout.com,
 *    robinhoodchain.blockscout.com) actually configure is NOT published there,
 *    and could not be verified: a scripted probe from the build machine got a
 *    Cloudflare 403. Treat 300/min as an upper bound, not a promise.
 *  - Page size: `/addresses/{hash}/nft` answers 50 items per page plus
 *    `next_page_params` (observed in the responses this module was built
 *    against; the docs page above does not state it). So the 5 000 ceiling is
 *    ≈ 100 requests per chain — one full scan stays inside a minute's budget,
 *    which is exactly why it must not repeat every 3 minutes.
 */

/** O5: the most items one wallet scan will read (≈ 100 indexer pages). */
export const BOOK_SCAN_CEILING = 5_000

/** Items per indexer page (observed, see above). */
const INDEXER_PAGE_SIZE = 50
/** Pages allowed past `ceiling / INDEXER_PAGE_SIZE` for short or filtered pages before a scan calls the indexer broken. */
const PAGE_SLACK = 10

/**
 * K65: the most pages one wallet scan (one chain) will ask for. The ceiling
 * counts ITEMS, so an indexer that keeps answering empty or filtered pages with
 * a fresh `next_page_params` would otherwise be followed forever.
 */
export function maxPagesFor(ceiling: number): number {
  return Math.ceil(ceiling / INDEXER_PAGE_SIZE) + PAGE_SLACK
}

/** Two cursors name the same page: same keys, same values (cursors are flat records of scalars). */
function samePageParams(a: IndexerPageParams | null, b: IndexerPageParams | null): boolean {
  if (a === null || b === null) {
    return a === b
  }

  const keys = Object.keys(a)

  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && a[key] === b[key])
}

const BOOK_SCAN_CHANNEL = 'iclone:inft-book-scan'
const BOOK_POLICY: RetryPolicy = { retries: 3, backoffMs: [500, 1_500, 4_000] }
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** Blockscout's `next_page_params` keys for the address NFT list — the only keys a cursor may carry. */
const PARAM_KEYS: ReadonlySet<string> = new Set([
  'fiat_value',
  'id',
  'items_count',
  'token_contract_address_hash',
  'token_id',
  'token_type',
  'value'
])

const PARAM_MAX_KEYS = PARAM_KEYS.size
const PARAM_MAX_CHARS = 120

export type IndexerPageParams = Readonly<Record<string, number | string | null>>

export interface PageRead<T> {
  items: T[]
  next: IndexerPageParams | null
  /** K23: the items are good but the indexer's next cursor is unreadable (an unknown key): keep them, stop there. */
  cursorBroken?: boolean
}

/** One page from one chain's indexer; null = the request failed (or was aborted). */
type ChainPageReader<T> = (
  chain: string,
  address: string,
  params: IndexerPageParams | null,
  signal?: AbortSignal
) => Promise<null | PageRead<T>>

interface RetryPolicy {
  retries: number
  /** Wait before retry n (the last entry repeats). */
  backoffMs: readonly number[]
  sleep?: (ms: number) => Promise<void>
  /** Stops the retries and the paging: an aborted scan reads no further page. */
  signal?: AbortSignal
}

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export async function readPageWithRetry<T>(
  read: (params: IndexerPageParams | null) => Promise<null | PageRead<T>>,
  params: IndexerPageParams | null,
  policy: RetryPolicy
): Promise<null | PageRead<T>> {
  const sleep = policy.sleep ?? realSleep

  for (let attempt = 0; attempt <= policy.retries; attempt++) {
    if (attempt > 0) {
      await sleep(policy.backoffMs[Math.min(attempt - 1, policy.backoffMs.length - 1)] ?? 0)
    }

    if (policy.signal?.aborted) {
      return null
    }

    const page = await read(params).catch(() => null)

    if (page) {
      return page
    }
  }

  return null
}

interface CollectedPages<T> {
  items: T[]
  /** Pages read successfully; 0 means the very first page failed. */
  pages: number
  /** Every page was read (not stopped by a failure, the ceiling, the page cap or a repeated cursor). */
  complete: boolean
  /** Stopped by the ceiling, every page before it read: the most the app will ever read of this wallet. */
  capped: boolean
}

/**
 * Follows `next` to exhaustion, stopping at `ceiling` items, the first page that
 * fails for good, `maxPages` pages (default `maxPagesFor(ceiling)`), or a page
 * whose `next` names the page just read. The last two are an indexer that never
 * ends: the scan keeps what it read and says it is not complete.
 */
export async function collectPages<T>(
  read: (params: IndexerPageParams | null) => Promise<null | PageRead<T>>,
  options: RetryPolicy & { ceiling: number; maxPages?: number }
): Promise<CollectedPages<T>> {
  const items: T[] = []
  const maxPages = options.maxPages ?? maxPagesFor(options.ceiling)
  let params: IndexerPageParams | null = null
  let pages = 0

  for (;;) {
    if (options.signal?.aborted || pages >= maxPages) {
      return { items, pages, complete: false, capped: false }
    }

    const page: null | PageRead<T> = await readPageWithRetry(read, params, options)

    if (!page) {
      return { items, pages, complete: false, capped: false }
    }

    pages += 1

    const taken = page.items.slice(0, options.ceiling - items.length)

    items.push(...taken)

    if (taken.length < page.items.length) {
      return { items, pages, complete: false, capped: true }
    }

    if (page.cursorBroken) {
      return { items, pages, complete: false, capped: false }
    }

    if (!page.next) {
      return { items, pages, complete: true, capped: false }
    }

    if (items.length >= options.ceiling) {
      return { items, pages, complete: false, capped: true }
    }

    if (samePageParams(page.next, params)) {
      return { items, pages, complete: false, capped: false }
    }

    params = page.next
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The indexer's `next_page_params` (or a cursor's echo of it): a flat record of scalars under allow-listed keys, else null. */
export function parsePageParams(raw: unknown): IndexerPageParams | null {
  if (!isPlainRecord(raw)) {
    return null
  }

  const entries = Object.entries(raw)

  if (entries.length === 0 || entries.length > PARAM_MAX_KEYS) {
    return null
  }

  const out: Record<string, number | string | null> = {}

  for (const [key, value] of entries) {
    if (!PARAM_KEYS.has(key)) {
      return null
    }

    if (value === null || (typeof value === 'number' && Number.isFinite(value))) {
      out[key] = value
    } else if (typeof value === 'string' && value.length <= PARAM_MAX_CHARS) {
      out[key] = value
    } else {
      return null
    }
  }

  return out
}

/**
 * What an indexer page says about the next one: null = this was the last page;
 * undefined = it names a next page this module cannot follow (an unknown key —
 * the API changed). The reader treats undefined as a FAILED page, so a scan
 * says it stopped early instead of passing a truncated wallet off as complete.
 */
export function nextPageParams(raw: unknown): IndexerPageParams | null | undefined {
  if (raw === null || raw === undefined) {
    return null
  }

  return parsePageParams(raw) ?? undefined
}

interface BookCursor {
  chain: string
  params: IndexerPageParams | null
}

interface BookPage<T> {
  ok: boolean
  items: T[]
  /** Where the next call starts; on failure, the cursor to retry. Null once done. */
  cursor: BookCursor | null
  done: boolean
  error?: string
}

export function parseBookCursor(raw: unknown, chains: readonly string[]): BookCursor | null {
  if (!isPlainRecord(raw) || typeof raw.chain !== 'string' || !chains.includes(raw.chain)) {
    return null
  }

  if (raw.params === null || raw.params === undefined) {
    return { chain: raw.chain, params: null }
  }

  const params = parsePageParams(raw.params)

  return params ? { chain: raw.chain, params } : null
}

export async function readBookPage<T>(
  read: ChainPageReader<T>,
  chains: readonly string[],
  address: string,
  cursor: BookCursor | null,
  policy: RetryPolicy = BOOK_POLICY
): Promise<BookPage<T>> {
  const at = cursor ?? (chains[0] ? { chain: chains[0], params: null } : null)

  if (!at) {
    return { ok: true, items: [], cursor: null, done: true }
  }

  const page = await readPageWithRetry(params => read(at.chain, address, params), at.params, policy)

  if (!page) {
    return { ok: false, items: [], cursor: at, done: false, error: 'page failed' }
  }

  // K23: the same for a next cursor the indexer spelled with a key we do not know: this page's items stand.
  if (page.cursorBroken) {
    return { ok: false, items: page.items, cursor: at, done: false, error: 'cursor unreadable' }
  }

  // K65: a next page that is this page again would be asked for forever — the
  // renderer keeps this page's items and stops with a retry, never a loop.
  if (page.next && samePageParams(page.next, at.params)) {
    return { ok: false, items: page.items, cursor: at, done: false, error: 'cursor repeated' }
  }

  const nextChain = chains[chains.indexOf(at.chain) + 1]

  const next: BookCursor | null = page.next
    ? { chain: at.chain, params: page.next }
    : nextChain
      ? { chain: nextChain, params: null }
      : null

  return { ok: true, items: page.items, cursor: next, done: next === null }
}

/** The P7 seam (createAppSenderGuard in main.ts): which IPC senders are the app's own renderer. */
export type ScanSenderGuard = (event: IpcSenderEventLike, channel: string) => boolean

interface InitInftBookOptions<T> {
  readPage: ChainPageReader<T>
  chains: readonly string[]
  /** Required: the scan spends the indexer budget for any address it is given. */
  isTrustedSender: ScanSenderGuard
}

export function initInftBook<T>({ chains, readPage, isTrustedSender }: InitInftBookOptions<T>): void {
  // A sender the guard refuses (a <webview> guest, a subframe, the Privy window) gets null. No guard = refuse.
  guardedHandler(ipcMain, isTrustedSender ?? (() => false)).handle(
    BOOK_SCAN_CHANNEL,
    (_event: unknown, address: unknown, cursor: unknown): Promise<BookPage<T>> => {
      if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
        return Promise.resolve({ ok: false, items: [], cursor: null, done: true, error: 'bad address' })
      }

      const parsed = cursor === null || cursor === undefined ? null : parseBookCursor(cursor, chains)

      if (cursor !== null && cursor !== undefined && !parsed) {
        return Promise.resolve({ ok: false, items: [], cursor: null, done: true, error: 'bad cursor' })
      }

      return readBookPage(readPage, chains, address.toLowerCase(), parsed)
    }
  )
}

// ── the Home roster scan (iclone:inft-scan + iclone:inft-scan-tick) ──────────

/** ownerOf calls per JSON-RPC batch request. */
export const HOME_OWNER_BATCH = 20
/**
 * Batch requests in flight at once, across chains. A tick also reads page 1 of
 * each chain beside them, so the requests in flight total up to
 * HOME_OWNER_CONCURRENCY + chains (2 page reads + 4 batches = 6 today). A batch
 * whose RPC fails over to the next one is still one job of this limiter: the
 * failover POSTs run one after another, never beside it, so they add requests
 * per tick but never in-flight width.
 */
export const HOME_OWNER_CONCURRENCY = 4
/** The most checked iNFTs one refresh proves; a larger set is proven in turns, tick after tick. */
export const HOME_VERIFY_PER_TICK = 200

const HOME_IDS_MAX = BOOK_SCAN_CEILING
const CONTRACT_RE = /^0x[0-9a-f]{40}$/
const TOKEN_ID_RE = /^\d{1,78}$/
// K88: 78 digits still reach past 2^256 - 1; such an id would encode into a calldata word longer than 32 bytes.
const UINT256_MAX = (1n << 256n) - 1n
const OWNER_OF_SELECTOR = '0x6352211e'
const ZERO_OWNER = '0'.repeat(40)
// An ABI-encoded address: 12 zero bytes, then the 20-byte owner. Anything else is not an ownerOf answer.
// K21: the `0x` prefix is lowercase as JSON-RPC writes it ("0X…" is not an answer); hex digits in either case.
const OWNER_WORD_RE = /^0x0{24}([0-9a-fA-F]{40})$/

export interface EthCall {
  to: string
  data: string
}

/** One JSON-RPC batch of eth_calls on one chain: results aligned with `calls` (null = no answer), or null if no RPC answered. */
type EthCallBatch = (chain: string, calls: readonly EthCall[], signal: AbortSignal) => Promise<(null | string)[] | null>

/** held = ownerOf names this wallet; gone = it names another; unknown = no proof either way (kept). */
type OwnerVerdict = 'gone' | 'held' | 'unknown'

interface HomeTickResult<T> {
  ok: boolean
  /** A scan was already running: this refresh did nothing. */
  skipped: boolean
  /** Page 1 of every chain — where a newly received iNFT shows up. */
  arrivals: T[]
  /** Card id → verdict, for the checked ids this tick proved. */
  owners: Record<string, OwnerVerdict>
  error?: string
}

interface CheckedToken {
  id: string
  chain: string
  contract: string
  tokenId: string
}

/** The renderer's checked card ids (`chain:contract:tokenId`, lowercase), validated; unknown chains and malformed ids are dropped. */
export function parseCheckedIds(raw: unknown, chains: readonly string[]): CheckedToken[] {
  if (!Array.isArray(raw)) {
    return []
  }

  const out: CheckedToken[] = []
  const seen = new Set<string>()

  for (const value of raw.slice(0, HOME_IDS_MAX)) {
    if (typeof value !== 'string' || seen.has(value)) {
      continue
    }

    const [chainKey, contract, tokenId, extra] = value.split(':')
    const chain = chains.find(name => name.toLowerCase() === chainKey)

    if (
      chain &&
      extra === undefined &&
      contract &&
      CONTRACT_RE.test(contract) &&
      tokenId &&
      TOKEN_ID_RE.test(tokenId) &&
      BigInt(tokenId) <= UINT256_MAX
    ) {
      seen.add(value)
      out.push({ id: value, chain, contract, tokenId })
    }
  }

  return out
}

function ownerOfCall(token: CheckedToken): EthCall {
  return { to: token.contract, data: OWNER_OF_SELECTOR + BigInt(token.tokenId).toString(16).padStart(64, '0') }
}

function verdictFor(result: null | string, wallet: string): OwnerVerdict {
  const owner = result ? OWNER_WORD_RE.exec(result)?.[1]?.toLowerCase() : undefined

  if (!owner) {
    return 'unknown'
  }

  return owner === wallet.slice(2) ? 'held' : owner === ZERO_OWNER ? 'unknown' : 'gone'
}

/** Runs `jobs` with at most `limit` in flight. */
async function runLimited(jobs: readonly (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0

  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next]

      next += 1
      await job?.()
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
}

interface HomeScannerDeps<TItem, TFull> {
  chains: readonly string[]
  readPage: ChainPageReader<TItem>
  /** The full paged roster scan (iclone-privy.ts `scanInfts`); it must honour `signal`. */
  fullScan: (address: string, signal: AbortSignal) => Promise<TFull>
  ethCallBatch: EthCallBatch
}

interface HomeScanner<TItem, TFull> {
  full: (address: string) => Promise<TFull>
  tick: (address: unknown, checkedIds: unknown) => Promise<HomeTickResult<TItem>>
  /** Sign-out: the running scan stops reading. */
  abort: () => void
}

/**
 * One Home scan at a time, per app. `full` joins a running full scan of the
 * same wallet and aborts anything else (a wallet switch); `tick` is skipped
 * while any scan runs; `abort` (sign-out) stops the running one.
 */
export function createHomeScanner<TItem, TFull>(deps: HomeScannerDeps<TItem, TFull>): HomeScanner<TItem, TFull> {
  let running: { address: string; kind: 'full' | 'tick'; controller: AbortController; done: Promise<unknown> } | null =
    null

  // Where the next tick's proof window starts, per wallet, when more than HOME_VERIFY_PER_TICK are checked.
  const rotation = new Map<string, number>()

  function start<R>(address: string, kind: 'full' | 'tick', job: (signal: AbortSignal) => Promise<R>): Promise<R> {
    const controller = new AbortController()

    const done = job(controller.signal).finally(() => {
      if (running?.controller === controller) {
        running = null
      }
    })

    running = { address, kind, controller, done }

    return done
  }

  function abort(): void {
    running?.controller.abort()
    running = null
  }

  function full(address: string): Promise<TFull> {
    const wallet = address.toLowerCase()

    if (running?.kind === 'full' && running.address === wallet) {
      return running.done as Promise<TFull>
    }

    abort()

    return start(wallet, 'full', signal => deps.fullScan(wallet, signal))
  }

  async function proveOwners(
    wallet: string,
    tokens: readonly CheckedToken[],
    signal: AbortSignal
  ): Promise<Record<string, OwnerVerdict>> {
    const owners: Record<string, OwnerVerdict> = {}
    const jobs: (() => Promise<void>)[] = []

    for (const chain of deps.chains) {
      const onChain = tokens.filter(token => token.chain === chain)

      for (let at = 0; at < onChain.length; at += HOME_OWNER_BATCH) {
        const batch = onChain.slice(at, at + HOME_OWNER_BATCH)

        jobs.push(async () => {
          if (signal.aborted) {
            return
          }

          const results = await deps.ethCallBatch(chain, batch.map(ownerOfCall), signal).catch(() => null)

          batch.forEach((token, index) => {
            owners[token.id] = verdictFor(results?.[index] ?? null, wallet)
          })
        })
      }
    }

    await runLimited(jobs, HOME_OWNER_CONCURRENCY)

    return owners
  }

  function proofWindow(wallet: string, tokens: readonly CheckedToken[]): CheckedToken[] {
    if (tokens.length <= HOME_VERIFY_PER_TICK) {
      return [...tokens]
    }

    // K88: only the wallet being proven keeps a window; a switched-away wallet's entry is dropped.
    for (const key of rotation.keys()) {
      if (key !== wallet) {
        rotation.delete(key)
      }
    }

    const from = (rotation.get(wallet) ?? 0) % tokens.length

    rotation.set(wallet, from + HOME_VERIFY_PER_TICK)

    return [...tokens, ...tokens].slice(from, from + HOME_VERIFY_PER_TICK)
  }

  function tick(address: unknown, checkedIds: unknown): Promise<HomeTickResult<TItem>> {
    if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
      return Promise.resolve({ ok: false, skipped: false, arrivals: [], owners: {}, error: 'bad address' })
    }

    if (running) {
      return Promise.resolve({ ok: true, skipped: true, arrivals: [], owners: {} })
    }

    const wallet = address.toLowerCase()
    const tokens = proofWindow(wallet, parseCheckedIds(checkedIds, deps.chains))

    return start(wallet, 'tick', async signal => {
      const [pages, owners] = await Promise.all([
        Promise.all(deps.chains.map(chain => deps.readPage(chain, wallet, null, signal).catch(() => null))),
        proveOwners(wallet, tokens, signal)
      ])

      return { ok: true, skipped: false, arrivals: pages.flatMap(page => page?.items ?? []), owners }
    })
  }

  return { full, tick, abort }
}
