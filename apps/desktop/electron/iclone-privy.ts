import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'

import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, session } from 'electron'

import { blockAnalytics, type SessionLike } from './iclone-analytics-block'
import { guardedHandler } from './iclone-consent'
import {
  BOOK_SCAN_CEILING,
  collectPages,
  createHomeScanner,
  type EthCall,
  type IndexerPageParams,
  nextPageParams,
  type PageRead,
  type ScanSenderGuard
} from './iclone-inft-book'
import { type ResolvedInftProfile, resolveInftProfile } from './iclone-profile'
import { writeFileAtomicSync } from './lib/atomic-write'

/**
 * iCLONE OS — Privy wallet login + iNFT wallet scan (main process).
 *
 * Self-contained on purpose: this is the ONE file the fork owns for wallet
 * login, per `iclone/README.md`'s fork discipline ("everything ours lives
 * under iclone/ — plus the minimum touch points in apps/desktop"). It has no
 * imports from main.ts/preload.ts and no new npm dependencies — only
 * node:http, node:fs, node:path and the `electron` module already in the app.
 *
 * ── Why a whole extra window instead of just doing this in the renderer ──
 * Privy's SDK (WebCrypto, iframes to its own domains) requires a real secure
 * context: `https:` or `http://localhost` / `http://127.0.0.1`. The app's own
 * renderer loads from `file://` in production — Privy is flatly unusable
 * there. So login runs in its own `BrowserWindow`, pointed at a tiny loopback
 * HTTP server this module starts on a FIXED port (127.0.0.1:47831 — fixed so
 * the Privy dashboard's allowed-origins entry never has to change between
 * runs or machines; see iclone/privy/README.md for the one-time dashboard
 * step the app owner must do).
 *
 * ── Why not OAuth social login ──
 * Electron cannot reliably complete a social provider's popup/redirect flow
 * (no custom-protocol redirect handler is wired for it). The vendored island
 * (iclone/privy/login-island/src/island.jsx) pins Privy's `loginMethods` to
 * `['email', 'wallet']` — wallet is the recommended path; either path
 * auto-provisions an embedded wallet on first sign-in.
 *
 * ── The three moving parts ──
 *  1. A loopback HTTP server serving exactly `privy.html` and
 *     `privy-login.js` from `iclone/privy/` — nothing else, no directory
 *     listing (`startLoopbackServer`).
 *  2. A login `BrowserWindow` on its own session partition
 *     (`persist:iclone-privy`) loading that server, with its own preload
 *     (`iclone/privy/privy-preload.cjs`) relaying the page's session state
 *     back over IPC (`openLoginWindow`).
 *  3. `scanInfts`, a from-scratch TypeScript port of the CLONE FRAME HUB's
 *     `bridge/nft.mjs` `scanWallet` + `bridge/platform/evm.mjs` read stack:
 *     Blockscout Base indexer first, raw public-RPC ERC-721 enumeration as a
 *     fallback, tagging every token `isAgentNft` by address-based trust only
 *     (the ATLAS iNFT contract + the ERC-8004 AgentIdentity registry) — never
 *     by a collection's self-reported name, which is attacker-controlled.
 *
 * IPC surface (renderer talks to this via `window.hermesDesktop.iclonePrivy`
 * — see the preload.ts patch in this feature's integration report):
 *   invoke 'iclone:privy-open'   → { ok: boolean; error?: string }
 *   invoke 'iclone:privy-logout' → { ok: boolean; error?: string }
 *   invoke 'iclone:inft-scan'    → InftScanResult   (arg: address: string)
 *   invoke 'iclone:privy-status' → IclonePrivySessionPayload | null
 *                                  (the partition's own word; null = unknown)
 *   main → renderer send 'iclone:privy-session'     → IclonePrivySessionPayload
 */

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

interface IclonePrivySessionPayload {
  status: 'in' | 'out'
  address: string | null
  userId: string | null
  label: string | null
  /** Status answers only: 'out' on the first launch of a new version that was signed in before it (V3-0b). */
  afterUpdate?: true
}

/** The on-chain `agent_bootstrap` block — the iNFT's profile source of truth:
 *  the living repo (GitHub) and the sealed genesis (Irys), plus the hashes the
 *  soul/identity files must match. This is what the profile engine follows to
 *  build one profile per iNFT. */
export interface InftBootstrap {
  version: number
  protocol: string
  repo: string
  genesis: string
  soul_sha256: string
  identity_sha256: string
  manifest: string
  byok: boolean
}

export interface InftScanItem {
  contract: string
  tokenId: string
  name: string
  image: string
  /** 3D model URL (GLB) from the token metadata — empty when none. */
  model: string
  isAgentNft: boolean
  /** Which network the token lives on ('Base' | 'Robinhood'). */
  chain: string
  /** Metadata `background_color` normalized to '#rrggbb' — empty when absent. */
  backdrop: string
  /** The profile source — null for plain NFTs / pre-reveal tokens. */
  bootstrap: InftBootstrap | null
}

interface InftScanResult {
  ok: boolean
  source: 'indexer' | 'rpc' | 'none'
  agents: InftScanItem[]
  /** Every chain's indexer was read to its last page (the renderer replaces its roster only then; otherwise it merges). */
  complete?: boolean
  /** Not complete only because a chain hit the ceiling: the most the app reads, so the O1 seed may come from it. */
  capped?: boolean
  error?: string
}

interface InitIclonePrivyOptions {
  /** Resolve the app's main window at call time — never cached, since the
   *  main window can be recreated (e.g. all-windows-closed on Windows/Linux,
   *  or a future multi-window mode) after `initIclonePrivy` first runs. */
  getMainWindow: () => BrowserWindow | null
  /** The version this userData last ran (`last-version.json`, read before this launch rewrites it) and this one.
   *  Absent = no version change is known, so no "signed out since the update" hint. */
  versionChange?: { current: string; previous: null | string }
  /** Required for the scan channels: a scan spends the indexer budget for any address it is given. */
  isTrustedSender: ScanSenderGuard
}

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const PRIVY_HOST = '127.0.0.1'
export const PRIVY_PORT = 47831

/**
 * Why the sign-in window did not open (K143). The port is fixed on purpose (it is the Privy-allowlisted origin), so a
 * second copy of the app — or anything else holding 127.0.0.1:47831 — cannot sign in; the renderer turns `reason` into
 * a localised message (desktop.home.signInPortInUse / signInUnavailable). `error` is the English line for logs.
 */
export type PrivyOpenResult =
  | { ok: true }
  | { ok: false; reason: 'port-in-use'; port: number; error: string }
  | { ok: false; reason: 'unavailable'; error: string }
  | { ok: false; reason: 'listen-failed'; error: string }

export type PrivyOpenRefusalReason = 'port-in-use' | 'unavailable' | 'listen-failed'

