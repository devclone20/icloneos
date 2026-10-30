/**
 * MCP — the OAuth sign-in procedure for one server.
 *
 * It left `tab.tsx` so that file stays under 900 lines (front E3d5's hard
 * size gate) and because it is a procedure, not view state: no hooks, every
 * input explicit. The body is the one that shipped, unchanged — only its
 * surroundings are now named.
 */
import { authMcpServer, getMcpOAuthFlow, type McpTestResult, type ProfileScope } from '@/hermes'
import type { Translations } from '@/i18n'
import { errorMessage } from '@/iclone-shared/errors'
import { completeMcpDesktopOAuth } from '@/lib/mcp-dashboard-oauth'
import { probeCache, probeKey } from '@/lib/mcp-probe-cache'
import { type McpServers } from '@/lib/mcp-servers'
import { notify, notifyError } from '@/store/notifications'
import type { HermesConfigRecord } from '@/types/hermes'

import type { Probe } from './servers'

interface AuthenticateDeps {
  dirty: boolean
  m: Translations['settings']['mcp']
  patchDraft: (mutate: (doc: McpServers) => McpServers) => void
  profile?: ProfileScope
  /** Bumped on every profile switch: a result from the profile we left is dropped. */
  profileEpoch: { current: number }
  resetDraft: (entries: McpServers) => void
  scopeProfileKey: string
  servers: McpServers
  setAuthing: (name: null | string) => void
  // The shape `hermesConfigCacheWriter` hands out (a react-query cache writer):
  // value OR updater, and an updater may only answer a record or `undefined`.
  setConfig: (update: (current: HermesConfigRecord | undefined) => HermesConfigRecord | undefined) => void
  setProbes: (update: (current: Record<string, Probe>) => Record<string, Probe>) => void
  silentReload: () => Promise<void>
}

/** Runs the desktop OAuth flow for `serverName` and folds the result back in. */
export function makeAuthenticate(deps: AuthenticateDeps) {
  const {
    dirty,
    m,
    patchDraft,
    profile,
    profileEpoch,
    resetDraft,
    scopeProfileKey,
    servers,
    setAuthing,
    setConfig,
    setProbes,
    silentReload
  } = deps

  return async function authenticate(serverName: string) {
    const epoch = profileEpoch.current
    setAuthing(serverName)
    setProbes(current => ({ ...current, [serverName]: 'probing' }))

    try {
      const flow = await completeMcpDesktopOAuth({
        serverName,
        start: name => authMcpServer(name, profile ?? undefined),
        status: flowId => getMcpOAuthFlow(flowId, profile ?? undefined),
        openExternal: url => window.hermesDesktop.openExternal(url)
      })

      const result: McpTestResult = { ok: true, tools: flow.tools ?? [] }

      // Bail if the user switched profiles mid-flow — this result is profile A's.
      if (profileEpoch.current !== epoch) {
        return
      }

      setProbes(current => ({ ...current, [serverName]: result }))
      // Cache under the POST-auth fingerprint (auth: oauth) on success — that's
      // the config the mount effect will read back, so it hits this entry.
      const probedConfig = result.ok ? { ...servers[serverName], auth: 'oauth' } : servers[serverName]
      probeCache.set(probeKey(serverName, probedConfig, scopeProfileKey), { at: Date.now(), result })

      if (result.ok) {
        // The endpoint persisted `auth: oauth` — mirror it locally.
        const nextServers = { ...servers, [serverName]: { ...servers[serverName], auth: 'oauth' } }
        setConfig(current => (current ? { ...current, mcp_servers: nextServers } : current))

        // Mirror `auth: oauth` into the editor too. If we only reset a clean
        // draft, a dirty draft keeps the pre-auth text and the next Save would
        // drop the freshly-persisted auth field — so patch the dirty draft in
        // place instead of clobbering the user's other edits.
        if (dirty) {
          patchDraft(doc => (doc[serverName] ? { ...doc, [serverName]: { ...doc[serverName], auth: 'oauth' } } : doc))
        } else {
          resetDraft(nextServers)
        }

        notify({
          kind: 'success',
          title: m.authenticatedTitle,
          message: m.authenticatedMessage(serverName, result.tools.length)
        })
        void silentReload()
      } else if (result.error) {
        notifyError(new Error(result.error), serverName)
      }
    } catch (err) {
      if (profileEpoch.current !== epoch) {
        return
      }

      setProbes(current => ({
        ...current,
        [serverName]: { ok: false, error: errorMessage(err), tools: [] }
      }))
      notifyError(err, serverName)
    } finally {
      if (profileEpoch.current === epoch) {
        setAuthing(null)
      }
    }
  }
}
