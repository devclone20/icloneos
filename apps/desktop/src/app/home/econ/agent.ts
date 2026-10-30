/**
 * EconomyOS — who the active iNFT is on Virtuals (`acp agent whoami`).
 *
 * The identity heads every Dock window and is the same for all five apps, so
 * it is read once per iNFT and kept for the session (a name or avatar does not
 * change under you; a manual refresh re-reads it).
 */
import { useStore } from '@nanostores/react'
import { atom, computed } from 'nanostores'
import { useEffect, useMemo } from 'react'

import { acpJson, type AcpResult, asRecord, str } from './cli'
import type { AgentIdentity } from './types'

const IDENTITY_TTL_MS = 10 * 60 * 1000

export const $agentIdentity = atom<Record<string, AgentIdentity | null>>({})

function shapeIdentity(raw: unknown): AgentIdentity | null {
  const root = asRecord(raw)

  if (!root || !str(root, 'id')) {
    return null
  }

  const rating = root.rating

  return {
    id: str(root, 'id'),
    name: str(root, 'name'),
    description: str(root, 'description'),
    imageUrl: str(root, 'imageUrl'),
    walletAddress: str(root, 'walletAddress'),
    solWalletAddress: str(root, 'solWalletAddress'),
    role: str(root, 'role'),
    rating: typeof rating === 'number' ? rating : null,
    createdAt: str(root, 'createdAt'),
    builderCode: str(root, 'builderCode')
  }
}

export async function loadAgentIdentity(inftId: string, slug: string, force = false): Promise<AgentIdentity | null> {
  const result = await acpJson(inftId, slug, ['agent', 'whoami', '--json'], shapeIdentity, {
    ttlMs: IDENTITY_TTL_MS,
    force
  })

  const identity = result.ok ? result.data : null

  $agentIdentity.set({ ...$agentIdentity.get(), [slug]: identity })

  return identity
}

/** The identity for one iNFT — loads on first use, then from the store. */
export function useAgentIdentity(
  inftId: string | undefined,
  slug: string | undefined,
  configured: boolean
): AgentIdentity | null {
  // Select this slug only: another iNFT's identity landing must not
  // re-render this window.
  const store = useMemo(() => computed($agentIdentity, all => (slug ? all[slug] : undefined)), [slug])
  const known = useStore(store)

  useEffect(() => {
    if (inftId && slug && configured && known === undefined) {
      void loadAgentIdentity(inftId, slug)
    }
  }, [configured, inftId, known, slug])

  return known ?? null
}

const CHAINS_TTL_MS = 60 * 60_000

/** `acp chain list` — the market and the wallet read it with one argv and one
 *  TTL, so whichever opens first warms the other (the cache keeps the raw
 *  answer; each app shapes it its own way). */
export const CHAINS_ARGV: readonly string[] = ['chain', 'list', '--json']

export function chainListReader<T>(
  shape: (raw: unknown) => T
): (inftId: string, slug: string, options?: { force?: boolean }) => Promise<AcpResult<T>> {
  return (inftId, slug, options = {}) =>
    acpJson(inftId, slug, [...CHAINS_ARGV], shape, { ttlMs: CHAINS_TTL_MS, force: options.force })
}
