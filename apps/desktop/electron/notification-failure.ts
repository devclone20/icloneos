// A system notification that could not be shown.
//
// Since Electron 42, macOS notifications go through UNUserNotificationCenter: an unsigned build, or one the user has
// not allowed, shows nothing and the Notification emits `failed` instead. A failure never throws and keeps nothing
// waiting; it is logged once per source for the life of the process, with the platform's error and never the
// notification's own title or body.
//
// A notification nobody references after show() can be collected before `failed` (or a click) reaches it, so each
// watched one is held here until it closes, fails, is clicked, or the user picks an action or replies. Electron does
// not guarantee `close` (a notification the OS drops or that sits in the notification centre may never emit it), so
// the hold is capped: past HELD_MAX the oldest held notification is let go.

/** The part of Electron's Notification this module listens to. */
export interface FailingNotification {
  // Overloads, not a union of event names: a union would reject the real Notification under strict.
  on: {
    (event: 'action', listener: () => void): unknown
    (event: 'click', listener: () => void): unknown
    (event: 'close', listener: () => void): unknown
    (event: 'reply', listener: () => void): unknown
    (event: 'failed', listener: (event: unknown, error: string) => void): unknown
  }
}

const ERROR_MAX_CHARS = 160

/** The most notifications held at once; past it the oldest is released. */
export const HELD_MAX = 64

/** The platform error on one bounded line. */
export function notificationErrorLine(error: unknown): string {
  const line = String(error ?? '')
    .replace(/\s+/g, ' ')
    .trim()

  return (line.length > ERROR_MAX_CHARS ? `${line.slice(0, ERROR_MAX_CHARS)}…` : line) || 'unknown error'
}

export function createNotificationFailureWatch(log: (line: string) => void) {
  const reported = new Set<string>()
  const held = new Set<FailingNotification>()

  /**
   * Holds one notification until it closes, fails, is clicked or answered (an action or a reply), and listens for
   * `failed` on it; `onFailed` releases whatever the caller holds for it.
   */
  const watch = (notification: FailingNotification, source: string, onFailed?: () => void) => {
    const release = () => held.delete(notification)

    // A Set iterates in insertion order, so its first entry is the oldest held.
    while (held.size >= HELD_MAX) {
      const oldest = held.values().next().value

      if (oldest === undefined) {
        break
      }

      held.delete(oldest)
    }

    held.add(notification)
    notification.on('action', release)
    notification.on('click', release)
    notification.on('close', release)
    notification.on('reply', release)
    notification.on('failed', (_event, error) => {
      release()
      onFailed?.()

      if (reported.has(source)) {
        return
      }

      reported.add(source)
      log(`[notify] ${source} notification not shown: ${notificationErrorLine(error)}`)
    })
  }

  /** How many notifications are held right now (tests). */
  watch.held = () => held.size

  return watch
}