export function privyOpenRefusal(reason: PrivyOpenRefusalReason): PrivyOpenResult {
  if (reason === 'port-in-use') {
    return {
      ok: false,
      reason,
      port: PRIVY_PORT,
      error: `The sign-in page could not start: port ${PRIVY_PORT} is already in use on this Mac.`
    }
  }

  return reason === 'unavailable'
    ? { ok: false, reason, error: 'Privy login page is not available in this build.' }
    : { ok: false, reason, error: `The sign-in page could not start on ${PRIVY_HOST}:${PRIVY_PORT}.` }
}

/**
 * K143 r2 (n2): why the loopback server is not listening, from the last listen error. Only a held port
 * (`EADDRINUSE`) is "another copy is using the port"; any other error (EACCES, EADDRNOTAVAIL, none recorded) is a
 * plain failure, never a claim that something else holds the port.
 */
export function listenRefusalReason(code: string | null | undefined): 'port-in-use' | 'listen-failed' {
  return code === 'EADDRINUSE' ? 'port-in-use' : 'listen-failed'
}

const PRIVY_ORIGIN = `http://${PRIVY_HOST}:${PRIVY_PORT}`
const PRIVY_PARTITION = 'persist:iclone-privy'
/** The sign-in window is shown at first paint or after this long, whichever comes first. */
const LOGIN_SHOW_FALLBACK_MS = 1500

const OPEN_CHANNEL = 'iclone:privy-open'
const LOGOUT_CHANNEL = 'iclone:privy-logout'
const SCAN_CHANNEL = 'iclone:inft-scan'
const SCAN_TICK_CHANNEL = 'iclone:inft-scan-tick'
const PROFILE_RESOLVE_CHANNEL = 'iclone:inft-profile-resolve'
const SESSION_CHANNEL = 'iclone:privy-session'
const WINDOW_EVENT_CHANNEL = 'iclone:privy-window-event'
const STATUS_CHANNEL = 'iclone:privy-status'

// Address-based trust only — never a collection's self-reported name/symbol,
// which anyone can deploy and airdrop into a wallet. Trust is keyed by address
// AND chain, so a look-alike address on another network is not an agent.
//
//   Base — CLONE FRAME · ATLAS (verified live: name "ATLAS", symbol "INFT",
//     ERC-721,
//     https://base.blockscout.com/api/v2/tokens/0x3D9f35E08c41a80155353862f883F2B70119809f)
//   Base — the ERC-8004 AgentIdentity registry (proxy
//     "IdentityRegistryUpgradeable", 19k+ holders at verification time)
//   Robinhood — icloneOS i01 · Studio Experimentals (verified live on chain
//     4663: name "0004_icloneOS_studio_experimentals", symbol "IEXP4",
//     ERC-721SeaDrop, totalSupply 10; token metadata carries `model_url`, the
//     GLB itself, while `animation_url` points at the reveal HTML).
//
// A future owner-configurable allowlist (the HUB's
// `addCollection`/`removeCollection`) is a natural follow-up, out of scope
// here.
interface TrustedContract {
  contract: string
  chain: string
}

const TRUSTED_CONTRACTS: TrustedContract[] = [
  { contract: '0x3d9f35e08c41a80155353862f883f2b70119809f', chain: 'Base' },
  { contract: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432', chain: 'Base' },
  { contract: '0x4dfb27e4e6ade6afc8a21ab14751ee8b7ac75631', chain: 'Robinhood' }
]

function isAgentNft(contract: string): boolean {
  const c = contract.toLowerCase()

  return TRUSTED_CONTRACTS.some(t => t.contract === c)
}

/** Trusted contracts on one chain — the RPC enumeration path reads each of
 *  them with THAT chain's RPCs (a Base RPC cannot answer for chain 4663). */
function trustedContractsOn(chain: string): string[] {
  return TRUSTED_CONTRACTS.filter(t => t.chain === chain).map(t => t.contract)
}

// ─────────────────────────────────────────────────────────────────────────
// EVM read stack — ported from the CLONE FRAME HUB's
// bridge/platform/evm.mjs (zero-dep JSON-RPC failover + hand-rolled ABI
// codec). Every function here either returns a value or {ok:false,...}/null
// — never throws across an await boundary the caller didn't ask for.
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_RPCS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://1rpc.io/base'
]

// Per-chain RPC lists for tokenURI enrichment (the indexer's cached
// `metadata` is often null — the chain itself is the source of truth).
const CHAIN_RPCS: Record<string, string[]> = {
  Base: DEFAULT_RPCS,
  Robinhood: ['https://rpc.mainnet.chain.robinhood.com']
}

const SELECTORS = {
  tokenURI: '0xc87b56dd', // tokenURI(uint256)
  balanceOf: '0x70a08231', // balanceOf(address)
  tokenOfOwnerByIndex: '0x2f745c59', // tokenOfOwnerByIndex(address,uint256)
  ownerOf: '0x6352211e' // ownerOf(uint256)
} as const

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/
const RPC_TIMEOUT_MS = 8_000
const INDEXER_TIMEOUT_MS = 12_000
const META_TIMEOUT_MS = 8_000
const META_MAX_BYTES = 1.5 * 1024 * 1024

function isAddress(value: string): boolean {
  return ADDR_RE.test(value)
}

function encodeUint(n: number | bigint): string {
  return BigInt(n).toString(16).padStart(64, '0')
}

function encodeAddr(address: string): string {
  return address.replace(/^0x/, '').toLowerCase().padStart(64, '0')
}

// Decode a single ABI-encoded `string` eth_call return
// ([offset][length][data,padded]) → utf8. Never throws; '' on any malformed
// input (empty result, huge/garbage length, bad hex).
function decodeAbiString(hex: string | null): string {
  if (!hex || hex === '0x') {
    return ''
  }

  try {
    const h = hex.replace(/^0x/, '')
    const len = parseInt(h.slice(64, 128), 16)

    if (!Number.isFinite(len) || len <= 0 || len > 2_000_000) {
      return ''
    }

    return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8')
  } catch {
    return ''
  }
}

