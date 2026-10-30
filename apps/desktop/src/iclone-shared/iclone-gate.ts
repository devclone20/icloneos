/**
 * V3-S (K139): main refuses to spawn an agent whose permission gate is not installed and loaded, and marks that boot
 * failure with this token; the boot-failure overlay keys its copy on it. One definition for both sides.
 */
export const ICLONE_GATE_MARK = '[iclone-gate]'

export function isIcloneGateFailure(error: unknown): boolean {
  return typeof error === 'string' && error.includes(ICLONE_GATE_MARK)
}

/**
 * V3-S r4 (m-g): added to a gate refusal whose cause is that the runtime is not the app's own (a user's git checkout at
 * ~/.hermes/hermes-agent, a tree without the release's manifest and the app's stamp, a Hermes on PATH) — verified only, never written. The
 * overlay then names that cause and the way out (Repair sets up the app's own copy; the user's folder is left as is).
 */
export const ICLONE_GATE_UNMANAGED_MARK = '[iclone-gate:unmanaged-runtime]'

export function isIcloneGateUnmanaged(error: unknown): boolean {
  return isIcloneGateFailure(error) && (error as string).includes(ICLONE_GATE_UNMANAGED_MARK)
}

/**
 * V3-S r3 (MAJOR): whether main can start a Hermes in the user's own terminal app with its permission gate armed. It
 * cannot: that TUI is not a child of main, so its permission key has no inherited pipe to travel on (and the key never
 * goes in env, argv or a file). Main refuses that launch (`prepareHermesSpawn`, role `external-terminal`), and the
 * renderer hides "Open in terminal" while this is false — an action that can only fail is not offered. Main's refusal
 * stays as the backstop. Flip only together with V3-F keying an external TUI.
 */
export function externalTerminalCanCarryGate(): boolean {
  return false
}
