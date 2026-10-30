import type * as React from 'react'

import { PlatformAvatar } from '@/app/messaging/platform-icon'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { KbdGroup } from '@/components/ui/kbd'
import { SearchField } from '@/components/ui/search-field'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from '@/components/ui/sidebar'
import { Tip, TipKeybindLabel } from '@/components/ui/tooltip'
import { type SessionInfo } from '@/hermes'
import { cn } from '@/lib/utils'
import {
  pinSession,
  setSidebarCronOpen,
  setSidebarPinsOpen,
  setSidebarRecentsOpen,
  toggleSidebarMessagingOpen,
  unpinSession
} from '@/store/layout'
import { $newChatProfile } from '@/store/profile'
import { exitProjectScope, openProjectCreate } from '@/store/projects'
import { openRouteTile } from '@/store/route-tiles'
import { markAllSessionsRead } from '@/store/session'
import { type SplitDir } from '@/store/session-states'
import { ackAllSessionsRead } from '@/store/session-unread'

import { type AppView, CRON_ROUTE, MESSAGING_PANE, routeIsShowing } from '../../routes'
import type { SidebarNavItem } from '../../types'
import { canOpenRouteTile } from '../route-tile'

import { SidebarCronJobsSection } from './cron-jobs-section'
import { SidebarFilterMenu } from './filter-menu'
import { SidebarLoadMoreRow } from './load-more-row'
import { NON_SESSION_INITIAL_ROWS, NON_SESSION_LOAD_STEP } from './paging'
import { ProfileRail } from './profile-switcher'
import { ProjectBackRow, ProjectMenu, StartWorkButton } from './projects'
import { SidebarBlankState, SidebarPinnedEmptyState, SidebarSessionSkeletons } from './section-states'
import { SidebarSessionsSection } from './sessions-section'
import { CONTEXT_SPLIT_KIT, SplitSubmenu } from './split-submenu'
import { useSidebarProjectModel } from './use-sidebar-project-model'
import { useSidebarSectionModel } from './use-sidebar-section-model'
import { useSidebarSessionModel } from './use-sidebar-session-model'

export { stripFtsMarkers } from './use-sidebar-session-model'

// Capabilities left this strip on 19 Oct (front K2): it was one of the two
// buried doors the owner could not find, and its home is now a Settings topic
// of its own. The rows that remain are untouched.
const SIDEBAR_NAV: SidebarNavItem[] = [
  {
    id: 'new-session',
    label: '',
    icon: props => <Codicon name="robot" {...props} />,
    action: 'new-session',
    keybindActionId: 'session.new'
  },
  {
    id: 'messaging',
    label: '',
    icon: props => <Codicon name="comment" {...props} />,
    route: MESSAGING_PANE,
    keybindActionId: 'nav.messaging'
  },
  // No `artifacts` row: `/artifacts` resolves to `home`, so the row would be a
  // door to nothing — and, since rows light by destination, it would also light
  // while the home stage is showing. There is no `nav.artifacts` keybind either.
  {
    id: 'cron',
    label: '',
    icon: props => <Codicon name="watch" {...props} />,
    route: CRON_ROUTE,
    keybindActionId: 'nav.cron'
  }
]

// Two modes via the `compact` height variant (styles.css):
//   tall    → each section is shrink-0, capped, its own scroller; Sessions is flex-1.
//   compact → COMPACT_FLAT drops the caps so the whole stack scrolls as one.
// Sections stay shrink-0 so none can be squeezed below its content and bleed onto
// the next — the flexbox `min-height: auto` overlap trap that caused the bug.
const COMPACT_FLAT = 'compact:max-h-none compact:overflow-visible'

// Vertical scroll only — never a horizontal bar from glow bleed, long titles,
// etc. The bar itself only shows while the pointer is in the list.
const SCROLL_Y = 'overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-fade'

// The outer list reserves its bar's width whether or not one is showing, so
// filtering or collapsing a section doesn't reflow every row sideways. Only the
// outer one: nested scrollers would each reserve their own and stack the inset.
const SCROLL_GUTTER = '[scrollbar-gutter:stable]'

