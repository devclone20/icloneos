/**
 * V3-J J4-5 — amounts and instants in Settings › Economy › Payments in the window's language (`Intl`, as the rest of
 * the catalogue does: a decimal comma and `21/10/2026, 14:05` in pt-PT). Display only: the approval sheet's values
 * and the audit stay canonical (J4-4), and the amount INPUTS keep their canonical form (their parsing is unchanged).
 */
import { parseUsdc } from '@/iclone-shared/payments'

const MICROS_PER_USDC = 1_000_000

/** micro-USDC as the locale writes a number: two decimals at least, six at most (a micro-USDC is never rounded). */
export function usdcLabel(micros: number, locale: string): string {
  if (!Number.isSafeInteger(micros) || micros < 0) {
    return '—'
  }

  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(
    micros / MICROS_PER_USDC
  )
}

/** A canonical amount ("0.30", as main or the form holds it) in the locale's words; anything else is shown as is. */
export function usdcTextLabel(text: null | string | undefined, locale: string): string {
  if (text === null || text === undefined) {
    return '—'
  }

  const micros = parseUsdc(text)

  return micros === null ? text : usdcLabel(micros, locale)
}

/** An ISO instant to the minute in the locale's words (the catalogue's `momentLabel` shape); '—' when unreadable. */
export function momentText(iso: null | string | undefined, locale: string): string {
  const ms = iso ? Date.parse(iso) : Number.NaN

  return Number.isFinite(ms)
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
    : '—'
}
