// iclone os — V3-D the per-pane line of the Message sidebar's iT section and the
// pane attention words. Every locale fills this shape (ItPanesCopy).
type ItPaneStateWord = 'dead' | 'exited' | 'idle' | 'needs-input' | 'running'

export interface ItPanesCopy {
  linesLabel: (workspace: string) => string
  states: Record<ItPaneStateWord, string>
  signals: { attention: string; bell: string; notification: string }
  ago: (age: string) => string
  noBranch: string
  ports: (list: string) => string
  /** Why a tmux pane did not open on an ssh connection. */
  tmuxRemoteOff: string
}

export const enItPanes: ItPanesCopy = {
  linesLabel: workspace => `Panes of ${workspace}`,
  states: {
    running: 'running',
    idle: 'idle',
    'needs-input': 'needs you',
    exited: 'exited',
    dead: 'dead'
  },
  signals: { attention: 'asked for you', bell: 'bell', notification: 'notification' },
  ago: age => `${age} ago`,
  noBranch: 'no git',
  ports: list => `ports ${list}`,
  tmuxRemoteOff: 'tmux over ssh is off in this release: it runs only on this Mac until it is proven on a lab host.'
}
