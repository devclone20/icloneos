type Kinds = 'agent' | 'shell' | 'cron' | 'pane' | 'action'
type States = 'running' | 'waiting' | 'done' | 'failed' | 'died' | 'stopped'

/** V3-A — the Background tasks door on the Message band and its panel. */
export type BackgroundTasksTranslations = {
  /** The door's accessible name carries the live numbers. */
  doorLabel: (active: number, diedUnseen: number) => string
  title: string
  tabs: { tasks: string; log: string }
  kinds: Record<Kinds, string>
  states: Record<States, string>
  /** Replaces "Stopped" when the registry knows why a running task ended without dying. */
  endedBy: Record<'owner' | 'rewind' | 'session', string>
  /** Says why the elapsed time reads "—" (hover or keyboard focus on the row). */
  startUnknown: string
  stop: string
  stopping: string
  didNotStop: (detail: string) => string
  /** Replaces "Stopping…" when no reading of the job came in 15 s: neutral, neither stopped nor not. */
  cannotConfirm: string
  /** Next to "Did not stop": sends the stop again. */
  retryStop: string
  /** One line in place of Stop, per kind, when the source cannot stop it for real. */
  cannotStop: Record<Kinds | 'waiting', string>
  dismiss: string
  showMore: (count: number) => string
  diedBanner: (count: number) => string
  exitCode: (code: number) => string
  signal: (name: string) => string
  noOutput: string
  emptyTitle: string
  emptyText: string
  loading: string
  sourceError: (source: string, detail: string) => string
  sources: Record<'agent' | 'shell' | 'cron' | 'perm' | 'pane' | 'action', string>
  logEmpty: string
  logUnavailable: string
}
