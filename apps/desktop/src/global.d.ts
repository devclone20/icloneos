import type { GatewayWsUrlResult } from '@hermes/shared'
import type { TranslucencyState } from '@hermes/shared/translucency'

import type {
  AcpInstallResult,
  AcpRunResult,
  AcpStatusOptions,
  InftAcpStatus,
  InftDetachResult,
  InftKvKey,
  InftKvResult,
  SkillSyncReport
} from './app/home/acp-setup'
import type { InftProfileSource, ResolvedInftProfile } from './app/home/inft-bootstrap'
import type { InftScanResult } from './app/home/inft-scan'
import type { OwnerChoice, OwnershipBridgeItem, OwnershipView } from './app/home/ownership'
import type { IclonePrivySessionPayload } from './app/home/privy-session'
import type { IcloneBalancesResult } from './app/home/wallet-balances'
import type { HomeTickResult, InftBookCursor, InftBookPage } from './app/settings/inft-book/book-types'
import type { SkillCatalog } from './app/settings/skills-settings-model'
import type { AgentRuntimeStatus } from './iclone-shared/agent-runtime-status'
import type {
  DesktopConnectionConfigInput,
  DesktopConnectionKind,
  DesktopRegistryConnectionInput,
  DesktopUninstallMode,
  DesktopUpdateApplyOptions,
  DesktopUpdateDirtyStrategy,
  HermesActiveWork,
  HermesApiRequest,
  HermesNotification,
  HermesReviewScope,
  HermesSelectPathsOptions,
  HermesTitleBarTheme
} from './iclone-shared/bridge-contract'
import type { PetPromptResult } from './iclone-shared/pet-prompt'
import type { WakeIndicatorState } from './lib/wake-indicator'
import type {
  PetOverlayBounds,
  PetOverlayControl,
  PetOverlayOpenRequest,
  PetOverlayStatePayload
} from './store/pet-overlay'
import type { QuickEntryStatePush, QuickEntryStatus, QuickEntrySubmitPayload } from './store/quick-entry'
import type { AppUpdateLogEntry, AppUpdateRestartResult, AppUpdateState } from './types/iclone-app-update'
import type {
  IcloneRuntimeAlignRecord,
  IcloneRuntimeStatus,
  IcloneSetDeveloperPolicyResult,
  IcloneUpdatePolicyInfo,
  IcloneUpstreamCheckOptions,
  IcloneUpstreamStatus
} from './types/iclone-updates'

export type {
  DesktopConnectionConfigInput,
  DesktopConnectionKind,
  DesktopRegistryConnectionInput,
  DesktopUninstallMode,
  DesktopUpdateApplyOptions,
  DesktopUpdateDirtyStrategy,
  HermesActiveWork,
  HermesApiRequest,
  HermesNotification,
  HermesReviewScope,
  HermesSelectPathsOptions,
  HermesTitleBarTheme
}

export {}

