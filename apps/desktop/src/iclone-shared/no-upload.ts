/**
 * Ruling 47 (V3-FX M3) — icloneOS never uploads diagnostics, logs or pastes to any third party. The runtime's
 * `/debug` uploads the debug report and 200 log lines to a public paste service (or Nous storage with `/debug nous`); only
 * `/debug local` stays on the machine. The desktop never sends such a command to the runtime (slash.ts refuses it
 * and opens the local report instead), and the runtime refuses it too (plugins/iclone-consent/noupload.py).
 */

/** The runtime commands that would upload, each with the argument test that keeps it local (none: always uploads). */
const UPLOADING_COMMANDS: Readonly<Record<string, (arg: string) => boolean>> = {
  debug: arg => !arg.toLowerCase().split(/\s+/).includes('local')
}

/** True when `/name arg` would make the runtime upload diagnostics or logs. */
export function uploadsDiagnostics(name: string, arg: string): boolean {
  const key = name.replace(/^\/+/, '').toLowerCase()
  const uploads = UPLOADING_COMMANDS[key]

  return uploads ? uploads(arg ?? '') : false
}

/** What the slash output says instead (the runtime's own refusal says the same). */
export const NO_UPLOAD_SLASH_TEXT =
  'icloneOS never uploads diagnostics or logs. Save a report to a file instead: Settings › Machine › Diagnostics › Save report.'
