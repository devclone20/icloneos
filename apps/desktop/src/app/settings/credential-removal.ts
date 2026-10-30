import { atom } from 'nanostores'
import { useNavigate } from 'react-router'

import { SETTINGS_ROUTE } from '@/app/routes'
import { deleteCustomEndpoint, deleteEnvVar, disconnectOAuthProvider, getGlobalModelOptions } from '@/hermes'
import { enCredentialRemoval } from '@/i18n/en'
import {
  appendCredentialAudit,
  type CredentialAuditKind,
  type CredentialAuditResult,
  type CredentialAuditSurface
} from '@/lib/credential-audit'
import { openExternalLink } from '@/lib/external-link'
import { readJson, writeJson } from '@/lib/storage'
import { confirm } from '@/store/confirm'
import { notify, notifyError } from '@/store/notifications'
import type { EnvVarInfo, ModelOptionProvider, OAuthProvider } from '@/types/hermes'

type CredentialKind = CredentialAuditKind

export const credentialCopy = enCredentialRemoval

/** Everything the uniform flow needs to confirm, perform, notify and audit. */
export interface RemovalTarget {
  /** Shell command for external providers that ship one (claude-code). */
  command?: string
  docsUrl?: null | string
  /** Runtime prose for external providers with no command (`disconnect_hint`). */
  hint?: null | string
  /** Env-var name, OAuth provider id, endpoint id or gateway host — never a value. */
  id: string
  /** True when this credential backs the current main model provider. */
  isActiveProvider?: boolean
  kind: CredentialKind
  label: string
  /** Custom removal (messaging clear_env, gateway logout, terminal run). */
  perform?: () => Promise<unknown>
  profile?: string
  providerLabel?: string
  /** Model-options slug of the provider this credential backs, when known. */
  providerSlug?: string
  /** Labels of the other credentials that keep authenticating the provider. */
  remaining?: string[]
  surface: CredentialAuditSurface
}

type RemovalResult = { ok: false; error: unknown } | { ok: true; result: Exclude<CredentialAuditResult, 'failed'> }

interface RemovalNotice {
  message?: string
  title?: string
}

// Electron's IPC drops the transport's `statusCode` property, so the renderer
// sees only its message, which main.ts builds as `${statusCode}: ${body}`
// (optionally behind ipcRenderer's "Error invoking remote method …: Error: ").
const TRANSPORT_STATUS = /^(?:Error invoking remote method '[^']*': )?(?:Error: )?(\d{3}): /

/** The HTTP status of a failed request: the structured property first, else
 *  the transport's leading status only — never a "404" elsewhere in the text. */
export function httpStatusOf(err: unknown): number | undefined {
  const structured = err as { status?: unknown; statusCode?: unknown } | null

  for (const value of [structured?.status, structured?.statusCode]) {
    if (typeof value === 'number') {
      return value
    }
  }

  const match = err instanceof Error ? TRANSPORT_STATUS.exec(err.message) : null

  return match ? Number(match[1]) : undefined
}

export function isNotFoundError(err: unknown): boolean {
  return httpStatusOf(err) === 404
}

// DELETE /api/providers/oauth/{id} answers 409 when nothing was stored.
function isNothingStoredError(err: unknown): boolean {
  return httpStatusOf(err) === 409
}

/** A runtime-supplied docs URL, only when it is a web page. */
export function safeDocsUrl(url?: null | string): string | undefined {
  const trimmed = url?.trim() ?? ''

  return /^https?:\/\/[^\s]+$/i.test(trimmed) ? trimmed : undefined
}

