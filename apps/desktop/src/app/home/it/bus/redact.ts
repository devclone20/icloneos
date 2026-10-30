/**
 * A pane's bus token is its identity; printed by `env` it lands in scrollback.
 * Whatever leaves the live screen — the persisted revive buffer, `it collect`
 * tails — carries it masked (electron/iclone-pane-bus/token.ts: v1.<32 hex>.<64 hex>).
 *
 * Full-screen programs (`less`, `vim`) draw a long token across rows with cursor
 * moves, not soft wraps, so the reader sees it split by spaces and newlines.
 * Whitespace is allowed between any two characters; the row breaks are kept.
 */
const hexRun = (length: number) => `(?:[0-9a-f]\\s*){${length - 1}}[0-9a-f]`

const PANE_TOKEN_RE = new RegExp(`v\\s*1\\s*\\.\\s*${hexRun(32)}\\s*\\.\\s*${hexRun(64)}`, 'g')

export function redactPaneTokens(text: string): string {
  return text.replace(PANE_TOKEN_RE, match => `v1.[pane token hidden]${'\n'.repeat(match.split('\n').length - 1)}`)
}
