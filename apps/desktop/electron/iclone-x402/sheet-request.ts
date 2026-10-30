/**
 * V3-J J4-4 — what an owner sheet's answer is bound to: the CANONICAL request, never the words shown. The sheet's
 * labels follow the window's language (`payments-sheet-copy.ts`), so its text differs per locale for one and the same
 * request; the audit record of the answer and the re-check after it name this id instead. Same request in any locale
 * ⇒ the same id; any value changed ⇒ another id.
 */
import { createHash } from 'node:crypto'

/** The owner sheets main asks (the door's `tool`). */
export type SheetKind = 'payments.mandate' | 'payments.settings' | 'payments.stop'

/** JSON with every object's keys sorted, arrays in order: one byte string per value, whatever built it. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }

  if (typeof value === 'object' && value !== null) {
    const row = value as Record<string, unknown>

    return `{${Object.keys(row)
      .filter(key => row[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
      .join(',')}}`
  }

  return JSON.stringify(value ?? null)
}

/** 32 hex (128 bits) of sha-256 over the kind and the canonical request: the id the audit and the re-check use. */
export function sheetRequestId(kind: SheetKind, request: unknown): string {
  return createHash('sha256')
    .update(canonicalJson({ v: 1, kind, request }))
    .digest('hex')
    .slice(0, 32)
}
