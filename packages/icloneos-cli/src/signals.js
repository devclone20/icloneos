// @ts-check

/**
 * SIGINT and SIGTERM only raise the abort flag: the installer stops at its next checkpoint, and its `finally`
 * blocks put any moved app back, detach the disk image and remove staging before the process exits.
 * @returns {AbortSignal}
 */
export function abortOnTerminationSignals() {
  const controller = new AbortController();
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    process.on(signal, () => controller.abort(signal));
  }
  return controller.signal;
}