declare global {
  interface Window {
    hermesDesktop: {
      // Resolve a backend connection. Omit `profile` (or pass the primary) for
      // the window's backend; pass a named profile to lazily spawn/reuse that
      // profile's backend from the pool.
      getConnection: (profile?: string | null) => Promise<HermesConnection>
      // Registry-scoped backend resolution: dial (connectionId, profile). An
      // empty/local connectionId delegates to the legacy getConnection path.
      getConnectionFor?: (payload: {
        connectionId?: null | string
        profile?: null | string
      }) => Promise<HermesConnection>
      // Registry-scoped fresh WS URL (same result contract as getGatewayWsUrl).
      getGatewayWsUrlFor?: (payload: {
        connectionId?: null | string
        profile?: null | string
      }) => Promise<GatewayWsUrlResult>
      // Union agent roster across every registered connection.
      getAgentRoster?: () => Promise<DesktopAgentRoster>
      // Credential-free routes across the union connection registry. The
      // optional profile list is used only by the single-local v1 fallback;
      // endpoint and auth material never crosses the IPC boundary.
      getProfileRoutes: (profiles: string[]) => Promise<DesktopPluginProfileRoute[]>
      // Reconnect-after-wake recovery: liveness-probe the cached PRIMARY backend
      // and drop it if a remote one has gone unreachable, so the next
      // getConnection() rebuilds a reachable descriptor instead of the renderer
      // re-dialing a dead remote forever. No-op for local backends (they
      // self-heal via the child 'exit' handler). `rebuilt` is true when a stale
      // remote cache was dropped.
      revalidateConnection: () => Promise<{ ok: boolean; rebuilt: boolean }>
      // Keepalive: mark a pool profile backend as recently used so the idle
      // reaper spares it while its chat is active.
      touchBackend: (profile?: string | null) => Promise<{ ok: boolean }>
      /** Respawn the desktop backend so it re-reads once-per-process config
       *  (browser.headed). Interrupts a turn in flight. */
      restartBackend: () => Promise<{ error?: string; ok: boolean }>
      getGatewayWsUrl: (profile?: null | string) => Promise<GatewayWsUrlResult>
      // Open (or focus) a standalone OS window for a single chat session so
      // the user can work with multiple chats side by side. Returns ok:false
      // with an error code when the sessionId is empty/invalid. `watch` opens
      // a spectator window (lazy resume — no agent build) for live-streaming
      // a running subagent's session.
      openSessionWindow: (sessionId: string, opts?: { watch?: boolean }) => Promise<{ ok: boolean; error?: string }>
      // Resume this session in the user's own terminal emulator (`hermes --tui
      // --resume <id>`) — the external terminal, not the in-app pane.
      openSessionInTerminal: (
        sessionId: string,
        opts?: { cwd?: string; profile?: string }
      ) => Promise<{ ok: boolean; error?: string }>
      // Open a new full-chrome app window — a peer instance of the primary that
      // renders the complete app against the shared backend, so the user can run
      // multiple GUI windows at once.
      openWindow: () => Promise<{ ok: boolean; error?: string }>
      // Pop the in-app Browser (webview + address bar) into its own OS window.
      // `tabId` is the `$previewTabs` id; closing the window fires
      // `onBrowserPopoutClosed` so the caller can dock the tab again.
      openBrowserWindow: (tabId: string) => Promise<{ ok: boolean; error?: string }>
      onBrowserPopoutClosed: (callback: (tabId: string) => void) => () => void
      // Claim a one-shot cross-window ambient cue (turn-end sound / spoken
      // reply). Resolves true for the first window to claim a key, false for
      // peers — so N open windows don't all fire the same cue.
      claimAmbientCue: (key: string) => Promise<boolean>
      wakeIndicator?: {
        getState: () => Promise<WakeIndicatorState>
        setState: (state: WakeIndicatorState) => void
        onState: (callback: (state: WakeIndicatorState) => void) => () => void
      }
      // iCLONE OS — multi-chain native-coin balances (public RPCs).
      icloneBalances?: {
        fetch: (address: string, solAddress?: string) => Promise<IcloneBalancesResult>
      }
      // iCLONE OS — on-chain 3D model fetch for the iNFT Stage.
      icloneModel?: {
        fetch: (url: string) => Promise<{ ok: boolean; data?: Uint8Array; error?: string }>
      }
      // iCLONE OS — first-launch policy acceptance + permission intents (main owns consent.json).
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- seam: only this block may change
      icloneConsent?: import('./components/consent/types').IcloneConsentBridge
      // V3-ON — the first-launch Set up step (system permission status, packages' state).
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- seam: only this block may change
      icloneSetup?: import('./components/setup/types').IcloneSetupBridge
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- seam: only this block may change
      icloneConfinement?: import('./store/confinement').IcloneConfinementBridge
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- seam: only this block may change
      icloneDoctor?: import('./app/settings/diagnostics-settings-model').IcloneDoctorBridge
      // V3-I — ACP Market › Work (electron/iclone-acp-work/ipc.ts).
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- seam: only this block may change
      icloneAcpWork?: import('./store/acp-work').AcpWorkBridge
      // REL-6 — the ACP tools installer (electron/iclone-acp-tools/ipc.ts).
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- seam: only this block may change
      icloneAcpTools?: import('./store/acp-tools').AcpToolsBridge
      // iCLONE OS — App Atualisation: Track B (fork vs upstream, cached 6 h
      // in main unless forced; `cacheOnly` never runs git) and Track A (the
      // runtime, local reads only).
      icloneUpdates?: {
        check: (options?: IcloneUpstreamCheckOptions) => Promise<IcloneUpstreamStatus>
        runtime: () => Promise<IcloneRuntimeStatus>
        // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- seam: only this block may change
        compat?: import('./types/iclone-compat').IcloneCompatBridge
      }
      // iCLONE OS — the `it` CLI command plane.
      icloneIt?: {
        onCmd: (callback: (payload: { id: number; argv: string[] }) => void) => () => void
        reply: (id: number, output: string) => void
      }
      // iCLONE OS — Virtuals ACP CLI per-iNFT setup wizard.
      icloneAcp?: {
        check: () => Promise<{ ok: boolean; version?: string; error?: string }>
        /** electron/iclone-agentcard-status.ts: the owner's own AgentCard account, read-only (state null = unknown). */
        agentcardStatus?: () => Promise<unknown>
        run: (inftId: string, argv: string[], timeoutMs?: number) => Promise<AcpRunResult>
        status: (inftId: string, opts?: AcpStatusOptions) => Promise<InftAcpStatus>
        kvGet: (inftId: string, key: InftKvKey) => Promise<InftKvResult>
        kvSet: (inftId: string, key: InftKvKey, value: Record<string, unknown>) => Promise<InftKvResult>
        kvDelete: (inftId: string, key: InftKvKey) => Promise<InftKvResult>
        /** Email marks file per iNFT (electron/iclone-email-state.ts); value = the renderer's serialized state. */
        emailState?: {
          load: (slug: string) => Promise<EmailStateFileResult>
          save: (slug: string, value: Record<string, unknown>) => Promise<EmailStateFileResult>
        }
        detach: (inftId: string) => Promise<InftDetachResult>
        configMap: () => Promise<Record<string, InftAcpStatus>>
        install: () => Promise<AcpInstallResult>
        updateCheck: () => Promise<AcpInstallResult>
        setStage: (slug: string | null) => Promise<void>
        /** Start (slug) or stop (null) the job stream of the open market window. */
        watch: (slug: string | null) => Promise<{ ok: true; slug: string | null } | { ok: false; error: string }>
        /** `{ slug, source, type, jobId, status, at }` per job event; validated by the renderer. */
        onEvent: (callback: (payload: unknown) => void) => () => void
      }
      // iCLONE OS — bundled Hermes skills → the agent's skills trees.
      icloneSkills?: {
        sync: () => Promise<SkillSyncReport>
        last: () => Promise<SkillSyncReport | null>
        catalog?: () => Promise<SkillCatalog | null>
      }
      // iCLONE OS — Claude Code engine (the user's own `claude` CLI); see electron/iclone-claude-code.ts.
      icloneClaudeCode?: {
        status: (refresh?: boolean) => Promise<{
          authMethod: string | null
          fallbackTarget: { baseUrl?: string; model: string; provider: string } | null
          installed: boolean
          lastFallback: { at: number; reason: string; text: string } | null
          loggedIn: boolean
          path: string | null
          pluginInstalled: boolean
          subscriptionType: string | null
          version: string | null
          window: {
            fiveHour: { resetsAt: number | null; utilization: number | null } | null
            isUsingOverage: boolean
            sevenDay: { resetsAt: number | null; utilization: number | null } | null
            status: string
          } | null
        }>
        /** status.json + fallback.json only: never starts `claude` (the chat banner polls this). */
        fallbackState: () => Promise<{
          fallbackTarget: { baseUrl?: string; model: string; provider: string } | null
          lastFallback: { at: number; reason: string; text: string } | null
        }>
        setFallback: (target: { baseUrl?: string; model: string; provider: string }) => Promise<{ ok: true }>
      }
      // iCLONE OS — Privy wallet login + iNFT wallet scan.
      iclonePrivy?: {
        open: () => Promise<{
          ok: boolean
          error?: string
          reason?: 'port-in-use' | 'unavailable' | 'listen-failed'
          port?: number
        }>
        logout: () => Promise<{ ok: boolean; error?: string }>
        // The persist:iclone-privy partition's own word; null = unknown.
        status: () => Promise<IclonePrivySessionPayload | null>
        scan: (address: string) => Promise<InftScanResult>
        // The 3-minute Home refresh: page 1 + ownerOf proofs of the checked ids (electron/iclone-inft-book.ts).
        scanTick?: (address: string, checkedIds: string[]) => Promise<HomeTickResult>
        // One iNFT Book page per call (electron/iclone-inft-book.ts).
        bookScan?: (address: string, cursor: InftBookCursor | null) => Promise<InftBookPage>
        resolveProfile: (item: InftProfileSource) => Promise<ResolvedInftProfile>
        onSession: (callback: (session: IclonePrivySessionPayload) => void) => () => void
      }
      // iCLONE OS — ownership guard (R9): held / unknown / lost per iNFT.
      icloneOwnership?: {
        observe: (wallet: string, items: OwnershipBridgeItem[]) => Promise<OwnershipView[]>
        list: () => Promise<OwnershipView[]>
        recheck: (slug: string) => Promise<OwnershipView | null>
        choose: (
          slug: string,
          choice: OwnerChoice,
          confirm: string
        ) => Promise<{
          ok: boolean
          error?: string
          view?: OwnershipView
          deleteHermesProfile?: boolean
          note?: string
        }>
        prepareSell: (slug: string, github: boolean) => Promise<{ ok: boolean; error?: string; view?: OwnershipView }>
        presaleDetached: (slug: string, removed: number) => Promise<OwnershipView | null>
        promptHeaderWritten: (profileSlug: string) => Promise<number>
        ghStatus: () => Promise<{ ok: boolean; detail: string }>
        registry: () => Promise<{ version: number; origin: 'bundled' | 'remote'; contracts: number }>
        onChanged: (callback: (view: OwnershipView) => void) => () => void
      }
      // The pop-out pet (V3-P): a transparent always-on-top window hosting only the pixel pet. The main
      // renderer drives it (open/close + state push); the overlay sends control messages back. Every channel is
      // guarded in main (isTrustedSender) and the overlay holds no gateway.
      petOverlay?: {
        open: (request: PetOverlayOpenRequest) => Promise<{ ok: boolean; bounds?: PetOverlayBounds; reason?: string }>
        close: () => Promise<{ ok: boolean }>
        setBounds: (bounds: PetOverlayBounds) => void
        setIgnoreMouse: (ignore: boolean) => void
        /** The overlay's prompt box needs the keyboard: focusable only while it is open. */
        setFocusable: (focusable: boolean) => void
        pushState: (payload: PetOverlayStatePayload) => void
        control: (payload: PetOverlayControl) => void
        /** Main renderer → overlay (through main): what became of a prompt-box message. */
        sendPromptResult: (result: PetPromptResult) => void
        /** Main renderer → main: about to hand submit `id` on to the session (resolves once main recorded it). */
        promptHandoff: (id: number) => Promise<boolean>
        onPromptResult: (callback: (result: PetPromptResult) => void) => () => void
        onState: (callback: (payload: PetOverlayStatePayload) => void) => () => void
        onControl: (callback: (payload: PetOverlayControl) => void) => () => void
      }
      // HUD mode: the chrome-free floating chat. A FULL app renderer with its
      // own gateway (like an instance window), sized and skinned as a floating
      // bar — so it mounts the real composer rather than a lookalike. Main
      // owns the window; `onChanged` keeps every window's toggle truthful.
      hud?: {
        nativeDrag: boolean
        windowing?: {
          clientPlacement: boolean
          controlDrag: boolean
          nativeDrag: boolean
          workspaceTransfer: boolean
        }
        open: (request?: { sessionId?: null | string; profile?: null | string }) => Promise<{ ok: boolean }>
        close: () => Promise<{ ok: boolean }>
        setIgnoreMouse: (ignore: boolean) => void
        moveBy: (delta: { x: number; y: number; width: number; height: number }) => void
        setWorkspaceTransfer?: (transferring: boolean) => void
        setBounds: (bounds: { x: number; y: number; width: number; height: number }) => void
        resetLayout: () => Promise<{ ok: boolean }>
        setFrost: (showing: boolean) => Promise<{ ok: boolean }>
        setSession: (sessionId: null | string) => void
        onGoto: (callback: (sessionId: string) => void) => () => void
        onChanged: (callback: (state: { open: boolean; sessionId: null | string }) => void) => () => void
        onCursor: (callback: (point: { x: number; y: number } | null) => void) => () => void
        onGameOverlay: (callback: (state: { active: boolean; app: string }) => void) => () => void
      }
      // Quick Entry: a global-hotkey mini composer window. Main owns the OS
      // shortcut registration + the persisted preference (it must restore the
      // shortcut on a cold launch without the renderer visiting Settings), so
      // the renderer reads/writes it here and adopts the authoritative reply.
      quickEntry: {
        getSettings: () => Promise<QuickEntryStatus>
        // Returns the resulting state — including `registered: false` +
        // `error: 'taken'` when another app already owns the chord, so a failed
        // registration surfaces in Settings instead of failing silently.
        setSettings: (patch: { enabled?: boolean; shortcut?: string }) => Promise<QuickEntryStatus>
        // Quick window → main: send this payload (main forwards it to the
        // primary renderer, which routes it to the target session and submits
        // through the normal prompt path) and hide.
        submit: (payload: QuickEntrySubmitPayload) => void
        // Quick window → main: hide without sending (Escape / blur).
        dismiss: () => void
        // Primary renderer → main → quick window: gateway connection state +
        // the recent-session options. Main caches the latest push and replays
        // it to a quick window spawned later.
        pushState: (payload: QuickEntryStatePush) => void
        // Quick window subscribes to those pushes.
        onState: (callback: (payload: QuickEntryStatePush) => void) => () => void
        // Primary renderer subscribes to submits captured by the quick window.
        onSubmit: (callback: (payload: QuickEntrySubmitPayload | string) => void) => () => void
        // Quick window subscribes to "you were just summoned" so it can reset
        // its draft and re-focus the input on every open.
        onShown: (callback: () => void) => () => void
      }
      getBootProgress: () => Promise<DesktopBootProgress>
      getConnectionConfig: (profile?: null | string) => Promise<DesktopConnectionConfig>
      saveConnectionConfig: (payload: DesktopConnectionConfigInput) => Promise<DesktopConnectionConfig>
      applyConnectionConfig: (payload: DesktopConnectionConfigInput) => Promise<DesktopConnectionConfig>
      testConnectionConfig: (payload: DesktopConnectionConfigInput) => Promise<DesktopConnectionTestResult>
      // Opt-in OS-keychain encryption for stored gateway secrets (default
      // off). `get` never touches the OS keychain; `set` re-encodes stored
      // secrets and can throw when the keychain is unusable.
      getSecretStorageEncryption: () => Promise<{ on: boolean }>
      setSecretStorageEncryption: (on: boolean) => Promise<{ on: boolean }>
      // V3-FX M1: the Keychain setting now and when this app launched (null: not a trusted sender).
      keychainState?: () => Promise<{ on: boolean; atLaunch: boolean } | null>
      // r3: relaunch the app (only when the Keychain was turned on since launch); null: not a trusted sender.
      keychainRestart?: () => Promise<boolean | null>
      // v2 multi-connection registry: named agent sources, all persisted
      // together (local + any number of remote/cloud/ssh instances).
      connections: {
        list: () => Promise<DesktopConnectionsRegistry>
        save: (
          payload: DesktopRegistryConnectionInput
        ) => Promise<{ ok: boolean; connection: DesktopRegistryConnection; registry: DesktopConnectionsRegistry }>
        remove: (id: string) => Promise<{ ok: boolean; registry: DesktopConnectionsRegistry }>
        setPrimary: (id: string) => Promise<{ ok: boolean; registry: DesktopConnectionsRegistry }>
        setLaunchMode?: (
          mode: 'last-used' | 'primary'
        ) => Promise<{ ok: boolean; registry: DesktopConnectionsRegistry }>
        setLastUsed?: (id: string) => Promise<{ ok: boolean; registry: DesktopConnectionsRegistry }>
        test: (id: string) => Promise<DesktopConnectionTestResult>
        // Drain/update/restore one Desktop-managed SSH install. External URL
        // and cloud sources are refused without touching their processes.
        updateManaged?: (id: string) => Promise<DesktopManagedConnectionUpdateResult>
        // Fan out `hermes update` to every eligible registered connection;
        // cloud entries are skipped (platform-managed), each row independent.
        // excludeIds skips connections the caller updates through another
        // path (the everything-update flow's active backend + local client).
        updateAll?: (options?: {
          excludeIds?: string[]
        }) => Promise<{ ok: boolean; results: DesktopConnectionUpdateResult[] }>
        // Registry lifecycle push: fired when a connection is removed or
        // materially edited so the renderer can dispose (and re-dial) the
        // secondary gateways scoped to it. Optional: older Electron mains
        // don't emit it.
        onChanged?: (
          callback: (payload: { connectionId: string; reason: 'removed' | 'saved' | 'updated' }) => void
        ) => () => void
      }
      sshConfigHosts: () => Promise<DesktopSshHostsResult>
      sshResolveHost: (host: string) => Promise<DesktopSshResolveResult>
      probeConnectionConfig: (remoteUrl: string) => Promise<DesktopConnectionProbeResult>
      oauthLoginConnectionConfig: (remoteUrl: string) => Promise<DesktopOauthLoginResult>
      oauthLogoutConnectionConfig: (remoteUrl: string) => Promise<DesktopOauthLogoutResult>
      // Hermes Cloud: one portal login powers discovery + silent per-agent
      // sign-in (cloud-auto-discovery Phase 3).
      cloud: {
        status: () => Promise<DesktopCloudStatus>
        login: () => Promise<DesktopCloudStatus & { ok: boolean }>
        logout: () => Promise<DesktopCloudStatus & { ok: boolean }>
        discover: (org?: string) => Promise<DesktopCloudDiscoverResult>
        agentSignIn: (dashboardUrl: string) => Promise<DesktopCloudAgentSignInResult>
      }
      profile: {
        get: () => Promise<DesktopActiveProfile>
        // Persists the profile used on the next Desktop launch without
        // interrupting the live gateway workspace switch.
        remember: (name: string | null) => Promise<DesktopActiveProfile>
        // Persists the desktop's profile choice and relaunches the local
        // backend under the new HERMES_HOME (reloads the window). Pass null to
        // clear the preference.
        set: (name: string | null) => Promise<DesktopActiveProfile>
      }
      api: <T>(request: HermesApiRequest) => Promise<T>
      notify: (payload: HermesNotification) => Promise<boolean>
      requestMicrophoneAccess: () => Promise<boolean>
      /** read_window_below tool: metadata for the OS window directly underneath this one (never pixels). */
      readWindowBelow?: () => Promise<{
        frontmost: { app: string; title: string } | null
        note?: string
        platform: string
        window: {
          app: string
          bounds: { height: number; width: number; x: number; y: number }
          id: number
          title: string
        } | null
      } | null>
      readFileDataUrl: (filePath: string) => Promise<string>
      /** Remote non-image attach: higher dedicated cap than preview/Settings default. */
      readFileDataUrlForAttach?: (filePath: string) => Promise<string>
      /** Settings → Chat: max size for local files loaded as data URLs (attach/preview). */
      dataUrlReadMax?: {
        get: () => Promise<{ defaultMaxMb: number; maxBytes: number; maxMb: number }>
        set: (maxMb: number) => Promise<{ defaultMaxMb: number; maxBytes: number; maxMb: number }>
      }
      readFileText: (filePath: string) => Promise<HermesReadFileTextResult>
      /** Full-source read for runtime desktop plugins (readFileText truncates
       *  at the 512 KiB preview cap). Absent on older shells — callers fall
       *  back to readFileText and must reject a `truncated` result. */
      readPluginSource?: (filePath: string) => Promise<HermesReadFileTextResult>
      selectPaths: (options?: HermesSelectPathsOptions) => Promise<string[]>
      /** Native save dialog; returns the chosen path or null on cancel. */
      selectSavePath?: (options?: {
        defaultPath?: string
        filters?: Array<{ extensions: string[]; name: string }>
        title?: string
      }) => Promise<null | string>
      writeClipboard: (text: string) => Promise<boolean>
      readClipboard: () => Promise<string>
      saveGatewayFile?: (payload: {
        connectionId?: null | string
        path: string
        profile?: null | string
        suggestedName?: string
      }) => Promise<{
        canceled?: boolean
        path?: string
        saved: boolean
      }>
      saveImageFromUrl: (url: string) => Promise<boolean>
      /** Edit verb against the window's focused element (the custom context
       *  menu's Cut/Copy/Paste/Select all). */
      contextMenuEdit?: (command: 'copy' | 'cut' | 'paste' | 'selectAll') => Promise<void>
      /** Copy the image under the LAST context-menu gesture (Chromium tracks
       *  its coordinates on the main-process context-menu event). */
      contextMenuCopyImage?: () => Promise<void>
      /** Replace the misspelled word or add it to the dictionary. */
      contextMenuSpellcheck?: (action: { kind: 'add' | 'replace'; word: string }) => Promise<void>
      /** Add a word to the spell-check dictionary of a webview guest's
       *  session (the tag exposes no session API). */
      contextMenuGuestAddWord?: (payload: { webContentsId: number; word: string }) => Promise<void>
      /** Spell-check facts for the gesture that opened the current menu;
       *  fires shortly after the DOM contextmenu event. */
      onContextMenuSpellcheck?: (
        callback: (payload: { misspelledWord: string; suggestions: string[] }) => void
      ) => () => void
      saveImageBuffer: (data: ArrayBuffer | Uint8Array, ext: string) => Promise<string>
      saveClipboardImage: () => Promise<string>
      getPathForFile: (file: File) => string
      normalizePreviewTarget: (target: string, baseDir?: string) => Promise<HermesPreviewTarget | null>
      watchPreviewFile: (url: string) => Promise<HermesPreviewWatch>
      /** Watch a directory for entry churn (disk-plugin door); same watcher
       *  registry + onPreviewFileChanged channel as watchPreviewFile. Optional:
       *  older Electron shells predate it and fall back to the readdir poll. */
      watchDirectory?: (dir: string) => Promise<HermesPreviewWatch>
      stopPreviewFileWatch: (id: string) => Promise<boolean>
      setActiveWork?: (payload: HermesActiveWork) => void
      setTitleBarTheme?: (payload: HermesTitleBarTheme) => void
      setNativeTheme?: (mode: 'dark' | 'light' | 'system') => void
      /** Main-process fact: this OS can back glass with a native material. */
      glassSupported?: boolean
      /** Main-process fact: this OS can do any translucency at all (not Linux). */
      translucencySupported?: boolean
      setTranslucency?: (payload: TranslucencyState) => void
      setKeepAwake?: (on: boolean) => void
      setDisableF12?: (blocked: boolean) => void
      setPreviewShortcutActive?: (active: boolean) => void
      openExternal: (url: string) => Promise<void>
      openPreviewInBrowser?: (url: string) => Promise<void>
      fetchLinkTitle: (url: string) => Promise<string>
      /** A site's icon as a data URL, or '' when it has none we can read.
       *  Resolved and cached in the main process (electron/favicon.ts). */
      resolveFavicon?: (url: string) => Promise<string>
      sanitizeWorkspaceCwd: (cwd?: null | string) => Promise<{ cwd: string; sanitized: boolean }>
      settings: {
        getDefaultProjectDir: () => Promise<{ defaultLabel: string; dir: null | string; resolvedCwd: string }>
        pickDefaultProjectDir: () => Promise<{ canceled: boolean; dir: null | string }>
        setDefaultProjectDir: (dir: null | string) => Promise<{ dir: null | string }>
      }
      zoom?: {
        get: () => Promise<{ level: number; percent: number }>
        /** Synchronous zoom factor of this window (1 = 100%). */
        factor?: () => number
        setPercent: (percent: number) => void
        onChanged: (callback: (payload: { level: number; percent: number }) => void) => () => void
      }
      revealLogs: () => Promise<{ ok: boolean; path: string; error?: string }>
      getRecentLogs: () => Promise<{ path: string; lines: string[] }>
      /** Persist a renderer error-boundary catch to desktop.log (fire-and-forget). */
      reportRendererError?: (report: {
        label: string
        boundary: string
        message: string
        componentStack: string
      }) => void
      readDir: (path: string) => Promise<HermesReadDirResult>
      gitRoot?: (path: string) => Promise<string | null>
      // Reveal a path in the OS file manager (Finder / Explorer).
      revealPath?: (path: string) => Promise<boolean>
      // Open a DIRECTORY (created if missing) in the OS file manager.
      openDir?: (path: string) => Promise<{ ok: boolean; error?: string }>
      // Local Desktop runtime-plugin root (<HERMES_HOME>/desktop-plugins),
      // resolved by Electron independently of the connected backend (#66899).
      // Created on demand; returns the normalized absolute path.
      desktopPluginsRoot?: () => Promise<string>
      /** LOCAL `<HERMES_HOME>/logs` (profile-aware) — error card "Open Logs". */
      logsRoot?: () => Promise<string>
      // Local AGENT-plugin root (<HERMES_HOME>/plugins), same Electron-local
      // resolution. The disk door also scans it for `<name>/desktop/plugin.js`
      // so one agent-plugin package can ship a desktop UI half. Optional:
      // older Electron shells predate it — the scanner then skips this root.
      agentPluginsRoot?: () => Promise<string>
      // Rename a file/folder in place (new base name, same parent dir).
      renamePath?: (path: string, newName: string) => Promise<{ path: string }>
      // Write a small UTF-8 text file (hardened path, parent must exist).
      writeTextFile?: (path: string, content: string) => Promise<{ path: string }>
      // Move a file/folder to the OS trash (recoverable).
      trashPath?: (path: string) => Promise<boolean>
      // Git-driven worktree management for the "Start work" flow.
      git?: {
        worktreeList: (repoPath: string) => Promise<HermesGitWorktree[]>
        worktreeAdd: (
          repoPath: string,
          options?: { name?: string; branch?: string; base?: string; existingBranch?: string }
        ) => Promise<{ path: string; branch: string; repoRoot: string }>
        worktreeRemove: (
          repoPath: string,
          worktreePath: string,
          options?: { force?: boolean }
        ) => Promise<{ removed: string }>
        branchSwitch: (repoPath: string, branch: string) => Promise<{ branch: string }>
        // The local branches, plus the remote-tracking refs that have no local
        // branch, for the "convert a branch into a worktree" picker.
        branchList: (repoPath: string) => Promise<HermesGitBranch[]>
        // Local + remote-tracking branches for the "base branch" picker in the
        // new-worktree dialog. The remote default (origin/HEAD) is flagged so
        // the UI can preselect it.
        baseBranchList: (repoPath: string) => Promise<HermesGitBaseBranch[]>
        // Compact working-tree status for the composer coding rail. Null on a
        // non-repo / remote backend (where the Electron probe can't run).
        repoStatus: (repoPath: string) => Promise<HermesRepoStatus | null>
        // Working-tree-vs-HEAD unified diff for one file (the preview's diff
        // view). Empty string when the file is unchanged or not in a repo.
        fileDiff: (repoPath: string, filePath: string) => Promise<string>
        // Codex-style review pane: changed files per scope, per-file diff, and
        // stage / unstage / revert.
        review: {
          list: (repoPath: string, scope: HermesReviewScope, baseRef?: null | string) => Promise<HermesReviewList>
          diff: (
            repoPath: string,
            filePath: string,
            scope: HermesReviewScope,
            baseRef?: null | string,
            staged?: boolean
          ) => Promise<string>
          stage: (repoPath: string, filePath?: null | string) => Promise<{ ok: boolean }>
          unstage: (repoPath: string, filePath?: null | string) => Promise<{ ok: boolean }>
          revert: (repoPath: string, filePath?: null | string) => Promise<{ ok: boolean }>
          revParse: (repoPath: string, ref?: null | string) => Promise<null | string>
          commit: (repoPath: string, message: string, push: boolean) => Promise<{ ok: boolean }>
          // Diff (staged-or-all) + recent commit subjects for drafting a
          // commit message. Reads only; empty strings off-repo.
          commitContext: (repoPath: string) => Promise<{ diff: string; recent: string }>
          push: (repoPath: string) => Promise<{ ok: boolean }>
          shipInfo: (repoPath: string) => Promise<HermesReviewShipInfo>
          // The PR on each of the given branches — plus any known only by
          // number — for badging a list of sessions in one request instead of
          // one `pr view` per checkout.
          prList: (repoPath: string, branches: string[], numbers?: number[]) => Promise<HermesRepoPullRequests>
          // A pasted PR review/issue comment URL resolved to its structured
          // context (author, body, file + line anchor, diff hunk). Null when
          // gh can't answer — the paste stays a plain URL.
          fetchPrComment: (repoPath: string, url: string) => Promise<HermesPrComment | null>
          createPr: (repoPath: string) => Promise<{ url: string }>
        }
        // Repo-first discovery: scan bounded roots for git repos (depth-capped).
        scanRepos: (
          roots: string[],
          options?: { maxDepth?: number; enabled?: boolean; excludePaths?: string[] }
        ) => Promise<{ root: string; label: string }[]>
      }
      terminal: {
        /** Best-effort current working directory of the live PTY child (POSIX
         *  only; null on Windows or when unavailable). Used to reopen a tab
         *  where the user last `cd`'d. */
        cwd: (id: string) => Promise<string | null>
        dispose: (id: string) => Promise<boolean>
        onData: (id: string, callback: (payload: string) => void) => () => void
        onExit: (id: string, callback: (payload: HermesTerminalExit) => void) => () => void
        resize: (id: string, size: { cols: number; rows: number }) => Promise<boolean>
        /** `pane`: the bus identity and spawn spec of an iT pane (V3-D, validated in main). */
        start: (options?: {
          cols?: number
          cwd?: string
          pane?: unknown
          rows?: number
        }) => Promise<HermesTerminalSession>
        write: (id: string, data: string) => Promise<boolean>
      }
      reachPreviewUrl?: (url: string) => Promise<string>
      setActiveConnectionRoute?: (
        route: {
          connectionId?: null | string
          profile?: string
          registryScoped?: boolean
        } | null
      ) => void
      onClosePreviewRequested?: (callback: () => void) => () => void
      onPreviewNav?: (callback: (command: 'back' | 'forward' | 'reload') => void) => () => void
      onOpenFolderRequested?: (callback: () => void) => () => void
      onOpenUpdatesRequested?: (callback: () => void) => () => void
      onDeepLink?: (
        callback: (payload: { kind: string; name: string; params: Record<string, string> }) => void
      ) => () => void
      signalDeepLinkReady?: () => Promise<{ ok: boolean }>
      probePluginRepo?: (payload: { identifier?: string; repo?: string }) => Promise<{
        ok: boolean
        agent: boolean
        desktop: boolean
        agentName?: string | null
        desktopName?: string | null
        warnings?: string[]
        insecure?: boolean
        error?: string
      }>
      installDesktopPlugin?: (payload: {
        identifier?: string
        repo?: string
        force?: boolean
      }) => Promise<{ ok: boolean; pluginName?: string; path?: string; error?: string }>
      onWindowStateChanged?: (callback: (payload: HermesWindowState) => void) => () => void
      onFocusSession?: (callback: (sessionId: string) => void) => () => void
      onNotificationAction?: (callback: (payload: { actionId: string; sessionId?: string }) => void) => () => void
      /** Plugin (and other session-less) notification body/action activation. */
      onNotificationActivate?: (
        callback: (payload: { actionId?: string; activate?: string; notifyId?: string; tag?: string }) => void
      ) => () => void
      onPreviewFileChanged: (callback: (payload: HermesPreviewFileChanged) => void) => () => void
      onBackendExit: (callback: (payload: BackendExit) => void) => () => void
      // Soft gateway-mode apply: primary backend was torn down without a window
      // reload. Wipe session lists (skeletons) and re-dial.
      onConnectionApplied?: (callback: () => void) => () => void
      onPowerResume?: (callback: () => void) => () => void
      getOnBattery?: () => Promise<boolean>
      onBatteryChanged?: (callback: (onBattery: boolean) => void) => () => void
      onBootProgress: (callback: (payload: DesktopBootProgress) => void) => () => void
      getBootstrapState: () => Promise<DesktopBootstrapState>
      continueBootstrapLocal: () => Promise<{ ok: boolean }>
      resetBootstrap: () => Promise<{ ok: boolean }>
      repairBootstrap: () => Promise<{ ok: boolean }>
      cancelBootstrap: () => Promise<{ ok: boolean; cancelled: boolean }>
      onBootstrapEvent: (callback: (payload: DesktopBootstrapEvent) => void) => () => void
      /** RTB-6/7 + V3-ON: the agent runtime install status and its repair actions. */
      agentRuntime?: {
        status: () => Promise<AgentRuntimeStatus & { skippedThisRun: boolean }>
        skip: () => Promise<{ ok: boolean; reason?: string }>
        installAgain: () => Promise<{ ok: boolean }>
        openFix: (fix: 'open-network-settings' | 'open-storage-settings' | 'reveal-folder') => Promise<{ ok: boolean }>
        onChange: (callback: (status: AgentRuntimeStatus) => void) => () => void
      }
      getVersion: () => Promise<DesktopVersionInfo>
      getRemoteDisplayReason?: () => Promise<string | null>
      updates: {
        check: () => Promise<DesktopUpdateStatus>
        apply: (opts?: DesktopUpdateApplyOptions) => Promise<DesktopUpdateApplyResult>
        getBranch: () => Promise<{ branch: string }>
        setBranch: (name: string) => Promise<{ branch: string; refused?: 'curated-only' }>
        /** R1: the update policy and the bundled runtime pin (local). */
        policy?: () => Promise<IcloneUpdatePolicyInfo>
        /** R1: the explicit developer compare with upstream; curated answers `curated-only`. */
        compareUpstream?: () => Promise<DesktopUpdateStatus>
        /** R1: a user-started check of the iclone os app updater (the app's own feed; `inactive` without one). */
        checkApp?: () => Promise<IcloneAppUpdateCheck>
        setDeveloperPolicy?: (payload: { ack: string; by: string }) => Promise<IcloneSetDeveloperPolicyResult>
        onProgress: (callback: (payload: DesktopUpdateProgress) => void) => () => void
      }
      /** H1: the app updater (electron/app-update-ipc.ts). Absent on bridges that predate it. */
      appUpdate?: {
        state: () => Promise<AppUpdateState>
        check: () => Promise<IcloneAppUpdateCheck>
        download: () => Promise<boolean>
        cancel: () => Promise<boolean>
        restart: (options?: { confirmed?: boolean }) => Promise<AppUpdateRestartResult>
        log: () => Promise<AppUpdateLogEntry[]>
        onChanged: (callback: (state: AppUpdateState) => void) => () => void
        onOpen: (callback: () => void) => () => void
        onNotice: (callback: (payload: { text: string }) => void) => () => void
      }
      uninstall: {
        summary: () => Promise<DesktopUninstallSummary>
        run: (mode: DesktopUninstallMode) => Promise<DesktopUninstallResult>
      }
      themes: {
        // Download a VS Code Marketplace extension and return the raw color
        // theme files it contributes. The renderer converts + persists them.
        fetchMarketplace: (id: string) => Promise<DesktopMarketplaceThemeResult>
        // Search the Marketplace for color-theme extensions. An empty query
        // returns the most-installed themes.
        searchMarketplace: (query: string) => Promise<DesktopMarketplaceSearchItem[]>
      }
      // Find-in-page: delegates to Electron's webContents.findInPage on the
      // IPC sender's window so Cmd+F from a secondary session window
      // searches that window (not the primary). `onFoundInPage` returns the
      // unsubscribe fn; the renderer wires it via `initFindInPageListener`
      // in store/find-in-page.ts and tears it down when the FindBar unmounts.
      findInPage: (query: string, options?: { forward?: boolean; findNext?: boolean }) => Promise<{ count: number }>
      stopFindInPage: () => Promise<void>
      onFoundInPage: (callback: (result: { activeMatchOrdinal: number; count: number }) => void) => () => void
      // Main-process `before-input-event` forwards Ctrl/Cmd+F here so the
      // renderer can still open the FindBar when the OS compositor has
      // already grabbed the chord (#81727, e.g. Pop!_OS / GNOME).
      onOpenFindBarRequested: (callback: () => void) => () => void
    }
  }
}