// A non-session group's scroll body: own scroller when tall, flattened when compact.
const GROUP_BODY = cn(SCROLL_Y, COMPACT_FLAT)

// Section-header action icons stay hidden until the whole header row is hovered
// (group/section lives on SidebarSectionHeader), mirroring the artifacts/file
// browser header affordances. focus-visible keeps them keyboard-reachable.
const HEADER_ACTION_BTN =
  'text-(--ui-text-tertiary) opacity-0 transition-opacity hover:bg-(--ui-control-hover-background) hover:text-foreground group-hover/section:opacity-100 focus-visible:opacity-100'

// The view toggle (overview group toggle / in-project back) is the one control
// that stays visible at all times — it's the stable navigation affordance, not
// a hover-revealed action.
const HEADER_NAV_BTN =
  'text-(--ui-text-tertiary) opacity-70 transition-opacity hover:bg-(--ui-control-hover-background) hover:text-foreground hover:opacity-100 focus-visible:opacity-100'

// FTS results cover sessions that aren't in the loaded page; synthesize a
// minimal SessionInfo so they render in the same row component (resume works
// by id; the snippet stands in for the preview).

interface ChatSidebarProps extends React.ComponentProps<typeof Sidebar> {
  currentView: AppView
  onNavigate: (item: SidebarNavItem) => void
  onLoadMoreSessions: () => Promise<void> | void
  onLoadMoreMessaging?: (platform: string) => Promise<void> | void
  onResumeSession: (sessionId: string, session?: SessionInfo) => void
  onDeleteSession: (sessionId: string) => void
  onArchiveSession: (sessionId: string) => void
  onBranchSession: (sessionId: string) => void
  onNewSessionInWorkspace: (path: null | string) => void
  /** Create a brand-new session and open it as a tile on `dir`. */
  onNewSessionSplit: (dir: SplitDir) => void
  onManageCronJob: (jobId: string) => void
  onTriggerCronJob: (jobId: string) => Promise<void>
}

