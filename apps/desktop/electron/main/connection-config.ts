// Desktop connection config and the v2 connection registry: read, sanitize, write.
import fs from 'node:fs'
import path from 'node:path'

import { session } from 'electron'

import {
  connectionScopeKey,
  localProfileEntry,
  modeIsRemoteLike,
  normalizeRemoteBaseUrl,
  normalizeRemoteHeaders,
  normalizeSshConfig,
  remoteRequestMatchesBaseUrl,
  resolveAuthMode,
  savedProfileSsh,
  tokenPreview
} from '../connection-config'
import type { ConnectionRegistry, RegistryConnection } from '../connection-registry'
import { migrateV1ToRegistry, normalizeRegistry, reconcileRegistryDrift } from '../connection-registry'
import { loadOrCreateInstallationId } from '../desktop-installation'
import { resolvePersistedRemoteToken, tightenSecretFileMode, writeSecretFileAtomic } from '../hardening'
import { writeFileAtomicSync } from '../lib/atomic-write'
import type { RemoteUpdateTarget } from '../managed-ssh-update'
import { applyRemoteRequestHeaders } from '../remote-ws-headers'
import type { SshConnection } from '../ssh-connection'

import { remoteWsHeaderStore } from './backend-state'
import { PROFILE_NAME_RE } from './env'
import { rememberLog } from './log'
import {
  DESKTOP_CONNECTION_CONFIG_PATH,
  DESKTOP_CONNECTIONS_REGISTRY_PATH,
  DESKTOP_INSTALLATION_PATH,
  DESKTOP_PROFILE_CONFIG_PATH
} from './paths'
import {
  decryptDesktopSecret,
  decryptRemoteHeaders,
  encryptDesktopSecret,
  probeSecureTokenStorage,
  sanitizeConnectionProfiles
} from './secrets'

let connectionConfigCache: DesktopConnectionConfig | null = null
let connectionConfigCacheMtime: number | null = null
let connectionRegistryCache: DesktopConnectionsRegistry | null = null
let connectionRegistryCacheMtime: number | null = null
let remoteHeaderRulesInstalled = false

export function headersForRemoteRequest(requestUrl: string) {
  const exactWsHeaders = remoteWsHeaderStore.headersFor(requestUrl)

  if (exactWsHeaders && Object.keys(exactWsHeaders).length > 0) {
    return exactWsHeaders
  }

  const config = readDesktopConnectionConfig()

  if (modeIsRemoteLike(config.mode) && config.remote?.url) {
    const headers = decryptRemoteHeaders(config.remote.headers)

    if (Object.keys(headers).length > 0 && remoteRequestMatchesBaseUrl(requestUrl, String(config.remote.url))) {
      return headers
    }
  }

  return {}
}

export function installRemoteHeaderRules() {
  if (remoteHeaderRulesInstalled) {
    return
  }

  remoteHeaderRulesInstalled = true
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    applyRemoteRequestHeaders(details, callback, headersForRemoteRequest)
  })
}

/** connection.json, read by this process; `remote` and the profile entries stay untrusted until resolved. */
export interface DesktopConnectionConfig {
  mode: 'local' | 'remote' | 'cloud' | 'ssh'
  remote: Record<string, unknown>
  profiles: ReturnType<typeof sanitizeConnectionProfiles>
}

/**
 * RegistryConnection in object-literal form: an interface gets no implicit index signature, so only this form
 * is assignable to the `[field: string]: unknown` route sources plugin-profile-routes takes.
 */
export type RegistryEntry = { [K in keyof RegistryConnection]: RegistryConnection[K] }

type DesktopConnectionsRegistry = Omit<ConnectionRegistry, 'connections'> & { connections: RegistryEntry[] }

