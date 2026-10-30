import './skills-page.css'

/**
 * Capabilities — OUR page (E3 decision #8, 2026-10-18): the frame, the tab
 * strip, the rails, the inspectors, the states and every control are our own
 * (`../profiles/ic-page.tsx` on the `--ic-*` tokens, plus `skills-page.css`).
 * The old upstream page shell, master-detail, overlay panel and component
 * library are gone from this directory; what it reuses is logic only — the
 * Hermes skills/toolsets/analytics calls, the scope stores, the route hooks and
 * the per-toolset settings panels.
 *
 * The page's own logic lives beside it and is tested on its own:
 * `skill-logic.ts` (filters, sort, frontmatter) and `mcp/servers.ts`.
 *
 * Three things the surface it replaces did not do:
 * - a failed load is an inline error with a retry, not a spinner that never ends;
 * - no skills at all reads as an empty state while the search box stays usable;
 * - both of those states can be driven on a real window (`dev-fault.ts`).
 *
 * `frame="bare"`: `contrib/wiring.tsx` still wraps this view in the shared
 * overlay panel, so the page draws no second card. One prop flips it back the
 * day that wrapper is dropped (E3a).
 */
import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ArchiveSkillConfirmDialog } from '@/app/learning/archive-skill-confirm-dialog'
import { CodeEditor } from '@/components/chat/code-editor'
import type { DesktopRosterAgent } from '@/global'
import {
  editLearningNode,
  getLearningNode,
  getProfiles,
  getSkills,
  getToolsets,
  getUsageAnalytics,
  type ProfileScope,
  profileScopeKey,
  setSkillEnabled,
  setToolsetEnabled
} from '@/hermes'
import { useI18n } from '@/i18n'
import { enSkills } from '@/i18n/en'
import { isDesktopToolsetVisible } from '@/lib/desktop-toolsets'
import { queryClient } from '@/lib/query-client'
import { invalidateSlashCompletions } from '@/lib/slash-completion-cache'
import { useStoreSelector } from '@/lib/use-session-slice'
import { $gateway, activeGatewayConnectionId } from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import type { SkillInfo, ToolsetInfo } from '@/types/hermes'

import { useOnProfileSwitch } from '../hooks/use-on-profile-switch'
import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import {
  IcConfirmDialog,
  IcDialog,
  IcHiddenLabel,
  IcPage,
  IcPageButton,
  IcPageState,
  IcSelect
} from '../profiles/ic-page'
import { toolsetDisplayLabel } from '../settings/helpers'
import { warnsOnDisable } from '../settings/skills-settings-model'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { useSkillCatalogSync } from './catalog-sync'
import { injectedFaultError, installSkillsFaultSeam, isInjectedFault, skillsFault } from './dev-fault'
import { EmbeddedHubPicker } from './embedded-hub-picker'
import { McpTab } from './mcp-tab'
import { filteredSkills, filteredToolsets, usageOf, visibleToolsetCount } from './skill-logic'
import { SkillsTab } from './skills-tab'
import { $skillsSortDesc, $toolsetsSortDesc } from './store'
import { ToolsetsTab } from './toolsets-tab'

// 'hub' is gone as a top-level tab — the Skills Hub browser lives inside the
// Skills tab now (EmbeddedHubPicker below the installed list). Legacy
// `?tab=hub` links fall back to 'skills' via useRouteEnumParam.
const SKILLS_MODES = ['skills', 'toolsets', 'mcp'] as const

// Skills + toolsets live in the RQ cache so switching tabs/pages paints the
// cached lists instantly (no reload flash) and mount only fires a deduped
// background refetch. A profile swap globally invalidates (see store/profile),
// so these plain keys refetch against the new backend automatically.
// Both are extended with the Capabilities scope key at the call sites so every
// scoped profile keeps its own cached copy (prefix invalidations still match).
// A transient first attempt self-heals (gateway start-up is the slowest cold
// path this page has), but the armed dev fault is NOT transient: retrying it
// would only delay the error branch the probe is waiting for.
const retryUnlessInjected = (count: number, error: unknown) => !isInjectedFault(error) && count < 2

// 300 ms, then 600 ms — react-query's own default starts at a full second,
// which is longer than this page's entire cold load (~525 ms for the skills
// list on lab 2, three runs). A retry nobody notices is the point.
const FAULT_RETRY_BASE_MS = 300
const retryDelayFor = (attempt: number) => FAULT_RETRY_BASE_MS * 2 ** attempt