// Any tokenURI/media pointer scheme → fetchable https. http(s) and data:
// pass through unchanged.
function resolveMediaUrl(u: string): string {
  const s = u.trim()

  if (!s) {
    return ''
  }

  if (s.startsWith('ipfs://')) {
    return 'https://ipfs.io/ipfs/' + s.slice(7).replace(/^ipfs\//, '')
  }

  if (s.startsWith('ar://')) {
    return 'https://arweave.net/' + s.slice(5)
  }

  if (s.startsWith('irys://')) {
    return 'https://gateway.irys.xyz/' + s.slice(7)
  }

  return s
}

interface RpcCallResult {
  ok: boolean
  result?: string
  error?: string
}

// Generic JSON-RPC call, tried against each RPC in order until one returns a
// usable result. `skipEmpty`: a bare '0x' from an eth_call read is not a
// valid answer for the selectors this module calls — it's exclusively a
// rate-limited/lagging-node signal — so failover past it instead of
// committing to it.
async function rpcCall(
  method: string,
  params: unknown[],
  { rpcs = DEFAULT_RPCS, timeoutMs = RPC_TIMEOUT_MS, skipEmpty = false } = {}
): Promise<RpcCallResult> {
  let lastError = 'no rpcs configured'

  for (const url of rpcs) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      })

      if (!res.ok) {
        lastError = `rpc http ${res.status}`

        continue
      }

      const body = (await res.json()) as { result?: string; error?: { message?: string } }

      if (body.error) {
        lastError = body.error.message || 'rpc error'

        continue
      }

      if (body.result !== undefined && body.result !== null) {
        if (skipEmpty && body.result === '0x') {
          lastError = 'rpc: empty (0x) result'

          continue
        }

        return { ok: true, result: body.result }
      }

      lastError = 'rpc: empty result'
    } catch (e) {
      lastError =
        e instanceof Error && e.name === 'TimeoutError' ? 'rpc timeout' : e instanceof Error ? e.message : 'rpc failed'
    }
  }

  return { ok: false, error: lastError }
}

async function ethCall(to: string, data: string, rpcs: string[] = DEFAULT_RPCS): Promise<string | null> {
  const r = await rpcCall('eth_call', [{ to, data }, 'latest'], { rpcs, skipEmpty: true })

  return r.ok && r.result && r.result !== '0x' ? r.result : null
}

// The same client in JSON-RPC batch form (the Home refresh's ownerOf proofs):
// the chain's RPC list in order, failing over on an HTTP error, a non-array
// answer or a timeout. Per call, an error or a bare '0x' is null (no proof).
export async function ethCallBatch(
  chain: string,
  calls: readonly EthCall[],
  signal: AbortSignal
): Promise<(null | string)[] | null> {
  const body = JSON.stringify(
    calls.map((call, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [call, 'latest'] }))
  )

  for (const url of CHAIN_RPCS[chain] ?? DEFAULT_RPCS) {
    if (signal.aborted) {
      return null
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.any([signal, AbortSignal.timeout(RPC_TIMEOUT_MS)]),
        headers: { 'content-type': 'application/json' },
        body
      })

      const answers: unknown = res.ok ? await res.json() : null

      if (!Array.isArray(answers)) {
        continue
      }

      const results: (null | string)[] = calls.map(() => null)

      for (const answer of answers as { id?: unknown; result?: unknown }[]) {
        if (typeof answer?.id === 'number' && answer.id in results && typeof answer.result === 'string') {
          results[answer.id] = answer.result === '0x' ? null : answer.result
        }
      }

      return results
    } catch {
      // Next RPC — an aborted signal returns at the top of the loop.
    }
  }

  return null
}

interface TokenMetadata {
  name?: string
  description?: string
  image?: string
  image_url?: string
  image_gateway?: string
  /** iCLONE iNFT metadata: the GLB itself. On these tokens `animation_url`
   *  points at the reveal HTML page, so this is the field the 3D stage
   *  actually needs — prefer it over the animation pair when present. */
  model_url?: string
  /** iCLONE iNFT metadata: the static rendered image of the actual iNFT
   *  (the "poster"). This is the REAL card image — preferred over `image`
   *  because the collection's pre-reveal metadata ships an `artefact`
   *  texture-map there, which looks like a placeholder, not the character. */
  poster?: string
  animation_url?: string
  /** Irys-style direct gateway URL — preferred (the plain animation_url can
   *  point at an expired CDN mirror; verified live on ATLAS #1). */
  animation_gateway?: string
  /** OpenSea-standard field color, 6 hex digits without '#' (the iCLONE 1111
   *  metadata records the rim color here). */
  background_color?: string
  /** The on-chain `agent_bootstrap` block — the profile's source of truth. */
  agent_bootstrap?: {
    version?: number
    protocol?: string
    repo?: string
    genesis?: string
    soul_sha256?: string
    identity_sha256?: string
    manifest?: string
    substrate?: { byok?: boolean }
  }
}

/** '#rrggbb' from a metadata background_color (with or without '#'), or ''. */
function normalizeBackdrop(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }

  const hex = value.trim().replace(/^#/, '').toLowerCase()

  return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : ''
}