export function removalConfirmCopy(target: RemovalTarget): {
  confirmLabel: string
  description: string
  title: string
} {
  const copy = credentialCopy
  const provider = target.providerLabel || target.label
  let description: string
  let confirmLabel = copy.confirmLabel

  switch (target.kind) {
    case 'api_key':
      description = copy.description.api_key(target.id, provider)

      break

    case 'oauth':
      description = copy.description.oauth(provider)

      break

    case 'external':
      if (target.command) {
        description = copy.description.externalCommand(target.command)
        confirmLabel = copy.runInTerminal
      } else {
        description = copy.description.external(provider, target.hint?.trim() || copy.externalDefaultHint)
      }

      break

    case 'custom_endpoint':
      description = copy.description.custom_endpoint

      break

    case 'bot_token':
      description = copy.description.bot_token(target.id)

      break

    case 'memory_secret':
      description = copy.description.memory_secret(target.id)

      break

    default:
      description = ''
  }

  const remaining = target.remaining ?? []

  if (remaining.length > 0) {
    description = `${description} ${copy.alsoSignedIn(provider, joinLabels(remaining), remaining.length)}`.trim()
  } else if (target.isActiveProvider) {
    description = `${description} ${copy.activeProviderNote}`.trim()
  }

  return { confirmLabel, description, title: copy.title(target.label) }
}

/** The one confirm every secret deletion goes through. Sign-out never asks. */
async function confirmRemoval(target: RemovalTarget): Promise<boolean> {
  if (target.kind === 'gateway_session') {
    return true
  }

  return confirm({ destructive: true, ...removalConfirmCopy(target) })
}

export interface RemovalDeps {
  deleteCustomEndpoint: typeof deleteCustomEndpoint
  deleteEnvVar: typeof deleteEnvVar
  disconnectOAuthProvider: typeof disconnectOAuthProvider
}

// Resolved per call and per kind: a host whose '@/hermes' mock (tests) lacks
// one of these exports must still reach the one its removal needs.
const defaultDeps = (): RemovalDeps => ({
  deleteCustomEndpoint: (...args) => deleteCustomEndpoint(...args),
  deleteEnvVar: (...args) => deleteEnvVar(...args),
  disconnectOAuthProvider: (...args) => disconnectOAuthProvider(...args)
})

/** Performs the removal. A 404 (env) / 409 (OAuth) means the state is already
 *  the one asked for, so it resolves as `already_removed`, not an error. */
export async function removeCredential(target: RemovalTarget, provided?: RemovalDeps): Promise<RemovalResult> {
  try {
    const deps = target.perform ? null : (provided ?? defaultDeps())

    if (target.perform) {
      await target.perform()
    } else if (deps && (target.kind === 'api_key' || target.kind === 'memory_secret')) {
      await deps.deleteEnvVar(target.id, target.profile)
    } else if (deps && target.kind === 'oauth') {
      await deps.disconnectOAuthProvider(target.id)
    } else if (deps && target.kind === 'custom_endpoint') {
      await deps.deleteCustomEndpoint(target.id)
    } else {
      throw new Error(`No removal for ${target.kind}`)
    }
  } catch (error) {
    if (isNotFoundError(error) || (target.kind === 'oauth' && isNothingStoredError(error))) {
      return { ok: true, result: 'already_removed' }
    }

    return { error, ok: false }
  }

  if (target.kind === 'gateway_session') {
    return { ok: true, result: 'signed_out' }
  }

  return { ok: true, result: target.kind === 'external' ? 'terminal_started' : 'removed' }
}

/** Notify + audit (+ the active-provider flag). Returns `result.ok`. */
export function afterRemoval(target: RemovalTarget, result: RemovalResult, notice?: RemovalNotice): boolean {
  const copy = credentialCopy

  appendCredentialAudit({
    id: target.id,
    kind: target.kind,
    result: result.ok ? result.result : 'failed',
    surface: target.surface
  })

  if (!result.ok) {
    notifyError(result.error, copy.failed(target.label))

    return false
  }

  const remaining = target.remaining ?? []

  // Another credential still authenticates the provider: it keeps working, so
  // the Model page is not sent to "choose a provider".
  if (
    target.isActiveProvider &&
    target.providerSlug &&
    remaining.length === 0 &&
    result.result !== 'terminal_started'
  ) {
    markCredentialRemoved(target.providerSlug, target.profile)
  }

  const stillSignedIn =
    remaining.length > 0 ? ` ${copy.stillSignedIn(target.providerLabel || target.label, joinLabels(remaining))}` : ''

  // The docs URL comes from the runtime; only a web page may be opened from it.
  const docsUrl = safeDocsUrl(target.docsUrl)

  notify({
    action: docsUrl ? { label: copy.revokeAtProvider, onClick: () => openExternalLink(docsUrl) } : undefined,
    durationMs: 4_000,
    kind: result.result === 'terminal_started' ? 'info' : 'success',
    message:
      notice?.message ??
      `${
        result.result === 'already_removed'
          ? copy.alreadyRemovedMessage(target.label)
          : copy.removedMessage(target.label)
      }${stillSignedIn}`,
    title: notice?.title ?? (result.result === 'signed_out' ? copy.signedOut : copy.removedTitle)
  })

  return true
}

