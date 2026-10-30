import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { codiconIcon } from '@/components/ui/codicon'
import { getHermesConfigRecord, listAllProfileSessions } from '@/hermes'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useI18n } from '@/i18n'
import { Activity, AppWindow, Archive, BarChart3, Download, GitBranch, Palette, RefreshCw, Sun, Zap } from '@/lib/icons'
import { resolveVersionStatus } from '@/lib/version-status'
import { $repoWorktrees } from '@/store/coding-status'
import {
  $commandPaletteOpen,
  $commandPalettePage,
  $commandPaletteSeed,
  closeCommandPalette,
  closeCommandPaletteAfterAction,
  restoreCommandPaletteFocus
} from '@/store/command-palette'
import { $bindings } from '@/store/keybinds'
import { $dismissedAutoProjectIds, filterVisibleProjects } from '@/store/layout'
import { openBrowserTab } from '@/store/preview'
import { $projectTree, goToProject, openFolderAsProject, requestStartWorkSession } from '@/store/projects'
import { $connection } from '@/store/session'
import {
  $backendUpdateApply,
  $backendUpdateStatus,
  $desktopVersion,
  $updateApply,
  $updateStatus
} from '@/store/updates'
import { canOpenNewWindow, openNewWindow } from '@/store/windows'
import { type ThemeMode, useTheme } from '@/themes/context'

import { openSession, openSessionIntentFromModifiers } from '../open-session'
import { COMMAND_CENTER_PANE, navigateToWorkspacePage, SETTINGS_ROUTE } from '../routes'
import { SECTIONS } from '../settings/constants'
import { settingsArrivalOptions } from '../settings/settings-arrival'
import { type SettingsSearchEntry, settingsSearchTargetQuery } from '../settings/settings-search'
import { useSettingsSearchCatalog } from '../settings/use-settings-search'

import { usePaletteContributions } from './contrib'
import { MarketplaceThemePage } from './marketplace-theme-page'
import { isPalettePage, type PalettePageId } from './pages'
import { rankGroups } from './rank'
import { routeCommands } from './routes-commands'
import { useSearchGroups, useSettingsPageGroups } from './search-groups'
import { toSessionEntry } from './sessions'
import { NON_CONFIG_SETTINGS, SETTINGS_PANE_DESTINATIONS } from './settings-rows'
import { PaletteSheet, type SelectMods } from './sheet'
import { THEME_MODES, themeSupportsMode } from './theme-modes'
import type { PaletteGroup, PaletteItem, PalettePage } from './types'

// Nested page → its parent, so Back / Esc step up one level instead of closing
// the palette. Pages absent here go straight back to the root list.
const PAGE_PARENTS: Partial<Record<PalettePageId, PalettePageId>> = { 'install-theme': 'theme' }

// Backstop only. The palette normally retires on the content's real
// `animationend`, so the CSS owns the close duration; this just guarantees the
// body can't stay mounted forever somewhere animations never run (jsdom,
// `animation: none`). Deliberately longer than any plausible exit so it never
// races the real signal and truncates the fade.
const EXIT_FALLBACK_MS = 1000

/**
 * ⌘K is an overlay that is stateful to itself: pressing it must open a frame
 * immediately, and must not be held up by whatever else the shell is doing. So
 * the mounted cost of a CLOSED palette is one store subscription and nothing
 * else.
 *
 * Everything expensive — a dozen store subscriptions (connection, update
 * status/apply, keybinds, worktrees, projects, theme, i18n), three server
 * queries, and the group builders that assemble a few hundred rows — lives in
 * `CommandPaletteBody`, which only exists while the palette is on screen.
 * Before this split those hooks ran on every render of the always-mounted
 * component: an in-flight update rewrote `$updateApply` per progress line and
 * rebuilt the entire row set each time, for a surface nobody could see.
 *
 * `mounted` lags `open` by the close animation rather than tracking it exactly.
 * Unmounting the body the instant `open` flips false would rip the content out
 * of the tree before the sheet could play its exit, so the overlay would
 * vanish instead of closing. The body reports its own exit via
 * `onExited` (the content's real `animationend`), so nothing here has to know
 * how long that animation is — the CSS owns the duration.
 *
 * The `openCount` key remounts the body per open, which is what lets local
 * search/sub-page state reset without a close effect.
 */
