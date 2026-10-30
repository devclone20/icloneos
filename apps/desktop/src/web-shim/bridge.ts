// The `window.hermesDesktop` surface for icloneOS Web: the renderer served by
// the Hermes gateway itself (HERMES_WEB_DIST), so every call is same-origin.
// REST and websockets map onto the gateway; Electron-only features resolve to
// honest no-ops so the shell renders without them.

import POLICY_META from '../../../../iclone/legal/policy-version.json' with { type: 'json' }
import { CONSENT_PERMISSION_KEYS } from '../components/consent/types'
import type {
  BundledPolicy,
  ConsentPermissionKey,
  ConsentPermissions,
  ConsentRecord,
  ConsentResult,
  ConsentSnapshot,
  ConsentState,
  IcloneConsentBridge
} from '../components/consent/types'
import { compareVersions } from '../iclone-shared/version'

const SESSION_HEADER = 'X-Hermes-Session-Token'
const DEFAULT_TIMEOUT_MS = 30_000

export interface WebBridgeOptions {
  authRequired: boolean
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  location: Pick<Location, 'host' | 'origin' | 'protocol'>
  notAvailable?: (feature: string) => void
  // The full bundled policy (short text + permission rows); the web entry passes it. Without it only the policy's
  // identity from iclone/legal/policy-version.json is shown, with no permission rows.
  policy?: BundledPolicy
  storage?: ConsentStorage
  token: null | string
}

export interface WebApiRequest {
  body?: unknown
  method?: string
  path: string
  timeoutMs?: number
  upload?: { bytes: ArrayBuffer; contentType?: string; filename: string }
}

type Bridge = Record<string, unknown>

// Policy acceptance for icloneOS Web. The desktop keeps consent.json in main;
// a browser has no main process, so the record lives in this origin's
// localStorage and the same bundled policy is shown and accepted. Device
// permissions are the browser's own prompts, so the saved switches are intents.
export const WEB_CONSENT_KEY = 'icloneos-web.consent.v1'

export type ConsentStorage = Pick<Storage, 'getItem' | 'setItem'>

function memoryStorage(): ConsentStorage {
  const items = new Map<string, string>()

  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value)
  }
}

export function defaultConsentStorage(): ConsentStorage {
  try {
    return globalThis.localStorage ?? memoryStorage()
  } catch {
    // Storage access throws in some privacy modes; the policy is then asked again on every load.
    return memoryStorage()
  }
}

function readRecord(storage: ConsentStorage): ConsentRecord | null {
  try {
    const value = JSON.parse(storage.getItem(WEB_CONSENT_KEY) ?? 'null') as Partial<ConsentRecord> | null

    return value &&
      value.schema === 1 &&
      typeof value.policyVersion === 'string' &&
      typeof value.acceptedAt === 'string'
      ? (value as ConsentRecord)
      : null
  } catch {
    return null
  }
}

// Only rows the policy shows can be saved; the keychain is never encrypted in a browser.
function sanitize(permissions: unknown, shown: readonly ConsentPermissionKey[]): ConsentPermissions {
  const source = (permissions && typeof permissions === 'object' ? permissions : {}) as Record<string, unknown>
  const clean: ConsentPermissions = {}

  for (const key of shown) {
    if (typeof source[key] === 'boolean') {
      clean[key] = key === 'keychain' ? false : (source[key] as boolean)
    }
  }

  return clean
}

