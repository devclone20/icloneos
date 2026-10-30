/**
 * tmux is only INVOKED (ISC licence; nothing of it ships). Every session the
 * app creates lives on its own server socket label, `-L iclone`, started with
 * `-f /dev/null`: the owner's own tmux server and `tmux.conf` are never read
 * or written. Session names are validated, never interpolated unquoted.
 *
 * `new-session -A` is attach-or-create, so the same argv both starts a session
 * and re-attaches to it after the app restarts. Killing the attached client
 * (closing the pane, or the app dying) only DETACHES; ending a session is a
 * separate explicit command.
 *
 * The app owns the server's environment. Whoever starts a tmux server freezes
 * its own environment into the server's GLOBAL environment, and every later
 * session's shell inherits it. If a normal pane (which holds its bus token)
 * starts `tmux -L iclone` first, its token would reach every app tmux pane. So
 * every app session and attach is one tmux command list, run in order by the
 * server: unset each bus variable globally, pin `update-environment` to tmux's
 * own defaults (no bus variable is imported from a client), then attach.
 */
import { BUS_ENV_KEYS } from '../iclone-pane-bus/pane-env'

export const TMUX_SOCKET_LABEL = 'iclone'

// The contract allows `.`; tmux rewrites `.` and `:` in session names (they are
// target separators), so a dotted name would not re-attach by the name we
// stored. The accepted set is the contract's minus the dot.
const SESSION_RE = /^[A-Za-z0-9_-]{1,48}$/

export function isTmuxSessionName(name: string): boolean {
  return SESSION_RE.test(name)
}

/** `iclone-<slug>-<first 8 of the pane id>`, cut to the 48-character cap. */
export function tmuxSessionFor(slug: string, paneId: string): string {
  const clean = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')

  const tail = clean(paneId).replace(/-/g, '').slice(0, 8) || 'pane'
  const head = clean(slug).slice(0, 48 - 'iclone-'.length - tail.length - 1) || 'it'

  return `iclone-${head}-${tail}`
}

const base = (): string[] => ['-L', TMUX_SOCKET_LABEL, '-f', '/dev/null']

/** tmux 3.6's own default: what a client refreshes in a session on attach. A ~/.tmux.conf could have widened it. */
const UPDATE_ENVIRONMENT =
  'DISPLAY KRB5CCNAME MSYSTEM SSH_ASKPASS SSH_AUTH_SOCK SSH_AGENT_PID SSH_CONNECTION WINDOWID XAUTHORITY'

/** Runs before new-session in the same client (`;` separates tmux commands); unsetting an absent variable is not an error. */
const ownServerEnv = (): string[] => [
  ...BUS_ENV_KEYS.flatMap(key => ['set-environment', '-g', '-u', key, ';']),
  'set-option',
  '-g',
  'update-environment',
  UPDATE_ENVIRONMENT,
  ';'
]

function assertSession(session: string): void {
  if (!isTmuxSessionName(session)) {
    throw new Error(`tmux session name "${session}" must match ${SESSION_RE.source}`)
  }
}

/** argv for a local `tmux` binary: attach-or-create. */
export function localTmuxAttachArgs(session: string): string[] {
  assertSession(session)

  return [...base(), ...ownServerEnv(), 'new-session', '-A', '-s', session]
}

export function tmuxListArgs(): string[] {
  return [...base(), 'list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}']
}

export function tmuxEndArgs(session: string): string[] {
  assertSession(session)

  return [...base(), 'kill-session', '-t', `=${session}`]
}

const singleQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * The remote command for the ssh branch of a pane: attach-or-create, or — when
 * the host has no tmux — say so with the command to copy and fall back to a
 * login shell. Nothing is installed for the owner.
 */
export function remoteTmuxCommand(session: string): string {
  assertSession(session)

  const missing = singleQuote(
    'iclone os: tmux is not installed on this host. To install it yourself: sudo apt-get install tmux (Debian/Ubuntu) or brew install tmux (macOS).'
  )

  return [
    `command -v tmux >/dev/null 2>&1 || { printf '%s\\n' ${missing}; exec "$SHELL" -l; }`,
    `exec tmux ${[...base(), ...ownServerEnv()].map(singleQuote).join(' ')} new-session -A -s ${singleQuote(session)}`
  ].join('; ')
}

interface TmuxSessionRow {
  name: string
  createdAt: number
  attached: number
}

export function parseTmuxList(stdout: string): TmuxSessionRow[] {
  return stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter(cells => cells.length === 3 && isTmuxSessionName(cells[0]))
    .map(([name, created, attached]) => ({ name, createdAt: Number(created) * 1000, attached: Number(attached) }))
}
