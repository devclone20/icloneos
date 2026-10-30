// English fallbacks for the `compact.*` i18n keys (requested from L7a). The
// runtime's own lines (summary headline, token line, progress) are shown
// verbatim and never pass through this table.
export const compactCopy = {
  aborted: 'Compaction aborted · nothing was changed',
  busy: 'Wait for the turn to finish',
  button: 'Compact session',
  buttonShort: 'Compact',
  compacted: 'Compacted',
  compactedWithFallback: 'Compacted with fallback summary',
  compactedMessages: (removed: number) => `compressed ${removed} messages`,
  compactingFor: (focusTopic: string) => `compressing context for: ${focusTopic}`,
  compactingGeneric: 'compressing context...',
  dismiss: 'Dismiss',
  error: 'Compaction failed',
  errorLine: (message: string) => `error: ${message}`,
  host: 'Compacted on the compute host',
  lockHeld: 'Another compaction holds this session',
  messages: 'messages',
  noSession: 'Start a conversation to compact it',
  noop: 'Nothing to compact',
  nothingToCompress: 'nothing to compress',
  running: 'Compacting…',
  sessionUnavailable: 'Session unavailable · nothing was compacted',
  tokens: 'tokens',
  tooFew: 'Needs at least 4 messages to compact',
  unsupported: 'Compacted through the legacy command path',
  wouldGrow: 'Compaction refused · the summary would be larger'
} as const
