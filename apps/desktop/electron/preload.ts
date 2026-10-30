import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'

import type {
  DesktopConnectionConfigInput,
  DesktopRegistryConnectionInput,
  DesktopUninstallMode,
  DesktopUpdateApplyOptions,
  HermesActiveWork,
  HermesApiRequest,
  HermesNotification,
  HermesReviewScope,
  HermesSelectPathsOptions,
  HermesTitleBarTheme
} from '../src/iclone-shared/bridge-contract'

import { createConfirmTracker } from './agent-update-confirm'
import { installExternalLinkRouter } from './external-link-router'
import { createPaymentsBridge } from './iclone-x402/preload-api'

type IpcEvent = Electron.IpcRendererEvent

// Which translucency the OS can back. Asked synchronously because the renderer
// needs it before its first paint, and answered by main because deciding it
// needs `os.release()` — a sandboxed preload may only require electron, events,
// timers and url, so importing node:os here throws before contextBridge runs
// and takes the ENTIRE bridge down with it (window.hermesDesktop undefined =>
// "Desktop IPC bridge is unavailable"). No reply means no glass, which degrades
// to an ordinary opaque window rather than a page thinned over nothing.
const translucencySupport = ipcRenderer.sendSync('hermes:translucency:support')
const hudWindowing = ipcRenderer.sendSync('hermes:hud:windowing')
const hudNativeDrag = hudWindowing?.nativeDrag === true

// U1 second lock: capture-phase listeners in this isolated world see `isTrusted` before any page handler runs.
const agentUpdateConfirm = createConfirmTracker({
  isConfirmTarget: target => target instanceof Element && target.closest('[data-agent-update-confirm]') !== null
})

// V3-F: the same lock for the permission mode controls and the consent door's answer buttons.
const permModeConfirm = createConfirmTracker({
  isConfirmTarget: target => target instanceof Element && target.closest('[data-perm-mode-confirm]') !== null
})

const doorAnswerConfirm = createConfirmTracker({
  isConfirmTarget: target => target instanceof Element && target.closest('[data-consent-door-answer]') !== null
})

// V3-I: the same lock for the WORK tab's owner decisions (level, go online, approve, decline).
const acpWorkConfirm = createConfirmTracker({
  isConfirmTarget: target => target instanceof Element && target.closest('[data-acp-work-confirm]') !== null
})

// REL-6: the same lock for installing the ACP tools (an `I` action under V3-F: the owner's own click only).
const acpToolsConfirm = createConfirmTracker({
  isConfirmTarget: target => target instanceof Element && target.closest('[data-acp-tools-confirm]') !== null
})

// V3-G: the same lock for acknowledging a hard link in the Containers pane.
const confinementConfirm = createConfirmTracker({
  isConfirmTarget: target => target instanceof Element && target.closest('[data-confinement-confirm]') !== null
})

// V3-J: the same lock for Settings › Economy › Payments (a settings change, a revoke, clearing the stop).
const paymentsConfirm = createConfirmTracker({
  isConfirmTarget: target => target instanceof Element && target.closest('[data-payments-confirm]') !== null
})

const userGesture = (tracker: ReturnType<typeof createConfirmTracker>) => ({
  activation: navigator.userActivation?.isActive === true,
  confirm: tracker.take()
})

for (const type of ['click', 'keydown']) {
  window.addEventListener(
    type,
    event => {
      const observed = {
        isTrusted: event.isTrusted,
        key: event instanceof KeyboardEvent ? event.key : undefined,
        target: event.target,
        type: event.type
      }

      agentUpdateConfirm.observe(observed)
      permModeConfirm.observe(observed)
      doorAnswerConfirm.observe(observed)
      acpWorkConfirm.observe(observed)
      confinementConfirm.observe(observed)
      paymentsConfirm.observe(observed)
    },
    { capture: true }
  )
}

// X1b/X1c: a real click on a link that leaves the app (a new window, or this one: target=_blank, ⌘/Ctrl/⇧- or
// middle-click, a plain click) opens it in the system browser. This is the only way there for a link: every app
// window denies window requests (app-window-open-policy.ts) and main-frame navigations away from the app
// (app-navigation-policy.ts), because neither can tell a real click from a script or the app from an artifact.
installExternalLinkRouter(
  window,
  url => {
    ipcRenderer.invoke('hermes:openExternal', url).catch(() => undefined)
  },
  () => window.location.href
)

// R4-F1: the pop-out pet (`?win=pet`) draws at zoom 1 — whole device pixels per tile — whatever the app's UI zoom
// (90 % by default). Chromium zoom is per origin, so the overlay would inherit it; set from the frame itself, the zoom
// is this frame's own (temporary): it neither follows nor changes the app windows' zoom.
try {
  if (new URLSearchParams(window.location.search).get('win') === 'pet') {
    webFrame.setZoomFactor(1)
  }
} catch {
  // Best effort: a pet drawn at the app's zoom is still a pet.
}