export interface DesktopMarketplaceSearchItem {
  extensionId: string
  displayName: string
  publisher: string
  description: string
  installs: number
}

export interface DesktopMarketplaceThemeFile {
  label: string
  /** VS Code's `uiTheme` for this entry (vs-dark / vs / hc-black). */
  uiTheme?: string
  /** Raw theme JSON (JSONC) text, parsed + converted by the renderer. */
  contents: string
}

export interface DesktopMarketplaceThemeResult {
  extensionId: string
  displayName: string
  themes: DesktopMarketplaceThemeFile[]
}

export interface HermesTerminalSession {
  cwd: string
  id: string
  shell: string
}

export interface HermesTerminalExit {
  code: number | null
  signal: string | null
}

export interface DesktopVersionInfo {
  /** The app's own semver (`app.getVersion()`), never the runtime's. */
  appVersion: string
  /** The Hermes runtime's `__version__`, or null when its checkout cannot be read. */
  runtimeVersion?: null | string
  /** `iclone os 1.0.0 · Hermes runtime 0.17.0` — the one line every version surface shows. */
  versionLine?: string
  electronVersion: string
  nodeVersion: string
  platform: string
  hermesRoot: string
  /** True when the running renderer bundle predates desktop changes in the
   *  installed source tree (runtime updated, app binary not rebuilt/swapped). */
  bundleOutOfSync?: boolean
  /** Commits under apps/desktop/ the running bundle is missing (null unknown). */
  bundleCommitsBehind?: null | number
}

