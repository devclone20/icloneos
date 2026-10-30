/**
 * MCP — the probe lane, lifted out of `./tab.tsx` VERBATIM (E3d5 r3, ticket
 * T1): the tab had no room left under the 900-line ceiling, and probing is one
 * coherent job anyway — spawn/connect each enabled server, cache the result per
 * (server, fingerprint, profile), and feed the cost overlay from it.
 *
 * Every epoch guard is the original's: a probe that lands after the profile
 * switched belongs to the old profile and is dropped, never painted.
 */
import { useEffect, useRef, useState } from 'react'

import { type ProfileScope, testMcpServer } from '@/hermes'
import { errorMessage } from '@/iclone-shared/errors'
import { estimateServerTokens, serverUsageCount } from '@/lib/mcp-cost'
import { PROBE_TTL_MS, probeCache, probeKey } from '@/lib/mcp-probe-cache'
import { type McpServers } from '@/lib/mcp-servers'

import { loadMcpUsage, type Probe, type ServerCost, serverEnabled } from './servers'

interface McpProbeLane {
  costFor: (serverName: string, server: Record<string, unknown>) => ServerCost
  probes: Record<string, Probe>
  /** Drops every probe and the usage counts: called on a profile switch, so
   *  profile A's statuses never paint beside profile B's servers. */
  resetLane: () => void
  runProbe: (serverName: string) => Promise<void>
  setProbes: React.Dispatch<React.SetStateAction<Record<string, Probe>>>
}

export function useMcpProbes({
  appProfile,
  profile,
  profileEpoch,
  scopeProfileKey,
  servers
}: {
  appProfile: null | string
  profile?: ProfileScope
  /** Bumped by the tab on every profile switch; read, never written, here. */
  profileEpoch: React.MutableRefObject<number>
  scopeProfileKey: string
  servers: McpServers
}): McpProbeLane {
  const [probes, setProbes] = useState<Record<string, Probe>>({})
  const probesRef = useRef(probes)
  probesRef.current = probes

  // 30-day per-tool call counts (registry names). null = analytics unavailable
  // or not loaded yet — the cost overlay then omits usage entirely.
  const [toolCalls30d, setToolCalls30d] = useState<null | Record<string, number>>(null)

  const runProbe = async (serverName: string) => {
    const epoch = profileEpoch.current
    const key = probeKey(serverName, servers[serverName], scopeProfileKey)
    setProbes(current => ({ ...current, [serverName]: 'probing' }))

    try {
      const result = await testMcpServer(serverName, profile ?? undefined)

      // Drop the result if the profile changed mid-probe — it belongs to A.
      if (profileEpoch.current !== epoch) {
        return
      }

      probeCache.set(key, { at: Date.now(), result })
      setProbes(current => ({ ...current, [serverName]: result }))
    } catch (err) {
      if (profileEpoch.current !== epoch) {
        return
      }

      const result = { ok: false, error: errorMessage(err), tools: [] }
      probeCache.set(key, { at: Date.now(), result })
      setProbes(current => ({ ...current, [serverName]: result }))
    }
  }

  // It should just know: probe enabled servers as config arrives — but through
  // the cache, so revisiting the page doesn't respawn/reconnect the fleet.
  useEffect(() => {
    for (const [serverName, server] of Object.entries(servers)) {
      if (!serverEnabled(server) || probesRef.current[serverName] !== undefined) {
        continue
      }

      const cached = probeCache.get(probeKey(serverName, server, scopeProfileKey))

      if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
        setProbes(current => ({ ...current, [serverName]: cached.result }))
      } else {
        void runProbe(serverName)
      }
    }
    // Re-run only when the server set changes; runProbe is recreated every
    // render and adding it would re-probe the fleet on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers])

  // Cosmetic 30-day usage counts for the cost overlay — cached module-wide per
  // scope profile, epoch-guarded like the probes so a slow profile-A fetch
  // can't paint into profile B.
  useEffect(() => {
    const epoch = profileEpoch.current

    void loadMcpUsage(scopeProfileKey, profile ?? appProfile ?? null).then(value => {
      if (profileEpoch.current === epoch) {
        setToolCalls30d(value)
      }
    })
    // `profileEpoch` is a ref handed in by the tab: stable for the component's
    // whole life, and adding it would only re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeProfileKey, profile, appProfile])

  // Overlay inputs for one server: token estimate from its (successful) probe,
  // 30-day uses from analytics. Both halves degrade to null independently.
  const costFor = (serverName: string, server: Record<string, unknown>): ServerCost => {
    const probe = probes[serverName]

    return {
      tokens: probe && probe !== 'probing' && probe.ok ? estimateServerTokens(server, probe.tools) : null,
      uses: toolCalls30d ? serverUsageCount(serverName, toolCalls30d) : null
    }
  }

  const resetLane = () => {
    setProbes({})
    setToolCalls30d(null)
  }

  return { costFor, probes, resetLane, runProbe, setProbes }
}