/** Confirm → remove → notify + audit. `null` = the user dismissed the confirm. */
export async function runRemoval(
  target: RemovalTarget,
  options: { deps?: RemovalDeps; notice?: RemovalNotice; onBusy?: (busy: boolean) => void } = {}
): Promise<null | RemovalResult> {
  if (!(await confirmRemoval(target))) {
    return null
  }

  options.onBusy?.(true)

  try {
    const result = await removeCredential(target, options.deps)
    afterRemoval(target, result, options.notice)

    return result
  } finally {
    options.onBusy?.(false)
  }
}

// ── Active provider removed → "choose a provider" ────────────────────────────
// PUT /api/config deep-merges, so the app cannot detach `model.provider`; and
// the runtime keeps the saved model listed for a provider that lost its
// credentials. This app-side flag holds the Model page in its setup state
// until the next successful model save. Never auto-picks another provider.

interface CredentialRemovedFlag {
  at: number
  /** Profile scope the removal happened in ('' = the app-wide active profile). */
  profile: string
  provider: string
}

/** Flags keyed by profile scope ('' = the app-wide active profile), because the
 *  Keys and Model pages are per-iNFT through `scopeProfile`. */
type CredentialRemovedFlags = Record<string, CredentialRemovedFlag>

const CREDENTIAL_REMOVED_KEY = 'iclone.credential-removed.v2'

const scopeKey = (profile?: null | string) => profile?.trim() || ''

function readFlags(): CredentialRemovedFlags {
  const raw = readJson<Record<string, unknown>>(CREDENTIAL_REMOVED_KEY)
  const flags: CredentialRemovedFlags = {}

  if (!raw || typeof raw !== 'object') {
    return flags
  }

  for (const [scope, value] of Object.entries(raw)) {
    const flag = value as Partial<CredentialRemovedFlag> | null

    if (flag && typeof flag.provider === 'string' && typeof flag.at === 'number') {
      flags[scope] = { at: flag.at, profile: scope, provider: flag.provider }
    }
  }

  return flags
}

export const $credentialRemoved = atom<CredentialRemovedFlags>(readFlags())

export function credentialRemovedFor(
  flags: CredentialRemovedFlags,
  profile?: null | string
): CredentialRemovedFlag | null {
  return flags[scopeKey(profile)] ?? null
}

export function markCredentialRemoved(provider: string, profile?: null | string, at = Date.now()) {
  const scope = scopeKey(profile)
  const next = { ...$credentialRemoved.get(), [scope]: { at, profile: scope, provider } }
  writeJson(CREDENTIAL_REMOVED_KEY, next)
  $credentialRemoved.set(next)
}

/** Clears the flag of ONE profile scope; other iNFTs keep theirs. */
export function clearCredentialRemoved(profile?: null | string) {
  const key = scopeKey(profile)
  const current = $credentialRemoved.get()

  if (!(key in current)) {
    return
  }

  const next = { ...current }
  delete next[key]
  writeJson(CREDENTIAL_REMOVED_KEY, Object.keys(next).length ? next : null)
  $credentialRemoved.set(next)
}

export const MODEL_SETTINGS_PATH = `${SETTINGS_ROUTE}?tab=config:model`
export const ACCOUNTS_SETTINGS_PATH = `${SETTINGS_ROUTE}?tab=providers&pview=accounts`

// ── Id mapping: model-options slug ↔ OAuth catalog id ↔ runtime source ───────
const norm = (value: string) => value.trim().toLowerCase().replace(/_/g, '-')