export function createWebConsent(options: {
  now?: () => Date
  openExternal: (url: string) => void
  policy: BundledPolicy
  storage?: ConsentStorage
}): IcloneConsentBridge {
  const storage = options.storage ?? defaultConsentStorage()
  const now = options.now ?? (() => new Date())
  const policy = options.policy
  // The document may list a permission this build has no switch for (Local network, U1-08-p2): keep our keys only.
  const own: readonly string[] = [...CONSENT_PERMISSION_KEYS, 'files']
  const shown = policy.permissions.map(row => row.key).filter((key): key is ConsentPermissionKey => own.includes(key))

  const state = (record: ConsentRecord | null): ConsentState =>
    !record ? 'required' : compareVersions(record.policyVersion, policy.version) < 0 ? 'update' : 'ok'

  const write = (record: ConsentRecord): ConsentResult => {
    try {
      storage.setItem(WEB_CONSENT_KEY, JSON.stringify(record))
    } catch (error) {
      return { ok: false, error: `This browser did not save the choice (${(error as Error).message}).` }
    }

    return { ok: true, record }
  }

  const update = (change: (record: ConsentRecord) => ConsentRecord): ConsentResult => {
    const record = readRecord(storage)

    return record ? write(change(record)) : { ok: false, error: 'The policy has not been accepted yet.' }
  }

  return {
    get: async (): Promise<ConsentSnapshot> => {
      const record = readRecord(storage)

      return {
        bundled: policy,
        keychainEncrypted: false,
        record,
        state: state(record)
      }
    },
    policyText: async () => null,
    accept: async input => {
      if (input?.version !== policy.version) {
        return { ok: false, error: `Only the bundled policy v${policy.version} can be accepted.` }
      }

      const previous = readRecord(storage)
      const at = now().toISOString()

      return write({
        acceptedAt: at,
        aiProviderConsent:
          typeof input.aiProvider === 'boolean'
            ? { accepted: input.aiProvider, at }
            : (previous?.aiProviderConsent ?? null),
        permissions: previous?.permissions ?? {},
        permissionsDecidedAt: previous?.permissionsDecidedAt ?? null,
        policyEffective: policy.effective,
        policyVersion: policy.version,
        schema: 1,
        skipped: previous?.skipped ?? false
      })
    },
    setPermissions: async input => {
      const skipped = input?.skipped === true

      return update(record => ({
        ...record,
        permissions: skipped ? {} : sanitize(input?.permissions, shown),
        permissionsDecidedAt: skipped ? null : now().toISOString(),
        skipped
      }))
    },
    setAiProvider: async input =>
      update(record => ({
        ...record,
        aiProviderConsent: { accepted: input?.accepted === true, at: now().toISOString() }
      })),
    openPolicy: async () => {
      options.openExternal(policy.url)

      return true
    },
    // A browser tab cannot quit the app; declining leaves the gate up.
    quit: async () => false
  }
}

export function isWebBuild(): boolean {
  return import.meta.env.MODE === 'web' || (globalThis as { __ICLONE_WEB__?: boolean }).__ICLONE_WEB__ === true
}

// Namespaces the renderer types as always present but that only exist in the
// desktop app. Every member resolves to a no-op so
// `hermesDesktop.<ns>.<method>()` never throws in a browser.
const DESKTOP_ONLY = [
  'cloud',
  'git',
  'hud',
  'icloneAcp',
  'icloneIt',
  'icloneOwnership',
  'iclonePrivy',
  'quickEntry',
  'terminal',
  'uninstall',
  'updates',
  'wakeIndicator'
]

// Namespaces the renderer types as optional (`hermesDesktop.<ns>?.`): the web
// app leaves them out, so every caller takes its own "not in this build" path
// (engine choice, updates, skills sync, on-chain balances, 3D model fetch and
// the Doctor's checks all run in the desktop main process; Settings >
// Diagnostics then states that diagnostics are unavailable).
export const ABSENT_IN_WEB = [
  // Both update namespaces run entirely in the desktop main process: `agentUpdate`
  // shells out to the fork-owned update script and relaunches the app, `appUpdate`
  // drives the electron updater. A browser has neither, so both are absent rather
  // than reported no-ops. Any new preload namespace needs an entry here or in one
  // of the lists below — src/web-shim/bridge.test.ts enumerates preload.ts and fails
  // on the first namespace without a decision.
  'agentUpdate',
  // V3-RT-B: the agent runtime's install status, skip and repair belong to this Mac's installer; a browser installs
  // nothing (the install overlay and the Settings section read the bridge as absent).
  'agentRuntime',
  'appUpdate',
  'dataUrlReadMax',
  // REL-6: the ACP tools installer writes the CLI into this Mac's app folder; a browser installs nothing (and the
  // Market pane reads the bridge as absent, so it is not gated there).
  'icloneAcpTools',
  // V3-I: ACP WORK is a main-process supervisor that keeps an iNFT online from this machine; a browser has none.
  'icloneAcpWork',
  'icloneBalances',
  'icloneClaudeCode',
  // V3-G: confinement wraps the agent's shell on this Mac; a browser runs no agent shell to confine.
  'icloneConfinement',
  'icloneDoctor',
  'icloneModel',
  // V3-ON: the Set up step reads this Mac's system permissions and installed packages; a browser has neither, so the
  // step is not offered there (the consent flow is unchanged).
  'icloneSetup',
  'icloneSkills',
  'icloneUpdates',
  // V3-D: the pane bus broker and its Unix socket live in main; the renderer's
  // paneBus() reads it as absent and iT keeps working without the bus.
  'paneBus',
  // The pop-out pet is an OS window (V3-P): a browser has none, so the pet stays in the page.
  'petOverlay',
  // The VS Code Marketplace theme search runs in the desktop main process (electron/vscode-marketplace.ts). The
  // runtime serves no themes marketplace route, so the web build has none: the theme pages say so instead (V3-0).
  'themes'
] as const

