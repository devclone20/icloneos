/**
 * What a pane carries to main when its shell starts: its bus name, and — for
 * panes made by `it spawn` or `it tmux` — the spec that shaped it. The layout
 * creates the pane first and the shell starts later (only once on screen), so
 * the spec waits here, keyed by the pane's terminal id, until the session
 * reads it. Main re-validates every field.
 */

interface PaneStartOptions {
  id: string
  name?: string
  group?: string
  role?: string
  spawnId?: string
  env?: Record<string, string>
  cmd?: string
  tmux?: { attach?: string; slug?: string }
}

type PaneSpec = Omit<PaneStartOptions, 'id'>

const specs = new Map<string, PaneSpec>()

export function setPaneSpec(terminalId: string, spec: PaneSpec): void {
  specs.set(terminalId, spec)
}

/**
 * The start options for a pane's shell. A spec's `cmd` runs once: a shell that
 * restarts later (relaunch, reload) comes back as a plain shell, never re-running it.
 */
export function paneStartOptions(terminalId: string): PaneStartOptions {
  const spec = specs.get(terminalId)

  if (spec?.cmd) {
    specs.set(terminalId, { ...spec, cmd: undefined })
  }

  return { id: terminalId, ...spec }
}