export function readDesktopConnectionConfig(): DesktopConnectionConfig {
  // Check if file changed on disk since last read (e.g. modified by another
  // process or an external tool).  Our own writes update the cache inline
  // via writeDesktopConnectionConfig, but external changes would be missed.
  let mtime = null

  try {
    mtime = fs.statSync(DESKTOP_CONNECTION_CONFIG_PATH).mtimeMs
  } catch {
    mtime = null
  }

  if (connectionConfigCache && connectionConfigCacheMtime === mtime) {
    return connectionConfigCache
  }

  let config: DesktopConnectionConfig = { mode: 'local', remote: {}, profiles: {} }

  try {
    const raw = fs.readFileSync(DESKTOP_CONNECTION_CONFIG_PATH, 'utf8')
    // Tighten an install written before this file was owner-only. Every write
    // now goes out at 0600, but a file already on disk keeps its old 0644 bits
    // until something chmods it, and waiting for the user's next Settings save
    // would leave it group/other-readable indefinitely. Runs on a cache miss
    // only (once per launch, plus after an external edit); chmod moves ctime,
    // not mtime, so it cannot invalidate the cache it sits inside.
    //
    // Deliberately BEFORE JSON.parse, not after: a truncated or hand-mangled
    // connection.json still contains the token bytes, and parse throws into the
    // catch below, which swallows the error and falls back to local mode. With
    // the tighten after the parse, exactly the file that is both corrupt AND
    // world-readable would be the one file never tightened — and nothing would
    // ever retry it, because the fallback config is not written back. The chmod
    // needs only the path, so it has no reason to wait for valid JSON.
    tightenSecretFileMode(DESKTOP_CONNECTION_CONFIG_PATH)

    const parsed = JSON.parse(raw)

    // NOT done here: migrating a legacy non-safeStorage token payload to
    // ciphertext at rest. Deferred deliberately — it has to honor the opt-in
    // plaintext choice PR #62319 adds (re-encrypting it converts a portable
    // credential into a keychain-bound one and can lose the token), write
    // through sanitizeConnectionProfiles below rather than persisting raw
    // `parsed`, and tell the user to ROTATE, since every existing backup copy
    // still holds the old secret. Do not add it without those three.

    if (parsed && typeof parsed === 'object') {
      const remote = parsed.remote && typeof parsed.remote === 'object' ? parsed.remote : {}
      // authMode lives on the remote sub-object: 'oauth' (cookie + ws-ticket)
      // or 'token' (legacy static session token). Default to 'token' for
      // backward compatibility with configs written before OAuth support.
      remote.authMode = remote.authMode === 'oauth' ? 'oauth' : 'token'
      config = {
        mode: parsed.mode === 'ssh' ? 'ssh' : modeIsRemoteLike(parsed.mode) ? parsed.mode : 'local',
        remote,
        // Per-profile remote overrides: each profile may point at its own
        // backend (local spawn or its own remote URL). Preserved verbatim so
        // profileRemoteOverride() can resolve them; normalized lazily on save.
        profiles: sanitizeConnectionProfiles(parsed.profiles)
      }
    }
  } catch {
    // Missing or malformed connection settings should fall back to local.
  }

  connectionConfigCache = config
  connectionConfigCacheMtime = mtime

  return config
}

export function writeDesktopConnectionConfig(config: DesktopConnectionConfig) {
  fs.mkdirSync(path.dirname(DESKTOP_CONNECTION_CONFIG_PATH), { recursive: true })
  // Owner-only, not writeFileAtomic: this is the single choke point for every
  // connection.json write (the IPC save/apply handlers and
  // persistSshConnectionToken all land here), and the file carries the
  // safeStorage-encrypted gateway token plus its URL and SSH host/user/keyPath.
  // safeStorage keeps the token opaque; 0600 keeps the whole record — and the
  // fields that are NOT encrypted — off other local accounts, matching
  // native-oauth-tokens.json and desktop-installation.json.
  writeSecretFileAtomic(DESKTOP_CONNECTION_CONFIG_PATH, JSON.stringify(config, null, 2))
  connectionConfigCache = config
  connectionConfigCacheMtime = fs.statSync(DESKTOP_CONNECTION_CONFIG_PATH).mtimeMs
}

// ── v2 connection registry (multi-source) ──────────────────────────────────

/**
 * Read the v2 registry, importing from v1 connection.json exactly once (when
 * connections.json does not exist yet). Same mtime-cache + tighten-mode
 * discipline as readDesktopConnectionConfig; a corrupt registry degrades to
 * local-only via normalizeRegistry rather than throwing at boot.
 *
 * An EXISTING registry is additionally reconciled against v1 when the two have
 * drifted — see reconcileRegistryDrift. The one-shot migration cannot cover a
 * user who registered nothing and then pointed Settings -> Gateway at a remote,
 * and until that heals, every launch re-homes them onto a local backend.
 */