// tokenURI → parsed metadata JSON, or null. Handles the on-chain form
// (data:application/json[;base64],…) locally; the off-chain form fetches with
// a timeout + size cap and never throws.
async function resolveTokenMeta(uri: string): Promise<TokenMetadata | null> {
  const s = uri.trim()

  if (!s) {
    return null
  }

  if (s.startsWith('data:')) {
    try {
      const comma = s.indexOf(',')

      if (comma < 0) {
        return null
      }

      const head = s.slice(5, comma)
      const payload = s.slice(comma + 1)
      const raw = /;base64/i.test(head) ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload)

      return JSON.parse(raw) as TokenMetadata
    } catch {
      return null
    }
  }

  const u = resolveMediaUrl(s)

  if (!/^https?:\/\//i.test(u)) {
    return null
  }

  try {
    const res = await fetch(u, {
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
      headers: { accept: 'application/json, text/plain, */*' }
    })

    if (!res.ok) {
      return null
    }

    const text = await res.text()

    if (text.length > META_MAX_BYTES) {
      return null
    }

    return JSON.parse(text) as TokenMetadata
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────
// scanInfts — Blockscout Base indexer first, raw-RPC enumeration fallback.
// Ported from the HUB's bridge/nft.mjs `scanWallet`, scoped down to this
// app's simpler (not owner-configurable) trust set — see isAgentNft above.
// Both the indexer response shape and the RPC selectors were verified live
// against Base mainnet while building this module (holder
// <a wallet address>, token ids 1 and 2).
// ─────────────────────────────────────────────────────────────────────────

// One Blockscout instance per chain the app reads. Robinhood Chain mainnet
// (chain id 4663 — where the iCLONE 1111 OpenSea drop lives) redirects its
// explorer.mainnet.chain.robinhood.com hostname here. Its Cloudflare tier
// 403-challenges UA-less fetches, so every indexer call sends a browser
// User-Agent (verified: 403 without, 200 with; Base needs none but tolerates
// it).
const INDEXERS = [
  { chain: 'Base', base: 'https://base.blockscout.com/api/v2' },
  { chain: 'Robinhood', base: 'https://robinhoodchain.blockscout.com/api/v2' }
] as const

const INDEXER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** The indexer chains, in scan order — the iNFT Book's cursor walks them (main.ts wires it). */
export const INDEXER_CHAINS: readonly string[] = INDEXERS.map(indexer => indexer.chain)

// Best-effort only, and it never throws — an unusable contract contributes
// nothing rather than failing the whole scan.
//
// This path IS the recovery leg for the trusted contracts that don't
// implement ERC721Enumerable: `tokenOfOwnerByIndex` reverts for ATLAS on Base
// AND for the Robinhood Studio Experimentals drop on chain 4663 (both
// verified live), so enumeration falls through to the ownerOf probe. It runs
// per chain, with that chain's RPCs, whenever that chain's indexer failed —
// which on Robinhood's Cloudflare tier is often enough that the roster would
// otherwise flap to empty.
const RPC_FALLBACK_MAX_PER_CONTRACT = 12

interface IndexerNftItem {
  id: string | number
  image_url?: string | null
  media_url?: string | null
  metadata?: {
    name?: string
    image?: string
    image_gateway?: string
    animation_url?: string
    animation_gateway?: string
    model_url?: string
    background_color?: string
  } | null
  token?: { address_hash?: string; name?: string } | null
}

function toIndexerScanItem(it: IndexerNftItem, chain: string): InftScanItem {
  const contract = it.token?.address_hash || ''
  const md = it.metadata || {}

  return {
    contract,
    tokenId: String(it.id ?? ''),
    name: md.name || `${it.token?.name || 'NFT'} #${it.id}`,
    image: resolveMediaUrl(md.image_gateway || md.image || it.image_url || it.media_url || ''),
    model: resolveMediaUrl(md.model_url || md.animation_gateway || md.animation_url || ''),
    isAgentNft: isAgentNft(contract),
    chain,
    backdrop: normalizeBackdrop(md.background_color),
    bootstrap: null
  }
}

/** ONE indexer page of a wallet's NFTs (null = the request failed; the caller
 *  owns retries). `params` is the previous page's `next_page_params`, set
 *  through URLSearchParams only. Also the iNFT Book's page reader (main.ts). */
export async function readIndexerPage(
  chain: string,
  address: string,
  params: IndexerPageParams | null,
  signal?: AbortSignal
): Promise<null | PageRead<InftScanItem>> {
  const indexer = INDEXERS.find(candidate => candidate.chain === chain)

  if (!indexer || !isAddress(address)) {
    return null
  }

  const url = new URL(`${indexer.base}/addresses/${address.toLowerCase()}/nft`)

  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== null) {
      url.searchParams.set(key, String(value))
    }
  }

  // Last, so no cursor key can widen the token filter.
  url.searchParams.set('type', 'ERC-721,ERC-1155,ERC-404')

  const timeout = AbortSignal.timeout(INDEXER_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        accept: 'application/json',
        'user-agent': INDEXER_UA,
        // The Robinhood tier also challenges requests with no `referer` —
        // a browser UA alone now lands on "Just a moment…" (verified: 403
        // without, 200 with). Same-origin referer, never a foreign one.
        referer: `${new URL(indexer.base).origin}/`
      }
    })

    if (!res.ok) {
      return null
    }

    const body = (await res.json()) as { items?: IndexerNftItem[]; next_page_params?: unknown }
    const items = Array.isArray(body.items) ? body.items : []
    const next = nextPageParams(body.next_page_params)
    const read = items.map(it => toIndexerScanItem(it, indexer.chain)).filter(a => a.contract)

    // K23: an unknown cursor key fails only the follow-up; this page's items stand and the scan says incomplete.
    return next === undefined ? { items: read, next: null, cursorBroken: true } : { items: read, next }
  } catch {
    return null
  }
}

// Every page to exhaustion (≤ BOOK_SCAN_CEILING). Hosted Blockscout 500s in
// flaps — one spaced retry per page rescues most scans. A first page that
// fails is a failed indexer (null → the RPC fallback); a later one keeps the
// pages already read and says the scan is not complete.
async function scanViaIndexer(
  indexer: (typeof INDEXERS)[number],
  address: string,
  signal?: AbortSignal
): Promise<{ items: InftScanItem[]; complete: boolean; capped: boolean } | null> {
  const scan = await collectPages(params => readIndexerPage(indexer.chain, address, params, signal), {
    ceiling: BOOK_SCAN_CEILING,
    retries: 1,
    backoffMs: [1_500],
    signal
  })

  return scan.pages === 0 ? null : scan
}

async function readToken(contract: string, tokenId: string, chain = 'Base'): Promise<InftScanItem | null> {
  const rpcs = CHAIN_RPCS[chain] ?? DEFAULT_RPCS
  const uriHex = await ethCall(contract, SELECTORS.tokenURI + encodeUint(BigInt(tokenId)), rpcs)
  const uri = decodeAbiString(uriHex)

  if (!uri) {
    return {
      contract,
      tokenId,
      name: `#${tokenId}`,
      image: '',
      model: '',
      isAgentNft: isAgentNft(contract),
      chain,
      backdrop: '',
      bootstrap: null
    }
  }

  const meta = await resolveTokenMeta(uri)
  const b = meta?.agent_bootstrap

  return {
    contract,
    tokenId,
    name: meta?.name || `#${tokenId}`,
    image: resolveMediaUrl(meta?.poster || meta?.image_gateway || meta?.image || meta?.image_url || ''),
    model: resolveMediaUrl(meta?.model_url || meta?.animation_gateway || meta?.animation_url || ''),
    isAgentNft: isAgentNft(contract),
    chain,
    backdrop: normalizeBackdrop(meta?.background_color),
    bootstrap: b
      ? {
          version: b.version ?? 0,
          protocol: b.protocol ?? '',
          repo: b.repo ?? '',
          genesis: b.genesis ?? '',
          soul_sha256: b.soul_sha256 ?? '',
          identity_sha256: b.identity_sha256 ?? '',
          manifest: b.manifest ?? '',
          byok: b.substrate?.byok ?? false
        }
      : null
  }
}

// The indexer's cached `metadata` is often stale — it can still hold the
// pre-reveal/artefact image long after the token was revealed. For agent-
// trusted tokens, the on-chain tokenURI is the source of truth: re-read it to
// get the REAL image (poster) and the GLB, so a collection card never shows a
// texture-map placeholder. The stage needs the GLB URL, and the card needs the
// real image — both come from the same on-chain read.
const ENRICH_MAX = 8

async function enrichFromChain(items: InftScanItem[]): Promise<InftScanItem[]> {
  const targets = items.filter(it => it.isAgentNft).slice(0, ENRICH_MAX)

  if (targets.length === 0) {
    return items
  }

  const enriched = await Promise.all(
    targets.map(async it => {
      try {
        const fresh = await readToken(it.contract, it.tokenId, it.chain)

        return fresh ? { key: it, fresh } : null
      } catch {
        return null
      }
    })
  )

  const byTarget = new Map(enriched.filter(Boolean).map(e => [e!.key, e!.fresh]))

  return items.map(it => {
    const fresh = byTarget.get(it)

    return fresh
      ? {
          ...it,
          // The on-chain image wins over the indexer's cache: a stale cache is
          // exactly what leaves the pre-reveal artefact on a revealed card.
          image: fresh.image || it.image,
          model: fresh.model || it.model,
          name: it.name || fresh.name,
          backdrop: it.backdrop || fresh.backdrop,
          bootstrap: fresh.bootstrap ?? it.bootstrap
        }
      : it
  })
}

