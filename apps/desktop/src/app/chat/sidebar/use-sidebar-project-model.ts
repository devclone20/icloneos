import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { type SessionInfo } from '@/hermes'
import { filterVisibleProjects } from '@/store/layout'
import {
  ALL_PROJECTS,
  enterProject,
  exitProjectScope,
  fetchProjectSessions,
  refreshProjects,
  refreshProjectTree,
  refreshWorktrees,
  scanAndRecordRepos
} from '@/store/projects'
import { recoverSessionPullRequests, refreshPullRequests, sessionPrKey } from '@/store/pull-requests'
import { setCurrentCwd } from '@/store/session'
import { $workingSessionIds } from '@/store/session-states'

import { orderByIds } from './order'
import {
  excludeProjectSessions,
  orderProjectsByIds,
  overlayLiveLanes,
  overlayLivePreviews,
  PROJECT_PREVIEW_COUNT,
  projectTreeCwd,
  type SidebarProjectTree,
  type SidebarWorkspaceTree,
  sortProjectsForOverview,
  useRepoWorktreeMap
} from './projects'
import { type SidebarSessionModel } from './use-sidebar-session-model'

// How long after connecting to warm the project tree for someone who isn't in
// the grouped view. Long enough that the flat list — the thing actually on
// screen — has the connection to itself first.
const PROJECT_TREE_WARM_MS = 2_000

