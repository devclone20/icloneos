/** The market data module's `primitives` section — its public names are re-exported by ../market-data.ts. */
import { asArray, asRecord, type Json } from '../../cli'

// ── tolerant primitives ─────────────────────────────────────────────────────

export function finiteOrNull(value: unknown): null | number {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value

  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null
}

export function records(value: unknown): Json[] {
  return asArray(value)
    .map(asRecord)
    .filter((item): item is Json => item !== null)
}

export function round(value: number, digits: number): string {
  const scale = 10 ** digits

  return String(Math.round(value * scale) / scale)
}

/** Any JSON value as readable text — objects pretty-printed. */
export function textOf(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return ''
    }
  }

  return ''
}

export function displayValue(value: unknown): string {
  return typeof value === 'string' ? value : textOf(value).replace(/\s+/g, ' ')
}
