import { errorMessage } from '@/iclone-shared/errors'
import { asFiniteNumber, asNonEmptyString, isRecord } from '@/iclone-shared/guards'
import { isMissingRpcMethod } from '@/lib/gateway-rpc'

import type { SessionCompressResponse } from '../../types'

/** The full `session.compress` result (openrpc `SessionCompressResult`). The
 *  app-wide type only declares what the transcript path reads; compaction also
 *  reads the before/after counters, the refusal flags and the lock answer. A
 *  compute-host session passes the host's result through, so every field is
 *  optional and read defensively. */
export interface SessionCompressResult extends SessionCompressResponse {
  after_messages?: number
  after_tokens?: number
  before_messages?: number
  before_tokens?: number
  compressed?: boolean
  lock_held?: boolean
  message?: string
  summary?: SessionCompressResponse['summary'] & {
    fallback_used?: boolean
    refused_would_grow?: boolean
  }
  turn_isolation?: boolean
}

export type CompactOutcomeKind =
  'aborted' | 'busy' | 'compacted' | 'error' | 'fallback' | 'host' | 'lock_held' | 'noop' | 'refused' | 'unsupported'

export interface CompactOutcome {
  kind: CompactOutcomeKind
  /** Live runtime id the RPC answered for (differs after a stale-id resume). */
  sessionId: string
  afterMessages?: number
  afterTokens?: number
  beforeMessages?: number
  beforeTokens?: number
  /** Runtime text, verbatim: summary headline / token line / note, the lock
   *  holder description, the host output or the error message. */
  headline?: string
  message?: string
  note?: string
  removed?: number
  tokenLine?: string
}

/** Kinds after which the conversation history changed. */
export const CHANGED_KINDS: ReadonlySet<CompactOutcomeKind> = new Set(['compacted', 'fallback', 'host'])

const SESSION_BUSY = /session busy|turn (is )?running/i

/** Context size the runtime reported before compaction (`context_breakdown`),
 *  used only when the result omits `before_tokens` (compute-host results). */
export interface ContextSnapshot {
  contextUsed?: number
}

function usageContextUsed(result: SessionCompressResult): number | undefined {
  const infoUsage = isRecord(result.info?.usage) ? result.info.usage : undefined

  return asFiniteNumber(infoUsage?.context_used) ?? asFiniteNumber(result.usage?.context_used)
}

/** Classify a `session.compress` result. Every branch returns a kind the UI
 *  renders — there is no silent path. */
export function classifyCompactResult(
  result: SessionCompressResult | null | undefined,
  sessionId: string,
  before?: ContextSnapshot | null
): CompactOutcome {
  const res: SessionCompressResult = isRecord(result) ? result : {}
  const summary = isRecord(res.summary) ? res.summary : undefined

  const base: CompactOutcome = {
    kind: 'noop',
    sessionId,
    afterMessages: asFiniteNumber(res.after_messages),
    afterTokens: asFiniteNumber(res.after_tokens) ?? usageContextUsed(res),
    beforeMessages: asFiniteNumber(res.before_messages),
    beforeTokens: asFiniteNumber(res.before_tokens) ?? before?.contextUsed,
    removed: asFiniteNumber(res.removed)
  }

  if (res.lock_held === true) {
    return { ...base, kind: 'lock_held', message: asNonEmptyString(res.message) }
  }

  if (summary) {
    const text = {
      headline: asNonEmptyString(summary.headline),
      note: asNonEmptyString(summary.note),
      tokenLine: asNonEmptyString(summary.token_line)
    }

    if (summary.refused_would_grow === true) {
      return { ...base, ...text, kind: 'refused' }
    }

    if (res.status === 'aborted' || summary.aborted === true) {
      return { ...base, ...text, kind: 'aborted' }
    }

    if (summary.noop === true) {
      return { ...base, ...text, kind: 'noop' }
    }

    return { ...base, ...text, kind: summary.fallback_used === true ? 'fallback' : 'compacted' }
  }

  const hostOutput = asNonEmptyString(res.host_ack?.output?.trim())

  if (hostOutput) {
    return { ...base, kind: 'host', message: hostOutput }
  }

  if (res.compressed === false) {
    return { ...base, kind: 'noop', message: asNonEmptyString(res.message) }
  }

  return { ...base, kind: (base.removed ?? 0) > 0 ? 'compacted' : 'noop' }
}

/** Classify a rejected `session.compress`. A running turn is `busy` (the
 *  runtime refuses with "session busy"), an older gateway without the method
 *  is `unsupported` (the caller falls back to the slash worker). */
export function classifyCompactError(error: unknown, sessionId: string): CompactOutcome {
  const message = errorMessage(error)

  if (isMissingRpcMethod(error)) {
    return { kind: 'unsupported', message, sessionId }
  }

  return { kind: SESSION_BUSY.test(message) ? 'busy' : 'error', message, sessionId }
}

/** Whole-percent token reduction, or null when either side is unknown. */
export function reductionPercent(outcome: Pick<CompactOutcome, 'afterTokens' | 'beforeTokens'>): null | number {
  const { afterTokens, beforeTokens } = outcome

  if (afterTokens === undefined || beforeTokens === undefined || beforeTokens <= 0) {
    return null
  }

  return Math.round(((beforeTokens - afterTokens) / beforeTokens) * 100)
}

/** Token counts: integers below 10k, `k` with one decimal from 10k, `M` from 1M. */
export function formatTokenCount(tokens: number): string {
  // Rounded first, so 999,950 reads 1.0M rather than 1000.0k.
  const thousands = Math.round(tokens / 100) / 10

  if (thousands >= 1_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }

  if (tokens >= 10_000) {
    return `${thousands.toFixed(1)}k`
  }

  return Math.round(tokens).toLocaleString('en-US')
}
