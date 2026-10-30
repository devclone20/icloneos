/**
 * Auto-compact trigger, estimated client-side. No RPC reports it, so this
 * mirrors the runtime's ContextCompressor rules exactly (threshold percent →
 * small-window floor → input budget → MINIMUM_CONTEXT_LENGTH floor →
 * degenerate-window 85 % → absolute `threshold_tokens` cap). Per-model
 * autoraises that live in runtime code are not visible here, which is why the
 * value is always labelled estimated.
 */

import { asFiniteNumber, coerceNumber, isRecord } from '@/iclone-shared/guards'

const DEFAULT_THRESHOLD_PERCENT = 0.5
const MINIMUM_CONTEXT_LENGTH = 64_000
const SMALL_CTX_WINDOW_LIMIT = 512_000
const SMALL_CTX_THRESHOLD_PERCENT = 0.75
const MIN_CTX_TRIGGER_RATIO = 0.85

export interface CompressionSettings {
  enabled: boolean
  modelThresholds: Record<string, number>
  thresholdPercent: number
  thresholdTokensCap: null | number
}

interface AutoCompactEstimate {
  /** Always true until the runtime reports its own trigger. */
  estimated: true
  thresholdPercent: number
  tokens: number
}

const RUNTIME_TRUE = new Set(['1', 'true', 'yes'])

/** Python's `int(v)`: an int-valued number truncates, a string must spell an integer. */
function pythonInt(value: unknown): number | undefined {
  const parsed = coerceNumber(value)

  if (parsed === undefined || (typeof value === 'string' && !/^\s*[+-]?\d+\s*$/.test(value))) {
    return undefined
  }

  return Math.trunc(parsed)
}

/**
 * Reads `compression.*` from a `/api/config` record with the runtime's own
 * coercions (`agent_init.py`): `float(threshold)`, `int(threshold_tokens)`,
 * `str(enabled).lower() in {"true","1","yes"}`, numeric-only model thresholds.
 * Absent keys keep the runtime defaults.
 */
export function compressionSettingsFromConfig(config: unknown): CompressionSettings {
  const compression = isRecord(config) && isRecord(config.compression) ? config.compression : {}
  const percent = coerceNumber(compression.threshold)
  const cap = pythonInt(compression.threshold_tokens)
  const modelThresholds: Record<string, number> = {}

  if (isRecord(compression.model_thresholds)) {
    for (const [key, value] of Object.entries(compression.model_thresholds)) {
      const fraction = asFiniteNumber(value)

      if (fraction !== undefined) {
        modelThresholds[key] = fraction
      }
    }
  }

  return {
    enabled: !('enabled' in compression) || RUNTIME_TRUE.has(String(compression.enabled).toLowerCase()),
    modelThresholds,
    thresholdPercent: percent ?? DEFAULT_THRESHOLD_PERCENT,
    thresholdTokensCap: cap !== undefined && cap > 0 ? cap : null
  }
}

/** Longest substring key of `modelThresholds` contained in `model` wins. */
export function resolveModelThreshold(model: string, modelThresholds: Record<string, number>, base: number): number {
  let bestKey = ''

  for (const key of Object.keys(modelThresholds)) {
    if (key && model.includes(key) && key.length > bestKey.length) {
      bestKey = key
    }
  }

  return bestKey ? (modelThresholds[bestKey] ?? base) : base
}

/** Windows under 512K trigger at no less than 75 % (raise-only). */
export function effectiveThresholdPercent(contextLength: number, thresholdPercent: number): number {
  return contextLength > 0 && contextLength < SMALL_CTX_WINDOW_LIMIT
    ? Math.max(thresholdPercent, SMALL_CTX_THRESHOLD_PERCENT)
    : thresholdPercent
}

/** `(context_length − max_tokens) × percent`, floored at 64K, 85 % when the floor fills the window. */
export function computeThresholdTokens(
  contextLength: number,
  thresholdPercent: number,
  maxTokens: null | number = null
): number {
  let effectiveWindow = contextLength - (maxTokens ?? 0)

  if (effectiveWindow <= 0) {
    effectiveWindow = contextLength
  }

  const floored = Math.max(Math.trunc(effectiveWindow * thresholdPercent), MINIMUM_CONTEXT_LENGTH)

  if (effectiveWindow > 0 && floored >= effectiveWindow) {
    return Math.max(1, Math.min(Math.trunc(effectiveWindow * MIN_CTX_TRIGGER_RATIO), effectiveWindow - 1))
  }

  return floored
}

/**
 * The gateway builds agents with the provider-default `max_tokens` (no output
 * reservation), so `maxTokens` defaults to none, as the runtime does.
 */
export function estimateAutoCompact(
  contextMax: number,
  model: string,
  settings: CompressionSettings,
  maxTokens: null | number = null
): AutoCompactEstimate | null {
  if (!settings.enabled || !(contextMax > 0)) {
    return null
  }

  const percent = effectiveThresholdPercent(
    contextMax,
    resolveModelThreshold(model, settings.modelThresholds, settings.thresholdPercent)
  )

  let tokens = computeThresholdTokens(contextMax, percent, maxTokens)

  if (settings.thresholdTokensCap !== null) {
    tokens = Math.min(tokens, Math.min(settings.thresholdTokensCap, contextMax))
  }

  return { estimated: true, thresholdPercent: percent, tokens }
}
