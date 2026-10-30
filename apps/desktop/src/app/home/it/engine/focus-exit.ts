/**
 * The way OUT of the terminal by keyboard. xterm's custom key handler passes
 * every key to the pty — Tab, Escape and Shift+Tab included (vim needs them) —
 * so without this a keyboard user is trapped once a session is attached.
 * Shift+Tab is released to the browser: xterm does not handle it and nothing
 * calls preventDefault, so native focus traversal carries focus to the rail.
 */
export function isTerminalFocusExit(event: KeyboardEvent): boolean {
  return event.key === 'Tab' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
}

/** id of the visually hidden hint the helper textarea is described by (it-terminal.tsx). */
export const IT_EXIT_HINT_ID = 'it-terminal-exit-hint'
