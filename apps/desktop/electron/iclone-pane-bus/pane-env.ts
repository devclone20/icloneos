/**
 * What a pane's process is started with. Pure, so the tmux identity rule is
 * tested against a real tmux server without Electron.
 *
 * A bus identity is handed ONLY to a local shell the app owns for its whole
 * life. A tmux pane gets none in this release: the tmux server freezes the
 * environment of the client that starts it into its global environment, every
 * later session's shell inherits that, and the session outlives the pane — so
 * a token given to any tmux client would speak for another pane, or for a dead
 * one. Fetching a fresh identity per attach would need the shell to prove which
 * pane it is to main (peer credentials), which Node does not expose; until then
 * "no bus in tmux" is the safe answer, said by `it bus` itself.
 *
 * Why the bus does not bind a token to the caller's pid: macOS gives it as
 * `getsockopt(LOCAL_PEERPID)`, which Node's `net` does not surface and the app
 * has no native module to reach. Asking `lsof` per request costs tens of ms, over
 * the 15 ms hop budget, and is racy against pid reuse. So a token is kept out of
 * places other processes inherit from instead: this env filter, and the app
 * scrubbing its own tmux server's environment (tmux-cmd.ts).
 */

/** Every variable the bus hands a shell. None of them may reach tmux or ssh. */
const BUS_ENV_RE = /^ICLONE_PANE_/

/** The bus variables by name, for the places that cannot match a pattern (tmux `set-environment -u`). */
export const BUS_ENV_KEYS = [
  'ICLONE_PANE_ID',
  'ICLONE_PANE_NAME',
  'ICLONE_PANE_TOKEN',
  'ICLONE_PANE_SOCK',
  'ICLONE_PANE_GROUP',
  'ICLONE_PANE_ROLE'
] as const

/** The refusal main raises and the renderer words from its catalogue. */
export const TMUX_REMOTE_OFF = 'iclone:tmux-remote-off'

export interface PreparedPane {
  paneId: string
  /** The spec's own env, already through the allow-list. */
  env: Record<string, string>
  /** ICLONE_PANE_* for a local non-tmux shell on a listening bus; null otherwise. */
  identity: null | Record<string, string>
  initialInput: null | string
  tmux: null | { session: string; localArgs: string[]; remoteCommand: null | string }
}

export function paneProcessEnv(base: NodeJS.ProcessEnv, pane: null | PreparedPane): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}

  // From the base too: an app started from inside a pane carries that pane's identity.
  for (const [key, value] of Object.entries({ ...base, ...pane?.env })) {
    if (!BUS_ENV_RE.test(key)) {
      env[key] = value
    }
  }

  // TMUX in the base is the app's own (started from a tmux shell), never the pane's: a
  // tmux client would refuse to nest, and `it bus` reads TMUX as "this shell is inside tmux".
  // So a pane sees TMUX only once it starts a tmux of its own.
  delete env.TMUX
  delete env.TMUX_PANE

  if (pane?.tmux) {
    return env
  }

  return pane?.identity ? { ...env, ...pane.identity } : env
}
