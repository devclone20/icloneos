import { type CSSProperties } from 'react'

import { createParticleEmitter, ParticleField, type ParticleFieldConfig } from '@/components/particles/particle-field'
import { $vibeHeartsEnabled } from '@/store/vibe-hearts-enabled'

/**
 * TikTok-style floating hearts — a thin skin over {@link ParticleField} (pixel
 * heart glyph + pink), rising from the composer. Fired by the core `reaction`
 * event (affection in a user message) via {@link burstVibeHearts}. Gated by Settings → Appearance
 * → Vibe Hearts (`$vibeHeartsEnabled`), on by default.
 */

// A token, not a hex: the hearts are chrome, so the skin retints them with
// everything else (--ic-red-100 is our light pink, which reads on the light and
// the dark chat surface alike). The value lands on `--particle-color`, a CSS
// custom property, so a `var()` resolves there exactly as a literal did.
const HEART_COLORS = ['var(--ic-red-100)'] as const

/** Composer placement: hearts rise the thread height (rise = % of the tall lane). */
export const COMPOSER_HEART_CONFIG: Partial<ParticleFieldConfig> = {
  count: 12,
  size: [6, 13],
  rise: [6.75, 15.75],
  duration: [320, 700]
}

// Pixel-art heart from @nous-research/ui (14×12), crisp + `currentColor`.
const HEART_GLYPH = (
  <svg fill="none" shapeRendering="crispEdges" viewBox="0 0 14 12" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M13.2 0v5.65714h-1.8857v1.88572H9.42857v1.88571H7.54286v1.88573H5.65714V9.42857H3.77143V7.54286H1.88571V5.65714H0V0h5.65714v1.88571h1.88572V0z"
      fill="currentColor"
    />
  </svg>
)

const emitter = createParticleEmitter()

/** Fire a vibe burst (from the core `reaction` event) on the mounted composer field. */
export const burstVibeHearts = (count?: number) => {
  if (!$vibeHeartsEnabled.get()) {
    return
  }

  emitter.burst(count)
}

interface HeartFieldProps {
  config?: Partial<ParticleFieldConfig>
  className?: string
  style?: CSSProperties
}

/** Heart-skinned particle field. Caller supplies placement + a config preset. */
export function HeartField({ config, className, style }: HeartFieldProps) {
  return (
    <ParticleField
      className={className}
      colors={HEART_COLORS}
      config={config}
      emitter={emitter}
      glyph={HEART_GLYPH}
      style={style}
    />
  )
}
