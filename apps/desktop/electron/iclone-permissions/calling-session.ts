/**
 * S6: the session a request on the agent or pay socket came from. Payments and the consent verb are reached from a
 * command the agent ran, far below the socket handler; the handler names the session once and the mode is read for it.
 *
 * The name is what the client read from HERMES_SESSION_ID, which Hermes sets per command. It is a claim by the agent's
 * own process: a command that knows another session's id can name it. That id is not in its environment or its files.
 * A kernel-attested caller would need native peer credentials on the socket; declared, for the critics.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const SESSION_ID = /^[\w.:@-]{1,200}$/

const current = new AsyncLocalStorage<null | string>()

/** Runs `run` as a request from `session`; anything that is not a session id means no session, which asks. */
export const withCallingSession = <T>(session: unknown, run: () => T): T =>
  current.run(typeof session === 'string' && SESSION_ID.test(session) ? session : null, run)

export const callingSession = (): null | string => current.getStore() ?? null
