import { useStore } from '@nanostores/react'
import { type CSSProperties, type ReactElement, type PointerEvent as ReactPointerEvent } from 'react'
import { useLocation } from 'react-router'

import { SessionDraftTitle } from '@/app/chat/session-draft-title'
import { SessionStatusDot } from '@/app/chat/session-status-dot'
import { PALETTE_AREA, type PaletteContribution, paletteToggle } from '@/app/command-palette/contrib'
import { FrameTools } from '@/app/shell/frame-tools'
import { legacyShellMode, WINDOW_DRAG_BAND_PX } from '@/app/shell/legacy-shell'
import { InlinePreviewDirective } from '@/components/assistant-ui/inline-preview-directive'
import { allPaneIds, group, groupLeafIds } from '@/components/pane-shell/tree/model'
import { LAYOUTS_AREA } from '@/components/pane-shell/tree/presets'
import {
  $layoutTree,
  bindTreeSideVisibility,
  declareDefaultTree,
  mirrorLayoutTree,
  removeTreePane,
  watchContributedPanes
} from '@/components/pane-shell/tree/store'
import { SidebarProvider } from '@/components/ui/sidebar'
import { discoverBundledPlugins } from '@/contrib/plugins'
import { registry } from '@/contrib/registry'
import { discoverRuntimePlugins } from '@/contrib/runtime-loader'
import { NEW_SESSION_TITLE, sessionTitle as storedSessionTitle } from '@/lib/chat-runtime'
import { Download, Terminal, Upload, Zap } from '@/lib/icons'
import { TRANSCRIPT_DIRECTIVE_AREA, type TranscriptDirectiveContribution } from '@/lib/transcript-directives'
import { pruneComposerPopoutZones } from '@/store/composer-popout'
import { $fileBrowserOpen, $panesFlipped, $sidebarOpen, setFileBrowserOpen, setSidebarOpen } from '@/store/layout'
import { runExportProfileFlow, runImportProfileFlow } from '@/store/profile-share'
import { $selectedStoredSessionId, $sessions, sessionMatchesStoredId } from '@/store/session'
import { watchSessionPins } from '@/store/session-pin-sync'
import { watchUnreadWriteGuard } from '@/store/session-unread-remote'
import { isAuxiliaryWindow, isBrowserWindow, isHudWindow } from '@/store/windows'

import { BrowserPopoutShell } from '../chat/browser-popout-shell'
import type { SessionDragPayload } from '../chat/composer/inline-refs'
import { watchPreviewTiles } from '../chat/preview-tile'
import { watchRouteTiles } from '../chat/route-tile'
import { startSessionDrag } from '../chat/session-drag'
import { SessionTileCloseConfirm, watchSessionTiles, WorkspaceTabMenu } from '../chat/session-tile'
import { AppContextMenu } from '../context-menu/app-context-menu'
import { isItSurfaceOpen, toggleItSurface } from '../home/it-store'
import { HudShell } from '../hud/hud-shell'
import { $workspaceIsPage, appViewForPath } from '../routes'

import { ContribWiring, WiredPane } from './wiring'

/**
 * Stripped-down app root (bb/contrib-areas) on the layout TREE model, mounting
 * the REAL app surfaces. There is no title bar or status bar: OUR window-drag
 * band and its frame tools are the only window chrome, and `titleBar.*` /
 * `statusBar.*` contributions have no slot (owner decision #20).
 */

// ---------------------------------------------------------------------------
// Pane contributions. `data.placement` = semantic role for grid presets;
// `data.minWidth/maxWidth/minHeight/maxHeight` = the SAME clamps the app's
// `Pane` props declare — the layout tree sizes zones by weight (percentage)
// but a zone never shrinks/grows past its active pane's clamp.
// Headers are contextual (tree-side): a pane alone in a zone shows no
// header/tab by default; stacked panes show chips. Double-click a zone
// toggles its header either way.
// ---------------------------------------------------------------------------

