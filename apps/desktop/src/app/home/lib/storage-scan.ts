/**
 * iCLONE OS — key listing for persisted state.
 *
 * Upstream `@/lib/storage` reads and writes single keys but cannot enumerate
 * them; families of keys (one per iNFT, per window, …) are found here.
 */

/** Every stored key that starts with `prefix`, in storage order. The keys are
 *  collected before returning, so callers may remove them while iterating.
 *  Best-effort: unavailable storage (private mode, disabled, no window) yields
 *  [], and a failure mid-scan keeps the keys already read. */
export function storageKeysWithPrefix(prefix: string): string[] {
  const keys: string[] = []

  try {
    const storage = window.localStorage

    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)

      if (key !== null && key.startsWith(prefix)) {
        keys.push(key)
      }
    }
  } catch {
    // Restricted contexts list as empty, matching readKey's absent reads.
  }

  return keys
}