export function readDesktopConnectionsRegistry(): DesktopConnectionsRegistry {
  let mtime = null

  try {
    mtime = fs.statSync(DESKTOP_CONNECTIONS_REGISTRY_PATH).mtimeMs
  } catch {
    mtime = null
  }

  if (connectionRegistryCache && connectionRegistryCacheMtime === mtime) {
    return connectionRegistryCache
  }

  let registry

  if (mtime === null) {
    // First run on this build: import the v1 single-connection config. The v1
    // file is NOT modified or deleted — older builds keep reading it. The
    // migration is deterministic over the v1 input, so even if two processes
    // race the first run (updater relaunch, second window), both derive the
    // same registry and the later atomic write is a no-op content-wise.
    registry = migrateV1ToRegistry(readDesktopConnectionConfig())

    try {
      writeDesktopConnectionsRegistry(registry)
    } catch {
      // Write failed (full disk, read-only userData). Keep the migrated
      // registry in memory so list/save keep working this session instead of
      // hard-failing every hermes:connections:* call.
      connectionRegistryCache = registry
      connectionRegistryCacheMtime = null
    }

    return registry
  }

  try {
    // Same rationale as connection.json: tighten BEFORE parse so a corrupt
    // file that still holds token bytes gets its mode fixed anyway.
    tightenSecretFileMode(DESKTOP_CONNECTIONS_REGISTRY_PATH)
    registry = normalizeRegistry(JSON.parse(fs.readFileSync(DESKTOP_CONNECTIONS_REGISTRY_PATH, 'utf8')))
  } catch {
    // Whole-file corruption (truncated write, mangled hand-edit). The
    // degraded local-only registry keeps boot working, but the file BYTES are
    // the user's connection data — preserve them in a sidecar BEFORE any
    // later write (drift reconcile, connection save) overwrites the file
    // (#94246: recovery must never be data loss).
    preserveCorruptRegistrySidecar()
    registry = normalizeRegistry(null)
  }

  if (registry?.quarantined?.length) {
    rememberLog(
      `[connections] ${registry.quarantined.length} malformed registry entr${registry.quarantined.length === 1 ? 'y was' : 'ies were'} quarantined (kept under "quarantined" in connections.json); healthy connections loaded normally.`
    )
  }

  // Heal v1 -> v2 drift: the v1 global route names a remote this registry has
  // never heard of, so the live descriptor resolves to no connectionId and the
  // launch pick sends the window somewhere else. Persist so the repair is a
  // one-time event rather than a recomputation on every read; a failed write
  // still returns the healed registry for this session.
  const reconciled = reconcileRegistryDrift(registry, readDesktopConnectionConfig())

  if (reconciled.changed) {
    registry = reconciled.registry

    try {
      writeDesktopConnectionsRegistry(registry)

      return registry
    } catch {
      connectionRegistryCache = registry
      connectionRegistryCacheMtime = null

      return registry
    }
  }

  connectionRegistryCache = registry
  connectionRegistryCacheMtime = mtime

  return registry
}

// Copy an unparseable connections.json aside (once per corruption event) so a
// later registry write can never destroy the only copy of the user's saved
// connections (#94246). Best effort: failure to preserve must not block boot.
function preserveCorruptRegistrySidecar() {
  try {
    const rawText = fs.readFileSync(DESKTOP_CONNECTIONS_REGISTRY_PATH, 'utf8')

    if (!rawText.trim()) {
      return
    }

    const sidecar = `${DESKTOP_CONNECTIONS_REGISTRY_PATH}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`

    if (!fs.existsSync(sidecar)) {
      fs.writeFileSync(sidecar, rawText, { mode: 0o600 })
    }

    rememberLog(
      `[connections] connections.json could not be parsed; preserved the original file at ${sidecar} and continuing with a local-only registry. No connection data was deleted.`
    )
  } catch {
    // The read itself failed (missing file, permissions) — nothing to save.
  }
}

export function writeDesktopConnectionsRegistry(registry: ConnectionRegistry) {
  fs.mkdirSync(path.dirname(DESKTOP_CONNECTIONS_REGISTRY_PATH), { recursive: true })
  // Owner-only for the same reason as connection.json: entries carry
  // safeStorage-encrypted tokens plus URLs and SSH host/user/keyPath.
  writeSecretFileAtomic(DESKTOP_CONNECTIONS_REGISTRY_PATH, JSON.stringify(registry, null, 2))
  connectionRegistryCache = registry
  connectionRegistryCacheMtime = fs.statSync(DESKTOP_CONNECTIONS_REGISTRY_PATH).mtimeMs
}