const OAUTH_ALIASES: Record<string, string[]> = {
  anthropic: ['anthropic', 'claude'],
  'claude-code': ['claude-code'],
  'copilot-acp': ['copilot-acp', 'copilot', 'github-copilot'],
  'minimax-oauth': ['minimax-oauth'],
  nous: ['nous', 'nous-portal'],
  'openai-codex': ['openai-codex', 'codex'],
  'qwen-oauth': ['qwen-oauth', 'qwen-code'],
  'xai-oauth': ['xai-oauth', 'grok-oauth']
}

/** True when a model-options slug (or runtime `source`) names this OAuth id. */
export function slugMatchesOAuthId(slug: string, oauthId: string): boolean {
  const s = norm(slug)
  const id = norm(oauthId)

  return s === id || (OAUTH_ALIASES[id] ?? []).includes(s)
}

// Sign-ins that authenticate another provider's slug: the runtime's
// `anthropic` provider also uses Claude Code's stored login.
const OAUTH_BACKS: Record<string, string[]> = { 'claude-code': ['anthropic'] }

/** True when this OAuth/external sign-in authenticates the model provider. */
function oauthBacksSlug(slug: string, oauthId: string): boolean {
  return slugMatchesOAuthId(slug, oauthId) || (OAUTH_BACKS[norm(oauthId)] ?? []).includes(norm(slug))
}