/** `icloneAcp.emailState` (electron/iclone-email-state.ts): value null = no valid file yet. */
export type EmailStateFileResult = { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string }

export interface DesktopUninstallSummary {
  hermes_home: string
  agent_installed: boolean
  gui_installed: boolean
  source_built_artifacts: string[]
  packaged_app_paths: string[]
  userdata_dir: string
  userdata_exists: boolean
  platform: string
  running_app_path?: null | string
  probe?: string
}

export interface DesktopUninstallResult {
  ok: boolean
  mode?: DesktopUninstallMode
  willRemoveAppBundle?: boolean
  scriptPath?: string
  error?: string
  message?: string
}

export interface DesktopUpdateCommit {
  sha: string
  summary: string
  author: string
  at: number
}

export interface DesktopUpdateStatus {
  supported: boolean
  updateAvailable?: boolean
  branch?: string
  currentBranch?: string
  reason?: string
  message?: string
  error?: string
  /** Exact commits behind. null = update available, but the count is
   *  unknowable (shallow clone without a merge-base) — never render it as a
   *  literal number. */
  behind?: number | null
  currentSha?: string
  /** Backend only: the version string the backend reports for itself. */
  currentVersion?: string
  targetSha?: string
  commits?: DesktopUpdateCommit[]
  dirty?: boolean
  fetchedAt?: number
  /** R1: local status against the bundled runtime pin (never an upstream fetch). */
  pinned?: boolean
  aligned?: boolean | null
  pinSha?: string
  pinDate?: string
  policy?: 'curated' | 'developer'
  align?: IcloneRuntimeAlignRecord | null
}

