/**
 * V3-S (K139): main refuses to spawn an agent whose permission gate is not installed and loaded, and marks that boot
 * failure with this token; the boot-failure overlay keys its copy on it. One definition for both sides.
 */
export const ICLONE_GATE_MARK = '[iclone-gate]'

/** Where main appends the app log to a boot error (`… Log: <path>\n<last 20 log lines>`, start-hermes.ts). */
const APPENDED_LOG = ' Log: '

/**
 * The error's own sentence: its first line, before the app log main appends. Everything after that is evidence (the
 * child's output tail, the last lines of desktop.log) and is never classified: those lines carry the gate's own
 * SUCCESS line (`[iclone-gate] loaded by Hermes at …`) on every boot.
 */
export function ownErrorHead(error: string): string {
  const firstLine = error.split('\n', 1)[0] ?? ''
  const cut = firstLine.indexOf(APPENDED_LOG)

  return (cut === -1 ? firstLine : firstLine.slice(0, cut)).replace(/^(?:Error: )+/, '').trimStart()
}

/**
 * v0.0.9 F3 (14 Nov 2026): a refusal of the permission gate, and nothing else. A gate refusal is an `IcloneGateError`
 * (structured flag `isIcloneGateFailure`) whose message STARTS with the mark; a string that only contains the mark
 * somewhere in its appended log (a backend that crashed for another reason right after the gate passed) is not one.
 */
export function isIcloneGateFailure(error: unknown): boolean {
  if (error && typeof error === 'object') {
    if ((error as { isIcloneGateFailure?: unknown }).isIcloneGateFailure === true) {
      return true
    }

    return error instanceof Error ? isIcloneGateFailure(error.message) : false
  }

  return typeof error === 'string' && ownErrorHead(error).startsWith(ICLONE_GATE_MARK)
}

/**
 * V3-S r4 (m-g): added to a gate refusal whose cause is that the runtime is not the app's own (a user's git checkout at
 * ~/.hermes/hermes-agent, a tree without the release's manifest and the app's stamp, a Hermes on PATH) — verified only, never written. The
 * overlay then names that cause and the way out (Repair sets up the app's own copy; the user's folder is left as is).
 */
export const ICLONE_GATE_UNMANAGED_MARK = '[iclone-gate:unmanaged-runtime]'

export function isIcloneGateUnmanaged(error: unknown): boolean {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : ''

  return isIcloneGateFailure(error) && ownErrorHead(text).includes(ICLONE_GATE_UNMANAGED_MARK)
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
