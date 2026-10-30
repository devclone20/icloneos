/**
 * V3-I — what the Work tab derives from main's view, pure. Every figure on screen comes from the view main folded on
 * read (`WorkView`); nothing here keeps state between renders.
 */
import type { WorkOfferView, WorkRowGroup, WorkRowView, WorkTrace, WorkView } from '@/iclone-shared/acp-work'

import { usd } from '../../format'

export const WORK_GROUPS: readonly WorkRowGroup[] = ['in-flight', 'payments', 'completed', 'history']

/** Exact micro-USDC as dollars for display; null reads as the gap mark the caller chooses. */
export function microsLabel(micros: null | number): string {
  return micros === null ? '—' : usd(micros / 1_000_000)
}

export function rowsIn(view: WorkView, group: WorkRowGroup): WorkRowView[] {
  return view.rows.filter(row => row.group === group)
}

const STANDING_ORDER: Record<WorkOfferView['standing'], number> = {
  pending: 0,
  approved: 1,
  refused: 2,
  declined: 3,
  seen: 4
}

/** What needs the owner first, then the rest; a stable order inside each standing. */
export function inboxOrder(offers: readonly WorkOfferView[]): WorkOfferView[] {
  return [...offers].sort((a, b) => STANDING_ORDER[a.standing] - STANDING_ORDER[b.standing])
}

export type TraceHop = keyof WorkTrace

export const TRACE_HOPS: readonly TraceHop[] = ['offer', 'job', 'budgetMicros', 'deliverable', 'paymentMicros']

/** One hop's text, or null for a gap — a gap is shown as a gap, never filled in. */
export function hopValue(trace: WorkTrace, hop: TraceHop): null | string {
  if (hop === 'budgetMicros' || hop === 'paymentMicros') {
    return trace[hop] === null ? null : microsLabel(trace[hop])
  }

  return trace[hop]
}

/** The I3 identity: the payments rows add up to the ledger's earned total, exactly. */
export function paymentsMatchLedger(view: WorkView): boolean {
  const rows = view.rows.reduce((sum, row) => sum + (row.trace.paymentMicros ?? 0), 0)

  return rows === view.totals.earnedMicros
}