export interface DesktopUpdateBlocker {
  pid: number
  name: string
  cmdline: string
  kind: 'local-preview' | 'other'
  safeToStop: boolean
  label?: string
  port?: number
  createTime?: number
}

export interface IcloneAppUpdateCheck {
  error?: string
  outcome:
    'available' | 'blocked-runtime' | 'downloaded' | 'downloading' | 'error' | 'inactive' | 'installing' | 'up-to-date'
  version: null | string
}

export interface DesktopUpdateApplyResult {
  ok: boolean
  branch?: string
  error?: string
  message?: string
  blockers?: DesktopUpdateBlocker[]
  /** True when no staged updater exists (CLI install) and the user should run
   *  `hermes update` themselves. `command` is the exact line to run. */
  manual?: boolean
  command?: string
  hermesRoot?: string
  /** True when the backend was updated but the GUI couldn't be relaunched in
   *  place (AppImage / dev run): the new version loads on next launch. */
  backendUpdated?: boolean
  /** False when the running GUI package was NOT replaced by this update
   *  (Linux GUI/backend skew, or a sandbox-blocked relaunch). Distinguishes
   *  "backend only" outcomes from a real in-place GUI relaunch. (#45205) */
  guiUpdated?: boolean
  /** True for the Linux GUI/backend-skew terminal state: backend updated but
   *  the running AppImage/.deb/.rpm shell is unchanged and must be
   *  reinstalled. Renders a closeable "update the desktop app" message. */
  guiSkew?: boolean
  /** True when the update finished but the app must be quit + reopened by hand
   *  (e.g. the rebuilt sandbox helper isn't launchable): keep a working
   *  window, don't auto-quit into a dead app. (#45205) */
  manualRestart?: boolean
  /** True when the auto-relaunch was skipped specifically because the rebuilt
   *  chrome-sandbox helper is not launchable (not root:root + setuid). */
  sandboxBlocked?: boolean
  /** True when a detached relauncher took over (macOS bundle swap / Linux
   *  re-exec): the app is about to quit and reopen itself. */
  handedOff?: boolean
}

