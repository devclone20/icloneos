import type { Translations } from '../types'

export const backgroundTasks: Translations['backgroundTasks'] = {
  doorLabel: (active, died) =>
    `Background tasks: ${active} running${died > 0 ? `, ${died} died without anyone noticing` : ''}`,
  title: 'Background tasks',
  tabs: { tasks: 'Tasks', log: 'Permission log' },
  kinds: { agent: 'Agent', shell: 'Shell job', cron: 'Cron run', pane: 'iT pane', action: 'Desktop action' },
  states: {
    running: 'Running',
    waiting: 'Waiting for you',
    done: 'Done',
    failed: 'Failed',
    died: 'Died',
    stopped: 'Stopped'
  },
  endedBy: { owner: 'Stopped by you', rewind: 'Removed by rewind', session: 'Session ended' },
  startUnknown: 'Start time unknown: its source does not report one.',
  stop: 'Stop',
  stopping: 'Stopping…',
  didNotStop: detail => (detail ? `Did not stop — ${detail}` : 'Did not stop'),
  cannotConfirm: "Can't confirm",
  retryStop: 'Retry',
  cannotStop: {
    agent: 'A sub-agent cannot be stopped from here yet.',
    shell: 'This job cannot be stopped from here.',
    cron: 'A run cannot be stopped; pause the job in Cron.',
    pane: 'Stop it in its iT pane.',
    action: 'This action cannot be stopped from here.',
    waiting: 'Answer it in the chat.'
  },
  dismiss: 'Dismiss',
  showMore: count => `Show ${count} more`,
  diedBanner: count =>
    count === 1 ? '1 task died while nobody was looking' : `${count} tasks died while nobody was looking`,
  exitCode: code => `exit ${code}`,
  signal: name => `killed by ${name}`,
  noOutput: 'No output yet',
  emptyTitle: 'Nothing in the background',
  emptyText: 'Agents, shell jobs and cron runs working out of sight appear here.',
  loading: 'Reading background work…',
  sourceError: (source, detail) => `${source} could not be read: ${detail}`,
  sources: {
    agent: 'Sub-agents',
    shell: 'Shell jobs',
    cron: 'Cron',
    perm: 'Permission log',
    pane: 'iT panes',
    action: 'Desktop actions'
  },
  logEmpty: 'No permission decisions yet.',
  logUnavailable: 'The permission log is not available in this build.'
}
