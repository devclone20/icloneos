/**
 * iCLONE OS — promise timing helpers. Plain TS (only the `setTimeout` and
 * `AbortSignal` globals that both the renderer and Node provide).
 */

export interface SleepOptions {
  /** Aborting rejects the pending sleep at once; an already-aborted signal rejects immediately. */
  signal?: AbortSignal | undefined
  /** Builds the rejection value on abort. Default: `signal.reason`. */
  abortReason?: (() => unknown) | undefined
}

/** Resolves after `ms` milliseconds, or rejects as soon as `options.signal` aborts. */
export function sleep(ms: number, options: SleepOptions = {}): Promise<void> {
  const { abortReason, signal } = options

  if (!signal) {
    return new Promise(resolve => {
      setTimeout(resolve, ms)
    })
  }

  const reason = (): unknown => (abortReason ? abortReason() : signal.reason)

  if (signal.aborted) {
    return Promise.reject(reason())
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(reason())
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    signal.addEventListener('abort', onAbort, { once: true })
  })
}
