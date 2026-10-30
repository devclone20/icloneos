import { Tip } from '@/components/ui/tooltip'
import { appendCredentialAudit, type CredentialAuditSurface } from '@/lib/credential-audit'
import type { Monitor } from '@/lib/icons'
import { Check, HelpCircle } from '@/lib/icons'
import { selectableCardClass } from '@/lib/selectable-card'
import { cn } from '@/lib/utils'

// Sign-out is one click (it only drops local cookies/tokens and is undone by
// signing in again) — no confirm, but it still leaves an audit line. The id is
// the host only: a connection URL can carry query secrets.
export function auditSignOut(url: string, surface: CredentialAuditSurface, result: 'failed' | 'signed_out') {
  let id = url

  try {
    id = new URL(url).host || url
  } catch {
    id = url.replace(/[?#].*$/, '')
  }

  appendCredentialAudit({ id, kind: 'gateway_session', result, surface })
}

type Mode = 'local' | 'remote' | 'cloud' | 'ssh'
export type AuthMode = 'oauth' | 'token'
export type ProbeStatus = 'idle' | 'probing' | 'done' | 'error'
// Hermes Cloud discovery lifecycle for the cloud-mode panel.
export type CloudDiscoverStatus = 'idle' | 'loading' | 'done' | 'error'

export interface GatewaySettingsState {
  envOverride: boolean
  mode: Mode
  remoteAuthMode: AuthMode
  remoteOauthConnected: boolean
  remoteTokenPreview: string | null
  remoteTokenSet: boolean
  // Whether OS-keychain-backed encryption (Electron safeStorage) is available.
  // Default true so we never gate on a value we haven't hydrated yet.
  secureTokenStorage: boolean
  // Whether the currently-persisted remote token is stored as plain text on
  // disk (opted-in on a machine without secure storage). Drives the warning banner.
  remoteTokenPlainText: boolean
  remoteUrl: string
  cloudOrg: string
  sshHost: string
  sshUser: string
  sshPort: number | null
  sshKeyPath: string
  sshRemoteHermesPath: string
  sshRemoteProfile: string
}

export const SSH_HOST_CUSTOM = '__custom__'

export const EMPTY_STATE: GatewaySettingsState = {
  envOverride: false,
  mode: 'local',
  remoteAuthMode: 'token',
  remoteOauthConnected: false,
  remoteTokenPreview: null,
  remoteTokenSet: false,
  secureTokenStorage: true,
  remoteTokenPlainText: false,
  remoteUrl: '',
  cloudOrg: '',
  sshHost: '',
  sshUser: '',
  sshPort: null,
  sshKeyPath: '',
  sshRemoteHermesPath: '',
  sshRemoteProfile: ''
}

export function normalizeGatewaySettingsState(
  config: Partial<GatewaySettingsState> | null | undefined
): GatewaySettingsState {
  if (!config || typeof config !== 'object') {
    return { ...EMPTY_STATE }
  }

  const defined = Object.fromEntries(Object.entries(config).filter(([, value]) => value != null))

  return { ...EMPTY_STATE, ...defined }
}

export function savedCloudConnectionUrl(config: Pick<GatewaySettingsState, 'mode' | 'remoteUrl'>): string {
  return config.mode === 'cloud' ? config.remoteUrl.trim().replace(/\/+$/, '').toLowerCase() : ''
}

export function ModeCard({
  active,
  description,
  disabled,
  hint,
  icon: Icon,
  onSelect,
  title
}: {
  active: boolean
  description: string
  disabled?: boolean
  hint?: string
  icon: typeof Monitor
  onSelect: () => void
  title: string
}) {
  return (
    <button
      className={cn(
        'flex h-full min-h-0 w-full flex-col p-3 text-left disabled:cursor-not-allowed disabled:opacity-50',
        selectableCardClass({ active, prominent: true })
      )}
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 text-[length:var(--conversation-text-font-size)] font-medium">{title}</span>
        {hint ? (
          <Tip label={hint}>
            <span
              className="grid size-3.5 shrink-0 cursor-help place-items-center text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)"
              onClick={event => event.stopPropagation()}
            >
              <HelpCircle className="size-3.5" />
            </span>
          </Tip>
        ) : null}
        {active ? <Check className="ml-auto size-3.5 shrink-0 text-primary" /> : null}
      </div>
      <p className="mt-1.5 flex-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
        {description}
      </p>
    </button>
  )
}
