// The preload bridge payload types both sides compile against: electron/preload.ts imports them, src/global.d.ts
// re-exports them for the renderer. Types only — a sandboxed preload may not load any module at runtime.
export type DesktopUninstallMode = 'full' | 'gui' | 'lite'

export type DesktopUpdateDirtyStrategy = 'abort' | 'stash' | 'force'

export interface DesktopUpdateApplyOptions {
  dirtyStrategy?: DesktopUpdateDirtyStrategy
  /** User confirmed that Desktop may stop freshly re-scanned safe local preview servers. */
  stopSafeBlockers?: boolean
}

export interface HermesTitleBarTheme {
  background: string
  foreground: string
}

/** Turns in flight, so the main process can confirm before a quit kills them. */
export interface HermesActiveWork {
  count: number
  titles: string[]
}

export interface DesktopConnectionConfigInput {
  mode: 'local' | 'remote' | 'cloud' | 'ssh'
  // When set, the save/apply/test targets this profile's per-profile remote
  // override instead of the global connection.
  profile?: null | string
  remoteAuthMode?: 'oauth' | 'token'
  remoteToken?: string
  // When true and secure (OS-keychain) storage is unavailable, persist the
  // remote token as plain text on disk instead of failing. Requires an explicit
  // user opt-in from the renderer.
  allowPlainTextToken?: boolean
  remoteUrl?: string
  // For a 'cloud' connection: the selected Hermes Cloud org (slug or id) to
  // persist so Settings can reopen into it. Ignored for remote/local modes.
  cloudOrg?: string
  sshHost?: string
  sshUser?: string
  sshPort?: number | null
  sshKeyPath?: string
  sshRemoteHermesPath?: string
  sshRemoteProfile?: string
}

// ── v2 multi-connection registry (named agent sources) ─────────────────────

export type DesktopConnectionKind = 'cloud' | 'local' | 'remote' | 'ssh'

export interface DesktopRegistryConnectionInput {
  // Present for edits; omitted on create (the main process mints the id).
  id?: string
  kind: DesktopConnectionKind
  label: string
  url?: string
  authMode?: 'oauth' | 'token'
  // Plaintext token to store (encrypted at rest); omit to keep the saved one.
  token?: string
  allowPlainTextToken?: boolean
  // Extra gateway headers for remote/cloud entries (access proxies such as
  // Cloudflare Access). The map is authoritative when present: name → new
  // plaintext value (encrypted at rest), or null to keep the stored secret
  // for that name. Omit the field entirely to keep the saved set unchanged.
  headers?: Record<string, null | string>
  org?: string
  host?: string
  user?: string
  port?: null | number
  keyPath?: string
  remoteHermesPath?: string
  remoteProfile?: string
}

export interface HermesApiRequest {
  path: string
  method?: string
  body?: unknown
  // Single-file multipart upload (FastAPI UploadFile endpoints). Mutually
  // exclusive with `body`; bytes transfer over IPC as a structured-clone
  // ArrayBuffer. Token-mode backends only.
  upload?: { filename: string; contentType?: string; bytes: ArrayBuffer }
  timeoutMs?: number
  // Route this REST call to a specific profile's backend. Omit for the primary
  // (window) backend. Read-only cross-profile data is served by the primary, so
  // this is only needed for profile-scoped live/settings calls.
  profile?: string | null
  // Route this REST call to a specific REGISTERED gateway connection (v2
  // registry). Data owned by a remote gateway — cron jobs and their run
  // sessions — lives in that host's state.db, so requests for it must resolve
  // through the owning connection, not the local profile pool. Omit / '' to
  // keep the legacy profile-routed path; explicit 'local' forces this device.
  connectionId?: string | null
}

export interface HermesNotification {
  title?: string
  body?: string
  silent?: boolean
  kind?: string
  sessionId?: string
  /** Dedupe discriminator for session-less notifications (e.g. plugin id). */
  tag?: string
  /** Absolute icon path for Electron `Notification`. */
  icon?: string
  /** Resolved hash-router path opened on body click (plugin / deeplink-compatible). */
  activate?: string
  /** Renderer handle for onActivate / onAction callbacks. */
  notifyId?: string
  actions?: { id: string; text: string; activate?: string }[]
}

// Diff scope for the review pane, mirroring Codex: uncommitted working-tree
// changes, all changes vs the branch base, or everything since the current
// turn began.
export type HermesReviewScope = 'branch' | 'lastTurn' | 'uncommitted'

export interface HermesSelectPathsOptions {
  title?: string
  defaultPath?: string
  directories?: boolean
  multiple?: boolean
  /** Backend profile that produced defaultPath; Electron uses it for WSL gating. */
  profile?: string
  filters?: Array<{ name: string; extensions: string[] }>
}
