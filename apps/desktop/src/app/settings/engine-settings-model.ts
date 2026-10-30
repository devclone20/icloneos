import { setModelAssignment } from '@/api/models'
import { enEngine } from '@/i18n/en'

/** The engine pane's words in the reader's language (English by default). */
type EngineCopy = typeof enEngine
import { persistString, storedString } from '@/lib/storage'

import { PROVIDER_GROUPS } from './constants'

export const ENGINE_PROVIDER = 'claude-code-cli'
export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' }
] as const
export const INSTALL_COMMAND = 'curl -fsSL https://claude.ai/install.sh | bash'
export const LOGIN_COMMAND = 'claude auth login'
const NOUS_MODEL_KEY = 'iclone.engine.nousModel'
const FALLBACK_SEEN_KEY = 'iclone.engine.fallbackSeen'

/** baseUrl: a custom/local endpoint, by URL only (Hermes clears model.base_url while Claude Code is the engine). */
export type EngineTarget = { baseUrl?: string; model: string; provider: string }

export type ClaudeCodeStatus = Awaited<ReturnType<NonNullable<Window['hermesDesktop']['icloneClaudeCode']>['status']>>
type EngineState = 'checking' | 'not-installed' | 'not-logged-in' | 'ready'

export function engineState(status: ClaudeCodeStatus | null): EngineState {
  if (!status) {
    return 'checking'
  }

  if (!status.installed) {
    return 'not-installed'
  }

  return status.loggedIn ? 'ready' : 'not-logged-in'
}

const PLAN_NAMES: Record<string, string> = { enterprise: 'Enterprise', max: 'Max', pro: 'Pro', team: 'Team' }

export function statusLine(status: ClaudeCodeStatus | null, copy: EngineCopy = enEngine): string {
  switch (engineState(status)) {
    case 'checking':
      return copy.checking

    case 'not-installed':
      return copy.notInstalled

    case 'not-logged-in':
      return copy.notLoggedIn
    default: {
      const plan = status?.subscriptionType ?? ''

      // An unknown plan drops the plan clause instead of naming a plan the user may not have.
      return copy.loggedIn(PLAN_NAMES[plan] ?? '')
    }
  }
}

const pct = (value: null | number | undefined) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : '')

function clock(epochSeconds: null | number | undefined): string {
  if (typeof epochSeconds !== 'number') {
    return ''
  }

  const d = new Date(epochSeconds * 1000)

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** HH:MM:SS of an epoch in ms — the "checked at" stamp of the Status row. */
export function clockOf(epochMs: number): string {
  const d = new Date(epochMs)

  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

export function windowLine(window: ClaudeCodeStatus['window'], copy: EngineCopy = enEngine): string {
  if (!window || (!window.fiveHour && !window.sevenDay)) {
    return copy.windowUnknown
  }

  return copy.window(
    pct(window.fiveHour?.utilization),
    clock(window.fiveHour?.resetsAt),
    pct(window.sevenDay?.utilization)
  )
}

export const readNousModel = () => storedString(NOUS_MODEL_KEY) ?? ''
export const writeNousModel = (model: string) => persistString(NOUS_MODEL_KEY, model)
export const readFallbackSeen = () => Number(storedString(FALLBACK_SEEN_KEY) || 0) || 0
export const writeFallbackSeen = (at: number) => persistString(FALLBACK_SEEN_KEY, String(at))

/** Display name for a provider id, from the Providers catalogue; the raw id when it is not listed. */
export function engineLabel(provider: string): string {
  if (provider === 'nous') {
    return 'Nous'
  }

  const prefix = `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_`

  return PROVIDER_GROUPS.find(group => group.prefix === prefix)?.name ?? provider
}

/** The engine Claude Code falls back to and returns to: whatever is in use now, else what was recorded. */
export function returnTarget(current: EngineTarget | null, recorded: EngineTarget | null): EngineTarget | null {
  if (current?.provider && current.provider !== ENGINE_PROVIDER) {
    return {
      model: current.model,
      provider: current.provider,
      ...(current.baseUrl && current.provider !== 'nous' ? { baseUrl: current.baseUrl } : {})
    }
  }

  return recorded?.provider && recorded.provider !== ENGINE_PROVIDER ? recorded : null
}

/** model.set payload for Settings → Engine (the same route Settings → Model uses). */
export function engineSelection(engine: 'claude' | 'nous', model: string): { model: string; provider: string } {
  return engine === 'claude' ? { model, provider: ENGINE_PROVIDER } : { model, provider: 'nous' }
}

/** model.base_url from the Hermes config record, when it is a plain http(s) URL (credentials in a URL are dropped). */
export function endpointOf(config: unknown): string {
  const model = (config as { model?: unknown } | null)?.model
  const value = model && typeof model === 'object' ? (model as { base_url?: unknown }).base_url : undefined

  if (typeof value !== 'string' || !value || value.length > 300) {
    return ''
  }

  try {
    const url = new URL(value)

    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? value : ''
  } catch {
    return ''
  }
}

/** Why a switch did not happen — a code, never the runtime's own sentence (S27.1: words come from the catalogue). */
type EngineSwitchFailure = 'failed' | 'no-model'

type EngineSwitch = { confirm: true; ok: false } | { ok: false; reason: EngineSwitchFailure } | { ok: true }

/** The pane's line for a refused switch, in the person's language. */
export const switchFailure = (reason: EngineSwitchFailure, copy: EngineCopy = enEngine) =>
  reason === 'no-model' ? copy.switchFailedReason(copy.noModel) : copy.switchFailed

/** One model.set (the route Settings → Model uses) with its answer checked: refused, guarded and failed switches
 *  come back as a code or a confirm step, never as silence and never as the runtime's English. An empty model is
 *  never sent. */
export async function switchEngine(target: EngineTarget, confirmed = false): Promise<EngineSwitch> {
  if (!target.provider || !target.model) {
    return { ok: false, reason: 'no-model' }
  }

  try {
    const result = await setModelAssignment({
      model: target.model,
      provider: target.provider,
      scope: 'main',
      ...(target.baseUrl ? { base_url: target.baseUrl } : {}),
      ...(confirmed ? { confirm_expensive_model: true } : {})
    })

    if (result?.ok) {
      return { ok: true }
    }

    return result?.confirm_required ? { confirm: true, ok: false } : { ok: false, reason: 'failed' }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