// Top-level calls the renderer types as always present that need the desktop
// main process (files, windows, logs, bootstrap, find-in-page, SSH and local
// connection config). Each is a reported no-op.
const DESKTOP_ONLY_CALLS = [
  'applyConnectionConfig',
  'cancelBootstrap',
  'claimAmbientCue',
  'continueBootstrapLocal',
  'fetchLinkTitle',
  'findInPage',
  'getConnectionConfig',
  'getProfileRoutes',
  'getRecentLogs',
  'normalizePreviewTarget',
  'oauthLoginConnectionConfig',
  'oauthLogoutConnectionConfig',
  'openBrowserWindow',
  'openSessionInTerminal',
  'openSessionWindow',
  'openWindow',
  'probeConnectionConfig',
  'readDir',
  'readFileDataUrl',
  'readFileText',
  'repairBootstrap',
  'requestMicrophoneAccess',
  'resetBootstrap',
  'restartBackend',
  'revealLogs',
  'sanitizeWorkspaceCwd',
  'saveClipboardImage',
  'saveConnectionConfig',
  'saveImageBuffer',
  'saveImageFromUrl',
  'selectPaths',
  'setSecretStorageEncryption',
  'sshConfigHosts',
  'sshResolveHost',
  'stopFindInPage',
  'stopPreviewFileWatch',
  'testConnectionConfig',
  'touchBackend',
  'watchPreviewFile'
]

/** The resolved URL of an origin-relative gateway path; anything that could leave the origin throws before a fetch. */
export function sameOriginUrl(path: unknown, origin: string): URL {
  const text = typeof path === 'string' ? path : ''

  if (!text.startsWith('/') || text.startsWith('//') || /[\\\s]/.test(text)) {
    throw new Error(
      `icloneOS Web only calls its own gateway with an origin-relative path, not ${JSON.stringify(text.slice(0, 80))}`
    )
  }

  const url = new URL(text, origin)

  if (url.origin !== new URL(origin).origin) {
    throw new Error(`icloneOS Web refused a gateway call that resolves off its origin (${url.origin})`)
  }

  return url
}

