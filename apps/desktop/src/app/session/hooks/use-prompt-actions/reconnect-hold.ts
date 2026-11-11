import { $gatewayState } from '@/store/session'

// Bound for holding a send across a reconnect: past the slowest backend boot the switch can cause, short of the point a user
// assumes the words are gone. After it the text goes back to the composer with the reason.
export const RECONNECT_HOLD_MS = 90_000

/** The window's socket is down or being dialed. `idle` is before the first boot, where the composer is disabled anyway. */
export function isGatewayReconnecting(): boolean {
  const state = $gatewayState.get()

  return state === 'connecting' || state === 'closed' || state === 'error'
}

/** Resolves true on the next open, false once the bound passes. */
export function waitForGatewayOpen(timeoutMs = RECONNECT_HOLD_MS): Promise<boolean> {
  if ($gatewayState.get() === 'open') {
    return Promise.resolve(true)
  }

  return new Promise(resolve => {
    const finish = (open: boolean) => {
      window.clearTimeout(timer)
      off()
      resolve(open)
    }

    const timer = window.setTimeout(() => finish(false), timeoutMs)

    const off = $gatewayState.listen(state => {
      if (state === 'open') {
        finish(true)
      }
    })
  })
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The socket was not open when the request was made: nothing left the window, so sending it again cannot send it twice. */
export const neverLeftTheWindow = (err: unknown) => /gateway is not connected/i.test(message(err))

/** The socket died with the request pending: the backend may have taken it, so it must never be sent again by itself. */
export const cutOffInFlight = (err: unknown) => /gateway connection closed/i.test(message(err))
