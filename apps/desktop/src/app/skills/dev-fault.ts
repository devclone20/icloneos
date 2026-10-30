/**
 * Dev-only fault seam for the Capabilities page's two failure branches.
 *
 * The front's target asks for the empty and the error state to be proven on a
 * real lab window, not only in jsdom, and a probe cannot reach them from
 * outside: `contextBridge` exposes `window.hermesDesktop` as a
 * NON-CONFIGURABLE, deep-frozen property (measured on lab 2 by E3d2), so
 * nothing outside the app can make the skills/toolsets calls answer `[]` or
 * throw. Same shape and the same reasoning as `app/messaging/dev-fault.ts`.
 *
 * One optional window field, read only under `import.meta.env.DEV`. A
 * production build drops the branch with the constant, and an app where nobody
 * sets the field behaves exactly as before.
 */
type SkillsFault = 'empty' | 'error'

const FIELD = '__icloneSkillsFault'

// Marks the error the seam throws. A probe arms `error` to paint the branch on
// the FIRST attempt, so the retry policy has to recognise this one exactly —
// never by sniffing its message, which a real backend error could match.
const INJECTED = Symbol.for('iclone.skills.injectedFault')

let armed: SkillsFault | undefined

const normalize = (value: unknown): SkillsFault | undefined =>
  value === 'empty' || value === 'error' ? value : undefined

/** The error an armed `error` fault throws, tagged so retries skip it. */
export function injectedFaultError(label: string): Error {
  const error = new Error(`${label}: injected fault`)

  Object.defineProperty(error, INJECTED, { value: true })

  return error
}

/**
 * True for the seam's own error. The page retries a transient failure twice
 * (gateway start-up is the app's slowest cold path) but must NOT retry this
 * one: the probe needs the error branch on screen immediately, and a retry of
 * a fault that is still armed would only paint the same error later.
 */
export function isInjectedFault(error: unknown): boolean {
  return typeof error === 'object' && error !== null && INJECTED in error
}

/** What a dev (or a CDP probe) asked the capabilities lists to do. */
export function skillsFault(): SkillsFault | undefined {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return undefined
  }

  // Read through the FIELD, not the backing store: a probe may arm the fault
  // before the page mounts and installs the accessor, and the first query fires
  // in the same commit as that effect.
  return normalize((window as unknown as Record<string, unknown>)[FIELD])
}

/**
 * Install the seam, once, from the page.
 *
 * The field is an ACCESSOR, not a plain data property, because arming a fault
 * has to invalidate the two lists as well: React Query holds the previous
 * answer for the same key, so a probe that arms a second branch would be shown
 * the first branch's screen (measured in r1 — "empty" read back 12 s after
 * "error" was armed). `onArm` carries the page's own query keys so they stay
 * declared where they are used.
 */
export function installSkillsFaultSeam(onArm: () => void): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return
  }

  const host = window as unknown as Record<string, unknown>
  const existing = Object.getOwnPropertyDescriptor(host, FIELD)

  if (existing?.get) {
    return
  }

  // A probe that armed the fault before this ran left a plain data property.
  armed = normalize(host[FIELD])

  Object.defineProperty(host, FIELD, {
    // Non-configurable so `delete` cannot drop the accessor and leave a stale
    // `armed` behind: clearing the fault is `window.__icloneSkillsFault = null`.
    configurable: false,
    get: () => armed,
    set: (value: unknown) => {
      armed = normalize(value)
      onArm()
    }
  })
}
