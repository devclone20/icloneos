/**
 * V3-FX r4 — a clean relaunch that a cancelled quit cannot leave armed. `app.relaunch()` cannot be undone, so it is
 * called only when the quit really proceeds (`will-quit`); until then the request is just armed. A quit the owner
 * cancels ("Keep Running" over a turn in flight) disarms it, so a later ordinary quit does not restart the app.
 */
export interface RelaunchApp {
  relaunch(): void
  quit(): void
  on(event: 'will-quit', listener: () => void): unknown
}

export function createRelaunchOnQuit(app: RelaunchApp) {
  let armed = false

  app.on('will-quit', () => {
    if (armed) {
      armed = false
      app.relaunch()
    }
  })

  return {
    /** Quit now and start again once the quit goes through. */
    request(): void {
      armed = true
      app.quit()
    },
    /** The quit was cancelled: a later quit is an ordinary quit. */
    disarm(): void {
      armed = false
    },
    armed: (): boolean => armed
  }
}
