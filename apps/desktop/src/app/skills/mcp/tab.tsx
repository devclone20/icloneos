/**
 * Capabilities → MCP — OUR tab (E3 decision #8, 2026-10-18). The 1 862-line
 * single file this came from is split: the pure logic is `./servers.ts`, the
 * row and its controls `./row.tsx`, the inspector `./config.tsx`, the catalog
 * `./catalog.tsx` and the output channel `./logs.tsx`. What is left here is
 * the tab itself — the config document, the probes and the writes.
 *
 * `../mcp-tab.tsx` re-exports `McpTab` from here: it is a published plugin-SDK
 * symbol (`src/sdk/index.ts`), so its module path never moves.
 */
import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { type CodeEditorApi } from '@/components/chat/code-editor'
import { JsonDocumentEditor } from '@/components/chat/json-document-editor'
import {
  getMcpCatalog,
  type HermesGateway,
  type McpCatalogEntry,
  type ProfileScope,
  profileScopeKey,
  saveMcpServers
} from '@/hermes'
import { useI18n } from '@/i18n'
import { type McpImportEntry } from '@/lib/mcp-import'
import { serverFingerprint } from '@/lib/mcp-probe-cache'
import { getServers, type McpServers } from '@/lib/mcp-servers'
import { toggleToolInServer } from '@/lib/mcp-tool-filter'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $activeSessionId } from '@/store/session'

import { hermesConfigCacheWriter, useHermesConfigRecord } from '../../hooks/use-config-record'
import { useOnProfileSwitch } from '../../hooks/use-on-profile-switch'
import { DetailPane } from '../../master-detail'
import { IcPageButton, IcPageState } from '../../profiles/ic-page'
import { useDeepLinkHighlight } from '../../settings/use-deep-link-highlight'

import { makeAuthenticate } from './authenticate'
import { McpCatalog } from './catalog'
import { McpImportButton, ServerConfig } from './config'
import { installMcpSeedSeam, type McpSeed, mcpSeed } from './dev-seed'
import { McpLogs } from './logs'
import { McpRow } from './row'
import {
  MCP_CATALOG_KEY,
  parseServersDoc,
  scanServerBlocks,
  serverEnabled,
  STARTER_ENTRY,
  statusLine,
  statusOf,
  wrapDoc
} from './servers'
import { useMcpProbes } from './use-mcp-probes'

