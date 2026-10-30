import { atom } from 'nanostores'

import { routeDefaultEffort, routeEffortLevels, type RouteOptions, RUNTIME_EFFORT_ROUTES } from '@/lib/reasoning-levels'
import { persistString, storedString } from '@/lib/storage'
import { normalize } from '@/lib/text'

import { notifyError } from './notifications'
import {
  markComposerSelectionManual,
  setCurrentFastMode,
  setCurrentReasoningEffort,
  setReasoningEffortWire
} from './session'
import { sessionTileDelegate } from './session-states'

const STORAGE_KEY = 'hermes.desktop.model-presets'

/** Per-model reasoning/fast preset, remembered globally across sessions and
 *  re-applied to the session whenever that model is selected. An unset effort
 *  keeps the session's level when the new route lists it, else takes the
 *  route's default (`presetForSwitch`); unset fast stays as it is. */
interface ModelPreset {
  effort?: string
  fast?: boolean
}

type RequestGateway = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

/** Stable `provider::model` key (matches the visibility-store format). */
export const modelPresetKey = (provider: string, model: string): string => `${provider}::${model}`

function load(): Record<string, ModelPreset> {
  const raw = storedString(STORAGE_KEY)

  if (!raw) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw)

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, ModelPreset>) : {}
  } catch {
    return {}
  }
}

export const $modelPresets = atom<Record<string, ModelPreset>>(load())

export function getModelPreset(provider: string, model: string): ModelPreset {
  return $modelPresets.get()[modelPresetKey(provider, model)] ?? {}
}

/** Merge a partial preset for one model and persist. */
export function setModelPreset(provider: string, model: string, patch: ModelPreset): void {
  const key = modelPresetKey(provider, model)
  const next = { ...$modelPresets.get(), [key]: { ...$modelPresets.get()[key], ...patch } }

  $modelPresets.set(next)
  persistString(STORAGE_KEY, JSON.stringify(next))
}

/** Put one model's remembered effort back exactly: `undefined` (or '') removes
 *  the key, and a preset left empty is dropped — '' is never persisted. */
function restoreModelPresetEffort(provider: string, model: string, effort: string | undefined): void {
  const key = modelPresetKey(provider, model)
  const { [key]: current, ...others } = $modelPresets.get()
  const { effort: _dropped, ...rest } = current ?? {}
  const preset: ModelPreset = effort ? { ...rest, effort } : rest
  const next = Object.keys(preset).length ? { ...others, [key]: preset } : others

  $modelPresets.set(next)
  persistString(STORAGE_KEY, JSON.stringify(next))
}

/**
 * The preset to apply when switching to (provider, model): the remembered one,
 * and when it has no effort while the session's current level is not one the
 * new route sends, the route's default — the previous model's level never
 * carries over onto a route that does not list it. `currentEffort` is the
 * session's explicit level ('' = the profile default applies, left to the
 * runtime). Routes without levels (no effort knob, or contract types without
 * the table) leave effort unset.
 */
export function presetForSwitch(
  provider: string,
  model: string,
  preset: ModelPreset,
  currentEffort: string,
  options: RouteOptions = {}
): ModelPreset {
  if (preset.effort !== undefined) {
    return preset
  }

  const table = options.table === undefined ? RUNTIME_EFFORT_ROUTES : options.table
  const levels = routeEffortLevels(provider, model, { ...options, table })
  const current = normalize(currentEffort)

  if (!table || !current || !levels.length || levels.includes(current)) {
    return preset
  }

  return { ...preset, effort: routeDefaultEffort(levels, table.ladder) }
}

/** The one `config.set` frame that changes a session's reasoning effort. */
export const reasoningConfigSetParams = (sessionId: string, value: string) => ({
  key: 'reasoning',
  session_id: sessionId,
  value
})

/** Apply a model's preset to the composer, then push it to a live session.
 *  `undefined` skips that dimension; values are capability-gated upstream.
 *  Without a session the local draft still needs the preset, but must not call
 *  `config.set`: that falls back to persistent profile config when no session
 *  matches and would rewrite the user's defaults.
 *
 *  `primary: false` scopes the optimistic write to the tile's session slice —
 *  a tile's picker must not clobber the primary composer's effort/fast. */
export async function applyModelPreset(
  { effort, fast }: ModelPreset,
  ctx: { failMessage: string; primary?: boolean; request: RequestGateway; sessionId: null | string }
): Promise<void> {
  if (ctx.primary ?? true) {
    if (effort !== undefined) {
      setCurrentReasoningEffort(effort)
    }

    if (fast !== undefined) {
      setCurrentFastMode(fast)
    }
  } else if (ctx.sessionId) {
    sessionTileDelegate()?.updateSession(ctx.sessionId, state => ({
      ...state,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
      ...(fast !== undefined ? { fast } : {})
    }))
  }

  if (!ctx.sessionId) {
    return
  }

  try {
    if (effort !== undefined) {
      await ctx.request('config.set', reasoningConfigSetParams(ctx.sessionId, effort))
    }

    if (fast !== undefined) {
      await ctx.request('config.set', { key: 'fast', session_id: ctx.sessionId, value: fast ? 'fast' : 'normal' })
    }
  } catch (err) {
    notifyError(err, ctx.failMessage)
  }
}

/** Pick a reasoning level for one model from the composer: remember it as that
 *  model's preset, apply it optimistically to the surface that owns it, then
 *  write it to the live session. The wire echo is cleared until the next
 *  `session.info` reports what the route sends. A failed write rolls the
 *  surface back to `previous` and the model's preset back to what it was
 *  before the pick, each only when no newer pick has started for it; returns
 *  whether the level is now in effect. */
// Picks per model preset key and per surface: a write that fails after a newer
// pick started must not roll that newer pick back.
const pickGenerations = new Map<string, number>()

const nextPick = (key: string): number => {
  const generation = (pickGenerations.get(key) ?? 0) + 1

  pickGenerations.set(key, generation)

  return generation
}

const isLatestPick = (key: string, generation: number): boolean => pickGenerations.get(key) === generation

export async function selectModelEffort(
  { effort, model, previous, provider }: { effort: string; model: string; previous: string; provider: string },
  ctx: { failMessage: string; primary: boolean; request: RequestGateway; sessionId: null | string }
): Promise<boolean> {
  const apply = (value: string) => {
    if (ctx.primary) {
      setCurrentReasoningEffort(value)
    } else if (ctx.sessionId) {
      sessionTileDelegate()?.updateSession(ctx.sessionId, state => ({ ...state, reasoningEffort: value }))
    }
  }

  if (ctx.primary) {
    markComposerSelectionManual()
    setReasoningEffortWire('')
  }

  const presetKey = `preset:${modelPresetKey(provider, model)}`
  const surfaceKey = ctx.primary ? 'surface:primary' : `surface:${ctx.sessionId ?? ''}`
  const presetPick = nextPick(presetKey)
  const surfacePick = nextPick(surfaceKey)
  const remembered = getModelPreset(provider, model).effort

  setModelPreset(provider, model, { effort })
  apply(effort)

  // Preset-only without a session: `config.set` falls back to the profile
  // config when no session matches and would rewrite the user's default.
  if (!ctx.sessionId) {
    return true
  }

  try {
    await ctx.request('config.set', reasoningConfigSetParams(ctx.sessionId, effort))

    return true
  } catch (err) {
    if (isLatestPick(surfaceKey, surfacePick)) {
      apply(previous)
    }

    if (isLatestPick(presetKey, presetPick)) {
      restoreModelPresetEffort(provider, model, remembered)
    }

    notifyError(err, ctx.failMessage)

    return false
  }
}
