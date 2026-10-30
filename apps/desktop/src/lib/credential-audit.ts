import { readJson, writeJson } from '@/lib/storage'

export const CREDENTIAL_AUDIT_KEY = 'iclone.credential-audit.v1'
export const CREDENTIAL_AUDIT_MAX = 50

export type CredentialAuditKind =
  'api_key' | 'bot_token' | 'custom_endpoint' | 'external' | 'gateway_session' | 'memory_secret' | 'oauth'

export type CredentialAuditResult = 'already_removed' | 'failed' | 'removed' | 'signed_out' | 'terminal_started'

export type CredentialAuditSurface =
  'accounts' | 'cloud' | 'custom_endpoints' | 'gateway' | 'keys' | 'memory' | 'messaging' | 'model' | 'provider_keys'

/** One audit line. Names only: `id` is an env-var name, provider id or
 *  endpoint id — never a value, token or redacted preview. */
export interface CredentialAuditEntry {
  id: string
  kind: CredentialAuditKind
  result: CredentialAuditResult
  surface: CredentialAuditSurface
  ts: number
}

const KINDS = new Set<string>([
  'api_key',
  'bot_token',
  'custom_endpoint',
  'external',
  'gateway_session',
  'memory_secret',
  'oauth'
])

const RESULTS = new Set<string>(['already_removed', 'failed', 'removed', 'signed_out', 'terminal_started'])

const SURFACES = new Set<string>([
  'accounts',
  'cloud',
  'custom_endpoints',
  'gateway',
  'keys',
  'memory',
  'messaging',
  'model',
  'provider_keys'
])

const ID_MAX = 96
const listeners = new Set<() => void>()

/** Reduce an identifier to a short, printable name (no whitespace, no quotes). */
export function auditSafeId(id: string): string {
  const clean = String(id ?? '')
    .replace(/[^\w.:@/+-]/g, '_')
    .slice(0, ID_MAX)

  return clean || 'unknown'
}

function isEntry(value: unknown): value is CredentialAuditEntry {
  if (!value || typeof value !== 'object') {
    return false
  }

  const entry = value as Record<string, unknown>

  return (
    typeof entry.id === 'string' &&
    typeof entry.ts === 'number' &&
    KINDS.has(String(entry.kind)) &&
    RESULTS.has(String(entry.result)) &&
    SURFACES.has(String(entry.surface))
  )
}

/** Newest first. Malformed rows (older builds, manual edits) are dropped. */
export function readCredentialAudit(): CredentialAuditEntry[] {
  const raw = readJson<unknown>(CREDENTIAL_AUDIT_KEY)

  if (!Array.isArray(raw)) {
    return []
  }

  return raw.filter(isEntry).map(pick)
}

// Builds a fresh object from the five allowed fields so a caller passing a
// wider object (a row with `value`, `redacted_value`, …) cannot leak it.
function pick(entry: CredentialAuditEntry): CredentialAuditEntry {
  return {
    id: auditSafeId(entry.id),
    kind: entry.kind,
    result: entry.result,
    surface: entry.surface,
    ts: entry.ts
  }
}

// Read-modify-write under one key. Several windows may write; the last writer
// wins, which can drop a concurrent line — acceptable for a local history.
export function appendCredentialAudit(input: Omit<CredentialAuditEntry, 'ts'> & { ts?: number }): CredentialAuditEntry {
  const entry = pick({ ...input, ts: input.ts ?? Date.now() })
  const next = [entry, ...readCredentialAudit()].slice(0, CREDENTIAL_AUDIT_MAX)
  writeJson(CREDENTIAL_AUDIT_KEY, next)
  listeners.forEach(listener => listener())

  return entry
}

export function subscribeCredentialAudit(listener: () => void): () => void {
  listeners.add(listener)

  const onStorage = (event: StorageEvent) => {
    if (event.key === CREDENTIAL_AUDIT_KEY) {
      listener()
    }
  }

  window.addEventListener('storage', onStorage)

  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}