/**
 * Renderer-facing view of a registry entry: token bytes never cross the IPC
 * boundary — the renderer gets a preview + set flag, mirroring
 * sanitizeDesktopConnectionConfig.
 */
export function sanitizeRegistryConnection(entry: RegistryConnection) {
  const { token, headers, ...rest } = entry
  const decrypted = decryptDesktopSecret(token)
  // Last-known stable backend identity (from roster enumeration / Test) so
  // Settings can hint "Same backend as <label>" on connections that are two
  // addresses for one box. Display-only; absent until a probe has seen it.
  const knownInstallId = connectionInstallIds.get(entry.id)?.id

  return {
    ...rest,
    tokenSet: Boolean(decrypted),
    tokenPreview: tokenPreview(decrypted),
    ...(knownInstallId ? { installId: knownInstallId } : {}),
    // Header VALUES are secrets (Cloudflare Access client secrets etc.) and
    // never cross the IPC boundary — the renderer only needs the names to
    // render the edit form.
    headerNames: headers && typeof headers === 'object' ? Object.keys(headers) : []
  }
}

export function sanitizeConnectionsRegistry(registry = readDesktopConnectionsRegistry()) {
  // Same keyring signal the v1 sanitize exposes: lets the Connections panel
  // offer the plain-text opt-in on keyring-less Linux instead of failing.
  // Policy-aware: never touches safeStorage while encryption is opted out.
  const secureTokenStorage = probeSecureTokenStorage()

  return {
    version: registry.version,
    primary: registry.primary,
    launchMode: registry.launchMode,
    lastUsed: registry.lastUsed,
    secureTokenStorage,
    connections: registry.connections.map(sanitizeRegistryConnection),
    // Surface quarantined-entry NOTICES only (reason + best-effort label) —
    // the raw entries can carry token envelopes and stay in the file (#94246).
    quarantined: (registry.quarantined || []).map(q => ({
      reason: String(q?.reason || 'unknown'),
      label:
        q && q.entry && typeof q.entry === 'object' && typeof (q.entry as any).label === 'string'
          ? (q.entry as any).label
          : ''
    }))
  }
}