// The main tab carries the same session context menu as tile tabs (targets
// the loaded primary session; no menu on a fresh draft).
const wrapWorkspaceTab = (tab: ReactElement) => <WorkspaceTabMenu>{tab}</WorkspaceTabMenu>

/** The `@session` payload for the workspace tab — the loaded primary session,
 *  or null on a fresh draft / full-page view (nothing to link). */
const workspaceDragPayload = (): SessionDragPayload | null => {
  const selected = $selectedStoredSessionId.get()

  if (!selected || $workspaceIsPage.get()) {
    return null
  }

  const stored = $sessions.get().find(s => sessionMatchesStoredId(s, selected))

  return { id: selected, profile: stored?.profile ?? '', title: stored ? storedSessionTitle(stored) : '' }
}

// The main tab drags like a session tile — drop it on a composer to link the
// chat, on a zone/edge to stack/split. Defers (`false`) to the generic pane
// move when there's no loaded session to carry.
const workspaceTabDrag = (event: ReactPointerEvent<HTMLElement>, onTap: () => void) => {
  const payload = workspaceDragPayload()

  if (!payload) {
    return false
  }

  startSessionDrag(payload, event, { onTap })

  return true
}

// iclone os: there is NO left sessions sidebar — session management lives in
// Settings → Sessions & Bots (which embeds the same sidebar surface). The
// 'sessions' pane contribution was removed; a boot sweep below clears it
// (and the bots tab that center-docked into it) from persisted trees.
registry.registerMany([
  {
    id: 'workspace',
    area: 'panes',
    workspaceMode: 'sessions',
    // Live-retitled to the loaded session by syncWorkspaceTitle below.
    title: NEW_SESSION_TITLE,
    data: {
      placement: 'main',
      minWidth: '22vw',
      tabDrag: workspaceTabDrag,
      tabWrap: wrapWorkspaceTab,
      uncloseable: true
    }
  }
  // iclone os has ONE terminal, and it is iT (home/it-terminal.tsx). The
  // bottom-deck terminal pane is retired: it was a second surface over the
  // same shell pool, so `it run` could land in a hidden deck instead of the
  // pane the owner was looking at. ⌃` and the palette open iT instead.
  //
  // The upstream right sidebars — the `files` file browser and the `review`
  // git diff — are retired too, deleted with their cluster (E3c, contract E3
  // §3): they were upstream Hermes surfaces and OUR home stage replaces them,
  // so the chat is the only core pane left in the tree.
])

// ---------------------------------------------------------------------------
// Core keybind and ⌘K contributions. Sample PLUGIN contributions don't live here — they're their own files under `src/plugins/`,
// auto-discovered by discoverBundledPlugins() below.
// ---------------------------------------------------------------------------