const SKILLS_QUERY_KEY = ['skills-list'] as const
const TOOLSETS_QUERY_KEY = ['toolsets-list'] as const

// The dev fault is read INSIDE the loader, never captured at render: a probe
// sets the field and the page's own Retry then sees it on the refetch.
const loadSkills = async (scope: ProfileScope): Promise<SkillInfo[]> => {
  const fault = skillsFault()

  if (fault === 'error') {
    throw injectedFaultError('skills')
  }

  return fault === 'empty' ? [] : getSkills(scope)
}

const loadToolsets = async (scope: ProfileScope): Promise<ToolsetInfo[]> => {
  const fault = skillsFault()

  if (fault === 'error') {
    throw injectedFaultError('toolsets')
  }

  return fault === 'empty' ? [] : getToolsets(scope)
}

// Per-tool call counts come from a 365-day message scan — heavy, and purely
// cosmetic (Toolsets usage badges). Cache the result module-wide with a TTL so
// bouncing between tabs/pages doesn't re-run the scan every time. Keyed by
// the Capabilities scope profile: analytics are profile-scoped, so a scope or
// app-profile switch must not show the previous profile's counts.
// `useRefreshHotkey` still forces a fresh pull.
const TOOL_CALLS_TTL_MS = 10 * 60 * 1000
const toolCallsCache = new Map<string, { at: number; value: Record<string, number> }>()

async function loadToolCalls(
  scopeKey: string,
  scopeProfile: ProfileScope,
  force = false
): Promise<Record<string, number>> {
  const cached = toolCallsCache.get(scopeKey)

  if (!force && cached && Date.now() - cached.at < TOOL_CALLS_TTL_MS) {
    return cached.value
  }

  const analytics = await getUsageAnalytics(365, scopeProfile)

  const value = Object.fromEntries((analytics.tools ?? []).map(e => [e.tool, e.count]))

  toolCallsCache.set(scopeKey, { at: Date.now(), value })

  return value
}

interface SkillsViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
  /** Embedded mode (plugin dialogs — e.g. Bot Mode's Advanced section): tab
   *  state lives in local React state instead of the route's `?tab=` param,
   *  so an embedding dialog never fights the page router. */
  embedded?: boolean
  /** Pin the WHOLE view to one profile: the scope selector is hidden and
   *  every tab reads/writes THAT profile. This is the plugin door — Bot Mode
   *  renders the real Capabilities surface pinned to a bot. */
  fixedProfile?: string
  /** The URL search param the tab strip rides. Defaults to `?tab=`; the
   *  Settings pane that hosts this page passes its own (`?cview=`) because
   *  `?tab=` already selects the Settings rail's pane (front K2). */
  tabParam?: string
  /** Pin the view to a REGISTERED gateway connection alongside `fixedProfile`:
   *  every read/write routes to that machine's backend instead of the active
   *  gateway. `''`/`'local'` mean the local pool. This is Bot Mode's
   *  remote-target door — a bot living on another registered gateway gets the
   *  live surface pointed at ITS backend. Ignored without `fixedProfile`. */
  fixedConnection?: string
}

