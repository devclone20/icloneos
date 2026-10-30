/**
 * V3-FX FX-7 — the diagnostics report is a FILE the owner chooses. In 0.0.3 icloneOS never uploads diagnostics to any
 * third party: main composes the report (the doctor's last report, what failed, the recent app log), redacts it with
 * the doctor's redaction (secrets, keys, tokens, e-mails, the home folder), shows the parts before anything is written,
 * and writes only where the owner picks. "Report an issue" opens the public repository's new-issue page with a title
 * and nothing else: no log content ever goes into the URL.
 *
 * Plain TS shared by main (electron/iclone-diagnostics-file.ts) and the renderer (store/send-diagnostics.ts).
 */
import { PUBLIC_REPO_URL } from './public-repo'

export type DiagnosticsPartId = 'context' | 'logs' | 'report'

export interface DiagnosticsFileView {
  /** What the file holds, in order, with the number of lines of each (a part with nothing to say is left out). */
  parts: { id: DiagnosticsPartId; lines: number }[]
  /** The exact text that would be written, already redacted. */
  text: string
  suggestedName: string
}

export type DiagnosticsSaveResult =
  { ok: true; name: string } | { ok: false; canceled: true } | { ok: false; canceled?: false; error: string }

/** The longest "what failed" text main accepts from the renderer (the rest is cut, never sent anywhere). */
export const DIAGNOSTICS_CONTEXT_MAX = 8_000

/** The new-issue page of the public repository, with a title only. */
export function reportIssueUrl(title: string): string {
  return `${PUBLIC_REPO_URL}/issues/new?title=${encodeURIComponent(title.slice(0, 120))}`
}