export function ChatSidebar({
  currentView,
  onNavigate,
  onLoadMoreSessions,
  onLoadMoreMessaging,
  onResumeSession,
  onDeleteSession,
  onArchiveSession,
  onBranchSession,
  onNewSessionInWorkspace,
  onNewSessionSplit,
  onManageCronJob,
  onTriggerCronJob
}: ChatSidebarProps) {
  const sidebarSessions = useSidebarSessionModel(currentView)
  const sidebarProjects = useSidebarProjectModel(sidebarSessions)

  const sidebarSections = useSidebarSectionModel(sidebarSessions, sidebarProjects, {
    onLoadMoreMessaging,
    onLoadMoreSessions
  })

  const {
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
    dndSensors,
    filtersActive,
    grouping,
    messagingOpenIds,
    messagingVisible,
    newSessionKbd,
    newSessionKbdFlash,
    panesFlipped,
    pathname,
    pinnedSessions,
    pinsOpen,
    projectTreeLoading,
    removedSessionIds,
    reposScanning,
    s,
    search,
    searchInputRef,
    searchPending,
    searchQuery,
    searchResults,
    sessionsLoading,
    setSearchQuery,
    showAllProfiles,
    showArchived,
    sortOrderIds,
    toggleUnread,
    trimmedQuery,
    unreadCount,
    worktreeGroupingActive
  } = sidebarSessions

  const {
    enteredProject,
    enteredProjectContent,
    enteredProjectId,
    inProject,
    onEnterProject,
    overviewPreviews,
    projectOverview,
    projectsSkeletonVisible,
    scopedRepoWorktrees,
    sessionsLabel
  } = sidebarProjects

  const {
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
  } = sidebarSections

  const newSessionKbdClass = cn('ml-auto', newSessionKbdFlash && '[&_kbd]:text-(--ui-text-primary)')

  return (
    <Sidebar
      className={cn(
        // Visibility is the layout tree's job (a hidden zone is display:none;
        // the narrow overlay renders the live instance) — the sidebar always
        // paints itself fully.
        'relative h-full min-w-0 overflow-hidden border-t-0 border-b-0 text-foreground transition-none',
        panesFlipped ? 'border-l border-r-0' : 'border-r border-l-0',
        'border-(--sidebar-edge-border) bg-(--ui-sidebar-surface-background) opacity-100'
      )}
      collapsible="none"
    >
      <SidebarContent className="gap-0 overflow-hidden bg-transparent px-2.5">
        <SidebarGroup className="shrink-0 p-0 pb-2 pt-[calc(var(--titlebar-height)+0.375rem)]">
          <SidebarGroupContent>
            <SidebarMenu className="gap-px">
              {[...SIDEBAR_NAV, ...contributedNav].map(item => {
                const isInteractive = Boolean(item.action) || Boolean(item.route)

                // At its OWN destination, query included: matching ids against
                // `currentView` went dark the day a page became a Settings pane.
                const active = item.route ? routeIsShowing(item.route, pathname, search) : false

                const isNewSession = item.id === 'new-session'

                const button = (
                  <SidebarMenuButton
                    aria-disabled={!isInteractive}
                    className={cn(
                      // no-drag: these rows sit directly under the titlebar's
                      // [-webkit-app-region:drag] strips (app-shell.tsx), with only
                      // 6px of clearance. Drag regions win hit-testing over DOM
                      // (pointer-events can't override), and on Linux/WSLg the
                      // resolved region has been observed to swallow clicks on the
                      // top rows. Same carve-out as USER_BUBBLE_BASE_CLASS in
                      // thread.tsx.
                      'flex h-7 w-full justify-start gap-2 rounded-md border border-transparent px-2 text-left text-[0.8125rem] font-medium text-(--ui-text-secondary) transition-colors duration-100 ease-out [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background) hover:text-foreground hover:transition-none',
                      active &&
                        'border-(--ui-stroke-tertiary) bg-(--ui-control-active-background) text-foreground shadow-none hover:border-(--ui-stroke-tertiary)!',
                      !isInteractive &&
                        'cursor-default hover:border-transparent hover:bg-transparent hover:text-inherit'
                    )}
                    onClick={() => {
                      // A plain new session lands in whatever profile the live
                      // gateway is on (= the active switcher context). null →
                      // no swap. The switcher header is the single place to
                      // change which profile that is.
                      if (isNewSession) {
                        $newChatProfile.set(null)
                      }

                      onNavigate(item)
                    }}
                    tooltip={
                      item.keybindActionId
                        ? {
                            children: (
                              <TipKeybindLabel actionId={item.keybindActionId} text={s.nav[item.id] ?? item.label} />
                            )
                          }
                        : (s.nav[item.id] ?? item.label)
                    }
                    type="button"
                  >
                    <item.icon className="size-4 shrink-0 text-[color-mix(in_srgb,currentColor_72%,transparent)]" />
                    <span className="min-w-0 flex-1 truncate">{s.nav[item.id] ?? item.label}</span>
                    {isNewSession && (
                      <KbdGroup className={newSessionKbdClass} keys={newSessionKbd} size="sm" variant="ghost" />
                    )}
                  </SidebarMenuButton>
                )

                // New session + MOUNTABLE route-backed pages can open in a split —
                // right-click for the directional "Open in split" submenu.
                return (
                  <SidebarMenuItem key={item.id}>
                    {isNewSession || (item.route && canOpenRouteTile(item.route)) ? (
                      <ContextMenu>
                        <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
                        <ContextMenuContent aria-label={s.nav[item.id] ?? item.label}>
                          <SplitSubmenu
                            kit={CONTEXT_SPLIT_KIT}
                            label={s.row.openInSplit}
                            onSplit={dir => {
                              if (isNewSession) {
                                onNewSessionSplit(dir)
                              } else if (item.route) {
                                openRouteTile(item.route, dir)
                              }
                            }}
                          />
                        </ContextMenuContent>
                      </ContextMenu>
                    ) : (
                      button
                    )}
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {showSessionSections && (
          <div className="shrink-0 px-2 pb-1 pt-1">
            <SearchField
              aria-label={s.searchAria}
              inputRef={searchInputRef}
              onChange={setSearchQuery}
              placeholder={s.searchPlaceholder}
              value={searchQuery}
            />
          </div>
        )}

        {showSessionSections && (
          <div
            className={cn('flex min-h-0 flex-1 flex-col pb-1.75', SCROLL_Y, SCROLL_GUTTER)}
            data-sessions-mode={sessionsMode}
            data-sessions-project={inProject ? (enteredProjectId ?? undefined) : undefined}
          >
            {trimmedQuery && (
              <SidebarSessionsSection
                activeSessionId={activeSidebarSessionId}
                contentClassName={cn('flex min-h-0 flex-1 flex-col gap-px pb-1.75', SCROLL_Y)}
                emptyState={
                  searchPending ? (
                    <SidebarSessionSkeletons />
                  ) : (
                    <div className="wrap-anywhere grid min-h-24 place-items-center rounded-lg px-2 text-center text-xs text-(--ui-text-tertiary)">
                      {s.noMatch(trimmedQuery)}
                    </div>
                  )
                }
                label={s.results}
                onArchiveSession={onArchiveSession}
                onBranchSession={onBranchSession}
                onDeleteSession={onDeleteSession}
                onResumeSession={onResumeSession}
                onToggle={() => undefined}
                onTogglePin={pinSession}
                onToggleUnread={toggleUnread}
                open
                pinned={false}
                rootClassName="min-h-32 flex-1 overflow-hidden p-0"
                sessions={searchResults}
                showProfileTags={showAllProfiles}
              />
            )}

            {!trimmedQuery && (
              <SidebarSessionsSection
                activeSessionId={activeSidebarSessionId}
                contentClassName="flex flex-col gap-px rounded-lg pb-2 pt-1"
                dndSensors={dndSensors}
                emptyState={<SidebarPinnedEmptyState />}
                label={s.pinned}
                onArchiveSession={onArchiveSession}
                onBranchSession={onBranchSession}
                onDeleteSession={onDeleteSession}
                onReorderSessions={reorderPinned}
                onResumeSession={onResumeSession}
                onToggle={() => setSidebarPinsOpen(!pinsOpen)}
                onTogglePin={unpinSession}
                onToggleUnread={toggleUnread}
                open={pinsOpen}
                pinned
                rootClassName="shrink-0 p-0 pb-1"
                sessions={pinnedSessions}
                showProfileTags={showAllProfiles}
                sortable={pinnedSessions.length > 1}
              />
            )}

            {!trimmedQuery && (
              <SidebarSessionsSection
                activeProjectId={activeProjectId}
                activeSessionId={activeSidebarSessionId}
                // Inbox style is a render variant, not a grouping — it rides
                // whichever view is active: flat recents, project lanes, and
                // the overview previews all render the same card.
                card={cardRows}
                collapsible={!inProject}
                contentClassName={cn(
                  'flex min-h-0 flex-1 flex-col gap-px pb-1.75',
                  // The section is the ONE authority on whether the virtual
                  // list owns scrolling: it neutralizes this wrapper scroller
                  // itself (overflow-visible) when it virtualizes. Gating
                  // SCROLL_Y here on index's own parallel guess desynced the
                  // two — a cached project tree flipped this side but not the
                  // section's, leaving the list with no scroller at all and
                  // the recents pane rendering blank under Updated grouping.
                  SCROLL_Y,
                  // Flatten into the single scroll when compact — unless this is the
                  // virtualized long list, which must keep its own scroller.
                  !recentsVirtualizes && COMPACT_FLAT
                )}
                dndSensors={dndSensors}
                emptyState={
                  showSessionSkeletons ? (
                    <SidebarSessionSkeletons />
                  ) : (
                    <div className="grid min-h-16 place-items-center rounded-lg px-2 text-center text-xs text-(--ui-text-tertiary)">
                      {inProject
                        ? s.projectEmpty
                        : filtersActive
                          ? s.noFilterMatches
                          : pinnedSessions.length > 0
                            ? s.allPinned
                            : s.noSessions}
                    </div>
                  )
                }
                footer={
                  // Hidden only when workspace-grouped — those groups page
                  // themselves. Profile groups don't: this one footer fetches the
                  // next page, which grows every profile at once.
                  !agentsGrouped && !showSessionSkeletons && hasMoreSessions ? (
                    <SidebarLoadMoreRow
                      loading={sessionsLoading || recentsLoadMorePending}
                      onClick={() => void onLoadMoreRecents()}
                      // Recents are post-filtered to non-project sessions, so a
                      // backend page size (50) is not a truthful "rows you'll
                      // see" count. Use the generic label instead of a fake N.
                      step={0}
                    />
                  ) : null
                }
                forceEmptyState={showSessionSkeletons}
                // Archived is a plain list, and so is a magnitude-ranked one.
                // Otherwise project lanes stay chronological whatever the flat
                // list does — only the flat list can swap its dividers for
                // WORKING / DONE.
                grouping={showArchived || rankedGlobally ? 'none' : grouping === 'status' ? 'status' : 'date'}
                groups={displayAgentGroups}
                headerAction={
                  // One cluster, not a fragment: the header is justify-between,
                  // so two children (mark-all + the rest) park the check-all in
                  // the middle as a blank 24px hole until hover.
                  <div className="flex shrink-0 items-center gap-0.5">
                    {unreadCount > 0 && (
                      <Tip label={s.markAllRead}>
                        <Button
                          aria-label={s.markAllRead}
                          className={HEADER_ACTION_BTN}
                          onClick={event => {
                            event.stopPropagation()
                            markAllSessionsRead()
                            // Ack the persisted layer too, or the next list
                            // refresh repaints every dot just dismissed.
                            ackAllSessionsRead()
                          }}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <Codicon name="check-all" size="0.75rem" />
                        </Button>
                      </Tip>
                    )}
                    {inProject && enteredProject ? (
                      <div className="group/workspace flex shrink-0 items-center gap-0.5">
                        {enteredProject.path && <StartWorkButton repoPath={enteredProject.path} />}
                        {/* Home has no folder and no record to rename, theme, or delete. */}
                        {!enteredProject.isNoProject && (
                          <ProjectMenu
                            isActive={enteredProject.id === activeProjectId}
                            onExitScope={exitProjectScope}
                            project={enteredProject}
                            scoped
                          />
                        )}
                        <div className="grid size-6 place-items-center">
                          <Tip label={s.showProjects}>
                            <Button
                              aria-label={s.showProjects}
                              className={HEADER_NAV_BTN}
                              onClick={event => {
                                event.stopPropagation()
                                exitProjectScope()
                              }}
                              size="icon-xs"
                              variant="ghost"
                            >
                              <Codicon name="list-unordered" size="0.75rem" />
                            </Button>
                          </Tip>
                        </div>
                      </div>
                    ) : (
                      <>
                        {!showAllProfiles ? (
                          <Tip label={agentsGrouped ? s.projects.newButton : s.nav['new-session']}>
                            <Button
                              aria-label={agentsGrouped ? s.projects.newButton : s.nav['new-session']}
                              className={HEADER_ACTION_BTN}
                              onClick={event => {
                                event.stopPropagation()

                                if (agentsGrouped) {
                                  openProjectCreate()
                                } else {
                                  onNewSessionInWorkspace(null)
                                }
                              }}
                              size="icon-xs"
                              variant="ghost"
                            >
                              <Codicon name="add" size="0.75rem" />
                            </Button>
                          </Tip>
                        ) : null}
                        <div className="grid size-6 place-items-center">
                          <SidebarFilterMenu className={HEADER_NAV_BTN} />
                        </div>
                      </>
                    )}
                  </div>
                }
                label={sessionsLabel}
                labelMeta={
                  worktreeGroupingActive ? (
                    reposScanning && !projectsSkeletonVisible ? (
                      <GlyphSpinner ariaLabel={s.loading} className="text-[0.6875rem] text-(--ui-text-quaternary)" />
                    ) : undefined
                  ) : undefined
                }
                liveSessions={inProject ? agentSessions : undefined}
                manualOrderIds={agentOrderManual ? agentOrderIds : sortOrderIds}
                onArchiveSession={onArchiveSession}
                onBranchSession={onBranchSession}
                onDeleteSession={onDeleteSession}
                onEnterProject={onEnterProject}
                // Unlike reorder below, this stays on across profiles: a folder
                // is a folder, and the new session lands in the active profile
                // — the same one the composer would have started it in.
                onNewSessionInWorkspace={onNewSessionInWorkspace}
                onReorderProjects={showAllProfiles ? undefined : reorderProjects}
                onReorderSessions={showAllProfiles ? undefined : reorderSessions}
                onResumeSession={onResumeSession}
                onToggle={() => setSidebarRecentsOpen(!agentsOpen)}
                onTogglePin={pinSession}
                onToggleUnread={toggleUnread}
                open={agentsOpen}
                pinned={false}
                projectBackRow={
                  inProject ? <ProjectBackRow label={s.projects.back} onClick={exitProjectScope} /> : undefined
                }
                projectContent={inProject ? enteredProjectContent : undefined}
                projectOverview={projectOverview}
                projectOverviewPreviews={overviewPreviews}
                projectRepoWorktrees={inProject ? scopedRepoWorktrees : undefined}
                projectsLoading={worktreeGroupingActive ? projectTreeLoading : false}
                removedSessionIds={inProject ? removedSessionIds : undefined}
                rootClassName={cn(
                  'min-h-32 flex-1 overflow-hidden p-0',
                  !recentsVirtualizes && 'compact:min-h-0 compact:flex-none compact:overflow-visible'
                )}
                sessions={displayAgentSessions}
                sortable={!showAllProfiles && agentSessions.length > 1}
              />
            )}

            {!trimmedQuery &&
              !worktreeGroupingActive &&
              messagingGroups.map(group => {
                const visible = messagingVisible[group.sourceId] ?? NON_SESSION_INITIAL_ROWS
                const shownSessions = group.sessions.slice(0, visible)
                // More to show if rows are hidden behind the cap, or the backend
                // still has older threads on disk.
                const canRevealMore = visible < group.sessions.length || group.hasMore

                return (
                  <SidebarSessionsSection
                    activeSessionId={activeSidebarSessionId}
                    contentClassName={cn('flex max-h-56 flex-col gap-px pb-1.75', GROUP_BODY)}
                    emptyState={null}
                    footer={
                      canRevealMore ? (
                        <SidebarLoadMoreRow
                          loading={Boolean(messagingLoadMorePending[group.sourceId])}
                          onClick={() => revealMoreMessaging(group.sourceId, group.sessions.length, group.hasMore)}
                          step={Math.min(NON_SESSION_LOAD_STEP, Math.max(0, group.total - shownSessions.length))}
                        />
                      ) : null
                    }
                    key={group.sourceId}
                    label={group.label}
                    labelIcon={
                      <PlatformAvatar
                        className="size-4 rounded-[4px] text-[0.5625rem] [&_svg]:size-3"
                        platformId={group.sourceId}
                        platformName={group.label}
                      />
                    }
                    onArchiveSession={onArchiveSession}
                    onDeleteSession={onDeleteSession}
                    onResumeSession={onResumeSession}
                    onToggle={() => toggleSidebarMessagingOpen(group.sourceId)}
                    onTogglePin={pinSession}
                    onToggleUnread={toggleUnread}
                    open={messagingOpenIds.includes(group.sourceId)}
                    pinned={false}
                    rootClassName="shrink-0 p-0"
                    sessions={shownSessions}
                  />
                )
              })}

            {!trimmedQuery && !worktreeGroupingActive && cronJobs.length > 0 && (
              <SidebarCronJobsSection
                jobs={cronJobs}
                label={s.cronJobs}
                onManageJob={onManageCronJob}
                onOpenRun={onResumeSession}
                onToggle={() => setSidebarCronOpen(!cronOpen)}
                onTriggerJob={onTriggerCronJob}
                open={cronOpen}
              />
            )}
          </div>
        )}

        {!showSessionSections && <SidebarBlankState onNewProject={openProjectCreate} />}

        <div className="shrink-0 px-0.5 pb-1 pt-0.5">
          <ProfileRail />
        </div>
      </SidebarContent>
      {/* ProjectDialog + WorktreeDialog moved to ContribWiring — the app-wide
          single mounts must outlive this surface (it now lives inside the
          Settings → Sessions & Bots pane, mounted only while open). */}
    </Sidebar>
  )
}