// ownerOf probe window for non-enumerable trusted contracts (ATLAS reverts on
// tokenOfOwnerByIndex, and so does the Robinhood Studio Experimentals drop).
// Small collections only — the probe walks ids 1..N.
const OWNER_PROBE_MAX_ID = 32

async function scanViaRpc(address: string, chain: string): Promise<InftScanItem[]> {
  const agents: InftScanItem[] = []
  const rpcs = CHAIN_RPCS[chain] ?? DEFAULT_RPCS

  for (const contract of trustedContractsOn(chain)) {
    try {
      const balHex = await ethCall(contract, SELECTORS.balanceOf + encodeAddr(address), rpcs)
      const balance = balHex ? parseInt(balHex, 16) : 0

      if (balance <= 0) {
        continue
      }

      const count = Math.min(balance, RPC_FALLBACK_MAX_PER_CONTRACT)
      const owned: string[] = []

      for (let i = 0; i < count && owned.length < count; i++) {
        const idxHex = await ethCall(
          contract,
          SELECTORS.tokenOfOwnerByIndex + encodeAddr(address) + encodeUint(i),
          rpcs
        )

        if (idxHex) {
          owned.push(BigInt(idxHex).toString())
        } else {
          break // Not enumerable — switch to the ownerOf probe below.
        }
      }

      if (owned.length === 0) {
        for (let id = 1; id <= OWNER_PROBE_MAX_ID && owned.length < count; id++) {
          const ownerHex = await ethCall(contract, SELECTORS.ownerOf + encodeUint(id), rpcs)

          if (ownerHex && ownerHex.slice(-40).toLowerCase() === address.slice(2).toLowerCase()) {
            owned.push(String(id))
          }
        }
      }

      for (const tokenId of owned) {
        const item = await readToken(contract, tokenId, chain)

        if (item) {
          agents.push(item)
        }
      }
    } catch {
      // Best-effort per contract — move on rather than failing the whole scan.
    }
  }

  return agents
}

async function scanInfts(address: string, signal?: AbortSignal): Promise<InftScanResult> {
  if (!isAddress(address)) {
    return { ok: false, source: 'none', agents: [], error: 'bad address' }
  }

  const normalized = address.toLowerCase()

  // Every chain in parallel; a chain whose indexer is down just contributes
  // nothing — one flaky Cloudflare tier must not blank the whole roster.
  const perChain = await Promise.all(INDEXERS.map(indexer => scanViaIndexer(indexer, normalized, signal)))

  if (signal?.aborted) {
    return { ok: false, source: 'none', agents: [], error: 'aborted' }
  }

  const complete = perChain.every(scan => scan?.complete === true)
  const capped = !complete && perChain.every(scan => scan?.complete === true || scan?.capped === true)
  const merged = perChain.flatMap(scan => scan?.items ?? [])

  // Any chain whose indexer failed falls back to raw-RPC enumeration of THAT
  // chain's trusted contracts (enumerable, else the ownerOf probe) — the
  // roster must never lose an agent to a Blockscout/Cloudflare flap.
  const recovered = await Promise.all(
    INDEXERS.map((indexer, i) =>
      perChain[i] === null ? scanViaRpc(normalized, indexer.chain) : Promise.resolve<InftScanItem[]>([])
    )
  )

  merged.push(...recovered.flat())

  // One token, one card — even when two paths report the same id.
  const seen = new Set<string>()

  const unique = merged.filter(it => {
    const key = `${it.chain}:${it.contract.toLowerCase()}:${it.tokenId}`

    if (seen.has(key)) {
      return false
    }

    seen.add(key)

    return true
  })

  const anyIndexer = perChain.some(items => items !== null)

  if (unique.length > 0 || anyIndexer) {
    return {
      ok: true,
      source: anyIndexer ? 'indexer' : 'rpc',
      agents: await enrichFromChain(unique),
      complete,
      capped
    }
  }

  return { ok: true, source: 'none', agents: [], complete, capped }
}

const homeScanner = createHomeScanner({
  chains: INDEXER_CHAINS,
  readPage: readIndexerPage,
  fullScan: scanInfts,
  ethCallBatch
})

// ─────────────────────────────────────────────────────────────────────────
// Loopback static server — serves exactly iclone/privy/privy.html and
// iclone/privy/privy-login.js. No directory listing, no other path, no path
// traversal surface (the map below is the entire routing table; nothing in
// it is built from request input).
// ─────────────────────────────────────────────────────────────────────────

interface ServedFile {
  file: string
  contentType: string
}

const SERVED_FILES: Record<string, ServedFile> = {
  '/': { file: 'privy.html', contentType: 'text/html; charset=utf-8' },
  '/privy.html': { file: 'privy.html', contentType: 'text/html; charset=utf-8' },
  '/privy-login.js': { file: 'privy-login.js', contentType: 'application/javascript; charset=utf-8' }
}

const REQUIRED_PRIVY_FILES = ['privy.html', 'privy-login.js', 'privy-preload.cjs']

/**
 * Locate `iclone/privy/` across the layouts this module can run under:
 *  - packaged: an electron-builder `extraResources` entry mapping
 *    `iclone/privy` → `resources/iclone-privy` (not configured yet — see
 *    iclone/privy/README.md; this candidate is here so wiring it up later
 *    needs no code change).
 *  - dev / source checkout: apps/desktop is two levels under the monorepo
 *    root, so `app.getAppPath()/../../iclone/privy`.
 *  - a future layout where the fork vendors it directly under the app dir.
 * Returns the first candidate that actually holds all three files this
 * feature needs; null (never a throw) if none do, so the app degrades to
 * "wallet login unavailable" instead of failing to start.
 */
function resolvePrivyDir(): string | null {
  const appRoot = app.getAppPath()

  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'iclone-privy') : null,
    path.join(appRoot, '..', '..', 'iclone', 'privy'),
    path.join(appRoot, 'iclone-privy')
  ].filter((p): p is string => Boolean(p))

  for (const dir of candidates) {
    if (REQUIRED_PRIVY_FILES.every(f => fs.existsSync(path.join(dir, f)))) {
      return dir
    }
  }

  return null
}

