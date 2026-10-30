/**
 * iCLONE OS — turning a caught value into display text, shared by the
 * electron main process and the renderer.
 */

/**
 * The message of an `Error`, otherwise the value as text. With `fallback`, a
 * falsy non-Error value (undefined, null, '', 0, false) reads as the fallback.
 * Never throws.
 */
export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) {
    return error.message
  }

  if (fallback !== undefined && !error) {
    return fallback
  }

  try {
    return String(error)
  } catch {
    // A null-prototype object (or a throwing toString) must not crash the catch block that formats it.
    return Object.prototype.toString.call(error)
  }
}
