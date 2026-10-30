/**
 * English fallback copy for the context card (i18n keys `contextPanel.*` are
 * requested from the i18n owner). Category labels are NOT here: they are the
 * runtime's own strings from `session.context_breakdown`.
 */
export const CONTEXT_PANEL_COPY = {
  autoCompactAt: 'Auto-compact at',
  autoCompactOff: 'Auto-compact is off',
  breakdownPending: 'The breakdown appears once the agent has started.',
  breakdownUnavailable: 'Breakdown unavailable right now.',
  chipLabel: (percent: number, used: string, max: string) => `Context ${percent}% used, ${used} of ${max} tokens`,
  compactPending: 'Compact session',
  contextFiles: 'Context files',
  estimated: 'estimated',
  estimatedHint: 'Computed from the compression settings; the runtime does not report its trigger.',
  freeSpace: 'Free space',
  measuredHint: 'Measured by the provider',
  estimatedSourceHint: 'Estimated locally until the provider reports usage',
  notLoaded: 'not loaded',
  progressLabel: 'Context window used',
  progressValueText: (percent: number, used: string, max: string) => `${percent}%, ${used} of ${max} tokens`,
  spendSession: 'Spend · this session',
  spendTasks: 'Background tasks · last 24 h',
  spendToday: 'Spend · today (UTC)',
  title: 'Context',
  tokens: 'tokens',
  untilAutoCompact: 'until auto-compact',
  spend: {
    api_calls: 'API calls',
    cache_read: 'Cache read',
    cache_read_tokens: 'Cache read',
    cache_write: 'Cache write',
    calls: 'Calls',
    compressions: 'Compressions',
    input: 'Input',
    input_tokens: 'Input',
    output: 'Output',
    output_tokens: 'Output',
    reasoning: 'Reasoning',
    reasoning_tokens: 'Reasoning',
    sessions: 'Sessions'
  }
} as const