function startLoopbackServer(privyDir: string): http.Server {
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0]
    const entry = req.method === 'GET' ? SERVED_FILES[pathname] : undefined

    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')

    if (!entry) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')

      return
    }

    fs.readFile(path.join(privyDir, entry.file), (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')

        return
      }

      res.writeHead(200, { 'content-type': entry.contentType, 'content-length': data.length })
      res.end(data)
    })
  })

  server.on('error', err => {
    lastListenErrorCode = (err as NodeJS.ErrnoException).code ?? null
    console.error(`[iclone-privy] loopback server error on ${PRIVY_ORIGIN}:`, err)
  })
  server.on('listening', () => {
    lastListenErrorCode = null
  })

  server.listen(PRIVY_PORT, PRIVY_HOST)

  return server
}

/** The code of the loopback server's last listen error (null once it listens). K143 r2 (n2). */
let lastListenErrorCode: string | null = null

/** One more attempt to bind the fixed port; resolves whether the server is listening afterwards. */
function listenAgain(server: http.Server): Promise<boolean> {
  return new Promise(resolve => {
    const done = () => {
      server.off('listening', done)
      server.off('error', done)
      resolve(server.listening)
    }

    server.once('listening', done)
    server.once('error', done)

    try {
      server.listen(PRIVY_PORT, PRIVY_HOST)
    } catch {
      done()
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────
// Login window
// ─────────────────────────────────────────────────────────────────────────

type PrivySessionListener = (status: 'in' | 'out', address: string | null) => void

/** Main-side listeners of the session (V3-I: ACP WORK stops every listener on sign-out or a wallet switch). */
const sessionListeners = new Set<PrivySessionListener>()

/** Follows every session state main learns: a sign-in, a sign-out, and each definitive status answer. */
export function onPrivySession(listener: PrivySessionListener): () => void {
  sessionListeners.add(listener)

  return () => sessionListeners.delete(listener)
}

function announceSession(payload: IclonePrivySessionPayload): void {
  for (const listener of sessionListeners) {
    try {
      listener(payload.status, payload.address)
    } catch (error) {
      console.error('[iclone-privy] session listener failed:', error)
    }
  }
}

/** The last session state this app recorded ('in' | 'out'), or null when none was. */
export function privySignInState(): 'in' | 'out' | null {
  return signInRecord?.read() ?? null
}

let loginWindow: BrowserWindow | null = null
let signInRecord: PrivySignInRecord | null = null
// Bumped by every sign-in and sign-out. A status probe records its answer only
// if no sign-in or sign-out landed while it ran; otherwise it answers null.
let signInGeneration = 0
// Ends the running status probe (window destroyed, answer null) — sign-out
// calls it before clearing the partition.
let abortStatusProbe: (() => void) | null = null

/** Defense in depth for every window on the Privy partition: the page never
 *  needs to leave the loopback origin (Privy's own flows run inside iframes,
 *  not top-level navigation). Origin-exact, and on redirects too: a prefix
 *  test accepted `http://127.0.0.1:47831@evil.com/`. */
function confinePrivyWindow(win: BrowserWindow): void {
  const stayHome = (event: { preventDefault: () => void }, url: string) => {
    let origin = ''

    try {
      origin = new URL(url).origin
    } catch {
      // unparsable → not ours
    }

    if (origin !== new URL(PRIVY_ORIGIN).origin) {
      event.preventDefault()
    }
  }

  win.webContents.on('will-navigate', stayHome)
  win.webContents.on('will-redirect', stayHome)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

function parseSessionPayload(raw: unknown): IclonePrivySessionPayload | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const r = raw as Record<string, unknown>
  const status = r.status === 'out' ? 'out' : r.status === 'in' ? 'in' : null

  if (!status) {
    return null
  }

  return {
    status,
    address: typeof r.address === 'string' ? r.address : null,
    userId: typeof r.userId === 'string' ? r.userId : null,
    label: typeof r.label === 'string' ? r.label : null
  }
}

/** Puts the sign-in window in front of the user, wherever the main window is. With the main window in macOS full
 *  screen (its own Space) a child window could open on another Space and never be seen ("opening sign-in…", then
 *  nothing). Visible on every Space, full-screen ones included, it always lands over the app. */
function presentLoginWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) {
    return
  }

  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  win.show()
  win.focus()
  app.focus({ steal: true })
}

function openLoginWindow(privyDir: string, getMainWindow: () => BrowserWindow | null): void {
  if (loginWindow && !loginWindow.isDestroyed()) {
    presentLoginWindow(loginWindow)

    return
  }

  // Deny everything by default — this window only ever needs email OTP +
  // wallet connect, neither of which needs camera/mic/geolocation/etc.
  session.fromPartition(PRIVY_PARTITION).setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  // Ruling 57.3 / critic r5 M2: the Privy SDK's analytics events never leave this Mac (before the page loads).
  blockAnalytics(session.fromPartition(PRIVY_PARTITION) as unknown as SessionLike)

  const mainWin = getMainWindow()

  const win = new BrowserWindow({
    width: 440,
    height: 620,
    resizable: false,
    minimizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    title: 'iCLONE OS — Sign in',
    backgroundColor: '#0b0a10',
    parent: mainWin && !mainWin.isDestroyed() ? mainWin : undefined,
    webPreferences: {
      partition: PRIVY_PARTITION,
      preload: path.join(privyDir, 'privy-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: !app.isPackaged
    }
  })

  loginWindow = win

  confinePrivyWindow(win)

  // Shown at first paint, and at the latest after a short wait: a page that is slow to paint must never leave an
  // invisible window behind a button that looks dead.
  const presentFallback = setTimeout(() => presentLoginWindow(win), LOGIN_SHOW_FALLBACK_MS)

  win.once('ready-to-show', () => {
    clearTimeout(presentFallback)
    presentLoginWindow(win)
  })
  win.once('closed', () => clearTimeout(presentFallback))

  // A window whose page failed to load must not survive as the cached
  // `loginWindow`: the reuse path show()+focus()es it, and what the user gets
  // is a blank card that never signs anyone in. Tear it down so the next
  // click builds a fresh one.
  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`[iclone-privy] login window failed to load (${code} ${description}) — closing it`)

    if (!win.isDestroyed()) {
      win.destroy()
    }
  })

  const onWindowEvent = (event: IpcMainEvent, payload: unknown) => {
    if (event.sender !== win.webContents) {
      return
    }

    const parsed = parseSessionPayload(payload)

    if (!parsed) {
      return
    }

    if (parsed.status === 'out') {
      homeScanner.abort()
    }

    const target = getMainWindow()

    if (target && !target.isDestroyed()) {
      target.webContents.send(SESSION_CHANNEL, parsed)
    }

    // Signed in: let the user see the "Signed in" state land in privy.html,
    // then close the window for them — signing in is the window's one job.
    if (parsed.status === 'in') {
      signInGeneration += 1
      signInRecord?.write('in')
    }

    announceSession(parsed)

    if (parsed.status === 'in' && !win.isDestroyed()) {
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.close()
        }
      }, 900)
    }
  }

  ipcMain.on(WINDOW_EVENT_CHANNEL, onWindowEvent)

  win.on('closed', () => {
    ipcMain.removeListener(WINDOW_EVENT_CHANNEL, onWindowEvent)

    if (loginWindow === win) {
      loginWindow = null
    }
  })

  win.loadURL(`${PRIVY_ORIGIN}/privy.html`)
}

