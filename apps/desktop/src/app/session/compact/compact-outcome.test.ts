import { describe, expect, it } from 'vitest'

import {
  classifyCompactError,
  classifyCompactResult,
  formatTokenCount,
  reductionPercent,
  type SessionCompressResult
} from './compact-outcome'

// Shapes as `session.compress` returns them (tui_gateway/methods_session.py +
// agent/manual_compression_feedback.py headlines).
const compacted: SessionCompressResult = {
  after_messages: 9,
  after_tokens: 38_200,
  before_messages: 61,
  before_tokens: 142_000,
  info: { usage: { context_used: 38_900 } },
  messages: [],
  removed: 52,
  status: 'compressed',
  summary: {
    aborted: false,
    fallback_used: false,
    headline: 'Compressed: 61 → 9 messages',
    noop: false,
    note: null,
    refused_would_grow: false,
    token_line: 'Approx request size: ~142,000 → ~38,200 tokens'
  },
  usage: { calls: 1, input: 0, output: 0, total: 0 }
}

describe('classifyCompactResult', () => {
  it('reads a live compaction verbatim', () => {
    const outcome = classifyCompactResult(compacted, 'rt-1')

    expect(outcome).toMatchObject({
      afterMessages: 9,
      afterTokens: 38_200,
      beforeMessages: 61,
      beforeTokens: 142_000,
      headline: 'Compressed: 61 → 9 messages',
      kind: 'compacted',
      removed: 52,
      sessionId: 'rt-1',
      tokenLine: 'Approx request size: ~142,000 → ~38,200 tokens'
    })
    expect(outcome.note).toBeUndefined()
  })

  it.each([
    ['fallback', { fallback_used: true, headline: 'Compressed with fallback: 61 → 9 messages' }],
    ['noop', { headline: 'No changes from compression: 3 messages', noop: true }],
    [
      'refused',
      { headline: 'Compression refused (summary would grow the conversation): 61', refused_would_grow: true }
    ],
    ['aborted', { aborted: true, headline: 'Compression aborted: 61 messages preserved', note: 'No provider.' }]
  ] as const)('classifies the %s summary', (kind, summary) => {
    const outcome = classifyCompactResult({ ...compacted, summary: { ...summary } }, 'rt-1')

    expect(outcome.kind).toBe(kind)
    expect(outcome.headline).toBe(summary.headline)
  })

  it('treats status=aborted as aborted even without the summary flag', () => {
    expect(classifyCompactResult({ ...compacted, status: 'aborted' }, 'rt-1').kind).toBe('aborted')
  })

  it('surfaces the lock holder when another compaction holds the session', () => {
    const outcome = classifyCompactResult(
      { compressed: false, lock_held: true, message: 'Compression already running (auto-compaction)' },
      'rt-1'
    )

    expect(outcome).toMatchObject({ kind: 'lock_held', message: 'Compression already running (auto-compaction)' })
  })

  it('passes a compute-host result through and falls back to the snapshot for before tokens', () => {
    const outcome = classifyCompactResult(
      {
        host_ack: { output: 'compressed on host' },
        info: { usage: { context_used: 21_000 } },
        status: 'compressed',
        turn_isolation: true
      },
      'rt-1',
      { contextUsed: 90_000 }
    )

    expect(outcome).toMatchObject({
      afterTokens: 21_000,
      beforeTokens: 90_000,
      kind: 'host',
      message: 'compressed on host'
    })
  })

  it('maps compressed:false and bare counters without inventing success', () => {
    expect(classifyCompactResult({ compressed: false, message: 'nothing' }, 'rt-1')).toMatchObject({
      kind: 'noop',
      message: 'nothing'
    })
    expect(classifyCompactResult({ removed: 4 }, 'rt-1')).toMatchObject({ kind: 'compacted', removed: 4 })
    expect(classifyCompactResult({ removed: 0 }, 'rt-1').kind).toBe('noop')
    expect(classifyCompactResult(null, 'rt-1').kind).toBe('noop')
  })

  it('ignores non-finite counters', () => {
    const outcome = classifyCompactResult(
      { ...compacted, after_tokens: Number.NaN, info: {}, usage: undefined },
      'rt-1'
    )

    expect(outcome.afterTokens).toBeUndefined()
  })
})

describe('classifyCompactError', () => {
  it('marks a running turn as busy', () => {
    expect(
      classifyCompactError(new Error('session busy — /interrupt the current turn before /compress'), 'rt-1')
    ).toMatchObject({ kind: 'busy', message: 'session busy — /interrupt the current turn before /compress' })
  })

  it('marks an older gateway as unsupported', () => {
    expect(classifyCompactError(new Error('method not found: session.compress'), 'rt-1').kind).toBe('unsupported')
  })

  it('keeps any other failure as an error with its message', () => {
    expect(classifyCompactError(new Error('boom'), 'rt-1')).toMatchObject({ kind: 'error', message: 'boom' })
  })
})

describe('reductionPercent / formatTokenCount', () => {
  it('rounds the reduction and refuses unknown sides', () => {
    expect(reductionPercent({ afterTokens: 38_200, beforeTokens: 142_000 })).toBe(73)
    expect(reductionPercent({ afterTokens: 10 })).toBeNull()
    expect(reductionPercent({ afterTokens: 0, beforeTokens: 0 })).toBeNull()
  })

  it('formats integers, k from 10k and M from 1M', () => {
    expect(formatTokenCount(9_999)).toBe('9,999')
    expect(formatTokenCount(142_000)).toBe('142.0k')
    expect(formatTokenCount(1_250_000)).toBe('1.3M')
    expect(formatTokenCount(999_949)).toBe('999.9k')
    expect(formatTokenCount(999_950)).toBe('1.0M')
  })
})