export type DesktopUpdateStage =
  | 'idle'
  | 'prepare'
  | 'fetch'
  | 'pull'
  | 'pydeps'
  | 'update'
  | 'rebuild'
  | 'restart'
  | 'done'
  | 'manual'
  /** Backend updated but the running GUI package (AppImage/.deb/.rpm) was NOT
   *  changed — the user must update/reinstall the desktop app. Terminal,
   *  closeable; never claims the GUI was updated. (#45205) */
  | 'guiSkew'
  | 'error'

export interface DesktopUpdateProgress {
  stage: DesktopUpdateStage
  message: string
  percent: number | null
  error: string | null
  at: number
}

export interface DesktopPluginProfileRoute {
  // Registry source identity. Pair with profile; profile names are not unique
  // across sources.
  connectionId: string
  mode: 'local' | 'remote'
  profile: string
  targetProfile: string
}

export interface HermesConnection {
  baseUrl: string
  darwinMajor?: number
  isFullscreen: boolean
  // The live, RESOLVED connection mode. Only ever 'local' or 'remote' — a
  // 'cloud' saved-config entry resolves to a 'remote' connection under the hood
  // (cloud-auto-discovery Q3/Q6), so this never carries 'cloud'.
  mode?: 'local' | 'remote'
  authMode?: 'oauth' | 'token'
  remoteHost?: string
  remoteIdentity?: string
  remoteKind?: 'cloud' | 'ssh' | 'url'
  remoteHermesVersion?: string
  nativeOverlayWidth: number
  source?: 'env' | 'local' | 'settings'
  token: string
  wsUrl: string
  logs: string[]
  // Set for pool (non-primary) backends so the renderer knows which profile a
  // connection belongs to.
  profile?: string
  // The registry connection this descriptor resolves to. Registry-scoped
  // secondaries carry it directly; legacy primary remotes preserve it from
  // their selected stored route before dialing.
  connectionId?: string
  // True only when getConnectionFor explicitly resolved a v2 registry route.
  // An inferred connectionId identifies the visible source but its v1 profile
  // name may still be a client-side routing alias rather than a backend profile.
  registryScoped?: boolean
  // True only when `profile` is a request scope on the shared primary backend.
  // A pooled backend also carries `profile`, so presence alone cannot identify
  // the shared-primary routing case.
  sharedPrimary?: boolean
  // True when `profile` is a request scope on a SHARED registry remote/cloud
  // backend (one host, many profiles) — the registry analogue of sharedPrimary.
  sharedRemote?: boolean
  windowButtonPosition: { x: number; y: number } | null
}

export interface HermesWindowState {
  darwinMajor?: number
  isFullscreen: boolean
  isMinimized?: boolean
  isVisible?: boolean
  nativeOverlayWidth: number
  windowButtonPosition: { x: number; y: number } | null
}

export interface DesktopActiveProfile {
  // The desktop's stored profile preference, or null when unset (legacy launch
  // that defers to the sticky active_profile / default).
  profile: string | null
}