// ─────────────────────────────────────────────────────────────────────────
// Session status — the partition's own word, read on the renderer's boot
// ─────────────────────────────────────────────────────────────────────────

/** The last session state this app saw for the partition. `null` = never
 *  recorded (a fresh install, or a 1.0.0 upgrade that predates the record). */
type PrivySignInState = 'in' | 'out' | null

interface PrivySignInRecord {
  read: () => PrivySignInState
  write: (state: 'in' | 'out') => void
  /** Mirror a definitive status answer; null (unknown) changes nothing. */
  record: (answer: IclonePrivySessionPayload | null) => void
}

/** A one-line JSON file in userData, replaced atomically (tmp + rename). A
 *  write that fails removes the file, which falls back to the partition check
 *  instead of leaving a stale state behind. */
export function createPrivySignInRecord(file: string): PrivySignInRecord {
  const read = (): PrivySignInState => {
    try {
      const state = (JSON.parse(fs.readFileSync(file, 'utf8')) as { state?: unknown } | null)?.state

      return state === 'in' || state === 'out' ? state : null
    } catch {
      return null
    }
  }

  const write = (state: 'in' | 'out'): void => {
    try {
      writeFileAtomicSync(file, JSON.stringify({ state }), { mode: 0o600 })
    } catch {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        // Not a plain file (or not removable): read() treats it as unrecorded.
      }
    }
  }

  return {
    read,
    write,
    record: answer => {
      if (answer?.status === 'in' || answer?.status === 'out') {
        write(answer.status)
      }
    }
  }
}

/** The facts read once at boot, before this launch's first status answer can rewrite the sign-in record. */
interface PrivyUpdateBoot {
  /** The sign-in record as the previous version left it. */
  marker: PrivySignInState
  versionChange?: { current: string; previous: null | string }
}

/**
 * The home's "signed out since the update" hint, and nothing otherwise: the previous version recorded a sign-in, the
 * version changed (a known earlier version, not a fresh install), and this launch's partition answers 'out'.
 */
export function signedOutByUpdate(boot: PrivyUpdateBoot, answer: IclonePrivySessionPayload | null): boolean {
  const change = boot.versionChange

  return (
    answer?.status === 'out' &&
    boot.marker === 'in' &&
    Boolean(change?.previous) &&
    change?.previous !== change?.current
  )
}

/** True when the partition has ever stored web data (Local Storage or
 *  IndexedDB entries). A partition that never loaded the Privy page has none. */
export function hasPartitionData(storagePath: string | null): boolean {
  if (!storagePath) {
    return false
  }

  return ['Local Storage', 'IndexedDB'].some(dir => {
    try {
      return fs.readdirSync(path.join(storagePath, dir)).length > 0
    } catch {
      return false
    }
  })
}

/** Load the Privy page only when it can find a session: the record says
 *  'in', or nothing was recorded yet and the partition holds data (an
 *  upgrader from 1.0.0). A never-signed-in store costs no network. */
export function shouldProbePrivyPartition(state: PrivySignInState, partitionHasData: () => boolean): boolean {
  if (state !== null) {
    return state === 'in'
  }

  return partitionHasData()
}

export const SIGNED_OUT_PAYLOAD: IclonePrivySessionPayload = Object.freeze({
  status: 'out',
  address: null,
  userId: null,
  label: null
})

/** How long the hidden status page may take to report. A cold Privy SDK talks
 *  to auth.privy.io first, so this is generous; the renderer's "restoring your
 *  wallet…" placeholder is bounded separately (10 s) and still applies a later
 *  answer. Past it main answers null (unknown) — never 'out', which would make
 *  the renderer forget a wallet that is really signed in. */
export const PRIVY_STATUS_TIMEOUT_MS = 30_000

/** A session can report 'in' before its wallet list loads (address null);
 *  wait this long for the addressed report before settling for it. */
const PRIVY_STATUS_ADDRESS_GRACE_MS = 1_500

interface PrivyStatusWindow {
  webContents: unknown
  loadURL: (url: string) => Promise<void>
  isDestroyed: () => boolean
  destroy: () => void
}

export interface PrivyStatusProbeDeps {
  createWindow: () => PrivyStatusWindow
  /** Subscribes to the page preload's relay; returns the unsubscribe. */
  onWindowEvent: (listener: (event: { sender: unknown }, payload: unknown) => void) => () => void
  url: string
  timeoutMs?: number
  addressGraceMs?: number
  /** Aborting ends the probe at once: window destroyed, answer null. */
  signal?: AbortSignal
}

/**
 * Load privy.html in a hidden window on the persisted partition and return
 * the first session it reports: the island announces `in` (with the wallet)
 * or `out` as soon as the SDK is ready. The window is destroyed on every path.
 */
export function probePrivySession({
  createWindow,
  onWindowEvent,
  url,
  timeoutMs = PRIVY_STATUS_TIMEOUT_MS,
  addressGraceMs = PRIVY_STATUS_ADDRESS_GRACE_MS,
  signal
}: PrivyStatusProbeDeps): Promise<IclonePrivySessionPayload | null> {
  return new Promise(resolve => {
    let done = false
    let addressless: IclonePrivySessionPayload | null = null
    let grace: ReturnType<typeof setTimeout> | null = null
    let stop: () => void = () => undefined
    let win: PrivyStatusWindow | null = null

    const finish = (result: IclonePrivySessionPayload | null) => {
      if (done) {
        return
      }

      done = true
      clearTimeout(deadline)
      signal?.removeEventListener('abort', onAbort)

      if (grace) {
        clearTimeout(grace)
      }

      stop()

      if (win && !win.isDestroyed()) {
        win.destroy()
      }

      resolve(result)
    }

    const deadline = setTimeout(() => finish(addressless), timeoutMs)
    const onAbort = () => finish(null)

    if (signal?.aborted) {
      finish(null)

      return
    }

    signal?.addEventListener('abort', onAbort)

    try {
      const probeWin = createWindow()

      win = probeWin
      stop = onWindowEvent((event, payload) => {
        if (event.sender !== probeWin.webContents) {
          return
        }

        const parsed = parseSessionPayload(payload)

        if (!parsed) {
          return
        }

        if (parsed.status === 'in' && !parsed.address) {
          addressless ??= parsed
          grace ??= setTimeout(() => finish(addressless), addressGraceMs)

          return
        }

        finish(parsed)
      })
      probeWin.loadURL(url).catch(() => finish(addressless))
    } catch {
      finish(null)
    }
  })
}

