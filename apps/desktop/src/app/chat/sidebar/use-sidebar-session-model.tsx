import { KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router'

import { Codicon } from '@/components/ui/codicon'
import { useContributions } from '@/contrib/react/use-contributions'
import { searchSessions, type SessionInfo, type SessionSearchResult } from '@/hermes'
import { useI18n } from '@/i18n'
import { comboTokens } from '@/lib/keybinds/combo'
import { sessionMatchesSearch } from '@/lib/session-search'
import { $activeConnectionId } from '@/store/connections'
import { $cronJobs } from '@/store/cron'
import { $bindings } from '@/store/keybinds'
import {
  $dismissedAutoProjectIds,
  $panesFlipped,
  $pinnedSessionIds,
  $sidebarCardRows,
  $sidebarCronOpen,
  $sidebarFiltersActive,
  $sidebarGrouping,
  $sidebarMessagingOpenIds,
  $sidebarOrdering,
  $sidebarPinsOpen,
  $sidebarPrDataWanted,
  $sidebarPrFilter,
  $sidebarProfileFilter,
  $sidebarProjectFilter,
  $sidebarProjectOrderIds,
  $sidebarRecentsOpen,
  $sidebarSessionOrderIds,
  $sidebarSessionOrderManual,
  $sidebarShowArchived,
  $sidebarStatusFilter,
  $sidebarWorkspaceOrderIds,
  $sidebarWorkspaceParentOrderIds,
  SESSION_SEARCH_FOCUS_EVENT,
  setSidebarSessionOrderIds,
  setSidebarSessionOrderManual
} from '@/store/layout'
import { notifyError } from '@/store/notifications'
import {
  $profileColors,
  $profiles,
  $profileScope,
  ALL_PROFILES,
  normalizeProfileKey,
  sidebarProfileForScope
} from '@/store/profile'
import {
  $activeProjectId,
  $projects,
  $projectScope,
  $projectTree,
  $projectTreeLoading,
  $removedSessionIds,
  $reposScanning
} from '@/store/projects'
import { $prBranchBySession, $pullRequestsByBranch, pullRequestBucket, sessionPrKey } from '@/store/pull-requests'
import {
  $cronSessions,
  $currentCwd,
  $gatewayState,
  $messagingPlatformTotals,
  $messagingSessions,
  $messagingTruncated,
  $sessionProfilesTruncated,
  $sessions,
  $sessionsLoading,
  $unreadFinishedSessionIds
} from '@/store/session'
import { $sessionDotStateById, sessionStatusBucket } from '@/store/session-dot-state'
import { $unconfirmedPinWrites } from '@/store/session-pin-sync'
import { $focusedStoredSessionId } from '@/store/session-states'
import { markSessionUnread } from '@/store/session-unread-remote'
import { $archivedSessions } from '@/store/sidebar-archive'
import { $sidebarSessionRankIds } from '@/store/sidebar-sort'

import { type AppView, SIDEBAR_NAV_AREA, type SidebarNavContribution } from '../../routes'
import type { SidebarNavItem } from '../../types'

import { resolveManualSessionOrderIds, sameIds } from './order'
import { filterSessionsByProfileScope } from './profile-scope'
import { liveSessionProjectId, sessionRecency as sessionTime } from './projects'
import { buildSessionByAnyId, resolvePinnedSessions } from './session-index'

// The backend's FTS layer wraps matched terms in literal '>>>' / '<<<'
// highlight markers (sqlite snippet() delimiters — see hermes_state_search.py).
// The sidebar renders the snippet as plain text, so the markers must be
// stripped or a search for "foo" paints rows titled ">>>foo<<<".
// Exported for tests.
export function stripFtsMarkers(snippet: string): string {
  return snippet.replaceAll('>>>', '').replaceAll('<<<', '')
}

function searchResultToSession(result: SessionSearchResult): SessionInfo {
  const ts = result.session_started ?? Date.now() / 1000

  return {
    archived: false,
    cwd: null,
    ended_at: null,
    id: result.session_id,
    _lineage_root_id: result.lineage_root ?? null,
    input_tokens: 0,
    is_active: false,
    last_active: ts,
    message_count: 0,
    model: result.model ?? null,
    output_tokens: 0,
    preview: stripFtsMarkers(result.snippet ?? '').trim() || null,
    source: result.source ?? null,
    started_at: ts,
    title: null,
    tool_call_count: 0
  }
}

// ChatSidebar's state, first of three hooks it calls in this fixed order (sessions → projects → sections):
// each takes the previous ones' results, so the React hook order is the component's own.
export function useSidebarSessionModel(currentView: AppView) {
  const { t } = useI18n()
  const s = t.sidebar
  const { pathname, search } = useLocation()
  // Contributed nav rows (plugins pairing a page with a sidebar entry) render
  // below the built-ins with the same chrome; active = at their route.
  const navContributions = useContributions(SIDEBAR_NAV_AREA)

  const contributedNav = useMemo<SidebarNavItem[]>(
    () =>
      navContributions.flatMap(c => {
        const data = c.data as Partial<SidebarNavContribution> | undefined

        if (!data?.path?.startsWith('/') || !data.label) {
          return []
        }

        const codicon = data.codicon || 'plug'

        return [
          {
            id: c.id,
            label: data.label,
            icon: (props: { className?: string }) => <Codicon name={codicon} {...props} />,
            route: data.path
          }
        ]
      }),
    [navContributions]
  )

  const panesFlipped = useStore($panesFlipped)
  const grouping = useStore($sidebarGrouping)
  const ordering = useStore($sidebarOrdering)
  const statusFilter = useStore($sidebarStatusFilter)
  const projectFilter = useStore($sidebarProjectFilter)
  const profileFilter = useStore($sidebarProfileFilter)
  const prFilter = useStore($sidebarPrFilter)
  const prDataWanted = useStore($sidebarPrDataWanted)
  const prBranchOverrides = useStore($prBranchBySession)
  const pullRequests = useStore($pullRequestsByBranch)
  const filtersActive = useStore($sidebarFiltersActive)
  const showArchived = useStore($sidebarShowArchived)
  const cardRows = useStore($sidebarCardRows)
  const archivedSessions = useStore($archivedSessions)
  const dotStates = useStore($sessionDotStateById)
  // The active sort key as an id order. The flat list applies it within its
  // dividers; groups apply it to their own lanes.
  const sortOrderIds = useStore($sidebarSessionRankIds)
  const agentsGrouped = grouping === 'project'
  const pinnedSessionIds = useStore($pinnedSessionIds)
  const unconfirmedPinWrites = useStore($unconfirmedPinWrites)
  const pinsOpen = useStore($sidebarPinsOpen)
  const agentsOpen = useStore($sidebarRecentsOpen)
  const cronOpen = useStore($sidebarCronOpen)
  // The sidebar highlight tracks the FOCUSED session — the interacted tile's
  // tab, else the main selection — so it stays 1:1 with whatever tab is active.
  const selectedSessionId = useStore($focusedStoredSessionId)
  const sessions = useStore($sessions)
  const cronSessions = useStore($cronSessions)
  const cronJobs = useStore($cronJobs)
  const messagingSessions = useStore($messagingSessions)
  const messagingPlatformTotals = useStore($messagingPlatformTotals)
  const messagingTruncated = useStore($messagingTruncated)
  const sessionsLoading = useStore($sessionsLoading)
  const sessionProfilesTruncated = useStore($sessionProfilesTruncated)
  const unreadCount = useStore($unreadFinishedSessionIds).length
  const profiles = useStore($profiles)
  const profileColors = useStore($profileColors)
  const profileScope = useStore($profileScope)
  const activeConnectionId = useStore($activeConnectionId)

  // Toggle the persisted read-state watermark from a row menu. The row's own
  // `unread` prop mirrors what the dot paints; flip it and let the backend
  // become the truth (optimistic update + rollback in markSessionUnread).
  const toggleUnread = (storedId: string) => {
    const row = $sessions.get().find(r => r.id === storedId)

    if (!row) {
      return
    }

    markSessionUnread(storedId, row.unread !== true).catch(err => notifyError(err, s.row.unreadFailed))
  }

  // Only surface the profile switcher when more than one profile exists, so
  // single-profile users see the unchanged sidebar.
  const multiProfile = profiles.length > 1
  // Gate ALL-profiles grouping on multiProfile too: if a user drops back to one
  // profile while scope is still ALL (persisted), the rail is hidden and they'd
  // otherwise be stuck in the grouped view with no way out.
  const showAllProfiles = multiProfile && profileScope === ALL_PROFILES
  const messagingProfile = sidebarProfileForScope(profileScope)
  const agentOrderIds = useStore($sidebarSessionOrderIds)
  const agentOrderManual = useStore($sidebarSessionOrderManual)
  const workspaceOrderIds = useStore($sidebarWorkspaceOrderIds)
  const workspaceParentOrderIds = useStore($sidebarWorkspaceParentOrderIds)
  const projectOrderIds = useStore($sidebarProjectOrderIds)
  const projects = useStore($projects)
  const projectTree = useStore($projectTree)
  const projectTreeLoading = useStore($projectTreeLoading)
  const removedSessionIds = useStore($removedSessionIds)
  const reposScanning = useStore($reposScanning)
  const activeProjectId = useStore($activeProjectId)
  const projectScope = useStore($projectScope)
  const currentCwd = useStore($currentCwd)
  const gatewayState = useStore($gatewayState)
  const dismissedAutoProjects = useStore($dismissedAutoProjectIds)
  const newSessionCombo = useStore($bindings)['session.new']?.[0]
  const newSessionKbd = newSessionCombo ? comboTokens(newSessionCombo) : []
  const [searchQuery, setSearchQuery] = useState('')
  const [serverMatches, setServerMatches] = useState<SessionSearchResult[]>([])
  const [searchPending, setSearchPending] = useState(false)
  const [newSessionKbdFlash, setNewSessionKbdFlash] = useState(false)
  const messagingOpenIds = useStore($sidebarMessagingOpenIds)
  // Per-platform count of rows currently revealed (starts at NON_SESSION_INITIAL_ROWS).
  const [messagingVisible, setMessagingVisible] = useState<Record<string, number>>({})
  const searchInputRef = useRef<HTMLInputElement>(null)
  const trimmedQuery = searchQuery.trim()

  // Hotkey (session.focusSearch) → focus the field once it's mounted.
  useEffect(() => {
    const onFocus = () => searchInputRef.current?.focus({ preventScroll: true })

    window.addEventListener(SESSION_SEARCH_FOCUS_EVENT, onFocus)

    return () => window.removeEventListener(SESSION_SEARCH_FOCUS_EVENT, onFocus)
  }, [])

  // Flash the ⌘N hint to primary text (no transition) so the press visibly pings its affordance. At rest it is
  // the ghost kbd, never dimmed with opacity: that took it under the AA floor.
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined

    const onShortcut = () => {
      setNewSessionKbdFlash(true)
      clearTimeout(timeout)
      timeout = setTimeout(() => setNewSessionKbdFlash(false), 140)
    }

    window.addEventListener('hermes:new-session-shortcut', onShortcut)

    return () => {
      window.removeEventListener('hermes:new-session-shortcut', onShortcut)
      clearTimeout(timeout)
    }
  }, [])

  const activeSidebarSessionId = currentView === 'chat' ? selectedSessionId : null

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // Profile scope = the "workspace switcher" context. Concrete scope shows only
  // that profile's sessions (clean rows, no per-row tags); ALL fans every
  // profile in. Grouped rendering stays gated on `showAllProfiles` (multi-profile
  // + ALL) so a single-profile user is never stranded in a grouped view with no
  // rail — but the *data* still has to fan in when the persisted scope is ALL
  // (Grouping → Profile). Filtering that pool against the `__all__` sentinel
  // matches nothing and empties recents + pins.
  // Archived rows are excluded from the sessions query, so Archived is a view of
  // its own set rather than a filter over this one — a flat list of archived
  // rows, no project tree, no date or status dividers.
  const scopedSessions = useMemo(() => {
    const pool = showArchived ? archivedSessions : sessions

    return filterSessionsByProfileScope(pool, profileScope)
  }, [sessions, archivedSessions, showArchived, profileScope])

  // One predicate for the status/project filters, so the flat list and the
  // project lanes narrow by the same rule. A project lane holds rows the loaded
  // page may not, so it has to be answerable per session rather than by
  // membership in the filtered set.
  const sessionMatchesFilters = useCallback(
    (session: SessionInfo) => {
      if (statusFilter.length && !statusFilter.includes(sessionStatusBucket(dotStates[session.id]))) {
        return false
      }

      // Narrowing to a few of the profiles on screen. Scoped to one profile the
      // list is already that profile's, so a stale selection can't blank it.
      if (showAllProfiles && profileFilter.length && !profileFilter.includes(normalizeProfileKey(session.profile))) {
        return false
      }

      if (prFilter.length) {
        const key = sessionPrKey(session)

        if (!prFilter.includes(pullRequestBucket(key ? pullRequests[key] : undefined))) {
          return false
        }
      }

      // Same membership the sidebar groups and colors by, so a filtered row
      // lands in the lane the user picked it from.
      return !projectFilter.length || projectFilter.includes(liveSessionProjectId(session, projects) ?? '')
    },
    [statusFilter, projectFilter, profileFilter, showAllProfiles, prFilter, pullRequests, projects, dotStates]
  )

  const filtersNarrow =
    statusFilter.length > 0 ||
    projectFilter.length > 0 ||
    prFilter.length > 0 ||
    (showAllProfiles && profileFilter.length > 0)

  const visibleSessions = useMemo(
    () => (filtersNarrow ? scopedSessions.filter(sessionMatchesFilters) : scopedSessions),
    [scopedSessions, filtersNarrow, sessionMatchesFilters]
  )

  // Recents by activity (last_active || started_at). User send stamps
  // last_active immediately. Ordering by status doesn't sort here — it re-slots
  // rows *inside* whatever dividers are on, via sortOrderIds below — so the
  // date buckets stay chronological either way.
  const sortedSessions = useMemo(
    () => [...visibleSessions].sort((a, b) => sessionTime(b) - sessionTime(a)),
    [visibleSessions]
  )

  const visibleCronSessions = useMemo(
    () => filterSessionsByProfileScope(cronSessions, profileScope),
    [cronSessions, profileScope]
  )

  const visibleMessagingSessions = useMemo(
    () => filterSessionsByProfileScope(messagingSessions, profileScope),
    [messagingSessions, profileScope]
  )

  // Index sessions by every id a pin might be stored under — recents, cron,
  // AND messaging, since all three can be pinned (see session-index.ts).
  const sessionByAnyId = useMemo(
    () => buildSessionByAnyId(visibleSessions, visibleCronSessions, visibleMessagingSessions),
    [visibleSessions, visibleCronSessions, visibleMessagingSessions]
  )

  // Local pin ids first (hand-picked order), then server-flagged pins the
  // local set doesn't know about — a backend `pinned=1` row must never be
  // invisible just because localStorage is cold or was clobbered (#85969) —
  // minus the rows whose flag our own in-flight pin write already contradicts.
  const pinnedSessions = useMemo(
    () =>
      resolvePinnedSessions(
        pinnedSessionIds,
        sessionByAnyId,
        [...visibleSessions, ...cronSessions, ...messagingSessions],
        unconfirmedPinWrites
      ),
    [pinnedSessionIds, sessionByAnyId, visibleSessions, cronSessions, messagingSessions, unconfirmedPinWrites]
  )

  // Every id a pin is reachable under: the raw stored ids, plus BOTH identities
  // of each session we resolved one to. A pin is stored on the durable lineage
  // root, but the lists that must filter it out are fed from three independent
  // fetches (recents, the messaging slice, the backend project tree) and each
  // can surface the same conversation under either its live tip or its root.
  // Comparing one identity against the other is how a pinned session ended up
  // rendered twice — once in Pinned, once in its project group.
  const pinnedIdentitySet = useMemo(() => {
    const ids = new Set(pinnedSessionIds)

    for (const session of pinnedSessions) {
      ids.add(session.id)

      if (session._lineage_root_id) {
        ids.add(session._lineage_root_id)
      }
    }

    return ids
  }, [pinnedSessionIds, pinnedSessions])

  // A pinned session belongs to the Pinned section and nowhere else, so every
  // other list filters it out. Match on either identity the row carries — a
  // backend snapshot can surface either side of a compression tip rotation.
  const isPinnedSession = useCallback(
    (session: SessionInfo) =>
      pinnedIdentitySet.has(session.id) ||
      (session._lineage_root_id != null && pinnedIdentitySet.has(session._lineage_root_id)),
    [pinnedIdentitySet]
  )

  // What the project tree drops: pins (they live in their own section) plus
  // anything the active filters exclude, so filtering works the same whether
  // you're looking at the flat list or the lanes.
  const isHiddenFromProjects = useCallback(
    (session: SessionInfo) => isPinnedSession(session) || (filtersNarrow && !sessionMatchesFilters(session)),
    [isPinnedSession, filtersNarrow, sessionMatchesFilters]
  )

  // Full-text search across *all* sessions (not just the loaded page) so 699
  // sessions stay findable. Debounced; loaded sessions are matched instantly
  // client-side and merged ahead of the server hits.
  useEffect(() => {
    if (!trimmedQuery) {
      setServerMatches([])
      setSearchPending(false)

      return
    }

    let cancelled = false

    setSearchPending(true)

    const id = window.setTimeout(() => {
      void searchSessions(trimmedQuery)
        .then(res => {
          if (!cancelled) {
            setServerMatches(res.results)
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) {
            setSearchPending(false)
          }
        })
    }, 200)

    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [trimmedQuery])

  const searchResults = useMemo(() => {
    if (!trimmedQuery) {
      return []
    }

    const out = new Map<string, SessionInfo>()

    for (const s of sortedSessions) {
      if (sessionMatchesSearch(s, trimmedQuery)) {
        out.set(s.id, s)
      }
    }

    for (const match of serverMatches) {
      if (out.has(match.session_id)) {
        continue
      }

      const loaded = sessionByAnyId.get(match.session_id)
      out.set(match.session_id, loaded ?? searchResultToSession(match))
    }

    return [...out.values()]
  }, [trimmedQuery, sortedSessions, serverMatches, sessionByAnyId])

  const unpinnedAgentSessions = useMemo(
    () => sortedSessions.filter(s => !isPinnedSession(s)),
    [sortedSessions, isPinnedSession]
  )

  useEffect(() => {
    const next = resolveManualSessionOrderIds(
      unpinnedAgentSessions.map(s => s.id),
      agentOrderIds,
      agentOrderManual
    )

    if (!next.length && agentOrderManual) {
      setSidebarSessionOrderManual(false)
    }

    if (!next.length && agentOrderIds.length) {
      setSidebarSessionOrderIds([])

      return
    }

    if (next.length && !sameIds(next, agentOrderIds)) {
      setSidebarSessionOrderIds(next)
    }
  }, [agentOrderIds, agentOrderManual, unpinnedAgentSessions])

  // Recents render in recency order. The hand-picked order is layered on per
  // date group inside the section (orderRowsWithinGroups) rather than baked
  // into the list here, so a drag ranks a row among its own day's chats
  // instead of flattening the whole sidebar into an undated manual mode.
  const agentSessions = unpinnedAgentSessions

  // Recents are local-only: messaging-platform sessions are fetched as their
  // own slice ($messagingSessions) and rendered in self-managed per-platform
  // sections below, so there is no source-grouping magic to untangle here.
  //
  // Workspace grouping is a `project -> repo -> lane -> sessions` tree computed
  // authoritatively on the backend (projects.tree). Parents reorder via
  // workspaceParentOrderIds; worktrees within a parent via workspaceOrderIds.
  const worktreeGroupingActive = agentsGrouped && !showArchived
  const gatewayReady = gatewayState === 'open'

  return {
    activeConnectionId,
    activeProjectId,
    activeSidebarSessionId,
    agentOrderIds,
    agentOrderManual,
    agentSessions,
    agentsGrouped,
    agentsOpen,
    cardRows,
    contributedNav,
    cronJobs,
    cronOpen,
    currentCwd,
    dismissedAutoProjects,
    dndSensors,
    filtersActive,
    gatewayReady,
    grouping,
    isHiddenFromProjects,
    isPinnedSession,
    messagingOpenIds,
    messagingPlatformTotals,
    messagingProfile,
    messagingTruncated,
    messagingVisible,
    newSessionKbd,
    newSessionKbdFlash,
    ordering,
    panesFlipped,
    pathname,
    pinnedSessions,
    pinsOpen,
    prBranchOverrides,
    prDataWanted,
    profileColors,
    profileScope,
    projectFilter,
    projectOrderIds,
    projectScope,
    projectTree,
    projectTreeLoading,
    projects,
    removedSessionIds,
    reposScanning,
    s,
    scopedSessions,
    search,
    searchInputRef,
    searchPending,
    searchQuery,
    searchResults,
    sessionByAnyId,
    sessionProfilesTruncated,
    sessions,
    sessionsLoading,
    setMessagingVisible,
    setSearchQuery,
    showAllProfiles,
    showArchived,
    sortOrderIds,
    sortedSessions,
    toggleUnread,
    trimmedQuery,
    unreadCount,
    visibleMessagingSessions,
    workspaceOrderIds,
    workspaceParentOrderIds,
    worktreeGroupingActive
  }
}

export type SidebarSessionModel = ReturnType<typeof useSidebarSessionModel>
