/**
 * iCLONE OS — number-to-text formatters (sizes, clocks, durations) shared by
 * the electron main process and the renderer. Locale-free by design: the
 * output is the same in every language, as the callers' copy expects.
 */
import { isFiniteNumber } from './guards'

export type ByteUnit = 'B' | 'GB' | 'KB' | 'MB' | 'TB'

const BYTE_UNITS: readonly ByteUnit[] = ['B', 'KB', 'MB', 'GB', 'TB']

export interface FormatBytesOptions {
  /** 1024 (KiB-style, the default) or 1000 (SI). */
  base?: 1000 | 1024 | undefined
  /** The smallest unit shown (default 'B'). */
  minUnit?: ByteUnit | undefined
  /** The largest unit shown (default 'TB'); larger sizes stay in it. */
  maxUnit?: ByteUnit | undefined
  /**
   * Digits after the point for units above B (bytes are always whole): a fixed count, one count per unit
   * (missing units → 0), or 'adaptive' (the default) = one digit below 10, none from 10 on.
   */
  fractionDigits?: 'adaptive' | number | Partial<Record<ByteUnit, number>> | undefined
}

function fractionDigitsFor(unit: ByteUnit, value: number, spec: FormatBytesOptions['fractionDigits']): number {
  if (unit === 'B') {
    return 0
  }

  if (typeof spec === 'number') {
    return spec
  }

  if (spec === undefined || spec === 'adaptive') {
    return value >= 10 ? 0 : 1
  }

  return spec[unit] ?? 0
}

function knownUnit(unit: ByteUnit | undefined, fallback: ByteUnit): ByteUnit {
  return unit !== undefined && BYTE_UNITS.includes(unit) ? unit : fallback
}

/** "512 B", "1.5 KB", "15 MB"… Callers handle "unknown" (0 / missing) sizes themselves. */
export function formatBytes(bytes: number, options: FormatBytesOptions = {}): string {
  const base = options.base === 1000 ? 1000 : 1024
  const minIndex = BYTE_UNITS.indexOf(knownUnit(options.minUnit, 'B'))
  const maxIndex = BYTE_UNITS.indexOf(knownUnit(options.maxUnit, 'TB'))
  let unit = knownUnit(options.minUnit, 'B')
  let value = bytes / base ** minIndex

  for (const next of BYTE_UNITS.slice(minIndex + 1, maxIndex + 1)) {
    if (!(value >= base)) {
      break
    }

    value /= base
    unit = next
  }

  return `${value.toFixed(fractionDigitsFor(unit, value, options.fractionDigits))} ${unit}`
}

export interface FormatClockOptions {
  /** 'auto' (default): "H:MM:SS" from one hour on. 'never': minutes keep counting ("75:04"). */
  hours?: 'auto' | 'never' | undefined
}

/** Whole seconds as a clock: "4:05", "1:02:03". Fractions are floored; negatives read as 0. */
export function formatClock(totalSeconds: number, options: FormatClockOptions = {}): string {
  const whole = Math.max(0, Math.floor(totalSeconds))
  const seconds = String(whole % 60).padStart(2, '0')
  const minutes = Math.floor(whole / 60)

  if (options.hours === 'never' || minutes < 60) {
    return `${minutes}:${seconds}`
  }

  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`
}

/** "42s" under a minute, then "M:SS". Fractions are floored; negatives read as "0s". */
export function formatElapsedSeconds(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds))

  return whole < 60 ? `${whole}s` : formatClock(whole, { hours: 'never' })
}

/** "850 ms", "4.2s", then "3m 7s" (whole seconds, carried into the minutes). '' for a non-finite value. */
export function formatDurationMs(ms: unknown): string {
  if (!isFiniteNumber(ms)) {
    return ''
  }

  if (ms < 1000) {
    return `${ms} ms`
  }

  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`
  }

  const totalSeconds = Math.round(ms / 1000)

  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
}
