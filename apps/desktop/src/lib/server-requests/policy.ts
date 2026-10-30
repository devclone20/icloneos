/**
 * What this app does with every server→client request the runtime can send (contract P4c D6).
 * `handled`: a UI or a registered handler answers it. `declineOk`: answered at once with a JSON-RPC
 * error (fail closed; the runtime treats it as "skipped"). Anything not listed is unknown → -32601.
 * `iclone/contract/extract.mjs` reads this table into the lock's `serverRequests`.
 */
export const SERVER_REQUEST_POLICY: Readonly<Record<string, 'declineOk' | 'handled'>> = Object.freeze({
  approval: 'handled',
  clarify: 'handled',
  'display.install.sudo': 'declineOk',
  'preview.act': 'handled',
  'preview.read': 'handled',
  secret: 'handled',
  sudo: 'handled',
  'terminal.read': 'handled',
  tour: 'handled',
  'vault.code': 'declineOk',
  'vault.save_login': 'declineOk',
  'vault.unlock_prompt': 'declineOk',
  'window.read': 'handled'
})

/** Bridges only the window showing the session may answer; every other window declines with 4404. */
export const WINDOW_OWNED_METHODS: ReadonlySet<string> = new Set([
  'preview.act',
  'preview.read',
  'terminal.read',
  'tour',
  'window.read'
])

const SERVER_REQUEST_NOT_SHOWN = 4404
export const SERVER_REQUEST_METHOD_NOT_FOUND = -32601

/**
 * The runtime is the clock (lead ruling): it withdraws every request at its own deadline with
 * `request.cancel`. The local backstop only frees memory when that cancel never arrives (dead transport): it fires
 * at the runtime deadline + 30 s grace and never answers the runtime. Runtime defaults, hermes-agent 1ac3f97fbe09
 * unless noted; a configured `approvals.timeout` / `clarify.timeout` can only lengthen the runtime's wait.
 */
const BACKSTOP_GRACE_S = 30

const RUNTIME_DEADLINE_S: Readonly<Record<string, number>> = Object.freeze({
  approval: 300, // tools/approval_context.py:255 `approvals.timeout` default
  clarify: 3600, // tools/clarify_gateway.py:276 `clarify.timeout` default
  'mcp.setup': 600, // legacy runtime ebe8cda8ea^ tui_gateway/agent_callbacks.py:117
  secret: 300, // tui_gateway/server.py:1393 `_ask` default
  sudo: 300 // tui_gateway/server.py:1393 `_ask` ceiling (agent_callbacks.py:251 asks 120)
})

/** Any other method: the `_ask` default, tui_gateway/server.py:1393. */
const DEFAULT_RUNTIME_DEADLINE_S = 300

/** Backstop for `method`: after this long without an answer or a cancel the entry is dropped, silently. */
export function serverRequestTimeoutMs(method: string): number {
  return ((RUNTIME_DEADLINE_S[method] ?? DEFAULT_RUNTIME_DEADLINE_S) + BACKSTOP_GRACE_S) * 1000
}

/** JSON-RPC error code for declining `method` when this window does not answer it. */
export function declineCodeFor(method: string): number {
  return WINDOW_OWNED_METHODS.has(method) ? SERVER_REQUEST_NOT_SHOWN : SERVER_REQUEST_METHOD_NOT_FOUND
}
