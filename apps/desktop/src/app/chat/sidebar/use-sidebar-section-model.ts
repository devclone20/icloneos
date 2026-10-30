import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { type SessionInfo } from '@/hermes'
import { resolveProfileColor } from '@/lib/profile-color'
import { normalizeSessionSource, sessionSourceLabel } from '@/lib/session-source'
import {
  setPinnedSessionOrder,
  setSidebarProjectOrderIds,
  setSidebarSessionOrderIds,
  setSidebarSessionOrderManual,
  setSidebarWorkspaceOrderIds,
  setSidebarWorkspaceParentOrderIds,
  SIDEBAR_SESSIONS_PAGE_SIZE
} from '@/store/layout'
import { messagingTotalsKey, normalizeProfileKey } from '@/store/profile'
import { sessionPinId } from '@/store/session'
import { loadArchivedSessions } from '@/store/sidebar-archive'

import { reconcileOrderIds, sameIds } from './order'
import { NON_SESSION_INITIAL_ROWS, NON_SESSION_LOAD_STEP } from './paging'
import { sessionRecency as sessionTime, type SidebarSessionGroup, type SidebarWorkspaceTree } from './projects'
import { VIRTUALIZE_THRESHOLD } from './sessions-section'
import { type SidebarProjectModel } from './use-sidebar-project-model'
import { type SidebarSessionModel } from './use-sidebar-session-model'

interface MessagingSection {
  sourceId: string
  label: string
  sessions: SessionInfo[]
  total: number
  hasMore: boolean
}

interface SidebarSectionCallbacks {
  onLoadMoreMessaging?: (platform: string) => Promise<void> | void
  onLoadMoreSessions: () => Promise<void> | void
}