registry.registerMany([
  // The agent's write -> see loop: rescan <hermes home>/desktop-plugins
  // without relaunching (same-id reloads dispose the previous incarnation).
  {
    id: 'plugins.reload',
    area: PALETTE_AREA,
    data: {
      id: 'plugins.reload',
      label: 'Reload desktop plugins',
      keywords: ['plugins', 'reload', 'refresh', 'desktop'],
      run: () => void discoverRuntimePlugins()
    } satisfies PaletteContribution
  },
  // The core `::preview{file="…"}` transcript directive — the model (or a
  // skill) renders a workspace HTML file LIVE inside its own message
  // (sandboxed srcdoc iframe; falls back to the classic preview card for
  // non-HTML targets and remote gateways). Also the reference consumer for
  // the `transcript.directives` area plugins register into.
  {
    id: 'transcript.preview',
    area: TRANSCRIPT_DIRECTIVE_AREA,
    data: {
      name: 'preview',
      render: ({ attrs, streaming }) => <InlinePreviewDirective attrs={attrs} streaming={streaming} />
    } satisfies TranscriptDirectiveContribution
  },
  // The keybind panel's ⌘K door.
  {
    id: 'keybinds.panel',
    area: PALETTE_AREA,
    data: {
      id: 'keybinds.panel',
      label: 'Keyboard shortcuts',
      keywords: ['keybinds', 'shortcuts', 'hotkeys', 'keyboard'],
      run: () => window.dispatchEvent(new CustomEvent('hermes:open-keybinds'))
    } satisfies PaletteContribution
  },
  // Profile sharing: bundle the active profile (config, skills, theme, layout)
  // into a portable archive, or adopt someone else's. Both open native dialogs,
  // so the palette closing on select is correct.
  {
    id: 'profile.export',
    area: PALETTE_AREA,
    data: {
      id: 'profile.export',
      label: 'Export profile…',
      icon: Upload,
      keywords: ['profile', 'export', 'share', 'bundle', 'theme', 'settings', 'backup'],
      run: () => void runExportProfileFlow()
    } satisfies PaletteContribution
  },
  {
    id: 'profile.import',
    area: PALETTE_AREA,
    data: {
      id: 'profile.import',
      label: 'Import profile…',
      icon: Download,
      keywords: ['profile', 'import', 'share', 'bundle', 'archive', 'restore'],
      run: () => void runImportProfileFlow()
    } satisfies PaletteContribution
  }
])

// ---------------------------------------------------------------------------
// Layout presets — CHAT (main) always dominates.
// ---------------------------------------------------------------------------

// The seed the tree store hands out for panes that still live in it (session
// and preview tiles): there is no layout picker and no preset UI any more, and
// the upstream right sidebars went with their cluster (E3c, contract E3 §3) —
// the chat is OUR Message window and the only core pane, so the seed is its
// zone alone.
//
// Preview tiles are DYNAMIC panes (like session tiles), so no preset names one:
// they're registered by watchPreviewTiles as tabs open, and dockPaneBeside
// lands each one beside the pane it was opened from.
const DEFAULT_TREE = group(['workspace'], { id: 'grp-main' })

declareDefaultTree(DEFAULT_TREE)

// The backend `apply_layout` verb resolves its id against this area
// (store/pane-focus.ts). The picker and the focus / quad / terminal-deck
// presets went with the upstream pane shell, so the seed above is the ONE core
// layout left addressable: without this registration the verb answers false to
// every id a fresh install can name.
registry.register({ id: 'default', area: LAYOUTS_AREA, source: 'core', data: DEFAULT_TREE })

// iclone os boot sweep: clear the retired left sidebar out of persisted
// trees — the sessions pane, the bots tab that center-docked into it, and
// any pane stranded on the LEFT root side (this machine's old layouts had
// the terminal stacked there). Guarded per id: removeTreePane rebuilds the
// tree even for an absent pane, and a no-op sweep would persist a fresh
// identical tree on every boot.
for (const staleId of ['sessions', 'hermes-bots:pane', 'terminal', 'files', 'review']) {
  const bootTree = $layoutTree.get()

  if (bootTree && allPaneIds(bootTree).includes(staleId)) {
    removeTreePane(staleId)
  }
}

// Bundled plugins load AFTER core, so a same-id contribution from a plugin
// deliberately overrides the core default (last writer wins). Third-party
// runtime plugins will flow through the same discovery seam.
discoverBundledPlugins()

// Plugin panes join the tree by their `placement` hint the moment they
// register — incl. runtime plugins arriving seconds after boot.
watchContributedPanes()

// Session + route (page) tiles: persisted splits register panes docked beside
// main. A popped-out Browser has no layout tree — registering tiles there
// would still run, and preview-tile watching would try to dock into a tree
// this window never renders.
if (!isBrowserWindow()) {
  watchSessionTiles()
  watchRouteTiles()
  watchPreviewTiles()
}

// Composer pop-out state is keyed by layout zone, so drop entries for zones the
// user has since closed or merged away — otherwise a long-lived install keeps a
// row for every split it has ever had.
$layoutTree.subscribe(tree => {
  if (tree) {
    pruneComposerPopoutZones(groupLeafIds(tree))
  }
})

