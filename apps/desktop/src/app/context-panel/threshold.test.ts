import { describe, expect, it } from 'vitest'

import {
  compressionSettingsFromConfig,
  computeThresholdTokens,
  effectiveThresholdPercent,
  estimateAutoCompact,
  resolveModelThreshold
} from './threshold'

// Reference values printed by the runtime itself (2026-10-18, lab backend):
// ContextCompressor._compute_threshold_tokens(ctx, _effective_threshold_percent(ctx, pct), max_tokens).
const RUNTIME_REFERENCE: [ctx: number, pct: number, maxTokens: null | number, effective: number, tokens: number][] = [
  [64_000, 0.5, null, 0.75, 54_400],
  [128_000, 0.5, null, 0.75, 96_000],
  [200_000, 0.5, null, 0.75, 150_000],
  [200_000, 0.8, null, 0.8, 160_000],
  [1_000_000, 0.5, null, 0.5, 500_000],
  [1_050_000, 0.5, 65_536, 0.5, 492_232],
  [400_000, 0.5, 32_000, 0.75, 276_000],
  [32_000, 0.5, null, 0.75, 27_200],
  [100_000, 0.5, null, 0.75, 75_000],
  [272_000, 0.85, null, 0.85, 231_200]
]

const DEFAULTS = compressionSettingsFromConfig({})

describe('auto-compact threshold (mirror of the runtime ContextCompressor)', () => {
  it.each(RUNTIME_REFERENCE)(
    'ctx %i at %f (max_tokens %s) → %f → %i tokens',
    (ctx, pct, maxTokens, effective, tokens) => {
      expect(effectiveThresholdPercent(ctx, pct)).toBe(effective)
      expect(computeThresholdTokens(ctx, effective, maxTokens)).toBe(tokens)
    }
  )

  it('estimates 64K / 200K / 1M windows from default settings within ±1 token', () => {
    for (const [ctx, expected] of [
      [64_000, 54_400],
      [200_000, 150_000],
      [1_000_000, 500_000]
    ] as const) {
      const estimate = estimateAutoCompact(ctx, 'any/model', DEFAULTS)

      expect(estimate?.estimated).toBe(true)
      expect(Math.abs((estimate?.tokens ?? 0) - expected)).toBeLessThanOrEqual(1)
    }
  })

  it('falls back to the full window when max_tokens swallows it', () => {
    expect(computeThresholdTokens(100_000, 0.75, 200_000)).toBe(75_000)
  })

  it('applies the absolute cap, itself capped at the window', () => {
    const capped = compressionSettingsFromConfig({ compression: { threshold_tokens: 90_000 } })
    const huge = compressionSettingsFromConfig({ compression: { threshold_tokens: 5_000_000 } })

    expect(estimateAutoCompact(1_000_000, 'm', capped)?.tokens).toBe(90_000)
    expect(estimateAutoCompact(1_000_000, 'm', huge)?.tokens).toBe(500_000)
  })

  it('resolves per-model overrides by the longest matching key', () => {
    const table = { 'glm-5.2': 0.6, 'glm-5.2-1M': 0.9 }

    expect(resolveModelThreshold('zai/glm-5.2-1M', table, 0.5)).toBe(0.9)
    expect(resolveModelThreshold('zai/glm-5.2', table, 0.5)).toBe(0.6)
    expect(resolveModelThreshold('other', table, 0.5)).toBe(0.5)
    expect(resolveModelThreshold('', table, 0.5)).toBe(0.5)
  })

  it('reads compression settings from the config record, keeping runtime defaults for absent keys', () => {
    expect(DEFAULTS).toEqual({ enabled: true, modelThresholds: {}, thresholdPercent: 0.5, thresholdTokensCap: null })

    expect(
      compressionSettingsFromConfig({
        compression: {
          enabled: false,
          model_thresholds: { a: 0.7, b: 'x', c: true },
          threshold: 0.65,
          threshold_tokens: 0
        }
      })
    ).toEqual({ enabled: false, modelThresholds: { a: 0.7 }, thresholdPercent: 0.65, thresholdTokensCap: null })

    expect(compressionSettingsFromConfig(null).thresholdPercent).toBe(0.5)
  })

  // agent_init.py: float(threshold), int(threshold_tokens) (bad text → None),
  // str(enabled).lower() in {"true", "1", "yes"}; model thresholds numbers only.
  it.each([
    [
      { threshold: '0.8', threshold_tokens: '120000' },
      { enabled: true, thresholdPercent: 0.8, thresholdTokensCap: 120_000 }
    ],
    [
      { threshold: ' 0.6 ', threshold_tokens: 150_000.9 },
      { thresholdPercent: 0.6, thresholdTokensCap: 150_000 }
    ],
    [
      { threshold: 'high', threshold_tokens: '1.5e5' },
      { thresholdPercent: 0.5, thresholdTokensCap: null }
    ],
    [{ threshold_tokens: '-5' }, { thresholdTokensCap: null }],
    [{ enabled: 'false' }, { enabled: false }],
    [{ enabled: 'Yes' }, { enabled: true }],
    [{ enabled: 1 }, { enabled: true }],
    [{ enabled: 0 }, { enabled: false }],
    [{ enabled: null }, { enabled: false }]
  ])('coerces %j exactly like the runtime', (compression, expected) => {
    expect(compressionSettingsFromConfig({ compression })).toMatchObject(expected)
  })

  it('reports nothing when compression is off or the window is unknown', () => {
    expect(estimateAutoCompact(200_000, 'm', { ...DEFAULTS, enabled: false })).toBeNull()
    expect(estimateAutoCompact(0, 'm', DEFAULTS)).toBeNull()
  })
})
