/**
 * iCLONE OS — runtime shape guards for untyped JSON (CLI output, bridge
 * payloads), shared by the electron main process and the renderer.
 */

/** A non-null object that is not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value as a plain object, or null for anything else (arrays included). */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

/** The value as a plain object, or a fresh empty object for anything else (arrays included). */
export function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** The value when it is a string (the empty string included). */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The value when it is a string of at least one character. */
export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A string with a non-whitespace character and at most `maxLength` characters. */
export function isNonBlankString(value: unknown, maxLength = Number.POSITIVE_INFINITY): value is string {
  return typeof value === 'string' && value.length <= maxLength && value.trim().length > 0
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The value when it is a finite number (NaN and ±Infinity are refused). */
export function asFiniteNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined
}

/** A string as-is, or a finite number as its decimal text. */
export function coerceString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }

  return isFiniteNumber(value) ? String(value) : undefined
}

/** A finite number, or a non-blank string that `Number()` parses to one. */
export function coerceNumber(value: unknown): number | undefined {
  if (isFiniteNumber(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim() !== '') {
    return asFiniteNumber(Number(value))
  }

  return undefined
}