/** One probe at a time: a renderer that reloads twice in a row shares the
 *  answer instead of stacking hidden windows. */
export function createPrivyStatusReader(
  probe: () => Promise<IclonePrivySessionPayload | null>
): () => Promise<IclonePrivySessionPayload | null> {
  let inFlight: Promise<IclonePrivySessionPayload | null> | null = null

  return () => {
    inFlight ??= probe()
      .catch(() => null)
      .finally(() => {
        inFlight = null
      })

    return inFlight
  }
}

function createStatusWindow(privyDir: string): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 440,
    height: 620,
    title: 'iCLONE OS — Wallet status',
    webPreferences: {
      partition: PRIVY_PARTITION,
      preload: path.join(privyDir, 'privy-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: false,
      // Hidden windows are throttled by default; the SDK's start-up timers
      // must run at full speed or the answer arrives late.
      backgroundThrottling: false
    }
  })

  confinePrivyWindow(win)

  return win
}

async function logoutPrivy(getMainWindow: () => BrowserWindow | null): Promise<{ ok: boolean; error?: string }> {
  signInGeneration += 1
  homeScanner.abort()
  abortStatusProbe?.()
  signInRecord?.write('out')
  announceSession({ ...SIGNED_OUT_PAYLOAD })

  try {
    await session.fromPartition(PRIVY_PARTITION).clearStorageData()

    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.close()
    }

    const target = getMainWindow()

    if (target && !target.isDestroyed()) {
      target.webContents.send(SESSION_CHANNEL, { ...SIGNED_OUT_PAYLOAD })
    }

    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'logout failed' }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

let initialized = false

/**
 * Call once, at app ready — see this feature's integration report for the
 * exact one-line main.ts patch. Starts the loopback server and registers the
 * IPC handlers; idempotent (a second call is a no-op) so an accidental
 * double-wire during dev never binds the port twice.
 */
export function initIclonePrivy({ getMainWindow, versionChange, isTrustedSender }: InitIclonePrivyOptions): void {
  if (initialized) {
    return
  }

  initialized = true

  const privyDir = resolvePrivyDir()

  signInRecord = createPrivySignInRecord(path.join(app.getPath('userData'), 'iclone-privy-signin.json'))

  const updateBoot: PrivyUpdateBoot = { marker: signInRecord.read(), versionChange }

  if (!privyDir) {
    console.error(
      '[iclone-privy] iclone/privy/ not found (or incomplete) — wallet login is unavailable. See iclone/privy/README.md.'
    )
  }

  const server = privyDir ? startLoopbackServer(privyDir) : null

  app.once('before-quit', () => {
    server?.close()
  })

  ipcMain.handle(OPEN_CHANNEL, async (_event: IpcMainInvokeEvent): Promise<PrivyOpenResult> => {
    if (!privyDir) {
      return privyOpenRefusal('unavailable')
    }

    // The port is fixed (it is the Privy-allowlisted origin). If another
    // process holds it, loading the URL would hand that process our origin
    // and the preload's session relay — so the window does not open at all.
    // The port may have been held only at launch (another copy of the app still quitting): try once more.
    if (server && !server.listening && !(await listenAgain(server))) {
      return privyOpenRefusal(listenRefusalReason(lastListenErrorCode))
    }

    if (!server?.listening) {
      return privyOpenRefusal(listenRefusalReason(lastListenErrorCode))
    }

    openLoginWindow(privyDir, getMainWindow)

    return { ok: true }
  })

  ipcMain.handle(LOGOUT_CHANNEL, () => logoutPrivy(getMainWindow))

  const readStatus = createPrivyStatusReader(() => {
    // Same rule as OPEN_CHANNEL: never load the origin when another process
    // may hold the port — its page would receive our partition's preload.
    if (!privyDir || !server?.listening) {
      return Promise.resolve(null)
    }

    const partition = session.fromPartition(PRIVY_PARTITION)
    const signedInMarker = signInRecord?.read() ?? null

    if (!shouldProbePrivyPartition(signedInMarker, () => hasPartitionData(partition.getStoragePath()))) {
      return Promise.resolve({ ...SIGNED_OUT_PAYLOAD })
    }

    partition.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

    const generation = signInGeneration
    const abort = new AbortController()
    const end = () => abort.abort()

    abortStatusProbe = end

    return probePrivySession({
      createWindow: () => createStatusWindow(privyDir),
      onWindowEvent: listener => {
        const handler = (event: IpcMainEvent, payload: unknown) => listener(event, payload)

        ipcMain.on(WINDOW_EVENT_CHANNEL, handler)

        return () => ipcMain.removeListener(WINDOW_EVENT_CHANNEL, handler)
      },
      url: `${PRIVY_ORIGIN}/privy.html`,
      signal: abort.signal
    }).then(answer => {
      if (abortStatusProbe === end) {
        abortStatusProbe = null
      }

      // Overtaken by a sign-in or sign-out: that event is the newer truth.
      if (generation !== signInGeneration) {
        return null
      }

      signInRecord?.record(answer)

      if (answer) {
        announceSession(answer)
      }

      return answer
    })
  })

  // A sign-in or sign-out by hand this launch (signInGeneration > 0) is newer news than the update: no hint then.
  ipcMain.handle(STATUS_CHANNEL, () =>
    readStatus().then(answer =>
      answer && signInGeneration === 0 && signedOutByUpdate(updateBoot, answer)
        ? { ...answer, afterUpdate: true as const }
        : answer
    )
  )

  // The scan channels answer the app's own renderer only (the Privy window runs this preload on a remote page).
  // A refused sender gets null. No guard = refuse.
  const scanIpc = guardedHandler(ipcMain, isTrustedSender ?? (() => false))

  scanIpc.handle(SCAN_CHANNEL, (_event: unknown, address: unknown): Promise<InftScanResult> => {
    if (typeof address !== 'string') {
      return Promise.resolve({ ok: false, source: 'none', agents: [], error: 'bad address' })
    }

    return homeScanner.full(address)
  })

  scanIpc.handle(SCAN_TICK_CHANNEL, (_event: unknown, address: unknown, checkedIds: unknown) =>
    homeScanner.tick(address, checkedIds)
  )

  ipcMain.handle(PROFILE_RESOLVE_CHANNEL, (_event: IpcMainInvokeEvent, item: unknown): Promise<ResolvedInftProfile> => {
    const it = item as InftScanItem | null | undefined

    if (!it || typeof it !== 'object' || typeof it.contract !== 'string' || typeof it.tokenId !== 'string') {
      return Promise.resolve({
        slug: '',
        name: '',
        soulMd: '',
        identity: null,
        source: 'none',
        identityVerified: false,
        soulVerified: false,
        error: 'bad item'
      })
    }

    return resolveInftProfile(it)
  })
}
