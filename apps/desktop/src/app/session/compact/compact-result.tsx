import './compact.css'

import { cn } from '@/lib/utils'

import { CHANGED_KINDS, type CompactOutcome, formatTokenCount, reductionPercent } from './compact-outcome'
import { compactCopy } from './compact.copy'

type Tone = 'danger' | 'muted' | 'ok' | 'warn'

const TITLE: Record<CompactOutcome['kind'], string> = {
  aborted: compactCopy.aborted,
  busy: compactCopy.busy,
  compacted: compactCopy.compacted,
  error: compactCopy.error,
  fallback: compactCopy.compactedWithFallback,
  host: compactCopy.host,
  lock_held: compactCopy.lockHeld,
  noop: compactCopy.noop,
  refused: compactCopy.wouldGrow,
  unsupported: compactCopy.unsupported
}

const TONE: Record<CompactOutcome['kind'], Tone> = {
  aborted: 'danger',
  busy: 'warn',
  compacted: 'ok',
  error: 'danger',
  fallback: 'ok',
  host: 'ok',
  lock_held: 'warn',
  noop: 'muted',
  refused: 'warn',
  unsupported: 'muted'
}

/** "142.0k → 38.2k tokens · 61 → 9 messages" from whatever the result carried. */
function compactMetricsLine(outcome: CompactOutcome): null | string {
  const parts: string[] = []

  if (outcome.beforeTokens !== undefined && outcome.afterTokens !== undefined) {
    parts.push(
      `${formatTokenCount(outcome.beforeTokens)} → ${formatTokenCount(outcome.afterTokens)} ${compactCopy.tokens}`
    )
  }

  if (outcome.beforeMessages !== undefined && outcome.afterMessages !== undefined) {
    parts.push(`${outcome.beforeMessages} → ${outcome.afterMessages} ${compactCopy.messages}`)
  }

  return parts.length ? parts.join(' · ') : null
}

/** The visible result of one compaction — every outcome kind renders a title
 *  and the runtime's own lines, so no branch is silent. */
export function CompactResult({ className, outcome }: { className?: string; outcome: CompactOutcome }) {
  const changed = CHANGED_KINDS.has(outcome.kind)
  const metrics = changed ? compactMetricsLine(outcome) : null
  const reduction = changed ? reductionPercent(outcome) : null

  const lines = [outcome.headline, outcome.tokenLine, outcome.note, outcome.message].filter(
    (line, index, all): line is string => Boolean(line) && all.indexOf(line) === index
  )

  return (
    <div
      className={cn('ic-compact-result', className)}
      data-kind={outcome.kind}
      data-testid="compact-result"
      data-tone={TONE[outcome.kind]}
      role="status"
    >
      <div className="ic-compact-result__head">
        <span aria-hidden className="ic-compact-result__dot" />
        <span className="ic-compact-result__title">{TITLE[outcome.kind]}</span>
        {reduction !== null && reduction > 0 ? (
          <span className="ic-compact-result__delta" data-testid="compact-result-delta">
            −{reduction} %
          </span>
        ) : null}
      </div>
      {metrics ? (
        <div className="ic-compact-result__metrics" data-testid="compact-result-metrics">
          {metrics}
        </div>
      ) : null}
      {lines.map(line => (
        <div className="ic-compact-result__line" key={line}>
          {line}
        </div>
      ))}
    </div>
  )
}
