/**
 * The connections registry at app boot (v0.0.9 pass 4): a pre-v0.0.9 regression caught by v0.0.9 e2e, caused by
 * e1b478779f. That commit deleted ConnectionSwitcher as unmounted, and with it the only callers of three boot duties:
 *
 * 1. initializeConnectionsRegistry(): the one-shot restore of the last-used source (launchMode 'last-used', the
 *    Settings › Gateways toggle). It runs once, only after the primary boot settled cleanly, and only in the primary
 *    window; it then waits for the primary connection itself (store/connections.ts), so it can never dial before the
 *    consent and permission gate let the primary boot through.
 * 2. refreshConnectionsRegistry() at boot: $connectionsRegistry, and everything derived from it (the profile rail's
 *    fleet strip, $hasMultipleConnections), loaded from Electron's local registry without opening Settings. It reads a
 *    local file through IPC; no backend is contacted.
 * 3. The re-pull on connections.onChanged lives in use-gateway-boot.ts, beside the handler that already listens.
 *
 * Idempotent across StrictMode's double effect and a hot reload: the restore is claimed once per page in a globalThis
 * slot (a module flag would be reset by HMR), and the store's own restoreAttempted guard stays as a second lock.
 */
import { $desktopBoot } from '@/store/boot'
import { initializeConnectionsRegistry, refreshConnectionsRegistry } from '@/store/connections'
import { isAuxiliaryWindow, isPeerInstanceWindow } from '@/store/windows'

const CLAIM = Symbol.for('iclone.connectionsRegistryRestoreClaimed')

type ClaimSlot = { [CLAIM]?: boolean }

/** @internal Tests only: forget that this page already restored. */
export function _resetConnectionsRegistryBootForTests(): void {
  delete (globalThis as ClaimSlot)[CLAIM]
}

/** Load the registry now and run the restore once the primary boot settles. Returns the subscription's disposer. */
export function startConnectionsRegistryAtBoot(): () => void {
  void refreshConnectionsRegistry().catch(() => undefined)

  if (isAuxiliaryWindow() || isPeerInstanceWindow()) {
    return () => undefined
  }

  let off: (() => void) | null = null

  const settle = () => {
    const boot = $desktopBoot.get()
    const slot = globalThis as ClaimSlot

    // A running boot (consent, the gate, install, the backend coming up) or a failed one never restores.
    if (boot.running || boot.error || slot[CLAIM]) {
      return
    }

    slot[CLAIM] = true
    off?.()
    off = null
    void initializeConnectionsRegistry().catch(() => undefined)
  }

  off = $desktopBoot.listen(settle)
  settle()

  return () => {
    off?.()
    off = null
  }
}