// What a desktop-only call returns: callable (a React effect may use it as its
// cleanup) and awaitable, settling to an empty list — index access, .map and
// .length all stay safe for the list/map shapes these calls return.
function settled(): unknown {
  const value = Promise.resolve([] as unknown[])

  return Object.assign(() => undefined, {
    catch: (onRejected?: (reason: unknown) => unknown) => value.catch(onRejected),
    finally: (onFinally?: () => void) => value.finally(onFinally),
    then: (onFulfilled?: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      value.then(onFulfilled, onRejected)
  })
}

export function unavailable(path: string, report: (feature: string) => void): unknown {
  return new Proxy(() => undefined, {
    apply: () => {
      report(path)

      return settled()
    },
    get: (_target, key) => {
      if (typeof key !== 'string' || key === 'then') {
        return undefined
      }

      if (key.startsWith('on')) {
        return () => () => undefined
      }

      return unavailable(`${path}.${key}`, report)
    }
  })
}

export function createWebBridge(options: WebBridgeOptions): Bridge {
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
  const reported = new Set<string>()

  const report =
    options.notAvailable ??
    ((feature: string) => {
      if (!reported.has(feature)) {
        reported.add(feature)
        console.info(`[icloneOS Web] ${feature} is not available in the web app`)
      }
    })

  const wsBase = `${options.location.protocol === 'https:' ? 'wss' : 'ws'}://${options.location.host}`

  async function api<T = unknown>(request: WebApiRequest): Promise<T> {
    const url = sameOriginUrl(request?.path, options.location.origin)
    const headers: Record<string, string> = {}
    let body: BodyInit | undefined

    if (options.token) {
      headers[SESSION_HEADER] = options.token
    }

    if (request.upload) {
      const form = new FormData()
      const type = request.upload.contentType || 'application/octet-stream'
      form.append('file', new Blob([request.upload.bytes], { type }), request.upload.filename)
      body = form
    } else if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(request.body)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    try {
      const response = await fetchImpl(url.toString(), {
        body,
        credentials: 'same-origin',
        headers,
        method: request.method ?? 'GET',
        signal: controller.signal
      })

      const text = await response.text()

      if (response.status >= 400) {
        throw new Error(`${response.status}: ${text || response.statusText}`)
      }

      if (!text) {
        return null as T
      }

      try {
        return JSON.parse(text) as T
      } catch {
        return text as T
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function wsUrl(): Promise<string> {
    if (!options.authRequired) {
      return `${wsBase}/api/ws?token=${encodeURIComponent(options.token ?? '')}`
    }

    const { ticket } = await api<{ ticket: string }>({ method: 'POST', path: '/api/auth/ws-ticket' })

    return `${wsBase}/api/ws?ticket=${encodeURIComponent(ticket)}`
  }

  const connection = () => ({
    authMode: options.authRequired ? 'oauth' : 'token',
    baseUrl: options.location.origin,
    isFullscreen: false,
    logs: [] as string[],
    mode: 'remote',
    nativeOverlayWidth: 0,
    remoteHost: options.location.host,
    remoteKind: 'url',
    source: 'settings',
    token: options.token ?? '',
    wsUrl: `${wsBase}/api/ws`
  })

  const bridge: Bridge = {
    glassSupported: false,
    translucencySupported: false,
    api,
    getConnection: async () => connection(),
    getConnectionFor: async () => connection(),
    revalidateConnection: async () => connection(),
    getGatewayWsUrl: wsUrl,
    getGatewayWsUrlFor: wsUrl,
    getBootProgress: async () => ({ error: null, fakeMode: false, message: '', phase: 'ready', progress: 100 }),
    getBootstrapState: async () => ({
      active: false,
      completedAt: null,
      error: null,
      log: [],
      manifest: null,
      setupChoice: null,
      stages: {},
      startedAt: null,
      unsupportedPlatform: null
    }),
    getVersion: async () => import.meta.env.VITE_ICLONE_WEB_VERSION ?? '',
    getRemoteDisplayReason: async () => null,
    getOnBattery: async () => false,
    getSecretStorageEncryption: async () => ({ available: false }),
    openExternal: async (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    writeClipboard: async (text: string) => navigator.clipboard.writeText(text),
    readClipboard: async () => navigator.clipboard.readText(),
    notify: async () => undefined,
    signalDeepLinkReady: async () => undefined,
    reportRendererError: async () => undefined,
    getPathForFile: () => '',
    icloneConsent: createWebConsent({
      openExternal: url => void window.open(url, '_blank', 'noopener,noreferrer'),
      policy: options.policy ?? { ...POLICY_META, permissions: [], permissionsIntro: '', short: [] },
      storage: options.storage
    }),
    connections: {
      list: async () => [],
      onChanged: () => () => undefined
    },
    settings: {
      getDefaultProjectDir: async () => ({ defaultLabel: 'Not available in the web app', dir: null, resolvedCwd: '' }),
      pickDefaultProjectDir: async () => ({ canceled: true, dir: null }),
      setDefaultProjectDir: async () => ({ dir: null })
    },
    profile: {
      get: async () => null,
      remember: async () => undefined,
      set: async () => undefined
    },
    zoom: {
      factor: () => 1,
      get: async () => ({ level: 0, percent: 100 }),
      onChanged: () => () => undefined,
      setPercent: async () => undefined
    }
  }

  for (const ns of DESKTOP_ONLY) {
    bridge[ns] = unavailable(ns, report)
  }

  for (const call of DESKTOP_ONLY_CALLS) {
    bridge[call] = unavailable(call, report)
  }

  for (const ns of ABSENT_IN_WEB) {
    bridge[ns] = undefined
  }

  return new Proxy(bridge, {
    get: (target, key) => {
      if (typeof key !== 'string' || key in target) {
        return Reflect.get(target, key)
      }

      // Desktop events never fire in a browser: every `on<Event>` subscribes to nothing.
      if (/^on[A-Z]/.test(key)) {
        return () => () => undefined
      }

      // Anything else undecided is absent, as the optional members it stands for are typed.
      if (key !== 'then') {
        report(key)
      }

      return undefined
    }
  })
}