/** "A", "A and B", "A, B and C". */
export function joinLabels(labels: string[]): string {
  return labels.length < 2 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

export function oauthProviderForSlug(slug: string, providers: OAuthProvider[]): OAuthProvider | undefined {
  return providers.find(provider => slugMatchesOAuthId(slug, provider.id))
}

function keyEnvForProvider(provider?: ModelOptionProvider): string | undefined {
  return provider?.auth_type === 'api_key' || !provider?.auth_type ? provider?.key_env || undefined : undefined
}

const isSecretInfo = (info?: EnvVarInfo) => Boolean(info?.is_set && info.is_password)

/** The stored secret env key backing a model provider. Authenticated rows from
 *  GET /api/model/options carry no key_env/auth_type, so the key is found
 *  through GET /api/env's provider grouping; `*_API_KEY` names win ties. */
export function envKeyForProvider(
  provider: ModelOptionProvider | undefined,
  vars: null | Record<string, EnvVarInfo> | undefined
): string | undefined {
  return envKeysForProvider(provider, vars)[0]
}

/** Every stored secret env key backing a model provider, best first. */
function envKeysForProvider(
  provider: ModelOptionProvider | undefined,
  vars: null | Record<string, EnvVarInfo> | undefined
): string[] {
  if (!provider || !vars) {
    return []
  }

  const declared = keyEnvForProvider(provider)
  const slug = norm(provider.slug)

  const keys = Object.entries(vars)
    .filter(([, info]) => isSecretInfo(info) && Boolean(info.provider) && norm(info.provider ?? '') === slug)
    .map(([key]) => key)
    .filter(key => key !== declared)
    .sort((a, b) => Number(b.endsWith('_API_KEY')) - Number(a.endsWith('_API_KEY')) || a.localeCompare(b))

  return declared && isSecretInfo(vars[declared]) ? [declared, ...keys] : keys
}

/** One credential that authenticates a model provider. `manage` = a sign-in
 *  that cannot be disconnected from the app (Providers → Accounts owns it). */
export type ProviderCredential =
  { keyEnv: string; kind: 'api_key'; label: string } | { kind: 'manage' | 'oauth'; label: string; oauth: OAuthProvider }

/** Everything behind a model provider: env secrets first (best first), then
 *  app-disconnectable sign-ins, then sign-ins managed elsewhere.
 *  `vars === null` (GET /api/env unreadable) keeps the row's declared key_env. */
export function providerCredentials(
  provider: ModelOptionProvider,
  vars: null | Record<string, EnvVarInfo>,
  oauthProviders: OAuthProvider[]
): ProviderCredential[] {
  const declared = keyEnvForProvider(provider)
  const keys = vars ? envKeysForProvider(provider, vars) : declared ? [declared] : []

  // A catalog entry signed in from an env var (`source: 'env_var'`, e.g. the
  // `anthropic` row reporting ANTHROPIC_API_KEY) is that same key, not another credential.
  const signIns = oauthProviders.filter(
    oauth => oauth.status?.logged_in && oauth.status.source !== 'env_var' && oauthBacksSlug(provider.slug, oauth.id)
  )

  const disconnectable = (oauth: OAuthProvider) => oauth.disconnectable ?? oauth.flow !== 'external'

  return [
    ...keys.map(keyEnv => ({ keyEnv, kind: 'api_key' as const, label: keyEnv })),
    ...signIns.filter(disconnectable).map(oauth => ({ kind: 'oauth' as const, label: oauth.name, oauth })),
    ...signIns
      .filter(oauth => !disconnectable(oauth))
      .map(oauth => ({ kind: 'manage' as const, label: oauth.name, oauth }))
  ]
}

const fieldEnvSuffix = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')

// The env vars the runtime's memory plugins declare (`env_var` / `env_key` in
// plugins/memory/*), which its payload does not serialise. Keyed by provider,
// then by the field key in upper snake case.
const MEMORY_SECRET_ENV: Record<string, Record<string, string>> = {
  byterover: { API_KEY: 'BRV_API_KEY' },
  hindsight: { API_KEY: 'HINDSIGHT_API_KEY', LLM_API_KEY: 'HINDSIGHT_LLM_API_KEY' },
  honcho: { API_KEY: 'HONCHO_API_KEY' },
  mem0: { API_KEY: 'MEM0_API_KEY' },
  openviking: { API_KEY: 'OPENVIKING_API_KEY' },
  retaindb: { API_KEY: 'RETAINDB_API_KEY' },
  supermemory: { API_KEY: 'SUPERMEMORY_API_KEY' }
}

/** The stored env key behind a memory-provider secret: the declared env var
 *  (field `env_key`, else the runtime's declaration above) when one exists,
 *  else `<PROVIDER>_<FIELD>`, then the provider's only set secret, from
 *  GET /api/env. Undefined = the secret lives elsewhere (e.g. honcho.json). */
export function envKeyForMemorySecret(
  provider: string,
  field: { env_key?: string; key: string },
  vars: null | Record<string, EnvVarInfo> | undefined
): string | undefined {
  if (!vars) {
    return undefined
  }

  const declared =
    field.env_key?.trim() || MEMORY_SECRET_ENV[provider.trim().toLowerCase()]?.[fieldEnvSuffix(field.key)]

  if (declared) {
    return isSecretInfo(vars[declared]) ? declared : undefined
  }

  const prefix = `${provider
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')}_`

  const exact = `${prefix}${fieldEnvSuffix(field.key)}`

  if (isSecretInfo(vars[exact])) {
    return exact
  }

  const candidates = Object.keys(vars).filter(key => key.startsWith(prefix) && isSecretInfo(vars[key]))

  return candidates.length === 1 ? candidates[0] : undefined
}

/** Which current-provider row (if any) a credential backs. Best effort: any
 *  failure resolves to "not active" so the removal itself is never blocked. */
export async function findActiveProviderFor(
  /** `provider` = the key's EnvVarInfo.provider (GET /api/env catalog id). */
  match: { keyEnv?: string; oauthId?: string; provider?: string },
  profile?: string,
  load?: typeof getGlobalModelOptions
): Promise<ModelOptionProvider | undefined> {
  try {
    const response = await (load ?? getGlobalModelOptions)(undefined, profile)

    const current =
      response.providers?.find(provider => provider.is_current) ??
      response.providers?.find(provider => Boolean(response.provider) && provider.slug === response.provider)

    if (!current) {
      return undefined
    }

    // GET /api/env groups each key under the catalog provider `hermes model`
    // uses; authenticated model rows carry no key_env, so that is the link.
    if (match.provider && norm(match.provider) === norm(current.slug)) {
      return current
    }

    if (match.keyEnv && current.key_env === match.keyEnv) {
      return current
    }

    if (match.oauthId && slugMatchesOAuthId(current.slug, match.oauthId)) {
      return current
    }

    return undefined
  } catch {
    return undefined
  }
}

/** `useNavigate` throws outside a router (plugin dialogs, some tests); the
 *  removal flow then simply skips the jump to Settings → Model. Router presence
 *  is stable for a mounted instance, so the hook count never changes. */
export function useOptionalNavigate(): null | ReturnType<typeof useNavigate> {
  try {
    return useNavigate()
  } catch {
    return null
  }
}