export function CommandPalette() {
  const open = useStore($commandPaletteOpen)
  const [mounted, setMounted] = useState(open)
  const [openCount, setOpenCount] = useState(0)

  const retire = useCallback(() => {
    // Only retire the body if the palette is still closed — a reopen mid-fade
    // must not unmount the fresh instance.
    if (!$commandPaletteOpen.get()) {
      setMounted(false)
      restoreCommandPaletteFocus()
    }
  }, [])

  useEffect(() => {
    if (open) {
      setOpenCount(count => count + 1)
      setMounted(true)

      return
    }

    // Safety net for environments where the exit animation never runs (jsdom,
    // `animation: none`), so the body can't be stranded mounted. The real
    // unmount is `onExited` below; whichever fires first wins.
    const timer = setTimeout(retire, EXIT_FALLBACK_MS)

    return () => clearTimeout(timer)
  }, [open, retire])

  // No provider, no dialog root: the sheet is our own portal, and `mounted`
  // outliving `open` is what lets the exit animation play.
  return mounted ? <CommandPaletteBody key={openCount} onExited={retire} /> : null
}

function CommandPaletteBody({ onExited }: { onExited: () => void }) {
  const { t } = useI18n()
  const pendingPage = useStore($commandPalettePage)
  const pendingSeed = useStore($commandPaletteSeed)
  const bindings = useStore($bindings)
  const worktrees = useStore($repoWorktrees)
  const projectTree = useStore($projectTree)
  const dismissedAutoProjects = useStore($dismissedAutoProjectIds)
  const navigate = useNavigate()

  const { availableThemes, clearThemePreview, mode, previewTheme, resolvedMode, setMode, setTheme, themeName } =
    useTheme()

  // Mode rows preview like theme rows do: paint the committed skin at the
  // highlighted brightness. `system` has to be resolved here — previewTheme
  // paints a concrete light/dark.
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')

  const resolveThemeMode = useCallback(
    (target: ThemeMode): 'light' | 'dark' => (target === 'system' ? (systemDark ? 'dark' : 'light') : target),
    [systemDark]
  )

  const [search, setSearch] = useState('')
  const [page, setPage] = useState<null | PalettePageId>(null)
  /** A door named a page that does not exist (see the deep-link effect). */
  const [deadDoor, setDeadDoor] = useState<null | string>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // The Update row names the same install the statusbar names — same target
  // selection, same resolver. Reduced to the label string: an in-flight apply
  // rewrites these stores on every progress line, and only a changed string
  // should rebuild the palette's groups.
  const connection = useStore($connection)
  const desktopVersion = useStore($desktopVersion)
  const clientStatus = useStore($updateStatus)
  const clientApply = useStore($updateApply)
  const backendStatus = useStore($backendUpdateStatus)
  const backendApply = useStore($backendUpdateApply)

  const updateVersionLabel = useMemo(() => {
    const backend = connection?.mode === 'remote'
    const apply = backend ? backendApply : clientApply
    const status = backend ? backendStatus : clientStatus

    return resolveVersionStatus({
      applying: apply.applying || apply.stage === 'restart',
      behind: status?.behind ?? 0,
      copy: t.shell.statusbar,
      remote: backend,
      restarting: apply.stage === 'restart',
      sha: status?.currentSha?.slice(0, 7) ?? null,
      target: backend ? 'backend' : 'client',
      pin: !backend && status?.pinned && status.pinSha ? { aligned: status.aligned ?? null, sha: status.pinSha } : null,
      updateAvailable: status?.updateAvailable,
      version: backend ? status?.currentVersion : desktopVersion?.appVersion,
      versionLine: backend ? null : desktopVersion?.versionLine
    }).label
  }, [
    backendApply,
    backendStatus,
    clientApply,
    clientStatus,
    connection?.mode,
    desktopVersion?.appVersion,
    desktopVersion?.versionLine,
    t
  ])

  // Live ⌘/⌃-held state while the palette is open: rows with a modifier
  // variant (projects) preview it by swapping their label. Window-level
  // listeners because focus sits in the search input; blur clears so a
  // ⌘-Tab away doesn't strand the preview on.
  const [modHeld, setModHeld] = useState(false)

  useEffect(() => {
    const sync = (event: KeyboardEvent) => setModHeld(event.metaKey || event.ctrlKey)
    const clear = () => setModHeld(false)

    window.addEventListener('keydown', sync, { capture: true })
    window.addEventListener('keyup', sync, { capture: true })
    window.addEventListener('blur', clear)

    return () => {
      window.removeEventListener('keydown', sync, { capture: true })
      window.removeEventListener('keyup', sync, { capture: true })
      window.removeEventListener('blur', clear)
    }
  }, [])

  // Server-backed sources for the type-to-search groups. This component only
  // exists while the palette is open, so the queries are inherently lazy — no
  // `enabled` gate needed. react-query handles caching/dedup/staleness, so a
  // reopen paints from cache and revalidates in the background.
  const configQuery = useQuery({
    queryKey: ['command-palette', 'config'],
    queryFn: () => getHermesConfigRecord()
  })

  const sessionsQuery = useQuery({
    queryKey: ['command-palette', 'sessions'],
    queryFn: () => listAllProfileSessions(200, 1, 'exclude')
  })

  const archivedQuery = useQuery({
    queryKey: ['command-palette', 'archived'],
    queryFn: () => listAllProfileSessions(200, 0, 'only')
  })

  const mcpServers = useMemo(() => {
    const raw = configQuery.data?.mcp_servers

    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.keys(raw as Record<string, unknown>).sort()
      : []
  }, [configQuery.data])

  const sessions = useMemo(() => (sessionsQuery.data?.sessions ?? []).map(toSessionEntry), [sessionsQuery.data])
  const archivedSessions = useMemo(() => (archivedQuery.data?.sessions ?? []).map(toSessionEntry), [archivedQuery.data])

  // Search/sub-page are local to a mount, and this component remounts per open
  // (keyed by open count), so each open starts clean without a reset effect.

  // Deep-link into a nested page (e.g. typing on Settings → the Settings page).
  // An id that is not a declared page is a DOOR INTO NOTHING: it used to show
  // the root list in silence, which is how a deleted page keeps a live label.
  //
  // The HARD failure lives in `routes-commands.test.ts`, which walks all of
  // `src` for doors and cannot be skipped. At runtime this effect degrades
  // instead: it is mounted under the app's root error boundary, so a throw here
  // would replace the WHOLE window over one wrong row. So we log, keep the
  // palette standing on the root list, and name the bad id in the sheet's
  // notice line in dev builds only — a raw page id is developer text, never a
  // string to put in front of a user.
  useEffect(() => {
    if (!pendingPage) {
      return
    }

    $commandPalettePage.set(null)

    if (!isPalettePage(pendingPage)) {
      console.error(`command palette: no page "${pendingPage}" — fix or remove the door that opened it`)
      setDeadDoor(pendingPage)

      return
    }

    setDeadDoor(null)
    setPage(pendingPage)
  }, [pendingPage])

  // Landing on a page (deep-link open onto Settings, drilling into a submenu,
  // stepping back out) must leave the filter typeable immediately — the whole
  // point of the pill/⌘K hand-off is "just start typing". The sheet autofocuses
  // on mount only; a page swap re-renders the same input, and the back-button
  // click moves focus to the button.
  useEffect(() => {
    inputRef.current?.focus()
  }, [page])

  // Type-to-search hand-off: the keystroke that opened the palette (typing on
  // the Settings page) prefills the filter so the first character isn't lost.
  useEffect(() => {
    if (pendingSeed !== null) {
      setSearch(pendingSeed)
      $commandPaletteSeed.set(null)
    }
  }, [pendingSeed])

  // A palette row into Settings is an explicit arrival, even at the pane on
  // screen: it opens that pane's rail group (settings-arrival.ts).
  const go = useCallback(
    (path: string) => () => navigateToWorkspacePage(navigate, path, settingsArrivalOptions(path)),
    [navigate]
  )

  // Sessions: plain select = open beside what's already loaded (focus existing
  // tile/main, else a new tab — main only when it's a blank draft);
  // ⌘/⌃-select / ⌘-Enter = force a new tab; ⇧⌘ = own window. Same door as the
  // sidebar, minus the sidebar's licence to spend main.
  const goSession = useCallback(
    (sessionId: string) => (event?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => {
      openSession(sessionId, navigate, openSessionIntentFromModifiers(event, 'stack'))
    },
    [navigate]
  )

  // Step up one nested page (or back to the root list), clearing the filter so
  // the parent page doesn't reopen mid-search.
  const goBack = useCallback(() => {
    setSearch('')
    setPage(prev => (prev ? (PAGE_PARENTS[prev] ?? null) : null))
  }, [])

  const settingsSectionLabel = useCallback(
    (section: (typeof SECTIONS)[number]) => t.settings.sections[section.id] ?? section.label,
    [t.settings.sections]
  )

  // Running a keepOpen row (a toggle) changes state the rows themselves report,
  // so the groups have to rebuild without the palette closing. A counter keeps
  // that generic — the palette never learns which stores its contributions read.
  const [selectTick, setSelectTick] = useState(0)

  const contributedItems = usePaletteContributions()

  // The active repo's worktrees → "new conversation in <branch>". This is the
  // ⌘K-typed "I want to work on <branch>" reflex: each entry seeds a fresh
  // session anchored to that worktree's checkout (requestStartWorkSession),
  // so git is the source of truth and edits land in the right tree.
  const branchGroup = useMemo<PaletteGroup[]>(
    () =>
      worktrees.length > 0
        ? [
            {
              heading: t.commandCenter.branches,
              items: worktrees.map(wt => {
                const name = wt.branch?.trim() || wt.path.split('/').pop() || wt.path

                return {
                  icon: GitBranch,
                  id: `worktree-${wt.path}`,
                  keywords: ['branch', 'worktree', 'switch', name, wt.path],
                  label: t.commandCenter.startInBranch(name),
                  run: () => requestStartWorkSession(wt.path)
                }
              })
            }
          ]
        : [],
    [t, worktrees]
  )

  const baseGroups = useMemo<PaletteGroup[]>(() => {
    const settingsTab = (tab: string) => `${SETTINGS_ROUTE}?tab=${tab}`
    const cc = t.commandCenter

    // Projects are the primary way the desktop scopes work, so they're jumpable
    // from the palette. Plain select is a pure scope switch (sidebar enters the
    // project — never spends main); ⌘-Enter / ⌘-click also starts a new session
    // at the project root (stacked as a tab when main holds a chat), previewed
    // by the label swap while ⌘ is held. Rows carry the project's own codicon,
    // matching the sidebar. The pinned "Open folder…" row is the ⌘O upsert.
    const projectGroup: PaletteGroup = {
      heading: cc.projects,
      items: [
        {
          action: 'workspace.openFolder',
          icon: codiconIcon('folder-opened'),
          id: 'project-open-folder',
          keywords: ['open', 'folder', 'directory', 'project', 'add', 'import', 'workspace'],
          label: cc.openFolder,
          run: () => void openFolderAsProject()
        },
        ...filterVisibleProjects(projectTree, dismissedAutoProjects).map(project => ({
          comboHint: 'mod+enter',
          icon: codiconIcon(project.icon || (project.isNoProject ? 'home' : 'folder-library')),
          id: `project-${project.id}`,
          keywords: ['project', 'workspace', 'go to', project.label, ...(project.path ? [project.path] : [])],
          label: project.label,
          modLabel: cc.newSessionInProject(project.label),
          runWithEvent: (event?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) =>
            goToProject(project.id, { newSession: Boolean(event?.metaKey || event?.ctrlKey) })
        }))
      ]
    }

    // Group order is the tiebreaker rankGroups falls back on (stable sort), and
    // exact ties are the common case — "yolo" hits both "Toggle yolo" and a
    // worktree named bb/yolo-* as a whole word. So this order IS the priority:
    // where you're going, then what you can do, then what you can configure.
    return [
      {
        heading: cc.goTo,
        items: [
          // Read from the route REGISTRY, not listed here: a page that stops
          // declaring its route stops being offered, and a new page cannot
          // register without a label (routes-commands.ts). Owner #9 — only
          // the commands that make sense in this app.
          ...routeCommands(t, go),
          // Not routes any more, and therefore invisible to the registry above:
          // two Settings panes that are a page you go TO (settings-rows.ts).
          ...SETTINGS_PANE_DESTINATIONS.map(entry => ({
            icon: entry.icon,
            id: `goto-${entry.id}`,
            keywords: entry.keywords,
            label: entry.label(t),
            run: go(settingsTab(entry.tab))
          })),
          // Not a route: a second window of the same app.
          ...(canOpenNewWindow()
            ? [
                {
                  action: 'session.newWindow',
                  icon: AppWindow,
                  id: 'nav-new-window',
                  keywords: ['window', 'instance', 'open', 'new'],
                  label: t.keybinds.actions['session.newWindow'],
                  run: () => void openNewWindow()
                }
              ]
            : [])
        ]
      },
      projectGroup,
      // Registry-contributed rows (core features + plugins) — one group,
      // omitted while nothing contributes.
      ...(contributedItems.length > 0
        ? [
            {
              heading: cc.commands,
              items: contributedItems.map(item => ({
                action: item.action,
                // Read on mount and after every select (the deps below), so a
                // row that reports state can't show the state it just left.
                detail: item.detail?.(),
                detailVariant: item.detailVariant,
                icon: item.icon ?? Zap,
                id: item.key,
                keepOpen: item.keepOpen,
                keywords: item.keywords,
                label: item.label,
                run: item.run
              }))
            }
          ]
        : []),
      {
        heading: cc.commandCenter,
        items: [
          {
            icon: Archive,
            id: 'cc-sessions',
            keywords: ['command center', 'sessions', 'pin'],
            label: cc.sections.sessions,
            run: go(`${COMMAND_CENTER_PANE}&section=sessions`)
          },
          {
            icon: Activity,
            id: 'cc-system',
            keywords: ['command center', 'system', 'status', 'logs'],
            label: cc.sections.system,
            run: go(`${COMMAND_CENTER_PANE}&section=system`)
          },
          {
            icon: BarChart3,
            id: 'cc-usage',
            keywords: ['command center', 'usage', 'tokens', 'cost'],
            label: cc.sections.usage,
            run: go(`${COMMAND_CENTER_PANE}&section=usage`)
          },
          // A developer command (U2-p2-05-p2b): the dev build only.
          ...(import.meta.env.DEV
            ? [
                {
                  icon: RefreshCw,
                  id: 'cc-reload-window',
                  keywords: ['reload', 'window', 'refresh', 'restart', 'ui', 'stuck'],
                  label: cc.reloadWindow,
                  run: () => window.location.reload()
                }
              ]
            : []),
          {
            action: 'view.showBrowser',
            icon: codiconIcon('globe'),
            id: 'cc-open-browser',
            keywords: ['browser', 'web', 'url', 'address', 'open', 'navigate', 'internet', 'site'],
            label: cc.openBrowser,
            run: () => openBrowserTab()
          }
        ]
      },
      {
        // Declared before Settings: `rankGroups` keeps declaration order within
        // a score, so this keeps the theme/mode pickers on top for
        // "theme"/"color" queries instead of buried under a fuzzy Settings match.
        heading: cc.appearance,
        items: [
          {
            icon: Palette,
            id: 'appearance-theme',
            keywords: ['theme', 'appearance', 'color', 'palette', 'skin', 'dark', 'light', 'look'],
            label: cc.changeTheme,
            to: 'theme'
          },
          {
            icon: Sun,
            id: 'appearance-mode',
            keywords: ['appearance', 'color mode', 'brightness', 'dark', 'light', 'system'],
            label: cc.changeColorMode,
            to: 'color-mode'
          }
        ]
      },
      {
        heading: cc.settings,
        items: [
          ...SECTIONS.map(section => ({
            icon: section.icon,
            id: `set-config-${section.id}`,
            keywords: ['settings', section.label, settingsSectionLabel(section)],
            label: settingsSectionLabel(section),
            run: go(settingsTab(`config:${section.id}`))
          })),
          ...NON_CONFIG_SETTINGS.map(entry => ({
            icon: entry.icon,
            id: `set-${entry.tab}`,
            keywords: ['settings', ...(entry.keywords ?? [])],
            label: t.settings.nav[entry.labelKey],
            run: go(settingsTab(entry.tab))
          }))
        ]
      }
    ]
    // `selectTick` is a deliberate re-read trigger, not a value: rows report
    // live state through `detail()`, so the groups must rebuild after a select
    // that kept the palette open — eslint only sees an unused dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    contributedItems,
    dismissedAutoProjects,
    go,
    projectTree,
    selectTick,
    settingsSectionLabel,
    t,
    updateVersionLabel
  ])

  // The long, granular lists (settings fields, API keys, MCP servers, archived
  // chats) only surface once the user types — otherwise they'd bury the
  // navigation entries on an empty palette.
  //
  // Settings results are the DEEP catalog (schema-driven config fields,
  // appearance controls, stored credentials — the same entries the Settings
  // page serves), not a hardcoded key list: ⌘K is the de-facto settings
  // search everywhere, so root and the settings page must agree. The body
  // mounts per open, so the catalog queries fire on open and stay warm.
  const settingsCatalog = useSettingsSearchCatalog(true)

  const settingsEntryItem = useCallback(
    (entry: SettingsSearchEntry): PaletteItem => ({
      detail: entry.context,
      icon: entry.icon,
      id: `sp-${entry.id}`,
      keywords: [entry.context, entry.description ?? '', ...entry.keywords],
      label: entry.label,
      run: go(`${SETTINGS_ROUTE}?${settingsSearchTargetQuery(entry.target)}`)
    }),
    [go]
  )

  const searchGroups = useSearchGroups({
    archivedSessions,
    availableThemes,
    go,
    goSession,
    mcpServers,
    mode,
    previewTheme,
    resolveThemeMode,
    resolvedMode,
    search,
    sessions,
    setMode,
    setTheme,
    settingsCatalog,
    settingsEntryItem,
    t,
    themeName
  })

  // Branch rows rank below BOTH the fixed groups and the typed-only lists: they
  // scale with whatever worktrees happen to exist, so on a tie they're the least
  // likely thing meant. Everything above is either always-present chrome or a
  // list the search itself asked for.
  const groups = useMemo(
    () => [...baseGroups, ...searchGroups, ...branchGroup],
    [baseGroups, branchGroup, searchGroups]
  )

  // Settings-scoped page (⌘K on the Settings overlay, or its search pill):
  // the same catalog as root, minus everything that isn't settings.
  const settingsPageGroups = useSettingsPageGroups({
    go,
    search,
    settingsCatalog,
    settingsEntryItem,
    settingsSectionLabel,
    t
  })

  // Nested palette pages (VS Code-style submenus). Reusable: add the id to
  // `PALETTE_PAGES`, add its entry here and point a root item at it via `to`.
  // The `Record<PalettePageId, …>` is the proof the two agree: a declared id
  // with no entry and an entry with no declared id are both tsc errors, so a
  // door can never name a page this map does not build.
  const subPages = useMemo<Record<PalettePageId, PalettePage>>(
    () => ({
      theme: {
        title: t.settings.appearance.themeTitle,
        placeholder: t.settings.appearance.themeDesc,
        groups: [
          // Pinned at the top: drills into the Marketplace browser.
          {
            items: [
              {
                icon: Download,
                id: 'theme-install',
                keywords: ['install', 'marketplace', 'vscode', 'vs code', 'download', 'new', 'color'],
                label: t.commandCenter.installTheme.title,
                to: 'install-theme'
              }
            ]
          },
          // Brightness lives with the palettes: one mode toggle for the whole
          // list instead of splitting every theme across a Light and a Dark group.
          {
            heading: t.settings.appearance.colorMode,
            items: THEME_MODES.map(entry => ({
              active: mode === entry.mode,
              icon: entry.icon,
              id: `theme-mode-${entry.mode}`,
              keepOpen: true,
              keywords: ['appearance', 'brightness', 'color mode', t.settings.modeOptions[entry.mode].label],
              label: t.settings.modeOptions[entry.mode].label,
              onHighlight: () => previewTheme(themeName, resolveThemeMode(entry.mode)),
              run: () => setMode(entry.mode)
            }))
          },
          // Every palette once, applied on top of the selected mode. An import
          // that only ships one variant (Dracula) flips the mode to the side it
          // can actually render.
          {
            heading: t.settings.appearance.themeTitle,
            items: availableThemes.map(theme => {
              const previewMode = themeSupportsMode(theme.name, resolvedMode)
                ? resolvedMode
                : resolvedMode === 'dark'
                  ? 'light'
                  : 'dark'

              return {
                active: themeName === theme.name,
                icon: Palette,
                id: `theme-${theme.name}`,
                keepOpen: true,
                keywords: ['theme', 'appearance', 'palette', theme.label, theme.description ?? ''],
                label: theme.label,
                onHighlight: () => previewTheme(theme.name, previewMode),
                run: () => {
                  setTheme(theme.name)

                  if (previewMode !== resolvedMode) {
                    setMode(previewMode)
                  }
                }
              }
            })
          }
        ]
      },
      'color-mode': {
        title: t.settings.appearance.colorMode,
        placeholder: t.settings.appearance.colorModeDesc,
        groups: [
          {
            heading: t.settings.appearance.colorMode,
            items: THEME_MODES.map(entry => ({
              active: mode === entry.mode,
              icon: entry.icon,
              id: `mode-${entry.mode}`,
              keepOpen: true,
              keywords: ['appearance', 'brightness', t.settings.modeOptions[entry.mode].label],
              label: t.settings.modeOptions[entry.mode].label,
              onHighlight: () => previewTheme(themeName, resolveThemeMode(entry.mode)),
              run: () => setMode(entry.mode)
            }))
          }
        ]
      },
      // Server-driven page: items come from the Marketplace, rendered by
      // <MarketplaceThemePage> (loader + live search + per-row install).
      'install-theme': {
        title: t.commandCenter.installTheme.pageTitle,
        placeholder: t.commandCenter.installTheme.placeholder,
        groups: []
      },
      // Settings-scoped search (⌘K while the Settings overlay is up, or the
      // search pill beside its close button).
      settings: {
        title: t.commandCenter.nav.settings.title,
        placeholder: t.settings.search.placeholder,
        groups: settingsPageGroups
      }
    }),
    [
      availableThemes,
      mode,
      previewTheme,
      resolvedMode,
      resolveThemeMode,
      setMode,
      setTheme,
      settingsPageGroups,
      t,
      themeName
    ]
  )

  const activePage = page ? subPages[page] : null
  const unrankedGroups = activePage ? activePage.groups : groups
  const visibleGroups = useMemo(() => rankGroups(unrankedGroups, search), [unrankedGroups, search])
  const placeholder = activePage ? activePage.placeholder : t.commandCenter.searchPlaceholder

  // The sheet reports its highlighted row (arrows or hover) so preview-capable
  // rows (the theme pickers) can paint live. Any other highlight clears it.
  const handleHighlight = useCallback(
    (item: null | PaletteItem) => {
      if (item?.onHighlight) {
        item.onHighlight()
      } else {
        clearThemePreview()
      }
    },
    [clearThemePreview]
  )

  // A preview lives only while its rows show. If the page changes, give the
  // paint back to the committed appearance.
  useEffect(() => {
    clearThemePreview()
  }, [page, clearThemePreview])

  // Clear at close START, not at unmount. The body stays mounted through the
  // whole exit animation (see CommandPalette), so an unmount clear would
  // revert the theme only after the fade. The unmount return is the backstop
  // for a body that dies without a close (a remount on reopen).
  const paletteOpen = useStore($commandPaletteOpen)

  useEffect(() => {
    if (!paletteOpen) {
      clearThemePreview()
    }
  }, [paletteOpen, clearThemePreview])

  useEffect(() => clearThemePreview, [clearThemePreview])

  const handleSelect = (item: PaletteItem, mods: SelectMods) => {
    if (item.to) {
      setPage(item.to)
      setSearch('')

      return
    }

    // The sheet hands us the modifiers of the very click/Enter that chose the
    // row, so a ⌘-select can never read a stale modifier from an earlier one.
    if (item.runWithEvent) {
      item.runWithEvent(mods)
    } else {
      item.run?.()
    }

    if (!item.keepOpen) {
      closeCommandPaletteAfterAction()

      return
    }

    // Staying open means the rows are still on screen — re-read anything they
    // report (a toggle's on/off) so the note isn't showing the previous state.
    setSelectTick(tick => tick + 1)
  }

  return (
    <PaletteSheet
      bindings={bindings}
      groups={visibleGroups}
      inputRef={inputRef}
      modHeld={modHeld}
      noResultsLabel={t.commandCenter.noResults}
      /* Dev builds name the dead door on the surface that opened it; shipped
         builds only log it (the id is developer text, not a user string). */
      notice={
        deadDoor !== null && import.meta.env.DEV ? (
          <p className="icp-notice">{`No palette page "${deadDoor}" — fix or remove the door that opened it`}</p>
        ) : undefined
      }
      onBack={activePage ? goBack : undefined}
      onClose={closeCommandPalette}
      onExited={onExited}
      onHighlight={handleHighlight}
      onSearchChange={setSearch}
      onSelect={handleSelect}
      open={paletteOpen}
      pageTitle={activePage?.title ?? null}
      placeholder={placeholder}
      search={search}
      /* The Marketplace page loads and installs on its own rows, so it renders
         in place of the ranked list (it has no palette items to rank). */
      status={page === 'install-theme' ? <MarketplaceThemePage onPickTheme={setTheme} search={search} /> : undefined}
      title={t.commandCenter.paletteTitle}
    />
  )
}