export interface DesktopConnectionConfig {
  envOverride: boolean
  // The saved connection mode. 'cloud' is a Hermes Cloud connection: it carries
  // a remote-shaped block (remoteUrl = the selected agent's dashboardUrl,
  // remoteAuthMode 'oauth') but is remembered as cloud so settings reopens into
  // the cloud picker. Resolution treats cloud exactly as remote
  // (cloud-auto-discovery Q3/Q6).
  mode: 'local' | 'remote' | 'cloud' | 'ssh'
  // The profile this config describes, or null for the global/default
  // connection. Per-profile entries let a profile point at its own backend.
  profile: null | string
  remoteAuthMode: 'oauth' | 'token'
  remoteOauthConnected: boolean
  remoteTokenPreview: string | null
  remoteTokenSet: boolean
  // Whether OS-keychain-backed encryption (Electron safeStorage) is currently
  // available on this machine. When false, a persisted remote token can only be
  // stored as plain text on disk (with an explicit opt-in).
  secureTokenStorage: boolean
  // Whether the currently-persisted remote token is stored with encoding
  // 'plain' (i.e. plain text on disk in connection.json), which happens when
  // the user opted in on a machine without secure storage.
  remoteTokenPlainText: boolean
  remoteUrl: string
  // For a 'cloud' connection: the persisted Hermes Cloud org (slug or id) the
  // connected instance was discovered under, so Settings → Gateway can reopen
  // into that org. Empty string for remote/local.
  cloudOrg: string
  sshHost: string
  sshUser: string
  sshPort: number | null
  sshKeyPath: string
  sshRemoteHermesPath: string
  sshRemoteProfile: string
}

export interface DesktopConnectionTestResult {
  baseUrl?: string
  ok?: boolean
  version?: string | null
  reachable?: boolean
  sshError?:
    | 'auth-failed'
    | 'hermes-not-found'
    | 'host-key-changed'
    | 'timeout'
    | 'unreachable'
    | 'unsupported-platform'
    | 'update-required'
    | 'unknown'
    | null
  error?: string | null
  host?: string
  remoteHermesPath?: string
  remoteHermesVersion?: string
  remotePlatform?: string
}

// A registered agent source as the renderer sees it: token bytes never cross
// the IPC boundary (preview + set flag instead, like DesktopConnectionConfig).
export interface DesktopRegistryConnection {
  id: string
  kind: DesktopConnectionKind
  // Required, registry-unique device name ("Homelab", "Work laptop").
  label: string
  url?: string
  authMode?: 'oauth' | 'token'
  org?: string
  host?: string
  user?: string
  port?: number
  keyPath?: string
  remoteHermesPath?: string
  remoteProfile?: string
  tokenSet: boolean
  tokenPreview: null | string
  // Names of the stored extra gateway headers (Cloudflare Access etc.);
  // header VALUES are secrets and never cross the IPC boundary. Optional so
  // fixtures/older payloads without the field remain valid.
  headerNames?: string[]
  // Last-known stable backend identity (the /api/status `install_id`).
  // Present once a roster enumeration or connection test has seen it; two
  // connections sharing it are one physical backend registered under two
  // addresses (display-only "Same backend as …" hint in Settings).
  installId?: string
}

export interface DesktopConnectionsRegistry {
  version: number
  // id of the connection that owns the window/primary backend.
  primary: string
  // Preserve old installs by defaulting to the explicit primary; users may
  // instead resume the last successfully opened source.
  launchMode?: 'last-used' | 'primary'
  // Last source the Sessions workspace opened successfully. Optional for
  // compatibility with an older Electron main during a rolling app update.
  lastUsed?: string
  // Whether OS-keychain-backed encryption (Electron safeStorage) is available;
  // false drives the plain-text token opt-in on keyring-less Linux.
  secureTokenStorage: boolean
  connections: DesktopRegistryConnection[]
}

// One agent in the union roster: a profile on a registered source, with the
// pre-computed @name-device handle for duplicate profile names.
export interface DesktopRosterAgent {
  connectionId: string
  connectionKind: DesktopConnectionKind
  connectionLabel: string
  profile: string
  targetProfile?: string
  handle: string
}

export interface DesktopAgentRoster {
  agents: DesktopRosterAgent[]
  sources: {
    connectionId: string
    label: string
    kind: DesktopConnectionKind
    reachable: boolean
    error?: string
    // Stable backend identity (/api/status install_id) when known.
    installId?: string
  }[]
}

// Per-connection result row from the update fan-out.
export interface DesktopConnectionUpdateResult {
  connectionId: string
  label: string
  kind: DesktopConnectionKind
  ok: boolean
  skipped?: boolean
  reason?: string
  detail?: string
  error?: string
}

export type DesktopManagedConnectionUpdateOutcome =
  'updated' | 'update-failed' | 'restore-failed' | 'update-and-restore-failed' | 'refused'

export interface DesktopManagedUpdateReceipt {
  correlationId: string
  // Additive receipt outcomes remain forward-compatible with newer updater
  // kernels instead of making an older renderer reject their proof.
  outcome: string
  startedAt?: string
  finishedAt?: string
  preSha?: string
  postSha?: string
  preVersion?: string
  postVersion?: string
  stopReason?: string
}

export interface DesktopManagedConnectionUpdateResult {
  connectionId: string
  correlationId: string
  ok: boolean
  updateOk: boolean
  restoreOk: boolean
  outcome: DesktopManagedConnectionUpdateOutcome
  exitCode: number | null
  receipt: DesktopManagedUpdateReceipt | null
  scopes: Array<{ profile: string; restored: boolean; error?: string }>
  error?: string
  message?: string
}

export interface DesktopSshResolveResult {
  hostname: string | null
  identityFile: string | null
  port: number | null
  user: string | null
}

export interface DesktopSshHostsResult {
  hosts: string[]
}

export interface DesktopAuthProvider {
  name: string
  displayName: string
  // True when this provider authenticates with a username + password
  // (the gateway's /login page renders a credential form) rather than an
  // OAuth redirect. The session/cookie/ws-ticket machinery is identical;
  // only the login-page form and the desktop's button copy differ.
  supportsPassword?: boolean
}

export interface DesktopConnectionProbeResult {
  baseUrl: string
  reachable: boolean
  authMode: 'oauth' | 'token' | 'unknown'
  providers: DesktopAuthProvider[]
  version: string | null
  error: string | null
}

export interface DesktopOauthLoginResult {
  ok: boolean
  baseUrl: string
  connected: boolean
}

export interface DesktopOauthLogoutResult {
  ok: boolean
  connected: boolean
}

// --- Hermes Cloud (cloud-auto-discovery Phase 3) ---

export interface DesktopCloudStatus {
  // The portal base URL the desktop talks to (default or env-overridden).
  portalBaseUrl: string
  // Whether the OAuth partition holds a live Nous portal (Privy) session — the
  // portal authenticates via Privy, so this reflects the privy-token cookie, NOT
  // the hermes gateway session cookies. See cookiesHavePrivySession.
  signedIn: boolean
}

// A discovered Hermes Cloud agent — the trimmed DTO from NAS GET /api/agents.
export interface DesktopCloudAgent {
  id: string
  name: string
  status: string
  // null until the agent has a provisioned dashboard (show "provisioning…").
  dashboardUrl: string | null
  // "active" | "degraded" | "down" | "unknown".
  dashboardGatewayState: string
}

// An org the signed-in user belongs to — for the org picker shown when a
// multi-org user's discovery call needs disambiguation (NAS 409).
export interface DesktopCloudOrg {
  id: string
  slug: string | null
  name: string
  isPersonal: boolean
  // "OWNER" | "MEMBER".
  role: string
}

// Discovery result: either the agent list, OR a request to pick an org first
// (multi-org user, no org chosen yet). The renderer shows a picker on the
// latter and re-calls discover(org). On the agents branch, `org` echoes the
// authoritatively-resolved org the list was scoped to (from NAS), so the
// desktop persists it without relying on transient picker state.
export type DesktopCloudDiscoverResult =
  | { agents: DesktopCloudAgent[]; org?: DesktopCloudOrg | null; needsOrgSelection?: false }
  | { needsOrgSelection: true; orgs: DesktopCloudOrg[] }

