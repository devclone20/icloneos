/** The market data module's `history` section — its public names are re-exported by ../market-data.ts. */
import { asRecord, bool, type Json, listAt, num, str } from '../../cli'

import { budgetOf, normalizeStatus, statusLabel } from './jobs'
import { finiteOrNull, textOf } from './primitives'
import type { EntryTone, JobEntry, JobHistory } from './types'

// ── job history ─────────────────────────────────────────────────────────────

const EVENT_TITLES = new Map([
  ['job.created', 'Job created'],
  ['budget.set', 'Budget set'],
  ['job.funded', 'Funded'],
  ['job.submitted', 'Deliverable submitted'],
  ['job.completed', 'Completed'],
  ['job.rejected', 'Rejected'],
  ['job.expired', 'Expired']
])

const EVENT_TONES = new Map<string, EntryTone>([
  ['job.created', 'muted'],
  ['budget.set', 'warn'],
  ['job.funded', 'tone'],
  ['job.submitted', 'warn'],
  ['job.completed', 'up'],
  ['job.rejected', 'down'],
  ['job.expired', 'down']
])

/** Epoch ms from ms, seconds, a numeric string or an ISO date. */
export function timestampOf(value: unknown): null | number {
  const numeric = finiteOrNull(value)

  if (numeric != null) {
    return numeric < 1e12 ? numeric * 1000 : numeric
  }

  const parsed = typeof value === 'string' ? Date.parse(value) : NaN

  return Number.isFinite(parsed) ? parsed : null
}

function prettyBody(value: unknown): { body: string; bodyIsJson: boolean } {
  if (typeof value === 'string') {
    const text = value.trim()

    if (/^[[{]/.test(text)) {
      try {
        return { body: JSON.stringify(JSON.parse(text), null, 2), bodyIsJson: true }
      } catch {
        // Plain text that starts with a bracket.
      }
    }

    return { body: value, bodyIsJson: false }
  }

  return { body: textOf(value), bodyIsJson: value !== null && typeof value === 'object' }
}

function eventDetail(event: Json): string {
  const amount = finiteOrNull(event.amount)
  const fund = asRecord(event.fundRequest) ?? asRecord(event.fundTransfer)
  const fundAmount = finiteOrNull(fund?.amount)

  return [
    amount == null ? '' : `${amount} USDC`,
    fundAmount == null
      ? ''
      : `${str(fund, 'recipient') ? 'transfer' : 'fund request'} ${fundAmount} ${str(fund, 'symbol') || 'USDC'}`,
    str(event, 'reason')
  ]
    .filter(Boolean)
    .join(' · ')
}

function systemEntry(raw: Json, event: Json): Omit<JobEntry, 'id'> {
  const type = str(event, 'type') || str(raw, 'type')

  return {
    kind: 'system',
    title: EVENT_TITLES.get(type) ?? (type ? statusLabel(normalizeStatus(type.replace(/^job\./, ''))) : 'Event'),
    detail: eventDetail(event),
    ...prettyBody(event.deliverable ?? ''),
    from: '',
    tone: EVENT_TONES.get(type) ?? 'muted',
    at: timestampOf(raw.timestamp ?? raw.createdAt)
  }
}

function messageEntry(raw: Json): Omit<JobEntry, 'id'> {
  const payable = asRecord(raw.payableDetails)
  const amount = finiteOrNull(payable?.amount)

  return {
    kind: 'message',
    title: str(raw, 'contentType') || 'message',
    detail: amount == null ? '' : `${amount} ${str(payable, 'symbol') || 'USDC'}`,
    ...prettyBody(raw.content ?? raw.message ?? raw.text ?? ''),
    from: str(raw, 'from') || str(raw, 'senderAddress') || str(raw, 'sender'),
    tone: 'muted',
    at: timestampOf(raw.timestamp ?? raw.createdAt)
  }
}

function shapeEntry(raw: Json): JobEntry {
  const event = asRecord(raw.event)
  const entry = str(raw, 'kind') === 'system' || event ? systemEntry(raw, event ?? raw) : messageEntry(raw)
  const id = str(raw, 'id') || str(raw, 'memoId') || `${entry.at ?? ''}:${entry.kind}:${entry.title}`

  return { ...entry, id }
}

/** Two entries may share when/what (two messages in one second): suffix the
 *  repeats so every timeline key is unique and stays put as history grows. */
function uniqueIds(entries: JobEntry[]): JobEntry[] {
  const seen = new Map<string, number>()

  return entries.map(entry => {
    const count = seen.get(entry.id) ?? 0

    seen.set(entry.id, count + 1)

    return count === 0 ? entry : { ...entry, id: `${entry.id}#${count}` }
  })
}

export function shapeJobHistory(raw: unknown): JobHistory {
  const root = asRecord(raw) ?? {}
  const legacy = bool(root, 'legacy')

  return {
    jobId: str(root, 'jobId'),
    chainId: num(root, 'chainId'),
    status: normalizeStatus(str(root, 'status') || str(root, 'phase')),
    budgetUsdc: root.budget != null || root.price != null ? budgetOf(root, legacy) : null,
    deliverable: textOf(root.deliverable),
    entries: uniqueIds(listAt(raw, ['entries', 'messages', 'memos']).map(shapeEntry))
  }
}