export function McpTab({ gateway, profile }: { gateway: HermesGateway | null; profile?: ProfileScope }) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const activeSessionId = useStore($activeSessionId)

  // The profile this tab configures: the Capabilities profile-scope selector's
  // choice (`profile`) when set, otherwise the app-wide active profile. Every
  // fetch/save below is scoped to it, and it keys the config/catalog/probe
  // caches so switching the selector refetches and never shows another
  // profile's servers (AGENTS.md scope-in-key). When no override is passed this
  // resolves to $activeGatewayProfile, so behavior is identical to before.
  const appProfile = useStore($activeGatewayProfile)
  const scopeProfileKey = profile != null ? profileScopeKey(profile) : normalizeProfileKey(appProfile)

  // Shared config cache (see use-config-record): revisiting the tab paints the
  // cached record instantly; mutations write through `setConfig` and stay
  // visible to the other settings surfaces.
  const {
    data: config,
    isLoading: configLoading,
    isError: configFailed,
    error: configError,
    refetch: refetchConfig,
    dataUpdatedAt: configUpdatedAt,
    errorUpdatedAt: configErroredAt
  } = useHermesConfigRecord(profile)

  const setConfig = hermesConfigCacheWriter(profile)

  // True from a profile switch until the config query resettles for the new
  // profile. Until then `config` (and thus `servers`) still holds profile A's
  // data, so any persist would write A's server list into B — block mutations.
  const [profilePending, setProfilePending] = useState(false)
  const staleConfigStamp = useRef<null | number>(null)
  const staleErrorStamp = useRef<null | number>(null)

  const [saving, setSaving] = useState(false)

  // Blocks the browser until an OAuth flow lands a token; also reset on profile
  // switch, so declared up here alongside the other per-profile view state.
  const [authing, setAuthing] = useState<null | string>(null)

  // Master document draft. `docVersion` remounts the editor when the draft is
  // regenerated programmatically (list-side mutations); `dirty` guards user
  // edits from being clobbered by those regenerations.
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [docVersion, setDocVersion] = useState(0)
  const [logSource, setLogSource] = useState<'stdio' | 'agent'>('stdio')

  // Selection IS the editor cursor: whichever server block contains it is the
  // configured server on the left. Cursor outside every block → the list.
  const editorApi = useRef<CodeEditorApi | null>(null)
  const [cursor, setCursor] = useState(0)
  const blocks = useMemo(() => scanServerBlocks(draft), [draft])

  const activeBlock = useMemo(
    () => blocks.find(block => cursor >= block.from && cursor <= block.to) ?? null,
    [blocks, cursor]
  )

  const selected = activeBlock?.name ?? null

  const focusServer = (name: string) => {
    const block = blocks.find(b => b.name === name)

    if (block) {
      // Land just inside the key so the block claims the cursor.
      editorApi.current?.setCursor(block.from + 1)
      setCursor(block.from + 1)
    }
  }

  // DEV-only stub fleet (see ./dev-seed). A fresh user has no MCP server, so
  // without it the rows, their actions and the inspector cannot be driven on a
  // lab window at all. Always null in a production build.
  const [seed, setSeed] = useState<McpSeed | null>(() => mcpSeed())

  useEffect(() => {
    installMcpSeedSeam(setSeed)
  }, [])

  const servers = useMemo(() => seed?.servers ?? getServers(config ?? null), [config, seed])

  // Config/document order, not alphabetical — the list mirrors mcp.json.
  const names = useMemo(() => Object.keys(servers), [servers])

  // Key by the SCOPED profile — installed/enabled badges are per-profile, so
  // sharing one cache across profiles would flash the previous profile's state
  // on switch. When no selector override is set this is the active profile,
  // identical to before.
  const catalogQuery = useQuery({
    queryKey: [...MCP_CATALOG_KEY, scopeProfileKey],
    queryFn: () => getMcpCatalog(profile ?? undefined),
    staleTime: 5 * 60_000
  })

  const catalog = useMemo(() => {
    const live = catalogQuery.data?.entries ?? []

    return seed ? [...seed.catalog, ...live] : live
  }, [catalogQuery.data, seed])

  // The catalog SECTION of the unified list only offers entries that aren't
  // already configured — installed servers appear once, in the fleet list
  // above, with live status. Match by catalog `installed` flag or a config
  // entry under the same name (covers a just-saved doc the catalog refetch
  // hasn't caught up with yet).
  const availableCatalog = useMemo(
    () => catalog.filter((entry: McpCatalogEntry) => !entry.installed && !(entry.name in servers)),
    [catalog, servers]
  )

  const descriptionFor = (serverName: string, server: Record<string, unknown>): null | string => {
    const lower = serverName.toLowerCase()

    const match = catalog.find(
      entry =>
        entry.name.toLowerCase() === lower ||
        (entry.url && entry.url === server.url) ||
        (entry.command && entry.command === server.command)
    )

    return match?.description ?? null
  }

  const resetDraft = (entries: McpServers) => {
    setDraft(wrapDoc(entries))
    setDirty(false)
    setDocVersion(version => version + 1)
  }

  // Mirror a list-side mutation into a dirty draft without losing the user's
  // other edits. Unparseable drafts are left alone — save resolves the race.
  const patchDraft = (mutate: (doc: McpServers) => McpServers) => {
    try {
      setDraft(wrapDoc(mutate(parseServersDoc(draft))))
      setDocVersion(version => version + 1)
    } catch {
      // Draft is mid-edit / invalid JSON; the user's text wins until save.
    }
  }

  // Seed the editor draft from config exactly once, the first time it lands.
  // Background refetches thereafter update the list but must not clobber an
  // in-progress edit — the draft is the user's until they save or reset.
  const draftSeeded = useRef(false)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    // profilePending: config still holds the PREVIOUS profile's record right
    // after a switch — seeding from it would latch the wrong profile's doc.
    if (!config || profilePending) {
      return
    }

    if (!draftSeeded.current) {
      draftSeeded.current = true
      resetDraft(getServers(config))

      return
    }

    if (dirty || names.length === 0) {
      return
    }

    // Heal the early-boot race: the first config snapshot can land before the
    // backend has mcp_servers assembled, seeding (and latching) an empty doc
    // while later refetches fill the list — saving would then wipe the real
    // servers. A PRISTINE empty draft reseeds when servers arrive; any user
    // edit (dirty) still always wins.
    try {
      if (Object.keys(parseServersDoc(draft)).length === 0) {
        resetDraft(servers)
      }
    } catch {
      // Mid-edit / invalid JSON — the user's text wins.
    }
  }, [config, dirty, draft, names, profilePending, servers])

  // Bumped on every profile switch. Async probe/auth completions capture the
  // epoch at call time and bail if it changed, so a slow profile-A request can't
  // write its result into profile B's state after the user switched.
  const profileEpoch = useRef(0)

  // Probing is its own lane (`./use-mcp-probes`): the per-server status, the
  // 30-day usage counts and the cost overlay they feed.
  const { costFor, probes, resetLane, runProbe, setProbes } = useMcpProbes({
    appProfile,
    profile,
    profileEpoch,
    scopeProfileKey,
    servers
  })

  // A profile switch invalidates the config query (see store/profile.ts), which
  // refetches the new backend's mcp.json. Reset ALL per-profile view state — the
  // draft (incl. a dirty one, so profile A's edits can't be saved into B), its
  // seed latch, probes, and cursor — so everything reseeds for the new profile.
  // The probe cache is already profile-keyed, so this just forces a re-probe.
  useOnProfileSwitch(() => {
    profileEpoch.current += 1
    draftSeeded.current = false
    resetLane()
    setCursor(0)
    setAuthing(null)
    setDirty(false)
    setDraft('')
    setDocVersion(version => version + 1)
    // Mark stale until the config query replaces profile A's data — guards
    // sidebar mutations from persisting A's server list into B mid-refetch.
    staleConfigStamp.current = configUpdatedAt
    staleErrorStamp.current = configErroredAt
    setProfilePending(true)
  })

  // Clear once the config query settles for the new profile: dataUpdatedAt bumps
  // on a fresh success, errorUpdatedAt on a fresh failure. Releasing on error too
  // means a failed refetch surfaces the retry UI instead of leaving mutations
  // silently no-op forever.
  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (
      profilePending &&
      staleConfigStamp.current !== null &&
      (configUpdatedAt !== staleConfigStamp.current || configErroredAt !== staleErrorStamp.current)
    ) {
      setProfilePending(false)
      staleConfigStamp.current = null
      staleErrorStamp.current = null
    }
  }, [profilePending, configUpdatedAt, configErroredAt])

  useDeepLinkHighlight({
    block: 'nearest',
    elementId: serverName => `mcp-server-${serverName}`,
    onResolve: focusServer,
    param: 'server',
    ready: serverName => blocks.some(block => block.name === serverName)
  })

  // First-class OAuth: opens the system browser, blocks until the flow lands a
  // token (verified on disk — a friendly tools/list is not proof), then the
  // auth result doubles as the probe (it carries the tool list).
  const authenticate = makeAuthenticate({
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
    silentReload: () => silentReload()
  })

  // Config writes reach live sessions immediately — no manual "Reload MCP".
  const silentReload = async () => {
    if (!gateway) {
      return
    }

    try {
      await gateway.request('reload.mcp', { confirm: true, session_id: activeSessionId ?? undefined })
    } catch (err) {
      notifyError(err, m.reloadFailed)
    }
  }

  // Whole-map replace (NOT saveHermesConfig, which deep-merges and so can never
  // delete a server, drop `enabled: false`, or remove a nested field). Only
  // after the replace lands do we write the cache through + reload live sessions.
  // Returns false when the profile switched mid-save: the write hit profile A's
  // backend (correct), but the client-side cache/editor now belong to B, so the
  // caller must skip its post-await writes.
  const persist = async (nextServers: McpServers): Promise<boolean> => {
    if (seed) {
      // A seeded fleet is not a real one: writing it would put stub servers in
      // the user's config.yaml. Dev-only, with the seed (see ./dev-seed).
      return false
    }

    const epoch = profileEpoch.current
    await saveMcpServers(nextServers, profile ?? undefined)

    if (profileEpoch.current !== epoch) {
      return false
    }

    setConfig(current => ({ ...current, mcp_servers: nextServers }))
    void silentReload()

    return true
  }

  // A catalog install wrote a new server into config.yaml on the backend —
  // refresh the catalog (installed state) and the config, then RECONCILE THE
  // EDITOR DRAFT with the fresh servers. Without this a dirty draft (or even a
  // clean one the seed never refreshes) would omit the new server, and the next
  // whole-map Save would silently drop it.
  const onCatalogInstalled = async () => {
    void catalogQuery.refetch()
    const { data } = await refetchConfig()
    const nextServers = getServers(data ?? null)

    if (dirty) {
      // Keep the user's in-progress edits (doc wins), add any server the install
      // introduced that the draft doesn't have yet.
      patchDraft(doc => ({ ...nextServers, ...doc }))
    } else {
      resetDraft(nextServers)
    }

    void silentReload()
  }

  const withEnabled = (server: Record<string, unknown>, enabled: boolean) => {
    const next = { ...server }

    if (enabled) {
      delete next.enabled
    } else {
      next.enabled = false
    }

    return next
  }

  const setServerEnabled = async (serverName: string, enabled: boolean) => {
    if (profilePending) {
      return
    }

    const next = withEnabled(servers[serverName], enabled)

    try {
      if (!(await persist({ ...servers, [serverName]: next }))) {
        return
      }

      if (dirty) {
        patchDraft(doc => (doc[serverName] ? { ...doc, [serverName]: withEnabled(doc[serverName], enabled) } : doc))
      } else {
        resetDraft({ ...servers, [serverName]: next })
      }

      if (enabled) {
        void runProbe(serverName)
      }
    } catch (err) {
      notifyError(err, m.saveFailed)
    }
  }

  // Per-tool gating writes the server's `tools.include`/`tools.exclude` and
  // persists like any other config change (immediate reload of live sessions).
  // The probe still lists every discovered tool; the filter decides which ones
  // the agent actually registers.
  const toggleTool = async (serverName: string, toolName: string) => {
    const base = servers[serverName]

    if (!base || profilePending) {
      return
    }

    const next = toggleToolInServer(base, toolName)

    try {
      if (!(await persist({ ...servers, [serverName]: next }))) {
        return
      }

      if (dirty) {
        patchDraft(doc =>
          doc[serverName] ? { ...doc, [serverName]: toggleToolInServer(doc[serverName], toolName) } : doc
        )
      } else {
        resetDraft({ ...servers, [serverName]: next })
      }
    } catch (err) {
      notifyError(err, m.saveFailed)
    }
  }

  const removeServer = async (serverName: string) => {
    if (profilePending) {
      return
    }

    setSaving(true)

    try {
      const next = { ...servers }
      delete next[serverName]

      if (!(await persist(next))) {
        return
      }

      if (dirty) {
        patchDraft(doc => {
          const patched = { ...doc }
          delete patched[serverName]

          return patched
        })
      } else {
        resetDraft(next)
      }

      setCursor(0)
    } catch (err) {
      notifyError(err, m.removeFailed)
    } finally {
      setSaving(false)
    }
  }

  // "+" seeds a starter entry into the document (unique key) and marks it
  // dirty — naming happens in the editor, like every other mcp.json.
  const addServer = () => {
    if (profilePending) {
      return
    }

    let base: McpServers

    try {
      base = parseServersDoc(draft)
    } catch {
      base = { ...servers }
    }

    let key = 'my-server'

    for (let i = 2; key in base; i++) {
      key = `my-server-${i}`
    }

    const nextDraft = wrapDoc({ ...base, [key]: STARTER_ENTRY })
    setDraft(nextDraft)
    setDirty(true)
    setDocVersion(version => version + 1)

    // Focus the fresh block once the editor remounts with the new doc.
    const from = nextDraft.indexOf(`"${key}"`)

    if (from >= 0) {
      requestAnimationFrame(() => {
        editorApi.current?.setCursor(from + 1)
        setCursor(from + 1)
      })
    }
  }

  // Paste-anything import: merge parsed entries into the draft exactly like
  // addServer seeds its starter — dirty draft, unique keys, focus the first
  // new block. Saving stays an explicit step, so the user can fix placeholder
  // env values (YOUR_KEY, …) in the editor first.
  const importServers = (entries: McpImportEntry[]) => {
    if (profilePending || entries.length === 0) {
      return
    }

    let base: McpServers

    try {
      base = parseServersDoc(draft)
    } catch {
      base = { ...servers }
    }

    let firstKey: null | string = null

    for (const entry of entries) {
      let key = entry.name

      for (let i = 2; key in base; i++) {
        key = `${entry.name}-${i}`
      }

      base = { ...base, [key]: entry.config }
      firstKey ??= key
    }

    const nextDraft = wrapDoc(base)
    setDraft(nextDraft)
    setDirty(true)
    setDocVersion(version => version + 1)

    if (firstKey) {
      const from = nextDraft.indexOf(`"${firstKey}"`)

      if (from >= 0) {
        requestAnimationFrame(() => {
          editorApi.current?.setCursor(from + 1)
          setCursor(from + 1)
        })
      }
    }
  }

  const saveDoc = async () => {
    if (profilePending) {
      return
    }

    let entries: McpServers

    try {
      entries = parseServersDoc(draft)
    } catch (err) {
      notifyError(err, m.invalidJson)

      return
    }

    setSaving(true)

    const prevServers = servers

    try {
      if (!(await persist(entries))) {
        return
      }

      resetDraft(entries)
      // Keep only probes for servers that survived AND kept the same config;
      // removed OR edited entries drop their probe so the mount effect re-probes
      // the new shape (the cache also misses on the changed fingerprint).
      setProbes(current =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([name]) =>
              name in entries && serverFingerprint(entries[name]) === serverFingerprint(prevServers[name] ?? {})
          )
        )
      )
      notify({ kind: 'success', title: m.savedTitle, message: m.savedMessage('mcp.json') })
    } catch (err) {
      notifyError(err, m.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  // Cached data paints instantly; a spinner only ever shows on the first-ever
  // load, and a failed load gets a real retry — never a silent blank pane.
  if (configFailed && !config) {
    return (
      <IcPageState
        action={<IcPageButton onClick={() => void refetchConfig()}>{m.reload}</IcPageButton>}
        description={m.failedLoad}
        kind="error"
        title={m.failedLoad}
      />
    )
  }

  if (!config) {
    return <IcPageState kind="loading" title={configLoading ? m.loading : t.skills.loading} />
  }

  // Selection may reference an unsaved block (freshly pasted) — fall back to
  // the draft's parsed entry so the config pane can still describe it.
  const savedEntry = selected ? servers[selected] : undefined

  const draftEntry = (() => {
    if (!selected || savedEntry) {
      return undefined
    }

    try {
      return parseServersDoc(draft)[selected]
    } catch {
      return undefined
    }
  })()

  const activeEntry = savedEntry ?? draftEntry

  return (
    <div className="icsk__mcp">
      {/* LEFT: the focused block's server config, or the unified fleet+catalog list. */}
      <aside className="icsk__mcp-aside">
        {selected && activeEntry ? (
          <ServerConfig
            authing={authing === selected}
            cost={costFor(selected, activeEntry)}
            description={descriptionFor(selected, activeEntry)}
            entry={activeEntry}
            name={selected}
            onAuthenticate={() => void authenticate(selected)}
            onBack={() => setCursor(0)}
            onProbe={() => void runProbe(selected)}
            onRemove={() => void removeServer(selected)}
            onToggle={checked => void setServerEnabled(selected, checked)}
            onToggleTool={toolName => void toggleTool(selected, toolName)}
            probe={probes[selected]}
            saved={savedEntry !== undefined}
            saving={saving}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col p-2">
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
              {/* ONE coherent column: the configured fleet on top, the
                  Nous-approved catalog below it. Installed entries live in the
                  fleet list (with live status), so the catalog section only
                  offers what's NOT installed yet — no duplicate rows, no tab
                  flipping to find the install button. */}
              {/* Geometry mirrors ListStrip (mb-1 h-6 pl-2) so this header
                  lands on the exact line the sort link occupies in the
                  Skills/Tools views. */}
              <div className="icsk__mcp-head">
                <span className="icsk__mcp-head-label">{m.tabServers}</span>
                <McpImportButton disabled={profilePending} onImport={importServers} />
              </div>
              {names.length === 0 ? (
                <IcPageState
                  action={<IcPageButton onClick={addServer}>{m.newServer}</IcPageButton>}
                  description={m.emptyDesc}
                  kind="empty"
                  title={m.emptyTitle}
                />
              ) : (
                <>
                  {names.map(serverName => {
                    const server = servers[serverName]
                    const status = statusOf(server, probes[serverName])
                    const cost = costFor(serverName, server)

                    return (
                      <McpRow
                        active={false}
                        busy={saving}
                        enabled={serverEnabled(server)}
                        key={serverName}
                        name={serverName}
                        onProbe={() => void runProbe(serverName)}
                        onRemove={() => void removeServer(serverName)}
                        onSelect={() => focusServer(serverName)}
                        onToggle={checked => void setServerEnabled(serverName, checked)}
                        status={status}
                        statusText={statusLine(m, status, probes[serverName], server, cost)}
                        unused={
                          serverEnabled(server) &&
                          status === 'ok' &&
                          cost.tokens !== null &&
                          cost.tokens > 0 &&
                          cost.uses === 0
                        }
                      />
                    )
                  })}
                  <button aria-label={m.newServer} className="icsk__addrow" onClick={addServer} type="button">
                    <Plus aria-hidden="true" size={14} />
                    <span className="icsk__addrow-label">{m.newServer}</span>
                  </button>
                </>
              )}
              {(catalogQuery.isLoading || availableCatalog.length > 0) && (
                <>
                  <div className="icsk__mcp-head icsk__mcp-head--split">
                    <span className="icsk__mcp-head-label">{m.tabCatalog}</span>
                  </div>
                  <McpCatalog
                    entries={availableCatalog}
                    loading={catalogQuery.isLoading}
                    onInstalled={onCatalogInstalled}
                    profile={profile}
                  />
                </>
              )}
            </div>
          </div>
        )}
      </aside>

      {/* RIGHT: the mcp.json editor, logs hard-pinned below. */}
      <main className="icsk__mcp-main">
        <JsonDocumentEditor
          apiRef={editorApi}
          disabled={saving}
          filePath="mcp.json"
          header={
            <>
              mcp.json
              {dirty && <span aria-hidden className="size-1.5 rounded-full bg-current/60" />}
            </>
          }
          highlight={activeBlock ? { from: activeBlock.from, to: activeBlock.to } : null}
          initialValue={draft}
          onChange={next => {
            setDraft(next)
            setDirty(true)
          }}
          onCursorChange={setCursor}
          onFormatJsonError={error => notifyError(new Error(error), m.invalidJson)}
          onSave={() => void saveDoc()}
          remountKey={docVersion}
          trailing={
            <IcPageButton disabled={saving || !dirty} onClick={() => void saveDoc()} tone="quiet">
              {saving ? t.common.saving : t.common.save}
            </IcPageButton>
          }
        />
        <DetailPane
          actions={
            <span className="flex items-center gap-1.5">
              {(['stdio', 'agent'] as const).map(kind => (
                <button
                  aria-selected={logSource === kind}
                  className="icsk__tab icsk__logtab"
                  key={kind}
                  onClick={() => setLogSource(kind)}
                  role="tab"
                  type="button"
                >
                  {kind}
                </button>
              ))}
            </span>
          }
          defaultHeight={176}
          id="mcp-logs"
          title={<span className="icsk__note">{selected && savedEntry ? selected : m.allServers}</span>}
        >
          <McpLogs emptyLabel={m.noOutput} server={selected && savedEntry ? selected : null} source={logSource} />
        </DetailPane>
      </main>
    </div>
  )
}
