/**
 * Real-featureset wiring for the contrib (layout tree) root — the minimal
 * subset of DesktopController's hook chain that makes the REAL surfaces work:
 * gateway boot -> sessions list -> click-to-resume -> live transcript ->
 * composer send, plus the real terminal.
 *
 * The wired nodes (sidebar / chat routes / terminal) are exposed through
 * context; registered panes render `<WiredPane part="…"/>` to consume them.
 */

import { useStore } from '@nanostores/react'
import { useQueryClient } from '@tanstack/react-query'
import { type CSSProperties, lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { graftRefreshedTailOntoBackfill } from '@/app/chat/transcript-backfill'
import { formatRefValue } from '@/components/assistant-ui/directive-text'
import { BootFailureOverlay } from '@/components/boot-failure-overlay'
import { ConfirmHost } from '@/components/confirm-host'
import { ConsentSheet } from '@/components/consent'
import { DesktopInstallOverlay } from '@/components/desktop-install-overlay'
import { FindBar } from '@/components/find-bar'
import { GatewayConnectingOverlay } from '@/components/gateway-connecting-overlay'
import { NotificationStack } from '@/components/notifications'
import { DesktopOnboardingOverlay } from '@/components/onboarding'
import { $newSessionTabAction, registerPaneCloser } from '@/components/pane-shell/tree/store'
import {
  $workspaceMode,
  $workspaceNewSessionTarget,
  $workspaceOwnerKey,
  setWorkspaceScope
} from '@/components/pane-shell/workspace-scope'
import { petPromptTargetOf } from '@/components/pet/pet-prompt-target'
import { RemoteDisplayBanner } from '@/components/remote-display-banner'
import { SendDiagnosticsHost } from '@/components/send-diagnostics-dialog'
import { emitGatewayEvent } from '@/contrib/events'
import { getLatestSessionMessages } from '@/hermes'
import { sleep } from '@/iclone-shared/async'
import { type ChatMessage, chatMessageText, preserveLocalAssistantErrors, toChatMessages } from '@/lib/chat-messages'
import { isMessagingSource } from '@/lib/session-source'
import { latestSessionTodos } from '@/lib/todos'
import { activateWakeIndicator } from '@/lib/wake-indicator'
import { playWakeSound } from '@/lib/wake-sound'
import { $billingSettingsRequest } from '@/store/billing-block'
import { $desktopBoot } from '@/store/boot'
import { requestVoiceConversationStart } from '@/store/composer'
import { $activeConnectionId } from '@/store/connections'
import { $cronReviewRequest, setCronFocusJobId } from '@/store/cron'
import { $pinnedSessionIds, pinSession, restoreWorktree, unpinSession } from '@/store/layout'
import { notify, notifyError } from '@/store/notifications'
import { $previewTarget } from '@/store/preview'
import {
  $activeGatewayProfile,
  $freshSessionRequest,
  $profileScope,
  ALL_PROFILES,
  ensureGatewayProfile,
  newSessionInProfile,
  normalizeProfileKey,
  refreshActiveProfile
} from '@/store/profile'
import { $startWorkSessionRequest, followActiveSessionCwd } from '@/store/projects'
import {
  $activeSessionId,
  $connection,
  $currentCwd,
  $freshDraftReady,
  $gatewayState,
  $messages,
  $messagingSessions,
  $resumeExhaustedSessionId,
  $resumeFailedSessionId,
  $selectedStoredSessionId,
  $sessionResumeRequest,
  $sessions,
  requestSessionResume,
  sessionMatchesStoredId,
  sessionPinId,
  setAwaitingResponse,
  setBusy,
  setMessages
} from '@/store/session'
import { clearSessionTodos, setSessionTodos, todosForHydration } from '@/store/todos'
import { armWakeWord, stopClientCapture } from '@/store/wake-word'
import { isAuxiliaryWindow, isHudWindow, isPeerInstanceWindow } from '@/store/windows'
import { useSkinCommand } from '@/themes/use-skin-command'

import { closeWorkspaceTab } from '../chat/close-tab'
import { requestComposerInsert } from '../chat/composer/focus'
import { useComposerActions } from '../chat/hooks/use-composer-actions'
import { ProjectDialog } from '../chat/sidebar/project-dialog'
import { WorktreeDialog } from '../chat/sidebar/projects/worktree-dialog'
import { $commandCenterSessionDelete } from '../command-center/session-delete'
import { CommandPalette } from '../command-palette'
import { triggerAndRefreshCronJobs } from '../cron/cron-actions'
import { useGatewayBoot } from '../gateway/hooks/use-gateway-boot'
import { useGatewayRequest } from '../gateway/hooks/use-gateway-request'
import { FilesIsland } from '../home/files-island'
import { HomeView } from '../home/home-view'
import { initItCommands } from '../home/it-commands'
import { ItTerminalHost } from '../home/it-host'
import { closeAllTerminals } from '../home/it/engine/terminals'
import { useKeybinds } from '../hooks/use-keybinds'
import { useHudHandoff } from '../hud/handoff'
import { ModelPickerOverlay } from '../model-picker-overlay'
import { ModelVisibilityOverlay } from '../model-visibility-overlay'
import { mainChatOccupied, openSession } from '../open-session'
import { Panel } from '../overlays/panel'
import { RemoteFolderPicker } from '../remote-picker/remote-picker'
import {
  CRON_ROUTE,
  HOME_ROUTE,
  NEW_CHAT_ROUTE,
  routeSessionId,
  sessionRoute,
  SETTINGS_ROUTE,
  syncWorkspaceRoute
} from '../routes'
import { SessionPickerOverlay } from '../session-picker-overlay'
import { SessionSwitcher } from '../session-switcher'
import { useBackgroundQueueDrain } from '../session/hooks/use-background-queue-drain'
import { useContextSuggestions } from '../session/hooks/use-context-suggestions'
import { useCwdActions } from '../session/hooks/use-cwd-actions'
import { useHermesConfig } from '../session/hooks/use-hermes-config'
import { useMessageStream } from '../session/hooks/use-message-stream'
import { useModelControls } from '../session/hooks/use-model-controls'
import { usePreviewRouting } from '../session/hooks/use-preview-routing'
import { usePromptActions } from '../session/hooks/use-prompt-actions'
import { useRouteResume } from '../session/hooks/use-route-resume'
import { useSessionActions } from '../session/hooks/use-session-actions'
import { useSessionListActions } from '../session/hooks/use-session-list-actions'
import { useSessionStateCache } from '../session/hooks/use-session-state-cache'
import { startWorkspaceSession } from '../session/workspace-session-target'
import { PluginInstallModal } from '../settings/plugin-install-modal'
import { useOverlayRouting } from '../shell/hooks/use-overlay-routing'
import { useWindowControlsOverlayWidth } from '../shell/hooks/use-window-controls-overlay-width'
import { titlebarControlsPosition, titlebarToolsRightCss } from '../shell/titlebar'
import { UpdatesOverlay } from '../updates-overlay'

import { ContribWiringContext } from './context'
import {
  reconcileActiveTranscript,
  resolveActiveTranscriptSession,
  useBackgroundSync
} from './hooks/use-background-sync'
import { useDesktopIntegrations } from './hooks/use-desktop-integrations'
import { useQuickEntryBridge } from './hooks/use-quick-entry-bridge'
import { useSessionTileDelegate } from './hooks/use-session-tile-delegate'
import { McpInstallDeepLinkDialog } from './mcp-install-deeplink-dialog'
import { $restartPreviewServer, setStatusbarItemGroup } from './panes'
import { createSessionRpcDispatcher } from './session-rpc-dispatcher'
import { ChatRoutesSurface, SidebarSurface } from './surfaces'
import type { WiringActions, WiringApi } from './types'

// Overlay views the controller mounts over the shell — lazy, load on demand.
// skills is an overlay too (owner rule — see OVERLAY_VIEWS in routes.ts):
// rendered here in the shared Panel card with a ✕, never again as a full-page
// trap in the workspace zone. Messaging and Command Center left this list in
// front K5: both are Settings panes now, mounted by `settings/panes.tsx`.
const AgentsView = lazy(async () => ({ default: (await import('../agents')).AgentsView }))
const SkillsView = lazy(async () => ({ default: (await import('../skills')).SkillsView }))
const CronView = lazy(async () => ({ default: (await import('../cron')).CronView }))
const SettingsView = lazy(async () => ({ default: (await import('../settings')).SettingsView }))
// V3-P: the pixel pet at the composer's corner (its own chunk; renders nothing while the pet is off).
const FloatingPet = lazy(async () => ({ default: (await import('@/components/pet/floating-pet')).FloatingPet }))

// iclone os: the `it` CLI command plane answers from any terminal.
initItCommands()

// Surfaces (the four wired panes), the render context + WiredPane, and the
// WiringActions/WiringApi contracts all live in sibling modules — this file is
// the controller that assembles them.
export { WiredPane } from './context'

export function ContribWiring({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()

  // The main window boots on #/home before the router mounts (main.tsx →
  // applyBootRoute). The HUD is the inverse: it renders nothing on a /home
  // hash it inherited (the home layer is main-window-only), so it bounces to
  // the chat route — the session goto push then lands it on the conversation.
  useEffect(() => {
    if (isHudWindow() && location.pathname.startsWith(HOME_ROUTE)) {
      navigate(NEW_CHAT_ROUTE, { replace: true })
    }
  }, [location.pathname, navigate])

  const busyRef = useRef(false)
  const creatingSessionRef = useRef(false)
  // Billing recovery routes to Settings → Billing from surfaces without router
  // context (the sticky toast). The shell owns `navigate`, so it consumes the
  // intent counter here; the ref skips the initial mount value.
  const billingSettingsSeenRef = useRef(0)
  const cronReviewSeenRef = useRef(0)
  const activeTranscriptSignatureRef = useRef(new Map<string, string>())
  const activeTranscriptRequestSequenceRef = useRef(0)
  // Stable identity for the whole callback surface (see WiringActions). Mutated
  // in place each render so memoized surfaces never re-render on churn.
  const actionsRef = useRef<WiringActions | null>(null)

  const gatewayState = useStore($gatewayState)
  const activeSessionId = useStore($activeSessionId)
  const billingSettingsRequest = useStore($billingSettingsRequest)
  const cronReviewRequest = useStore($cronReviewRequest)
  const currentCwd = useStore($currentCwd)

  // eslint-disable-next-line no-restricted-syntax -- one-shot request-seen sentinel, not an atom mirror
  useEffect(() => {
    if (billingSettingsRequest === billingSettingsSeenRef.current) {
      return
    }

    billingSettingsSeenRef.current = billingSettingsRequest

    if (billingSettingsRequest > 0) {
      navigate(`${SETTINGS_ROUTE}?tab=billing`)
    }
  }, [billingSettingsRequest, navigate])

  // eslint-disable-next-line no-restricted-syntax -- one-shot request-seen sentinel, not an atom mirror
  useEffect(() => {
    if (cronReviewRequest === cronReviewSeenRef.current) {
      return
    }

    cronReviewSeenRef.current = cronReviewRequest

    if (cronReviewRequest > 0) {
      navigate(CRON_ROUTE)
    }
  }, [cronReviewRequest, navigate])
  const freshDraftReady = useStore($freshDraftReady)
  const resumeFailedSessionId = useStore($resumeFailedSessionId)
  const resumeExhaustedSessionId = useStore($resumeExhaustedSessionId)
  const sessionResumeRequest = useStore($sessionResumeRequest)
  const selectedStoredSessionId = useStore($selectedStoredSessionId)
  const messagingSessions = useStore($messagingSessions)
  const sessions = useStore($sessions)
  const activeConnectionId = useStore($activeConnectionId)
  const activeGatewayProfile = useStore($activeGatewayProfile)
  const profileScope = useStore($profileScope)
  const boot = useStore($desktopBoot)

  const routedSessionId = routeSessionId(location.pathname)
  const routedSessionIdRef = useRef(routedSessionId)

  routedSessionIdRef.current = routedSessionId
  const routeToken = `${location.pathname}:${location.search}:${location.hash}`
  const routeTokenRef = useRef(routeToken)
  routeTokenRef.current = routeToken
  const getRouteToken = useCallback(() => routeTokenRef.current, [])

  const getRoutedStoredSessionId = useCallback(() => routedSessionIdRef.current, [])

  const clearRoutedSessionIntent = useCallback(() => {
    routedSessionIdRef.current = null
  }, [])

  // Point the workspace at the route: the pane contribution re-registers
  // headerVeto from $workspaceIsPage (so the main zone's tab bar stands down
  // on pages), and a page route fronts the pane so it can't stay stuck behind
  // a focused session tile.
  useEffect(() => {
    syncWorkspaceRoute(location.pathname)
  }, [location.pathname])

  const {
    agentsOpen,
    artifactsOpen,
    chatOpen,
    homeOpen,
    closeOverlayToPreviousRoute,
    commandCenterOpen,
    cronOpen,
    currentView,
    openAgents,
    openCommandCenterSection,
    resetOverlayReturnRoute,
    settingsOpen,
    skillsOpen,
    starmapOpen,
    toggleCommandCenter,
    webhooksOpen
  } = useOverlayRouting()

  // iclone os: home is the BASE surface. Overlays (settings, cron, …) float
  // above it and the Dock stays on screen — owner rule. Navigating to chat is
  // the one deliberate exit.
  // `commandCenterOpen` is a Settings pane since front K5, so `settingsOpen`
  // already covers it; it stays in the expression because the ⌘. toggle reads
  // the same flag and a reader should not have to prove the implication.
  const overlayFloating = settingsOpen || commandCenterOpen || agentsOpen || cronOpen || skillsOpen

  // Chat and every overlay render OVER the home layer, so the dock never
  // leaves the screen (owner rule). This used to be gated on a "the user has
  // been home at least once" ref, which made the dock's presence depend on
  // route history — the same route could show it or not. The route alone
  // decides now.
  //
  // Capabilities/Messaging/Artifacts joined the overlay set (owner rule: a
  // closable window, never a full-page trap), so home stays live beneath them
  // too. Only plugin-contributed pages still own the workspace outright.
  //
  // MAIN window only: the HUD and other auxiliary windows must never grow
  // the home layer (owner rule: the HUD is JUST the bar — chatOpen is true
  // inside the HUD window too, so without this gate the dock/stage leak in).
  const showHome = !isAuxiliaryWindow() && (homeOpen || overlayFloating || chatOpen)

  // Pages the owner removed (E3 §6: starmap, webhooks, artifacts) mount no
  // more; a stale deep link or a leftover door lands on home, never a blank.
  const removedPageOpen = starmapOpen || webhooksOpen || artifactsOpen

  useEffect(() => {
    if (removedPageOpen) {
      navigate(HOME_ROUTE, { replace: true })
    }
  }, [navigate, removedPageOpen])

  // `/journey` (aliases `/learning`, `/memory-graph`) opened the star map, one
  // of those removed pages. Its door navigated to `/starmap`, which resolves to
  // `home` — the same stage the user ends up looking at, with a retired address
  // left in the location. It goes to home directly now: identical surface,
  // honest URL, and no navigation to a retired route anywhere in the tree. The
  // command itself lives in session/hooks/use-prompt-actions/slash.ts, which is
  // not this front's file: reported, not deleted here.
  const openRemovedMemoryGraph = useCallback(() => navigate(HOME_ROUTE, { replace: true }), [navigate])
  // Chat presents as the Message WINDOW over the ever-present home; every
  // other view keeps the full stage behind its overlay card.
  const homeMode = chatOpen ? ('window' as const) : ('stage' as const)

  const {
    activeSessionIdRef,
    ensureSessionState,
    getRuntimeIdForStoredSession,
    resetViewSync,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionIdRef,
    sessionStateByRuntimeIdRef,
    syncSessionStateToView,
    updateSessionState
  } = useSessionStateCache({
    activeSessionId,
    busyRef,
    selectedStoredSessionId,
    setAwaitingResponse,
    setBusy,
    setMessages
  })

  const { connectionRef, gateway, gatewayRef, requestGateway: ambientRequestGateway } = useGatewayRequest()

  // When chrome stays on the launch backend (Bot Mode / all-profiles
  // navigation), session-owned RPCs still have to hit the session's backend.
  // The routing itself lives in createSessionRpcDispatcher (routed by the
  // session the RPC targets, owner ladder in resolveSessionRpcOwner) so the
  // exact production dispatcher is what the integration tests drive.
  const requestGateway = useMemo(
    () =>
      createSessionRpcDispatcher({
        ambientRequest: ambientRequestGateway,
        runtimeIdByStoredSessionIdRef,
        selectedStoredSessionIdRef,
        sessionStateByRuntimeIdRef
      }),
    [ambientRequestGateway, runtimeIdByStoredSessionIdRef, selectedStoredSessionIdRef, sessionStateByRuntimeIdRef]
  )

  const { loadMoreMessagingForPlatform, loadMoreSessions, refreshCronJobs, refreshMessagingSessions, refreshSessions } =
    useSessionListActions({ profileScope })

  const updateActiveSessionRuntimeInfo = useCallback(
    (info: { branch?: string; cwd?: string }) => {
      const sessionId = activeSessionIdRef.current

      if (!sessionId) {
        return
      }

      updateSessionState(sessionId, state => ({
        ...state,
        branch: info.branch ?? state.branch,
        cwd: info.cwd ?? state.cwd
      }))
    },
    [activeSessionIdRef, updateSessionState]
  )

  const { refreshProjectBranch } = useCwdActions({
    activeSessionIdRef,
    onSessionRuntimeInfo: updateActiveSessionRuntimeInfo,
    requestGateway
  })

  const { refreshHermesConfig, sttEnabled, voiceMaxRecordingSeconds } = useHermesConfig({ activeSessionIdRef })

  const { applySavedMainModel, refreshCurrentModel, selectModel } = useModelControls({
    queryClient,
    requestGateway
  })

  const openProviderSettings = useCallback(() => navigate(`${SETTINGS_ROUTE}?tab=providers`), [navigate])

  // Palette "Keyboard shortcuts" entry dispatches a custom event (contributions
  // don't have router access); listen and navigate to the settings keybinds tab.
  useEffect(() => {
    const onOpenKeybinds = () => navigate(`${SETTINGS_ROUTE}?tab=keybinds`)
    // V3-F: the permission mode picker's ⌘K door, same shape.
    const onOpenPermissions = () => navigate(`${SETTINGS_ROUTE}?tab=permissions`)
    window.addEventListener('hermes:open-keybinds', onOpenKeybinds)
    window.addEventListener('hermes:open-permissions', onOpenPermissions)

    return () => {
      window.removeEventListener('hermes:open-keybinds', onOpenKeybinds)
      window.removeEventListener('hermes:open-permissions', onOpenPermissions)
    }
  }, [navigate])

  // Dev-only: install the credit-notice demo trigger (Ctrl+Shift+C / ⌘K palette
  // / window.__creditsDemo). Dynamic import inside the DEV guard so the module
  // is dropped from production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) {
      return
    }

    let dispose: (() => void) | undefined

    void import('./dev/credits-notice-demo').then(m => {
      dispose = m.installCreditsNoticeDemo()
    })

    return () => dispose?.()
  }, [])

  // Post-turn rehydrate from stored history (same behavior as DesktopController,
  // including finished-todos restoration).
  const hydrateFromStoredSession = useCallback(
    async (
      attempts = 1,
      storedSessionId = selectedStoredSessionIdRef.current,
      runtimeSessionId = activeSessionIdRef.current
    ) => {
      if (!storedSessionId || !runtimeSessionId) {
        return
      }

      const storedProfile = $sessions.get().find(session => sessionMatchesStoredId(session, storedSessionId))?.profile

      for (let index = 0; index < Math.max(1, attempts); index += 1) {
        try {
          const latest = await getLatestSessionMessages(storedSessionId, storedProfile)
          const messages = toChatMessages(latest.messages)
          updateSessionState(
            runtimeSessionId,
            state => ({
              ...state,
              // Post-turn rehydrate reads only the newest tail page — graft it
              // onto any backfilled older pages instead of dropping them.
              messages: preserveLocalAssistantErrors(
                graftRefreshedTailOntoBackfill(messages, state.messages),
                state.messages
              )
            }),
            storedSessionId
          )

          const restored = todosForHydration(latestSessionTodos(messages))

          if (restored) {
            setSessionTodos(runtimeSessionId, restored)
          } else {
            clearSessionTodos(runtimeSessionId)
          }

          return
        } catch {
          // Best-effort fallback when live stream payloads are empty.
        }

        if (index < attempts - 1) {
          await sleep(250)
        }
      }
    },
    [activeSessionIdRef, selectedStoredSessionIdRef, updateSessionState]
  )

  // Refresh any active transcript changed by another process. Signature-gated
  // so a no-change event does not churn the thread.
  const refreshActiveTranscript = useCallback(
    () =>
      reconcileActiveTranscript({
        activeSessionIdRef,
        busyRef,
        requestSequenceRef: activeTranscriptRequestSequenceRef,
        resolveSession: resolveActiveTranscriptSession,
        selectedStoredSessionIdRef,
        signatureRef: activeTranscriptSignatureRef,
        updateSessionState
      }),
    [activeSessionIdRef, busyRef, selectedStoredSessionIdRef, updateSessionState]
  )

  const { handleGatewayEvent } = useMessageStream({
    activeGatewayProfile,
    activeSessionIdRef,
    hydrateFromStoredSession,
    queryClient,
    refreshHermesConfig,
    refreshSessions,
    sessionStateByRuntimeIdRef,
    updateSessionState
  })

  // Agent-driven preview routing (agent opens a URL/file -> the preview rail
  // follows) + the preview server restart handler, layered over the base
  // gateway event stream exactly like DesktopController.
  const { handleDesktopGatewayEvent, restartPreviewServer } = usePreviewRouting({
    baseHandleGatewayEvent: handleGatewayEvent,
    currentCwd,
    requestGateway
  })

  // Composer @-mention context suggestions (files/dirs under the cwd).
  useContextSuggestions({
    activeSessionId,
    activeSessionIdRef,
    currentCwd,
    gatewayState,
    requestGateway
  })

  // Expose the restart handler to the preview pane contribution (module
  // boundary crossed via atom — contrib-panes can't import this file).
  useEffect(() => {
    $restartPreviewServer.set(restartPreviewServer)

    return () => $restartPreviewServer.set(null)
  }, [restartPreviewServer])

  const {
    archiveSession,
    branchCurrentSession,
    branchStoredSession,
    createBackendSessionForSend,
    openNewSessionTile,
    removeSession,
    resumeSession,
    selectSidebarItem,
    startFreshSessionDraft
  } = useSessionActions({
    activeSessionId,
    activeSessionIdRef,
    busyRef,
    creatingSessionRef,
    ensureSessionState,
    getRouteToken,
    getRoutedStoredSessionId,
    navigate,
    onFreshDraftRouteIntent: clearRoutedSessionIntent,
    requestGateway,
    resetViewSync,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionId,
    selectedStoredSessionIdRef,
    sessionStateByRuntimeIdRef,
    syncSessionStateToView,
    updateSessionState
  })

  // A profile switch/create drops to a fresh new-session draft so the
  // previously open session doesn't bleed across contexts. Skip initial value.
  const freshSessionRequest = useStore($freshSessionRequest)
  const lastFreshRef = useRef(freshSessionRequest)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (freshSessionRequest === lastFreshRef.current) {
      return
    }

    lastFreshRef.current = freshSessionRequest
    startFreshSessionDraft()
  }, [freshSessionRequest, startFreshSessionDraft])

  // Swapping the live gateway to another source or profile must re-pull that
  // source's model/config/profile state. Two sources commonly both expose a
  // `default` profile, so profile alone is not a sufficient identity.
  const gatewayScope = `${activeConnectionId ?? ''}\0${activeGatewayProfile}`
  const lastGatewayScopeRef = useRef(gatewayScope)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (gatewayScope === lastGatewayScopeRef.current) {
      return
    }

    lastGatewayScopeRef.current = gatewayScope
    // Force: the new source/profile pair has its own defaults, so reseed the
    // selector even if the composer already shows values from the previous
    // backend. These refreshes carry intent tokens so an in-flight picker
    // click still wins.
    void refreshCurrentModel(true)
    void refreshHermesConfig(true)
    void refreshActiveProfile()
  }, [gatewayScope, refreshCurrentModel, refreshHermesConfig])

  // New session anchored to a workspace. Seeds cwd + branch from the clicked
  // workspace; an explicit worktree path also drills the sidebar into that
  // project so the new lane is visible.
  //
  // `openTab` is the sidebar "+" behavior: once a chat is loaded, stack a new
  // tab instead of replacing it (see mainChatOccupied). The composer's
  // "branch off into a new worktree" flow keeps the fresh-draft path — it
  // prefills the MAIN composer right after, so it has to own that surface.
  const startSessionInWorkspace = useCallback(
    (path: null | string, options?: { openTab?: boolean }) => {
      setWorkspaceScope('sessions')

      if (options?.openTab && mainChatOccupied(activeSessionIdRef.current, $selectedStoredSessionId.get())) {
        void openNewSessionTile('center', { cwd: path, listed: false })

        return
      }

      startWorkspaceSession({
        activeSessionIdRef,
        followActiveSessionCwd,
        onExplicitWorkspace: restoreWorktree,
        path,
        requestGateway,
        startFreshSessionDraft
      })
    },
    [activeSessionIdRef, openNewSessionTile, requestGateway, startFreshSessionDraft]
  )

  // Composer "branch off into a new worktree": open a fresh session anchored
  // to the just-created tree, then prefill the task that kicked it off.
  const startWorkSessionRequest = useStore($startWorkSessionRequest)
  const lastStartWorkTokenRef = useRef(startWorkSessionRequest?.token ?? 0)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (!startWorkSessionRequest || startWorkSessionRequest.token === lastStartWorkTokenRef.current) {
      return
    }

    lastStartWorkTokenRef.current = startWorkSessionRequest.token
    startSessionInWorkspace(startWorkSessionRequest.path, { openTab: startWorkSessionRequest.openTab })

    if (startWorkSessionRequest.draft) {
      requestComposerInsert(startWorkSessionRequest.draft, { target: 'main' })
    }
  }, [startSessionInWorkspace, startWorkSessionRequest])

  const composer = useComposerActions({ activeSessionId, currentCwd, requestGateway })

  const branchInNewChat = useCallback(
    async (messageId?: string) => {
      const branched = await branchCurrentSession(messageId)

      if (branched) {
        await refreshSessions().catch(() => undefined)
      }

      return branched
    },
    [branchCurrentSession, refreshSessions]
  )

  const handleSkinCommand = useSkinCommand()

  const {
    cancelRun,
    editMessage,
    executeSlashCommand,
    handleThreadMessagesChange,
    reloadFromMessage,
    restoreToMessage,
    steerPrompt,
    submitText,
    transcribeVoiceAudio
  } = usePromptActions({
    activeSessionId,
    activeSessionIdRef,
    branchCurrentSession: branchInNewChat,
    busyRef,
    createBackendSessionForSend,
    getRoutedStoredSessionId,
    getRuntimeIdForStoredSession,
    getRouteToken,
    handleSkinCommand,
    openMemoryGraph: openRemovedMemoryGraph,
    refreshSessions,
    requestGateway,
    resumeStoredSession: resumeSession,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionIdRef,
    startFreshSessionDraft,
    sttEnabled,
    updateSessionState
  })

  // The pet box's target, read at send time: the session on screen and the busy flag the composer's guard reads.
  const petPromptTarget = useCallback(
    () => petPromptTargetOf({ activeSessionIdRef, busyRef, selectedStoredSessionIdRef }),
    [activeSessionIdRef, selectedStoredSessionIdRef]
  )

  // Runs outside the selected ChatBar so queues belonging to background
  // sessions continue once those sessions are idle.
  useBackgroundQueueDrain({
    enabled: gatewayState === 'open',
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionId,
    submitText
  })

  // Session-tile delegate (resume/submit/interrupt/slash + the session verbs
  // the tile TAB menu needs, without touching the primary view).
  useSessionTileDelegate({
    archiveSession,
    branchStoredSession,
    executeSlashCommand,
    removeSession,
    requestGateway,
    runtimeIdByStoredSessionIdRef,
    sessionStateByRuntimeIdRef,
    updateSessionState
  })

  // The global-hotkey Quick Entry window's bridge: its captured text rides the
  // SAME submit machinery the normal composer uses (current chat / picked
  // session / new session), and it hears gateway truth from this window.
  useQuickEntryBridge({ startFreshSessionDraft, submitText })

  // Leaving HUD mode hands this window the session back (see hud/handoff).
  useHudHandoff({ navigate, resumeSession })

  // Clear a failed turn's red error banner. Errors are renderer-local (never
  // persisted): a bare error placeholder is dropped entirely; a partial-output
  // failure keeps its content and sheds the error. Both the runtime cache AND
  // the live $messages view must be updated — preserveLocalAssistantErrors
  // re-grafts any still-errored view message on the next session.info flush.
  const dismissError = useCallback(
    (messageId: string) => {
      const runtimeSessionId = activeSessionIdRef.current

      if (!runtimeSessionId) {
        return
      }

      const clearErrorIn = (messages: ChatMessage[]): ChatMessage[] =>
        messages.flatMap(message => {
          if (message.id !== messageId || !message.error) {
            return [message]
          }

          if (!chatMessageText(message).trim() && !message.parts.some(part => part.type !== 'text')) {
            return []
          }

          return [{ ...message, error: undefined, pending: false }]
        })

      // View first: the cache update below triggers a re-sync that reads
      // $messages as the error-preservation baseline.
      setMessages(clearErrorIn($messages.get()))

      updateSessionState(runtimeSessionId, state => ({
        ...state,
        messages: clearErrorIn(state.messages)
      }))
    },
    [activeSessionIdRef, updateSessionState]
  )

  useRouteResume({
    activeSessionId,
    activeSessionIdRef,
    creatingSessionRef,
    currentView,
    freshDraftReady,
    gatewayState,
    locationPathname: location.pathname,
    resumeSession,
    resumeFailedSessionId,
    resumeExhaustedSessionId,
    sessionResumeRequest,
    routedSessionId,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionId,
    selectedStoredSessionIdRef,
    startFreshSessionDraft
  })

  // Plugins hear the stream FIRST (isolated fan-out in contrib/events), then
  // the app dispatches as before — a plugin listener can't affect app flow.
  const handleGatewayEventWithPlugins = useCallback(
    (event: Parameters<typeof handleDesktopGatewayEvent>[0]) => {
      emitGatewayEvent(event)

      if (event.type === 'wake.detected') {
        const payload = event.payload as { profile?: null | string; start_new_session?: boolean } | undefined

        // Free the Mac mic so voice conversation can open getUserMedia.
        // Server already pauses the detector lease; this stops client PCM feed.
        stopClientCapture()

        // Audible confirmation that the wake registered, before voice capture
        // starts. Gated by the shared sound-mute toggle.
        playWakeSound()
        activateWakeIndicator()

        // Multi-profile routing: a wake phrase enrolled by another profile
        // re-homes the gateway to that profile first (live swap — same path
        // as clicking it in the profile rail), then opens the fresh session
        // and starts voice there.
        const targetProfile = payload?.profile?.trim()
        const activeProfile = normalizeProfileKey($activeGatewayProfile.get())

        if (targetProfile && normalizeProfileKey(targetProfile) !== activeProfile) {
          if (payload?.start_new_session !== false) {
            newSessionInProfile(targetProfile)
          } else {
            void ensureGatewayProfile(normalizeProfileKey(targetProfile)).catch((error: unknown) => {
              // #81094: the voice-path switch must surface its failure too.
              notifyError(error, `Failed to switch to profile "${normalizeProfileKey(targetProfile)}"`)
            })
          }
        } else if (payload?.start_new_session !== false) {
          startFreshSessionDraft()
        }

        requestVoiceConversationStart()

        return
      }

      handleDesktopGatewayEvent(event)
    },
    [handleDesktopGatewayEvent, startFreshSessionDraft]
  )

  useGatewayBoot({
    beforeConnectionSwitch: () => {
      startFreshSessionDraft({ preserveRoute: true, workspaceTarget: null })
      resetOverlayReturnRoute()
      closeAllTerminals()
    },
    handleGatewayEvent: handleGatewayEventWithPlugins,
    onConnectionReady: c => {
      connectionRef.current = c
    },
    onGatewayReady: g => {
      gatewayRef.current = g
    },
    refreshHermesConfig,
    refreshSessions
  })

  useEffect(() => {
    if (gatewayState === 'open') {
      // Status-then-arm, syncing $wakeWord so the composer toggle reflects the
      // same listener this auto-arm claims.
      void armWakeWord(requestGateway)
    }
  }, [gatewayState, requestGateway])

  const activeIsMessaging =
    !!selectedStoredSessionId &&
    isMessagingSource(messagingSessions.find(s => sessionMatchesStoredId(s, selectedStoredSessionId))?.source)

  // sessions.changed refreshes every open transcript; only messaging retains
  // the periodic safety-net it already had before this fix.
  // Keep app data live while the gateway is open (on-connect reseed + the
  // cron / messaging / transcript visibility polls + fresh-draft reseed).
  useBackgroundSync({
    activeConnectionId,
    activeGatewayProfile,
    activeIsMessaging,
    activeSessionId,
    activeStoredSessionId: selectedStoredSessionId,
    freshDraftReady,
    gatewayState,
    refreshActiveTranscript,
    refreshCronJobs,
    refreshCurrentModel,
    refreshHermesConfig,
    refreshMessagingSessions,
    refreshSessions,
    requestGateway,
    updateSessionState
  })

  // Electron-main / OS / cross-window integrations: update polling, ⌘W close,
  // deep links, native-notification nav, preview-shortcut enablement,
  // remembered-session restore, and cross-window session-list sync.
  const previewTarget = useStore($previewTarget)

  useDesktopIntegrations({
    activeProfile: normalizeProfileKey(activeGatewayProfile),
    chatOpen,
    hasPreview: Boolean(previewTarget),
    locationPathname: location.pathname,
    navigate,
    profileReady: boot.phase === 'renderer.ready',
    refreshSessions,
    resumeExhaustedSessionId,
    routedSessionId,
    runtimeIdByStoredSessionId: runtimeIdByStoredSessionIdRef,
    sessions
  })

  // Pin/unpin the selected session (keybind + chat header) — pinned
  // on the durable lineage-root id so it survives auto-compression.
  const toggleSelectedPin = useCallback(() => {
    const sessionId = $selectedStoredSessionId.get()

    if (!sessionId) {
      return
    }

    const session = $sessions.get().find(s => sessionMatchesStoredId(s, sessionId))
    const pinId = session ? sessionPinId(session) : sessionId

    if ($pinnedSessionIds.get().includes(pinId)) {
      unpinSession(pinId)
    } else {
      pinSession(pinId)
    }
  }, [])

  // The tab-strip "+" and ⌘T share one action: open a new session as its own
  // tab (stacked into the workspace zone) WITHOUT polluting the session list.
  // Created `listed: false`, so each new tab's in-memory session stays out of
  // the sidebar until its first message persists a turn and a refresh surfaces
  // it — Cursor-style. Every click opens a fresh "New session" tab (multiple
  // empty tabs are fine since none touch the session list).
  const openNewSessionTab = useCallback(() => {
    const workspaceMode = $workspaceMode.get()
    const workspaceOwnerKey = $workspaceOwnerKey.get()
    const workspaceNewSessionTarget = $workspaceNewSessionTarget.get()

    if (workspaceMode === 'bots') {
      if (workspaceNewSessionTarget?.kind !== 'route' || !workspaceOwnerKey) {
        notify({
          kind: 'info',
          message:
            workspaceNewSessionTarget?.kind === 'blocked'
              ? workspaceNewSessionTarget.message
              : 'Select a Bot or group first.'
        })

        return
      }

      void openNewSessionTile('center', {
        listed: false,
        route: workspaceNewSessionTarget.route,
        workspaceScope: {
          ownerRoute: workspaceNewSessionTarget.route,
          workspaceMode: 'bots',
          workspaceOwnerKey
        }
      })

      return
    }

    void openNewSessionTile('center', { listed: false })
  }, [openNewSessionTile])

  // Archive the selected session (rebindable `session.archive` hotkey).
  const archiveSelectedSession = useCallback(() => {
    const sessionId = $selectedStoredSessionId.get()

    if (!sessionId) {
      return
    }

    void archiveSession(sessionId)
  }, [archiveSession])

  // Single global listener for every rebindable hotkey plus the on-screen
  // keybind editor's capture mode (same as DesktopController).
  useKeybinds({
    archiveSelectedSession,
    openNewSessionTab,
    startFreshSession: startFreshSessionDraft,
    toggleCommandCenter,
    toggleSelectedPin
  })

  // Register the tab-strip "+" action (the generic renderer stays
  // session-agnostic; null until wired hides the glyph).
  useEffect(() => {
    $newSessionTabAction.set(openNewSessionTab)

    return () => $newSessionTabAction.set(null)
  }, [openNewSessionTab])

  // Publish the one session action the Command Center pane cannot build for
  // itself (front K5). `removeSession` resolves the owning profile, sweeps the
  // messaging/cron slices and the archived store; a pane-local re-implementation
  // would drop those branches, and the pane is inside Settings, far from this
  // controller's props. Same crossing as `$newSessionTabAction` above.
  useEffect(() => {
    $commandCenterSessionDelete.set(removeSession)

    return () => $commandCenterSessionDelete.set(null)
  }, [removeSession])

  // The MAIN tab's Close. The workspace pane can't leave the tree, so its
  // closer empties it instead: the next stacked session shifts in, else main
  // drops to a fresh draft. Registering it here is also what gives the tab its
  // close GESTURE (⌘-click / middle-click) — the strip reads the closer, not
  // the `uncloseable` flag, so the pane stays undismissable either way.
  useEffect(() => {
    registerPaneCloser('workspace', () => void closeWorkspaceTab(id => navigate(sessionRoute(id))))

    return () => registerPaneCloser('workspace')
  }, [navigate])

  // The controller's entire callback surface, gathered into the stable
  // `actions` bag. `nextActions` is TS-checked against WiringActions each
  // render; its fields are copied into the ref object so `actions` keeps one
  // identity for the app's life (memoized surfaces don't re-render on churn)
  // while every handler still closes over the latest values.
  const nextActions: WiringActions = {
    onAddContextRef: composer.addContextRefAttachment,
    onAddUrl: url => composer.addContextRefAttachment(`@url:${formatRefValue(url)}`, url),
    onArchiveSession: sessionId => void archiveSession(sessionId),
    onAttachDroppedItems: composer.attachDroppedItems,
    onAttachImageBlob: composer.attachImageBlob,
    onAttachPrCommentUrl: composer.attachPrCommentUrl,
    onBranchInNewChat: messageId => void branchInNewChat(messageId),
    onBranchSession: sessionId => void branchStoredSession(sessionId),
    onCancel: cancelRun,
    onDeleteSelectedSession: () => {
      const id = $selectedStoredSessionId.get()

      if (id) {
        void removeSession(id)
      }
    },
    onDeleteSession: sessionId => void removeSession(sessionId),
    onDismissError: dismissError,
    onEdit: editMessage,
    onLoadMoreMessaging: loadMoreMessagingForPlatform,
    onLoadMoreSessions: loadMoreSessions,
    onManageCronJob: jobId => {
      setCronFocusJobId(jobId)
      navigate(CRON_ROUTE)
    },
    onNavigate: selectSidebarItem,
    onNewSessionInWorkspace: path => startSessionInWorkspace(path, { openTab: true }),
    onNewSessionSplit: dir => void openNewSessionTile(dir),
    onPasteClipboardImage: opts => composer.pasteClipboardImage(opts),
    onPickFiles: () => void composer.pickContextPaths('file'),
    onPickFolders: () => void composer.pickContextPaths('folder'),
    onPickImages: () => void composer.pickImages(),
    onReload: reloadFromMessage,
    onRemoveAttachment: id => void composer.removeAttachment(id),
    onRestoreToMessage: restoreToMessage,
    // Already on screen (open tile, or the main session)? Jump to its tab;
    // otherwise load it into main. Same door every other session link uses.
    // The clicked ROW is the identity, not its bare id: two profiles can hold
    // twins with the same stored id (#92454), and an id-only resume resolves
    // against whichever cached row is found first — the user clicks a row
    // previewing profile A and the resume dials profile B. Pin the row's own
    // (connection, profile) as the resume owner before navigating; untagged
    // rows (single-profile installs, legacy pages) keep the id-only path.
    onResumeSession: (sessionId, session) => {
      const rowProfile = session?.profile?.trim()

      if (rowProfile) {
        requestSessionResume(sessionId, {
          connectionId: session?.connection_id?.trim() || 'local',
          ...(session?.connection_id?.trim() ? {} : { mode: 'local' as const }),
          profile: rowProfile,
          targetProfile: rowProfile
        })
      }

      openSession(sessionId, navigate)
    },
    onRetryResume: sessionId => void resumeSession(sessionId, true),
    onSteer: steerPrompt,
    onSubmit: submitText,
    onThreadMessagesChange: handleThreadMessagesChange,
    onToggleSelectedPin: toggleSelectedPin,
    onTranscribeAudio: transcribeVoiceAudio,
    onTriggerCronJob: jobId =>
      triggerAndRefreshCronJobs(jobId, profileScope === ALL_PROFILES ? 'all' : profileScope)
        .then(() => undefined)
        .catch(() => undefined),
    getGateway: () => gatewayRef.current,
    openAgents,
    openCommandCenterSection,
    requestGateway,
    selectModel,
    toggleCommandCenter
  }

  if (actionsRef.current) {
    Object.assign(actionsRef.current, nextActions)
  } else {
    actionsRef.current = nextActions
  }

  const actions = actionsRef.current

  // Each pane node is memoized on ONLY the reactive inputs it truly consumes;
  // everything else reaches its surface through `actions` (stable) or the
  // surface's own atom subscriptions. A wiring tick that doesn't touch a
  // node's keys leaves its element reference intact, so `WiredPane` (memoized)
  // bails on that pane subtree — panes render independently of one another.
  const sidebarNode = useMemo(
    () => <SidebarSurface actions={actions} currentView={currentView} />,
    [actions, currentView]
  )

  // The voice cap changes only on config load; the gateway instance + all
  // chat reactivity are subscribed inside ChatRoutesSurface / ChatView.
  const chatRoutesNode = useMemo(
    () => <ChatRoutesSurface actions={actions} maxVoiceRecordingSeconds={voiceMaxRecordingSeconds} />,
    [actions, voiceMaxRecordingSeconds]
  )

  const api = useMemo<WiringApi>(
    () => ({
      chatRoutes: chatRoutesNode,
      sidebar: sidebarNode,
      // The statusbar is gone (E3a) and the deck terminal is gone (E3c: iT is
      // the one terminal, home/it-terminal.tsx); both parts stay in the
      // WiringApi contract with nothing wired to them.
      statusbar: null,
      terminal: null
    }),
    [chatRoutesNode, sidebarNode]
  )

  // Native window-button clearance for OUR frame (ic-window.css pads past the
  // macOS traffic lights) and the Windows/WSLg min/max/close reservation the
  // chat header and the popped-out browser keep clear of. Prefer the live WCO
  // measurement, fall back to the static reservation.
  const connection = useStore($connection)
  const controlsPos = titlebarControlsPosition(connection?.windowButtonPosition, Boolean(connection?.isFullscreen))
  const nativeOverlayWidth = useWindowControlsOverlayWidth() ?? connection?.nativeOverlayWidth ?? 0

  const titlebarToolsRight = titlebarToolsRightCss(nativeOverlayWidth, {
    darwinMajor: connection?.darwinMajor ?? 0,
    isFullscreen: Boolean(connection?.isFullscreen)
  })

  return (
    <ContribWiringContext.Provider value={api}>
      <div
        className="contents"
        style={
          {
            '--titlebar-controls-left': `${controlsPos.left}px`,
            // --titlebar-tools-width is the frame tools strip's own measurement (shell/frame-tools.tsx), on <html>.
            '--titlebar-tools-right': titlebarToolsRight
          } as CSSProperties
        }
      >
        {children}
      </div>

      {/* The full real overlay set (mirrors DesktopController's `overlays`). */}
      {/* App-wide single mounts (moved out of the retired sessions sidebar):
          both are atom-driven and opened from the composer, keybinds and
          Settings → Sessions & Bots. */}
      {!isAuxiliaryWindow() && <FilesIsland />}
      {!isAuxiliaryWindow() && <ProjectDialog />}
      {!isAuxiliaryWindow() && <WorktreeDialog />}
      <RemoteDisplayBanner />
      {!isAuxiliaryWindow() && <DesktopInstallOverlay />}
      {!isAuxiliaryWindow() && <ConsentSheet />}
      {!isAuxiliaryWindow() && (
        <DesktopOnboardingOverlay
          enabled={gatewayState === 'open'}
          onCompleted={() => {
            void refreshHermesConfig()
            void refreshCurrentModel()
            void queryClient.invalidateQueries({ queryKey: ['model-options'] })
          }}
          profile={activeGatewayProfile}
          requestGateway={requestGateway}
        />
      )}
      <ModelPickerOverlay gateway={gateway || undefined} onSelect={selectModel} profile={activeGatewayProfile} />
      <SessionPickerOverlay onResume={sessionId => openSession(sessionId, navigate)} />
      <ModelVisibilityOverlay
        gateway={gateway || undefined}
        onOpenProviders={openProviderSettings}
        profile={activeGatewayProfile}
      />
      <UpdatesOverlay />
      <GatewayConnectingOverlay />
      <BootFailureOverlay />
      <CommandPalette />
      <PluginInstallModal />
      <SessionSwitcher />
      <McpInstallDeepLinkDialog />
      <FindBar />
      <RemoteFolderPicker />

      {/* Eager, never behind Suspense: OUR frame is the first paint on every
          cold start, reload and restart — nothing upstream shows before it. */}
      {showHome && (
        <HomeView
          mode={homeMode}
          onClose={homeMode === 'window' ? () => navigate(HOME_ROUTE, { replace: true }) : closeOverlayToPreviousRoute}
        />
      )}

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsView
            gateway={gateway}
            onClose={closeOverlayToPreviousRoute}
            onConfigSaved={() => {
              void refreshHermesConfig()
              void refreshCurrentModel()
              void queryClient.invalidateQueries({ queryKey: ['model-options'] })
            }}
            onMainModelChanged={(provider, model) => {
              applySavedMainModel(provider, model)
              void refreshCurrentModel()
              void queryClient.invalidateQueries({ queryKey: ['model-options'] })
            }}
          />
        </Suspense>
      )}

      {agentsOpen && (
        <Suspense fallback={null}>
          <AgentsView onClose={closeOverlayToPreviousRoute} />
        </Suspense>
      )}

      {cronOpen && (
        <Suspense fallback={null}>
          <CronView
            onClose={closeOverlayToPreviousRoute}
            onOpenSession={sessionId => openSession(sessionId, navigate)}
          />
        </Suspense>
      )}

      {/* The one ex-page view still rendered as an overlay, in the same
          closable card as every other. Closing pops the overlay return stack,
          so a journey that started inside Settings ends back on the very
          Settings pane. Messaging and Command Center are Settings panes now
          (front K5), so neither is mounted here any more. */}
      {skillsOpen && (
        <Suspense fallback={null}>
          <Panel onClose={closeOverlayToPreviousRoute}>
            <SkillsView setStatusbarItemGroup={setStatusbarItemGroup} />
          </Panel>
        </Suspense>
      )}

      {!isAuxiliaryWindow() && (
        <Suspense fallback={null}>
          <FloatingPet
            onOpenSession={sessionId => openSession(sessionId, navigate)}
            onSubmitText={submitText}
            promptTarget={petPromptTarget}
          />
        </Suspense>
      )}

      {/* Toasts above everything. */}
      <NotificationStack />

      {/* Backs confirm() from @/store/confirm — renders only while one is open. */}
      <ConfirmHost />

      {/* Send Diagnostics consent/upload dialog — driven by $sendDiagnostics
          (error card action); renders nothing until requested. */}
      <SendDiagnosticsHost />

      {/* iT's shells: one never-reparented xterm per terminal in the pool,
          each parked over its pane's slot. Mounted here — outside the Message
          window — so closing that window, switching to the chat view or
          splitting a pane never takes a running shell down with it. */}
      {/* A ⌘⇧N peer shares this origin's pool: hosting it there would spawn a second PTY per shell. */}
      {!isAuxiliaryWindow() && !isPeerInstanceWindow() && (
        <ItTerminalHost onAddSelectionToChat={composer.addTerminalSelectionAttachment} />
      )}
    </ContribWiringContext.Provider>
  )
}
