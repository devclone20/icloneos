import type { DesktopConnectionKind, DesktopRegistryConnection } from '@/global'
import { Cloud, Globe, Monitor, Terminal } from '@/lib/icons'

// Pure helpers of the Connections registry (moved verbatim from connections-registry.tsx, 2026-10-20 I-D r2).
export const KIND_ICONS: Record<DesktopConnectionKind, typeof Globe> = {
  cloud: Cloud,
  local: Monitor,
  remote: Globe,
  ssh: Terminal
}

export interface EditorState {
  // null id → creating a new connection.
  id: null | string
  kind: DesktopConnectionKind
  label: string
  url: string
  authMode: 'oauth' | 'token'
  token: string
  host: string
  keyPath: string
  // ssh remote profile, hydrated on edit so the duplicate key matches the
  // main-process one (user@host:port + profile); the editor doesn't expose it.
  remoteProfile: string
  // Extra gateway headers (access proxies such as Cloudflare Access).
  // `value: ''` on a row that came from storage means "keep the saved
  // secret" (sent as null); a typed value replaces it; a removed row clears
  // it. `stored` marks rows hydrated from headerNames so the placeholder can
  // say "saved" instead of demanding a value.
  headers: { name: string; stored: boolean; value: string }[]
}

export function editorFromConnection(conn: DesktopRegistryConnection): EditorState {
  return {
    id: conn.id,
    kind: conn.kind,
    label: conn.label,
    url: conn.url || '',
    authMode: conn.authMode || 'token',
    token: '',
    // Reconstruct the composite the single ssh host field displays. The save
    // payload sends ONLY this string (never separate user/port), because
    // normalizeSshConfig gives explicit user/port fields precedence over the
    // parsed host string — sending stored user/port alongside a retyped host
    // would silently resurrect the old values.
    host: conn.host ? `${conn.user ? `${conn.user}@` : ''}${conn.host}${conn.port ? `:${conn.port}` : ''}` : '',
    keyPath: conn.keyPath || '',
    remoteProfile: conn.remoteProfile || '',
    headers: (conn.headerNames || []).map(name => ({ name, stored: true, value: '' }))
  }
}

export function emptyEditor(kind: DesktopConnectionKind): EditorState {
  return {
    id: null,
    kind,
    label: '',
    url: '',
    authMode: 'token',
    token: '',
    host: '',
    keyPath: '',
    remoteProfile: '',
    headers: []
  }
}

/** Dedupe key for a remote/cloud gateway URL: trim, drop trailing slashes, lowercase. */
export function normalizeGatewayUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * Dedupe key for the composite ssh host string the editor shows
 * (`user@host:port`, user/port optional): normalized to `user@host:port` with
 * the default port made explicit so `box` and `box:22` collide.
 */
export function sshCompositeKey(composite: string): string {
  const raw = composite.trim().toLowerCase()

  if (!raw) {
    return ''
  }

  const at = raw.lastIndexOf('@')
  const user = at > 0 ? raw.slice(0, at) : ''
  const rest = at >= 0 ? raw.slice(at + 1) : raw
  const portMatch = rest.match(/^(.*?):(\d+)$/)
  const host = portMatch ? portMatch[1] : rest
  const port = portMatch ? portMatch[2] : '22'

  if (!host) {
    return ''
  }

  return `${user}@${host}:${port}`
}

/**
 * The renderer-side duplicate rule, mirrored by the main process
 * (normalizeConnectionInput enforces the same keys in the save path):
 *  - at most ONE local entry, ever;
 *  - remote/cloud entries are duplicates when their normalized URLs match;
 *  - ssh entries are duplicates on user@host:port + remote profile.
 * Returns the existing entry the candidate collides with, or null.
 */
export function findDuplicateConnection(
  editor: Pick<EditorState, 'host' | 'id' | 'kind' | 'remoteProfile' | 'url'>,
  connections: DesktopRegistryConnection[]
): DesktopRegistryConnection | null {
  if (editor.kind === 'local') {
    return connections.find(c => c.kind === 'local' && c.id !== editor.id) ?? null
  }

  if (editor.kind === 'remote' || editor.kind === 'cloud') {
    const key = normalizeGatewayUrl(editor.url)

    if (!key) {
      return null
    }

    return (
      connections.find(
        c =>
          (c.kind === 'remote' || c.kind === 'cloud') && c.id !== editor.id && normalizeGatewayUrl(c.url || '') === key
      ) ?? null
    )
  }

  const key = sshCompositeKey(editor.host)

  if (!key) {
    return null
  }

  const profile = editor.remoteProfile.trim()

  return (
    connections.find(
      c =>
        c.kind === 'ssh' &&
        c.id !== editor.id &&
        sshCompositeKey(`${c.user ? `${c.user}@` : ''}${c.host ?? ''}${c.port ? `:${c.port}` : ''}`) === key &&
        (c.remoteProfile || '').trim() === profile
    ) ?? null
  )
}

/**
 * Display-only same-backend hint: when two registered connections report the
 * same /api/status install_id, they are one physical backend registered under
 * two addresses (hostname + Tailscale IP). Returns the label of the FIRST
 * earlier sibling sharing this connection's id, or null. Never blocks or
 * deletes — dual routes are legitimate failover config; the roster already
 * collapses the duplicate bot rows.
 */
export function sameBackendPeerLabel(
  conn: Pick<DesktopRegistryConnection, 'id' | 'installId'>,
  connections: Pick<DesktopRegistryConnection, 'id' | 'installId' | 'label'>[]
): null | string {
  if (!conn.installId) {
    return null
  }

  for (const other of connections) {
    if (other.id === conn.id) {
      // Only rows AFTER the first occurrence carry the hint, so exactly one
      // of a same-backend pair is annotated (the later-listed one).
      return null
    }

    if (other.installId === conn.installId) {
      return other.label
    }
  }

  return null
}

export function scrollableAncestor(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement

  while (parent) {
    if (/(auto|scroll)/.test(window.getComputedStyle(parent).overflowY)) {
      return parent
    }

    parent = parent.parentElement
  }

  return null
}

/**
 * The connections registry section of Settings → Gateways: manage the named
 * agent sources (local runtime + any number of remote gateways / Hermes Cloud
 * instances / SSH hosts). Storage-level management — the active/primary
 * switchover UX is the connection-mode controls above this section.
 */
