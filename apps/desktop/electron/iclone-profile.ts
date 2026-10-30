/**
 * The iNFT profile engine — builds ONE profile per iNFT, side by side with the
 * iNFT detection engine (iclone-privy.ts).
 *
 * The chain the engine follows (owner's doctrine): the token's on-chain
 * metadata carries an `agent_bootstrap` block → `repo` (the living GitHub
 * template) and `genesis` (the sealed Irys backup, permanent) → `SOUL.md`
 * (the persona) and `identity.json` (the names/hashes) → a Hermes profile
 * named after the iNFT. The engine resolves that material here; the renderer
 * turns it into a real Hermes profile via `profiles.create`.
 *
 * One iNFT = one isolated profile: #5 and #7 are two minds, two SOUL.md files,
 * two chat sections. Nothing bleeds between them.
 */
import { createHash } from 'node:crypto'

import { profileSlugFor } from '../src/iclone-shared/inft-slug'

import type { InftBootstrap, InftScanItem } from './iclone-privy'

export interface ResolvedInftProfile {
  /** Valid Hermes profile name — lowercase, digits, hyphens. */
  slug: string
  /** Display name (the token's own name, e.g. "#5"). */
  name: string
  /** The soul with {NAME}/{N} filled from this token. */
  soulMd: string
  /** The identity.json, parsed — null when unreachable. */
  identity: Record<string, unknown> | null
  /** Where the soul actually came from. */
  source: 'genesis' | 'repo' | 'none'
  /** Whether identity.json's bytes match bootstrap.identity_sha256. */
  identityVerified: boolean
  /** Whether SOUL.md's bytes match bootstrap.soul_sha256 (may be false when
   *  the hash targets a different soul file — reported, never fatal). */
  soulVerified: boolean
  error?: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** `https://github.com/o/r` → `https://raw.githubusercontent.com/o/r/HEAD/<path>`. */
function githubRaw(repo: string, path: string): string {
  const clean = repo.replace(/\/+$/, '').replace(/^https?:\/\/github\.com\//, '')

  return `https://raw.githubusercontent.com/${clean}/HEAD/${path}`
}

function genesisUrl(genesis: string, path: string): string {
  return `${genesis.replace(/\/+$/, '')}/${path}`
}

// A soul is a text file; anything bigger is not one. The cap is enforced on
// the stream, so a hostile host cannot make the main process buffer a gigabyte.
const SOUL_MAX_BYTES = 256 * 1024

/** https only (a bootstrap is on-chain data anyone can write — it must never
 *  point the main process at a plain-http or loopback host), and bounded. */
async function fetchText(url: string, timeoutMs = 20_000): Promise<string | null> {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (
    parsed.protocol !== 'https:' ||
    /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|\[fc|\[fd)/i.test(parsed.hostname)
  ) {
    return null
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })

    if (!res.ok || !res.body) {
      return null
    }

    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0

    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      total += value.byteLength

      if (total > SOUL_MAX_BYTES) {
        await reader.cancel()

        return null
      }

      chunks.push(value)
    }

    return Buffer.concat(chunks).toString('utf8')
  } catch {
    return null
  }
}

/** Resolve one iNFT's profile material from its on-chain bootstrap. Never
 *  throws — a dead repo or a slow gateway yields `source: 'none'` with an
 *  `error`, and the caller decides what to show. */
export async function resolveInftProfile(item: InftScanItem): Promise<ResolvedInftProfile> {
  const slug = profileSlugFor(item.contract, item.tokenId)
  const name = item.name || `#${item.tokenId}`
  const b: InftBootstrap | null = item.bootstrap

  if (!b) {
    return {
      slug,
      name,
      soulMd: '',
      identity: null,
      source: 'none',
      identityVerified: false,
      soulVerified: false,
      error: 'No agent_bootstrap block — a plain NFT or a pre-reveal token has no soul to build a profile from.'
    }
  }

  // Soul: the sealed Irys genesis first (permanent), the living repo second.
  let soulRaw: string | null = null
  let source: ResolvedInftProfile['source'] = 'none'

  if (b.genesis) {
    soulRaw = await fetchText(genesisUrl(b.genesis, 'SOUL.md'))

    if (soulRaw !== null) {
      source = 'genesis'
    }
  }

  if (soulRaw === null && b.repo) {
    soulRaw = await fetchText(githubRaw(b.repo, 'SOUL.md'))

    if (soulRaw !== null) {
      source = 'repo'
    }
  }

  if (soulRaw === null) {
    return {
      slug,
      name,
      soulMd: '',
      identity: null,
      source: 'none',
      identityVerified: false,
      soulVerified: false,
      error: 'The soul is unreachable — neither the Irys genesis nor the repo answered.'
    }
  }

  // Identity (names/hashes) — genesis first, then repo.
  let identity: Record<string, unknown> | null = null
  let identityRaw: string | null = null

  if (b.genesis) {
    identityRaw = await fetchText(genesisUrl(b.genesis, 'identity.json'))
  }

  if (identityRaw === null && b.repo) {
    identityRaw = await fetchText(githubRaw(b.repo, 'identity.json'))
  }

  if (identityRaw !== null) {
    try {
      identity = JSON.parse(identityRaw) as Record<string, unknown>
    } catch {
      identity = null
    }
  }

  const identityVerified = Boolean(b.identity_sha256 && identityRaw && sha256(identityRaw) === b.identity_sha256)
  const soulVerified = Boolean(b.soul_sha256 && sha256(soulRaw) === b.soul_sha256)

  // The profile must know everything about its token — the marketplace name,
  // collection line, number, contract, chain and its OpenSea link. Prepend a
  // sealed identity header, then fill the soul's {NAME}/{N} placeholders.
  // The chain comes from identity.json (chain.network) — the renderer's source
  // carries only contract+tokenId, never `chain`, so deriving it here is both
  // correct and immune to a missing field.
  const collectionLine = identity && typeof identity.collection_line === 'string' ? identity.collection_line : ''

  const identityChain =
    identity && typeof identity.chain === 'object' ? (identity.chain as Record<string, unknown>) : null

  const chainName =
    identityChain && typeof identityChain.network === 'string' && identityChain.network
      ? identityChain.network
      : 'ethereum'

  const openseaUrl = `https://opensea.io/assets/${chainName.toLowerCase()}/${item.contract}/${item.tokenId}`

  const identityHeader = [
    '<!-- iNFT identity (sealed on-chain — do not rephrase the identity statement) -->',
    `marketplace_name: ${name}`,
    `collection_line: ${collectionLine}`,
    `collection_number: ${item.tokenId}`,
    `contract: ${item.contract}`,
    `chain: ${chainName}`,
    `opensea: ${openseaUrl}`,
    ''
  ].join('\n')

  const soulMd = `${identityHeader}\n${soulRaw.replace(/\{NAME\}/g, name).replace(/\{N\}/g, item.tokenId)}`

  return { slug, name, soulMd, identity, source, identityVerified, soulVerified }
}