export function SkillsView({
  embedded = false,
  fixedConnection,
  fixedProfile,
  setStatusbarItemGroup: _setStatusbarItemGroup,
  tabParam = 'tab'
}: SkillsViewProps) {
  const { t } = useI18n()
  // Both hooks run unconditionally (rules of hooks); embedded picks the local
  // one so tab clicks inside a dialog don't rewrite the page URL.
  const routeTab = useRouteEnumParam(tabParam, SKILLS_MODES, 'skills')
  const localTab = useState<(typeof SKILLS_MODES)[number]>('skills')
  const [mode, setMode] = embedded ? localTab : routeTab
  // $gateway only feeds the MCP tab — gate the subscription so Skills/Toolsets
  // tabs don't re-render on connect/disconnect/reconnect.
  const gateway = useStoreSelector($gateway, g => (mode === 'mcp' ? g : null))

  const [query, setQuery] = useState('')

  // The hub picker hosts a full docs-site iframe — the single most expensive
  // thing on this page. It mounts lazily (first time the Skills tab is shown)
  // and then STAYS mounted but hidden across tab switches, so bouncing to
  // Tools/MCP and back never reloads the site. Derived-state pattern: flips
  // once, during render, never back.
  const [hubMounted, setHubMounted] = useState(mode === 'skills')

  if (mode === 'skills' && !hubMounted) {
    setHubMounted(true)
  }

  // Capabilities scope selector: which profile's Skills/Tools/MCP config we're
  // editing — and on WHICH gateway. A profile belongs to one gateway, so on a
  // multi-connection desktop the selector offers every (connection, profile)
  // pair from the union agent roster and an explicit pick routes every
  // read/write to that machine's backend. Defaults to the app-wide active
  // profile (unchanged behavior). A `fixedProfile` (+ optional
  // `fixedConnection`) pins the scope outright (selector hidden).
  const activeProfile = useStore($activeGatewayProfile)
  const [scopeOverride, setScopeOverride] = useState<null | string | { connectionId: string; profile: string }>(null)

  const scopeProfile: ProfileScope = useMemo(
    () =>
      fixedProfile
        ? fixedConnection
          ? { connectionId: fixedConnection, profile: fixedProfile }
          : fixedProfile
        : (scopeOverride ?? activeProfile ?? null),
    [activeProfile, fixedConnection, fixedProfile, scopeOverride]
  )

  const scopeKey = profileScopeKey(scopeProfile)

  // The registry connection an explicit override pins — null for the ambient
  // active-profile path and for fixed-profile pins without a connection.
  const scopeConnectionId =
    scopeProfile && typeof scopeProfile === 'object' ? (scopeProfile.connectionId ?? '').trim() || 'local' : null

  // Scoped to a DIFFERENT backend than the window's active gateway? The MCP
  // tab's live-reload RPC rides the active gateway socket, which would reload
  // the wrong machine — withhold it for cross-backend scopes.
  const crossBackendScope = scopeConnectionId !== null && scopeConnectionId !== (activeGatewayConnectionId() ?? 'local')

  const { data: profilesData } = useQuery({
    queryKey: ['capabilities-profiles'],
    queryFn: getProfiles,
    staleTime: 60_000,
    // Pinned scope never shows the selector, so don't fetch the roster for it.
    enabled: !fixedProfile
  })

  // v2 multi-connection registry: cheap local IPC to learn whether more than
  // one gateway is registered. Only then is the (heavier) union agent roster
  // fetched to feed the selector — single-connection setups keep the exact
  // legacy profiles list. Both feature-detected for older Electron mains.
  const registryBridge = window.hermesDesktop?.connections
  const rosterBridge = window.hermesDesktop?.getAgentRoster

  const { data: registryData } = useQuery({
    queryKey: ['capabilities-connections-registry'],
    queryFn: () => registryBridge!.list(),
    staleTime: 60_000,
    enabled: !fixedProfile && Boolean(registryBridge) && Boolean(rosterBridge)
  })

  const multiConnection = (registryData?.connections.length ?? 0) > 1

  const { data: rosterData } = useQuery({
    queryKey: ['capabilities-agent-roster'],
    queryFn: () => rosterBridge!(),
    staleTime: 60_000,
    enabled: !fixedProfile && multiConnection
  })

  const { data: skills, isError: skillsFailed } = useQuery({
    queryKey: [...SKILLS_QUERY_KEY, scopeKey],
    queryFn: () => loadSkills(scopeProfile),
    staleTime: 0,
    // Two bounded attempts, then the page owns the failure (an inline error
    // naming which list lost, with a Retry that refetches). The armed dev
    // fault is excluded so the error branch paints on the first attempt.
    retry: retryUnlessInjected,
    retryDelay: retryDelayFor
  })

  const { data: toolsets, isError: toolsetsFailed } = useQuery({
    queryKey: [...TOOLSETS_QUERY_KEY, scopeKey],
    queryFn: () => loadToolsets(scopeProfile),
    staleTime: 0,
    retry: retryUnlessInjected,
    retryDelay: retryDelayFor
  })

  // Optimistic write-through against the scoped Skills key: toggles/bulk/
  // archive repaint instantly; the next background refetch reconciles.
  const setSkills = useCallback(
    (fn: (cur: SkillInfo[] | undefined) => SkillInfo[] | undefined) =>
      queryClient.setQueryData<SkillInfo[]>([...SKILLS_QUERY_KEY, scopeKey], prev => fn(prev) ?? prev),
    [scopeKey]
  )

  // tool name -> call count over the analytics window. null = still loading
  // (the row shows its tool count instead); {} = loaded empty / unavailable.
  const [toolCalls, setToolCalls] = useState<Record<string, number> | null>(null)
  // Bumped on profile switch so a slow analytics load from profile A can't set
  // toolCalls after the user moved to B.
  const toolCallsEpoch = useRef(0)
  const skillsSortDesc = useStore($skillsSortDesc)
  const toolsetsSortDesc = useStore($toolsetsSortDesc)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)
  const [selectedToolset, setSelectedToolset] = useState<string | null>(null)

  const refreshCapabilities = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: TOOLSETS_QUERY_KEY })
    ])

    invalidateSlashCompletions()

    // An explicit refresh is the one time we bypass the analytics TTL — but
    // only if the badges are already on screen; otherwise let the lazy load
    // pick it up when Toolsets is first shown. Guard the async set against a
    // profile/scope switch landing before it resolves.
    if (toolCallsCache.size > 0) {
      const epoch = toolCallsEpoch.current

      loadToolCalls(scopeKey, scopeProfile, true)
        .then(value => toolCallsEpoch.current === epoch && setToolCalls(value))
        .catch(() => toolCallsEpoch.current === epoch && setToolCalls({}))
    }
  }, [scopeKey, scopeProfile])

  const refreshToolsets = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: TOOLSETS_QUERY_KEY })
  }, [])

  useRefreshHotkey(refreshCapabilities)

  // DEV-only: let a CDP probe arm the empty/error branches from outside (the
  // preload bridge is frozen, so there is no other way in). Arming invalidates
  // both lists, which is why the seam needs the page's keys.
  useEffect(() => {
    installSkillsFaultSeam(() => {
      void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: TOOLSETS_QUERY_KEY })
    })
  }, [])

  // Per-tool call counts feed ONLY the Toolsets tab's usage badges/sort, and
  // the query behind them is a 365-day message scan — heavy. Fetch it lazily
  // the first time Toolsets is shown, never on Skills or MCP, so it can't
  // starve the MCP tab's config load. Absent → toolsets sort A–Z until it lands.
  useEffect(() => {
    if (mode !== 'toolsets' || toolCalls !== null) {
      return
    }

    let cancelled = false
    // Guard the setter by epoch too: when toolCalls is already null at switch
    // time, setToolCalls(null) is a no-op so this effect never re-runs to flip
    // `cancelled` — the epoch check catches that gap.
    const epoch = toolCallsEpoch.current
    const live = () => !cancelled && toolCallsEpoch.current === epoch

    loadToolCalls(scopeKey, scopeProfile)
      .then(value => live() && setToolCalls(value))
      .catch(() => live() && setToolCalls({}))

    return () => void (cancelled = true)
  }, [mode, scopeKey, scopeProfile, toolCalls])

  // Learned/local skills are editable + archivable, mirroring the memory
  // graph (same /api/learning/node endpoints — delete archives, restorable
  // via `hermes curator restore`).
  const [skillEditor, setSkillEditor] = useState<null | { content: string; name: string }>(null)
  const [skillDraft, setSkillDraft] = useState('')
  const [skillSaving, setSkillSaving] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<null | string>(null)
  // Bumped on profile switch so an in-flight openSkillEditor fetch from profile
  // A can't reopen the editor with A's content after switching to B.
  const skillEditorEpoch = useRef(0)

  // On an app-wide profile switch the analytics cache is scope-keyed, but our
  // local toolCalls state isn't — leaving it non-null would keep the lazy
  // effect from ever re-running, so badges/sort would show the previous
  // profile's counts. Reset to null so the next Toolsets view reloads for the
  // active profile. The switch also drops any scope override — the user just
  // changed what "here" means — and the open editor/archive dialog, whose
  // targets belong to the profile we just left.
  useOnProfileSwitch(() => {
    toolCallsEpoch.current += 1
    setToolCalls(null)
    setScopeOverride(null)
    skillEditorEpoch.current += 1
    setSkillEditor(null)
    setSkillDraft('')
    setArchiveTarget(null)
  })

  const visibleSkills = useMemo(
    () => (skills ? filteredSkills(skills, query, skillsSortDesc) : []),
    [query, skills, skillsSortDesc]
  )

  const visibleToolsets = useMemo(
    () => (toolsets ? filteredToolsets(toolsets, query, toolCalls ?? {}, toolsetsSortDesc) : []),
    [query, toolCalls, toolsets, toolsetsSortDesc]
  )

  // Bulk actions ("All" master switch, "Disable unused") and the master-switch
  // state target the WHOLE tab, never the search-filtered view — a tab-wide
  // control that silently scoped to the current query would be a lie.
  const bulkSkills = skills ?? []
  const bulkToolsets = useMemo(() => (toolsets ?? []).filter(ts => isDesktopToolsetVisible(ts.name)), [toolsets])

  // Installed-name set for the hub picker's already-installed guard — the
  // UNFILTERED list on purpose (search must not make a skill look absent).
  const installedSkillNames = useMemo(() => new Set((skills ?? []).map(s => s.name)), [skills])

  // Keep a valid selection: fall back to the first visible row when the
  // current selection is filtered out (or nothing is selected yet).
  const activeSkill = useMemo(
    () => visibleSkills.find(s => s.name === selectedSkill) ?? visibleSkills[0] ?? null,
    [selectedSkill, visibleSkills]
  )

  const activeToolset = useMemo(
    () => visibleToolsets.find(ts => ts.name === selectedToolset) ?? visibleToolsets[0] ?? null,
    [selectedToolset, visibleToolsets]
  )

  // Turning OFF a skill the app's runtime instructions name (economyos,
  // consent) asks first: the agent cannot follow instructions that point at a
  // skill it may not open. The guard came with the retired Settings pane
  // (front K2) and is the one behaviour of it that is not a control.
  const [disableGuard, setDisableGuard] = useState<null | SkillInfo>(null)

  // The write, optimistic: the row repaints before the call and reverts if it
  // fails. It RETHROWS instead of notifying, so a caller that owns a beat (the
  // disable guard's dialog, below) can show the failure inline.
  async function applySkillToggle(skill: SkillInfo, enabled: boolean) {
    setSkills(current => current?.map(row => (row.name === skill.name ? { ...row, enabled } : row)) ?? current)

    try {
      await setSkillEnabled(skill.name, enabled, scopeProfile)
      // A disabled skill loses its `/name` command, so the composer's cached
      // `/` list has to be dropped along with the row repaint.
      invalidateSlashCompletions()
    } catch (err) {
      setSkills(
        current => current?.map(row => (row.name === skill.name ? { ...row, enabled: !enabled } : row)) ?? current
      )
      throw err
    }
  }

  // A flip straight off the switch is silent on success (a toast per flip would
  // spam rapid customization); its errors are a toast, because the switch has
  // nowhere to put one.
  async function handleToggleSkill(skill: SkillInfo, enabled: boolean) {
    try {
      await applySkillToggle(skill, enabled)
    } catch (err) {
      notifyError(err, t.skills.failedToUpdate(skill.name))
    }
  }

  async function handleToggleToolset(toolset: ToolsetInfo, enabled: boolean) {
    const scopedToolsetKey = [...TOOLSETS_QUERY_KEY, scopeKey]

    const writeScoped = (fn: (cur: ToolsetInfo[] | undefined) => ToolsetInfo[] | undefined) =>
      queryClient.setQueryData<ToolsetInfo[]>(scopedToolsetKey, prev => fn(prev) ?? prev)

    writeScoped(
      current =>
        current?.map(row => (row.name === toolset.name ? { ...row, enabled, available: enabled } : row)) ?? current
    )

    try {
      await setToolsetEnabled(toolset.name, enabled, scopeProfile)
    } catch (err) {
      writeScoped(
        current =>
          current?.map(row => (row.name === toolset.name ? { ...row, enabled: !enabled, available: !enabled } : row)) ??
          current
      )
      notifyError(err, t.skills.failedToUpdate(toolsetDisplayLabel(toolset)))
    }
  }

  // Sequential on purpose: each toggle is a config read-modify-write on the
  // backend; parallel calls would race the disabled-list save.
  async function bulkApply(skillTargets: SkillInfo[], toolsetTargets: ToolsetInfo[], enabled: boolean) {
    if (bulkBusy || skillTargets.length + toolsetTargets.length === 0) {
      return
    }

    setBulkBusy(true)

    let done = 0

    try {
      for (const row of skillTargets) {
        await setSkillEnabled(row.name, enabled, scopeProfile)
        setSkills(cur => cur?.map(r => (r.name === row.name ? { ...r, enabled } : r)) ?? cur)
        done += 1
      }

      for (const row of toolsetTargets) {
        await setToolsetEnabled(row.name, enabled, scopeProfile)
        queryClient.setQueryData<ToolsetInfo[]>(
          [...TOOLSETS_QUERY_KEY, scopeKey],
          cur => cur?.map(r => (r.name === row.name ? { ...r, enabled, available: enabled } : r)) ?? cur
        )
        done += 1
      }

      notify({ kind: 'success', title: t.skills.bulkUpdated(done), message: '' })
    } catch (err) {
      notifyError(err, t.skills.failedToUpdate(mode === 'skills' ? t.skills.tabSkills : t.skills.tabToolsets))
    } finally {
      invalidateSlashCompletions()
      setBulkBusy(false)
    }
  }

  const bulkToggle = (enabled: boolean) =>
    mode === 'skills'
      ? bulkApply(
          bulkSkills.filter(row => row.enabled !== enabled),
          [],
          enabled
        )
      : bulkApply(
          [],
          bulkToolsets.filter(row => row.enabled !== enabled),
          enabled
        )

  // "Never used" = zero recorded activity. The pruning move for a 100+ skill
  // install: keep the workhorses, shed the noise.
  const disableUnused = () =>
    bulkApply(
      bulkSkills.filter(skill => skill.enabled && usageOf(skill) === 0),
      [],
      false
    )

  const allSkillsEnabled = bulkSkills.length > 0 && bulkSkills.every(s => s.enabled)
  const allToolsetsEnabled = bulkToolsets.length > 0 && bulkToolsets.every(ts => ts.enabled)

  const openSkillEditor = async (name: string) => {
    const epoch = skillEditorEpoch.current

    try {
      const node = await getLearningNode(name, scopeProfile)

      if (skillEditorEpoch.current !== epoch) {
        return
      }

      setSkillEditor({ content: node.content, name })
      setSkillDraft(node.content)
    } catch (err) {
      notifyError(err, name)
    }
  }

  const saveSkillEdit = async () => {
    if (!skillEditor) {
      return
    }

    setSkillSaving(true)

    try {
      await editLearningNode(skillEditor.name, skillDraft, scopeProfile)
      notify({
        kind: 'success',
        title: t.skills.skillUpdated,
        message: t.skills.appliesToNewSessions(skillEditor.name)
      })
      setSkillEditor(null)
      void refreshCapabilities()
    } catch (err) {
      notifyError(err, skillEditor.name)
    } finally {
      setSkillSaving(false)
    }
  }

  // Selecting a different scope is the same staleness hazard as an app-wide
  // profile switch: in-flight analytics belong to the previous scope's cache
  // key, and an open skill editor / archive dialog targets the PREVIOUS
  // scope's skill (a save/archive would hit the new one). Reset both here —
  // this handler is the only way the scope changes besides an app profile
  // switch, which useOnProfileSwitch already covers.
  //
  // Selector option values are `connectionId::profile` on multi-connection
  // desktops (the roster path) and bare profile names otherwise, so one
  // handler decodes both.
  const changeScope = (value: string) => {
    const sep = value.indexOf('::')

    // Roster picks (`connectionId::profile`) stay objects — a `local::` pick
    // must PIN the local pool even while a remote gateway is active. Legacy
    // bare-name picks stay strings so cache keys and routing are unchanged.
    const next: ProfileScope = sep >= 0 ? { connectionId: value.slice(0, sep), profile: value.slice(sep + 2) } : value

    if (profileScopeKey(next) === scopeKey) {
      return
    }

    setScopeOverride(next as string | { connectionId: string; profile: string })
    toolCallsEpoch.current += 1
    setToolCalls(null)
    skillEditorEpoch.current += 1
    setSkillEditor(null)
    setSkillDraft('')
    setArchiveTarget(null)
  }

  // Scope-selector rows. Multi-connection desktops list every reachable
  // (connection, profile) agent from the union roster — the selected profile
  // is configured ON ITS OWN GATEWAY. Otherwise the legacy per-profile list.
  const scopeOptions: { label: string; value: string }[] = useMemo(() => {
    if (multiConnection && rosterData?.agents?.length) {
      const activeId = activeGatewayConnectionId() ?? 'local'

      return rosterData.agents.map((agent: DesktopRosterAgent) => ({
        label:
          agent.connectionId === activeId
            ? `${agent.profile} — ${agent.connectionLabel} (current)`
            : `${agent.profile} — ${agent.connectionLabel}`,
        value: `${agent.connectionId}::${agent.profile}`
      }))
    }

    return (profilesData?.profiles ?? []).map(p => ({
      label: p.is_default ? 'Hermes (default)' : p.name,
      value: p.name
    }))
  }, [multiConnection, profilesData, rosterData])

  // The selector's current value must match one option's value exactly. On the
  // roster path an ambient (non-override) scope is the active gateway's
  // profile, which lives at `activeConnectionId::profile`.
  const scopeSelectValue = useMemo(() => {
    if (scopeProfile && typeof scopeProfile === 'object') {
      return `${(scopeProfile.connectionId ?? '').trim() || 'local'}::${scopeProfile.profile ?? ''}`
    }

    if (multiConnection && rosterData?.agents?.length) {
      return `${activeGatewayConnectionId() ?? 'local'}::${normalizeProfileKey(scopeProfile)}`
    }

    return scopeProfile ?? ''
  }, [multiConnection, rosterData, scopeProfile])

  // Moved in from the retired `Settings → Skills` pane (front K2): the catalog
  // Re-sync, the counts + last-sync line and the standing off-warning. The
  // hook runs on every tab; only the Skills tab shows its controls, because
  // that is the list they are about.
  const catalogSync = useSkillCatalogSync(skills, () => {
    void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
  })

  const tabs = [
    { id: 'skills' as const, label: t.skills.tabSkills, meta: skills?.length ?? null },
    { id: 'toolsets' as const, label: t.skills.tabToolsets, meta: toolsets ? visibleToolsetCount(toolsets) : null },
    { id: 'mcp' as const, label: t.skills.tabMcp, meta: null }
  ]

  const loadFailed = (skillsFailed || toolsetsFailed) && (!skills || !toolsets)

  return (
    <IcPage
      actions={mode === 'skills' ? catalogSync.actions : null}
      frame="bare"
      subtitle={mode === 'skills' ? catalogSync.subtitle : null}
      title={t.sidebar.nav.skills}
    >
      <div className="icsk__shell">
        <div className="icsk__bar">
          <div aria-label={t.sidebar.nav.skills} className="icsk__tabs" role="tablist">
            {tabs.map(tab => (
              <button
                aria-controls="icsk-panel"
                aria-selected={mode === tab.id}
                className="icsk__tab"
                data-ic-tab={tab.id}
                key={tab.id}
                onClick={() => setMode(tab.id)}
                role="tab"
                type="button"
              >
                <span>{tab.label}</span>
                {tab.meta === null ? null : <span className="icsk__tab-meta">{tab.meta}</span>}
              </button>
            ))}
          </div>
          {/* Shown above EVERY tab: the user configures ANY profile's
              capabilities — on any registered gateway — without switching the
              whole app. Only meaningful with >1 option. */}
          {scopeOptions.length > 1 ? (
            <div className="icsk__scope">
              <IcHiddenLabel id="icsk-scope-label">{t.skills.configuringProfile}</IcHiddenLabel>
              <span aria-hidden="true">{t.skills.configuringProfile}</span>
              <IcSelect id="icsk-scope" onValueChange={changeScope} options={scopeOptions} value={scopeSelectValue} />
            </div>
          ) : null}
        </div>
        <div
          aria-label={tabs.find(tab => tab.id === mode)?.label}
          className="icsk__content"
          id="icsk-panel"
          role="tabpanel"
        >
          {mode === 'mcp' ? (
            // The gateway instance backs ONLY the live `reload.mcp` RPC, and
            // it is the ACTIVE gateway's socket — for a scope pinned to a
            // different backend that RPC would hot-reload the wrong machine's
            // MCP servers, so it is withheld (config edits still apply on that
            // backend's next session).
            <McpTab gateway={crossBackendScope ? null : gateway} key={`mcp-${scopeKey}`} profile={scopeProfile} />
          ) : loadFailed ? (
            <IcPageState
              action={
                <IcPageButton onClick={() => void refreshCapabilities()} tone="accent">
                  {t.skills.refresh}
                </IcPageButton>
              }
              // Which list lost is the cause the user can act on; the thrown
              // message is never shown (it can carry a path or a host).
              description={skillsFailed && toolsetsFailed ? t.skills.toolsetsRefreshFailed : undefined}
              kind="error"
              title={skillsFailed ? t.skills.skillsLoadFailed : t.skills.toolsetsRefreshFailed}
            />
          ) : !skills || !toolsets ? (
            <IcPageState kind="loading" title={t.skills.loading} />
          ) : mode === 'skills' ? (
            <SkillsTab
              allEnabled={allSkillsEnabled}
              busy={bulkBusy}
              onArchive={() => activeSkill && setArchiveTarget(activeSkill.name)}
              onBulkToggle={enabled => void bulkToggle(enabled)}
              onDisableUnused={() => void disableUnused()}
              onEdit={() => activeSkill && void openSkillEditor(activeSkill.name)}
              onFlipSort={() => $skillsSortDesc.set(!$skillsSortDesc.get())}
              onQueryChange={setQuery}
              onSelect={setSelectedSkill}
              onToggle={(skill, enabled) => {
                if (!enabled && warnsOnDisable(skill.name)) {
                  setDisableGuard(skill)

                  return
                }

                void handleToggleSkill(skill, enabled)
              }}
              profile={scopeProfile}
              query={query}
              rowNotes={catalogSync.rowNotes}
              selected={activeSkill}
              skills={visibleSkills}
              sortDesc={skillsSortDesc}
            />
          ) : (
            <ToolsetsTab
              allEnabled={allToolsetsEnabled}
              busy={bulkBusy}
              onBulkToggle={enabled => void bulkToggle(enabled)}
              onConfiguredChange={refreshToolsets}
              onFlipSort={() => $toolsetsSortDesc.set(!$toolsetsSortDesc.get())}
              onQueryChange={setQuery}
              onSelect={setSelectedToolset}
              onToggle={(toolset, enabled) => void handleToggleToolset(toolset, enabled)}
              profile={scopeProfile}
              query={query}
              selected={activeToolset}
              sortDesc={toolsetsSortDesc}
              toolCalls={toolCalls}
              toolsets={visibleToolsets}
            />
          )}
        </div>
        {/* Hub picker OUTSIDE the tab switch: it lazy-mounts the first time
            Skills is shown, then stays mounted (hidden) across Tools/MCP so
            the docs-site iframe never reloads on a tab bounce. No scope key on
            purpose — the picker fetches nothing; scope rides the `profile`
            prop into each install call, and remounting on scope change would
            reload the whole site for no data benefit. */}
        {hubMounted ? (
          <div className={mode === 'skills' ? 'icsk__hub' : 'icsk__hub icsk__hub--hidden'}>
            <EmbeddedHubPicker hidden={mode !== 'skills'} installedNames={installedSkillNames} profile={scopeProfile} />
          </div>
        ) : null}
      </div>
      {skillEditor ? (
        <IcDialog
          busy={skillSaving}
          footer={
            <>
              <IcPageButton onClick={() => setSkillEditor(null)} tone="quiet">
                {t.common.cancel}
              </IcPageButton>
              <IcPageButton disabled={skillSaving} onClick={() => void saveSkillEdit()} tone="accent">
                {skillSaving ? t.common.saving : t.common.save}
              </IcPageButton>
            </>
          }
          onClose={() => setSkillEditor(null)}
          open
          title={`${skillEditor.name}/SKILL.md`}
        >
          <div className="icsk__editor">
            <CodeEditor
              filePath="SKILL.md"
              initialValue={skillEditor.content}
              key={skillEditor.name}
              onCancel={() => setSkillEditor(null)}
              onChange={setSkillDraft}
              onSave={() => void saveSkillEdit()}
            />
          </div>
        </IcDialog>
      ) : null}
      {/*
       * The dialog owns the beat: `onConfirm` only does the work and throws,
       * which keeps it open with the inline error; on success it holds its
       * done label and then closes itself through `onClose`. Closing inside
       * `onConfirm` would unmount it before any of that could be seen.
       */}
      <IcConfirmDialog
        busyLabel={t.common.saving}
        cancelLabel={enSkills.warnCancel}
        confirmLabel={enSkills.warnConfirm}
        description={disableGuard ? enSkills.warnBody(disableGuard.name) : undefined}
        doneLabel={t.common.done}
        errorFallback={t.skills.failedToUpdate(disableGuard?.name ?? '')}
        onClose={() => setDisableGuard(null)}
        onConfirm={async () => {
          if (disableGuard) {
            await applySkillToggle(disableGuard, false)
          }
        }}
        open={disableGuard !== null}
        title={enSkills.warnTitle(disableGuard?.name ?? '')}
        tone="danger"
      />
      {archiveTarget ? (
        <ArchiveSkillConfirmDialog
          onApply={() => {
            const name = archiveTarget
            const snapshot = skills

            setSkills(current => current?.filter(skill => skill.name !== name) ?? current)
            invalidateSlashCompletions()

            if (skillEditor?.name === name) {
              setSkillEditor(null)
            }

            return () => setSkills(() => snapshot)
          }}
          onClose={() => setArchiveTarget(null)}
          onFailure={(err, name) => notifyError(err, name)}
          open
          profile={scopeProfile}
          skillId={archiveTarget}
          skillName={archiveTarget}
        />
      ) : null}
    </IcPage>
  )
}

// Feature-detection flag for plugins (Bot Mode): TRUE means this build's
// SkillsView routes `fixedConnection` to the pinned connection's backend.
// Older builds export SkillsView WITHOUT the prop — passing it there would
// silently read/write the ACTIVE gateway under the remote bot's profile name,
// which is exactly the wrong-machine bug the prop exists to prevent. A static
// property is probe-able without rendering.
SkillsView.supportsFixedConnection = true as const
