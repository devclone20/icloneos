/**
 * V3-FX M1 — the one owner of "may the OS keychain seal keys now". The owner's Keychain setting
 * (`secretStoragePolicy().on`, main/secrets.ts) decides; every sealer the app hands out follows it LIVE: turning the
 * setting on (or off) rebuilds the sealer the next time anyone asks and tells every subscriber at once, so the ACP
 * tools, payments and the panes change state without a restart. Built only while the setting is on: off, no
 * safeStorage call is ever made (FX-2).
 */

type Listener = (on: boolean) => void

export interface LiveSealing<T> {
  /** The sealer for the setting as it is now (built once per "on" period), or null while it is off. */
  current(): T | null
  /** Why there is none, for the panes: the owner's setting is off, or the OS cannot seal. */
  noSealReason(): 'keychain-off' | 'unsealable'
}

export function createKeychainSwitch(read: () => boolean) {
  const listeners = new Set<Listener>()
  let last = read()

  return {
    on: (): boolean => read(),
    /** Called by whoever changed the setting; tells every subscriber once per real change. */
    changed(): void {
      const now = read()

      if (now === last) {
        return
      }

      last = now

      for (const listener of [...listeners]) {
        try {
          listener(now)
        } catch {
          // one subscriber's failure never stops the others
        }
      }
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    /** A sealer that follows the setting: rebuilt after every change, never built while the setting is off. */
    sealer<T>(build: () => T | null): LiveSealing<T> {
      let built: { value: T | null } | null = null
      let builtWhileOn = false

      const current = (): T | null => {
        const on = read()

        if (!on) {
          built = null

          return null
        }

        if (!built || !builtWhileOn) {
          built = { value: build() }
          builtWhileOn = true
        }

        return built.value
      }

      listeners.add(() => {
        built = null
        builtWhileOn = false
      })

      return { current, noSealReason: () => (read() ? 'unsealable' : 'keychain-off') }
    }
  }
}

export type KeychainSwitch = ReturnType<typeof createKeychainSwitch>