// Second of ChatSidebar's three state hooks (see useSidebarSessionModel): the project tree and its pull requests.
export function useSidebarProjectModel(sidebarSessions: SidebarSessionModel) {
  const {
    activeConnectionId,
    activeProjectId,
    agentSessions,
    currentCwd,
    dismissedAutoProjects,
    gatewayReady,
    isHiddenFromProjects,
    prBranchOverrides,
    prDataWanted,
    profileScope,
    projectFilter,
    projectOrderIds,
    projectScope,
    projectTree,
    projectTreeLoading,
    projects,
    removedSessionIds,
    s,
    scopedSessions,
    showAllProfiles,
    sortOrderIds,
    workspaceOrderIds,
    workspaceParentOrderIds,
    worktreeGroupingActive
  } = sidebarSessions

  // The backend project tree is a structural snapshot, NOT a per-message feed.
  // Refresh it on structural edges only — entering the grouped view, a profile
  // switch, gateway (re)connect — plus the once-per-run disk scan. Live session
  // changes between refreshes are reflected by the in-memory overlay
  // (overlayLiveLanes / overlayLivePreviews) off `$sessions`, so a turn
  // completing does NOT re-run the heavy list_sessions_rich scan. Project
  // mutations refresh the tree from their own store actions.
  useEffect(() => {
    if (!gatewayReady) {
      return
    }

    if (worktreeGroupingActive) {
      void refreshProjects()

      // The all-profiles tree is served off every profile's databases at once
      // and deliberately leaves discovery out — a repo with no sessions is the
      // same repo in every profile, so scanning here would multiply empty lanes
      // by the profile count and write the result into profiles the user isn't
      // driving.
      if (showAllProfiles) {
        void refreshProjectTree()

        return
      }

      // Paint the list from the fast tree fetch (explicit projects + repos from
      // existing sessions / the backend cache) FIRST, then kick off the heavy
      // home-dir git crawl so newly-discovered repos fold in afterward — instead
      // of the crawl blocking the first render.
      void refreshProjectTree().finally(() => void scanAndRecordRepos())

      return
    }

    // Flat view: warm the tree in the background anyway. Fetching it only on
    // the switch meant the first switch of every run paid for the whole round
    // trip behind a skeleton, and the menu's Project filter had nothing to
    // list until you'd visited the grouped view at least once.
    const warm = window.setTimeout(() => void refreshProjectTree(), PROJECT_TREE_WARM_MS)

    return () => window.clearTimeout(warm)
  }, [activeConnectionId, worktreeGroupingActive, showAllProfiles, profileScope, gatewayReady])

  // Sessions the branch join can't answer for get one look at their own
  // transcript — a `gh pr create` in there names the PR outright. Backfills
  // whatever is loaded, whether or not the badge is on: gating it on the badge
  // meant switching PR on showed a half-empty list until a second pass caught
  // up. One request per batch of never-scanned rows, and the scanned set makes
  // that batch empty from the second pass on, so this settles to nothing.
  useEffect(() => {
    if (!gatewayReady) {
      return
    }

    const warm = window.setTimeout(() => void recoverSessionPullRequests(scopedSessions), PROJECT_TREE_WARM_MS)

    return () => window.clearTimeout(warm)
  }, [gatewayReady, scopedSessions])

  // PR state is only fetched for someone who asked to see it — the badge or the
  // filter — and it asks about the branches on screen, so the answer can't be
  // crowded out by a busy repo's newer PRs.
  const prLookupsByRepo = useMemo(() => {
    if (!prDataWanted) {
      return {}
    }

    const byRepo: Record<string, string[]> = {}

    for (const session of scopedSessions) {
      // The row's own key, so a session bound to a branch (or a PR number) it
      // was stamped with asks about THAT, not the branch it started on.
      const [root, lookup] = sessionPrKey(session)?.split('\n') ?? []

      if (root && lookup && !byRepo[root]?.includes(lookup)) {
        byRepo[root] = [...(byRepo[root] ?? []), lookup]
      }
    }

    return byRepo
    // prBranchOverrides is what `sessionPrKey` reads through — a recovered PR
    // has to re-ask with the key it just learned.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prDataWanted, scopedSessions, prBranchOverrides])

  // A stable identity for "the same question as last time", so a re-render that
  // rebuilds the map doesn't re-ask GitHub.
  const prQueryKey = JSON.stringify(
    Object.entries(prLookupsByRepo)
      .map(([root, lookups]) => [root, [...lookups].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b))
  )

  useEffect(() => {
    if (prQueryKey === '[]') {
      return
    }

    const byRepo = Object.fromEntries(JSON.parse(prQueryKey) as [string, string[]][])

    void refreshPullRequests(byRepo)

    // A PR opens, merges or gets closed on github.com, not in here — so like
    // the project tree, re-pull when the window comes back. The store's own
    // staleness window keeps a flurry of focus events to one call per repo.
    const onActive = () => {
      if (document.visibilityState !== 'hidden') {
        void refreshPullRequests(byRepo)
      }
    }

    window.addEventListener('focus', onActive)
    document.addEventListener('visibilitychange', onActive)

    return () => {
      window.removeEventListener('focus', onActive)
      document.removeEventListener('visibilitychange', onActive)
    }
  }, [prQueryKey])

  // Out-of-band repo changes (a `git init` / `rm -rf` in another terminal) emit
  // no git events, so — like every git GUI — re-pull on window focus / tab
  // visibility instead of stranding the tree until a hard reload. The tree
  // fetch is cheap and runs every focus (picks up explicit create/delete +
  // session regrouping); the heavy disk crawl that surfaces brand-new repos is
  // throttled. Agent-driven changes already refresh via $workspaceChangeTick.
  useEffect(() => {
    if (!worktreeGroupingActive || !gatewayReady) {
      return
    }

    let lastScanAt = 0
    const SCAN_THROTTLE_MS = 30_000

    const onActive = () => {
      if (document.visibilityState === 'hidden') {
        return
      }

      void refreshProjects()
      void refreshProjectTree()

      // Discovery stays off while browsing every profile, for the reason the
      // first fetch leaves it out.
      if (showAllProfiles) {
        return
      }

      const now = Date.now()

      if (now - lastScanAt >= SCAN_THROTTLE_MS) {
        lastScanAt = now
        void scanAndRecordRepos(true)
      }
    }

    window.addEventListener('focus', onActive)
    document.addEventListener('visibilitychange', onActive)

    return () => {
      window.removeEventListener('focus', onActive)
      document.removeEventListener('visibilitychange', onActive)
    }
  }, [worktreeGroupingActive, showAllProfiles, gatewayReady])

  // Apply the persisted repo + worktree orders to a project's repo subtrees.
  const orderRepos = useCallback(
    (repos: SidebarWorkspaceTree[]): SidebarWorkspaceTree[] =>
      orderByIds(repos, parent => parent.id, workspaceParentOrderIds).map(parent => ({
        ...parent,
        groups: orderByIds(parent.groups, group => group.id, workspaceOrderIds)
      })),
    [workspaceParentOrderIds, workspaceOrderIds]
  )

  // ── Projects: the single top-level model (authoritative, from the backend) ──
  // `projects.tree` already unifies explicit projects + auto repos and folds
  // linked worktrees under their main repo. The desktop only layers local view
  // state on top: dismissed auto-projects, persisted repo/lane order, and the
  // overview sort. Membership is the backend tree's — never re-derived here.
  const projectModel = useMemo<SidebarProjectTree[]>(() => {
    const sorted = sortProjectsForOverview(
      filterVisibleProjects(projectTree, dismissedAutoProjects)
        // A filtered-out project drops its whole lane, header included — hiding
        // only its rows would leave a row of empty folders behind.
        .filter(project => !projectFilter.length || projectFilter.includes(project.id))
        .map(project =>
          excludeProjectSessions(
            {
              ...project,
              // Home is synthetic, so its name is ours to translate — every
              // other label is a repo basename or a name the user typed.
              label: project.isNoProject ? s.projects.home : project.label,
              repos: orderRepos(project.repos)
            },
            isHiddenFromProjects
          )
        ),
      activeProjectId
    )

    // Layer the user's manual drag-order on top of the deterministic sort. Empty
    // (default) returns `sorted` untouched; projects the user hasn't ordered yet
    // keep their sorted position rather than jumping the hand-picked list.
    return orderProjectsByIds(sorted, projectOrderIds)
  }, [
    projectTree,
    dismissedAutoProjects,
    orderRepos,
    activeProjectId,
    projectFilter,
    projectOrderIds,
    isHiddenFromProjects,
    s
  ])

  // The overview only renders in grouped mode; the model stays live regardless
  // so scoping is consistent across views.
  const agentProjectTree = worktreeGroupingActive ? projectModel : undefined

  // ── Project switcher (drill-in) ────────────────────────────────────────────
  // Grouped, single-profile view is a project switcher: ALL_PROJECTS shows the
  // overview (a list you click into); a concrete scope means you've "entered" a
  // project, so the Sessions list shows ONLY that project's worktrees/sessions.
  const projectsActive = Boolean(agentProjectTree?.length)

  // The overview node for the entered project (structure + counts, empty lanes).
  const overviewEnteredProject =
    projectsActive && projectScope !== ALL_PROJECTS
      ? agentProjectTree?.find(node => node.id === projectScope)
      : undefined

  const inProject = Boolean(overviewEnteredProject)
  const enteredProjectId = overviewEnteredProject?.id

  // Entering a project lazily hydrates its full lanes (repo -> lane -> sessions)
  // from the backend — same grouping/ids as the overview, just with rows.
  const [enteredProjectTree, setEnteredProjectTree] = useState<SidebarProjectTree | null>(null)

  useEffect(() => {
    if (!enteredProjectId || !gatewayReady) {
      setEnteredProjectTree(null)

      return
    }

    let cancelled = false

    void fetchProjectSessions(enteredProjectId).then(project => {
      if (!cancelled) {
        setEnteredProjectTree(project)
      }
    })

    return () => {
      cancelled = true
    }
    // `projectTree` in deps: re-hydrate after a tree refresh so the entered view
    // stays current with new/ended sessions.
  }, [enteredProjectId, gatewayReady, projectTree])

  // Prefer the hydrated tree; fall back to the overview node (empty lanes) while
  // the drill-in fetch is in flight, so the header/structure render immediately.
  const enteredProject = useMemo<SidebarProjectTree | undefined>(() => {
    if (!overviewEnteredProject) {
      return undefined
    }

    const hydrated =
      enteredProjectTree && enteredProjectTree.id === overviewEnteredProject.id
        ? enteredProjectTree
        : overviewEnteredProject

    // The live-session overlay (creates/evictions) is applied per-repo in
    // RepoFlatSection, AFTER the visual git-worktree lanes are merged in (so
    // out-of-tree worktrees can be placed). Here we just order the snapshot and
    // drop pinned rows — the hydrated lanes come straight from the backend, so
    // they haven't been through projectModel's filter.
    // The label comes from the overview node either way — that's the model's
    // presentation copy (Home is translated there), not the raw payload's.
    return excludeProjectSessions(
      { ...hydrated, label: overviewEnteredProject.label, repos: orderRepos(hydrated.repos) },
      isHiddenFromProjects
    )
  }, [overviewEnteredProject, enteredProjectTree, orderRepos, isHiddenFromProjects])

  // Overlay live `$sessions` onto the entered project so a just-created session
  // (which the backend snapshot hasn't folded in yet) counts as content and
  // renders immediately — same optimistic layer as the overview previews. The
  // backend now seeds each project folder as an (empty) repo, so the overlay
  // always has a lane to place a new in-project session into.
  const enteredProjectContent = useMemo(
    () => (enteredProject ? overlayLiveLanes(enteredProject, agentSessions, removedSessionIds) : undefined),
    [enteredProject, agentSessions, removedSessionIds]
  )

  const scopedRepoPaths = useMemo(
    () =>
      enteredProject ? enteredProject.repos.map(repo => repo.path).filter((path): path is string => Boolean(path)) : [],
    [enteredProject]
  )

  // git worktree list is a VISUAL-only enhancer (empty lanes); never membership.
  const inEnteredProject = Boolean(enteredProject && !showAllProfiles)
  const [scopedRepoWorktrees] = useRepoWorktreeMap(scopedRepoPaths, inEnteredProject)

  // Re-probe worktree lanes on out-of-band git changes the renderer can't see.
  // A turn can `git worktree add/remove` in the terminal (e.g. you ask Hermes to
  // "remove that worktree"), and the window never blurs during an in-app chat,
  // so nothing would otherwise re-run the visual probe. Re-sync when a working
  // session settles (its turn finished) or the window refocuses (an external
  // terminal may have changed things) — only while a project is entered, and
  // only the cheap per-repo `git worktree list`, never the heavy tree scan.
  //
  // Listened to rather than rendered from: a settling turn is a side effect,
  // and reading it with `useStore` repainted this whole component — every
  // section, every row — on each status edge, to run an effect that touches no
  // markup. The rows subscribe to their own status, so nothing above them needs
  // to re-render for one of them to change color.
  useEffect(() => {
    if (!inEnteredProject) {
      return
    }

    let previous = $workingSessionIds.get()

    return $workingSessionIds.listen(working => {
      // A session leaving the working set means its turn just completed.
      const aTurnSettled = previous.some(id => !working.includes(id))

      previous = working

      if (aTurnSettled) {
        refreshWorktrees()
      }
    })
  }, [inEnteredProject])

  useEffect(() => {
    if (!inEnteredProject) {
      return
    }

    const onFocus = () => refreshWorktrees()
    window.addEventListener('focus', onFocus)

    return () => window.removeEventListener('focus', onFocus)
  }, [inEnteredProject])

  const lastProjectCwdSyncRef = useRef<null | string>(null)

  const syncProjectCwd = useCallback(
    (project: SidebarProjectTree) => {
      const target = projectTreeCwd(project)

      if (target && target !== currentCwd) {
        setCurrentCwd(target)
      }
    },
    [currentCwd]
  )

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (!inProject || !enteredProject) {
      lastProjectCwdSyncRef.current = null

      return
    }

    if (lastProjectCwdSyncRef.current === enteredProject.id) {
      return
    }

    syncProjectCwd(enteredProject)
    lastProjectCwdSyncRef.current = enteredProject.id
  }, [inProject, enteredProject, syncProjectCwd])

  // A persisted scope can go stale (project archived/removed, or a profile
  // switch swapped the whole catalog). Once projects have loaded, drop back to
  // the overview if the scoped id is gone.
  useEffect(() => {
    if (projectScope !== ALL_PROJECTS && projectsActive && !enteredProject) {
      exitProjectScope()
    }
  }, [projectScope, projectsActive, enteredProject])

  // The project overview (drill-in list) vs. the entered project's content.
  const projectOverview = projectsActive && !inProject ? agentProjectTree : undefined

  // Preview rows come from the backend tree (each project carries its
  // most-recent sessions), overlaid with live $sessions so a just-created
  // session shows under its project instantly (and with its working arc),
  // matching the flat Recents list. Keyed by project id for the rows.
  const overviewPreviews = useMemo<Record<string, SessionInfo[]>>(
    () =>
      overlayLivePreviews(projectOverview ?? [], agentSessions, projects, PROJECT_PREVIEW_COUNT, {
        removed: removedSessionIds,
        // Rank before the trim, so "3 priciest in this project" isn't "3 most
        // recent, priciest first".
        rankIds: sortOrderIds
      }),
    [projectOverview, agentSessions, projects, removedSessionIds, sortOrderIds]
  )

  const onEnterProject = useCallback(
    (id: string) => {
      const project = projectModel.find(node => node.id === id)

      if (project) {
        syncProjectCwd(project)
      }

      enterProject(id)
    },
    [projectModel, syncProjectCwd]
  )

  // The Sessions section is a project switcher in grouped mode: its label reads
  // "Sessions" when flat, "Projects" at the overview, and the project's name
  // once you've entered one.
  const sessionsLabel =
    inProject && enteredProject ? enteredProject.label : worktreeGroupingActive ? s.projects.sectionLabel : s.sessions

  // Mirror the section's skeleton gate (projectsLoading + nothing to show yet):
  // while the skeleton is up there's no point also spinning the header count.
  const projectsSkeletonVisible =
    worktreeGroupingActive &&
    projectTreeLoading &&
    !projectOverview?.length &&
    !(inProject && (enteredProject?.sessionCount ?? 0) > 0)

  return {
    agentProjectTree,
    enteredProject,
    enteredProjectContent,
    enteredProjectId,
    inProject,
    onEnterProject,
    overviewPreviews,
    projectModel,
    projectOverview,
    projectsSkeletonVisible,
    scopedRepoWorktrees,
    sessionsLabel
  }
}

export type SidebarProjectModel = ReturnType<typeof useSidebarProjectModel>