// Mirror sidebar pins into the backend keep-flag so the auto-archive sweep
// never hides a pinned chat (and pre-existing pins migrate transparently).
watchSessionPins()

// Release unread-write guards once a list page confirms the value we wrote.
watchUnreadWriteGuard()

// The main tab reads as its SESSION (the loaded title, "New session" on a
// fresh draft) — a stack of main + tiles is then just a row of session names.
// register() replaces same-id in place; the render fn is the shared constant
// above, so the pane content never remounts.
const syncWorkspaceTitle = () => {
  const selected = $selectedStoredSessionId.get()
  const stored = selected ? $sessions.get().find(s => sessionMatchesStoredId(s, selected)) : null

  registry.register({
    id: 'workspace',
    area: 'panes',
    workspaceMode: 'sessions',
    // The placeholder, not the draft's live name — `tabTitle` below renders
    // that. Keeping it here would re-register the pane on every keystroke.
    title: stored ? storedSessionTitle(stored) : NEW_SESSION_TITLE,
    data: {
      // The tab's status dot — the SAME primitive the sidebar row and session
      // tiles render, so the main tab never disagrees with its sidebar row. A
      // fresh draft has no session to key by, which IS its status: the dot
      // resolves to `draft` and marks the tab rather than leaving a hole.
      tabLead: () => <SessionStatusDot session={stored} storedSessionId={selected} />,
      // A draft's name lives in its composer, not in any session row, so the
      // label subscribes to it directly — typing renames the tab without
      // re-registering the pane.
      tabTitle: stored ? undefined : () => <SessionDraftTitle scope={selected} />,
      // Pages aren't tab-able: the main zone's bar stands down while one shows.
      headerVeto: $workspaceIsPage.get(),
      placement: 'main',
      minWidth: '22vw',
      tabDrag: workspaceTabDrag,
      tabWrap: wrapWorkspaceTab,
      uncloseable: true
    }
  })
}

$selectedStoredSessionId.listen(syncWorkspaceTitle)
$sessions.listen(syncWorkspaceTitle)
$workspaceIsPage.listen(syncWorkspaceTitle)

// ---------------------------------------------------------------------------
// Pane visibility stores -> tree. $sidebarOpen / $fileBrowserOpen /
// $panesFlipped (driven by keybinds and ⌘K) keep their semantics; the tree
// reacts — a hidden pane's zone collapses (content stays mounted), the flip
// toggle mirrors the root row.
// ---------------------------------------------------------------------------

// SIDES have one source of truth: the TREE. The legacy $panesFlipped flag is
// DERIVED from where the sessions zone actually sits, so dragging sessions
// across — or applying a mirrored preset — keeps every reader of the flag
// truthful. The flip action (⌘\) mirrors the tree only when they disagree.
const sessionsOnRight = () => {
  const tree = $layoutTree.get()

  if (!tree) {
    return null
  }

  const order = allPaneIds(tree)
  const sessions = order.indexOf('sessions')
  const main = order.indexOf('workspace')

  return sessions >= 0 && main >= 0 ? sessions > main : null
}

$layoutTree.subscribe(() => {
  const flipped = sessionsOnRight()

  if (flipped !== null && flipped !== $panesFlipped.get()) {
    $panesFlipped.set(flipped)
  }
})

$panesFlipped.listen(flipped => {
  const current = sessionsOnRight()

  if (current !== null && current !== flipped) {
    mirrorLayoutTree()
  }
})

// POSITIONAL side toggle (⌘J): $fileBrowserOpen ≙ the RIGHT
// side of the main zone. (There is no left side anymore — the sessions
// sidebar moved into Settings.)
bindTreeSideVisibility('right', $fileBrowserOpen, setFileBrowserOpen)