// Returns the desktop's chosen profile name, or null when unset. "default" is
// a valid stored value (pins the root HERMES_HOME explicitly); null means "no
// preference" and preserves the legacy launch (no --profile flag).
export function readActiveDesktopProfile() {
  try {
    const raw = fs.readFileSync(DESKTOP_PROFILE_CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    const name = parsed && typeof parsed.profile === 'string' ? parsed.profile.trim() : ''

    if (name && (name === 'default' || PROFILE_NAME_RE.test(name))) {
      return name
    }
  } catch {
    // Missing or malformed → no preference.
  }

  return null
}

export function writeActiveDesktopProfile(name: string) {
  const value = typeof name === 'string' ? name.trim() : ''

  if (value && value !== 'default' && !PROFILE_NAME_RE.test(value)) {
    throw new Error(`Invalid profile name: ${value}`)
  }

  fs.mkdirSync(path.dirname(DESKTOP_PROFILE_CONFIG_PATH), { recursive: true })
  writeFileAtomicSync(DESKTOP_PROFILE_CONFIG_PATH, JSON.stringify({ profile: value || null }, null, 2))

  return value || null
}

// Build + validate a `{ url, authMode, token }` remote block. OAuth gateways
// authenticate via the login-window session cookie (verified at connect time in
// resolveRemoteBackend), so only token-auth remotes require a saved token.
// `org` (optional) is the Hermes Cloud org slug/id the instance was discovered
// under — persisted so Settings can reopen into the same org; omitted from the
// block when empty so plain remote connections stay unchanged.
function buildRemoteBlock(remoteUrl: string, authMode: string, token: object, org?: string, headers?: object) {
  if (authMode !== 'oauth' && !decryptDesktopSecret(token)) {
    throw new Error('Remote gateway session token is required.')
  }

  const block: { url: string; authMode: string; token: object; headers?: object; org?: string } = {
    url: normalizeRemoteBaseUrl(remoteUrl),
    authMode,
    token
  }

  const remoteHeaders = normalizeRemoteHeaders(headers)

  if (Object.keys(remoteHeaders).length > 0) {
    block.headers = remoteHeaders
  }

  const orgValue = typeof org === 'string' ? org.trim() : ''

  if (orgValue) {
    block.org = orgValue
  }

  return block
}

export function coerceDesktopConnectionConfig(
  input: any = {},
  existing = readDesktopConnectionConfig(),
  options: any = {}
): DesktopConnectionConfig {
  const persistToken = options.persistToken !== false
  const key = connectionScopeKey(input.profile)
  // 'cloud' and 'remote' both persist a remote-shaped block; 'cloud' is
  // remembered as its own provenance (Q6) and resolves to remote downstream.
  // Anything else collapses to local.
  const mode = input.mode === 'ssh' ? 'ssh' : modeIsRemoteLike(input.mode) ? input.mode : 'local'
  const remoteLike = modeIsRemoteLike(mode)

  // The block being edited: a per-profile entry or the global remote block.
  const rawExistingBlock = key ? existing.profiles?.[key] || {} : existing.remote || {}
  // Leaving a CLOUD connection unselects it: a cloud block's url/org/token
  // describe a discovered Hermes Cloud instance, NOT a user-owned remote gateway,
  // so switching to local or remote must NOT inherit them (otherwise the stale
  // cloud URL lingers and re-selecting Cloud looks "already connected"). When the
  // saved block was cloud and the new mode is not cloud, start from an empty
  // block. (remote↔local toggles still preserve a real remote URL as before.)
  const existingMode = key ? existing.profiles?.[key]?.mode : existing.mode
  const leavingCloud = existingMode === 'cloud' && mode !== 'cloud'
  const leavingSsh = rawExistingBlock.mode === 'ssh' && mode !== 'ssh' && mode !== 'local'
  const existingBlock = leavingCloud || leavingSsh ? {} : rawExistingBlock
  const remoteUrl = String(input.remoteUrl ?? existingBlock.url ?? '').trim()
  // authMode: explicit input wins; otherwise inherit the saved value, default 'token'.
  const authMode = resolveAuthMode(input.remoteAuthMode, existingBlock.authMode)
  // Cloud org: only meaningful for 'cloud' mode. Explicit input wins; otherwise
  // inherit the saved org. A plain 'remote' connection never carries an org
  // (switching cloud→remote drops it), so it stays unset unless mode is cloud.
  const cloudOrg = mode === 'cloud' ? String(input.cloudOrg ?? existingBlock.org ?? '').trim() : ''
  const incomingToken = typeof input.remoteToken === 'string' ? input.remoteToken.trim() : ''

  const remoteHeaders =
    input.remoteHeaders && typeof input.remoteHeaders === 'object' ? input.remoteHeaders : existingBlock.headers

  // Persist decision lives in hardening.resolvePersistedRemoteToken so the
  // IPC-propagation seam (allowPlainTextToken → encryptDesktopSecret opt-in) is
  // covered by a focused regression test. Pass allowPlainText through RAW — the
  // helper coerces with `=== true`, so a truthy-non-true value never enables
  // plain-text storage, and that strictness is asserted in exactly one place.
  const nextToken = resolvePersistedRemoteToken({
    incomingToken,
    persistToken,
    existingToken: existingBlock.token,
    allowPlainText: input.allowPlainTextToken,
    encryptSecret: encryptDesktopSecret
  })

  if (mode === 'ssh') {
    const sshBlock = buildSshBlock(input, savedProfileSsh(existing, key) || rawExistingBlock)

    if (key) {
      const profiles = { ...(existing.profiles || {}), [key]: sshBlock }

      return {
        mode: existing.mode === 'ssh' || modeIsRemoteLike(existing.mode) ? existing.mode : 'local',
        remote: existing.remote || {},
        profiles
      }
    }

    return { mode: 'ssh', remote: sshBlock, profiles: existing.profiles || {} }
  }

  if (key) {
    // Per-profile scope: a remote/cloud entry pins this profile to its own
    // backend; a local entry clears the override so the profile inherits the
    // default. The mode tag (remote vs cloud) is preserved on the entry.
    const profiles = { ...(existing.profiles || {}) }

    if (remoteLike) {
      profiles[key] = {
        mode,
        ...buildRemoteBlock(remoteUrl, authMode, nextToken, cloudOrg, remoteHeaders)
      }
    } else {
      const localEntry = localProfileEntry(rawExistingBlock)

      if (localEntry) {
        profiles[key] = localEntry
      } else {
        delete profiles[key]
      }
    }

    return {
      mode: existing.mode === 'ssh' || modeIsRemoteLike(existing.mode) ? existing.mode : 'local',
      remote: existing.remote || {},
      profiles
    }
  }

  const nextRemote = remoteLike
    ? buildRemoteBlock(remoteUrl, authMode, nextToken, cloudOrg, remoteHeaders)
    : existingMode === 'ssh'
      ? rawExistingBlock
      : { url: remoteUrl ? normalizeRemoteBaseUrl(remoteUrl) : remoteUrl, authMode, token: nextToken }

  // Preserve per-profile overrides when saving the global connection.
  return { mode, remote: nextRemote, profiles: existing.profiles || {} }
}

// Build an SSH connection block from a save payload, preserving an
// already-adopted dashboard token from the existing block (the token is minted
// + reconciled at bootstrap, never user-entered). `mode: 'ssh'` is stamped so
// normalizeSshConfig/profileSshOverride recognize it.
function buildSshBlock(input: any, existingBlock: any = {}) {
  // `??` (not `||`) so an explicit '' (user CLEARED the field) wins over the
  // saved value; only a truly absent (undefined) field inherits.
  const merged = normalizeSshConfig({
    mode: 'ssh',
    host: input.sshHost ?? existingBlock.host,
    user: input.sshUser ?? existingBlock.user,
    port: input.sshPort ?? existingBlock.port,
    keyPath: input.sshKeyPath ?? existingBlock.keyPath,
    remoteHermesPath: input.sshRemoteHermesPath ?? existingBlock.remoteHermesPath,
    remoteProfile: input.sshRemoteProfile ?? existingBlock.remoteProfile
  })

  if (!merged) {
    throw new Error('SSH host is required.')
  }

  // Carry forward an already-adopted dashboard token unless the host changed
  // (a different host invalidates the old dashboard's token).
  if (existingBlock.token && existingBlock.host === merged.host) {
    merged.token = existingBlock.token
  }

  return merged
}

/** One live managed-SSH scope: the probe connection plus the remote runtime identity the bootstrap reported. */
export interface SshConnectionEntry {
  ssh: SshConnection
  fingerprint: string
  ownershipId: string
  localPort: number
  remotePort: number
  pid: number
  host: string
  hostLabel: string
  hermesVersion: string
  remotePlatform: RemoteUpdateTarget['platform']
  reused: boolean
  spawnNonce: string
  creationTimeNs: string
  creationTime: string
  startedAt: string
  hermesPath: string
  hermesHome: string
  pythonPath: string
  remoteProfile: string
  registryConnectionId: string
  primaryRegistryScope: boolean
}

export const sshConnections = new Map<string, SshConnectionEntry>()
export const desktopInstallationId = loadOrCreateInstallationId(DESKTOP_INSTALLATION_PATH)

export const managedConnectionUpdates = new Map<string, Promise<any>>()
export const managedConnectionRecoveries = new Map<string, Promise<void>>()

// ── Union agent roster + registry ws-url + fan-out updates (phase 3-5) ─────

// Enumerate every registered connection's profiles concurrently and flatten
// into the union roster. Eager REST enumeration, lazy sockets: local + already
// -dialed sources answer instantly; unreachable ones return an error entry
// instead of failing the whole roster. ssh sources that have never been dialed
// are SKIPPED (connect-on-demand — dialing every ssh box just to list agents
// would spawn tunnels the user never asked for); once dialed, their pooled
// descriptor serves the enumeration like any remote. Last-known SSH profile
// lists are reused so switching the window back to local does not empty Bot Mode.
export const sshRosterCache = new Map<string, string[]>()
export const sshInventoryAttemptedAt = new Map<string, number>()
export const SSH_INVENTORY_RETRY_MS = 60_000

// Stable backend identity per registered connection: the `install_id` its
// /api/status reports (absent on backends older than the field). Enumeration
// runs on the ~5s Bot Mode roster poll and only hits /api/profiles, so the
// status probe is cached per connection with a TTL to avoid doubling roster
// traffic; the Test button refreshes it eagerly. A missing id simply bypasses
// the same-backend roster collapse — fully backward compatible.
export const connectionInstallIds = new Map<string, { id?: string; ts: number }>()
export const INSTALL_ID_TTL_MS = 5 * 60_000
export const INSTALL_ID_NEGATIVE_TTL_MS = 60_000

export function rememberConnectionInstallId(connectionId: string, statusBody: any) {
  const raw = statusBody && typeof statusBody === 'object' ? statusBody.install_id : undefined
  const id = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
  connectionInstallIds.set(connectionId, { id, ts: Date.now() })

  return id
}