contextBridge.exposeInMainWorld('hermesDesktop', {
  glassSupported: translucencySupport?.glass === true,
  translucencySupported: translucencySupport?.translucency === true,
  getConnection: (profile?: string | null) => ipcRenderer.invoke('hermes:connection', profile),
  // Registry-scoped backend resolution: { connectionId, profile } → descriptor.
  getConnectionFor: (payload: { connectionId?: null | string; profile?: null | string }) =>
    ipcRenderer.invoke('hermes:connection:for', payload),
  getProfileRoutes: (profiles: string[]) => ipcRenderer.invoke('hermes:plugin-profile-routes', profiles),
  revalidateConnection: () => ipcRenderer.invoke('hermes:connection:revalidate'),
  touchBackend: (profile?: string | null) => ipcRenderer.invoke('hermes:backend:touch', profile),
  // Respawn the desktop backend so it re-reads once-per-process config
  // (browser.headed). Interrupts a turn in flight — ask before calling.
  restartBackend: () => ipcRenderer.invoke('hermes:backend:restart'),
  getGatewayWsUrl: (profile?: null | string) => ipcRenderer.invoke('hermes:gateway:ws-url', profile),
  // Registry-scoped fresh WS URL: { connectionId, profile } → result shape of
  // getGatewayWsUrl, minted against that connection's backend.
  getGatewayWsUrlFor: (payload: { connectionId?: null | string; profile?: null | string }) =>
    ipcRenderer.invoke('hermes:gateway:ws-url-for', payload),
  // Union agent roster across every registered connection.
  getAgentRoster: () => ipcRenderer.invoke('hermes:agents:roster'),
  openSessionWindow: (sessionId: string, opts?: { watch?: boolean }) =>
    ipcRenderer.invoke('hermes:window:openSession', sessionId, opts),
  openSessionInTerminal: (sessionId: string, opts?: { cwd?: string; profile?: string }) =>
    ipcRenderer.invoke('hermes:window:openInTerminal', sessionId, opts),
  openWindow: () => ipcRenderer.invoke('hermes:window:openInstance'),
  openBrowserWindow: (tabId: string) => ipcRenderer.invoke('hermes:window:openBrowser', tabId),
  onBrowserPopoutClosed: (callback: (tabId: string) => void) => {
    const listener = (_event: IpcEvent, tabId: string) => callback(tabId)
    ipcRenderer.on('hermes:browser-popout:closed', listener)

    return () => ipcRenderer.removeListener('hermes:browser-popout:closed', listener)
  },
  claimAmbientCue: (key: string) => ipcRenderer.invoke('hermes:ambient:claim', key),
  wakeIndicator: {
    getState: () => ipcRenderer.invoke('hermes:wake-indicator:get'),
    setState: (state: unknown) => ipcRenderer.send('hermes:wake-indicator:set', state),
    onState: (callback: (state: unknown) => void) => {
      const listener = (_event: IpcEvent, state: unknown) => callback(state)
      ipcRenderer.on('hermes:wake-indicator:state', listener)

      return () => ipcRenderer.removeListener('hermes:wake-indicator:state', listener)
    }
  },
  // iCLONE OS — multi-chain native-coin balances. See
  // electron/iclone-balances.ts for the main-process side of this bridge.
  icloneBalances: {
    fetch: (address: string, solAddress?: string) => ipcRenderer.invoke('iclone:balances', address, solAddress)
  },
  // iCLONE OS — on-chain 3D model fetch for the iNFT Stage.
  icloneModel: {
    fetch: (url: string) => ipcRenderer.invoke('iclone:fetch-model', url)
  },
  // iCLONE OS — first-launch policy acceptance + permission intents (electron/iclone-consent.ts).
  icloneConsent: {
    get: () => ipcRenderer.invoke('iclone:consent:get'),
    policyText: () => ipcRenderer.invoke('iclone:consent:policy-text'),
    accept: (input: { aiProvider?: boolean; version: string }) => ipcRenderer.invoke('iclone:consent:accept', input),
    setPermissions: (input: unknown) => ipcRenderer.invoke('iclone:consent:permissions', input),
    setAiProvider: (input: { accepted: boolean }) => ipcRenderer.invoke('iclone:consent:ai-provider', input),
    // V3-ON: the Set up step's per-section decisions (done / skipped), stored in the same consent.json.
    setSetup: (input: { sections: Record<string, string> }) => ipcRenderer.invoke('iclone:consent:setup', input),
    openPolicy: () => ipcRenderer.invoke('iclone:consent:open-policy'),
    quit: () => ipcRenderer.invoke('iclone:consent:quit'),
    doorCurrent: () => ipcRenderer.invoke('iclone:consent:door-current'),
    // Call synchronously inside the answer button's own click/key handler (it carries data-consent-door-answer).
    doorAnswer: (input: Record<string, unknown>) =>
      ipcRenderer.invoke('iclone:consent:door-answer', { ...input, gesture: userGesture(doorAnswerConfirm) }),
    requests: () => ipcRenderer.invoke('iclone:consent:requests'),
    onDoor: (callback: (request: unknown) => void) => {
      const listener = (_event: IpcEvent, request: unknown) => callback(request)

      ipcRenderer.on('iclone:consent:door', listener)

      return () => ipcRenderer.removeListener('iclone:consent:door', listener)
    },
    // V3-F — the permission modes (electron/iclone-permissions/ipc.ts). setMode and revoke count only when called
    // synchronously inside the handler of a control carrying data-perm-mode-confirm.
    permissions: {
      setMode: (input: Record<string, unknown>) =>
        ipcRenderer.invoke('iclone:permissions:set-mode', { ...input, gesture: userGesture(permModeConfirm) }),
      revoke: (id: string) =>
        ipcRenderer.invoke('iclone:permissions:revoke', { id, gesture: userGesture(permModeConfirm) }),
      // V3-F2: a function's level. Same lock as setMode; a raise also needs main's native old → new confirm.
      setFunctionLevel: (input: Record<string, unknown>) =>
        ipcRenderer.invoke('iclone:permissions:set-function-level', {
          ...input,
          gesture: userGesture(permModeConfirm)
        }),
      hermesApproval: (input: Record<string, unknown>) =>
        ipcRenderer.invoke('iclone:permissions:hermes-approval', input),
      state: (dir?: string | null) => ipcRenderer.invoke('iclone:permissions:state', { dir: dir ?? null }),
      tail: (since: number) => ipcRenderer.invoke('iclone:permissions:tail', { since }),
      onChanged: (callback: (seq: unknown) => void) => {
        const listener = (_event: IpcEvent, seq: unknown) => callback(seq)

        ipcRenderer.on('iclone:permissions:changed', listener)

        return () => ipcRenderer.removeListener('iclone:permissions:changed', listener)
      }
    }
  },
  // V3-ON — the Set up step (electron/iclone-setup.ts): system permission status + the ONE action main picks per item.
  icloneSetup: {
    system: () => ipcRenderer.invoke('iclone:setup:system'),
    act: (input: { item: string; title?: string; body?: string }) =>
      ipcRenderer.invoke('iclone:setup:system-act', input)
  },
  // V3-J — payments (electron/iclone-x402/): views only, never a key, a signature or a raw mandate; no sign/pay/issue.
  payments: createPaymentsBridge(
    (channel, payload) => ipcRenderer.invoke(channel, payload),
    () => userGesture(paymentsConfirm),
    (channel, listener) => {
      const wrapped = () => listener()

      ipcRenderer.on(channel, wrapped)

      return () => ipcRenderer.removeListener(channel, wrapped)
    },
    () => document.documentElement.lang
  ),
  // iCLONE OS — V3-G confinement (electron/iclone-confinement/ipc.ts): read-only state, and Kill for confined pids only.
  icloneConfinement: {
    state: () => ipcRenderer.invoke('iclone:confinement:state'),
    kill: (pid: number) => ipcRenderer.invoke('iclone:confinement:kill', { pid }),
    explain: (pid: number) => ipcRenderer.invoke('iclone:confinement:explain', { pid }),
    // Call synchronously inside the handler of a control carrying data-confinement-confirm.
    ackHardlink: (input: { root: string; dir: string; digest: string }) =>
      ipcRenderer.invoke('iclone:confinement:ack-hardlink', { ...input, gesture: userGesture(confinementConfirm) }),
    onChanged: (callback: () => void) => {
      const listener = () => callback()

      ipcRenderer.on('iclone:confinement:changed', listener)

      return () => ipcRenderer.removeListener('iclone:confinement:changed', listener)
    }
  },
  // iCLONE OS — local self-diagnostics (electron/iclone-doctor-main.ts).
  icloneDoctor: {
    list: () => ipcRenderer.invoke('iclone:doctor:list'),
    run: (options?: { packs?: string[]; live?: boolean }) => ipcRenderer.invoke('iclone:doctor:run', options ?? {}),
    fix: (input: { fixId: string; dryRun: boolean }) => ipcRenderer.invoke('iclone:doctor:fix', input),
    report: () => ipcRenderer.invoke('iclone:doctor:report'),
    openLogs: () => ipcRenderer.invoke('iclone:doctor:open-logs'),
    // FX-7: the diagnostics report as a file the owner chooses (nothing is uploaded).
    diagnosticsPreview: (input: { errorContext?: string }) => ipcRenderer.invoke('iclone:diagnostics:preview', input),
    diagnosticsSave: (input: { errorContext?: string }) => ipcRenderer.invoke('iclone:diagnostics:save', input),
    onProgress: (callback: (progress: unknown) => void) => {
      const listener = (_event: IpcEvent, progress: unknown) => callback(progress)

      ipcRenderer.on('iclone:doctor:progress', listener)

      return () => ipcRenderer.removeListener('iclone:doctor:progress', listener)
    }
  },
  // iCLONE OS — App Atualisation: Track B (fork vs upstream) and Track A
  // (the Hermes runtime beneath the app). See electron/iclone-updates.ts.
  icloneUpdates: {
    check: (options?: { cacheOnly?: boolean; force?: boolean }) =>
      ipcRenderer.invoke('iclone:upstream-check', {
        cacheOnly: options?.cacheOnly === true,
        force: options?.force === true
      }),
    runtime: () => ipcRenderer.invoke('iclone:runtime-status'),
    // The compat engine (electron/iclone-compat.ts). The owner's hold is timed in main: `ack` only begins or ends it.
    compat: {
      status: () => ipcRenderer.invoke('iclone:compat:status'),
      preview: (target?: string) => ipcRenderer.invoke('iclone:compat:preview', { target }),
      probe: () => ipcRenderer.invoke('iclone:compat:probe'),
      ack: (request: unknown) => ipcRenderer.invoke('iclone:compat:ack', request),
      backlog: (options?: { refresh?: boolean }) =>
        ipcRenderer.invoke('iclone:compat:backlog', { refresh: options?.refresh === true }),
      decide: (decision: unknown) => ipcRenderer.invoke('iclone:compat:decide', decision),
      summarise: (subjects: string[]) => ipcRenderer.invoke('iclone:compat:summarise', { subjects }),
      onVerdict: (callback: (payload: unknown) => void) => {
        const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
        ipcRenderer.on('iclone:compat:verdict', listener)

        return () => {
          ipcRenderer.removeListener('iclone:compat:verdict', listener)
        }
      },
      // U1: a RED verdict of the running runtime is a passive flag (pane banner + nav dot), never an OS notification.
      flag: () => ipcRenderer.invoke('iclone:compat:flag'),
      onFlag: (callback: (flag: unknown) => void) => {
        const listener = (_event: IpcEvent, flag: unknown) => callback(flag)
        ipcRenderer.on('iclone:compat:flag', listener)

        return () => {
          ipcRenderer.removeListener('iclone:compat:flag', listener)
        }
      }
    }
  },
  // iCLONE OS — the `it` CLI command plane. See electron/iclone-it.ts.
  icloneIt: {
    onCmd: (callback: (payload: { id: number; argv: string[] }) => void) => {
      const listener = (_event: IpcEvent, payload: Parameters<typeof callback>[0]) => callback(payload)
      ipcRenderer.on('iclone:it-cmd', listener)

      return () => ipcRenderer.removeListener('iclone:it-cmd', listener)
    },
    reply: (id: number, output: string) => ipcRenderer.send('iclone:it-reply', { id, output })
  },
  // iCLONE OS — V3-D the pane bus: pane state, attention signals, spawn plans,
  // sidebar probes and tmux sessions. See electron/iclone-pane-bus/ipc.ts.
  paneBus: {
    snapshot: () => ipcRenderer.invoke('iclone:pane-bus:snapshot'),
    signal: (paneId: string, text: string, source: string) =>
      ipcRenderer.invoke('iclone:pane-bus:signal', paneId, text, source),
    clear: (paneId: string) => ipcRenderer.invoke('iclone:pane-bus:clear', paneId),
    plan: (file: string) => ipcRenderer.invoke('iclone:pane-bus:plan', file),
    probe: (panes: { paneId: string; cwd: null | string }[]) => ipcRenderer.invoke('iclone:pane-bus:probe', panes),
    tmuxList: () => ipcRenderer.invoke('iclone:pane-bus:tmux-list'),
    tmuxEnd: (session: string) => ipcRenderer.invoke('iclone:pane-bus:tmux-end', session),
    onChange: (callback: (pane: unknown) => void) => {
      const listener = (_event: IpcEvent, pane: unknown) => callback(pane)
      ipcRenderer.on('iclone:pane-bus:change', listener)

      return () => ipcRenderer.removeListener('iclone:pane-bus:change', listener)
    }
  },
  // iCLONE OS — Virtuals ACP CLI per-iNFT setup wizard. See
  // electron/iclone-acp.ts for the allowlist and isolation rules.
  icloneAcp: {
    check: () => ipcRenderer.invoke('iclone:acp-check'),
    // The owner's own AgentCard account (agentcard CLI), read-only: one of four states, never its output.
    agentcardStatus: () => ipcRenderer.invoke('iclone:agentcard-status'),
    run: (inftId: string, argv: string[], timeoutMs?: number) =>
      ipcRenderer.invoke('iclone:acp-run', inftId, argv, timeoutMs),
    status: (inftId: string, opts?: unknown) => ipcRenderer.invoke('iclone:acp-status', inftId, opts),
    // Per-iNFT notes + card-signup state (main validates the key and redacts on write).
    kvGet: (inftId: string, key: unknown) => ipcRenderer.invoke('iclone:inft-kv-get', inftId, key),
    kvSet: (inftId: string, key: unknown, value: Record<string, unknown>) =>
      ipcRenderer.invoke('iclone:inft-kv-set', inftId, key, value),
    kvDelete: (inftId: string, key: unknown) => ipcRenderer.invoke('iclone:inft-kv-delete', inftId, key),
    // The owner's Email marks, mirrored to <userData>/inft/<slug>/email-state.json (main validates).
    emailState: {
      load: (slug: string) => ipcRenderer.invoke('iclone:email-state', 'get', slug),
      save: (slug: string, value: Record<string, unknown>) =>
        ipcRenderer.invoke('iclone:email-state', 'set', slug, value)
    },
    detach: (inftId: string) => ipcRenderer.invoke('iclone:acp-detach', inftId),
    configMap: () => ipcRenderer.invoke('iclone:acp-config-map'),
    // REL-6: counts only when called synchronously inside the handler of a control carrying data-acp-tools-confirm.
    install: () => ipcRenderer.invoke('iclone:acp-install', { gesture: userGesture(acpToolsConfirm) }),
    updateCheck: () => ipcRenderer.invoke('iclone:acp-update-check'),
    // The iNFT on the stage, for the agent's `acp` without --inft.
    setStage: (slug: string | null) => ipcRenderer.invoke('iclone:acp-stage', slug),
    // The market window's job stream: one listener per window, removed on dispose.
    watch: (slug: string | null) => ipcRenderer.invoke('iclone:acp-watch', slug),
    onEvent: (callback: (payload: unknown) => void) => {
      const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
      ipcRenderer.on('iclone:acp-event', listener)

      return () => {
        ipcRenderer.removeListener('iclone:acp-event', listener)
      }
    }
  },
  // REL-6 — the ACP tools installer (electron/iclone-acp-tools/). `install` counts only when called synchronously inside
  // the handler of a control carrying data-acp-tools-confirm; cancel and the reads never need a gesture.
  icloneAcpTools: {
    state: () => ipcRenderer.invoke('iclone:acp-tools:state'),
    check: () => ipcRenderer.invoke('iclone:acp-tools:check'),
    install: () => ipcRenderer.invoke('iclone:acp-tools:install', { gesture: userGesture(acpToolsConfirm) }),
    cancel: () => ipcRenderer.invoke('iclone:acp-tools:cancel'),
    openNotices: (which: 'app' | 'installed') => ipcRenderer.invoke('iclone:acp-tools:open-notices', { which }),
    onChanged: (callback: (view: unknown) => void) => {
      const listener = (_event: IpcEvent, view: unknown) => callback(view)

      ipcRenderer.on('iclone:acp-tools:changed', listener)

      return () => ipcRenderer.removeListener('iclone:acp-tools:changed', listener)
    }
  },
  // V3-I — ACP WORK (electron/iclone-acp-work/ipc.ts). setLevel, online, repair, approve and decline count only when
  // called synchronously inside the handler of a control carrying data-acp-work-confirm; offline and reboot never do.
  icloneAcpWork: {
    state: (slug: string) => ipcRenderer.invoke('iclone:acp-work:state', { slug }),
    refresh: (slug: string) => ipcRenderer.invoke('iclone:acp-work:refresh', { slug }),
    setLevel: (slug: string, level: string) =>
      ipcRenderer.invoke('iclone:acp-work:set-level', { slug, level, gesture: userGesture(acpWorkConfirm) }),
    online: (slug: string) =>
      ipcRenderer.invoke('iclone:acp-work:online', { slug, gesture: userGesture(acpWorkConfirm) }),
    offline: (slug: string) => ipcRenderer.invoke('iclone:acp-work:offline', { slug }),
    reboot: (slug: string) => ipcRenderer.invoke('iclone:acp-work:reboot', { slug }),
    repair: (slug: string) =>
      ipcRenderer.invoke('iclone:acp-work:repair', { slug, gesture: userGesture(acpWorkConfirm) }),
    approve: (slug: string, jobId: string) =>
      ipcRenderer.invoke('iclone:acp-work:approve', { slug, jobId, gesture: userGesture(acpWorkConfirm) }),
    decline: (slug: string, jobId: string) =>
      ipcRenderer.invoke('iclone:acp-work:decline', { slug, jobId, gesture: userGesture(acpWorkConfirm) }),
    onChanged: (callback: (slug: unknown) => void) => {
      const listener = (_event: IpcEvent, slug: unknown) => callback(slug)

      ipcRenderer.on('iclone:acp-work:changed', listener)

      return () => ipcRenderer.removeListener('iclone:acp-work:changed', listener)
    }
  },
  // iCLONE OS — the app teaches its agent (bundled Hermes skills → every
  // skills tree). See electron/iclone-skills.ts.
  icloneSkills: {
    sync: () => ipcRenderer.invoke('iclone:skills-sync'),
    last: () => ipcRenderer.invoke('iclone:skills-last'),
    catalog: () => ipcRenderer.invoke('iclone:skills-catalog')
  },
  // iCLONE OS — Claude Code as an optional engine (the user's own CLI and
  // subscription). See electron/iclone-claude-code.ts.
  icloneClaudeCode: {
    status: (refresh?: boolean) => ipcRenderer.invoke('iclone:claude-code-status', refresh === true),
    fallbackState: () => ipcRenderer.invoke('iclone:claude-code-fallback-state'),
    setFallback: (target: { baseUrl?: string; model: string; provider: string }) =>
      ipcRenderer.invoke('iclone:claude-code-fallback', target)
  },
  // iCLONE OS — Privy wallet login + iNFT wallet scan. See
  // electron/iclone-privy.ts for the main-process side of this bridge.
  iclonePrivy: {
    open: () => ipcRenderer.invoke('iclone:privy-open'),
    logout: () => ipcRenderer.invoke('iclone:privy-logout'),
    status: () => ipcRenderer.invoke('iclone:privy-status'),
    scan: (address: string) => ipcRenderer.invoke('iclone:inft-scan', address),
    scanTick: (address: string, checkedIds: string[]) =>
      ipcRenderer.invoke('iclone:inft-scan-tick', address, checkedIds),
    bookScan: (address: string, cursor: unknown) => ipcRenderer.invoke('iclone:inft-book-scan', address, cursor),
    resolveProfile: (item: unknown) => ipcRenderer.invoke('iclone:inft-profile-resolve', item),
    onSession: (callback: (session: unknown) => void) => {
      const listener = (_event: IpcEvent, session: unknown) => callback(session)
      ipcRenderer.on('iclone:privy-session', listener)

      return () => ipcRenderer.removeListener('iclone:privy-session', listener)
    }
  },
  // iCLONE OS — ownership guard (R9). See electron/iclone-ownership.ts.
  icloneOwnership: {
    observe: (wallet: string, items: unknown) => ipcRenderer.invoke('iclone:ownership-observe', wallet, items),
    list: () => ipcRenderer.invoke('iclone:ownership-list'),
    recheck: (slug: string) => ipcRenderer.invoke('iclone:ownership-recheck', slug),
    choose: (slug: string, choice: string, confirm: string) =>
      ipcRenderer.invoke('iclone:ownership-choose', slug, choice, confirm),
    prepareSell: (slug: string, github: boolean) => ipcRenderer.invoke('iclone:ownership-prepare-sell', slug, github),
    presaleDetached: (slug: string, removed: number) =>
      ipcRenderer.invoke('iclone:ownership-presale-detached', slug, removed),
    promptHeaderWritten: (profileSlug: string) => ipcRenderer.invoke('iclone:ownership-prompt-header', profileSlug),
    ghStatus: () => ipcRenderer.invoke('iclone:ownership-gh-status'),
    registry: () => ipcRenderer.invoke('iclone:ownership-registry'),
    onChanged: (callback: (view: unknown) => void) => {
      const listener = (_event: IpcEvent, view: unknown) => callback(view)
      ipcRenderer.on('iclone:ownership-changed', listener)

      return () => ipcRenderer.removeListener('iclone:ownership-changed', listener)
    }
  },
  // V3-P: the pop-out pet. Main renderer → open/close/push state; the overlay → control/bounds/click-through.
  // Every channel is guarded in main (pet-overlay.ts): the app's own renderer only, each side its own channels.
  petOverlay: {
    open: (request: unknown) => ipcRenderer.invoke('hermes:pet-overlay:open', request),
    close: () => ipcRenderer.invoke('hermes:pet-overlay:close'),
    setBounds: (bounds: unknown) => ipcRenderer.send('hermes:pet-overlay:set-bounds', bounds),
    setIgnoreMouse: (ignore: boolean) => ipcRenderer.send('hermes:pet-overlay:ignore-mouse', ignore === true),
    setFocusable: (focusable: boolean) => ipcRenderer.send('hermes:pet-overlay:set-focusable', focusable === true),
    pushState: (payload: unknown) => ipcRenderer.send('hermes:pet-overlay:state', payload),
    control: (payload: unknown) => ipcRenderer.send('hermes:pet-overlay:control', payload),
    sendPromptResult: (result: unknown) => ipcRenderer.send('hermes:pet-overlay:prompt-result', result),
    promptHandoff: (id: unknown) => ipcRenderer.invoke('hermes:pet-overlay:prompt-handoff', id),
    onPromptResult: (callback: (result: unknown) => void) => {
      const listener = (_event: IpcEvent, result: unknown) => callback(result)
      ipcRenderer.on('hermes:pet-overlay:prompt-result', listener)

      return () => ipcRenderer.removeListener('hermes:pet-overlay:prompt-result', listener)
    },
    onState: (callback: (payload: unknown) => void) => {
      const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
      ipcRenderer.on('hermes:pet-overlay:state', listener)

      return () => ipcRenderer.removeListener('hermes:pet-overlay:state', listener)
    },
    onControl: (callback: (payload: unknown) => void) => {
      const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
      ipcRenderer.on('hermes:pet-overlay:control', listener)

      return () => ipcRenderer.removeListener('hermes:pet-overlay:control', listener)
    }
  },
  // HUD mode: the chrome-free floating chat. A full app renderer (own gateway)
  // sized as a floating bar, so it mounts the real composer. Main owns the
  // window; `onChanged` keeps every window's toggle truthful.
  hud: {
    nativeDrag: hudNativeDrag,
    windowing: {
      clientPlacement: hudWindowing?.clientPlacement !== false,
      controlDrag: hudWindowing?.controlDrag === true,
      nativeDrag: hudNativeDrag,
      workspaceTransfer: hudWindowing?.workspaceTransfer === true
    },
    open: (request?: { sessionId?: null | string; profile?: null | string }) =>
      ipcRenderer.invoke('hermes:hud:open', request),
    close: () => ipcRenderer.invoke('hermes:hud:close'),
    setIgnoreMouse: (ignore: boolean) => ipcRenderer.send('hermes:hud:ignore-mouse', ignore),
    moveBy: (delta: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.send('hermes:hud:move-by', delta),
    setWorkspaceTransfer: (transferring: boolean) => ipcRenderer.send('hermes:hud:workspace-transfer', transferring),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.send('hermes:hud:set-bounds', bounds),
    resetLayout: () => ipcRenderer.invoke('hermes:hud:reset-layout'),
    // Whether the band covers the window below the bar. Main pairs it with the
    // user's translucency setting to decide the native frost (macOS vibrancy /
    // Windows 11 DWM backdrop) — see hudFrostFor.
    setFrost: (showing: boolean) => ipcRenderer.invoke('hermes:hud:frost', showing),
    // The HUD tells main which session it is on; main hands that back to the
    // app window when the HUD closes, so the app can re-home onto it.
    setSession: (sessionId: null | string) => ipcRenderer.send('hermes:hud:session', sessionId),
    onGoto: (callback: (sessionId: string) => void) => {
      const listener = (_event: IpcEvent, sessionId: string) => callback(sessionId)
      ipcRenderer.on('hermes:hud:goto', listener)

      return () => ipcRenderer.removeListener('hermes:hud:goto', listener)
    },
    onChanged: (callback: (state: { open: boolean; sessionId: null | string }) => void) => {
      const listener = (_event: IpcEvent, state: Parameters<typeof callback>[0]) => callback(state)
      ipcRenderer.on('hermes:hud:changed', listener)

      return () => ipcRenderer.removeListener('hermes:hud:changed', listener)
    },
    // Linux only, and silent elsewhere: where the cursor is, in page
    // coordinates, or null when it has left the window. Stands in for the
    // mousemove that `setIgnoreMouseEvents(true, { forward: true })` delivers on
    // macOS and Windows but not here.
    onCursor: (callback: (point: { x: number; y: number } | null) => void) => {
      const listener = (_event: IpcEvent, point: Parameters<typeof callback>[0]) => callback(point)
      ipcRenderer.on('hermes:hud:cursor', listener)

      return () => ipcRenderer.removeListener('hermes:hud:cursor', listener)
    },
    // Main's game-overlay watch: whether a fullscreen app (a game) is under
    // the HUD, so the renderer can step back to the low-opacity overlay
    // treatment while one owns the screen.
    onGameOverlay: (callback: (state: { active: boolean; app: string }) => void) => {
      const listener = (_event: IpcEvent, state: Parameters<typeof callback>[0]) => callback(state)
      ipcRenderer.on('hermes:hud:game-overlay', listener)

      return () => ipcRenderer.removeListener('hermes:hud:game-overlay', listener)
    }
  },
  // Quick Entry: the global-hotkey mini composer window. Main owns the OS
  // shortcut + the persisted preference; the quick window only captures text
  // and hands it back, and the primary renderer submits it through the normal
  // prompt path.
  quickEntry: {
    getSettings: () => ipcRenderer.invoke('hermes:quick-entry:settings:get'),
    setSettings: (patch: { enabled?: boolean; shortcut?: string }) =>
      ipcRenderer.invoke('hermes:quick-entry:settings:set', patch),
    submit: (payload: unknown) => ipcRenderer.send('hermes:quick-entry:submit', payload),
    dismiss: () => ipcRenderer.send('hermes:quick-entry:dismiss'),
    // Primary renderer → main → quick window: gateway connection state + the
    // recent-session options the target picker offers. Main caches the latest
    // payload so a freshly spawned quick window starts from truth.
    pushState: (payload: unknown) => ipcRenderer.send('hermes:quick-entry:state', payload),
    // Quick window subscribes to those pushes.
    onState: (callback: (payload: unknown) => void) => {
      const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
      ipcRenderer.on('hermes:quick-entry:state', listener)

      return () => ipcRenderer.removeListener('hermes:quick-entry:state', listener)
    },
    // Main → primary renderer: a submit captured by the quick window.
    onSubmit: (callback: (payload: unknown) => void) => {
      const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
      ipcRenderer.on('hermes:quick-entry:submit', listener)

      return () => ipcRenderer.removeListener('hermes:quick-entry:submit', listener)
    },
    // Main → quick window: you were just summoned (reset draft + refocus).
    onShown: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('hermes:quick-entry:shown', listener)

      return () => ipcRenderer.removeListener('hermes:quick-entry:shown', listener)
    }
  },
  getBootProgress: () => ipcRenderer.invoke('hermes:boot-progress:get'),
  getConnectionConfig: (profile?: null | string) => ipcRenderer.invoke('hermes:connection-config:get', profile),
  saveConnectionConfig: (payload: DesktopConnectionConfigInput) =>
    ipcRenderer.invoke('hermes:connection-config:save', payload),
  applyConnectionConfig: (payload: DesktopConnectionConfigInput) =>
    ipcRenderer.invoke('hermes:connection-config:apply', payload),
  testConnectionConfig: (payload: DesktopConnectionConfigInput) =>
    ipcRenderer.invoke('hermes:connection-config:test', payload),
  // Opt-in OS-keychain encryption for stored gateway secrets (default off —
  // see secret-storage-policy.ts). get never touches the OS keychain.
  getSecretStorageEncryption: () => ipcRenderer.invoke('hermes:secret-storage:get'),
  // V3-FX M1: the Keychain setting now and at this app's launch (never touches the keychain).
  keychainState: () => ipcRenderer.invoke('iclone:keychain:state'),
  // r3: relaunch the app so the permission modes use the Keychain turned on since launch.
  keychainRestart: () => ipcRenderer.invoke('iclone:keychain:restart'),
  setSecretStorageEncryption: (on: boolean) => ipcRenderer.invoke('hermes:secret-storage:set', on),
  // v2 multi-connection registry: named agent sources (local / remote / cloud / ssh).
  connections: {
    list: () => ipcRenderer.invoke('hermes:connections:list'),
    save: (payload: DesktopRegistryConnectionInput) => ipcRenderer.invoke('hermes:connections:save', payload),
    remove: (id: string) => ipcRenderer.invoke('hermes:connections:remove', id),
    setPrimary: (id: string) => ipcRenderer.invoke('hermes:connections:set-primary', id),
    setLaunchMode: (mode: 'last-used' | 'primary') => ipcRenderer.invoke('hermes:connections:set-launch-mode', mode),
    setLastUsed: (id: string) => ipcRenderer.invoke('hermes:connections:set-last-used', id),
    test: (id: string) => ipcRenderer.invoke('hermes:connections:test', id),
    updateManaged: (id: string) => ipcRenderer.invoke('hermes:connections:update-managed', id),
    // Fan out `hermes update` to every eligible registered connection.
    // Optional excludeIds skips rows the caller updates through another path.
    updateAll: (options?: { excludeIds?: string[] }) => ipcRenderer.invoke('hermes:connections:update-all', options),
    // Registry lifecycle push (main → renderer): a connection was removed or
    // materially edited, so secondaries scoped to it must be disposed (and,
    // for edits, re-dialed at the new target).
    onChanged: (callback: (payload: { connectionId: string; reason: 'removed' | 'saved' | 'updated' }) => void) => {
      const listener = (_event: IpcEvent, payload: Parameters<typeof callback>[0]) => callback(payload)
      ipcRenderer.on('hermes:connections:changed', listener)

      return () => ipcRenderer.removeListener('hermes:connections:changed', listener)
    }
  },
  sshConfigHosts: () => ipcRenderer.invoke('hermes:ssh-config:hosts'),
  sshResolveHost: (host: string) => ipcRenderer.invoke('hermes:ssh-config:resolve', host),
  probeConnectionConfig: (remoteUrl: string) => ipcRenderer.invoke('hermes:connection-config:probe', remoteUrl),
  oauthLoginConnectionConfig: (remoteUrl: string) =>
    ipcRenderer.invoke('hermes:connection-config:oauth-login', remoteUrl),
  oauthLogoutConnectionConfig: (remoteUrl: string) =>
    ipcRenderer.invoke('hermes:connection-config:oauth-logout', remoteUrl),
  // Hermes Cloud: one portal login powers discovery + silent per-agent sign-in
  // (cloud-auto-discovery Phase 3).
  cloud: {
    status: () => ipcRenderer.invoke('hermes:cloud:status'),
    login: () => ipcRenderer.invoke('hermes:cloud:login'),
    logout: () => ipcRenderer.invoke('hermes:cloud:logout'),
    discover: (org?: string) => ipcRenderer.invoke('hermes:cloud:discover', org),
    agentSignIn: (dashboardUrl: string) => ipcRenderer.invoke('hermes:cloud:agent-sign-in', dashboardUrl)
  },
  profile: {
    get: () => ipcRenderer.invoke('hermes:profile:get'),
    remember: (name: string | null) => ipcRenderer.invoke('hermes:profile:remember', name),
    set: (name: string | null) => ipcRenderer.invoke('hermes:profile:set', name)
  },
  api: (request: HermesApiRequest) => ipcRenderer.invoke('hermes:api', request),
  notify: (payload: HermesNotification) => ipcRenderer.invoke('hermes:notify', payload),
  requestMicrophoneAccess: () => ipcRenderer.invoke('hermes:requestMicrophoneAccess'),
  readWindowBelow: () => ipcRenderer.invoke('hermes:window:readBelow'),
  readFileDataUrl: (filePath: string) => ipcRenderer.invoke('hermes:readFileDataUrl', filePath),
  readFileDataUrlForAttach: (filePath: string) => ipcRenderer.invoke('hermes:readFileDataUrlForAttach', filePath),
  dataUrlReadMax: {
    get: () => ipcRenderer.invoke('hermes:data-url-read-max:get'),
    set: (maxMb: number) => ipcRenderer.invoke('hermes:data-url-read-max:set', maxMb)
  },
  readFileText: (filePath: string) => ipcRenderer.invoke('hermes:readFileText', filePath),
  readPluginSource: (filePath: string) => ipcRenderer.invoke('hermes:readPluginSource', filePath),
  selectPaths: (options?: HermesSelectPathsOptions) => ipcRenderer.invoke('hermes:selectPaths', options),
  selectSavePath: (options?: {
    defaultPath?: string
    filters?: Array<{ extensions: string[]; name: string }>
    title?: string
  }) => ipcRenderer.invoke('hermes:selectSavePath', options),
  writeClipboard: (text: string) => ipcRenderer.invoke('hermes:writeClipboard', text),
  readClipboard: () => ipcRenderer.invoke('hermes:readClipboard'),
  saveGatewayFile: (payload: {
    connectionId?: null | string
    path: string
    profile?: null | string
    suggestedName?: string
  }) => ipcRenderer.invoke('hermes:saveGatewayFile', payload),
  saveImageFromUrl: (url: string) => ipcRenderer.invoke('hermes:saveImageFromUrl', url),
  contextMenuEdit: (command: 'copy' | 'cut' | 'paste' | 'selectAll') =>
    ipcRenderer.invoke('hermes:context-menu:edit', command),
  contextMenuCopyImage: () => ipcRenderer.invoke('hermes:context-menu:copy-image'),
  contextMenuSpellcheck: (action: { kind: 'add' | 'replace'; word: string }) =>
    ipcRenderer.invoke('hermes:context-menu:spellcheck', action),
  contextMenuGuestAddWord: (payload: { webContentsId: number; word: string }) =>
    ipcRenderer.invoke('hermes:context-menu:guest-add-word', payload),
  onContextMenuSpellcheck: (callback: (payload: { misspelledWord: string; suggestions: string[] }) => void) => {
    const listener = (_event: IpcEvent, payload: Parameters<typeof callback>[0]) => callback(payload)
    ipcRenderer.on('hermes:context-menu-spellcheck', listener)

    return () => ipcRenderer.removeListener('hermes:context-menu-spellcheck', listener)
  },
  saveImageBuffer: (data: ArrayBuffer | Uint8Array, ext: string) =>
    ipcRenderer.invoke('hermes:saveImageBuffer', { data, ext }),
  saveClipboardImage: () => ipcRenderer.invoke('hermes:saveClipboardImage'),
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  normalizePreviewTarget: (target: string, baseDir?: string) =>
    ipcRenderer.invoke('hermes:normalizePreviewTarget', target, baseDir),
  watchPreviewFile: (url: string) => ipcRenderer.invoke('hermes:watchPreviewFile', url),
  watchDirectory: (dir: string) => ipcRenderer.invoke('hermes:watchDirectory', dir),
  stopPreviewFileWatch: (id: string) => ipcRenderer.invoke('hermes:stopPreviewFileWatch', id),
  setActiveWork: (payload: HermesActiveWork) => ipcRenderer.send('hermes:active-work', payload),
  setTitleBarTheme: (payload: HermesTitleBarTheme) => ipcRenderer.send('hermes:titlebar-theme', payload),
  setNativeTheme: (mode: 'dark' | 'light' | 'system') => ipcRenderer.send('hermes:native-theme', mode),
  setTranslucency: (payload: unknown) => ipcRenderer.send('hermes:translucency', payload),
  setKeepAwake: (on: boolean) => ipcRenderer.send('hermes:keep-awake', on),
  setDisableF12: (blocked: boolean) => ipcRenderer.send('hermes:devtools:disable-f12', blocked),
  setPreviewShortcutActive: (active: boolean) => ipcRenderer.send('hermes:previewShortcutActive', Boolean(active)),
  openExternal: (url: string) => ipcRenderer.invoke('hermes:openExternal', url),
  openPreviewInBrowser: (url: string) => ipcRenderer.invoke('hermes:openPreviewInBrowser', url),
  reachPreviewUrl: (url: string) => ipcRenderer.invoke('hermes:preview:reach', url),
  setActiveConnectionRoute: (
    route: { connectionId?: null | string; profile?: string; registryScoped?: boolean } | null
  ) => ipcRenderer.send('hermes:connection:active-route', route),
  fetchLinkTitle: (url: string) => ipcRenderer.invoke('hermes:fetchLinkTitle', url),
  resolveFavicon: (url: string) => ipcRenderer.invoke('hermes:resolveFavicon', url),
  sanitizeWorkspaceCwd: (cwd?: null | string) => ipcRenderer.invoke('hermes:workspace:sanitize', cwd),
  settings: {
    getDefaultProjectDir: () => ipcRenderer.invoke('hermes:setting:defaultProjectDir:get'),
    setDefaultProjectDir: (dir: null | string) => ipcRenderer.invoke('hermes:setting:defaultProjectDir:set', dir),
    pickDefaultProjectDir: () => ipcRenderer.invoke('hermes:setting:defaultProjectDir:pick')
  },
  zoom: {
    // Current zoom of this window, as { level, percent }.
    get: () => ipcRenderer.invoke('hermes:zoom:get'),
    // Synchronous zoom factor (1 = 100%). Coordinate math needs it in the
    // same tick as the event it converts, so no IPC round-trip here.
    factor: () => webFrame.getZoomFactor(),
    setPercent: (percent: number) => ipcRenderer.send('hermes:zoom:set-percent', percent),
    // Fires on every zoom change, including the Ctrl/Cmd +/-/0 shortcuts,
    // so the settings UI can stay in sync with the keyboard.
    onChanged: (callback: (payload: { level: number; percent: number }) => void) => {
      const listener = (_event: IpcEvent, payload: Parameters<typeof callback>[0]) => callback(payload)
      ipcRenderer.on('hermes:zoom:changed', listener)

      return () => ipcRenderer.removeListener('hermes:zoom:changed', listener)
    }
  },
  revealLogs: () => ipcRenderer.invoke('hermes:logs:reveal'),
  getRecentLogs: () => ipcRenderer.invoke('hermes:logs:recent'),
  // Fire-and-forget: persists a renderer error-boundary catch (with component
  // stack) to desktop.log so crashes survive the window (#79428).
  reportRendererError: (report: { label: string; boundary: string; message: string; componentStack: string }) =>
    ipcRenderer.send('hermes:logs:renderer-error', report),
  readDir: (dirPath: string) => ipcRenderer.invoke('hermes:fs:readDir', dirPath),
  gitRoot: (startPath: string) => ipcRenderer.invoke('hermes:fs:gitRoot', startPath),
  revealPath: (targetPath: string) => ipcRenderer.invoke('hermes:fs:reveal', targetPath),
  openDir: (dirPath: string) => ipcRenderer.invoke('hermes:fs:openDir', dirPath),
  desktopPluginsRoot: () => ipcRenderer.invoke('hermes:fs:desktopPluginsRoot'),
  logsRoot: () => ipcRenderer.invoke('hermes:fs:logsRoot'),
  agentPluginsRoot: () => ipcRenderer.invoke('hermes:fs:agentPluginsRoot'),
  renamePath: (targetPath: string, newName: string) => ipcRenderer.invoke('hermes:fs:rename', targetPath, newName),
  writeTextFile: (filePath: string, content: string) => ipcRenderer.invoke('hermes:fs:writeText', filePath, content),
  trashPath: (targetPath: string) => ipcRenderer.invoke('hermes:fs:trash', targetPath),
  git: {
    worktreeList: (repoPath: string) => ipcRenderer.invoke('hermes:git:worktreeList', repoPath),
    worktreeAdd: (
      repoPath: string,
      options?: { name?: string; branch?: string; base?: string; existingBranch?: string }
    ) => ipcRenderer.invoke('hermes:git:worktreeAdd', repoPath, options),
    worktreeRemove: (repoPath: string, worktreePath: string, options?: { force?: boolean }) =>
      ipcRenderer.invoke('hermes:git:worktreeRemove', repoPath, worktreePath, options),
    branchSwitch: (repoPath: string, branch: string) => ipcRenderer.invoke('hermes:git:branchSwitch', repoPath, branch),
    branchList: (repoPath: string) => ipcRenderer.invoke('hermes:git:branchList', repoPath),
    baseBranchList: (repoPath: string) => ipcRenderer.invoke('hermes:git:baseBranchList', repoPath),
    repoStatus: (repoPath: string) => ipcRenderer.invoke('hermes:git:repoStatus', repoPath),
    fileDiff: (repoPath: string, filePath: string) => ipcRenderer.invoke('hermes:git:fileDiff', repoPath, filePath),
    scanRepos: (roots: string[], options?: { maxDepth?: number; enabled?: boolean; excludePaths?: string[] }) =>
      ipcRenderer.invoke('hermes:git:scanRepos', roots, options),
    review: {
      list: (repoPath: string, scope: HermesReviewScope, baseRef?: null | string) =>
        ipcRenderer.invoke('hermes:git:review:list', repoPath, scope, baseRef),
      diff: (repoPath: string, filePath: string, scope: HermesReviewScope, baseRef?: null | string, staged?: boolean) =>
        ipcRenderer.invoke('hermes:git:review:diff', repoPath, filePath, scope, baseRef, staged),
      stage: (repoPath: string, filePath?: null | string) =>
        ipcRenderer.invoke('hermes:git:review:stage', repoPath, filePath),
      unstage: (repoPath: string, filePath?: null | string) =>
        ipcRenderer.invoke('hermes:git:review:unstage', repoPath, filePath),
      revert: (repoPath: string, filePath?: null | string) =>
        ipcRenderer.invoke('hermes:git:review:revert', repoPath, filePath),
      revParse: (repoPath: string, ref?: null | string) =>
        ipcRenderer.invoke('hermes:git:review:revParse', repoPath, ref),
      commit: (repoPath: string, message: string, push: boolean) =>
        ipcRenderer.invoke('hermes:git:review:commit', repoPath, message, push),
      commitContext: (repoPath: string) => ipcRenderer.invoke('hermes:git:review:commitContext', repoPath),
      push: (repoPath: string) => ipcRenderer.invoke('hermes:git:review:push', repoPath),
      shipInfo: (repoPath: string) => ipcRenderer.invoke('hermes:git:review:shipInfo', repoPath),
      prList: (repoPath: string, branches: string[], numbers?: number[]) =>
        ipcRenderer.invoke('hermes:git:review:prList', repoPath, branches, numbers),
      fetchPrComment: (repoPath: string, url: string) =>
        ipcRenderer.invoke('hermes:git:review:fetchPrComment', repoPath, url),
      createPr: (repoPath: string) => ipcRenderer.invoke('hermes:git:review:createPr', repoPath)
    }
  },
  terminal: {
    cwd: (id: string) => ipcRenderer.invoke('hermes:terminal:cwd', id),
    dispose: (id: string) => ipcRenderer.invoke('hermes:terminal:dispose', id),
    resize: (id: string, size: { cols: number; rows: number }) =>
      ipcRenderer.invoke('hermes:terminal:resize', id, size),
    start: (options?: { cols?: number; cwd?: string; pane?: unknown; rows?: number }) =>
      ipcRenderer.invoke('hermes:terminal:start', options),
    write: (id: string, data: string) => ipcRenderer.invoke('hermes:terminal:write', id, data),
    onData: (id: string, callback: (payload: string) => void) => {
      const channel = `hermes:terminal:${id}:data`
      const listener = (_event: IpcEvent, payload: string) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id: string, callback: (payload: unknown) => void) => {
      const channel = `hermes:terminal:${id}:exit`
      const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  onClosePreviewRequested: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('hermes:close-preview-requested', listener)

    return () => ipcRenderer.removeListener('hermes:close-preview-requested', listener)
  },
  onPreviewNav: (callback: (command: 'back' | 'forward' | 'reload') => void) => {
    const listener = (_event: IpcEvent, command: 'back' | 'forward' | 'reload') => callback(command)
    ipcRenderer.on('hermes:preview-nav', listener)

    return () => ipcRenderer.removeListener('hermes:preview-nav', listener)
  },
  onOpenFolderRequested: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('hermes:open-folder-requested', listener)

    return () => ipcRenderer.removeListener('hermes:open-folder-requested', listener)
  },
  onOpenUpdatesRequested: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('hermes:open-updates', listener)

    return () => ipcRenderer.removeListener('hermes:open-updates', listener)
  },
  onDeepLink: (callback: (payload: { kind: string; name: string; params: Record<string, string> }) => void) => {
    const listener = (_event: IpcEvent, payload: Parameters<typeof callback>[0]) => callback(payload)
    ipcRenderer.on('hermes:deep-link', listener)

    return () => ipcRenderer.removeListener('hermes:deep-link', listener)
  },
  signalDeepLinkReady: () => ipcRenderer.invoke('hermes:deep-link-ready'),
  probePluginRepo: (payload: { identifier?: string; repo?: string }) =>
    ipcRenderer.invoke('hermes:plugin:probe', payload),
  installDesktopPlugin: (payload: { identifier?: string; repo?: string; force?: boolean }) =>
    ipcRenderer.invoke('hermes:plugin:installDesktop', payload),
  onWindowStateChanged: (callback: (payload: unknown) => void) => {
    const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
    ipcRenderer.on('hermes:window-state-changed', listener)

    return () => ipcRenderer.removeListener('hermes:window-state-changed', listener)
  },
  onFocusSession: (callback: (sessionId: string) => void) => {
    const listener = (_event: IpcEvent, sessionId: string) => callback(sessionId)
    ipcRenderer.on('hermes:focus-session', listener)

    return () => ipcRenderer.removeListener('hermes:focus-session', listener)
  },
  onNotificationAction: (callback: (payload: { actionId: string; sessionId?: string }) => void) => {
    const listener = (_event: IpcEvent, payload: Parameters<typeof callback>[0]) => callback(payload)
    ipcRenderer.on('hermes:notification-action', listener)

    return () => ipcRenderer.removeListener('hermes:notification-action', listener)
  },
  onNotificationActivate: (
    callback: (payload: { actionId?: string; activate?: string; notifyId?: string; tag?: string }) => void
  ) => {
    const listener = (_event: IpcEvent, payload: Parameters<typeof callback>[0]) => callback(payload)
    ipcRenderer.on('hermes:notification-activate', listener)

    return () => ipcRenderer.removeListener('hermes:notification-activate', listener)
  },
  onPreviewFileChanged: (callback: (payload: unknown) => void) => {
    const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
    ipcRenderer.on('hermes:preview-file-changed', listener)

    return () => ipcRenderer.removeListener('hermes:preview-file-changed', listener)
  },
  onBackendExit: (callback: (payload: unknown) => void) => {
    const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
    ipcRenderer.on('hermes:backend-exit', listener)

    return () => ipcRenderer.removeListener('hermes:backend-exit', listener)
  },
  // Soft gateway-mode apply finished tearing down the primary backend. Renderer
  // should wipe session lists + re-dial without a window reload.
  onConnectionApplied: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('hermes:connection:applied', listener)

    return () => ipcRenderer.removeListener('hermes:connection:applied', listener)
  },
  onPowerResume: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('hermes:power-resume', listener)

    return () => ipcRenderer.removeListener('hermes:power-resume', listener)
  },
  // AC ↔ battery transitions; renderers slow their backstop polls on battery.
  getOnBattery: () => ipcRenderer.invoke('hermes:power-battery:get'),
  onBatteryChanged: (callback: (onBattery: boolean) => void) => {
    const listener = (_event: IpcEvent, onBattery: unknown) => callback(Boolean(onBattery))
    ipcRenderer.on('hermes:power-battery', listener)

    return () => ipcRenderer.removeListener('hermes:power-battery', listener)
  },
  onBootProgress: (callback: (payload: unknown) => void) => {
    const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
    ipcRenderer.on('hermes:boot-progress', listener)

    return () => ipcRenderer.removeListener('hermes:boot-progress', listener)
  },
  // First-launch bootstrap progress -- emitted by the install.ps1 stage
  // runner in main.ts (apps/desktop/electron/bootstrap-runner.ts).
  // Renderer's install overlay subscribes to live events and queries the
  // current snapshot via getBootstrapState() to recover after a devtools
  // reload mid-bootstrap.
  getBootstrapState: () => ipcRenderer.invoke('hermes:bootstrap:get'),
  continueBootstrapLocal: () => ipcRenderer.invoke('hermes:bootstrap:continue-local'),
  resetBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:reset'),
  repairBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:repair'),
  cancelBootstrap: () => ipcRenderer.invoke('hermes:bootstrap:cancel'),
  // RTB-6/7 + V3-ON: the agent runtime's install status (per-package lines, diagnosis), "Skip for now",
  // "Install again", and the fixes that open a macOS Settings pane or the app's folder.
  agentRuntime: {
    status: () => ipcRenderer.invoke('hermes:agent-runtime:get'),
    skip: () => ipcRenderer.invoke('hermes:agent-runtime:skip'),
    installAgain: () => ipcRenderer.invoke('hermes:agent-runtime:install-again'),
    openFix: (fix: 'open-network-settings' | 'open-storage-settings' | 'reveal-folder') =>
      ipcRenderer.invoke('hermes:agent-runtime:open-fix', fix),
    onChange: (callback: (status: unknown) => void) => {
      const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
      ipcRenderer.on('hermes:agent-runtime:changed', listener)

      return () => ipcRenderer.removeListener('hermes:agent-runtime:changed', listener)
    }
  },
  onBootstrapEvent: (callback: (payload: unknown) => void) => {
    const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
    ipcRenderer.on('hermes:bootstrap:event', listener)

    return () => ipcRenderer.removeListener('hermes:bootstrap:event', listener)
  },
  getVersion: () => ipcRenderer.invoke('hermes:version'),
  getRemoteDisplayReason: () => ipcRenderer.invoke('hermes:get-remote-display-reason'),
  uninstall: {
    summary: () => ipcRenderer.invoke('hermes:uninstall:summary'),
    run: (mode: DesktopUninstallMode) => ipcRenderer.invoke('hermes:uninstall:run', { mode })
  },
  updates: {
    check: () => ipcRenderer.invoke('hermes:updates:check'),
    apply: (opts?: DesktopUpdateApplyOptions) => ipcRenderer.invoke('hermes:updates:apply', opts),
    getBranch: () => ipcRenderer.invoke('hermes:updates:branch:get'),
    setBranch: (name: string) => ipcRenderer.invoke('hermes:updates:branch:set', name),
    // iclone-seam: r1-policy
    policy: () => ipcRenderer.invoke('iclone:update-policy'),
    compareUpstream: () => ipcRenderer.invoke('hermes:updates:compare-upstream'),
    checkApp: () => ipcRenderer.invoke('iclone:app-update:check'),
    setDeveloperPolicy: (payload: { ack: string; by: string }) =>
      ipcRenderer.invoke('iclone:update-policy:set-developer', payload),
    onProgress: (callback: (payload: unknown) => void) => {
      const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
      ipcRenderer.on('hermes:updates:progress', listener)

      return () => ipcRenderer.removeListener('hermes:updates:progress', listener)
    }
  },
  // U1 — Settings › Updates › Agent (electron/main/agent-update.ts). Nothing here runs unless the user clicks.
  // Web decision: ABSENT in the web shim (`ABSENT_IN_WEB` in src/web-shim/bridge.ts) — every door below needs the
  // main process (git, the runtime checkout, the app's own quit/relaunch). Every namespace added here owes that list
  // an entry: src/web-shim/bridge.test.ts enumerates these names and fails until the decision is written down.
  agentUpdate: {
    check: () => ipcRenderer.invoke('hermes:agent-update:check'),
    lastCheck: () => ipcRenderer.invoke('hermes:agent-update:last-check'),
    // Call synchronously inside the confirm button's own click/key handler (the button carries
    // data-agent-update-confirm): a programmatic click has no activation and no trusted confirm.
    gesture: () =>
      ipcRenderer.invoke('hermes:agent-update:gesture', {
        activation: navigator.userActivation?.isActive === true,
        confirm: agentUpdateConfirm.take()
      }),
    apply: (request: { gestureToken: string; targetSha: string }) =>
      ipcRenderer.invoke('hermes:agent-update:apply', request)
  },
  // H1: the app's own update state machine (electron/app-update-ipc.ts); main pushes every change.
  appUpdate: {
    state: () => ipcRenderer.invoke('iclone:app-update:state'),
    check: () => ipcRenderer.invoke('iclone:app-update:check'),
    download: () => ipcRenderer.invoke('iclone:app-update:download'),
    cancel: () => ipcRenderer.invoke('iclone:app-update:cancel'),
    restart: (options?: { confirmed?: boolean }) =>
      ipcRenderer.invoke('iclone:app-update:restart', { confirmed: options?.confirmed === true }),
    log: () => ipcRenderer.invoke('iclone:app-update:log'),
    onChanged: (callback: (payload: unknown) => void) => {
      const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
      ipcRenderer.on('iclone:app-update:changed', listener)

      return () => ipcRenderer.removeListener('iclone:app-update:changed', listener)
    },
    onOpen: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('iclone:app-update:open', listener)

      return () => ipcRenderer.removeListener('iclone:app-update:open', listener)
    },
    onNotice: (callback: (payload: unknown) => void) => {
      const listener = (_event: IpcEvent, payload: unknown) => callback(payload)
      ipcRenderer.on('iclone:app-update:notice', listener)

      return () => ipcRenderer.removeListener('iclone:app-update:notice', listener)
    }
  },
  themes: {
    fetchMarketplace: (id: string) => ipcRenderer.invoke('hermes:vscode-theme:fetch', id),
    searchMarketplace: (query: string) => ipcRenderer.invoke('hermes:vscode-theme:search', query)
  },
  // Find-in-page (Ctrl/Cmd+F): delegates to Electron's
  // webContents.findInPage on the IPC sender's window so a Cmd+F pressed
  // in a secondary session window searches THAT window, not the primary.
  // `onFoundInPage` returns the unsubscribe fn; the renderer wires it via
  // `initFindInPageListener` in store/find-in-page.ts and tears it down
  // when the FindBar unmounts.
  findInPage: (query: string, options?: { forward?: boolean; findNext?: boolean }) =>
    ipcRenderer.invoke('hermes:find-in-page', query, options),
  stopFindInPage: () => ipcRenderer.invoke('hermes:stop-find-in-page'),
  onFoundInPage: (callback: (result: { activeMatchOrdinal: number; count: number }) => void) => {
    const listener = (_event: IpcEvent, result: Parameters<typeof callback>[0]) => callback(result)
    ipcRenderer.on('hermes:found-in-page', listener)

    return () => ipcRenderer.removeListener('hermes:found-in-page', listener)
  },
  // Main-process `before-input-event` forwards Ctrl/Cmd+F here so renderer
  // can open the FindBar even when the GTK compositor has already grabbed
  // the chord at the windowing layer (#81727).
  onOpenFindBarRequested: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('hermes:open-find-bar', listener)

    return () => ipcRenderer.removeListener('hermes:open-find-bar', listener)
  }
})