export interface DesktopCloudAgentSignInResult {
  // The agent gateway base URL the silent sign-in targeted.
  baseUrl: string
  // Whether the agent's gateway session cookie landed (silent cascade done).
  connected: boolean
}

export interface DesktopBootProgress {
  error: string | null
  fakeMode: boolean
  /** True when the boot failure is a Nous Cloud agent that is down (HTTP 502/503/504). */
  isCloudBackendDown?: boolean
  message: string
  phase: string
  progress: number
  /**
   * True when the boot failure carried by `error` was a TRANSIENT remote
   * failure (dropped SSH/HTTP registered connection, mint timeout) that the
   * renderer may retry automatically. Absent/false on success updates,
   * local failures, and confirmed reauth rejections.
   */
  retryable?: boolean
  running: boolean
  /** Structured HTTP status when the boot failure carried one (e.g. 503). */
  statusCode?: number | null
  timestamp: number
}

// First-launch install ("bootstrap") event types -- emitted by
// electron/bootstrap-runner.ts and observed by the renderer install overlay.
// Mirrors the event shapes emitted by runBootstrap()'s onEvent callback.

export interface DesktopBootstrapStageDescriptor {
  name: string
  title?: string
  category?: string
  needs_user_input?: boolean
}

export type DesktopBootstrapStageState = 'pending' | 'running' | 'succeeded' | 'skipped' | 'failed'

export interface DesktopBootstrapStageResult {
  state: DesktopBootstrapStageState
  durationMs: number | null
  startedAt: number | null
  json: { ok: boolean; skipped?: boolean; reason?: string | null; stage: string } | null
  error: string | null
}

export interface DesktopBootstrapUnsupportedPlatform {
  platform: string
  activeRoot: string
  installCommand: string
  docsUrl: string
}

export interface DesktopBootstrapSetupChoice {
  platform: string
  activeRoot: string
}

export interface DesktopBootstrapState {
  active: boolean
  manifest: {
    type: 'manifest'
    stages: DesktopBootstrapStageDescriptor[]
    protocolVersion: number | null
    /** K-RT2: this run replaces a previous release's agent runtime. */
    purpose?: 'runtime-upgrade'
  } | null
  stages: Record<string, DesktopBootstrapStageResult>
  error: string | null
  log: Array<{ ts: number; stage: string | null; line: string; stream?: 'stdout' | 'stderr' }>
  startedAt: number | null
  completedAt: number | null
  setupChoice: DesktopBootstrapSetupChoice | null
  unsupportedPlatform: DesktopBootstrapUnsupportedPlatform | null
}

export type DesktopBootstrapEvent =
  | { type: 'dismissed' }
  | {
      type: 'setup-choice'
      active: boolean
      platform?: string
      activeRoot?: string
    }
  | {
      type: 'manifest'
      stages: DesktopBootstrapStageDescriptor[]
      protocolVersion: number | null
      purpose?: 'runtime-upgrade'
    }
  | {
      type: 'stage'
      name: string
      state: DesktopBootstrapStageState
      durationMs?: number
      json?: DesktopBootstrapStageResult['json']
      error?: string | null
    }
  | { type: 'log'; stage?: string | null; line: string; stream?: 'stdout' | 'stderr' }
  | { type: 'complete'; marker: Record<string, unknown> }
  /** r2: main's watchdog heartbeat while an install stage runs (idleMs: time since the stage's last real progress). */
  | { type: 'stage-alive'; stage?: string | null; idleMs: number }
  | { type: 'failed'; stage?: string | null; error: string }
  | {
      type: 'unsupported-platform'
      platform: string
      activeRoot: string
      installCommand: string
      docsUrl: string
    }

export interface HermesPreviewTarget {
  binary?: boolean
  byteSize?: number
  kind: 'file' | 'url'
  label: string
  large?: boolean
  language?: string
  mimeType?: string
  path?: string
  previewKind?: 'binary' | 'html' | 'image' | 'pdf' | 'text'
  renderMode?: 'preview' | 'source'
  source: string
  url: string
}

export interface HermesReadFileTextResult {
  binary?: boolean
  byteSize?: number
  language?: string
  mimeType?: string
  path: string
  text: string
  truncated?: boolean
}

export interface HermesPreviewWatch {
  id: string
  path: string
}

// A real git worktree as reported by `git worktree list` (source of truth for
// the "Start work" flow), as opposed to the session-cwd-derived grouping above.
export interface HermesGitWorktree {
  path: string
  branch: null | string
  isMain: boolean
  detached: boolean
  locked: boolean
}

// A branch that the "convert a branch into a worktree" picker offers: the local
// heads, plus the remote-tracking refs that have no local branch yet.
// `checkedOut` means that a selection opens that checkout. `isDefault` means
// that a selection switches the main checkout, and does not make
// `.worktrees/main`. `isRemote` means that a selection first makes a local
// branch that tracks the remote one.
export interface HermesGitBranch {
  name: string
  checkedOut: boolean
  isDefault: boolean
  isRemote: boolean
  worktreePath: null | string
}

// A branch the new worktree can be based on: local heads + remote-tracking
// refs. `isRemote` distinguishes `origin/main` from a local `main` (the UI
// may show a remote glyph); `isDefault` flags origin/HEAD so the dialog can
// preselect it.
export interface HermesGitBaseBranch {
  name: string
  isRemote: boolean
  isDefault: boolean
}

// A single changed path from `git status --porcelain=v2`, classified by state
// so the coding rail / switcher can group + open the right diff.
export interface HermesRepoStatusFile {
  path: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
}

// Compact working-tree status for the composer coding rail (parsed from
// `git status --porcelain=v2 --branch`).
export interface HermesRepoStatus {
  branch: null | string
  // The repo's trunk ("main" / "master" / …), so the UI can offer "branch off
  // the default" from anywhere. Null when no trunk is detected.
  defaultBranch: null | string
  detached: boolean
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  // Total distinct changed paths (tracked modified + conflicts + untracked).
  changed: number
  // +/- line counts of tracked changes vs HEAD (staged + unstaged). Untracked
  // files aren't in the diff, so they don't contribute lines.
  added: number
  removed: number
  // Capped changed-file list (REPO_STATUS_FILE_CAP) for the diff/open actions.
  files: HermesRepoStatusFile[]
}

// One changed file in the review pane (status letter, +/- lines, staged flag).
export interface HermesReviewFile {
  path: string
  added: number
  removed: number
  // M(odified) A(dded) D(eleted) R(enamed) C(opied) U(nmerged) ?(untracked)
  status: string
  staged: boolean
}

export interface HermesReviewList {
  files: HermesReviewFile[]
  // The resolved base ref the scope diffed against (branch merge-base / turn
  // baseline), or null for the uncommitted scope.
  base: null | string
}

// The branch's PR (if any) as reported by `gh pr view`.
export interface HermesReviewPr {
  url: string
  state: string
  number: number
}

// One repo's PRs as reported by `gh pr list`, each tied to the branch it was
// opened from — how a session row finds its own PR.
export interface HermesBranchPullRequest {
  branch: string
  draft: boolean
  number: number
  /** `open` | `closed` | `merged`, lowercased from gh. */
  state: string
  title: string
  url: string
}

export interface HermesRepoPullRequests {
  ghReady: boolean
  prs: HermesBranchPullRequest[]
}

// A PR review/issue comment resolved from a pasted GitHub URL — the composer's
// review-comment attachment context. `path`/`line`/`diffHunk` are empty for
// conversation-tab (issue) comments; `line` is null when the comment is
// outdated and only `original_line` remained.
export interface HermesPrComment {
  author: string
  body: string
  diffHunk: string
  kind: 'issue' | 'review'
  line: null | number
  path: string
  prNumber: number
  startLine: null | number
  url: string
}
// gh availability/auth + the current branch's PR — drives the review pane's PR
// button (disabled when gh isn't ready, "Open PR" vs "Create PR" otherwise).
export interface HermesReviewShipInfo {
  ghReady: boolean
  pr: HermesReviewPr | null
}

export interface HermesReadDirEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface HermesReadDirResult {
  entries: HermesReadDirEntry[]
  error?: string
}

export interface HermesPreviewFileChanged {
  id: string
  path: string
  url: string
}

export interface BackendExit {
  code: number | null
  signal: string | null
}