// Last of ChatSidebar's three state hooks (see useSidebarSessionModel): what each section shows and how it pages.
export function useSidebarSectionModel(
  sidebarSessions: SidebarSessionModel,
  sidebarProjects: SidebarProjectModel,
  { onLoadMoreMessaging, onLoadMoreSessions }: SidebarSectionCallbacks
) {
  const {
    agentSessions,
    filtersActive,
    grouping,
    isPinnedSession,
    messagingPlatformTotals,
    messagingProfile,
    messagingTruncated,
    messagingVisible,
    ordering,
    profileColors,
    profileScope,
    scopedSessions,
    sessionByAnyId,
    sessionProfilesTruncated,
    sessions,
    sessionsLoading,
    setMessagingVisible,
    showAllProfiles,
    showArchived,
    sortedSessions,
    trimmedQuery,
    visibleMessagingSessions,
    workspaceOrderIds,
    workspaceParentOrderIds,
    worktreeGroupingActive
  } = sidebarSessions

  const { agentProjectTree, enteredProjectContent, inProject, projectModel, projectOverview } = sidebarProjects

  const [messagingLoadMorePending, setMessagingLoadMorePending] = useState<Record<string, boolean>>({})
  const [recentsLoadMorePending, setRecentsLoadMorePending] = useState(false)

  const runKeyedLoad = useCallback(
    (
      key: string,
      load: ((key: string) => Promise<void> | void) | undefined,
      setPending: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
    ) => {
      if (!load) {
        return
      }

      setPending(prev => ({ ...prev, [key]: true }))

      void Promise.resolve(load(key))
        .catch(() => undefined)
        .finally(() => setPending(({ [key]: _done, ...rest }) => rest))
    },
    []
  )

  const loadMoreForMessaging = useCallback(
    (platform: string) => runKeyedLoad(platform, onLoadMoreMessaging, setMessagingLoadMorePending),
    [onLoadMoreMessaging, runKeyedLoad]
  )

  // Reveal another batch of a platform's rows; fetch from the backend too if we
  // run past what's loaded and more remain on disk.
  const revealMoreMessaging = (platform: string, loaded: number, hasMore: boolean) => {
    const next = (messagingVisible[platform] ?? NON_SESSION_INITIAL_ROWS) + NON_SESSION_LOAD_STEP

    setMessagingVisible(prev => ({ ...prev, [platform]: next }))

    if (next > loaded && hasMore) {
      loadMoreForMessaging(platform)
    }
  }

  // Each messaging platform is its own self-managed section: split the
  // separately-fetched messaging slice by source, newest platform first, rows
  // within a platform by recency. Per-platform totals (when a "load more" has
  // resolved them) drive the count + whether more remain on disk.
  const messagingGroups = useMemo<MessagingSection[]>(() => {
    if (!visibleMessagingSessions.length) {
      return []
    }

    const bySource = new Map<string, SessionInfo[]>()
    // Rows this platform owns that the Pinned section is showing instead. The
    // backend's per-platform total counts them, so discount it or "load more"
    // promises rows that will never appear.
    const pinnedBySource = new Map<string, number>()

    for (const session of visibleMessagingSessions) {
      const sourceId = normalizeSessionSource(session.source)

      if (!sourceId) {
        continue
      }

      if (isPinnedSession(session)) {
        pinnedBySource.set(sourceId, (pinnedBySource.get(sourceId) ?? 0) + 1)

        continue
      }

      const list = bySource.get(sourceId) ?? []
      list.push(session)
      bySource.set(sourceId, list)
    }

    return [...bySource.entries()]
      .map(([sourceId, list]) => {
        const ordered = [...list].sort((a, b) => sessionTime(b) - sessionTime(a))
        const known = messagingPlatformTotals[messagingTotalsKey(messagingProfile, sourceId)]
        const unpinnedKnown = known == null ? null : Math.max(0, known - (pinnedBySource.get(sourceId) ?? 0))
        const total = Math.max(ordered.length, unpinnedKnown ?? 0)

        return {
          // Known exact total → more exist iff total exceeds loaded; otherwise
          // the seed fetch was capped, so assume more until a per-platform load
          // resolves the count.
          hasMore: unpinnedKnown != null ? unpinnedKnown > ordered.length : messagingTruncated,
          label: sessionSourceLabel(sourceId) ?? sourceId,
          sessions: ordered,
          sourceId,
          total
        }
      })
      .sort((a, b) => sessionTime(b.sessions[0]) - sessionTime(a.sessions[0]))
  }, [visibleMessagingSessions, messagingPlatformTotals, messagingTruncated, isPinnedSession, messagingProfile])

  // Grouping by profile: one collapsible group per profile, color on the header
  // (not on every row). Default profile floats to the top, the rest alpha.
  // Only reachable while the sidebar is showing every profile — scoped to one,
  // it would draw a single group around the whole list.
  const profileGrouped = showAllProfiles && grouping === 'profile'

  const profileGroups = useMemo<SidebarSessionGroup[] | undefined>(() => {
    if (!profileGrouped) {
      return undefined
    }

    const groups = new Map<string, SidebarSessionGroup>()

    for (const session of agentSessions) {
      const key = normalizeProfileKey(session.profile)

      const group = groups.get(key) ?? {
        color: resolveProfileColor(key, profileColors),
        id: key,
        label: key,
        mode: 'profile',
        path: null,
        sessions: []
      }

      group.sessions.push(session)

      groups.set(key, group)
    }

    // default (root) first, then the rest alphabetically.
    return [...groups.values()].sort((a, b) =>
      a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.label.localeCompare(b.label)
    )
  }, [profileGrouped, agentSessions, profileColors])

  // The flat Sessions list always shows ALL recent sessions; Projects is a
  // parallel grouped view, not a filter on this one — nothing is hidden here.
  const displayAgentSessions = agentSessions

  // Pagination is scope-aware. In "All profiles" mode it tracks the global
  // unified set; scoped to one profile it tracks that profile's own truncation
  // flag — otherwise a huge default profile keeps "Load more" stuck on while
  // you browse a small one. The backend reports whether its page was capped
  // rather than an exact count, so no COUNT(*) runs per refresh.
  const loadedSessionCount = showAllProfiles ? sessions.length : scopedSessions.length

  // The archived view is its own (single, capped) query — paging the live
  // sessions list from under it would just fold un-archived rows back in.
  const hasMoreSessions =
    !showArchived &&
    (showAllProfiles
      ? Object.values(sessionProfilesTruncated).some(Boolean)
      : Boolean(sessionProfilesTruncated[profileScope]))

  const displayRecentsCountRef = useRef(0)
  const loadedRecentsCountRef = useRef(0)
  displayRecentsCountRef.current = displayAgentSessions.length
  loadedRecentsCountRef.current = loadedSessionCount

  const onLoadMoreRecents = useCallback(async () => {
    if (recentsLoadMorePending) {
      return
    }

    setRecentsLoadMorePending(true)

    try {
      const startVisible = displayRecentsCountRef.current
      const targetVisible = startVisible + SIDEBAR_SESSIONS_PAGE_SIZE
      let lastLoaded = loadedRecentsCountRef.current

      // Project-less recents can be sparse in the global recent stream (because
      // project-scoped sessions are filtered out in the UI). Keep paging until
      // we actually reveal a full page of visible rows, or the backend window
      // stops growing.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await Promise.resolve(onLoadMoreSessions())
        await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))

        const visibleNow = displayRecentsCountRef.current
        const loadedNow = loadedRecentsCountRef.current

        if (visibleNow >= targetVisible) {
          break
        }

        if (loadedNow <= lastLoaded) {
          break
        }

        lastLoaded = loadedNow
      }
    } finally {
      setRecentsLoadMorePending(false)
    }
  }, [onLoadMoreSessions, recentsLoadMorePending])

  // Archived rows are excluded from the sessions query, so the view has to
  // fetch its own set.
  useEffect(() => {
    if (showArchived) {
      void loadArchivedSessions()
    }
  }, [showArchived])

  // Ranking by size is a question about the whole list ("what did I burn money
  // on"), so it drops the calendar dividers and ranks globally — "Today" above
  // the priciest session you have ever had would be a lie. Time- and
  // state-based keys stay bucketed, where they read correctly per day.
  const rankedGlobally = ordering === 'cost' || ordering === 'tokens'

  const displayAgentGroups = profileGroups

  // The recents list owns its own (virtualized) scroll container only when it's a
  // long flat list. In that case it must keep its scroller even in short mode, so
  // we don't flatten it (flattening would defeat virtualization). Short flat lists
  // and grouped views (profile groups or the worktree tree) flatten into the
  // single outer scroll instead.
  // Whichever grouping is active, the flat set of repo subtrees on screen — the
  // single source for reconciling repo/worktree order, whether repos hang off
  // the bare tree or are nested under projects.
  const activeRepoTrees = useMemo<SidebarWorkspaceTree[]>(
    () => (agentProjectTree ? agentProjectTree.flatMap(project => project.repos) : []),
    [agentProjectTree]
  )

  // Mirror the section's own virtualization inputs (the props it receives),
  // not the raw tree cache: agentProjectTree persists after leaving Project
  // grouping, and keying on it here while the section keys on projectOverview
  // (which is nulled the moment grouping changes) left the two disagreeing —
  // wrapper classes built for a virtualized list around a non-virtual one.
  // Entered-project content is the third prop that suppresses virtualization.
  const recentsVirtualizes =
    !displayAgentGroups?.length &&
    !projectOverview?.length &&
    !(inProject && enteredProjectContent) &&
    displayAgentSessions.length >= VIRTUALIZE_THRESHOLD

  // Keep the persisted parent + worktree orders reconciled with what's on screen:
  // freshly-seen repos/worktrees surface at the top, vanished ones drop out of
  // the saved order.
  useEffect(() => {
    if (!activeRepoTrees.length) {
      return
    }

    const nextParents = reconcileOrderIds(
      activeRepoTrees.map(parent => parent.id),
      workspaceParentOrderIds
    )

    if (!sameIds(nextParents, workspaceParentOrderIds)) {
      setSidebarWorkspaceParentOrderIds(nextParents)
    }

    const nextWorktrees = reconcileOrderIds(
      activeRepoTrees.flatMap(parent => parent.groups.map(group => group.id)),
      workspaceOrderIds
    )

    if (!sameIds(nextWorktrees, workspaceOrderIds)) {
      setSidebarWorkspaceOrderIds(nextWorktrees)
    }
  }, [activeRepoTrees, workspaceParentOrderIds, workspaceOrderIds])

  // Skeletons mean "still loading", so they key off the UNFILTERED set. Keyed
  // off the filtered one, a filter that matches nothing showed skeletons on
  // every background refresh instead of the empty state.
  const showSessionSkeletons = sessionsLoading && scopedSessions.length === 0

  // Filtered down to nothing still renders the section: the empty state is what
  // tells you the filter — not an empty account — is why the list is bare.
  const showSessionSections =
    showSessionSkeletons || filtersActive || sortedSessions.length > 0 || projectModel.length > 0

  // The sidebar's session-area mode — exposed as data-attributes so custom
  // skins can target project mode (overview vs. entered), archived, or search
  // without relying on internal class names. `data-sessions-project` carries
  // the entered project's id for per-project targeting.
  const sessionsMode: 'archived' | 'flat' | 'project' | 'projects' | 'search' = trimmedQuery
    ? 'search'
    : showArchived
      ? 'archived'
      : inProject
        ? 'project'
        : worktreeGroupingActive
          ? 'projects'
          : 'flat'

  // Each reorderable list reports its OWN new id order; persisting is a direct,
  // typed write — no id-prefix sniffing to figure out which level moved.
  const reorderSessions = (ids: string[]) => {
    setSidebarSessionOrderManual(true)
    setSidebarSessionOrderIds(ids)
  }

  // Persist the new project overview order (drag-to-reorder); orderByIds applies
  // it over the default sort, so stale/new ids reconcile on the next render.
  const reorderProjects = (ids: string[]) => setSidebarProjectOrderIds(ids)

  // Sortable rows carry live session ids; the pinned store is keyed by durable
  // (lineage-root) ids, so translate before persisting the new order.
  const reorderPinned = (ids: string[]) =>
    setPinnedSessionOrder(
      ids.map(id => {
        const session = sessionByAnyId.get(id)

        return session ? sessionPinId(session) : id
      })
    )

  return {
    displayAgentGroups,
    displayAgentSessions,
    hasMoreSessions,
    messagingGroups,
    messagingLoadMorePending,
    onLoadMoreRecents,
    rankedGlobally,
    recentsLoadMorePending,
    recentsVirtualizes,
    reorderPinned,
    reorderProjects,
    reorderSessions,
    revealMoreMessaging,
    sessionsMode,
    showSessionSections,
    showSessionSkeletons
  }
}
