import { APP_INTL_LOCALE } from '@/iclone-shared/app-intl-locale'

import type { BillingCopy } from './copy'
import type { BillingStateResponse } from './types'

type AmountWords = BillingCopy['autoRefill']

export const EMPTY_BILLING_VALUE = '—'

export function clampAmount(raw: string, billing: Pick<BillingStateResponse, 'max_usd' | 'min_usd'>): string {
  const amount = parseEnteredAmount(raw)

  if (amount == null) {
    return ''
  }

  const min = parseEnteredAmount(billing.min_usd)
  const max = parseEnteredAmount(billing.max_usd)
  const clampedMin = min == null ? amount : Math.max(min, amount)
  const clamped = max == null ? clampedMin : Math.min(max, clampedMin)

  return formatAmountForRequest(clamped)
}

/** A dollar amount from a number or a "$1,234.50" string; null when it is not a finite number. */
export function parseAmount(value?: null | number | string): null | number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value !== 'string') {
    return null
  }

  const parsed = Number(value.replace(/[$,\s]/g, ''))

  return Number.isFinite(parsed) ? parsed : null
}

/** parseAmount for typed fields: text that reads as $0 or less is no amount; numbers pass unchanged. */
function parseEnteredAmount(value?: null | number | string): null | number {
  const amount = parseAmount(value)

  return typeof value === 'string' && amount !== null && amount <= 0 ? null : amount
}

function formatAmountForRequest(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

export function initialAutoReloadAmount(...candidates: Array<null | string | undefined>): string {
  for (const candidate of candidates) {
    const amount = parseEnteredAmount(candidate)

    if (amount != null) {
      return formatAmountForRequest(amount)
    }
  }

  return ''
}

export function validateAutoReloadInputs(
  thresholdRaw: string,
  reloadToRaw: string,
  bounds: Pick<BillingStateResponse, 'max_usd' | 'min_usd'>,
  words: AmountWords
): { error?: string; values?: { reloadTo: string; threshold: string } } {
  const threshold = validateBillingAmount(words.thresholdName, thresholdRaw, bounds, words)

  if (threshold.error || threshold.amount == null) {
    return { error: threshold.error }
  }

  const reloadTo = validateBillingAmount(words.reloadToName, reloadToRaw, bounds, words)

  if (reloadTo.error || reloadTo.amount == null) {
    return { error: reloadTo.error }
  }

  if (reloadTo.amount <= threshold.amount) {
    return { error: words.order }
  }

  return {
    values: {
      reloadTo: formatAmountForRequest(reloadTo.amount),
      threshold: formatAmountForRequest(threshold.amount)
    }
  }
}

function validateBillingAmount(
  label: string,
  raw: string,
  bounds: Pick<BillingStateResponse, 'max_usd' | 'min_usd'>,
  words: AmountWords
): { amount?: number; error?: string } {
  const cleaned = raw.trim().replace(/^\$/, '').trim()

  if (!cleaned || !/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return { error: words.badFormat(label) }
  }

  const amount = Number(cleaned)

  if (!(amount > 0)) {
    return { error: words.notPositive(label) }
  }

  const min = parseEnteredAmount(bounds.min_usd)

  if (min != null && amount < min) {
    return { error: words.belowMin(label, formatMoney(min)) }
  }

  const max = parseEnteredAmount(bounds.max_usd)

  if (max != null && amount > max) {
    return { error: words.aboveMax(label, formatMoney(max)) }
  }

  return { amount }
}

export function formatMoney(value?: null | number | string): string {
  const amount = parseEnteredAmount(value)

  if (amount == null) {
    return EMPTY_BILLING_VALUE
  }

  return new Intl.NumberFormat(APP_INTL_LOCALE, {
    currency: 'USD',
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    style: 'currency'
  }).format(amount)
}