// ⌃` / ⌘K row — every door that used to open the bottom
// deck now opens iT, the app's one terminal. `$terminalTakeover` survives as
// the "the terminal is showing" flag other surfaces already read (the agent's
// openAgentTerminal raises it), and iT mirrors it.
registry.register(
  paletteToggle({
    id: 'view.showTerminal',
    label: 'Toggle terminal',
    action: 'view.showTerminal',
    icon: Terminal,
    keywords: ['terminal', 'shell', 'console', 'pty', 'it'],
    get: () => isItSurfaceOpen(),
    set: () => toggleItSurface()
  })
)

// V3-F: the old yolo toggle's ⌘K door now opens the permission mode picker (Settings › Agent › Permissions).
// The mode itself changes only from the user's own click there; nothing in the palette writes it.
registry.register({
  id: 'session.permissionMode',
  area: PALETTE_AREA,
  data: {
    id: 'session.permissionMode',
    label: 'Permission mode…',
    icon: Zap,
    keywords: ['permissions', 'mode', 'yolo', 'approvals', 'ignore', 'manual', 'automatic', 'plan', 'accept edits'],
    run: () => window.dispatchEvent(new CustomEvent('hermes:open-permissions'))
  } satisfies PaletteContribution
})

// ---------------------------------------------------------------------------

/**
 * The host for contributed FULL-PAGE views (plugin pages): the only surfaces
 * left that render the route table outside OUR windows. The chat route is the
 * Message window's (it mounts the chat surface itself), and over OUR home
 * stage — home and every overlay view — this host mounts nothing at all, so
 * no covered pane, tab strip or drag handle can sit in the Tab order or under
 * the stage (U5-T3). Its in-flow top band keeps a page clear of the drag band.
 */
function WorkspacePageHost() {
  const { pathname } = useLocation()

  if (legacyShellMode(appViewForPath(pathname), isAuxiliaryWindow()) !== 'live') {
    return null
  }

  return (
    <div className="flex h-screen min-h-0 w-screen flex-col" data-iclone-page-host="">
      <div aria-hidden="true" className="shrink-0" style={{ height: WINDOW_DRAG_BAND_PX }} />
      <WiredPane part="chatRoutes" />
    </div>
  )
}

/** OUR window-drag band: the top of the main window moves it (macOS traffic
 *  lights sit natively above it). Hit-transparent, so nothing under it loses
 *  its pointer events; a control inside the band opts out with no-drag. It
 *  carries OUR frame tools at the top right (main window only) and sits one
 *  rung above the home layers so those tools stay reachable. */
function WindowDragBand() {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[calc(var(--ic-z-global-files)+1)] [-webkit-app-region:drag]"
      data-ic-window-drag=""
      style={{ height: WINDOW_DRAG_BAND_PX }}
    >
      {!isAuxiliaryWindow() && <FrameTools />}
    </div>
  )
}

export function ContribController() {
  const sidebarOpen = useStore($sidebarOpen)

  // HUD mode is the SAME app with its frame removed: the wiring (gateway,
  // sessions, streams, submit) mounts identically, and only the shell around
  // the chat surface differs. Branching here rather than at the window entry
  // is what keeps the HUD's composer the real composer.
  if (isHudWindow()) {
    return (
      <ContribWiring>
        <HudShell />
      </ContribWiring>
    )
  }

  if (isBrowserWindow()) {
    return (
      <ContribWiring>
        <BrowserPopoutShell />
      </ContribWiring>
    )
  }

  return (
    <SidebarProvider
      className="h-screen min-h-0 flex-col bg-background"
      onOpenChange={setSidebarOpen}
      open={sidebarOpen}
      style={{ '--sidebar-width': '100%' } as CSSProperties}
    >
      <ContribWiring>
        <AppContextMenu />
        <WorkspacePageHost />
        <WindowDragBand />

        {/* "Close running tab?" — the busy/input-blocked tile close gate. */}
        <SessionTileCloseConfirm />
      </ContribWiring>
    </SidebarProvider>
  )
}
